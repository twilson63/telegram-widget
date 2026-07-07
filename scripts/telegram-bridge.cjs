#!/usr/bin/env node
"use strict";

/*
 * Telegram Bridge Daemon
 * Connects Telegram Bot API to HyperDesk widget via localhost WebSocket.
 *
 * Modes:
 *   node telegram-bridge.cjs                    # token comes from TELEGRAM_BOT_TOKEN
 *   node telegram-bridge.cjs --widget-managed   # starts WS first, waits for bridge:configure
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN      — bot token from @BotFather (optional in --widget-managed mode)
 *   TELEGRAM_ALLOWED_CHATS  — optional, comma-separated chat IDs for allowlist
 *   TELEGRAM_WS_PORT        — optional, WebSocket server port (default: 18765)
 */

const { Bot } = require("grammy");
const { WebSocketServer } = require("ws");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ── Config ──
const DEFAULT_PORT = parseInt(process.env.TELEGRAM_WS_PORT || "18765", 10);

// ── Stored config ──
// The bot token can be remembered between sessions. It lives here — in a
// user-only file owned by the daemon — rather than in the widget's
// localStorage, so the secret never sits in browser-readable storage.
const CONFIG_DIR = process.env.TELEGRAM_BRIDGE_CONFIG_DIR ||
  path.join(os.homedir(), ".hyperdesk", "telegram-bridge");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function loadStoredConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (cfg && typeof cfg.token === "string" && cfg.token) return cfg;
  } catch (_) { /* missing or unreadable — no stored config */ }
  return null;
}

function storeConfig(token, allowedChatsStr) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ token, allowedChats: allowedChatsStr || "" }) + "\n", { mode: 0o600 });
    fs.chmodSync(CONFIG_FILE, 0o600); // mode option is ignored when the file already exists
    return true;
  } catch (err) {
    console.warn("Could not store bridge config:", err.message);
    return false;
  }
}

function clearStoredConfig() {
  try { fs.unlinkSync(CONFIG_FILE); } catch (_) {}
}

function hasStoredToken() {
  return loadStoredConfig() !== null;
}
let botToken = process.env.TELEGRAM_BOT_TOKEN || "";
let allowedChats = parseAllowedChats(process.env.TELEGRAM_ALLOWED_CHATS || "");
let actualWsPort = DEFAULT_PORT;

// ── State ──
let bot = null;
let wss = null;
let isPolling = false;
let startedAt = null;
let msgReceived = 0;
let msgSent = 0;
let history = []; // conversation history: [{role, text, chatId}]
let lastChatId = allowedChats[0] || null;
const MAX_HISTORY = 20; // last 20 exchanges (40 messages)
const CHUNK_MAX = 3500; // Telegram limit 4096, leave room for metadata

// Telegram's "typing…" indicator expires after ~5s. While the agent is working
// on a message, we re-send sendChatAction("typing") on this interval so the
// user sees the bot is busy before the first response arrives.
const TYPING_INTERVAL_MS = 4000;
// Hard cap so a stalled/lost agent run can never leave "typing…" on forever.
const TYPING_MAX_MS = 60000;
let typingTimer = null;
let typingCapTimer = null;
let typingChatId = null;

// ── CLI flags ──
const args = process.argv.slice(2);
const WIDGET_MANAGED = args.includes("--widget-managed");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Telegram Bridge Daemon

Usage:
  node telegram-bridge.cjs
  node telegram-bridge.cjs --widget-managed

Environment:
  TELEGRAM_BOT_TOKEN          Bot token from @BotFather (required unless --widget-managed)
  TELEGRAM_ALLOWED_CHATS      Comma-separated chat IDs for allowlist (optional)
  TELEGRAM_WS_PORT            WebSocket server port (default: 18765)
  TELEGRAM_BRIDGE_CONFIG_DIR  Where the remembered token is stored
                              (default: ~/.hyperdesk/telegram-bridge)

Widget-managed mode starts the localhost WebSocket first and waits for the
widget to send bridge:configure with the token. This keeps the token out of the
shell command, approval prompt, process list, and bridge logs. Once received,
the token is remembered in a user-only file (chmod 600) under the config dir,
so later sessions can send bridge:configure without a token. Send
bridge:forget-token (or pass remember:false in bridge:configure) to opt out.

Commands (on Telegram):
  /start   Connect and start polling
  /stop    Stop polling
  /status  Show status
  /help    Show this help
  anything Forward to HyperDesk agent
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log("telegram-bridge v0.3.0");
  process.exit(0);
}

if (!botToken && !WIDGET_MANAGED) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is required");
  console.error("  Get one from @BotFather on Telegram, or run with --widget-managed");
  process.exit(1);
}

