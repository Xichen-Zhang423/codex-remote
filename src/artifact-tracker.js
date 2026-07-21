import fs from "node:fs";
import path from "node:path";
import { diffSnapshots, normalizeCandidate, snapshotWorkspace } from "./artifact-scan.js";

export const DEFAULT_ARTIFACT_TRACKER_POLICY = Object.freeze({
  quietMs: 750,
  maxSettleMs: 3_000,
  tailMs: 10_000,
  tailBatchMs: 100,
  tailBatchPaths: 500,
  maxArtifactsPerTurn: 500,
  maxDirtyPaths: 10_000,
});

const INCOMPLETE_CODES = new Set([
  "watch_filename_missing",
  "watch_error",
  "watch_unavailable",
  "dirty_overflow",
  "settle_timeout",
  "terminal_scan_failed",
  "artifact_ingest_failed",
  "candidate_persist_failed",
  "tail_watch_error",
  "tail_scan_failed",
  "tail_commit_failed",
  "tail_dirty_overflow",
  "artifact_limit",
]);

function diagnostic(code, message, extra) {
  return { code, message, ...(extra ?? {}) };
}

function cloneHints(hints) {
  return new Map([...hints].map(([relativePath, sources]) => [relativePath, new Set(sources)]));
}

function noopWatcher() {
  return { close() {} };
}

function closeWatcher(watcher) {
  if (!watcher || watcher.__artifactTrackerClosed) return;
  watcher.__artifactTrackerClosed = true;
  try { watcher.close?.(); } catch {}
}

function reasonMessage(code) {
  return code.replaceAll("_", " ");
}

function recordPath(change) {
  return change?.relativePath ?? change?.path ?? change?.filename ?? null;
}

export class ArtifactTracker {
  constructor({
    store,
    watch = fs.watch,
    snapshot = snapshotWorkspace,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    policy = {},
    onError = () => {},
  } = {}) {
    if (!store) throw new TypeError("store is required");
    this.store = store;
    this.watch = watch;
    this.snapshot = snapshot;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.policy = Object.freeze({
      ...DEFAULT_ARTIFACT_TRACKER_POLICY,
      ...policy,
      maxArtifactsPerTurn: Math.min(500, Math.max(1, Math.floor(
        Number.isFinite(policy.maxArtifactsPerTurn)
          ? policy.maxArtifactsPerTurn
          : DEFAULT_ARTIFACT_TRACKER_POLICY.maxArtifactsPerTurn,
      ))),
      maxDirtyPaths: 10_000,
    });
    this.onError = typeof onError === "function" ? onError : () => {};
    this.turns = new Map();
    this.listeners = new Set();
    this.mainSettlement = Promise.resolve();
    this.starting = Promise.resolve();
    this.closing = false;
    this.closePromise = null;
    this.tail = null;
  }

  reportError(error) {
    try { this.onError(error); } catch {}
  }

  addDiagnostic(state, code, message = reasonMessage(code), extra) {
    if (state.diagnosticCodes.has(code)) return;
    state.diagnosticCodes.add(code);
    state.diagnostics.push(diagnostic(code, message, extra));
    if (INCOMPLETE_CODES.has(code)) state.complete = false;
  }

