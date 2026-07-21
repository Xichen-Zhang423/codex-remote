import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ArtifactTracker } from "../src/artifact-tracker.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settleAsync() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message = "condition") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await settleAsync();
  }
  throw new Error(`timed out waiting for ${message}`);
}

function fakeClock(start = 0) {
  let value = start;
  let sequence = 0;
  const timers = [];
  function setTimer(fn, delay) {
    const timer = {
      at: value + delay,
      sequence: sequence += 1,
      fn,
      cleared: false,
      unref() {},
    };
    timers.push(timer);
    return timer;
  }
  function clearTimer(timer) {
    if (timer) timer.cleared = true;
  }
  async function tick(milliseconds) {
    const target = value + milliseconds;
    while (true) {
      const due = timers
        .filter((timer) => !timer.cleared && timer.at <= target)
        .sort((left, right) => left.at - right.at || left.sequence - right.sequence)[0];
      if (!due) break;
      due.cleared = true;
      value = due.at;
      due.fn();
      await flush();
    }
    value = target;
    await flush();
  }
  return { now: () => value, setTimer, clearTimer, tick, timers };
}

class FakeWatcher extends EventEmitter {
  constructor(onChange, calls, label = "main") {
    super();
    this.onChange = onChange;
    this.calls = calls;
    this.label = label;
    this.closed = 0;
  }
  change(filename, eventType = "change") { this.onChange(eventType, filename); }
  close() { this.closed += 1; this.calls?.push(`watch:close:${this.label}`); }
}

function makeWatch(calls = []) {
  const watchers = [];
  const watch = (_root, options, listener) => {
    assert.equal(options.recursive, true);
    calls.push("watch:start");
    const watcher = new FakeWatcher(listener, calls, watchers.length === 0 ? "main" : "tail");
    watchers.push(watcher);
    return watcher;
  };
  return { watch, watchers };
}

function signature(seed = 1) {
  return { dev: "1", ino: String(seed), size: String(seed), mtimeNs: String(seed), ctimeNs: String(seed) };
}

function snapshot(entries = [], { partial = false, reasons = [], covered = ["."] } = {}) {
  return {
    entries: new Map(entries),
    coveredDirectories: new Set(covered),
    partial,
    reasons: [...reasons],
    counters: { files: entries.length, directories: 1, entries: entries.length },
  };
}

function makeStore(calls = []) {
  let revision = 0;
  const pending = new Map();
  return {
    pending,
    saved: [],
    hintUpdates: [],
    ingested: [],
    finalized: [],
    async savePendingTurn(input) {
      calls.push("pending:save");
      this.saved.push(input);
      pending.set(input.handle.localTaskId, structuredClone(input));
    },
    async updatePendingHints(localTaskId, hints) {
      calls.push("pending:hints");
      const copy = new Map([...hints].map(([name, sources]) => [name, new Set(sources)]));
      this.hintUpdates.push({ localTaskId, hints: copy });
    },
    async bindPendingTurn(localTaskId, turnId) {
      calls.push("pending:bind");
      const item = pending.get(localTaskId);
      if (item) item.handle.turnId = typeof turnId === "object" ? turnId.turnId : turnId;
    },
    async ingest(input) {
      calls.push(`store:ingest:${input.relativePath}`);
      this.ingested.push(input);
      revision += 1;
      return {
        id: `artifact-${revision}`,
        revision,
        threadId: input.threadId,
        turnId: input.turnId,
        relativePath: input.relativePath,
        state: "ready",
      };
    },
    async finalizeTurn(input) {
      calls.push("store:commit");
      revision += 1;
      this.finalized.push(structuredClone(input));
      return { revision, records: [...this.ingested], complete: input.complete, diagnostics: input.diagnostics };
    },
    async completePendingTurn(localTaskId) {
      calls.push("pending:complete");
      pending.delete(localTaskId);
    },
    async abortPendingTurn(localTaskId) {
      calls.push("pending:abort");
      pending.delete(localTaskId);
    },
    pendingTurns() { return [...pending.values()]; },
  };
}