// ── WebSocket Server ──
function startWebSocketServer() {
  return new Promise((resolve, reject) => {
    function tryStart(port) {
      const server = new WebSocketServer({ port, host: "127.0.0.1" });
      let settled = false;

      server.once("listening", () => {
        settled = true;
        resolve({ wss: server, actualPort: port });
      });

      server.once("error", (err) => {
        if (settled) {
          console.error("WebSocket server error:", err.message);
          return;
        }
        if (err.code === "EADDRINUSE") {
          console.warn(`Port ${port} in use, trying ${port + 1}`);
          tryStart(port + 1);
        } else {
          reject(err);
        }
      });
    }

    tryStart(DEFAULT_PORT);
  });
}

function setupWebSocket(serverInfo) {
  wss = serverInfo.wss;
  actualWsPort = serverInfo.actualPort;

  if (actualWsPort !== DEFAULT_PORT) {
    console.warn(`Bridge running on port ${actualWsPort} (auto-incremented from ${DEFAULT_PORT})`);
  }
  console.log(`WebSocket server listening on ws://127.0.0.1:${actualWsPort}`);

  wss.on("connection", (ws) => {
    console.log("Bridge daemon: widget connected");
    ws.send(JSON.stringify({
      type: "bridge:status",
      payload: { port: actualWsPort, status: bot ? "running" : "waiting-for-config", hasStoredToken: hasStoredToken() }
    }));

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "bridge:configure") {
          configureFromWidget(msg.payload || {}, ws);
          return;
        }

        if (msg.type === "telegram:message" && msg.payload?.text) {
          await handleAgentResponse(msg.payload.text, msg.payload.chatId);
          return;
        }

        if (msg.type === "bridge:stop") {
          console.log("Bridge daemon: stopping via widget command");
          stopPolling();
          notifyWidget({ type: "bridge:status", payload: { status: "stopped", port: actualWsPort } });
          return;
        }

        if (msg.type === "bridge:forget-token") {
          clearStoredConfig();
          console.log("Bridge daemon: stored token cleared");
          sendToSocket(ws, { type: "bridge:status", payload: buildStatusPayload(isPolling ? "running" : "stopped") });
          return;
        }

        if (msg.type === "bridge:ping") {
          ws.send(JSON.stringify({ type: "bridge:status", payload: buildStatusPayload("running") }));
        }
      } catch (err) {
        console.error("WebSocket message error:", err.message);
        sendToSocket(ws, { type: "bridge:status", payload: { error: err.message, port: actualWsPort } });
      }
    });

    ws.on("close", () => console.log("Bridge daemon: widget disconnected"));
    ws.on("error", (err) => console.error("WebSocket error:", err.message));
  });

  wss.on("error", (err) => console.error("WebSocket server error:", err.message));
}

function configureFromWidget(payload, ws) {
  let token = String(payload.token || "").trim();
  let allowedChatsStr = String(payload.allowedChats || "");

  if (token) {
    // Remember the token daemon-side (user-only file) unless explicitly told not to.
    if (payload.remember !== false) storeConfig(token, allowedChatsStr);
  } else {
    const stored = loadStoredConfig();
    if (!stored) {
      sendToSocket(ws, { type: "bridge:status", payload: { error: "Bot token missing", port: actualWsPort, hasStoredToken: false } });
      return;
    }
    token = stored.token;
    if (!allowedChatsStr) allowedChatsStr = String(stored.allowedChats || "");
  }

  botToken = token;
  allowedChats = parseAllowedChats(allowedChatsStr);
  lastChatId = allowedChats[0] || lastChatId;

  sendToSocket(ws, { type: "bridge:status", payload: { status: "configuring", port: actualWsPort, hasStoredToken: hasStoredToken() } });
  startBot();
}

