import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexAdapter } from "../src/codex-adapter.js";
import { RpcRemoteError } from "../src/jsonl-rpc-client.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message = "condition") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${message}`);
}

function makeRpc(handler = async () => ({})) {
  const calls = [];
  const responses = [];
  const errors = [];
  return {
    calls,
    responses,
    errors,
    async request(method, params) {
      calls.push([method, params]);
      return handler(method, params, calls.length);
    },
    respond(id, result) { responses.push([id, result]); },
    respondError(id, code, message) { errors.push([id, code, message]); },
  };
}

function makeBroker() {
  return {
    registered: [],
    decisions: [],
    cleared: [],
    closed: [],
    sessionAuto: false,
    register(request) { this.registered.push(request); return `approval-${this.registered.length}`; },
    async decide(id, action, payload) { this.decisions.push([id, action, payload]); return true; },
    async clear(value) { this.cleared.push(value); return 0; },
    async close(reason) { this.closed.push(reason); return 0; },
    setSessionAuto(value) { this.sessionAuto = value === true; return this.sessionAuto; },
    pendingEvents() { return []; },
  };
}

function makeArtifactTracker(overrides = {}) {
  const calls = [];
  const tracker = {
    calls,
    async beginTurn(input) {
      calls.push(["beginTurn", input]);
      return { localTaskId: input.localTaskId };
    },
    async bindTurnId(handle, turnId) { calls.push(["bindTurnId", handle, turnId]); },
    noteFileChange(handle, item) { calls.push(["noteFileChange", handle, item]); },
    async finishTurn(handle, options) { calls.push(["finishTurn", handle, options]); },
    async abortTurn(handle, options) { calls.push(["abortTurn", handle, options]); },
  };
  return Object.assign(tracker, overrides);
}

class FakeProcess extends EventEmitter {
  constructor(rpc) {
    super();
    this.rpc = rpc;
    this.starts = 0;
    this.stops = 0;
  }
  async start() { this.starts += 1; return { userAgent: "fake" }; }
  stop() { this.stops += 1; }
}

class SequencedProcess extends EventEmitter {
  constructor(steps) {
    super();
    this.steps = [...steps];
    this.rpc = null;
    this.starts = 0;
    this.stops = 0;
  }
  async start() {
    this.starts += 1;
    const step = this.steps.shift();
    if (step instanceof Error) {
      this.rpc = null;
      throw step;
    }
    this.rpc = step;
    return { userAgent: `fake-${this.starts}` };
  }
  stop() { this.stops += 1; this.rpc = null; }
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
  };
}

test("start binds process events once and stop detaches them", async () => {
  const rpc = makeRpc();
  const process = new FakeProcess(rpc);
  const events = [];
  const adapter = new CodexAdapter({ process, cwd: "D:\\repo", emit: (event) => events.push(event) });
  await adapter.start();
  await adapter.start();
  assert.equal(process.starts, 1);
  for (const name of ["notification", "serverRequest", "exit", "log", "protocolError"]) {
    assert.equal(process.listenerCount(name), 1);
  }
  process.emit("notification", { method: "item/agentMessage/delta", params: { delta: "hi" } });
  await waitFor(() => events.some((event) => event.type === "assistant_delta"));
  await adapter.stop();
  for (const name of ["notification", "serverRequest", "exit", "log", "protocolError"]) {
    assert.equal(process.listenerCount(name), 0);
  }
  assert.equal(process.stops, 1);
});

test("initial initialize timeout is reported and retried once with a clean process", async () => {
  const rpc = makeRpc();
  const splitSecret = `sk-${"A".repeat(40)}`;
  class TransientProcess extends EventEmitter {
    constructor() {
      super();
      this.rpc = null;
      this.starts = 0;
      this.stops = 0;
    }
    async start() {
      this.starts += 1;
      if (this.starts === 1) {
        this.emit("log", `temporary startup warning ${splitSecret.slice(0, 10)}`);
        this.emit("log", `${splitSecret.slice(10)}\n`);
        const error = new Error("initialize timed out after 30000ms");
        error.code = "RPC_TIMEOUT";
        error.method = "initialize";
        error.timeoutMs = 30_000;
        throw error;
      }
      this.rpc = rpc;
      return { userAgent: "recovered" };
    }
    stop() { this.stops += 1; this.rpc = null; }
  }
  const process = new TransientProcess();
  const diagnostics = [];
  const adapter = new CodexAdapter({
    process,
    cwd: "D:\\repo",
    onError: (error) => diagnostics.push(error.message),
  });

  assert.deepEqual(await adapter.start(), { userAgent: "recovered" });
  assert.equal(process.starts, 2);
  assert.equal(process.stops, 1);
  assert.equal(adapter.started, true);
  assert.equal(adapter.appServerStatus, "online");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /initialize timed out.*retrying once/i);
  assert.match(diagnostics[0], /temporary startup warning/i);
  assert.equal(diagnostics[0].replace(/\s+/g, "").includes(splitSecret), false);
  assert.match(diagnostics[0], /\[redacted\]/);
  await adapter.stop();
});

test("a second initialize timeout fails without an unbounded startup loop", async () => {
  const timeout = () => {
    const error = new Error("initialize timed out after 30000ms");
    error.code = "RPC_TIMEOUT";
    error.method = "initialize";
    error.timeoutMs = 30_000;
    return error;
  };
  const process = new SequencedProcess([timeout(), timeout(), makeRpc()]);
  const diagnostics = [];
  const adapter = new CodexAdapter({
    process,
    cwd: "D:\\repo",
    onError: (error) => diagnostics.push(error.message),
  });

  await assert.rejects(adapter.start(), /initialize timed out after 30000ms/);
  assert.equal(process.starts, 2);
  assert.equal(process.stops, 2);
  assert.equal(adapter.started, false);
  assert.equal(adapter.appServerStatus, "offline");
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0], /retrying once/i);
  assert.match(diagnostics[1], /failed after retry/i);
});

test("initialize retry waits for confirmed cleanup before starting a replacement", async () => {
  const closeGate = deferred();
  const rpc = makeRpc();
  class ClosingProcess extends EventEmitter {
    constructor() {
      super();
      this.rpc = null;
      this.starts = 0;
      this.stops = 0;
    }
    async start() {
      this.starts += 1;
      if (this.starts === 1) {
        const error = new Error("initialize timed out after 30000ms");
        error.code = "RPC_TIMEOUT";
        error.method = "initialize";
        throw error;
      }
      this.rpc = rpc;
      return { userAgent: "replacement" };
    }
    stop() {
      this.stops += 1;
      this.rpc = null;
      return closeGate.promise;
    }
  }
  const process = new ClosingProcess();
  const adapter = new CodexAdapter({ process, cwd: "D:\\repo" });

  const starting = adapter.start();
  await waitFor(() => process.stops === 1, "failed process cleanup");
  assert.equal(process.starts, 1);
  closeGate.resolve();
  assert.deepEqual(await starting, { userAgent: "replacement" });
  assert.equal(process.starts, 2);
  await adapter.stop();
});