function createHarness({ snapshots, policy = {}, store, watch, now, setTimer, clearTimer, onError } = {}) {
  const calls = [];
  const clock = now ? null : fakeClock();
  const watching = watch ? null : makeWatch(calls);
  const fakeStore = store ?? makeStore(calls);
  const suppliedSnapshots = [...(snapshots ?? [snapshot(), snapshot()])];
  const snapshotCalls = [];
  const tracker = new ArtifactTracker({
    store: fakeStore,
    watch: watch ?? watching.watch,
    snapshot: async (root, options) => {
      snapshotCalls.push({ root, options });
      calls.push(snapshotCalls.length === 1 ? "snapshot:baseline" : "snapshot:terminal");
      const next = suppliedSnapshots.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(root, options);
      return next;
    },
    now: now ?? clock.now,
    setTimer: setTimer ?? clock.setTimer,
    clearTimer: clearTimer ?? clock.clearTimer,
    policy: { tailMs: 0, ...policy },
    onError,
  });
  return { tracker, calls, clock, watching, store: fakeStore, snapshotCalls };
}

async function beginAndBind(harness, suffix = "1") {
  const handle = await harness.tracker.beginTurn({
    localTaskId: `local-${suffix}`,
    threadId: `thread-${suffix}`,
    cwd: process.cwd(),
    cwdGeneration: 7,
  });
  harness.calls.push("turn:bind");
  await harness.tracker.bindTurnId(handle, `turn-${suffix}`);
  return handle;
}

async function finishAfterQuiet(harness, handle, reason = "completed") {
  const finishing = harness.tracker.finishTurn(handle, { reason });
  await flush();
  await harness.clock.tick(harness.tracker.policy.quietMs);
  return finishing;
}

test("A: starts recursive watch before baseline and commits a full-snapshot artifact in lifecycle order", async () => {
  const h = createHarness({ snapshots: [snapshot(), snapshot([["created.txt", signature(2)]])] });
  const handle = await beginAndBind(h);
  const result = await finishAfterQuiet(h, handle);

  const ordered = h.calls.filter((call) => [
    "watch:start", "snapshot:baseline", "turn:bind", "pending:bind",
    "snapshot:terminal", "store:commit", "pending:complete",
  ].includes(call));
  assert.deepEqual(ordered, [
    "watch:start", "snapshot:baseline", "turn:bind", "pending:bind",
    "snapshot:terminal", "store:commit", "pending:complete",
  ]);
  assert.deepEqual(result.records.map((record) => record.relativePath), ["created.txt"]);
  assert.deepEqual(h.snapshotCalls[1].options.candidates, []);
  assert.notEqual(h.snapshotCalls[1].options.candidateOnly, true);
  assert.equal(result.complete, true);
  await h.tracker.close();
});

test("A: pre-baseline and pending-save watch events persist only after pending creation", async () => {
  const baselineGate = deferred();
  const saveGate = deferred();
  const calls = [];
  const store = makeStore(calls);
  const originalSave = store.savePendingTurn.bind(store);
  store.savePendingTurn = async (input) => {
    calls.push("pending:save:entered");
    await saveGate.promise;
    return originalSave(input);
  };
  const h = createHarness({
    store,
    snapshots: [async () => { await baselineGate.promise; return snapshot(); }, snapshot()],
  });
  const beginning = h.tracker.beginTurn({
    localTaskId: "pre-baseline",
    threadId: "thread-pre-baseline",
    cwd: process.cwd(),
    cwdGeneration: 1,
  });
  await waitFor(() => h.watching.watchers.length === 1, "pre-baseline watcher");
  assert.equal(h.watching.watchers.length, 1);
  h.watching.watchers[0].change("before-baseline.txt");
  await flush();
  assert.equal(store.hintUpdates.length, 0);
  baselineGate.resolve();
  await flush();
  h.watching.watchers[0].change("during-save.txt");
  await flush();
  assert.equal(store.hintUpdates.length, 0);
  saveGate.resolve();
  const handle = await beginning;

  assert.equal(store.hintUpdates.length, 1);
  assert.deepEqual([...store.hintUpdates[0].hints.keys()], ["before-baseline.txt", "during-save.txt"]);
  assert.ok(calls.indexOf("pending:save") < calls.indexOf("pending:hints"));
  await h.tracker.abortTurn(handle, { reason: "test" });
  await h.tracker.close();
});

