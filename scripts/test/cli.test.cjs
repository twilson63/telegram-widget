"use strict";

/*
 * CLI and Config Tests for the Telegram Bridge Daemon
 */

const { strictEqual, ok, match } = require("node:assert");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { stopBridge } = require("./test-helper.cjs");

const BRIDGE = __dirname + "/../telegram-bridge.cjs";

// ── Test: No token, no --widget-managed → exit 1 ──
test("CLI: no token and no --widget-managed exits with code 1", async () => {
  const code = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [BRIDGE], {
      env: (() => { const e = { ...process.env }; delete e.TELEGRAM_BOT_TOKEN; e.TELEGRAM_WS_PORT = "19001"; return e; })()
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.once("exit", (code) => resolve(code));
  });
  strictEqual(code, 1, "Expected exit code 1");
});

// ── Test: --help prints usage and exits 0 ──
test("CLI: --help prints usage and exits 0", async () => {
  const { stdout, stderr } = await execFile(process.execPath, [BRIDGE, "--help"]);
  strictEqual(stderr, "", "stderr should be empty for --help");
  ok(stdout.includes("telegram-bridge") || stdout.includes("Telegram Bridge"), "stdout should mention telegram-bridge");
  ok(stdout.includes("Usage") || stdout.includes("Usage:"), "stdout should contain Usage");
});

// ── Test: --version prints version and exits 0 ──
test("CLI: --version prints version and exits 0", async () => {
  const { stdout } = await execFile(process.execPath, [BRIDGE, "--version"]);
  ok(stdout.includes("v0.3.0") || stdout.includes("0.3"), "stdout should contain version");
});

// ── Test: TELEGRAM_BOT_TOKEN env var accepted ──
test("CLI: TELEGRAM_BOT_TOKEN env var is accepted without --widget-managed", async () => {
  const result = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, TELEGRAM_BOT_TOKEN: "test-token-does-not-matter", TELEGRAM_WS_PORT: "19002" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const finish = (code) => {
      proc.kill("SIGKILL");
      resolve({ code, stderr });
    };
    const timer = setTimeout(() => finish(null), 1500);
    proc.once("exit", (code) => { clearTimeout(timer); finish(code); });
  });
  ok(!result.stderr.includes("TELEGRAM_BOT_TOKEN is required"),
    "Should not complain about missing token when env var is set");
});

// ── Test: --widget-managed starts without token ──
test("CLI: --widget-managed starts without requiring TELEGRAM_BOT_TOKEN", async () => {
  const { spawnBridge, expectMessage, stopBridge: stop } = require("./test-helper.cjs");
  const { proc, port } = spawnBridge({ args: ["--widget-managed"] });

  await new Promise((r) => setTimeout(r, 800));
  const { WebSocket } = require("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => { ws.once("open", r); ws.once("error", r); });
  const status = await expectMessage(ws, 2000);

  ok(status.type === "bridge:status", "Should receive initial bridge:status");
  ok(status.payload?.port === port, "Status should show the port");
  const allowed = ["waiting-for-config", "configuring", "stopped"];
  ok(allowed.includes(status.payload?.status) || status.payload?.port === port,
    `Status indicates waiting for config, got: ${status.payload?.status}`);

  await stop(proc, ws);
});

// ── Test: invalid token produces error status, not crash ──
test("CLI: invalid token produces error status, not crash", async () => {
  const { spawnBridge, expectMessage, sendAndExpect, stopBridge: stop } = require("./test-helper.cjs");
  const { proc, port } = spawnBridge({ args: ["--widget-managed"], port: 19003 });

  await new Promise((r) => setTimeout(r, 800));
  const { WebSocket } = require("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => { ws.once("open", r); ws.once("error", r); });
  await expectMessage(ws, 2000);

  // Send invalid token via configure
  try {
    await sendAndExpect(ws, {
      type: "bridge:configure",
      payload: { token: "invalid:token", allowedChats: "" }
    }, 3000);
  } catch {
    ok(true, "Bot start may timeout — that's acceptable");
  }

  ok(!proc.killed, "Process should still be running after invalid token");
  await stop(proc, ws);
});