test("maps thread, history, and model operations to pinned v2 methods", async () => {
  const rpc = makeRpc(async (method, params) => {
    if (method === "thread/start") return { thread: { id: "new-thread", turns: [] } };
    if (method === "thread/resume") return { thread: { id: params.threadId, turns: [] } };
    if (method === "thread/read") return { thread: { id: params.threadId, turns: [] } };
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (method === "model/list") return { data: [{ id: "gpt-test" }], nextCursor: null };
    return {};
  });
  const adapter = new CodexAdapter({ rpc, cwd: "D:\\repo", model: "gpt-test", effort: "high" });
  await adapter.newThread({ cwd: "D:\\next", model: "gpt-next", effort: "medium" });
  await adapter.listThreads({ searchTerm: "ship", cwd: "D:\\next", cursor: "c1", limit: 25 });
  const history = await adapter.readThread("thread-1");
  await adapter.resumeThread("thread-2");
  await adapter.renameThread("thread-2", "Release work");
  await adapter.archiveThread("thread-2");
  await adapter.listModels({ cursor: "m1", limit: 50 });

  assert.deepEqual(rpc.calls, [
    ["thread/start", {
      cwd: "D:\\next", model: "gpt-next", approvalPolicy: "on-request",
      approvalsReviewer: "user", sandbox: "workspace-write",
    }],
    ["thread/list", { searchTerm: "ship", cwd: "D:\\next", cursor: "c1", limit: 25, archived: false }],
    ["thread/read", { threadId: "thread-1", includeTurns: true }],
    ["thread/resume", {
      threadId: "thread-2", cwd: "D:\\next", model: "gpt-next",
      approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write",
    }],
    ["thread/name/set", { threadId: "thread-2", name: "Release work" }],
    ["thread/archive", { threadId: "thread-2" }],
    ["model/list", { cursor: "m1", limit: 50, includeHidden: false }],
  ]);
  assert.deepEqual(history.events, []);
  assert.equal(adapter.threadId, "thread-2");
  assert.equal(adapter.effort, "medium");
});

test("history RPCs use a longer timeout without relaxing interactive requests", async () => {
  const calls = [];
  const rpc = {
    async request(method, params, options) {
      calls.push([method, options]);
      if (method === "thread/list") return { data: [], nextCursor: null };
      if (method === "thread/read" || method === "thread/resume") {
        return { thread: { id: params.threadId, cwd: params.cwd, turns: [] } };
      }
      if (method === "model/list") return { data: [], nextCursor: null };
      return {};
    },
  };
  const adapter = new CodexAdapter({ rpc, cwd: "D:\\repo" });

  await adapter.listThreads();
  await adapter.readThread("thread-old", { includeTurns: false });
  await adapter.resumeThread("thread-old", { cwd: "D:\\stored" });
  await adapter.listModels();

  assert.deepEqual(calls, [
    ["thread/list", { timeoutMs: 60_000 }],
    ["thread/read", { timeoutMs: 60_000 }],
    ["thread/resume", { timeoutMs: 60_000 }],
    ["model/list", undefined],
  ]);
});

test("resume adopts the selected thread cwd and reuses its returned history", async () => {
  const rpc = makeRpc(async (method, params) => {
    if (method !== "thread/resume") return {};
    return {
      thread: {
        id: params.threadId,
        cwd: params.cwd,
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [
            { type: "userMessage", id: "user-1", content: [{ type: "text", text: "old question" }] },
            { type: "agentMessage", id: "agent-1", text: "old answer" },
          ],
        }],
      },
    };
  });
  const adapter = new CodexAdapter({ rpc, cwd: "D:\\current" });

  const resumed = await adapter.resumeThread("thread-old", { cwd: "E:\\stored-workspace" });

  assert.equal(adapter.cwd, "E:\\stored-workspace");
  assert.equal(adapter.threadId, "thread-old");
  assert.deepEqual(resumed.events, [
    { type: "user_echo", text: "old question" },
    { type: "assistant", text: "old answer" },
    { type: "result", status: "completed" },
  ]);
  assert.deepEqual(rpc.calls, [[
    "thread/resume",
    {
      threadId: "thread-old",
      cwd: "E:\\stored-workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    },
  ]]);
});

test("starts a safe turn with text, local images, cwd, model, and effort", async () => {
  let cleaned = 0;
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thr1" } };
    if (method === "turn/start") return { turn: { id: "turn1", status: "inProgress" } };
    return {};
  });
  const adapter = new CodexAdapter({
    rpc,
    cwd: "D:\\repo",
    model: "gpt-test",
    effort: "high",
    materializeImages: async () => ({
      inputs: [{ type: "localImage", path: "D:\\tmp\\one.png" }],
      paths: ["D:\\tmp\\one.png"],
      cleanup: async () => { cleaned += 1; },
    }),
  });
  const pending = adapter.sendPrompt({ text: "run tests", images: ["data:image/png;base64,AA=="] });
  await waitFor(() => rpc.calls.some(([method]) => method === "turn/start"), "turn/start");
  const [, params] = rpc.calls.find(([method]) => method === "turn/start");
  assert.deepEqual(params, {
    threadId: "thr1",
    input: [
      { type: "text", text: "run tests" },
      { type: "localImage", path: "D:\\tmp\\one.png" },
    ],
    cwd: "D:\\repo",
    model: "gpt-test",
    effort: "high",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite", writableRoots: ["D:\\repo"], networkAccess: true,
    },
  });
  assert.equal(cleaned, 0);
  await adapter.handleNotification("turn/completed", {
    threadId: "thr1", turn: { id: "turn1", status: "completed" },
  });
  assert.deepEqual(await pending, { id: "turn1", status: "completed" });
  assert.equal(cleaned, 1);
});

test("begins artifact tracking immediately before turn/start and binds before turn_started", async () => {
  const order = [];
  const bindGate = deferred();
  let handle;
  const tracker = makeArtifactTracker({
    async beginTurn(input) {
      order.push("begin");
      handle = { localTaskId: input.localTaskId };
      assert.match(input.localTaskId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.deepEqual(input, {
        localTaskId: input.localTaskId,
        threadId: "artifact-thread",
        cwd: "D:\\repo",
        cwdGeneration: 0,
      });
      return handle;
    },
    async bindTurnId(boundHandle, turnId) {
      order.push("bind");
      assert.strictEqual(boundHandle, handle);
      assert.equal(turnId, "artifact-turn");
      await bindGate.promise;
      order.push("bound");
    },
  });
  const events = [];
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "artifact-thread" } };
    if (method === "turn/start") {
      order.push("rpc");
      return { turn: { id: "artifact-turn" } };
    }
    return {};
  });
  const adapter = new CodexAdapter({
    rpc, artifactTracker: tracker, cwd: "D:\\repo",
    emit: (event) => { if (event.type === "turn_started") { order.push("emit"); events.push(event); } },
  });

  const pending = adapter.sendPrompt({ text: "track me" });
  await waitFor(() => order.includes("bind"), "artifact bind");
  assert.deepEqual(order, ["begin", "rpc", "bind"]);
  assert.deepEqual(events, []);
  bindGate.resolve();
  await waitFor(() => events.length === 1, "turn_started after bind");
  assert.deepEqual(order, ["begin", "rpc", "bind", "bound", "emit"]);
  await adapter.handleNotification("turn/completed", {
    threadId: "artifact-thread", turn: { id: "artifact-turn", status: "completed" },
  });
  await pending;
});

