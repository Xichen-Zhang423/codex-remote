import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { JsonlRpcClient } from "../src/jsonl-rpc-client.js";

const FOUR_MIB = 4 * 1024 * 1024;
const SIXTEEN_MIB = 16 * 1024 * 1024;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readFrames(output) {
  return output.read().toString().trim().split("\n").map((line) => JSON.parse(line));
}

class ControlledOutput extends EventEmitter {
  constructor(results = []) {
    super();
    this.results = [...results];
    this.frames = [];
  }

  write(frame) {
    this.frames.push(String(frame));
    return this.results.length ? this.results.shift() : true;
  }
}

test("JsonlRpcClient extends EventEmitter and applies bounded defaults", () => {
  const rpc = new JsonlRpcClient({ input: new PassThrough(), output: new PassThrough() });
  assert.ok(rpc instanceof EventEmitter);
  assert.equal(rpc.timeoutMs, 15000);
  assert.equal(rpc.maxFrameBytes, SIXTEEN_MIB);
  assert.equal(rpc.maxQueuedBytes, FOUR_MIB);
  rpc.close();
});

test("bounded defaults accept a five MiB App Server history frame", () => {
  const input = new PassThrough();
  const rpc = new JsonlRpcClient({ input, output: new PassThrough() });
  const seen = [];
  rpc.on("notification", (message) => seen.push(message));
  input.write(`${JSON.stringify({
    method: "thread/loaded",
    params: { history: "x".repeat(5 * 1024 * 1024) },
  })}\n`);
  assert.equal(rpc.closed, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].params.history.length, 5 * 1024 * 1024);
  rpc.close();
});

test("request writes a frame and resolves a response split across chunks", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100 });
  const pending = rpc.request("thread/list", { limit: 1 });
  const [request] = readFrames(output);
  assert.deepEqual(request, { method: "thread/list", id: 1, params: { limit: 1 } });
  input.write(`{"id":${request.id},"res`);
  input.write(`ult":{"data":[]}}\n`);
  assert.deepEqual(await pending, { data: [] });
  assert.equal(rpc.pending.size, 0);
  rpc.close();
});

test("request is pending before output.write can synchronously deliver a response", async () => {
  const input = new PassThrough();
  const output = { write(frame) {
    const request = JSON.parse(frame);
    input.write(`${JSON.stringify({ id: request.id, result: "immediate" })}\n`);
    return true;
  } };
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100 });
  assert.equal(await rpc.request("model/list", {}), "immediate");
  assert.equal(rpc.pending.size, 0);
  rpc.close();
});

test("multiple response lines correlate out of order", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100 });
  const first = rpc.request("thread/read", { threadId: "one" });
  const second = rpc.request("thread/read", { threadId: "two" });
  const [a, b] = readFrames(output);
  input.write(`${JSON.stringify({ id: b.id, result: "two" })}\n${JSON.stringify({ id: a.id, result: "one" })}\n`);
  assert.deepEqual(await Promise.all([first, second]), ["one", "two"]);
  rpc.close();
});

test("notification, server request, notify, respond, and respondError use distinct envelopes", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonlRpcClient({ input, output });
  const notification = once(rpc, "notification");
  const serverRequest = once(rpc, "serverRequest");
  input.write('{"method":"turn/started","params":{"id":"t"}}\n{"id":"approval","method":"approval/request","params":{}}\n');
  assert.equal((await notification)[0].method, "turn/started");
  assert.equal((await serverRequest)[0].id, "approval");
  rpc.notify("initialized", { ready: true });
  rpc.respond("approval", { decision: "decline" });
  rpc.respondError(12, -32602, "invalid params");
  assert.deepEqual(readFrames(output), [
    { method: "initialized", params: { ready: true } },
    { id: "approval", result: { decision: "decline" } },
    { id: 12, error: { code: -32602, message: "invalid params" } },
  ]);
  rpc.close();
});

