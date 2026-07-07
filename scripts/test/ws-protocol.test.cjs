"use strict";

/*
 * WebSocket Protocol Tests for the Telegram Bridge Daemon
 */

const { strictEqual, ok, deepStrictEqual } = require("node:assert");
const { test } = require("node:test");
const { startBridge, stopBridge, sendAndExpect, waitForPort } = require("./test-helper.cjs");

// ── Test: Bridge starts WS server and sends initial status ──
test("WS: initial connection receives bridge:status", async () => {
  const { ws, proc, port, initialStatus } = await startBridge({
    args: ["--widget-managed"]
  });

  ok(initialStatus, "Should receive initial message");
  strictEqual(initialStatus.type, "bridge:status", "Message type should be bridge:status");
  ok(initialStatus.payload?.port === port, `Port should be ${port}`);

  await stopBridge(proc, ws);
});

// ── Test: bridge:configure updates status ──
test("WS: bridge:configure triggers status update", async () => {
  const { ws, proc } = await startBridge({
    args: ["--widget-managed"]
  });

  const configResp = await sendAndExpect(ws, {
    type: "bridge:configure",
    payload: { token: "0:ABC-test-token-for-testing", allowedChats: "" }
  }, 3000);

  ok(configResp.type === "bridge:status", "Should receive bridge:status after configure");

  await stopBridge(proc, ws);
});

// ── Test: bridge:stop stops the bridge ──
test("WS: bridge:stop changes status to stopped", async () => {
  const { ws, proc } = await startBridge({
    args: ["--widget-managed"]
  });

  // Configure (bot will fail auth, but bridge stays alive). Wait for the sync
  // "configuring" ack so the later async error status cannot be grabbed by stop.
  await sendAndExpect(ws, {
    type: "bridge:configure",
    payload: { token: "0:ABC-test", allowedChats: "" }
  }, 3000, (m) => m.type === "bridge:status" && m.payload?.status === "configuring").catch(() => {});

  // Now stop — filter for "stopped" so stray async statuses are ignored.
  const stopResp = await sendAndExpect(ws, { type: "bridge:stop" }, 3000, (m) => m.type === "bridge:status" && m.payload?.status === "stopped");
  ok(stopResp.type === "bridge:status", "Should receive bridge:status after stop");
  strictEqual(stopResp.payload?.status, "stopped", "Status should be stopped");

  await stopBridge(proc, ws);
});

// ── Test: bridge:ping receives status ──
test("WS: bridge:ping returns bridge:status", async () => {
  const { ws, proc } = await startBridge({
    args: ["--widget-managed"]
  });

  const pingResp = await sendAndExpect(ws, { type: "bridge:ping" }, 3000);
  ok(pingResp.type === "bridge:status", "Pong should be bridge:status");
  ok(pingResp.payload?.port, "Pong should include port");

  await stopBridge(proc, ws);
});

// ── Test: Port auto-increment ──
test("WS: port auto-increments when default is occupied", async () => {
  const { spawnBridge, expectMessage, stopBridge } = require("./test-helper.cjs");

  const first = spawnBridge({ args: ["--widget-managed"], port: 19010 });
  await waitForPort(19010, 4000);

  const second = spawnBridge({ args: ["--widget-managed"], port: 19010 });
  await waitForPort(19011, 4000);

  const { WebSocket } = require("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${19011}`);
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const status = await expectMessage(ws, 2000);
    strictEqual(status.payload?.port, 19011, "Second instance should report port 19011");
  } finally {
    await stopBridge(first.proc, null);
    await stopBridge(second.proc, ws);
  }
});

// ── Test: Invalid bridge:configure (no token) sends error ──
test("WS: bridge:configure with no token sends error status", async () => {
  const { ws, proc } = await startBridge({
    args: ["--widget-managed"]
  });
  // startBridge already drained the initial status

  const errResp = await sendAndExpect(ws, {
    type: "bridge:configure",
    payload: { token: "", allowedChats: "" }
  }, 3000, (m) => m.type === "bridge:status" && m.payload?.error === "Bot token missing");

  ok(errResp.type === "bridge:status", "Should get status for empty token config");
  strictEqual(errResp.payload?.error, "Bot token missing", "Error should say 'Bot token missing'");

  await stopBridge(proc, ws);
});