test("holds an early matching completion until artifact bind settles, then emits start before completion", async () => {
  const bindGate = deferred();
  const tracker = makeArtifactTracker({
    async bindTurnId(handle, turnId) {
      this.calls.push(["bindTurnId", handle, turnId]);
      await bindGate.promise;
      this.calls.push(["bindComplete", handle, turnId]);
    },
  });
  const events = [];
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "pending-bind-terminal-thread" } };
    if (method === "turn/start") return { turn: { id: "pending-bind-terminal-turn" } };
    return {};
  });
  const adapter = new CodexAdapter({
    rpc, artifactTracker: tracker, cwd: "D:\\repo",
    emit: (event) => events.push(event),
  });
  let resolved = false;
  const pending = adapter.sendPrompt({ text: "early terminal while binding" }).then((turn) => {
    resolved = true;
    return turn;
  });
  await waitFor(() => tracker.calls.some(([method]) => method === "bindTurnId"));
  const terminal = adapter.handleNotification("turn/completed", {
    threadId: "pending-bind-terminal-thread",
    turn: { id: "pending-bind-terminal-turn", status: "completed" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resolved, false);
  assert.equal(tracker.calls.some(([method]) => method === "finishTurn"), false);
  assert.equal(events.some(({ type }) => type === "turn_started"), false);
  assert.equal(events.some(({ type }) => type === "result"), false);

  bindGate.resolve();
  await terminal;
  assert.deepEqual(await pending, { id: "pending-bind-terminal-turn", status: "completed" });
  const finishes = tracker.calls.filter(([method]) => method === "finishTurn");
  assert.equal(finishes.length, 1);
  const visible = events.filter(({ type }) => type === "turn_started" || type === "result");
  assert.deepEqual(visible.map(({ type }) => type), ["turn_started", "result"]);
});

test("stop waits for pending artifact bind, then finishes once without a stale turn_started", async () => {
  const bindGate = deferred();
  const tracker = makeArtifactTracker({
    async bindTurnId(handle, turnId) {
      this.calls.push(["bindTurnId", handle, turnId]);
      await bindGate.promise;
    },
  });
  const events = [];
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "pending-bind-stop-thread" } };
    if (method === "turn/start") return { turn: { id: "pending-bind-stop-turn" } };
    return {};
  });
  const process = new FakeProcess(rpc);
  const adapter = new CodexAdapter({
    process, artifactTracker: tracker, cwd: "D:\\repo", emit: (event) => events.push(event),
  });
  await adapter.start();
  let rejected = false;
  const pending = adapter.sendPrompt({ text: "stop while binding" });
  pending.catch(() => { rejected = true; });
  await waitFor(() => tracker.calls.some(([method]) => method === "bindTurnId"));
  let stopped = false;
  const stopping = adapter.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, false);
  assert.equal(rejected, false);
  assert.equal(tracker.calls.some(([method]) => method === "finishTurn"), false);
  bindGate.resolve();
  await stopping;
  await assert.rejects(pending, /stopped/i);
  assert.equal(tracker.calls.filter(([method]) => method === "finishTurn").length, 1);
  assert.equal(events.some(({ type }) => type === "turn_started"), false);
});

test("process exit waits for pending artifact bind before finishing without a stale turn_started", async () => {
  const bindGate = deferred();
  const tracker = makeArtifactTracker({
    async bindTurnId(handle, turnId) {
      this.calls.push(["bindTurnId", handle, turnId]);
      await bindGate.promise;
    },
  });
  const broker = makeBroker();
  const events = [];
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "pending-bind-exit-thread" } };
    if (method === "turn/start") return { turn: { id: "pending-bind-exit-turn" } };
    return {};
  });
  const process = new FakeProcess(rpc);
  const adapter = new CodexAdapter({
    process, approvalBroker: broker, artifactTracker: tracker, cwd: "D:\\repo",
    emit: (event) => events.push(event),
  });
  await adapter.start();
  let rejected = false;
  const pending = adapter.sendPrompt({ text: "exit while binding" });
  pending.catch(() => { rejected = true; });
  await waitFor(() => tracker.calls.some(([method]) => method === "bindTurnId"));
  process.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rejected, false);
  assert.deepEqual(broker.closed, []);
  assert.equal(tracker.calls.some(([method]) => method === "finishTurn"), false);
  bindGate.resolve();
  await assert.rejects(pending, /exited/i);
  await waitFor(() => broker.closed.length === 1, "bind-pending exit cleanup");
  assert.equal(tracker.calls.filter(([method]) => method === "finishTurn").length, 1);
  assert.equal(events.some(({ type }) => type === "turn_started"), false);
  await adapter.stop();
});

test("reports artifact bind rejection once and still finishes the confirmed tracker turn", async () => {
  const errors = [];
  const tracker = makeArtifactTracker({
    async bindTurnId() { throw new Error("bind rejected"); },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "bind-reject-thread" } };
    if (method === "turn/start") return { turn: { id: "bind-reject-turn" } };
    return {};
  });
  const adapter = new CodexAdapter({
    rpc, artifactTracker: tracker, cwd: "D:\\repo",
    onError: (error) => errors.push(error.message),
  });
  const pending = adapter.sendPrompt({ text: "bind rejection" });
  await waitFor(() => errors.length === 1);
  await adapter.handleNotification("turn/completed", {
    threadId: "bind-reject-thread", turn: { id: "bind-reject-turn", status: "completed" },
  });
  await pending;
  assert.deepEqual(errors, ["bind rejected"]);
  assert.equal(tracker.calls.filter(([method]) => method === "finishTurn").length, 1);
  assert.equal(tracker.calls.some(([method]) => method === "abortTurn"), false);
});

test("defers queued turn/start and prompt resolution until artifact finish settles", async () => {
  const finishGate = deferred();
  const order = [];
  let nextTurn = 0;
  const tracker = makeArtifactTracker({
    async finishTurn(handle, options) {
      order.push(`finish:${handle.localTaskId}:${options.reason}`);
      await finishGate.promise;
      order.push("settled");
    },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "queue-thread" } };
    if (method === "turn/start") return { turn: { id: `queue-turn-${++nextTurn}` } };
    return {};
  });
  const adapter = new CodexAdapter({ rpc, artifactTracker: tracker, cwd: "D:\\repo" });
  let firstResolved = false;
  const first = adapter.sendPrompt({ text: "first" }).then((turn) => {
    firstResolved = true;
    order.push("resolved");
    return turn;
  });
  await waitFor(() => nextTurn === 1);
  const second = adapter.sendPrompt({ text: "second" });
  const completing = adapter.handleNotification("turn/completed", {
    threadId: "queue-thread", turn: { id: "queue-turn-1", status: "completed" },
  });
  await waitFor(() => order.some((entry) => entry.startsWith("finish:")), "artifact finish");
  assert.equal(firstResolved, false);
  assert.equal(nextTurn, 1);
  finishGate.resolve();
  await completing;
  await first;
  await waitFor(() => nextTurn === 2);
  assert.ok(order.indexOf("settled") < order.indexOf("resolved"));
  await adapter.handleNotification("turn/completed", {
    threadId: "queue-thread", turn: { id: "queue-turn-2", status: "completed" },
  });
  await second;
});

test("reports artifact begin failure but still starts and completes the Codex turn", async () => {
  const errors = [];
  let turnStarts = 0;
  const tracker = makeArtifactTracker({
    async beginTurn() { throw new Error("artifact begin failed"); },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "begin-failure-thread" } };
    if (method === "turn/start") {
      turnStarts += 1;
      return { turn: { id: "begin-failure-turn" } };
    }
    return {};
  });
  const adapter = new CodexAdapter({
    rpc, artifactTracker: tracker, cwd: "D:\\repo",
    onError: (error) => errors.push(error.message),
  });

  const pending = adapter.sendPrompt({ text: "still run" });
  await waitFor(() => turnStarts === 1, "Codex turn after artifact begin failure");
  await adapter.handleNotification("turn/completed", {
    threadId: "begin-failure-thread", turn: { id: "begin-failure-turn", status: "completed" },
  });
  assert.deepEqual(await pending, { id: "begin-failure-turn", status: "completed" });
  assert.deepEqual(errors, ["artifact begin failed"]);
  assert.equal(tracker.calls.some(([method]) => method === "abortTurn"), false);
});