test("A: failed pending creation closes the watcher without writing orphan hints", async () => {
  const store = makeStore();
  let watcher;
  store.savePendingTurn = async () => {
    watcher.change("during-failed-save.txt");
    throw new Error("pending save failed");
  };
  const watching = makeWatch();
  watcher = null;
  const watch = (...args) => {
    watcher = watching.watch(...args);
    return watcher;
  };
  const h = createHarness({ store, watch, snapshots: [snapshot()] });
  await assert.rejects(h.tracker.beginTurn({
    localTaskId: "save-failure",
    threadId: "thread-save-failure",
    cwd: process.cwd(),
    cwdGeneration: 1,
  }), /pending save failed/);
  await flush();

  assert.equal(store.hintUpdates.length, 0);
  assert.equal(watcher.closed, 1);
  await h.tracker.close();
});

test("B: deduplicates watcher and completed App Server hints into provenance", async () => {
  const h = createHarness({ snapshots: [snapshot(), snapshot([["same.txt", signature(2)]])] });
  const handle = await beginAndBind(h);
  h.watching.watchers[0].change("same.txt");
  h.tracker.noteFileChange(handle, {
    status: "completed",
    changes: [{ path: "same.txt" }, { path: "same.txt" }],
  });
  const result = await finishAfterQuiet(h, handle);

  assert.deepEqual(result.records[0].provenance, undefined);
  assert.deepEqual(h.store.ingested[0].provenance, ["snapshot", "watch", "appServer"]);
  assert.equal(h.store.ingested.length, 1);
  await h.tracker.close();
});

test("B: non-completed App Server changes are diagnostic only and not artifact evidence", async () => {
  const h = createHarness({ snapshots: [
    snapshot([], { covered: [] }),
    snapshot([["maybe.txt", signature(2)]], { covered: [] }),
  ] });
  const handle = await beginAndBind(h);
  h.tracker.noteFileChange(handle, { status: "in_progress", changes: [{ path: "maybe.txt" }] });
  const result = await finishAfterQuiet(h, handle);

  assert.equal(result.records.length, 0);
  assert.ok(result.diagnostics.some(({ code }) => code === "file_change_not_completed"));
  assert.deepEqual(h.snapshotCalls[1].options.candidates, []);
  await h.tracker.close();
});

test("C: carries safe accumulated candidates to volume terminal and candidate-only tail scans", async () => {
  const h = createHarness({
    policy: { tailMs: 10_000 },
    snapshots: [
      snapshot([], { partial: true, reasons: ["volume_root"], covered: [] }),
      snapshot([
        ["app-server.txt", signature(2)],
        ["watcher.txt", signature(3)],
      ], { partial: true, reasons: ["volume_root"], covered: [] }),
      snapshot([["late.txt", signature(4)]], { covered: [] }),
    ],
  });
  const handle = await beginAndBind(h);
  h.watching.watchers[0].change("watcher.txt");
  h.tracker.noteFileChange(handle, { status: "completed", path: "app-server.txt" });
  await finishAfterQuiet(h, handle);
  h.watching.watchers[1].change("late.txt");
  await h.clock.tick(100);

  assert.deepEqual(h.snapshotCalls.map(({ options }) => options?.candidates ?? null), [
    null,
    ["app-server.txt", "watcher.txt"],
    ["late.txt"],
  ]);
  assert.equal(h.snapshotCalls[2].options.candidateOnly, true);
  await h.tracker.close();
});

test("D: accepts exactly 10000 dirty paths then diagnoses overflow once", async () => {
  const h = createHarness({ snapshots: [snapshot(), snapshot()] });
  const handle = await beginAndBind(h);
  for (let index = 0; index < 10_002; index += 1) {
    h.tracker.noteFileChange(handle, { status: "completed", path: `generated/${index}.txt` });
  }
  const result = await finishAfterQuiet(h, handle);

  assert.equal(h.snapshotCalls[1].options.candidates.length, 10_000);
  assert.equal(result.diagnostics.filter(({ code }) => code === "dirty_overflow").length, 1);
  assert.equal(result.complete, false);
  await h.tracker.close();
});