test("remote errors preserve message, code, and data in RpcRemoteError", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100 });
  const pending = rpc.request("turn/start", {});
  const [request] = readFrames(output);
  input.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: "denied", data: { policy: "ask" } } })}\n`);
  const error = await pending.catch((reason) => reason);
  const { RpcRemoteError } = await import("../src/jsonl-rpc-client.js");
  assert.ok(error instanceof RpcRemoteError);
  assert.equal(error.message, "denied");
  assert.equal(error.code, -32000);
  assert.deepEqual(error.data, { policy: "ask" });
  assert.equal(rpc.pending.size, 0);
  rpc.close();
});

test("request timeout cleans pending state", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100 });
  const pending = rpc.request("thread/list", {}, { timeoutMs: 10 });
  const [request] = readFrames(output);
  const timeout = await pending.catch((error) => error);
  assert.equal(timeout.name, "RpcTimeoutError");
  assert.equal(timeout.code, "RPC_TIMEOUT");
  assert.equal(timeout.method, "thread/list");
  assert.equal(timeout.timeoutMs, 10);
  assert.match(timeout.message, /thread\/list timed out after 10ms/);
  assert.equal(rpc.pending.size, 0);
  input.write(`${JSON.stringify({ id: request.id, result: "late" })}\n`);
  rpc.close();
});

test("malformed lines emit protocolError and recover", async () => {
  const input = new PassThrough();
  const rpc = new JsonlRpcClient({ input, output: new PassThrough() });
  const protocolError = once(rpc, "protocolError");
  const notification = once(rpc, "notification");
  input.write('not json\n{"method":"turn/completed","params":{"ok":true}}\n');
  const [error, line] = await protocolError;
  assert.ok(error instanceof SyntaxError);
  assert.equal(line, "not json");
  assert.equal((await notification)[0].method, "turn/completed");
  rpc.close();
});

test("invalid parsed envelopes emit protocolError and never settle a pending request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100 });
  const pending = rpc.request("thread/read", {});
  const [request] = readFrames(output);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const errors = [];
  const notifications = [];
  rpc.on("protocolError", (error) => errors.push(error));
  rpc.on("notification", (message) => notifications.push(message));
  input.write([
    { id: request.id, result: "bad", error: { code: 1, message: "bad" } },
    { id: request.id, method: "bad", result: "bad" },
    { id: null, result: "bad" },
    { method: "bad", result: "bad" },
    { result: "bad" },
    { id: {}, method: "bad" },
  ].map(JSON.stringify).join("\n") + "\n");
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(errors.length, 6);
  assert.equal(notifications.length, 0);
  input.write(`${JSON.stringify({ id: request.id, result: "good" })}\n`);
  assert.equal(await pending, "good");
  rpc.close();
});

test("input/output errors and premature closes reject pending without unhandled error events", async (t) => {
  for (const [side, event] of [["input", "error"], ["output", "error"], ["input", "close"], ["output", "close"]]) {
    await t.test(`${side} ${event}`, async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100 });
      const pending = rpc.request("thread/list", {});
      output.read();
      const expected = new Error(`${side} failed`);
      const rejection = assert.rejects(pending, event === "error" ? (error) => error === expected : /closed/);
      assert.doesNotThrow(() => (side === "input" ? input : output).emit(event, expected));
      await rejection;
      assert.equal(rpc.closed, true);
      assert.equal(rpc.pending.size, 0);
    });
  }
});

test("close rejects pending, rejects every later send, and ignores late replies", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100 });
  const pending = rpc.request("thread/list", {});
  const [request] = readFrames(output);
  const reason = new Error("transport stopped");
  const rejection = assert.rejects(pending, (error) => error === reason);
  rpc.close(reason);
  await rejection;
  await assert.rejects(rpc.request("model/list", {}), (error) => error === reason);
  assert.throws(() => rpc.notify("initialized"), (error) => error === reason);
  assert.throws(() => rpc.respond(1, {}), (error) => error === reason);
  assert.throws(() => rpc.respondError(1, 1, "bad"), (error) => error === reason);
  input.write(`${JSON.stringify({ id: request.id, result: "late" })}\n`);
  assert.equal(rpc.pending.size, 0);
});

test("oversized unterminated and complete frames close transport and clear input", async (t) => {
  await t.test("unterminated", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100, maxFrameBytes: 32 });
    const pending = rpc.request("thread/list", {});
    output.read();
    input.write("x".repeat(33));
    await assert.rejects(pending, /frame exceeds 32 bytes/);
    assert.equal(rpc.closed, true);
    assert.equal(rpc.buffer, "");
  });
  await t.test("complete", () => {
    const input = new PassThrough();
    const rpc = new JsonlRpcClient({ input, output: new PassThrough(), maxFrameBytes: 48 });
    const seen = [];
    rpc.on("notification", (message) => seen.push(message));
    input.write(`${JSON.stringify({ method: "large", params: { value: "x".repeat(80) } })}\n{"method":"later"}\n`);
    assert.equal(rpc.closed, true);
    assert.equal(rpc.buffer, "");
    assert.deepEqual(seen, []);
  });
});

test("backpressure queues frames, starts response timeout after drain, and then flushes in order", async () => {
  const input = new PassThrough();
  const output = new ControlledOutput([false, true]);
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100, writeTimeoutMs: 100, maxQueuedBytes: 1024 });
  const first = rpc.request("first", {}, { timeoutMs: 100 });
  const second = rpc.request("second", {}, { timeoutMs: 10 });
  let secondSettled = false;
  second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
  try {
    assert.equal(output.frames.length, 1);
    assert.ok(rpc.queuedBytes > 0 && rpc.queuedBytes <= 1024);
    await delay(20);
    assert.equal(secondSettled, false);
    output.emit("drain");
    assert.equal(output.frames.length, 2);
    const [a, b] = output.frames.map((line) => JSON.parse(line));
    input.write(`${JSON.stringify({ id: a.id, result: "a" })}\n${JSON.stringify({ id: b.id, result: "b" })}\n`);
    assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
    assert.equal(rpc.queuedBytes, 0);
  } finally {
    rpc.close();
    await Promise.allSettled([first, second]);
  }
});

test("queue overflow is bounded and closes before queued side effects can be written", async () => {
  const input = new PassThrough();
  const output = new ControlledOutput([false]);
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100, writeTimeoutMs: 100, maxQueuedBytes: 64 });
  const pending = rpc.request("block", {});
  const outcome = pending.catch((error) => error);
  try {
    rpc.notify("small", {});
    assert.ok(rpc.queuedBytes <= 64);
    assert.throws(() => rpc.notify("large", { value: "x".repeat(100) }), /queue exceeds 64 bytes/);
    assert.match((await outcome).message, /queue exceeds 64 bytes/);
    assert.equal(output.frames.length, 1);
    assert.equal(rpc.queuedBytes, 0);
    output.emit("drain");
    assert.equal(output.frames.length, 1);
  } finally {
    rpc.close();
    await outcome;
  }
});

test("write/drain timeout closes transport and discards frames still queued", async () => {
  const input = new PassThrough();
  const output = new ControlledOutput([false]);
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100, writeTimeoutMs: 10 });
  const first = rpc.request("first", {});
  const second = rpc.request("side-effect", {});
  await assert.rejects(first, /output drain timed out after 10ms/);
  await assert.rejects(second, /output drain timed out after 10ms/);
  assert.equal(output.frames.length, 1);
  output.emit("drain");
  assert.equal(output.frames.length, 1);
});

test("close removes stream listeners, clears buffers/outbox, and stops later same-chunk events", async () => {
  const input = new PassThrough();
  const output = new ControlledOutput([false]);
  const rpc = new JsonlRpcClient({ input, output, timeoutMs: 100 });
  const pending = rpc.request("block", {});
  const outcome = pending.catch((error) => error);
  rpc.notify("queued", {});
  const seen = [];
  rpc.on("notification", (message) => {
    seen.push(message.method);
    rpc.close(new Error("listener stopped transport"));
  });
  input.write('{"method":"first"}\n{"method":"second"}\n');
  await outcome;
  assert.deepEqual(seen, ["first"]);
  assert.equal(rpc.buffer, "");
  assert.equal(rpc.outbox.length, 0);
  assert.equal(rpc.queuedBytes, 0);
  for (const event of ["data", "end", "error", "close"]) assert.equal(input.listenerCount(event), 0);
  for (const event of ["drain", "error", "close"]) assert.equal(output.listenerCount(event), 0);
  input.emit("data", '{"method":"third"}\n');
  assert.deepEqual(seen, ["first"]);
});