test("stop waits for a pending artifact begin, then aborts its owned handle without starting a turn", async () => {
  const beginGate = deferred();
  const tracker = makeArtifactTracker({
    beginTurn(input) {
      this.calls.push(["beginTurn", input]);
      return beginGate.promise;
    },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "pending-stop-thread" } };
    if (method === "turn/start") return { turn: { id: "must-not-start" } };
    return {};
  });
  const process = new FakeProcess(rpc);
  const adapter = new CodexAdapter({ process, artifactTracker: tracker, cwd: "D:\\repo" });
  await adapter.start();
  let rejected = false;
  const pending = adapter.sendPrompt({ text: "stop during begin" });
  pending.catch(() => { rejected = true; });
  await waitFor(() => tracker.calls.some(([method]) => method === "beginTurn"));
  let stopped = false;
  const stopping = adapter.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, false);
  assert.equal(rejected, false);
  assert.equal(rpc.calls.some(([method]) => method === "turn/start"), false);

  const handle = { localTaskId: "pending-stop-local" };
  beginGate.resolve(handle);
  await stopping;
  await assert.rejects(pending, /stopped/i);
  const aborts = tracker.calls.filter(([method]) => method === "abortTurn");
  assert.equal(aborts.length, 1);
  assert.strictEqual(aborts[0][1], handle);
  assert.deepEqual(aborts[0][2], { reason: "adapter_stop" });
  assert.equal(rpc.calls.some(([method]) => method === "turn/start"), false);
});

test("process exit waits for a pending artifact begin before aborting once and completing cleanup", async () => {
  const beginGate = deferred();
  const tracker = makeArtifactTracker({
    beginTurn(input) {
      this.calls.push(["beginTurn", input]);
      return beginGate.promise;
    },
  });
  const broker = makeBroker();
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "pending-exit-thread" } };
    if (method === "turn/start") return { turn: { id: "must-not-start" } };
    return {};
  });
  const process = new FakeProcess(rpc);
  const adapter = new CodexAdapter({
    process, approvalBroker: broker, artifactTracker: tracker, cwd: "D:\\repo",
  });
  await adapter.start();
  let rejected = false;
  const pending = adapter.sendPrompt({ text: "exit during begin" });
  pending.catch(() => { rejected = true; });
  await waitFor(() => tracker.calls.some(([method]) => method === "beginTurn"));
  process.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rejected, false);
  assert.deepEqual(broker.closed, []);
  assert.equal(rpc.calls.some(([method]) => method === "turn/start"), false);

  const handle = { localTaskId: "pending-exit-local" };
  beginGate.resolve(handle);
  await assert.rejects(pending, /exited/i);
  await waitFor(() => broker.closed.length === 1, "process exit cleanup");
  const aborts = tracker.calls.filter(([method]) => method === "abortTurn");
  assert.equal(aborts.length, 1);
  assert.strictEqual(aborts[0][1], handle);
  assert.deepEqual(aborts[0][2], { reason: "app_server_exit" });
  assert.equal(rpc.calls.some(([method]) => method === "turn/start"), false);
  await adapter.stop();
});

test("a rejected pending artifact begin is reported once and cannot hang stop", async () => {
  const beginGate = deferred();
  const errors = [];
  const tracker = makeArtifactTracker({
    beginTurn(input) {
      this.calls.push(["beginTurn", input]);
      return beginGate.promise;
    },
  });
  const process = new FakeProcess(makeRpc(async (method) => (
    method === "thread/start" ? { thread: { id: "pending-reject-thread" } } : {}
  )));
  const adapter = new CodexAdapter({
    process, artifactTracker: tracker, cwd: "D:\\repo",
    onError: (error) => errors.push(error.message),
  });
  await adapter.start();
  const pending = adapter.sendPrompt({ text: "reject begin" });
  pending.catch(() => {});
  await waitFor(() => tracker.calls.some(([method]) => method === "beginTurn"));
  const stopping = adapter.stop();
  beginGate.reject(new Error("pending begin rejected"));
  await stopping;
  await assert.rejects(pending, /stopped/i);
  assert.deepEqual(errors, ["pending begin rejected"]);
  assert.equal(tracker.calls.some(([method]) => method === "abortTurn"), false);
});

test("aborts an unconfirmed artifact turn exactly once when turn/start fails", async () => {
  const tracker = makeArtifactTracker();
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "start-failure-thread" } };
    if (method === "turn/start") throw new Error("turn RPC failed");
    return {};
  });
  const adapter = new CodexAdapter({ rpc, artifactTracker: tracker, cwd: "D:\\repo" });

  await assert.rejects(adapter.sendPrompt({ text: "fails" }), /turn RPC failed/);
  const aborts = tracker.calls.filter(([method]) => method === "abortTurn");
  assert.equal(aborts.length, 1);
  assert.deepEqual(aborts[0].slice(2), [{ reason: "turn_start_failed" }]);
  assert.equal(tracker.calls.some(([method]) => method === "finishTurn"), false);
});

test("rejects cwd changes during an active turn and increments generation only for idle changes", async () => {
  const begins = [];
  let nextTurn = 0;
  const tracker = makeArtifactTracker({
    async beginTurn(input) {
      begins.push(input);
      return { localTaskId: input.localTaskId };
    },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "cwd-thread" } };
    if (method === "turn/start") return { turn: { id: `cwd-turn-${++nextTurn}` } };
    return {};
  });
  const adapter = new CodexAdapter({ rpc, artifactTracker: tracker, cwd: "D:\\repo" });
  assert.equal(adapter.setCwd("D:\\one"), "D:\\one");
  const first = adapter.sendPrompt({ text: "first" });
  await waitFor(() => nextTurn === 1);
  assert.throws(() => adapter.setCwd("D:\\blocked"), /cannot change cwd while a turn is active/);
  assert.equal(begins[0].cwd, "D:\\one");
  assert.equal(begins[0].cwdGeneration, 1);
  await adapter.handleNotification("turn/completed", {
    threadId: "cwd-thread", turn: { id: "cwd-turn-1", status: "completed" },
  });
  await first;

  assert.equal(adapter.setCwd("D:\\two"), "D:\\two");
  const second = adapter.sendPrompt({ text: "second" });
  await waitFor(() => nextTurn === 2);
  assert.equal(begins[1].cwd, "D:\\two");
  assert.equal(begins[1].cwdGeneration, 2);
  await adapter.handleNotification("turn/completed", {
    threadId: "cwd-thread", turn: { id: "cwd-turn-2", status: "completed" },
  });
  await second;
});