test("D: missing watcher filename and asynchronous watch errors make the turn partial without throwing", async () => {
  const onErrors = [];
  const h = createHarness({ snapshots: [snapshot(), snapshot()], onError: (error) => onErrors.push(error) });
  const handle = await beginAndBind(h);
  h.watching.watchers[0].change(null);
  h.watching.watchers[0].emit("error", Object.assign(new Error("denied"), { code: "EPERM" }));
  const result = await finishAfterQuiet(h, handle);

  assert.equal(result.complete, false);
  assert.equal(result.diagnostics.filter(({ code }) => code === "watch_filename_missing").length, 1);
  assert.equal(result.diagnostics.filter(({ code }) => code === "watch_error").length, 1);
  assert.equal(onErrors.length, 1);
  await h.tracker.close();
});

test("D: coalesces pending hint persistence while preserving the newest bounded hint set", async () => {
  const gate = deferred();
  const calls = [];
  const store = makeStore(calls);
  let update = 0;
  store.updatePendingHints = async function updatePendingHints(localTaskId, hints) {
    update += 1;
    this.hintUpdates.push({
      localTaskId,
      hints: new Map([...hints].map(([name, sources]) => [name, new Set(sources)])),
    });
    if (update === 1) await gate.promise;
  };
  const h = createHarness({ store, snapshots: [snapshot(), snapshot()] });
  const handle = await beginAndBind(h);
  h.tracker.noteFileChange(handle, { status: "completed", path: "first.txt" });
  await flush();
  h.tracker.noteFileChange(handle, { status: "completed", path: "latest.txt" });
  gate.resolve();
  const result = await finishAfterQuiet(h, handle);

  assert.equal(result.complete, true);
  assert.equal(store.hintUpdates.length, 2);
  assert.deepEqual([...store.hintUpdates.at(-1).hints.keys()], ["first.txt", "latest.txt"]);
  await h.tracker.close();
});

test("D: pending hint write failure is isolated and marks candidate persistence incomplete", async () => {
  const store = makeStore();
  store.updatePendingHints = async () => { throw new Error("disk full"); };
  const h = createHarness({ store, snapshots: [snapshot(), snapshot()] });
  const handle = await beginAndBind(h);
  h.tracker.noteFileChange(handle, { status: "completed", path: "hint.txt" });
  const result = await finishAfterQuiet(h, handle);

  assert.equal(result.complete, false);
  assert.equal(result.diagnostics.filter(({ code }) => code === "candidate_persist_failed").length, 1);
  await h.tracker.close();
});

test("E: quiet settlement waits 750ms after the newest change", async () => {
  const h = createHarness({ snapshots: [snapshot(), snapshot()] });
  const handle = await beginAndBind(h);
  const finishing = h.tracker.finishTurn(handle, { reason: "completed" });
  await flush();
  await h.clock.tick(500);
  h.watching.watchers[0].change("during-settle.txt");
  await h.clock.tick(749);
  assert.equal(h.store.finalized.length, 0);
  await h.clock.tick(1);
  await finishing;
  assert.equal(h.store.finalized.length, 1);
  await h.tracker.close();
});

test("E: settlement stops at the 3s cap and emits settle_timeout", async () => {
  const h = createHarness({ snapshots: [snapshot(), snapshot()] });
  const handle = await beginAndBind(h);
  const finishing = h.tracker.finishTurn(handle, { reason: "completed" });
  await flush();
  for (let elapsed = 500; elapsed <= 3_000; elapsed += 500) {
    await h.clock.tick(500);
    if (elapsed < 3_000) h.watching.watchers[0].change(`busy-${elapsed}.txt`);
  }
  const result = await finishing;
  assert.equal(result.complete, false);
  assert.equal(result.diagnostics.filter(({ code }) => code === "settle_timeout").length, 1);
  await h.tracker.close();
});