// ── Telegram Bot ──
function startBot() {
  if (!botToken) {
    notifyWidget({ type: "bridge:status", payload: { error: "Bot token missing", port: actualWsPort } });
    return;
  }

  stopPolling();
  bot = new Bot(botToken);

  bot.catch((err) => {
    const msg = String(err.message || err.error?.description || err);
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("auth failed")) {
      console.error("ERROR: Invalid bot token — authentication failed");
      notifyWidget({ type: "bridge:status", payload: { error: "Invalid bot token", port: actualWsPort } });
      isPolling = false;
      return;
    }
    if (msg.includes("429") || msg.includes("too many")) {
      console.warn("Telegram API rate limited, backoff active");
      return;
    }
    console.error("Bot error:", msg);
    notifyWidget({ type: "bridge:status", payload: { error: msg, port: actualWsPort } });
  });

  bot.command("start", async (ctx) => {
    if (allowedChats.length > 0 && !allowedChats.includes(ctx.chat.id)) {
      await ctx.reply("Unauthorized. Contact the bot administrator.");
      return;
    }

    if (allowedChats.length === 0) allowedChats.push(ctx.chat.id);
    lastChatId = ctx.chat.id;
    startedAt = startedAt || Date.now();
    msgReceived = 0;
    msgSent = 0;
    history = [];

    await ctx.reply(
      `✅ Telegram bridge connected\n\n` +
      `Chat ID: ${ctx.chat.id}\n` +
      `Port: ${actualWsPort}\n` +
      `Status: Polling active\n\n` +
      `Send any message to chat with your HyperDesk agent.\n` +
      `Use /stop to disconnect, /status for info.`
    );

    isPolling = true;
    notifyWidget({
      type: "bridge:status",
      payload: { status: "connected", chatId: ctx.chat.id, port: actualWsPort }
    });
    console.log(`Bridge started — chat: ${ctx.chat.id}, port: ${actualWsPort}`);
  });

  bot.command("stop", async (ctx) => {
    if (!isPolling) {
      await ctx.reply("Bridge is not currently polling.");
      return;
    }
    await ctx.reply("🛑 Bridge stopped.");
    stopPolling();
    notifyWidget({ type: "bridge:status", payload: { status: "stopped", port: actualWsPort } });
    console.log("Bridge stopped via /stop");
  });

  bot.command("status", async (ctx) => {
    const uptime = startedAt ? formatUptime(Date.now() - startedAt) : "N/A";
    await ctx.reply(
      `Bridge Status\n` +
      `Polling: ${isPolling ? "active" : "stopped"}\n` +
      `Uptime: ${uptime}\n` +
      `Messages received: ${msgReceived}\n` +
      `Messages sent: ${msgSent}\n` +
      `History entries: ${history.length}`
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `Available commands:\n` +
      `/start — Connect and start polling\n` +
      `/stop  — Stop polling\n` +
      `/status — Show bridge status\n` +
      `/help  — Show this help\n\n` +
      `Any other message is forwarded to your HyperDesk agent.`
    );
  });

  bot.on("message:text", async (ctx) => {
    if (allowedChats.length > 0 && !allowedChats.includes(ctx.chat.id)) {
      return; // silently drop unauthorized messages
    }

    if (allowedChats.length === 0) allowedChats.push(ctx.chat.id);
    lastChatId = ctx.chat.id;

    const userText = ctx.message.text;
    msgReceived++;

    history.push({ role: "user", text: userText, chatId: ctx.chat.id });
    if (history.length > MAX_HISTORY * 2) history.splice(0, 2);

    // Show Telegram "typing…" immediately and keep refreshing it while the
    // agent processes the message. Skipped for slash commands, which get
    // an instant ctx.reply from the bridge and don't go through the agent.
    if (!userText.startsWith("/")) startTypingIndicator(ctx.chat.id);

    notifyWidget({
      type: "telegram:message",
      payload: { text: userText, chatId: ctx.chat.id }
    });

    console.log(`[${ctx.chat.id}] → agent: ${userText.slice(0, 50)}...`);
  });

  console.log("Starting Telegram Bot API long-polling...");
  bot.start({
    onStart: () => notifyWidget({ type: "bridge:status", payload: buildStatusPayload("running") }),
    onFallback: (err) => {
      if (err.message?.includes("bot inactive") || err.message?.includes("reconnect")) return;
      console.error("Polling error:", err.message);
      notifyWidget({ type: "bridge:status", payload: { error: err.message, port: actualWsPort } });
    }
  }).catch((err) => {
    const msg = String(err.message || err);
    console.error("Bot start failed:", msg);
    notifyWidget({ type: "bridge:status", payload: { error: msg, port: actualWsPort } });
    isPolling = false;
  });

  isPolling = true;
  startedAt = startedAt || Date.now();
}

function stopPolling() {
  stopTypingIndicator();
  if (!bot) return;
  isPolling = false;
  try {
    if (typeof bot.stop === "function") bot.stop();
    else if (bot.api && typeof bot.api.stopLongPolling === "function") bot.api.stopLongPolling();
  } catch (_) {
    // Fallback: mark stopped; process shutdown/pkill will clean up if needed.
  }
}

// ── Typing indicator ──
// Telegram's chat action "typing" shows a "Bot is typing…" hint in the chat
// for about five seconds. We send it the moment a real message arrives and
// refresh it on a timer until the agent's reply is delivered, so the user
// gets immediate feedback that their message is being handled.
function startTypingIndicator(chatId) {
  if (!bot || !isPolling || !chatId) return;
  stopTypingIndicator();
  typingChatId = chatId;
  sendTypingAction(chatId);
  typingTimer = setInterval(() => {
    if (!bot || !isPolling) { stopTypingIndicator(); return; }
    sendTypingAction(typingChatId);
  }, TYPING_INTERVAL_MS);
  // Safety cap: even if the agent reply never comes back (widget dropped,
  // run stalled, etc.), stop refreshing after TYPING_MAX_MS so we don't pin
  // a "typing…" indicator on the chat forever.
  typingCapTimer = setTimeout(stopTypingIndicator, TYPING_MAX_MS);
}