test("notes only matching completed fileChange items for the active artifact turn", async () => {
  const tracker = makeArtifactTracker();
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "file-thread" } };
    if (method === "turn/start") return { turn: { id: "file-turn" } };
    return {};
  });
  const adapter = new CodexAdapter({ rpc, artifactTracker: tracker, cwd: "D:\\repo" });
  const pending = adapter.sendPrompt({ text: "change files" });
  await waitFor(() => tracker.calls.some(([method]) => method === "bindTurnId"), "bound artifact turn");
  const completed = { type: "fileChange", status: "completed", changes: [{ path: "ok.txt" }] };
  const cases = [
    ["file-thread", "file-turn", completed],
    ["file-thread", "file-turn", { ...completed, status: "pending" }],
    ["file-thread", "file-turn", { ...completed, status: "failed" }],
    ["file-thread", "file-turn", { type: "commandExecution", status: "completed" }],
    ["other-thread", "file-turn", completed],
    ["file-thread", "other-turn", completed],
    ["file-thread", "file-turn", { type: "fileChange" }],
  ];
  for (const [threadId, turnId, item] of cases) {
    await adapter.handleNotification("item/completed", { threadId, turnId, item });
  }

  const notes = tracker.calls.filter(([method]) => method === "noteFileChange");
  assert.equal(notes.length, 1);
  assert.strictEqual(notes[0][2], completed);
  await adapter.handleNotification("turn/completed", {
    threadId: "file-thread", turn: { id: "file-turn", status: "completed" },
  });
  await pending;
});

test("replays only the confirmed turn early fileChange after artifact binding completes", async () => {
  const responseGate = deferred();
  const bindGate = deferred();
  const tracker = makeArtifactTracker({
    async bindTurnId(handle, turnId) {
      this.calls.push(["bindTurnId", handle, turnId]);
      await bindGate.promise;
      this.calls.push(["bindComplete", handle, turnId]);
    },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "early-file-thread" } };
    if (method === "turn/start") return responseGate.promise;
    return {};
  });
  const adapter = new CodexAdapter({ rpc, artifactTracker: tracker, cwd: "D:\\repo" });
  const pending = adapter.sendPrompt({ text: "early file change" });
  await waitFor(() => rpc.calls.some(([method]) => method === "turn/start"));
  const matching = {
    type: "fileChange", status: "completed", changes: [{ path: "early.txt" }],
  };
  await adapter.handleNotification("item/completed", {
    threadId: "early-file-thread", turnId: "turn-real", item: matching,
  });
  await adapter.handleNotification("item/completed", {
    threadId: "wrong-thread", turnId: "turn-real", item: matching,
  });
  await adapter.handleNotification("item/completed", {
    threadId: "early-file-thread", turnId: "other-turn", item: matching,
  });
  await adapter.handleNotification("item/completed", {
    threadId: "early-file-thread", turnId: "turn-real",
    item: { ...matching, status: "pending" },
  });
  assert.equal(tracker.calls.some(([method]) => method === "noteFileChange"), false);

  responseGate.resolve({ turn: { id: "turn-real" } });
  await waitFor(() => tracker.calls.some(([method]) => method === "bindTurnId"));
  assert.equal(tracker.calls.some(([method]) => method === "noteFileChange"), false);
  bindGate.resolve();
  await waitFor(() => tracker.calls.some(([method]) => method === "noteFileChange"));
  const notes = tracker.calls.filter(([method]) => method === "noteFileChange");
  assert.equal(notes.length, 1);
  assert.strictEqual(notes[0][2], matching);
  const methods = tracker.calls.map(([method]) => method);
  assert.ok(methods.indexOf("bindComplete") < methods.indexOf("noteFileChange"));
  await adapter.handleNotification("turn/completed", {
    threadId: "early-file-thread", turn: { id: "turn-real", status: "completed" },
  });
  await pending;
});

test("reports an asynchronous noteFileChange rejection once without delaying the turn", async () => {
  const errors = [];
  const tracker = makeArtifactTracker({
    noteFileChange() { return Promise.reject(new Error("async note failed")); },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "async-note-thread" } };
    if (method === "turn/start") return { turn: { id: "async-note-turn" } };
    return {};
  });
  const adapter = new CodexAdapter({
    rpc, artifactTracker: tracker, cwd: "D:\\repo",
    onError: (error) => errors.push(error.message),
  });
  const pending = adapter.sendPrompt({ text: "async note" });
  await waitFor(() => tracker.calls.some(([method]) => method === "bindTurnId"));
  await adapter.handleNotification("item/completed", {
    threadId: "async-note-thread", turnId: "async-note-turn",
    item: { type: "fileChange", status: "completed", changes: [{ path: "async.txt" }] },
  });
  await waitFor(() => errors.length === 1, "async note rejection report");
  assert.deepEqual(errors, ["async note failed"]);
  await adapter.handleNotification("turn/completed", {
    threadId: "async-note-thread", turn: { id: "async-note-turn", status: "completed" },
  });
  assert.deepEqual(await pending, { id: "async-note-turn", status: "completed" });
});

test("runs one active turn and advances a bounded FIFO only on matching completion", async () => {
  let nextTurn = 0;
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thr" } };
    if (method === "turn/start") return { turn: { id: `turn-${++nextTurn}` } };
    return {};
  });
  const adapter = new CodexAdapter({ rpc, cwd: "D:\\repo", maxQueue: 1 });
  const first = adapter.sendPrompt({ text: "one" });
  await waitFor(() => nextTurn === 1);
  const second = adapter.sendPrompt({ text: "two" });
  assert.equal(adapter.queueLength, 1);
  await assert.rejects(adapter.sendPrompt({ text: "three" }), /queue/i);
  await adapter.handleNotification("turn/completed", {
    threadId: "other", turn: { id: "stale", status: "completed" },
  });
  assert.equal(nextTurn, 1);
  await adapter.handleNotification("turn/completed", {
    threadId: "thr", turn: { id: "turn-1", status: "completed" },
  });
  await first;
  await waitFor(() => nextTurn === 2);
  await adapter.handleNotification("turn/completed", {
    threadId: "thr", turn: { id: "turn-2", status: "completed" },
  });
  await second;
  assert.equal(adapter.queueLength, 0);
});

test("does not accept a same-thread stale completion before turn/start is confirmed", async () => {
  const gate = deferred();
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thr" } };
    if (method === "turn/start") return gate.promise;
    return {};
  });
  const events = [];
  const adapter = new CodexAdapter({ rpc, cwd: "D:\\repo", emit: (event) => events.push(event) });
  const pending = adapter.sendPrompt({ text: "current" });
  await waitFor(() => rpc.calls.some(([method]) => method === "turn/start"));
  let settled = false;
  pending.finally(() => { settled = true; });
  await adapter.handleNotification("turn/completed", {
    threadId: "thr", turn: { id: "old-turn", status: "completed" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  assert.equal(events.some((event) => event.type === "result"), false);
  gate.resolve({ turn: { id: "real-turn" } });
  await waitFor(() => adapter.active?.confirmed === true);
  await adapter.handleNotification("turn/completed", {
    threadId: "thr", turn: { id: "real-turn", status: "completed" },
  });
  assert.deepEqual(await pending, { id: "real-turn", status: "completed" });
  assert.equal(events.filter((event) => event.type === "result").length, 1);
});

test("buffers a matching terminal notification until the turn/start response confirms it", async () => {
  const gate = deferred();
  const events = [];
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thr" } };
    if (method === "turn/start") return gate.promise;
    return {};
  });
  const adapter = new CodexAdapter({ rpc, cwd: "D:\\repo", emit: (event) => events.push(event) });
  const pending = adapter.sendPrompt({ text: "current" });
  await waitFor(() => rpc.calls.some(([method]) => method === "turn/start"));
  await adapter.handleNotification("turn/started", {
    threadId: "thr", turn: { id: "real-turn", status: "inProgress" },
  });
  await adapter.handleNotification("turn/completed", {
    threadId: "thr", turn: { id: "real-turn", status: "completed" },
  });
  assert.equal(events.some((event) => event.type === "result"), false);
  gate.resolve({ turn: { id: "real-turn" } });
  assert.deepEqual(await pending, { id: "real-turn", status: "completed" });
  assert.equal(events.filter((event) => event.type === "result").length, 1);
});