test("F: tail batches are sorted, candidate-only, capped at 500, and share the main artifact budget", async () => {
  const terminal = snapshot();
  const tailSnapshot = (_root, options) => snapshot(
    options.candidates.map((name, index) => [name, signature(index + 10)]),
  );
  const h = createHarness({
    policy: { tailMs: 10_000 },
    snapshots: [snapshot(), terminal, tailSnapshot],
  });
  const events = [];
  h.tracker.subscribe((event) => events.push(event));
  const handle = await beginAndBind(h);
  await finishAfterQuiet(h, handle);
  for (let index = 999; index >= 0; index -= 1) {
    h.watching.watchers[1].change(`tail/${String(index).padStart(4, "0")}.txt`);
  }
  await h.clock.tick(100);
  await settleAsync();
  await h.clock.tick(100);
  await settleAsync();

  const tailCalls = h.snapshotCalls.slice(2);
  assert.equal(tailCalls.length, 1);
  assert.equal(tailCalls[0].options.candidateOnly, true);
  assert.equal(tailCalls[0].options.candidates.length, 500);
  assert.deepEqual(tailCalls[0].options.candidates, [...tailCalls[0].options.candidates].sort());
  assert.equal(h.store.ingested.length, 500);
  const final = h.store.finalized.at(-1);
  assert.equal(final.complete, false);
  assert.equal(final.diagnostics.filter(({ code }) => code === "artifact_limit").length, 1);
  assert.equal(events.at(-1).complete, false);
  await h.tracker.close();
});

test("F: main 499 artifacts allow only one of ten late artifacts", async () => {
  const mainEntries = Array.from({ length: 499 }, (_, index) => [`main-${index}.txt`, signature(index + 2)]);
  const h = createHarness({
    policy: { tailMs: 10_000 },
    snapshots: [
      snapshot(),
      snapshot(mainEntries),
      (_root, options) => snapshot(options.candidates.map((name, index) => [name, signature(index + 10_000)])),
    ],
  });
  const handle = await beginAndBind(h);
  await finishAfterQuiet(h, handle);
  for (let index = 0; index < 10; index += 1) h.watching.watchers[1].change(`late/${index}.txt`);
  await h.clock.tick(100);
  await settleAsync();

  assert.equal(h.store.ingested.length, 500);
  assert.equal(h.store.finalized.at(-1).diagnostics.filter(({ code }) => code === "artifact_limit").length, 1);
  await h.tracker.close();
});

test("F: same-path changes during an in-flight tail batch coalesce into one serial retry", async () => {
  const gate = deferred();
  let tailScans = 0;
  let active = 0;
  let maximumActive = 0;
  const tailSnapshot = async (_root, options) => {
    tailScans += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (tailScans === 1) await gate.promise;
    active -= 1;
    return snapshot([[options.candidates[0], signature(tailScans + 20)]]);
  };
  const h = createHarness({
    policy: { tailMs: 10_000 },
    snapshots: [
      snapshot(),
      snapshot(),
      tailSnapshot,
      tailSnapshot,
    ],
  });
  const handle = await beginAndBind(h);
  await finishAfterQuiet(h, handle);
  const tailWatcher = h.watching.watchers[1];
  tailWatcher.change("repeat.txt");
  const firstTick = h.clock.tick(100);
  await flush();
  tailWatcher.change("repeat.txt");
  tailWatcher.change("repeat.txt");
  gate.resolve();
  await firstTick;
  await settleAsync();
  await h.clock.tick(100);
  await settleAsync();

  assert.equal(tailScans, 2);
  assert.equal(maximumActive, 1);
  assert.equal(h.store.ingested.filter(({ relativePath }) => relativePath === "repeat.txt").length, 2);
  await h.tracker.close();
});

test("F: a later unrelated tail event does not re-enqueue an already settled path", async () => {
  const h = createHarness({
    policy: { tailMs: 10_000 },
    snapshots: [
      snapshot(),
      snapshot(),
      snapshot([["a.txt", signature(20)]]),
      snapshot([["b.txt", signature(21)]]),
    ],
  });
  const handle = await beginAndBind(h, "tail-history");
  await finishAfterQuiet(h, handle);
  const tailWatcher = h.watching.watchers[1];
  tailWatcher.change("a.txt");
  await h.clock.tick(100);
  await settleAsync();
  tailWatcher.change("b.txt");
  await h.clock.tick(100);
  await settleAsync();

  assert.deepEqual(h.snapshotCalls[2].options.candidates, ["a.txt"]);
  assert.deepEqual(h.snapshotCalls[3].options.candidates, ["b.txt"]);
  assert.deepEqual(h.store.ingested.map(({ relativePath }) => relativePath), ["a.txt", "b.txt"]);
  await h.tracker.close();
});

