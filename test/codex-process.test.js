import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import {
  CodexProcess,
  initializeAppServer,
  resolveCodexLaunch,
} from "../src/codex-process.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killCalls = 0;
  }

  kill() {
    this.killCalls += 1;
    return true;
  }
}

function readFrames(stream) {
  const chunk = stream.read();
  if (!chunk) return [];
  return chunk.toString().trim().split("\n").filter(Boolean).map(JSON.parse);
}

function createHarness(options = {}) {
  const children = options.children || [new FakeChild()];
  const calls = [];
  let index = 0;
  const spawnImpl = (...args) => {
    calls.push(args);
    if (options.throwError) throw options.throwError;
    return children[index++];
  };
  const manager = new CodexProcess({
    spawnImpl,
    packageBin: options.packageBin,
    env: options.env || {},
    platform: options.platform || "linux",
    stopGraceMs: options.stopGraceMs,
    stopForceMs: options.stopForceMs,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  });
  return { manager, child: children[0], calls };
}

function manualTimers() {
  const timers = [];
  return {
    timers,
    setTimer(fn, delay) {
      const timer = { fn, delay, cleared: false, ran: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    runNext() {
      const timer = timers.find((candidate) => !candidate.cleared && !candidate.ran);
      if (!timer) throw new Error("no pending manual timer");
      timer.ran = true;
      timer.fn();
      return timer;
    },
  };
}

async function finishInitialization(child, pending, result = { userAgent: "codex" }) {
  const [request] = readFrames(child.stdin);
  assert.equal(request.method, "initialize");
  child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  await pending;
  return request;
}

test("resolveCodexLaunch honors CODEX_BIN, package, and platform fallback precedence", () => {
  assert.deepEqual(resolveCodexLaunch({
    env: { CODEX_BIN: "D:\\tools\\codex.exe" },
    packageBin: "ignored.js",
    platform: "win32",
  }), { command: "D:\\tools\\codex.exe", argsPrefix: [], source: "CODEX_BIN" });
  assert.deepEqual(resolveCodexLaunch({ env: {}, packageBin: "codex.js", platform: "win32" }), {
    command: process.execPath,
    argsPrefix: ["codex.js"],
    source: "package",
  });
  assert.deepEqual(resolveCodexLaunch({ env: {}, platform: "win32" }), {
    command: "codex.cmd", argsPrefix: [], source: "PATH",
  });
  assert.deepEqual(resolveCodexLaunch({ env: {}, platform: "linux" }), {
    command: "codex", argsPrefix: [], source: "PATH",
  });
});

test("initializeAppServer awaits the exact initialize request before notifying initialized", async () => {
  const calls = [];
  let resolveRequest;
  const response = { userAgent: "codex" };
  const rpc = {
    request(method, params, options) {
      calls.push(["request", method, params, options]);
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
    notify(method, params) { calls.push(["notify", method, params]); },
  };
  const pending = initializeAppServer(rpc);
  assert.deepEqual(calls, [["request", "initialize", {
    clientInfo: { name: "codex_remote", title: "Codex Remote", version: "0.1.0" },
    capabilities: { experimentalApi: false },
  }, { timeoutMs: 30_000 }]]);
  resolveRequest(response);
  assert.equal(await pending, response);
  assert.deepEqual(calls[1], ["notify", "initialized", {}]);
});

test("start uses exact spawn arguments and exposes the owned child and RPC client", async () => {
  const { manager, child, calls } = createHarness({ packageBin: "D:\\pkg\\codex.js", platform: "win32" });
  const pending = manager.start();
  assert.deepEqual(calls, [[process.execPath, ["D:\\pkg\\codex.js", "app-server"], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }]]);
  assert.equal(manager.child, child);
  assert.ok(manager.rpc);
  await finishInitialization(child, pending);
  manager.stop();
});

test("start writes initialize before initialized on the real JSONL streams", async () => {
  const { manager, child } = createHarness({ env: { CODEX_BIN: "codex-custom" } });
  const pending = manager.start();
  const request = readFrames(child.stdin)[0];
  assert.deepEqual(request, {
    method: "initialize",
    id: 1,
    params: {
      clientInfo: { name: "codex_remote", title: "Codex Remote", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    },
  });
  assert.deepEqual(readFrames(child.stdin), []);
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { ready: true } })}\n`);
  await pending;
  assert.deepEqual(readFrames(child.stdin), [{ method: "initialized", params: {} }]);
  manager.stop();
});

test("forwards RPC events and stderr logs without changing their arguments", async () => {
  const { manager, child } = createHarness();
  await finishInitialization(child, manager.start());
  const notification = once(manager, "notification");
  const serverRequest = once(manager, "serverRequest");
  const protocolError = once(manager, "protocolError");
  const log = once(manager, "log");
  child.stdout.write('{"method":"turn/started","params":{"id":"t"}}\n');
  child.stdout.write('{"id":7,"method":"approval/request","params":{}}\n');
  child.stdout.write('not-json\n');
  child.stderr.write("warning from codex\n");
  assert.equal((await notification)[0].method, "turn/started");
  assert.equal((await serverRequest)[0].id, 7);
  const [error, line] = await protocolError;
  assert.ok(error instanceof SyntaxError);
  assert.equal(line, "not-json");
  assert.equal((await log)[0], "warning from codex\n");
  manager.stop();
});

test("initialization failure rejects start, closes RPC, kills the child, and clears references", async () => {
  const { manager, child } = createHarness();
  const pending = manager.start();
  const rpc = manager.rpc;
  const [request] = readFrames(child.stdin);
  child.stdout.write(`${JSON.stringify({
    id: request.id,
    error: { code: -32000, message: "initialize denied" },
  })}\n`);
  await assert.rejects(pending, /initialize denied/);
  assert.equal(rpc.closed, true);
  assert.equal(child.killCalls, 1);
  assert.equal(manager.child, null);
  assert.equal(manager.rpc, null);
});

test("a child error during startup rejects and cleans up", async () => {
  const { manager, child } = createHarness();
  const pending = manager.start();
  const rpc = manager.rpc;
  const failure = new Error("spawn failed asynchronously");
  child.emit("error", failure);
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(rpc.closed, true);
  assert.equal(child.killCalls, 1);
  assert.equal(manager.child, null);
  assert.equal(manager.rpc, null);
});

test("a child exit during startup drains initialization until close, then rejects and emits once", async () => {
  const { manager, child } = createHarness();
  const pending = manager.start();
  const [request] = readFrames(child.stdin);
  const exited = once(manager, "exit");
  child.emit("exit", 2, null);
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { ready: true } })}\n`);
  child.emit("close", 2, null);
  await assert.rejects(pending, /exited.*2/i);
  assert.deepEqual(await exited, [2, null]);
  child.emit("exit", 2, null);
  child.emit("close", 2, null);
  assert.equal(manager.child, null);
  assert.equal(manager.rpc, null);
});