test("recovers the queue and cleans images when turn/start fails", async () => {
  let attempts = 0;
  let cleaned = 0;
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thr" } };
    if (method === "turn/start") {
      attempts += 1;
      if (attempts === 1) throw new Error("start failed");
      return { turn: { id: "turn-2" } };
    }
    return {};
  });
  const adapter = new CodexAdapter({
    rpc, cwd: "D:\\repo",
    materializeImages: async () => ({ inputs: [], paths: [], cleanup: async () => { cleaned += 1; } }),
  });
  const first = adapter.sendPrompt({ text: "one", images: ["x"] });
  const second = adapter.sendPrompt({ text: "two" });
  await assert.rejects(first, /start failed/);
  await waitFor(() => attempts === 2);
  assert.equal(cleaned, 1);
  await adapter.handleNotification("turn/completed", {
    threadId: "thr", turn: { id: "turn-2", status: "completed" },
  });
  await second;
});

test("translates notifications and routes server requests through the broker", async () => {
  const rpc = makeRpc();
  const broker = makeBroker();
  const events = [];
  const adapter = new CodexAdapter({ rpc, approvalBroker: broker, cwd: "D:\\repo", emit: (event) => events.push(event) });
  await adapter.handleNotification("item/agentMessage/delta", { delta: "hello" });
  assert.deepEqual(events, [{ type: "assistant_delta", text: "hello" }]);
  const id = adapter.handleServerRequest({
    id: 7, method: "item/commandExecution/requestApproval", params: { command: "npm test" },
  });
  assert.equal(id, "approval-1");
  await broker.registered[0].respond({ decision: "accept" });
  assert.deepEqual(rpc.responses, [[7, { decision: "accept" }]]);
  assert.equal(adapter.handleServerRequest({ id: 8, method: "unknown/request", params: {} }), null);
  assert.deepEqual(rpc.errors, [[8, -32601, "Unsupported App Server request: unknown/request"]]);
});

test("publishes phone events to subscribers and delegates approval decisions", async () => {
  const broker = makeBroker();
  const primary = [];
  const subscribed = [];
  const adapter = new CodexAdapter({
    rpc: makeRpc(), approvalBroker: broker, cwd: "D:\\repo",
    emit: (event) => primary.push(event),
  });
  const unsubscribe = adapter.subscribePhoneEvents((event) => subscribed.push(event));
  await adapter.handleNotification("warning", { message: "first" });
  assert.deepEqual(primary, [{ type: "notice", message: "first" }]);
  assert.deepEqual(subscribed, primary);
  assert.equal(await adapter.decideApproval("approval-1", "allow", { once: true }), true);
  assert.deepEqual(broker.decisions, [["approval-1", "allow", { once: true }]]);
  unsubscribe();
  await adapter.handleNotification("warning", { message: "second" });
  assert.equal(subscribed.length, 1);
});

test("interrupt cleans the active lease, closes turn approvals, and starts the next prompt", async () => {
  let nextTurn = 0;
  let cleaned = 0;
  const broker = makeBroker();
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thr" } };
    if (method === "turn/start") return { turn: { id: `turn-${++nextTurn}` } };
    if (method === "turn/interrupt") return {};
    return {};
  });
  const adapter = new CodexAdapter({
    rpc, approvalBroker: broker, cwd: "D:\\repo",
    materializeImages: async () => ({ inputs: [], paths: [], cleanup: async () => { cleaned += 1; } }),
  });
  const first = adapter.sendPrompt({ text: "one", images: ["x"] });
  await waitFor(() => nextTurn === 1);
  const second = adapter.sendPrompt({ text: "two" });
  assert.equal(await adapter.interrupt(), true);
  assert.equal(await adapter.interrupt(), false);
  assert.deepEqual(rpc.calls.find(([method]) => method === "turn/interrupt"), [
    "turn/interrupt", { threadId: "thr", turnId: "turn-1" },
  ]);
  assert.equal(cleaned, 0);
  assert.equal(nextTurn, 1);
  await adapter.handleNotification("turn/completed", {
    threadId: "thr", turn: { id: "turn-1", status: "interrupted" },
  });
  assert.deepEqual(await first, { id: "turn-1", status: "interrupted" });
  assert.equal(cleaned, 1);
  assert.deepEqual(broker.cleared[0], { turnId: "turn-1", reason: "interrupted" });
  await waitFor(() => nextTurn === 2);
  await adapter.handleNotification("turn/completed", {
    threadId: "thr", turn: { id: "turn-2", status: "completed" },
  });
  await second;
});

test("process exit rejects active and queued prompts and cleans every owned resource", async () => {
  const gate = deferred();
  let cleaned = 0;
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thr" } };
    if (method === "turn/start") return gate.promise;
    return {};
  });
  const process = new FakeProcess(rpc);
  const broker = makeBroker();
  const adapter = new CodexAdapter({
    process, approvalBroker: broker, cwd: "D:\\repo",
    materializeImages: async () => ({ inputs: [], paths: [], cleanup: async () => { cleaned += 1; } }),
  });
  await adapter.start();
  const active = adapter.sendPrompt({ text: "one", images: ["x"] });
  await waitFor(() => rpc.calls.some(([method]) => method === "turn/start"));
  const queued = adapter.sendPrompt({ text: "two" });
  broker.setSessionAuto(true);
  process.emit("exit", 1, null);
  await assert.rejects(active, /exited/i);
  await assert.rejects(queued, /exited/i);
  assert.equal(cleaned, 1);
  assert.deepEqual(broker.closed, ["app_server_exit"]);
  assert.equal(broker.sessionAuto, false);
  gate.resolve({ turn: { id: "late" } });
});

test("process exit finishes a confirmed artifact turn before cleanup and rejection", async () => {
  const finishGate = deferred();
  let cleaned = 0;
  let rejected = false;
  const tracker = makeArtifactTracker({
    async finishTurn(handle, options) {
      this.calls.push(["finishTurn", handle, options]);
      await finishGate.promise;
    },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "exit-confirmed-thread" } };
    if (method === "turn/start") return { turn: { id: "exit-confirmed-turn" } };
    return {};
  });
  const process = new FakeProcess(rpc);
  const broker = makeBroker();
  const adapter = new CodexAdapter({
    process, approvalBroker: broker, artifactTracker: tracker, cwd: "D:\\repo",
    materializeImages: async () => ({ inputs: [], cleanup: async () => { cleaned += 1; } }),
  });
  await adapter.start();
  const pending = adapter.sendPrompt({ text: "confirmed", images: ["x"] });
  pending.catch(() => { rejected = true; });
  await waitFor(() => tracker.calls.some(([method]) => method === "bindTurnId"));
  process.emit("exit", 1, null);
  await waitFor(() => tracker.calls.some(([method]) => method === "finishTurn"));
  assert.equal(rejected, false);
  assert.equal(cleaned, 0);
  assert.deepEqual(broker.closed, []);
  finishGate.resolve();
  await assert.rejects(pending, /exited/i);
  assert.equal(cleaned, 1);
  assert.deepEqual(broker.closed, ["app_server_exit"]);
  const finishes = tracker.calls.filter(([method]) => method === "finishTurn");
  assert.equal(finishes.length, 1);
  assert.deepEqual(finishes[0].slice(2), [{ reason: "app_server_exit" }]);
  await adapter.stop();
  assert.equal(tracker.calls.filter(([method]) => method === "finishTurn").length, 1);
});