test("F: tail watch errors are diagnosed once without an unhandled EventEmitter error", async () => {
  const errors = [];
  const h = createHarness({
    policy: { tailMs: 10_000 },
    snapshots: [snapshot(), snapshot()],
    onError: (error) => errors.push(error),
  });
  const handle = await beginAndBind(h);
  await finishAfterQuiet(h, handle);
  const failure = new Error("tail watch failed");
  h.watching.watchers[1].emit("error", failure);
  h.watching.watchers[1].emit("error", failure);
  await h.tracker.close();

  assert.equal(errors.length, 2);
  assert.equal(h.store.finalized.at(-1).diagnostics.filter(({ code }) => code === "tail_watch_error").length, 1);
  assert.equal(h.store.finalized.at(-1).complete, false);
});

test("F: tail commit failure emits one bounded partial update without claiming uncommitted records", async () => {
  const calls = [];
  const store = makeStore(calls);
  const originalFinalize = store.finalizeTurn.bind(store);
  let finalizations = 0;
  store.finalizeTurn = async (input) => {
    finalizations += 1;
    if (finalizations === 2) throw new Error("tail manifest failed");
    return originalFinalize(input);
  };
  const errors = [];
  const events = [];
  const h = createHarness({
    store,
    policy: { tailMs: 10_000 },
    snapshots: [snapshot(), snapshot(), snapshot([["late.txt", signature(50)]])],
    onError: (error) => errors.push(error),
  });
  h.tracker.subscribe((event) => events.push(event));
  const handle = await beginAndBind(h, "tail-commit-failure");
  const main = await finishAfterQuiet(h, handle);
  assert.equal(main.complete, true);
  h.watching.watchers[1].change("late.txt");
  await h.clock.tick(100);
  await settleAsync();
  await h.tracker.close();

  const failureEvents = events.filter((event) => (
    event.diagnostics.some(({ code }) => code === "tail_commit_failed")
  ));
  assert.equal(errors.length, 1);
  assert.equal(failureEvents.length, 1);
  assert.equal(failureEvents[0].complete, false);
  assert.deepEqual(failureEvents[0].records, []);
});

test("F: a successful tail preserves complete while a partial main can never become complete", async () => {
  for (const mainPartial of [false, true]) {
    const h = createHarness({
      policy: { tailMs: 10_000 },
      snapshots: [
        snapshot(),
        mainPartial ? new Error("main scan failed") : snapshot(),
        snapshot([["late.txt", signature(42)]]),
      ],
    });
    const handle = await beginAndBind(h, mainPartial ? "partial" : "complete");
    const main = await finishAfterQuiet(h, handle);
    h.watching.watchers[1].change("late.txt");
    await h.clock.tick(100);
    assert.equal(h.store.finalized.at(-1).complete, !mainPartial);
    assert.equal(main.complete, !mainPartial);
    await h.tracker.close();
  }
});

test("G: finish is exactly-once and queued begin waits for main finalization plus tail drain", async () => {
  const calls = [];
  const store = makeStore(calls);
  const finalizeGate = deferred();
  const originalFinalize = store.finalizeTurn.bind(store);
  let finalizations = 0;
  store.finalizeTurn = async (input) => {
    finalizations += 1;
    if (finalizations === 1) await finalizeGate.promise;
    return originalFinalize(input);
  };
  const h = createHarness({
    store,
    policy: { tailMs: 10_000 },
    snapshots: [snapshot(), snapshot(), snapshot()],
  });
  const first = await beginAndBind(h);
  const finishing = h.tracker.finishTurn(first, { reason: "completed" });
  assert.strictEqual(h.tracker.finishTurn(first, { reason: "ignored" }), finishing);
  await flush();
  await h.clock.tick(750);
  let began = false;
  const next = h.tracker.beginTurn({
    localTaskId: "local-next",
    threadId: "thread-next",
    cwd: process.cwd(),
    cwdGeneration: 8,
  }).then((value) => { began = true; return value; });
  await flush();
  assert.equal(began, false);
  finalizeGate.resolve();
  await finishing;
  const nextHandle = await next;

  assert.equal(finalizations, 1);
  assert.equal(h.watching.watchers[1].closed, 1);
  assert.equal(began, true);
  await h.tracker.abortTurn(nextHandle, { reason: "test" });
  await h.tracker.close();
});

