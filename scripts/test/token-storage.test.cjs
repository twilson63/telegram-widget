"use strict";

/*
 * Bridge-side token storage tests.
 * The bridge remembers the bot token in $TELEGRAM_BRIDGE_CONFIG_DIR/config.json
 * (user-only perms) so the widget never persists it in browser storage.
 * Every spawned bridge gets an isolated temp config dir via the test helper.
 */

const { strictEqual, ok } = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { startBridge, stopBridge, sendAndExpect, expectMessage } = require("./test-helper.cjs");

const TEST_TOKEN = "0:ABC-storage-test-token";

function configPath(configDir) {
  return path.join(configDir, "config.json");
}

test("storage: initial status reports hasStoredToken=false on fresh config dir", async () => {
  const { ws, proc, initialStatus } = await startBridge({ args: ["--widget-managed"] });
  strictEqual(initialStatus.payload?.hasStoredToken, false, "Fresh bridge should have no stored token");
  await stopBridge(proc, ws);
});

test("storage: bridge:configure with token persists config file with 0600 perms", async () => {
  const { ws, proc, configDir } = await startBridge({ args: ["--widget-managed"] });

  const resp = await sendAndExpect(ws, {
    type: "bridge:configure",
    payload: { token: TEST_TOKEN, allowedChats: "123" }
  }, 3000, (m) => m.type === "bridge:status" && m.payload?.hasStoredToken === true);

  strictEqual(resp.payload?.hasStoredToken, true, "Status should report a stored token");

  const file = configPath(configDir);
  ok(fs.existsSync(file), "config.json should exist after configure");
  const mode = fs.statSync(file).mode & 0o777;
  strictEqual(mode, 0o600, `config.json should be user-only (0600), got ${mode.toString(8)}`);

  const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
  strictEqual(cfg.token, TEST_TOKEN, "Stored token should match");
  strictEqual(cfg.allowedChats, "123", "Stored allowlist should match");

  await stopBridge(proc, ws);
});

test("storage: configure with remember:false does not persist the token", async () => {
  const { ws, proc, configDir } = await startBridge({ args: ["--widget-managed"] });

  const resp = await sendAndExpect(ws, {
    type: "bridge:configure",
    payload: { token: TEST_TOKEN, allowedChats: "", remember: false }
  }, 3000, (m) => m.type === "bridge:status" && m.payload?.hasStoredToken === false);

  strictEqual(resp.payload?.hasStoredToken, false, "Status should report no stored token");
  ok(!fs.existsSync(configPath(configDir)), "config.json should not exist with remember:false");

  await stopBridge(proc, ws);
});

test("storage: a restarted bridge uses the stored token when configure has none", async () => {
  // First bridge stores the token, then dies.
  const first = await startBridge({ args: ["--widget-managed"] });
  await sendAndExpect(first.ws, {
    type: "bridge:configure",
    payload: { token: TEST_TOKEN, allowedChats: "456" }
  }, 3000, (m) => m.type === "bridge:status" && m.payload?.status === "configuring");
  await stopBridge(first.proc, first.ws);

  // Second bridge on the same config dir: configure WITHOUT a token.
  const second = await startBridge({ args: ["--widget-managed"], configDir: first.configDir });
  strictEqual(second.initialStatus.payload?.hasStoredToken, true, "Restarted bridge should see the stored token");

  const resp = await sendAndExpect(second.ws, {
    type: "bridge:configure",
    payload: { token: "", allowedChats: "" }
  }, 3000, (m) => m.type === "bridge:status" && m.payload?.status === "configuring");

  strictEqual(resp.payload?.status, "configuring", "Bridge should configure from the stored token, not error");
  await stopBridge(second.proc, second.ws);
});

test("storage: bridge:forget-token deletes the stored config", async () => {
  const { ws, proc, configDir } = await startBridge({ args: ["--widget-managed"] });

  await sendAndExpect(ws, {
    type: "bridge:configure",
    payload: { token: TEST_TOKEN, allowedChats: "" }
  }, 3000, (m) => m.type === "bridge:status" && m.payload?.hasStoredToken === true);
  ok(fs.existsSync(configPath(configDir)), "config.json exists after configure");

  const resp = await sendAndExpect(ws, { type: "bridge:forget-token" }, 3000, (m) => m.type === "bridge:status" && m.payload?.hasStoredToken === false);
  strictEqual(resp.payload?.hasStoredToken, false, "Status should report the token is gone");
  ok(!fs.existsSync(configPath(configDir)), "config.json should be deleted");

  await stopBridge(proc, ws);
});

test("storage: configure without token and without stored config still errors", async () => {
  const { ws, proc } = await startBridge({ args: ["--widget-managed"] });

  const resp = await sendAndExpect(ws, {
    type: "bridge:configure",
    payload: { token: "", allowedChats: "" }
  }, 3000, (m) => m.type === "bridge:status" && m.payload?.error === "Bot token missing");

  strictEqual(resp.payload?.error, "Bot token missing", "Empty token with no stored config keeps the old error");
  strictEqual(resp.payload?.hasStoredToken, false, "And reports no stored token");

  await stopBridge(proc, ws);
});
