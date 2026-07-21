import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { checkCodexLoginStatus } from "../src/codex-status.js";

function spawnClosing(code, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter(); child.kill = () => child.emit("close", null);
    queueMicrotask(() => child.emit("close", code)); return child;
  };
}

test("checks the pinned package CLI without capturing account output", async () => {
  const calls = [];
  const status = await checkCodexLoginStatus({ packageBin: "C:\\runtime\\codex.js", spawnImpl: spawnClosing(0, calls) });
  assert.equal(status, "logged-in");
  assert.deepEqual(calls[0].args, ["C:\\runtime\\codex.js", "login", "status"]);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.shell, false);
});

test("maps logged-out and error states without returning CLI text", async () => {
  assert.equal(await checkCodexLoginStatus({ spawnImpl: spawnClosing(1, []) }), "logged-out");
  const failingSpawn = () => { const child = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => child.emit("error", new Error("secret output"))); return child; };
  assert.equal(await checkCodexLoginStatus({ spawnImpl: failingSpawn }), "unknown");
});

test("kills a bounded login probe on timeout", async () => {
  let killed = 0;
  const child = new EventEmitter(); child.kill = () => { killed += 1; };
  let callback;
  const result = checkCodexLoginStatus({
    spawnImpl: () => child,
    setTimer: (handler) => { callback = handler; return { unref() {} }; },
    clearTimer: () => {},
  });
  callback();
  assert.equal(await result, "unknown");
  assert.equal(killed, 1);
});