test("G: rejects a second main turn until the accepted active turn settles", async () => {
  const h = createHarness();
  const first = await h.tracker.beginTurn({
    localTaskId: "active-first",
    threadId: "thread-active-first",
    cwd: process.cwd(),
    cwdGeneration: 1,
  });
  await assert.rejects(h.tracker.beginTurn({
    localTaskId: "active-second",
    threadId: "thread-active-second",
    cwd: process.cwd(),
    cwdGeneration: 2,
  }), /active main turn/);
  assert.equal(h.tracker.turns.size, 1);
  await h.tracker.abortTurn(first, { reason: "test" });
  await h.tracker.close();
});

test("G: queued begin drains every old-tail batch through the shared artifact limit", async () => {
  const h = createHarness({
    policy: { tailMs: 10_000 },
    snapshots: [
      snapshot(),
      snapshot(),
      (_root, options) => snapshot(options.candidates.map((name, index) => [name, signature(index + 100)])),
      snapshot(),
    ],
  });
  const first = await beginAndBind(h, "drain-first");
  await finishAfterQuiet(h, first);
  for (let index = 0; index < 600; index += 1) {
    h.watching.watchers[1].change(`drain/${String(index).padStart(4, "0")}.txt`);
  }
  const next = await h.tracker.beginTurn({
    localTaskId: "drain-next",
    threadId: "thread-drain-next",
    cwd: process.cwd(),
    cwdGeneration: 9,
  });

  assert.equal(h.store.ingested.length, 500);
  assert.equal(h.store.finalized.at(-1).complete, false);
  assert.equal(h.store.finalized.at(-1).diagnostics.filter(({ code }) => code === "artifact_limit").length, 1);
  await h.tracker.abortTurn(next, { reason: "test" });
  await h.tracker.close();
});

test("G: close rejects racing begin and waits for deferred finalization while closing watchers", async () => {
  const store = makeStore();
  const gate = deferred();
  const originalFinalize = store.finalizeTurn.bind(store);
  store.finalizeTurn = async (input) => { await gate.promise; return originalFinalize(input); };
  const h = createHarness({ store, snapshots: [snapshot(), snapshot()] });
  const handle = await beginAndBind(h);
  const finishing = h.tracker.finishTurn(handle, { reason: "completed" });
  await flush();
  await h.clock.tick(750);
  const closing = h.tracker.close();
  await assert.rejects(
    h.tracker.beginTurn({ localTaskId: "late", threadId: "thread", cwd: process.cwd(), cwdGeneration: 1 }),
    /closing/,
  );
  let closed = false;
  closing.then(() => { closed = true; });
  await flush();
  assert.equal(closed, false);
  assert.equal(h.watching.watchers[0].closed, 1);
  gate.resolve();
  await Promise.all([finishing, closing]);
  assert.equal(closed, true);
});

test("G: queued begin rechecks close after the prior main settlement releases", async () => {
  const calls = [];
  const store = makeStore(calls);
  const gate = deferred();
  const originalFinalize = store.finalizeTurn.bind(store);
  store.finalizeTurn = async (input) => {
    await gate.promise;
    return originalFinalize(input);
  };
  const h = createHarness({ store, snapshots: [snapshot(), snapshot(), snapshot()] });
  const first = await beginAndBind(h, "close-race-first");
  const finishing = h.tracker.finishTurn(first, { reason: "completed" });
  await flush();
  await h.clock.tick(750);
  const second = h.tracker.beginTurn({
    localTaskId: "close-race-second",
    threadId: "thread-close-race-second",
    cwd: process.cwd(),
    cwdGeneration: 2,
  });
  await flush();
  const closing = h.tracker.close();
  gate.resolve();

  await assert.rejects(second, /artifact_tracker_closed/);
  await Promise.all([finishing, closing]);
  assert.equal(h.watching.watchers.length, 1);
  assert.equal(store.saved.length, 1);
});