test("process exit aborts an unconfirmed artifact turn exactly once before cleanup", async () => {
  const startGate = deferred();
  const abortGate = deferred();
  let cleaned = 0;
  const tracker = makeArtifactTracker({
    async abortTurn(handle, options) {
      this.calls.push(["abortTurn", handle, options]);
      await abortGate.promise;
    },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "exit-unconfirmed-thread" } };
    if (method === "turn/start") return startGate.promise;
    return {};
  });
  const process = new FakeProcess(rpc);
  const adapter = new CodexAdapter({
    process, artifactTracker: tracker, cwd: "D:\\repo",
    materializeImages: async () => ({ inputs: [], cleanup: async () => { cleaned += 1; } }),
  });
  await adapter.start();
  const pending = adapter.sendPrompt({ text: "unconfirmed", images: ["x"] });
  pending.catch(() => {});
  await waitFor(() => rpc.calls.some(([method]) => method === "turn/start"));
  process.emit("exit", 1, null);
  await waitFor(() => tracker.calls.some(([method]) => method === "abortTurn"));
  assert.equal(cleaned, 0);
  abortGate.resolve();
  await assert.rejects(pending, /exited/i);
  assert.equal(cleaned, 1);
  const aborts = tracker.calls.filter(([method]) => method === "abortTurn");
  assert.equal(aborts.length, 1);
  assert.deepEqual(aborts[0].slice(2), [{ reason: "app_server_exit" }]);
  assert.equal(tracker.calls.some(([method]) => method === "finishTurn"), false);
  startGate.resolve({ turn: { id: "too-late" } });
  await adapter.stop();
  assert.equal(tracker.calls.filter(([method]) => method === "abortTurn").length, 1);
});

test("adapter stop waits for confirmed artifact settlement and does not settle twice", async () => {
  const finishGate = deferred();
  const tracker = makeArtifactTracker({
    async finishTurn(handle, options) {
      this.calls.push(["finishTurn", handle, options]);
      await finishGate.promise;
    },
  });
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "stop-thread" } };
    if (method === "turn/start") return { turn: { id: "stop-turn" } };
    return {};
  });
  const process = new FakeProcess(rpc);
  const adapter = new CodexAdapter({ process, artifactTracker: tracker, cwd: "D:\\repo" });
  await adapter.start();
  const pending = adapter.sendPrompt({ text: "stop" });
  pending.catch(() => {});
  await waitFor(() => tracker.calls.some(([method]) => method === "bindTurnId"));
  let stopped = false;
  const stopping = adapter.stop().then(() => { stopped = true; });
  await waitFor(() => tracker.calls.some(([method]) => method === "finishTurn"));
  assert.equal(stopped, false);
  finishGate.resolve();
  await stopping;
  await assert.rejects(pending, /stopped/i);
  const finishes = tracker.calls.filter(([method]) => method === "finishTurn");
  assert.equal(finishes.length, 1);
  assert.deepEqual(finishes[0].slice(2), [{ reason: "adapter_stop" }]);
  await adapter.stop();
  assert.equal(tracker.calls.filter(([method]) => method === "finishTurn").length, 1);
});

test("restart waits for old exit cleanup before accepting new work", async () => {
  const cleanupGate = deferred();
  let nextTurn = 0;
  let cleanupCalls = 0;
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thr" } };
    if (method === "turn/start") return { turn: { id: `turn-${++nextTurn}` } };
    return {};
  });
  const process = new FakeProcess(rpc);
  const broker = makeBroker();
  const adapter = new CodexAdapter({
    process, approvalBroker: broker, cwd: "D:\\repo",
    materializeImages: async () => ({
      inputs: [], paths: [],
      cleanup: async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) await cleanupGate.promise;
      },
    }),
  });
  await adapter.start();
  const oldPrompt = adapter.sendPrompt({ text: "old", images: ["x"] });
  await waitFor(() => nextTurn === 1);
  process.emit("exit", 1, null);
  const restart = adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(process.starts, 1);
  await assert.rejects(adapter.sendPrompt({ text: "too early" }), /restarting/i);
  cleanupGate.resolve();
  await assert.rejects(oldPrompt, /exited/i);
  await restart;
  assert.equal(process.starts, 2);

  const fresh = adapter.sendPrompt({ text: "fresh" });
  await waitFor(() => nextTurn === 2);
  await adapter.handleNotification("turn/completed", {
    threadId: "thr", turn: { id: "turn-2", status: "completed" },
  });
  await fresh;
});

test("unexpected exits retry with bounded backoff, resume the thread, and accept fresh work", async () => {
  let turnNumber = 0;
  const initialRpc = makeRpc(async (method, params) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    return {};
  });
  const recoveredRpc = makeRpc(async (method, params) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: `recovered-${++turnNumber}` } };
    return {};
  });
  const process = new SequencedProcess([initialRpc, new Error("restart boot failed"), recoveredRpc]);
  const broker = makeBroker();
  const clock = fakeTimers();
  const events = [];
  const adapter = new CodexAdapter({
    process,
    approvalBroker: broker,
    cwd: "D:\\repo",
    emit: (event) => events.push(event),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    restartBaseMs: 10,
    maxRestartDelayMs: 20,
  });

  await adapter.start();
  await adapter.resumeThread("thread-survives");
  broker.setSessionAuto(true);
  process.emit("exit", 1, null);
  await waitFor(() => clock.timers.length === 1, "first restart timer");
  assert.equal(clock.timers[0].delay, 10);
  assert.equal(broker.sessionAuto, false);

  clock.timers[0].fn();
  await waitFor(() => clock.timers.length === 2, "second restart timer");
  assert.equal(clock.timers[1].delay, 20);

  clock.timers[1].fn();
  await waitFor(() => adapter.started === true, "adapter recovery");
  assert.equal(process.starts, 3);
  assert.equal(adapter.closed, false);
  assert.equal(adapter.threadId, "thread-survives");
  assert.ok(recoveredRpc.calls.some(([method]) => method === "thread/resume"));
  assert.ok(events.some((event) => event.type === "system_init" && event.threadId === "thread-survives"));

  const fresh = adapter.sendPrompt({ text: "after recovery" });
  await waitFor(() => turnNumber === 1, "fresh recovered turn");
  await adapter.handleNotification("turn/completed", {
    threadId: "thread-survives",
    turn: { id: "recovered-1", status: "completed" },
  });
  await fresh;
  await adapter.stop();
});

test("restart backoff remains capped across consecutive startup failures", async () => {
  const rpc = makeRpc();
  const process = new SequencedProcess([
    rpc,
    new Error("boot-1"),
    new Error("boot-2"),
    new Error("boot-3"),
  ]);
  const clock = fakeTimers();
  const adapter = new CodexAdapter({
    process,
    cwd: "D:\\repo",
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    restartBaseMs: 10,
    maxRestartDelayMs: 20,
  });

  await adapter.start();
  process.emit("exit", 1, null);
  for (let expectedCount = 1; expectedCount <= 3; expectedCount += 1) {
    await waitFor(() => clock.timers.length === expectedCount, `restart timer ${expectedCount}`);
    clock.timers[expectedCount - 1].fn();
  }
  await waitFor(() => clock.timers.length === 4, "capped restart timer");
  assert.deepEqual(clock.timers.map((timer) => timer.delay), [10, 20, 20, 20]);
  await adapter.stop();
});

