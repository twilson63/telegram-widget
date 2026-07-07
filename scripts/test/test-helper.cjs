"use strict";

/*
 * Test helpers for the Telegram Bridge Daemon.
 * Uses Node's native test runner (node --test) + ws for WebSocket client.
 * No external credentials or network required.
 */

const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Get clean env — TELEGRAM_BOT_TOKEN excluded so the bridge
 * enters --widget-managed waiting mode without complaining.
 */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN; // must be unset, not empty string
  return { ...env, ...extra };
}

/**
 * Poll a localhost TCP port until it accepts a connection, or time out.
 * Replaces a fixed sleep so we don't race the WS server startup under load.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<void>} rejects on timeout
 */
function waitForPort(port, timeoutMs = 4000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) {}
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Port ${port} not listening after ${timeoutMs}ms: ${err}`));
        } else {
          setTimeout(attempt, 40);
        }
      };
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) {}
        resolve();
      });
      socket.once("error", fail);
    }
    attempt();
  });
}

/**
 * Start the bridge daemon as a child process.
 * @param {object} opts
 * @param {string[]} opts.args - CLI flags, e.g. ["--widget-managed"]
 * @param {object} [opts.env] - Environment overrides
 * @param {number} [opts.port] - Override TELEGRAM_WS_PORT
 * @returns {{ proc: ReturnType<spawn>, port: number }}
 */
function spawnBridge({ args = [], env = {}, port = 0, configDir = null } = {}) {
  const actualPort = port || 18765 + Math.floor(Math.random() * 1000);
  // Every bridge gets an isolated stored-config dir so tests never read or
  // write the user's real ~/.hyperdesk/telegram-bridge/config.json.
  const actualConfigDir = configDir || fs.mkdtempSync(path.join(os.tmpdir(), "tg-bridge-test-"));
  const childEnv = {
    ...cleanEnv(),
    TELEGRAM_WS_PORT: String(actualPort),
    TELEGRAM_BRIDGE_CONFIG_DIR: actualConfigDir,
    ...env
  };
  const proc = spawn(
    process.execPath,
    [__dirname + "/../telegram-bridge.cjs", ...args],
    { env: childEnv, stdio: ["pipe", "pipe", "pipe"], cwd: __dirname + "/.." }
  );
  return { proc, port: actualPort, configDir: actualConfigDir };
}

// ── Buffered WS message queue ──
// A persistent per-socket queue so messages are never lost between a ws.send()
// and attaching a listener, and so async status bursts (e.g. configure →
// "configuring" → "running"/error) are buffered for predicate filtering instead
// of desyncing a naive once("message") drain.
function ensureQueue(ws) {
  if (ws.__tgQueue) return ws.__tgQueue;
  const q = { buffer: [], waiters: [] };
  ws.__tgQueue = q;
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; /* drop unparseable */ }
    const idx = q.waiters.findIndex((w) => {
      try { return w.predicate(msg); } catch (_) { return false; }
    });
    if (idx >= 0) {
      const w = q.waiters.splice(idx, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      q.buffer.push(msg);
    }
  });
  ws.on("close", () => {
    for (const w of q.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("WS closed while waiting for message"));
    }
  });
  return q;
}

function _wait(ws, predicate, timeoutMs) {
  const q = ensureQueue(ws);
  for (let i = 0; i < q.buffer.length; i++) {
    let match = false;
    try { match = predicate(q.buffer[i]); } catch (_) { match = false; }
    if (match) return Promise.resolve(q.buffer.splice(i, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = q.waiters.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) q.waiters.splice(idx, 1);
      reject(new Error("Timeout waiting for WS message"));
    }, timeoutMs);
    q.waiters.push({ predicate, resolve, timer });
  });
}

/**
 * Wait for the next WS message (no filtering). Prefer waitForMessage when the
 * bridge may emit async status bursts.
 * @param {WebSocket} ws
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>>}
 */
function expectMessage(ws, timeoutMs = 3000) {
  return _wait(ws, () => true, timeoutMs);
}

/**
 * Wait for a WS message matching a predicate, buffering non-matching messages
 * for later waiters.
 * @param {WebSocket} ws
 * @param {(msg: object) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return _wait(ws, predicate, timeoutMs);
}

/**
 * Send a message and wait for a response. If predicate is given, wait for a
 * message that matches (ignoring async status bursts); otherwise wait for the
 * next message.
 * @param {WebSocket} ws
 * @param {object} msg
 * @param {number} timeoutMs
 * @param {(msg: object) => boolean} [predicate]
 * @returns {Promise<Record<string, unknown>>}
 */
async function sendAndExpect(ws, msg, timeoutMs = 3000, predicate = null) {
  ws.send(JSON.stringify(msg));
  return predicate ? waitForMessage(ws, predicate, timeoutMs) : expectMessage(ws, timeoutMs);
}

/**
 * Start a bridge, connect WS, and return both.
 * Waits for the TCP port to be listening before opening the WS, so we don't
 * race the server startup (the historical source of flaky timeouts).
 * @param {object} opts
 * @returns {Promise<{ ws: WebSocket, proc: ReturnType<spawn>, port: number }>}
 */
async function startBridge(opts = {}) {
  const { proc, port, configDir } = spawnBridge(opts);
  await waitForPort(port, 4000);

  // Open the WS. The port is listening, but under load the first connect
  // attempt can race the server accept loop, so retry once.
  let ws;
  for (let attempt = 0; attempt < 3; attempt++) {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
        ws.once("close", () => reject(new Error("WS closed before open")));
      });
      break;
    } catch (e) {
      try { ws.close(); } catch (_) {}
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Drain the initial bridge:status message (give grammy/WS init headroom).
  const initialStatus = await expectMessage(ws, 5000);

  return { ws, proc, port, configDir, initialStatus };
}

/**
 * Gracefully stop a bridge process.
 * SIGTERM first, then SIGKILL if it hasn't exited within a short grace.
 * @param {ReturnType<spawn>} proc
 * @param {WebSocket} ws
 */
async function stopBridge(proc, ws) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch (_) { /* already closed */ }
  try { proc.stdin.destroy(); } catch (_) {}
  try { proc.kill("SIGTERM"); } catch (_) {}
  await new Promise((resolve) => {
    proc.once("exit", resolve);
    setTimeout(resolve, 800);
  });
  if (proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill("SIGKILL"); } catch (_) {}
  }
}

module.exports = { spawnBridge, expectMessage, waitForMessage, sendAndExpect, startBridge, stopBridge, cleanEnv, waitForPort };