  emit(update) {
    for (const listener of [...this.listeners]) {
      try { listener(update); } catch (error) { this.reportError(error); }
    }
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  beginTurn(input) {
    if (this.closing) return Promise.reject(new Error("artifact_tracker_closed: artifact tracker is closing"));
    const operation = this.starting.then(async () => {
      if (this.closing) throw new Error("artifact_tracker_closed: artifact tracker is closing");
      await this.mainSettlement;
      if (this.closing) throw new Error("artifact_tracker_closed: artifact tracker is closing");
      await this.closeTail();
      if (this.closing) throw new Error("artifact_tracker_closed: artifact tracker is closing");
      return this.startTurn(input);
    });
    this.starting = operation.catch(() => {});
    return operation;
  }

  async startTurn({ localTaskId, threadId, cwd, cwdGeneration } = {}) {
    if (typeof localTaskId !== "string" || !localTaskId) throw new TypeError("localTaskId is required");
    if (typeof threadId !== "string" || !threadId) throw new TypeError("threadId is required");
    if (typeof cwd !== "string" || !cwd) throw new TypeError("cwd is required");
    if (this.turns.size > 0) throw new Error("an active main turn already exists");

    const workspaceRealPath = await fs.promises.realpath(cwd);
    const handle = Object.freeze({
      localTaskId,
      threadId,
      turnId: null,
      workspaceRealPath,
      cwdGeneration: Number.isFinite(cwdGeneration) ? cwdGeneration : 0,
      startedAt: this.now(),
    });
    const state = {
      handle,
      threadId,
      turnId: null,
      workspaceRealPath,
      watcher: null,
      hints: new Map(),
      hintVersion: 0,
      persistedHintVersion: 0,
      hintPersistence: Promise.resolve(),
      hintPersistenceRunning: false,
      pendingSaved: false,
      active: true,
      acceptingChanges: true,
      lastDirtyAt: this.now(),
      diagnostics: [],
      diagnosticCodes: new Set(),
      complete: true,
      records: [],
      remainingArtifacts: this.policy.maxArtifactsPerTurn,
      finishing: null,
      baseline: null,
    };

    try {
      state.watcher = this.installWatcher(state, false);
      state.baseline = await this.snapshot(workspaceRealPath);
      await this.store.savePendingTurn({ handle, baseline: state.baseline, hints: state.hints });
      state.pendingSaved = true;
      this.queueHintPersistence(state);
      await this.awaitHintPersistence(state);
      this.turns.set(localTaskId, state);
      return handle;
    } catch (error) {
      state.active = false;
      closeWatcher(state.watcher);
      throw error;
    }
  }

  installWatcher(state, tail) {
    let watcher;
    try {
      watcher = this.watch(state.workspaceRealPath, { recursive: true }, (_eventType, filename) => {
        if (!state.acceptingChanges) return;
        if (filename == null || String(filename).trim() === "") {
          this.addDiagnostic(
            state,
            tail ? "tail_watch_error" : "watch_filename_missing",
            "watch event did not include a filename",
          );
          return;
        }
        this.addHint(state, String(filename), "watch", tail);
      });
      if (!watcher || typeof watcher.on !== "function") {
        throw new TypeError("watcher must support error events");
      }
      watcher.on("error", (error) => {
        this.addDiagnostic(
          state,
          tail ? "tail_watch_error" : "watch_error",
          error?.message ?? "workspace watch failed",
        );
        this.reportError(error);
        if (tail) {
          state.needsCommit = true;
          this.queueTailBatch(state);
        }
      });
      return watcher;
    } catch (error) {
      closeWatcher(watcher);
      this.addDiagnostic(
        state,
        tail ? "tail_watch_error" : "watch_unavailable",
        error?.message ?? "workspace watch unavailable",
      );
      this.reportError(error);
      return noopWatcher();
    }
  }

  addHint(state, suppliedPath, provenance, tail = false) {
    const normalized = normalizeCandidate(state.workspaceRealPath, suppliedPath);
    if (!normalized) return false;
    const existing = state.hints.get(normalized.relative);
    if (!existing && state.hints.size >= this.policy.maxDirtyPaths) {
      this.addDiagnostic(
        state,
        tail ? "tail_dirty_overflow" : "dirty_overflow",
        "dirty path limit 10000 exceeded",
      );
      return false;
    }
    const sources = existing ?? new Set();
    const previousSize = sources.size;
    sources.add(provenance);
    state.hints.set(normalized.relative, sources);
    state.lastDirtyAt = this.now();
    if (!tail && (!existing || sources.size !== previousSize)) {
      state.hintVersion += 1;
      this.queueHintPersistence(state);
    }
    if (tail) {
      const generation = (state.generations.get(normalized.relative) ?? 0) + 1;
      state.generations.set(normalized.relative, generation);
      state.pendingPaths.set(normalized.relative, generation);
      this.queueTailBatch(state);
    }
    return true;
  }

  queueHintPersistence(state) {
    if (!state.active || !state.pendingSaved) return state.hintPersistence;
    if (state.hintPersistenceRunning) return state.hintPersistence;
    state.hintPersistenceRunning = true;
    state.hintPersistence = (async () => {
      while (state.persistedHintVersion < state.hintVersion) {
        const targetVersion = state.hintVersion;
        const hints = cloneHints(state.hints);
        try {
          await this.store.updatePendingHints(state.handle.localTaskId, hints);
        } catch (error) {
          this.addDiagnostic(state, "candidate_persist_failed", error?.message ?? "candidate persistence failed");
          this.reportError(error);
        }
        state.persistedHintVersion = targetVersion;
      }
    })().finally(() => {
      state.hintPersistenceRunning = false;
      if (state.active && state.pendingSaved && state.persistedHintVersion < state.hintVersion) {
        this.queueHintPersistence(state);
      }
    });
    return state.hintPersistence;
  }

  async awaitHintPersistence(state) {
    while (state.hintPersistenceRunning || state.persistedHintVersion < state.hintVersion) {
      if (!state.hintPersistenceRunning) this.queueHintPersistence(state);
      await state.hintPersistence;
    }
  }

  stateFor(handle) {
    if (!handle || typeof handle.localTaskId !== "string") throw new TypeError("invalid turn handle");
    const state = this.turns.get(handle.localTaskId);
    if (!state || state.handle !== handle) throw new Error("turn handle is not active");
    return state;
  }

  async bindTurnId(handle, turnId) {
    const state = this.stateFor(handle);
    if (typeof turnId !== "string" || !turnId) throw new TypeError("turnId is required");
    await this.awaitHintPersistence(state);
    state.turnId = turnId;
    await this.store.bindPendingTurn(handle.localTaskId, turnId);
  }

  noteFileChange(handle, change) {
    const state = this.stateFor(handle);
    if (!state.acceptingChanges) return;
    if (change?.status != null && change.status !== "completed") {
      this.addDiagnostic(state, "file_change_not_completed", "non-completed file change was not used as evidence");
      return;
    }
    const changes = Array.isArray(change?.changes) ? change.changes : [change];
    for (const item of changes) {
      const status = item?.status ?? change?.status;
      if (status != null && status !== "completed") {
        this.addDiagnostic(state, "file_change_not_completed", "non-completed file change was not used as evidence");
        continue;
      }
      this.addHint(state, recordPath(item), "appServer", false);
    }
  }

  finishTurn(handle, { reason } = {}) {
    let state;
    try { state = this.stateFor(handle); } catch (error) { return Promise.reject(error); }
    if (state.finishing) return state.finishing;
    state.finishing = this.finishState(state, reason).finally(() => {
      closeWatcher(state.watcher);
      state.active = false;
      this.turns.delete(state.handle.localTaskId);
    });
    this.mainSettlement = state.finishing.catch(() => {});
    return state.finishing;
  }

  async waitQuiet(state) {
    const startedAt = this.now();
    while (true) {
      const now = this.now();
      const quietRemaining = this.policy.quietMs - (now - state.lastDirtyAt);
      if (quietRemaining <= 0) return;
      const settleRemaining = this.policy.maxSettleMs - (now - startedAt);
      if (settleRemaining <= 0) {
        this.addDiagnostic(state, "settle_timeout", "workspace did not become quiet before the settle deadline");
        return;
      }
      await new Promise((resolve) => {
        const timer = this.setTimer(resolve, Math.min(quietRemaining, settleRemaining));
        timer?.unref?.();
      });
    }
  }

  snapshotUpdate(state, reason) {
    return {
      type: "artifact_update",
      threadId: state.threadId,
      turnId: state.turnId,
      revision: 0,
      records: [...state.records],
      complete: false,
      diagnostics: [...state.diagnostics],
      ...(reason ? { reason } : {}),
    };
  }

  async finishState(state, reason) {
    this.emit(this.snapshotUpdate(state, reason));
    await this.waitQuiet(state);
    state.acceptingChanges = false;
    closeWatcher(state.watcher);
    await this.awaitHintPersistence(state);

    let terminal;
    try {
      terminal = await this.snapshot(state.workspaceRealPath, {
        candidates: [...state.hints.keys()].sort(),
      });
      if (terminal?.partial && terminal.reasons?.some((code) => code !== "volume_root")) {
        this.addDiagnostic(state, "terminal_scan_failed", "terminal workspace scan was incomplete");
      }
    } catch (error) {
      this.addDiagnostic(state, "terminal_scan_failed", error?.message ?? "terminal workspace scan failed");
      this.reportError(error);
      terminal = state.baseline;
    }

    const diff = diffSnapshots(state.baseline, terminal, {
      hints: state.hints,
      maxArtifactsPerTurn: state.remainingArtifacts,
    });
    for (const item of diff.diagnostics) {
      this.addDiagnostic(state, item.code, item.message, item.relativePath ? { relativePath: item.relativePath } : undefined);
    }
    for (const change of diff.changes) {
      try {
        const record = await this.store.ingest({
          workspaceRealPath: state.workspaceRealPath,
          threadId: state.threadId,
          turnId: state.turnId,
          relativePath: change.relativePath,
          sourcePath: path.resolve(state.workspaceRealPath, ...change.relativePath.split("/")),
          kind: change.kind,
          provenance: change.provenance,
          detectedAt: this.now(),
        });
        state.records.push(record);
        state.remainingArtifacts -= 1;
      } catch (error) {
        this.addDiagnostic(
          state,
          "artifact_ingest_failed",
          error?.message ?? "artifact ingest failed",
          { relativePath: change.relativePath },
        );
        this.reportError(error);
      }
    }

    const complete = state.complete && !state.diagnostics.some(({ code }) => INCOMPLETE_CODES.has(code));
    let manifest;
    try {
      manifest = await this.store.finalizeTurn({
        workspaceRealPath: state.workspaceRealPath,
        threadId: state.threadId,
        turnId: state.turnId,
        complete,
        diagnostics: state.diagnostics,
      });
      await this.store.completePendingTurn(state.handle.localTaskId);
    } catch (error) {
      this.addDiagnostic(state, "artifact_ingest_failed", error?.message ?? "artifact finalization failed");
      this.reportError(error);
    }

    const result = {
      records: [...state.records],
      complete: Boolean(manifest) && state.complete,
      diagnostics: [...state.diagnostics],
    };
    this.emit({
      type: "artifact_update",
      threadId: state.threadId,
      turnId: state.turnId,
      revision: manifest?.revision ?? 0,
      ...result,
      ...(reason ? { reason } : {}),
    });
    if (manifest && this.policy.tailMs > 0 && !this.closing && !state.diagnosticCodes.has("artifact_limit")) {
      await this.startTail(state, terminal, result, reason, manifest.revision);
    }
    return result;
  }

  async startTail(main, baseline, result, reason, revision) {
    const tail = {
      handle: main.handle,
      threadId: main.threadId,
      turnId: main.turnId,
      workspaceRealPath: main.workspaceRealPath,
      watcher: null,
      hints: new Map(),
      generations: new Map(),
      pendingPaths: new Map(),
      lastDirtyAt: this.now(),
      diagnostics: [...result.diagnostics],
      diagnosticCodes: new Set(result.diagnostics.map(({ code }) => code)),
      complete: result.complete,
      records: [...result.records],
      remainingArtifacts: main.remainingArtifacts,
      baseline,
      acceptingChanges: true,
      batchTimer: null,
      timer: null,
      processing: Promise.resolve(),
      needsCommit: false,
      reason,
      revision,
    };
    this.tail = tail;
    tail.watcher = this.installWatcher(tail, true);
    tail.timer = this.setTimer(() => {
      void this.finishTail(tail);
    }, this.policy.tailMs);
    tail.timer?.unref?.();
  }

  queueTailBatch(tail) {
    if (tail.batchTimer || !tail.acceptingChanges) return;
    tail.batchTimer = this.setTimer(() => {
      tail.batchTimer = null;
      tail.processing = tail.processing
        .then(() => this.processTailBatch(tail))
        .catch((error) => this.reportError(error));
    }, this.policy.tailBatchMs);
  }

  async processTailBatch(tail) {
    if (!tail.pendingPaths.size && !tail.needsCommit) return;
    const batchEntries = [...tail.pendingPaths.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, this.policy.tailBatchPaths);
    const batch = batchEntries.map(([relativePath]) => relativePath);
    for (const [relativePath, generation] of batchEntries) {
      if (tail.pendingPaths.get(relativePath) === generation) tail.pendingPaths.delete(relativePath);
    }
    tail.needsCommit = false;
    if (tail.remainingArtifacts <= 0 && batch.length) {
      this.addDiagnostic(tail, "artifact_limit", "artifact limit 500 reached");
      tail.pendingPaths.clear();
      tail.acceptingChanges = false;
      closeWatcher(tail.watcher);
      const committed = await this.commitTail(tail);
      if (!committed) this.stopTailAfterCommitFailure(tail);
      return;
    }
    let terminal;
    try {
      if (!batch.length) {
        terminal = tail.baseline;
      } else {
      terminal = await this.snapshot(tail.workspaceRealPath, {
        candidates: batch,
        candidateOnly: true,
      });
      }
    } catch (error) {
      this.addDiagnostic(tail, "tail_scan_failed", error?.message ?? "tail scan failed");
      this.reportError(error);
      terminal = tail.baseline;
    }
    const hints = new Map(batch.map((relativePath) => [relativePath, tail.hints.get(relativePath) ?? new Set(["watch"])]));
    const diff = diffSnapshots(tail.baseline, terminal, {
      hints,
      maxArtifactsPerTurn: tail.remainingArtifacts,
    });
    for (const item of diff.diagnostics) this.addDiagnostic(tail, item.code, item.message);
    for (const change of diff.changes) {
      try {
        const record = await this.store.ingest({
          workspaceRealPath: tail.workspaceRealPath,
          threadId: tail.threadId,
          turnId: tail.turnId,
          relativePath: change.relativePath,
          sourcePath: path.resolve(tail.workspaceRealPath, ...change.relativePath.split("/")),
          kind: change.kind,
          provenance: change.provenance,
          detectedAt: this.now(),
        });
        tail.records.push(record);
        tail.remainingArtifacts -= 1;
        if (record.state === "ready") {
          const signature = terminal.entries.get(change.relativePath);
          if (signature) tail.baseline.entries.set(change.relativePath, signature);
        }
      } catch (error) {
        this.addDiagnostic(tail, "artifact_ingest_failed", error?.message ?? "artifact ingest failed");
        this.reportError(error);
      }
    }
    const committed = await this.commitTail(tail);
    if (!committed) {
      this.stopTailAfterCommitFailure(tail);
      return;
    }
    if (tail.pendingPaths.size && tail.acceptingChanges) this.queueTailBatch(tail);
  }

  async commitTail(tail) {
    let manifest;
    try {
      manifest = await this.store.finalizeTurn({
        workspaceRealPath: tail.workspaceRealPath,
        threadId: tail.threadId,
        turnId: tail.turnId,
        complete: tail.complete,
        diagnostics: tail.diagnostics,
      });
    } catch (error) {
      this.addDiagnostic(tail, "tail_commit_failed", error?.message ?? "tail finalization failed");
      this.reportError(error);
      this.emit({
        type: "artifact_update",
        threadId: tail.threadId,
        turnId: tail.turnId,
        revision: tail.revision,
        records: [],
        complete: false,
        diagnostics: [...tail.diagnostics],
        ...(tail.reason ? { reason: tail.reason } : {}),
      });
      return false;
    }
    tail.revision = manifest.revision;
    this.emit({
      type: "artifact_update",
      threadId: tail.threadId,
      turnId: tail.turnId,
      revision: manifest.revision,
      records: [...tail.records],
      complete: tail.complete,
      diagnostics: [...tail.diagnostics],
      ...(tail.reason ? { reason: tail.reason } : {}),
    });
    return true;
  }

  stopTailAfterCommitFailure(tail) {
    tail.acceptingChanges = false;
    closeWatcher(tail.watcher);
    if (tail.batchTimer) {
      this.clearTimer(tail.batchTimer);
      tail.batchTimer = null;
    }
    tail.pendingPaths.clear();
    tail.needsCommit = false;
  }

  async finishTail(tail) {
    if (this.tail !== tail) return;
    tail.acceptingChanges = false;
    closeWatcher(tail.watcher);
    if (tail.batchTimer) {
      this.clearTimer(tail.batchTimer);
      tail.batchTimer = null;
    }
    if (tail.pendingPaths.size || tail.needsCommit) {
      tail.processing = tail.processing.then(() => this.processTailBatch(tail));
    }
    await tail.processing;
    while (tail.pendingPaths.size || tail.needsCommit) await this.processTailBatch(tail);
    if (this.tail === tail) this.tail = null;
  }

  async closeTail() {
    if (!this.tail) return;
    const tail = this.tail;
    this.tail = null;
    tail.acceptingChanges = false;
    closeWatcher(tail.watcher);
    if (tail.timer) this.clearTimer(tail.timer);
    if (tail.batchTimer) {
      this.clearTimer(tail.batchTimer);
      tail.batchTimer = null;
    }
    if (tail.pendingPaths.size || tail.needsCommit) {
      tail.processing = tail.processing.then(() => this.processTailBatch(tail));
    }
    await tail.processing;
    while (tail.pendingPaths.size || tail.needsCommit) await this.processTailBatch(tail);
  }

  async abortTurn(handle, { reason: _reason } = {}) {
    const state = this.stateFor(handle);
    if (state.finishing) {
      await state.finishing;
      return;
    }
    state.acceptingChanges = false;
    closeWatcher(state.watcher);
    await this.awaitHintPersistence(state);
    await this.store.abortPendingTurn(state.handle.localTaskId);
    state.active = false;
    this.turns.delete(state.handle.localTaskId);
  }

  async recoverPendingTurns() {
    const recovered = [];
    let pendingTurns;
    try {
      pendingTurns = await Promise.resolve(this.store.pendingTurns());
    } catch (error) {
      this.reportError(error);
      return recovered;
    }
    for (const pending of pendingTurns) {
      const handle = pending?.handle;
      if (!handle?.localTaskId) continue;
      if (!handle.turnId) {
        const result = {
          threadId: handle.threadId,
          turnId: null,
          records: [],
          complete: false,
          diagnostics: [diagnostic("pending_turn_unbound", "pending turn was never bound to a Codex turn")],
        };
        try {
          await this.store.abortPendingTurn(handle.localTaskId);
        } catch (error) {
          this.reportError(error);
        }
        recovered.push(result);
        continue;
      }

      let workspaceRealPath;
      try {
        workspaceRealPath = await fs.promises.realpath(handle.workspaceRealPath);
        const expected = path.resolve(handle.workspaceRealPath);
        const actual = path.resolve(workspaceRealPath);
        const same = process.platform === "win32"
          ? expected.toLowerCase() === actual.toLowerCase()
          : expected === actual;
        if (!same) throw new Error("pending workspace real path changed");
      } catch (error) {
        this.reportError(error);
        recovered.push({
          threadId: handle.threadId,
          turnId: handle.turnId,
          records: [],
          complete: false,
          retryable: true,
          diagnostics: [diagnostic(
            "pending_workspace_unavailable",
            "pending workspace is unavailable; recovery can be retried",
          )],
        });
        continue;
      }

      const hints = new Map();
      const suppliedHints = pending.hints instanceof Map ? pending.hints : new Map();
      for (const [suppliedPath, suppliedSources] of suppliedHints) {
        const normalized = normalizeCandidate(workspaceRealPath, suppliedPath);
        if (!normalized || hints.size >= this.policy.maxDirtyPaths) continue;
        const sources = new Set();
        for (const source of suppliedSources ?? []) {
          if (source === "watch" || source === "appServer") sources.add(source);
        }
        if (sources.size) hints.set(normalized.relative, sources);
      }
      const state = {
        diagnostics: [diagnostic("recovered_after_restart", "artifact turn recovered after restart")],
        diagnosticCodes: new Set(["recovered_after_restart"]),
        complete: true,
      };
      const records = [];
      let terminal;
      try {
        terminal = await this.snapshot(workspaceRealPath, {
          candidates: [...hints.keys()].sort(),
          candidateOnly: true,
        });
        if (terminal?.partial && terminal.reasons?.some((code) => code !== "volume_root")) {
          this.addDiagnostic(state, "terminal_scan_failed", "recovery terminal scan was incomplete");
        }
      } catch (error) {
        this.addDiagnostic(state, "terminal_scan_failed", error?.message ?? "recovery terminal scan failed");
        this.reportError(error);
        terminal = pending.baseline;
      }
      const diff = diffSnapshots(pending.baseline, terminal, {
        hints,
        maxArtifactsPerTurn: this.policy.maxArtifactsPerTurn,
      });
      for (const item of diff.diagnostics) this.addDiagnostic(state, item.code, item.message);
      for (const change of diff.changes) {
        try {
          records.push(await this.store.ingest({
            workspaceRealPath,
            threadId: handle.threadId,
            turnId: handle.turnId,
            relativePath: change.relativePath,
            sourcePath: path.resolve(workspaceRealPath, ...change.relativePath.split("/")),
            kind: change.kind,
            provenance: change.provenance,
            detectedAt: this.now(),
          }));
        } catch (error) {
          this.addDiagnostic(state, "artifact_ingest_failed", error?.message ?? "recovered artifact ingest failed");
          this.reportError(error);
        }
      }
      let manifest;
      try {
        manifest = await this.store.finalizeTurn({
          workspaceRealPath,
          threadId: handle.threadId,
          turnId: handle.turnId,
          complete: state.complete,
          diagnostics: state.diagnostics,
        });
        await this.store.completePendingTurn(handle.localTaskId);
      } catch (error) {
        this.addDiagnostic(state, "artifact_ingest_failed", error?.message ?? "recovery finalization failed");
        this.reportError(error);
      }
      const result = {
        threadId: handle.threadId,
        turnId: handle.turnId,
        revision: manifest?.revision ?? 0,
        records,
        complete: Boolean(manifest) && state.complete,
        diagnostics: state.diagnostics,
      };
      recovered.push(result);
      this.emit({ type: "artifact_update", ...result, reason: "recovered_after_restart" });
    }
    return recovered;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.starting;
      await this.closeTail();
      for (const state of this.turns.values()) {
        state.acceptingChanges = false;
        closeWatcher(state.watcher);
      }
      for (const state of this.turns.values()) await this.awaitHintPersistence(state);
      await this.mainSettlement;
      await this.closeTail();
      this.turns.clear();
      this.listeners.clear();
    })();
    return this.closePromise;
  }
}