test("G: aborting an unbound turn closes its watcher and removes pending state", async () => {
  const h = createHarness();
  const handle = await h.tracker.beginTurn({
    localTaskId: "unbound",
    threadId: "thread",
    cwd: process.cwd(),
    cwdGeneration: 1,
  });
  await h.tracker.abortTurn(handle, { reason: "cancelled" });
  assert.equal(h.watching.watchers[0].closed, 1);
  assert.ok(h.calls.includes("pending:abort"));
  await h.tracker.close();
});

test("H: recovery aborts unbound pending turns with a diagnostic", async () => {
  const calls = [];
  const store = makeStore(calls);
  await store.savePendingTurn({
    handle: Object.freeze({
      localTaskId: "pending-unbound",
      threadId: "thread",
      turnId: null,
      workspaceRealPath: process.cwd(),
      cwdGeneration: 1,
      startedAt: 1,
    }),
    baseline: snapshot(),
    hints: new Map(),
  });
  const h = createHarness({ store });
  const recovered = await h.tracker.recoverPendingTurns();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].complete, false);
  assert.ok(recovered[0].diagnostics.some(({ code }) => code === "pending_turn_unbound"));
  assert.equal(calls.filter((call) => call === "pending:abort").length, 1);
  assert.equal(store.pending.has("pending-unbound"), false);
  await h.tracker.close();
});

test("H: recovery uses only persisted safe hints, finalizes a bound turn, and removes pending", async () => {
  const calls = [];
  const store = makeStore(calls);
  const pending = {
    handle: Object.freeze({
      localTaskId: "pending-bound",
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      workspaceRealPath: process.cwd(),
      cwdGeneration: 2,
      startedAt: 1,
    }),
    baseline: snapshot([], { covered: [] }),
    hints: new Map([
      ["safe.txt", new Set(["watch"])],
      ["../escape.txt", new Set(["watch"])],
    ]),
  };
  store.pendingTurns = () => [pending];
  const h = createHarness({
    store,
    snapshots: [snapshot([["safe.txt", signature(12)]], { covered: [] })],
  });
  const recovered = await h.tracker.recoverPendingTurns();

  assert.deepEqual(h.snapshotCalls[0].options.candidates, ["safe.txt"]);
  assert.equal(h.snapshotCalls[0].options.candidateOnly, true);
  assert.deepEqual(h.store.ingested.map(({ relativePath }) => relativePath), ["safe.txt"]);
  assert.ok(recovered[0].diagnostics.some(({ code }) => code === "recovered_after_restart"));
  assert.ok(calls.includes("pending:complete"));
  await h.tracker.close();
});

test("H: unavailable recovery workspace remains pending and returns retryable diagnostic without guessed records", async () => {
  const calls = [];
  const store = makeStore(calls);
  store.pendingTurns = () => [{
    handle: Object.freeze({
      localTaskId: "pending-missing",
      threadId: "thread",
      turnId: "turn",
      workspaceRealPath: pathForMissingWorkspace(),
      cwdGeneration: 1,
      startedAt: 1,
    }),
    baseline: snapshot(),
    hints: new Map([["maybe.txt", new Set(["watch"])]]),
  }];
  const h = createHarness({ store });
  const recovered = await h.tracker.recoverPendingTurns();
  assert.deepEqual(recovered[0].records, []);
  assert.equal(recovered[0].retryable, true);
  assert.ok(recovered[0].diagnostics.some(({ code }) => code === "pending_workspace_unavailable"));
  assert.equal(calls.includes("pending:complete"), false);
  assert.equal(calls.includes("pending:abort"), false);
  await h.tracker.close();
});

test("I: terminal scanner and ingest failures never reject finish, and listener/onError failures are isolated", async () => {
  const store = makeStore();
  store.ingest = async () => { throw new Error("ingest failed"); };
  const h = createHarness({
    store,
    snapshots: [snapshot(), snapshot([["fallback.txt", signature(2)]])],
    onError: () => { throw new Error("onError failed"); },
  });
  h.tracker.subscribe(() => { throw new Error("listener failed"); });
  const handle = await beginAndBind(h);
  const result = await finishAfterQuiet(h, handle);
  assert.equal(result.complete, false);
  assert.equal(result.records.length, 0);
  assert.ok(result.diagnostics.some(({ code }) => code === "artifact_ingest_failed"));
  await h.tracker.close();
});

function pathForMissingWorkspace() {
  return `${process.cwd()}-${Date.now()}-missing`;
}
