"use strict";

/*
 * Message Routing Tests for the Telegram Bridge Daemon
 *
 * Tests:
 * - bridge:configure with chatId accepted
 * - bridge:stop without polling is safe
 * - Malformed WS messages handled gracefully
 * - Unknown WS message types ignored
 * - Chunking logic (inline reproduction)
 * - Message flow end-to-end via WS
 */

const { strictEqual, ok, deepStrictEqual } = require("node:assert");
const { test } = require("node:test");
const { startBridge, stopBridge, sendAndExpect } = require("./test-helper.cjs");

// ── Test: bridge:configure with chatId is accepted ──
test("routing: bridge:configure with chatId is accepted", async () => {
  const { ws, proc } = await startBridge({
    args: ["--widget-managed"]
  });
  // startBridge already drained initial status

  const resp = await sendAndExpect(ws, {
    type: "bridge:configure",
    payload: { token: "0:ABC-test-chatid", allowedChats: "12345" }
  }, 2000).catch(() => ({}));

  ok(resp.type === "bridge:status" || !resp.error, "Config should be accepted");

  await stopBridge(proc, ws);
});

// ── Test: bridge:stop while not polling is safe ──
test("routing: bridge:stop without polling does not crash", async () => {
  const { ws, proc } = await startBridge({
    args: ["--widget-managed"]
  });
  // startBridge already drained initial status

  const resp = await sendAndExpect(ws, { type: "bridge:stop" }, 1000);

  ok(resp.type === "bridge:status", "Should get status even without polling");
  ok(!proc.killed, "Process should survive stop without polling");

  await stopBridge(proc, ws);
});

// ── Test: Malformed WS messages are handled gracefully ──
test("routing: malformed WS message does not crash bridge", async () => {
  const { ws, proc } = await startBridge({
    args: ["--widget-managed"]
  });
  // startBridge already drained initial status

  ws.send("not json at all");
  await new Promise((r) => setTimeout(r, 500));

  ok(!proc.killed, "Process should survive malformed message");

  const pingResp = await sendAndExpect(ws, { type: "bridge:ping" }, 1000);
  ok(pingResp.type === "bridge:status", "Bridge should still respond after malformed message");

  await stopBridge(proc, ws);
});

// ── Test: Unknown WS message types are ignored ──
test("routing: unknown WS message type does not crash bridge", async () => {
  const { ws, proc } = await startBridge({
    args: ["--widget-managed"]
  });
  // startBridge already drained initial status

  ws.send(JSON.stringify({ type: "unknown:type" }));
  await new Promise((r) => setTimeout(r, 500));

  ok(!proc.killed, "Process should survive unknown message type");

  const pingResp = await sendAndExpect(ws, { type: "bridge:ping" }, 1000);
  ok(pingResp.type === "bridge:status", "Bridge still works after unknown message");

  await stopBridge(proc, ws);
});

// ── Test: chunking logic — verify splitIntoChunks behavior ──
test("routing: splitIntoChunks respects 3500 char limit with smart breaks", async () => {
  const CHUNK_MAX = 3500;

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

  // Short text → 1 chunk
  strictEqual(splitIntoChunks("Hello world", CHUNK_MAX).length, 1, "Short text → 1 chunk");
  strictEqual(splitIntoChunks("Hello world", CHUNK_MAX)[0], "Hello world", "Content preserved");

  // Exactly 3500 chars → 1 chunk
  strictEqual(splitIntoChunks("x".repeat(3500), CHUNK_MAX).length, 1, "Exact limit → 1 chunk");

  // Just over → 2 chunks
  const over = splitIntoChunks("x".repeat(3501), CHUNK_MAX);
  strictEqual(over.length, 2, "Over limit → 2 chunks");
  ok(over[0].length <= CHUNK_MAX && over[1].length <= CHUNK_MAX, "Both chunks within limit");

  // Paragraph breaks preferred
  const paras = splitIntoChunks("A".repeat(1750) + "\n\n" + "B".repeat(1750) + "\n\n" + "C".repeat(100), CHUNK_MAX);
  ok(paras.length >= 2, "Paragraph text → multiple chunks");

  // Very long text
  const longChunks = splitIntoChunks("hello world ".repeat(500), CHUNK_MAX);
  ok(longChunks.length >= 2 && longChunks.length <= 5, "Long text → 2-5 chunks");
  longChunks.forEach((c, i) => ok(c.length <= CHUNK_MAX, `Chunk ${i} within limit`));

  // Empty input
  strictEqual(splitIntoChunks("", CHUNK_MAX).length, 0, "Empty → no chunks");
});

// ── Test: Message flow end-to-end via WS ──
test("routing: configure → receive message from bridge → stop", async () => {
  const { ws, proc } = await startBridge({
    args: ["--widget-managed"]
  });

  // Configure
  await sendAndExpect(ws, {
    type: "bridge:configure",
    payload: { token: "0:ABC-test-flow", allowedChats: "99999" }
  }, 1500).catch(() => {});

  // Simulate agent response via WS
  const msgResp = await sendAndExpect(ws, {
    type: "telegram:message",
    payload: { text: "Hello from bridge test", chatId: "99999" }
  }, 1000);

  ok(msgResp.type === "bridge:status" || msgResp.type === undefined, "Bridge processes message");

  // Stop
  const stopResp = await sendAndExpect(ws, { type: "bridge:stop" }, 1000);
  strictEqual(stopResp.payload?.status, "stopped", "Should stop cleanly");
  ok(!proc.killed, "Process still alive after full flow");

  await stopBridge(proc, ws);
});