test("restart creates a safe replacement thread when resume fails", async () => {
  const initialRpc = makeRpc(async (method, params) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    return {};
  });
  const replacementRpc = makeRpc(async (method) => {
    if (method === "thread/resume") {
      throw new RpcRemoteError({ code: -32000, message: "thread is gone" });
    }
    if (method === "thread/start") return { thread: { id: "replacement-thread" } };
    return {};
  });
  const process = new SequencedProcess([initialRpc, replacementRpc]);
  const clock = fakeTimers();
  const errors = [];
  const events = [];
  const adapter = new CodexAdapter({
    process,
    cwd: "D:\\repo",
    emit: (event) => events.push(event),
    onError: (error) => errors.push(error.message),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    restartBaseMs: 10,
    maxRestartDelayMs: 20,
  });

  await adapter.start();
  await adapter.resumeThread("missing-thread");
  process.emit("exit", 1, null);
  await waitFor(() => clock.timers.length === 1, "replacement restart timer");
  clock.timers[0].fn();
  await waitFor(() => adapter.started === true, "replacement thread recovery");

  assert.deepEqual(replacementRpc.calls.map(([method]) => method), ["thread/resume", "thread/start"]);
  assert.equal(adapter.threadId, "replacement-thread");
  assert.deepEqual(errors, ["thread is gone"]);
  assert.ok(events.some((event) => event.type === "notice" && /new thread/i.test(event.message)));
  assert.ok(events.some((event) => event.type === "system_init" && event.threadId === "replacement-thread"));
  await adapter.stop();
});

test("a transport failure during resume retries instead of creating a duplicate thread", async () => {
  const initialRpc = makeRpc(async (method, params) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    return {};
  });
  const brokenRpc = makeRpc(async (method) => {
    if (method === "thread/resume") throw new Error("transport closed");
    return {};
  });
  const recoveredRpc = makeRpc(async (method, params) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    return {};
  });
  const process = new SequencedProcess([initialRpc, brokenRpc, recoveredRpc]);
  const clock = fakeTimers();
  const adapter = new CodexAdapter({
    process,
    cwd: "D:\\repo",
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    restartBaseMs: 10,
    maxRestartDelayMs: 20,
  });

  await adapter.start();
  await adapter.resumeThread("thread-survives");
  process.emit("exit", 1, null);
  await waitFor(() => clock.timers.length === 1, "transport restart timer");
  clock.timers[0].fn();
  await waitFor(() => clock.timers.length === 2, "transport retry timer");
  assert.deepEqual(brokenRpc.calls.map(([method]) => method), ["thread/resume"]);
  assert.equal(adapter.threadId, "thread-survives");

  clock.timers[1].fn();
  await waitFor(() => adapter.started === true, "transport recovery");
  assert.ok(recoveredRpc.calls.some(([method]) => method === "thread/resume"));
  await adapter.stop();
});

test("stop supersedes a restart that is still waiting for exit cleanup", async () => {
  const cleanupGate = deferred();
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thread-cleanup" } };
    if (method === "turn/start") return { turn: { id: "turn-cleanup" } };
    return {};
  });
  const process = new FakeProcess(rpc);
  const adapter = new CodexAdapter({
    process,
    cwd: "D:\\repo",
    materializeImages: async () => ({
      inputs: [],
      cleanup: async () => cleanupGate.promise,
    }),
  });

  await adapter.start();
  const oldPrompt = adapter.sendPrompt({ text: "old", images: ["x"] });
  await waitFor(() => rpc.calls.some(([method]) => method === "turn/start"));
  process.emit("exit", 1, null);
  const restart = adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await adapter.stop();
  cleanupGate.resolve();

  await assert.rejects(oldPrompt, /exited/i);
  await assert.rejects(restart, /stopped|superseded/i);
  assert.equal(process.starts, 1);
});

test("start after stop waits out a stale recovery generation", async () => {
  const cleanupGate = deferred();
  const rpc = makeRpc(async (method) => {
    if (method === "thread/start") return { thread: { id: "thread-restart" } };
    if (method === "turn/start") return { turn: { id: "turn-restart" } };
    return {};
  });
  const process = new FakeProcess(rpc);
  const adapter = new CodexAdapter({
    process,
    cwd: "D:\\repo",
    materializeImages: async () => ({
      inputs: [],
      cleanup: async () => cleanupGate.promise,
    }),
  });

  await adapter.start();
  const oldPrompt = adapter.sendPrompt({ text: "old", images: ["x"] });
  await waitFor(() => rpc.calls.some(([method]) => method === "turn/start"));
  process.emit("exit", 1, null);
  const staleRestart = adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await adapter.stop();
  const freshStart = adapter.start();
  cleanupGate.resolve();

  await assert.rejects(oldPrompt, /exited/i);
  await assert.rejects(staleRestart, /stopped|superseded/i);
  await freshStart;
  assert.equal(process.starts, 2);
  assert.equal(adapter.appServerStatus, "online");
  await adapter.stop();
});

test("a late resume response cannot mutate state after stop", async () => {
  const resumeGate = deferred();
  const initialRpc = makeRpc(async (method, params) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    return {};
  });
  const recoveringRpc = makeRpc(async (method) => {
    if (method === "thread/resume") return resumeGate.promise;
    return {};
  });
  const process = new SequencedProcess([initialRpc, recoveringRpc]);
  const clock = fakeTimers();
  const events = [];
  const adapter = new CodexAdapter({
    process,
    cwd: "D:\\repo",
    emit: (event) => events.push(event),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    restartBaseMs: 10,
    maxRestartDelayMs: 20,
  });

  await adapter.start();
  await adapter.resumeThread("original-thread");
  process.emit("exit", 1, null);
  await waitFor(() => clock.timers.length === 1, "late-response restart timer");
  clock.timers[0].fn();
  await waitFor(
    () => recoveringRpc.calls.some(([method]) => method === "thread/resume"),
    "pending recovery resume",
  );
  const stopping = adapter.stop();
  resumeGate.resolve({ thread: { id: "late-thread" } });
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(adapter.threadId, "original-thread");
  assert.equal(adapter.started, false);
  assert.equal(adapter.appServerStatus, "offline");
  assert.equal(events.some((event) => event.code === "app_server_recovered"), false);
});

test("stop cancels a pending App Server restart", async () => {
  const rpc = makeRpc();
  const process = new SequencedProcess([rpc, makeRpc()]);
  const clock = fakeTimers();
  const adapter = new CodexAdapter({
    process,
    cwd: "D:\\repo",
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    restartBaseMs: 10,
    maxRestartDelayMs: 20,
  });

  await adapter.start();
  process.emit("exit", 1, null);
  await waitFor(() => clock.timers.length === 1, "pending restart timer");
  await adapter.stop();
  assert.equal(clock.timers[0].cleared, true);
  clock.timers[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(process.starts, 1);
});

test("emit failures are isolated and reported", async () => {
  const errors = [];
  const adapter = new CodexAdapter({
    rpc: makeRpc(), cwd: "D:\\repo",
    emit: () => { throw new Error("render failed"); },
    onError: (error) => errors.push(error.message),
  });
  await assert.doesNotReject(adapter.handleNotification("warning", { message: "notice" }));
  assert.deepEqual(errors, ["render failed"]);
});