function stopTypingIndicator() {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
  if (typingCapTimer) { clearTimeout(typingCapTimer); typingCapTimer = null; }
  typingChatId = null;
}

function sendTypingAction(chatId) {
  if (!bot || !chatId) return;
  bot.api.sendChatAction(chatId, "typing").catch((err) => {
    // Non-fatal: typing is best-effort UX, never block the reply on it.
    const m = String(err?.message || err);
    if (!/400|chat not found|chat_id invalid/i.test(m)) {
      console.warn("sendChatAction(typing) failed:", m);
    }
  });
}

// ── Agent Response Handling ──
async function handleAgentResponse(text, explicitChatId) {
  stopTypingIndicator();
  msgSent++;

  const chatId = explicitChatId || findChatIdForResponse();
  if (!bot || !isPolling) {
    console.warn("Bot is not configured or polling — cannot send response");
    notifyWidget({ type: "bridge:status", payload: { error: "Bot is not configured or polling", port: actualWsPort } });
    return;
  }

  if (!chatId) {
    console.warn("No chat ID found for response — skipping send");
    notifyWidget({ type: "bridge:status", payload: { error: "No Telegram chat ID available", port: actualWsPort } });
    return;
  }

  const chunks = splitIntoChunks(text, CHUNK_MAX);
  let sent = 0;

  for (const chunk of chunks) {
    if (!isPolling) {
      console.warn("Bridge stopped during streaming — aborting remaining chunks");
      break;
    }
    try {
      await bot.api.sendMessage(chatId, chunk);
      sent++;
    } catch (err) {
      console.error("sendMessage error:", err.message);
      notifyWidget({ type: "bridge:status", payload: { error: err.message, port: actualWsPort } });
      break;
    }
  }

  if (sent > 0) {
    console.log(`Response sent as ${sent} chunk(s) to chat ${chatId}`);
    notifyWidget({ type: "bridge:status", payload: { status: "sent", chunks: sent, port: actualWsPort } });
  }

  history.push({ role: "assistant", text, chatId });
  if (history.length > MAX_HISTORY * 2) history.splice(0, 2);
}

// ── Utilities ──
function parseAllowedChats(value) {
  return String(value || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
}

function splitIntoChunks(text, maxSize) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining.trim());
      break;
    }

    let splitAt = maxSize;
    const paraBreak = remaining.lastIndexOf("\n\n", maxSize);
    const lineBreak = remaining.lastIndexOf("\n", maxSize);
    const spaceBreak = remaining.lastIndexOf(" ", maxSize);

    if (paraBreak > maxSize * 0.6) splitAt = paraBreak;
    else if (lineBreak > maxSize * 0.6) splitAt = lineBreak;
    else if (spaceBreak > maxSize * 0.8) splitAt = spaceBreak;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks.filter(c => c.length > 0);
}

function findChatIdForResponse() {
  const lastUserMsg = history.filter(h => h.role === "user" && h.chatId).pop();
  return lastUserMsg?.chatId || lastChatId || allowedChats[0] || null;
}

function formatUptime(ms) {
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${s}s`;
}

function buildStatusPayload(status) {
  return {
    status,
    port: actualWsPort,
    polling: isPolling,
    messagesReceived: msgReceived,
    messagesSent: msgSent,
    historyEntries: history.length,
    hasStoredToken: hasStoredToken()
  };
}

function sendToSocket(ws, msg) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch (_) {}
  }
}

function notifyWidget(msg) {
  if (!wss) return;
  for (const ws of wss.clients) sendToSocket(ws, msg);
}

// ── Graceful shutdown ──
function shutdown() {
  console.log("\nShutting down...");
  stopTypingIndicator();
  stopPolling();
  if (wss) wss.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Main ──
async function main() {
  console.log("Telegram Bridge Daemon v0.3.0");
  console.log(`Port: ${DEFAULT_PORT}`);
  console.log(`Allowed chats: ${allowedChats.length > 0 ? allowedChats.join(", ") : "permissive (first user sets)"}`);
  console.log(`Mode: ${WIDGET_MANAGED ? "widget-managed" : "environment-token"}`);
  console.log("---");

  try {
    const serverInfo = await startWebSocketServer();
    setupWebSocket(serverInfo);
  } catch (err) {
    console.error("Failed to start WebSocket server:", err.message);
    process.exit(1);
  }

  if (botToken) {
    startBot();
  } else {
    console.log("Waiting for widget configuration over localhost WebSocket...");
  }
}

main();