test("a running child drains final RPC and stderr events before close finalizes one exit", async () => {
  const { manager, child } = createHarness();
  await finishInitialization(child, manager.start());
  readFrames(child.stdin);
  const rpc = manager.rpc;
  const response = rpc.request("final/check", {}, { timeoutMs: 100 });
  const [request] = readFrames(child.stdin);
  const notifications = [];
  const logs = [];
  const exits = [];
  manager.on("notification", (message) => notifications.push(message));
  manager.on("log", (message) => logs.push(message));
  manager.on("exit", (...args) => exits.push(args));

  child.emit("exit", 0, null);
  assert.equal(manager.child, child);
  assert.equal(manager.rpc, rpc);
  assert.deepEqual(exits, []);
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { drained: true } })}\n`);
  child.stdout.write('{"method":"turn/completed","params":{"id":"t"}}\n');
  child.stderr.write("final warning\n");
  assert.deepEqual(await response, { drained: true });
  assert.equal(notifications[0].method, "turn/completed");
  assert.deepEqual(logs, ["final warning\n"]);

  child.emit("close", 0, null);
  child.emit("close", 0, null);
  assert.deepEqual(exits, [[0, null]]);
  assert.equal(rpc.closed, true);
  assert.equal(manager.child, null);
  assert.equal(manager.rpc, null);
});

test("stop retires an old child so its later exit and close cannot affect a replacement", async () => {
  const oldChild = new FakeChild();
  const newChild = new FakeChild();
  const { manager } = createHarness({ children: [oldChild, newChild] });
  await finishInitialization(oldChild, manager.start());
  manager.stop();
  const replacement = manager.start();
  const replacementRpc = manager.rpc;
  const exits = [];
  manager.on("exit", (...args) => exits.push(args));

  oldChild.emit("exit", 0, null);
  oldChild.emit("close", 0, null);
  assert.deepEqual(exits, []);
  assert.equal(manager.child, newChild);
  assert.equal(manager.rpc, replacementRpc);
  await finishInitialization(newChild, replacement);
  manager.stop();
});

test("concurrent start calls share one promise and one child", async () => {
  const { manager, child, calls } = createHarness();
  const first = manager.start();
  const second = manager.start();
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  await finishInitialization(child, first);
  assert.equal(await second, await first);
  manager.stop();
});

test("a synchronous spawn failure is returned as a rejected shared start promise", async () => {
  const failure = new Error("cannot spawn");
  const { manager } = createHarness({ throwError: failure });
  const first = manager.start();
  const second = manager.start();
  assert.equal(first, second);
  await assert.rejects(first, (error) => error === failure);
  assert.equal(manager.child, null);
  assert.equal(manager.rpc, null);
});

test("stop is idempotent and closes and kills only the currently owned child once", async () => {
  const { manager, child } = createHarness();
  await finishInitialization(child, manager.start());
  const rpc = manager.rpc;
  manager.stop();
  manager.stop();
  assert.equal(rpc.closed, true);
  assert.equal(child.killCalls, 1);
  assert.equal(manager.child, null);
  assert.equal(manager.rpc, null);
});

test("stop settles only after the retired App Server child closes", async () => {
  const { manager, child } = createHarness();
  await finishInitialization(child, manager.start());

  const stopping = manager.stop();
  assert.equal(typeof stopping?.then, "function");
  let settled = false;
  stopping.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(child.killCalls, 1);

  child.emit("close", 0, null);
  await stopping;
  assert.equal(settled, true);
});

test("stop force-kills once and rejects if the child still never closes", async () => {
  const clock = manualTimers();
  const { manager, child } = createHarness({
    stopGraceMs: 5,
    stopForceMs: 5,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await finishInitialization(child, manager.start());

  const stopping = manager.stop();
  assert.equal(typeof stopping?.then, "function");
  assert.equal(clock.runNext().delay, 5);
  assert.equal(child.killCalls, 2);
  assert.equal(clock.runNext().delay, 5);
  await assert.rejects(stopping, (error) => error?.code === "APP_SERVER_STOP_TIMEOUT");
  assert.equal(child.killCalls, 2);
});

test("a stop timeout blocks every replacement until the retired child eventually closes", async () => {
  const clock = manualTimers();
  const oldChild = new FakeChild();
  const newChild = new FakeChild();
  const { manager, calls } = createHarness({
    children: [oldChild, newChild],
    stopGraceMs: 5,
    stopForceMs: 5,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await finishInitialization(oldChild, manager.start());
  const stopping = manager.stop();
  clock.runNext();
  clock.runNext();
  await assert.rejects(stopping, (error) => error?.code === "APP_SERVER_STOP_TIMEOUT");

  const blocked = manager.start();
  try {
    assert.equal(calls.length, 1);
    await assert.rejects(blocked, (error) => error?.code === "APP_SERVER_STOP_TIMEOUT");
  } finally {
    if (calls.length > 1) {
      const cleanup = manager.stop();
      newChild.emit("close", 0, null);
      await cleanup;
      await Promise.allSettled([blocked]);
    }
  }

  oldChild.emit("close", 0, null);
  const replacement = manager.start();
  assert.equal(calls.length, 2);
  await finishInitialization(newChild, replacement);
  const cleanup = manager.stop();
  newChild.emit("close", 0, null);
  await cleanup;
});

test("retired child absorbs post-kill errors until close without affecting a replacement", async () => {
  const oldChild = new FakeChild();
  const newChild = new FakeChild();
  const { manager } = createHarness({ children: [oldChild, newChild] });
  await finishInitialization(oldChild, manager.start());
  manager.stop();

  assert.equal(oldChild.killCalls, 1);
  assert.doesNotThrow(() => oldChild.emit("error", new Error("late kill error")));

  const replacement = manager.start();
  const replacementRpc = manager.rpc;
  const exits = [];
  manager.on("exit", (...args) => exits.push(args));
  oldChild.emit("exit", 1, null);
  oldChild.emit("close", 1, null);

  assert.equal(oldChild.listenerCount("error"), 0);
  assert.deepEqual(exits, []);
  assert.equal(manager.child, newChild);
  assert.equal(manager.rpc, replacementRpc);
  await finishInitialization(newChild, replacement);
  manager.stop();
  newChild.emit("close", 0, null);
});

test("startup exit drains an initialize error until close and blocks replacement", async () => {
  const oldChild = new FakeChild();
  const newChild = new FakeChild();
  const { manager, calls } = createHarness({ children: [oldChild, newChild] });
  const pending = manager.start();
  const rpc = manager.rpc;
  const [request] = readFrames(oldChild.stdin);
  const notifications = [];
  const logs = [];
  const exits = [];
  manager.on("notification", (message) => notifications.push(message));
  manager.on("log", (message) => logs.push(message));
  manager.on("exit", (...args) => exits.push(args));

  oldChild.emit("exit", 9, "SIGTERM");
  const rejected = assert.rejects(pending, /initialize denied/);
  oldChild.stdout.write(`${JSON.stringify({
    id: request.id,
    error: { code: -32000, message: "initialize denied" },
  })}\n`);
  await rejected;

  assert.equal(manager.child, oldChild);
  assert.equal(manager.rpc, rpc);
  assert.equal(rpc.closed, false);
  const blocked = manager.start();
  assert.equal(blocked, pending);
  await assert.rejects(blocked, /initialize denied/);
  assert.equal(calls.length, 1);

  oldChild.stdout.write('{"method":"turn/completed","params":{"id":"buffered"}}\n');
  oldChild.stderr.write("buffered warning\n");
  assert.equal(notifications[0].params.id, "buffered");
  assert.deepEqual(logs, ["buffered warning\n"]);

  oldChild.emit("close", 9, "SIGTERM");
  oldChild.emit("close", 9, "SIGTERM");
  assert.deepEqual(exits, [[9, "SIGTERM"]]);
  assert.equal(rpc.closed, true);
  assert.equal(manager.child, null);
  assert.equal(manager.rpc, null);

  const replacement = manager.start();
  assert.equal(calls.length, 2);
  await finishInitialization(newChild, replacement);
  manager.stop();
  newChild.emit("close", 0, null);
});
