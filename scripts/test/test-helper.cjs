"use strict";

/*
 * Test helpers for the Telegram Bridge Daemon.
 * Uses Node's native test runner (node --test) + ws for WebSocket client.
 * No external credentials or network required.
 */

const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
const { once } = require("node:events");
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

/**
 * Wait for a WS message from the server.
 * @param {WebSocket} ws
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>>}
 */
function expectMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for WS message")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (e) {
        reject(new Error("Invalid JSON from WS: " + data.toString().slice(0, 200)));
      }
    });
  });
}

/**
 * Send a message and wait for the response.
 * @param {WebSocket} ws
 * @param {object} msg
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>>}
 */
async function sendAndExpect(ws, msg, timeoutMs = 3000) {
  ws.send(JSON.stringify(msg));
  return expectMessage(ws, timeoutMs);
}

/**
 * Start a bridge, connect WS, and return both.
 * @param {object} opts
 * @returns {Promise<{ ws: WebSocket, proc: ReturnType<spawn>, port: number }>}
 */
async function startBridge(opts = {}) {
  const { proc, port, configDir } = spawnBridge(opts);
  // Wait a bit for the WS server to start
  await new Promise((r) => setTimeout(r, 500));

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("close", () => reject(new Error("WS closed before open")));
  });

  // Drain the initial bridge:status message
  const initialStatus = await expectMessage(ws, 2000);

  return { ws, proc, port, configDir, initialStatus };
}

/**
 * Gracefully stop a bridge process.
 * @param {ReturnType<spawn>} proc
 * @param {WebSocket} ws
 */
async function stopBridge(proc, ws) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch (_) { /* already closed */ }
  proc.stdin.destroy();
  // Give it time to exit
  await new Promise((resolve) => {
    proc.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
  // Force kill if still alive
  if (!proc.killed) {
    try { proc.kill("SIGKILL"); } catch (_) {}
  }
}

module.exports = { spawnBridge, expectMessage, sendAndExpect, startBridge, stopBridge, cleanEnv };
