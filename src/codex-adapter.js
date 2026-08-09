import { randomUUID } from "node:crypto";
import { ApprovalBroker } from "./approval-broker.js";
import { translateItem, translateNotification } from "./event-translator.js";
import { materializeImages as materializeImageInputs } from "./image-input.js";
import { RpcRemoteError } from "./jsonl-rpc-client.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);

const DEFAULT_MAX_QUEUE = 20;
const MAX_PROMPT_TEXT = 200_000;
const MAX_EARLY_FILE_CHANGES = 1_000;
const HISTORY_RPC_TIMEOUT_MS = 60_000;
const DEFAULT_RESTART_BASE_MS = 1_000;
const DEFAULT_MAX_RESTART_DELAY_MS = 30_000;
const MAX_PROCESS_LOG_BUFFER = 4_096;

function isInitializeTimeout(error) {
  return error?.code === "RPC_TIMEOUT" && error?.method === "initialize";
}

function boundedProcessDiagnostic(value) {
  return String(value ?? "")
    .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-240);
}

function boundedRestartDelay(attempt, baseMs, maxMs) {
  const exponent = Math.min(30, Math.max(0, attempt - 1));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value, name) {
  if (value == null || value === "") return null;
  return nonEmptyString(value, name);
}

function threadIdFrom(response, fallback = null) {
  return response?.thread?.id ?? fallback;
}

export function historyEventsFromThread(thread) {
  const events = [];
  for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      events.push(...translateItem(item, "completed"));
    }
    if (turn?.status && turn.status !== "inProgress") {
      events.push(...translateNotification("turn/completed", { turn }));
    }
  }
  return events;
}

export class CodexAdapter {
  constructor({
    process,
    rpc,
    approvalBroker,
    cwd,
    model = null,
    effort = null,
    artifactTracker = null,
    emit = () => {},
    onError = () => {},
    materializeImages = materializeImageInputs,
    imageOptions = {},
    maxQueue = DEFAULT_MAX_QUEUE,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    restartBaseMs = DEFAULT_RESTART_BASE_MS,
    maxRestartDelayMs = DEFAULT_MAX_RESTART_DELAY_MS,
  } = {}) {
    if (!process && !rpc) throw new TypeError("CodexAdapter requires a process or rpc client");
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
      throw new TypeError("maxQueue must be a non-negative integer");
    }
    if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
      throw new TypeError("restart timers must be functions");
    }
    if (!Number.isSafeInteger(restartBaseMs) || restartBaseMs < 1) {
      throw new TypeError("restartBaseMs must be a positive integer");
    }
    if (!Number.isSafeInteger(maxRestartDelayMs) || maxRestartDelayMs < restartBaseMs) {
      throw new TypeError("maxRestartDelayMs must be an integer at least restartBaseMs");
    }
    this.process = process ?? null;
    this.rpc = rpc ?? null;
    this.cwd = nonEmptyString(cwd, "cwd");
    this.model = optionalString(model, "model");
    this.effort = optionalString(effort, "effort");
    this.artifactTracker = artifactTracker;
    this.cwdGeneration = 0;
    this.emit = emit;
    this.onError = onError;
    this.materializeImages = materializeImages;
    this.imageOptions = imageOptions;
    this.maxQueue = maxQueue;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.restartBaseMs = restartBaseMs;
    this.maxRestartDelayMs = maxRestartDelayMs;
    this.threadId = null;
    this.active = null;
    this.queue = [];
    this.started = false;
    this.closed = false;
    this.startPromise = null;
    this.startPromiseEpoch = null;
    this.exitCleanup = null;
    this.processListeners = null;
    this.processLogTail = "";
    this.processLogTruncated = false;
    this.phoneListeners = new Set();
    this.desired = false;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.restartPromise = null;
    this.retryInMs = 0;
    this.reconnectPending = false;
    this.recoveryThreadId = null;
    this.processExitSerial = 0;
    this.lifecycleEpoch = 0;
    this.phase = "stopped";
    this.approvalBroker = approvalBroker ?? new ApprovalBroker({
      emit: (event) => this.#emit(event),
      onError: (error) => this.#report(error),
    });
  }

  get queueLength() {
    return this.queue.length;
  }

  get appServerStatus() {
    if (this.phase === "online") return "online";
    if (["starting", "recovering", "backoff"].includes(this.phase)) return "restarting";
    return "offline";
  }

  async start() {
    if (!this.desired) {
      this.desired = true;
      this.lifecycleEpoch += 1;
    }
    if (this.started) return this.startResult;
    if (this.startPromise) {
      const pending = this.startPromise;
      if (this.startPromiseEpoch === this.lifecycleEpoch) return pending;
      try { await pending; } catch { /* the stale generation must settle before retrying */ }
      this.#assertLifecycle(this.lifecycleEpoch);
      return this.start();
    }
    this.#bindProcess();
    const exitCleanup = this.exitCleanup;
    const exitSerial = this.processExitSerial;
    const lifecycleEpoch = this.lifecycleEpoch;
    const promise = (async () => {
      if (exitCleanup) await exitCleanup;
      this.#assertLifecycle(lifecycleEpoch);
      const reconnecting = this.reconnectPending;
      const recoveryThreadId = this.recoveryThreadId;
      this.phase = "starting";
      try {
        const result = this.process ? await this.#startProcessWithRetry(lifecycleEpoch) : {};
        const candidateRpc = this.process ? this.process.rpc : this.rpc;
        if (!candidateRpc) throw new Error("Codex App Server did not expose an RPC client");
        const connection = { lifecycleEpoch, exitSerial, rpc: candidateRpc };
        this.#assertConnectionCurrent(connection);

        let recovery = null;
        if (reconnecting && recoveryThreadId) {
          this.phase = "recovering";
          recovery = await this.#recoverThread(recoveryThreadId, connection);
        }
        this.#assertConnectionCurrent(connection);

        if (recovery) this.threadId = recovery.threadId;
        this.rpc = candidateRpc;
        this.started = true;
        this.closed = false;
        this.phase = "online";
        this.startResult = result;
        this.reconnectPending = false;
        this.recoveryThreadId = null;
        this.restartAttempts = 0;
        this.retryInMs = 0;
        this.#clearRestartTimer();
        if (reconnecting) {
          const recoveredEvent = {
            type: "notice",
            code: "app_server_recovered",
            previousThreadId: recoveryThreadId,
            threadId: this.threadId,
            resumed: recovery?.resumed ?? null,
            preserveHistory: recovery?.resumed === false,
          };
          if (recovery?.resumed) {
            recoveredEvent.message = "Codex App Server restarted and resumed the current thread.";
          } else if (recovery) {
            recoveredEvent.message = "Codex App Server restarted; the previous thread was unavailable, so a new thread was created.";
          } else {
            recoveredEvent.message = "Codex App Server restarted and is ready.";
          }
          this.#emit(recoveredEvent);
          this.#emitSystemState("online");
        }
        return result;
      } catch (error) {
        this.started = false;
        this.closed = true;
        if (this.lifecycleEpoch === lifecycleEpoch) {
          this.phase = this.desired && this.reconnectPending ? "backoff" : "stopped";
        }
        if (this.process) {
          this.rpc = null;
          try {
            await this.process.stop();
          } catch (stopError) {
            this.#report(stopError);
          }
        }
        throw error;
      }
    })();
    this.startPromise = promise;
    this.startPromiseEpoch = lifecycleEpoch;
    try {
      return await promise;
    } finally {
      if (this.startPromise === promise) {
        this.startPromise = null;
        this.startPromiseEpoch = null;
      }
    }
  }

  async stop() {
    this.desired = false;
    this.lifecycleEpoch += 1;
    this.phase = "stopping";
    this.reconnectPending = false;
    this.recoveryThreadId = null;
    this.#clearRestartTimer();
    const hasPendingStart = Boolean(this.startPromise || this.restartPromise);
    if (this.closed && !this.started && !this.active && !this.queue.length && !hasPendingStart) {
      this.#unbindProcess();
      this.phase = "stopped";
      return;
    }
    this.closed = true;
    this.started = false;
    this.#unbindProcess();
    await this.#abortAll(new Error("Codex adapter stopped"), "adapter_stop");
    await this.process?.stop();
    if (this.process) this.rpc = null;
    this.phase = "stopped";
  }

  setCwd(cwd) {
    if (this.active) throw new Error("cannot change cwd while a turn is active");
    this.cwd = nonEmptyString(cwd, "cwd");
    this.cwdGeneration += 1;
    return this.cwd;
  }

  setModel(model) {
    this.model = optionalString(model, "model");
    return this.model;
  }

  setEffort(effort) {
    this.effort = optionalString(effort, "effort");
    return this.effort;
  }

  setSessionAuto(enabled) {
    return this.approvalBroker.setSessionAuto(enabled);
  }

  pendingApprovals() {
    return this.approvalBroker.pendingEvents();
  }

  subscribePhoneEvents(listener) {
    if (typeof listener !== "function") throw new TypeError("phone event listener must be a function");
    this.phoneListeners.add(listener);
    return () => this.phoneListeners.delete(listener);
  }

  async decideApproval(id, action, payload = {}) {
    return this.approvalBroker.decide(id, action, payload);
  }

  async newThread({ cwd = this.cwd, model = this.model, effort = this.effort } = {}) {
    if (this.active) throw new Error("cannot start a new thread while a turn is active");
    this.setCwd(cwd);
    this.setModel(model);
    this.setEffort(effort);
    return this.#startThread();
  }

  async #startThread() {
    const response = await this.#request("thread/start", this.#threadStartParams());
    const id = threadIdFrom(response);
    if (!id) throw new Error("thread/start returned no thread id");
    this.threadId = id;
    return response;
  }

  #threadStartParams() {
    return {
      cwd: this.cwd,
      ...(this.model ? { model: this.model } : {}),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    };
  }

  #threadResumeParams(threadId, { cwd = this.cwd } = {}) {
    return {
      threadId,
      cwd,
      ...(this.model ? { model: this.model } : {}),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    };
  }

  async resumeThread(threadId, { cwd = this.cwd } = {}) {
    if (this.active) throw new Error("cannot resume a thread while a turn is active");
    const id = nonEmptyString(threadId, "threadId");
    const targetCwd = nonEmptyString(cwd, "cwd");
    const response = await this.#request(
      "thread/resume",
      this.#threadResumeParams(id, { cwd: targetCwd }),
      { timeoutMs: HISTORY_RPC_TIMEOUT_MS },
    );
    this.setCwd(targetCwd);
    this.threadId = threadIdFrom(response, id);
    return { ...response, events: historyEventsFromThread(response?.thread) };
  }

  async #recoverThread(threadId, connection) {
    const id = nonEmptyString(threadId, "threadId");
    try {
      const response = await connection.rpc.request(
        "thread/resume",
        this.#threadResumeParams(id),
        { timeoutMs: HISTORY_RPC_TIMEOUT_MS },
      );
      this.#assertConnectionCurrent(connection);
      const restoredId = threadIdFrom(response, id);
      return { resumed: true, threadId: restoredId };
    } catch (error) {
      this.#assertConnectionCurrent(connection);
      if (!(error instanceof RpcRemoteError)) throw error;
      this.#report(error);
      const response = await connection.rpc.request("thread/start", this.#threadStartParams());
      this.#assertConnectionCurrent(connection);
      const replacementId = threadIdFrom(response);
      if (!replacementId) throw new Error("thread/start returned no thread id");
      return { resumed: false, threadId: replacementId };
    }
  }

  async listThreads({
    searchTerm,
    cwd,
    cursor,
    limit = 50,
    archived = false,
  } = {}) {
    return this.#request("thread/list", {
      ...(searchTerm ? { searchTerm } : {}),
      ...(cwd ? { cwd } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
      archived: archived === true,
    }, { timeoutMs: HISTORY_RPC_TIMEOUT_MS });
  }

  async readThread(threadId, { includeTurns = true } = {}) {
    const id = nonEmptyString(threadId, "threadId");
    if (typeof includeTurns !== "boolean") throw new TypeError("includeTurns must be a boolean");
    const response = await this.#request(
      "thread/read",
      { threadId: id, includeTurns },
      { timeoutMs: HISTORY_RPC_TIMEOUT_MS },
    );
    return { ...response, events: historyEventsFromThread(response?.thread) };
  }

  async renameThread(threadId, name) {
    return this.#request("thread/name/set", {
      threadId: nonEmptyString(threadId, "threadId"),
      name: nonEmptyString(name, "name"),
    });
  }

  async archiveThread(threadId) {
    return this.#request("thread/archive", { threadId: nonEmptyString(threadId, "threadId") });
  }

  async listModels({ cursor, limit = 100, includeHidden = false } = {}) {
    return this.#request("model/list", {
      ...(cursor ? { cursor } : {}),
      limit,
      includeHidden: includeHidden === true,
    });
  }

  sendPrompt({ text = "", images = [] } = {}) {
    if (this.closed) {
      const message = this.reconnectPending
        ? "Codex App Server is restarting; try again shortly"
        : "Codex adapter is stopped";
      return Promise.reject(new Error(message));
    }
    if (typeof text !== "string") return Promise.reject(new TypeError("prompt text must be a string"));
    if (text.length > MAX_PROMPT_TEXT) return Promise.reject(new Error("prompt text is too large"));
    if (!Array.isArray(images)) return Promise.reject(new TypeError("prompt images must be an array"));
    if (!text && !images.length) return Promise.reject(new Error("prompt must include text or an image"));
    if (this.active && this.queue.length >= this.maxQueue) {
      return Promise.reject(new Error("prompt queue is full"));
    }

    const completion = new Promise((resolve, reject) => {
      this.queue.push({ text, images: [...images], resolve, reject });
    });
    this.#pump();
    return completion;
  }

  async interrupt() {
    const record = this.active;
    if (!record?.threadId || !record?.turnId || record.finishing || record.interruptRequested) {
      return false;
    }
    record.interruptRequested = true;
    try {
      await this.#request("turn/interrupt", { threadId: record.threadId, turnId: record.turnId });
      this.#emit({ type: "notice", message: "Stopping the active Codex turn..." });
      return true;
    } catch (error) {
      record.interruptRequested = false;
      throw error;
    }
  }

  async handleNotification(method, params = {}) {
    if (method === "item/completed") {
      const record = this.active;
      const item = params?.item;
      const turnId = params?.turnId;
      const isCompletedFileChange = item?.type === "fileChange" && item?.status === "completed";
      const canTrack = Boolean(
        record?.artifactHandle
        && params?.threadId === record.threadId
        && typeof turnId === "string"
        && turnId,
      );
      if (canTrack && isCompletedFileChange) {
        if (record.confirmed && record.artifactBound) {
          if (turnId === record.turnId) this.#noteArtifactFileChange(record, item);
        } else if (record.earlyFileChangeCount < MAX_EARLY_FILE_CHANGES) {
          const changes = record.earlyFileChanges.get(turnId) ?? [];
          changes.push(item);
          record.earlyFileChanges.set(turnId, changes);
          record.earlyFileChangeCount += 1;
        } else if (!record.earlyFileChangeOverflowReported) {
          record.earlyFileChangeOverflowReported = true;
          this.#report(new Error("early file change buffer limit exceeded"));
        }
      }
    }
    if (method !== "turn/completed") {
      for (const event of translateNotification(method, params)) this.#emit(event);
    }

    if (method === "turn/started") {
      const record = this.active;
      const turnId = params?.turn?.id;
      const threadId = params?.threadId;
      if (record && turnId && (!threadId || threadId === record.threadId)) {
        record.turnId ??= turnId;
      }
      return;
    }

    if (method !== "turn/completed") return;
    const turn = params?.turn ?? {};
    const record = this.active;
    const sameThread = !params?.threadId || params.threadId === record?.threadId;
    const matches = Boolean(record?.confirmed && record.artifactBound && sameThread && turn?.id
      && record.turnId === turn.id);
    if (matches) {
      for (const event of translateNotification(method, params)) this.#emit(event);
      await this.#finishActive(record, turn, {
        reason: record.interruptRequested ? "interrupted" : "turn_completed",
      });
    } else if (record && (!record.confirmed || !record.artifactBound) && sameThread && turn?.id) {
      // JSON-RPC responses settle on a microtask, while a later notification
      // from the same stdout chunk is emitted synchronously. Hold a small
      // bounded set until turn/start confirms which terminal belongs to us.
      if (record.earlyTerminals.size >= 8) {
        record.earlyTerminals.delete(record.earlyTerminals.keys().next().value);
      }
      record.earlyTerminals.set(turn.id, turn);
    } else if (turn?.id) {
      try {
        await this.approvalBroker.clear({ turnId: turn.id, reason: "turn_completed" });
      } catch (error) {
        this.#report(error);
      }
    }
  }

  handleServerRequest(message = {}) {
    const method = message?.method;
    if (!APPROVAL_METHODS.has(method)) {
      this.rpc?.respondError?.(
        message?.id,
        -32601,
        `Unsupported App Server request: ${String(method ?? "unknown")}`,
      );
      return null;
    }
    return this.approvalBroker.register({
      rpcId: message.id,
      method,
      params: message.params ?? {},
      respond: (result) => this.#rpc().respond(message.id, result),
    });
  }

  #pump() {
    if (this.closed || this.active || !this.queue.length) return;
    const job = this.queue.shift();
    const record = {
      ...job,
      threadId: this.threadId,
      turnId: null,
      lease: null,
      cancelled: false,
      confirmed: false,
      interruptRequested: false,
      earlyTerminals: new Map(),
      earlyFileChanges: new Map(),
      earlyFileChangeCount: 0,
      earlyFileChangeOverflowReported: false,
      finishing: null,
      artifactHandle: null,
      artifactBeginPromise: null,
      artifactBindPromise: null,
      artifactBound: false,
      artifactSettlement: null,
      artifactCancellationReason: null,
    };
    this.active = record;
    void this.#startActive(record);
  }

  async #startActive(record) {
    try {
      if (!this.threadId) await this.#startThread();
      if (record.cancelled || this.active !== record) return;
      record.threadId = this.threadId;
      record.lease = await this.materializeImages(record.images, this.imageOptions);
      if (record.cancelled || this.active !== record) {
        await this.#cleanupLease(record);
        return;
      }
      const input = [];
      if (record.text) input.push({ type: "text", text: record.text });
      input.push(...(record.lease?.inputs ?? []));
      const params = {
        threadId: record.threadId,
        input,
        cwd: this.cwd,
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [this.cwd],
          networkAccess: true,
        },
      };
      if (this.artifactTracker) {
        record.artifactBeginPromise = Promise.resolve()
          .then(() => this.artifactTracker.beginTurn({
            localTaskId: randomUUID(),
            threadId: record.threadId,
            cwd: this.cwd,
            cwdGeneration: this.cwdGeneration,
          }))
          .then((handle) => {
            record.artifactHandle = handle;
            return handle;
          })
          .catch((error) => {
            this.#report(error);
            return null;
          });
        await record.artifactBeginPromise;
        if (record.cancelled || this.active !== record || this.closed) {
          await this.#settleArtifactTurn(
            record,
            record.artifactCancellationReason ?? "turn_start_failed",
          );
          return;
        }
      }
      const response = await this.#request("turn/start", params);
      const turnId = response?.turn?.id;
      if (!turnId) throw new Error("turn/start returned no turn id");
      if (record.cancelled || this.active !== record) {
        await this.#cleanupLease(record);
        return;
      }
      record.turnId = turnId;
      record.confirmed = true;
      if (record.artifactHandle) {
        record.artifactBindPromise = Promise.resolve()
          .then(() => this.artifactTracker.bindTurnId(record.artifactHandle, turnId))
          .catch((error) => this.#report(error));
        await record.artifactBindPromise;
      }
      record.artifactBound = true;
      if (record.cancelled || this.active !== record || this.closed) {
        this.#clearEarlyFileChanges(record);
        record.earlyTerminals.clear();
        return;
      }
      const earlyFileChanges = record.earlyFileChanges.get(turnId) ?? [];
      this.#clearEarlyFileChanges(record);
      this.#emit({ type: "turn_started", threadId: record.threadId, turnId: record.turnId });
      for (const item of earlyFileChanges) this.#noteArtifactFileChange(record, item);
      const earlyTerminal = record.earlyTerminals.get(turnId);
      for (const [staleTurnId] of record.earlyTerminals) {
        if (staleTurnId === turnId) continue;
        try {
          await this.approvalBroker.clear({ turnId: staleTurnId, reason: "stale_turn" });
        } catch (error) {
          this.#report(error);
        }
      }
      record.earlyTerminals.clear();
      if (earlyTerminal) {
        for (const event of translateNotification("turn/completed", {
          threadId: record.threadId,
          turn: earlyTerminal,
        })) this.#emit(event);
        await this.#finishActive(record, earlyTerminal, {
          reason: record.interruptRequested ? "interrupted" : "turn_completed",
        });
      }
    } catch (error) {
      if (record.cancelled) return;
      record.cancelled = true;
      this.#clearEarlyFileChanges(record);
      await this.#settleArtifactTurn(record, "turn_start_failed");
      await this.#cleanupLease(record);
      if (this.active === record) this.active = null;
      record.reject(error);
      this.#emit({ type: "error", message: error?.message || "Failed to start Codex turn" });
      this.#pump();
    }
  }

  #finishActive(record, turn, { reason }) {
    if (record.finishing) return record.finishing;
    record.finishing = (async () => {
      record.cancelled = true;
      this.#clearEarlyFileChanges(record);
      try {
        await this.approvalBroker.clear({ turnId: record.turnId ?? turn?.id, reason });
      } catch (error) {
        this.#report(error);
      }
      await this.#settleArtifactTurn(record, reason);
      await this.#cleanupLease(record);
      if (this.active === record) this.active = null;
      record.resolve(turn);
      this.#pump();
      return turn;
    })();
    return record.finishing;
  }

  #settleArtifactTurn(record, reason) {
    if (!record?.artifactHandle) return Promise.resolve();
    if (record.artifactSettlement) return record.artifactSettlement;
    const action = record.confirmed ? "finishTurn" : "abortTurn";
    record.artifactSettlement = Promise.resolve()
      .then(() => this.artifactTracker[action](record.artifactHandle, { reason }))
      .catch((error) => this.#report(error));
    return record.artifactSettlement;
  }

  #noteArtifactFileChange(record, item) {
    void Promise.resolve()
      .then(() => this.artifactTracker.noteFileChange(record.artifactHandle, item))
      .catch((error) => this.#report(error));
  }

  #clearEarlyFileChanges(record) {
    record?.earlyFileChanges?.clear();
    if (record) record.earlyFileChangeCount = 0;
  }

  async #cleanupLease(record) {
    this.#clearEarlyFileChanges(record);
    const lease = record.lease;
    record.lease = null;
    if (!lease?.cleanup) return;
    try {
      await lease.cleanup();
    } catch (error) {
      this.#report(error);
    }
  }

  async #abortAll(error, approvalReason) {
    const record = this.active;
    if (record) {
      record.cancelled = true;
      this.#clearEarlyFileChanges(record);
      record.artifactCancellationReason ??= approvalReason;
      if (record.artifactBeginPromise) await record.artifactBeginPromise;
      if (record.confirmed && record.artifactBindPromise) await record.artifactBindPromise;
      await this.#settleArtifactTurn(record, approvalReason);
      if (this.active === record) this.active = null;
      await this.#cleanupLease(record);
      record.reject(error);
    }
    for (const job of this.queue.splice(0)) job.reject(error);
    try {
      this.approvalBroker.setSessionAuto(false);
      await this.approvalBroker.close(approvalReason);
    } catch (brokerError) {
      this.#report(brokerError);
    }
  }

  #bindProcess() {
    if (!this.process || this.processListeners) return;
    const notification = (message) => {
      void this.handleNotification(message?.method, message?.params).catch((error) => this.#report(error));
    };
    const serverRequest = (message) => {
      try { this.handleServerRequest(message); } catch (error) { this.#report(error); }
    };
    const exit = (code, signal) => {
      void this.#handleProcessExit(code, signal).catch((error) => this.#report(error));
    };
    const log = (chunk) => {
      const combined = `${this.processLogTail}${String(chunk ?? "")}`;
      this.processLogTruncated ||= combined.length > MAX_PROCESS_LOG_BUFFER;
      this.processLogTail = combined.slice(-MAX_PROCESS_LOG_BUFFER);
    };
    const protocolError = (error) => {
      const detail = boundedProcessDiagnostic(error?.message || error);
      this.#report(new Error(`Codex App Server protocol error${detail ? `: ${detail}` : ""}`));
    };
    this.processListeners = { notification, serverRequest, exit, log, protocolError };
    this.process.on("notification", notification);
    this.process.on("serverRequest", serverRequest);
    this.process.on("exit", exit);
    this.process.on("log", log);
    this.process.on("protocolError", protocolError);
  }

  #unbindProcess() {
    if (!this.process || !this.processListeners) return;
    for (const [event, listener] of Object.entries(this.processListeners)) {
      this.process.off(event, listener);
    }
    this.processListeners = null;
  }

  async #startProcessWithRetry(lifecycleEpoch) {
    this.processLogTail = "";
    this.processLogTruncated = false;
    try {
      return await this.process.start();
    } catch (error) {
      if (!isInitializeTimeout(error)) throw error;
      const processDetail = this.#processDiagnosticDetail();
      const detail = processDetail ? ` Last App Server output: ${processDetail}` : "";
      this.#report(new Error(`Codex App Server initialize timed out; retrying once.${detail}`));
      await this.process.stop();
      this.#assertLifecycle(lifecycleEpoch);
      this.processLogTail = "";
      this.processLogTruncated = false;
      try {
        return await this.process.start();
      } catch (retryError) {
        if (isInitializeTimeout(retryError)) {
          const retryProcessDetail = this.#processDiagnosticDetail();
          const retryDetail = retryProcessDetail ? ` Last App Server output: ${retryProcessDetail}` : "";
          this.#report(new Error(`Codex App Server initialize failed after retry.${retryDetail}`));
        }
        throw retryError;
      }
    }
  }

  #processDiagnosticDetail() {
    if (this.processLogTruncated) return "[App Server output exceeded safe diagnostic limit]";
    return boundedProcessDiagnostic(this.processLogTail);
  }

  async #handleProcessExit(code, signal) {
    this.processExitSerial += 1;
    this.started = false;
    this.closed = true;
    this.phase = "backoff";
    this.reconnectPending = this.desired;
    this.recoveryThreadId ??= this.threadId;
    if (this.process) this.rpc = null;
    const detail = signal ? ` signal ${signal}` : ` code ${code}`;
    try {
      this.approvalBroker.setSessionAuto(false);
    } catch (error) {
      this.#report(error);
    }
    this.#emitSystemState("restarting");
    const cleanup = this.#abortAll(
      new Error(`Codex App Server exited with${detail}`),
      "app_server_exit",
    );
    this.exitCleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.exitCleanup === cleanup) this.exitCleanup = null;
    }
    this.#emit({
      type: "notice",
      code: "app_server_exited",
      message: `Codex App Server exited with${detail}`,
    });
    if (this.desired) this.#scheduleRestart();
  }

  #scheduleRestart() {
    if (!this.process || !this.desired || this.started || this.restartTimer) return;
    this.phase = "backoff";
    this.restartAttempts += 1;
    const attempt = this.restartAttempts;
    const delay = boundedRestartDelay(attempt, this.restartBaseMs, this.maxRestartDelayMs);
    this.retryInMs = delay;
    const timer = this.setTimer(() => {
      if (this.restartTimer !== timer) return;
      this.restartTimer = null;
      if (!this.desired || this.started) return;
      void this.#restartAfterExit();
    }, delay);
    this.restartTimer = timer;
    timer?.unref?.();
    this.#emitSystemState("restarting", { restartAttempt: attempt, retryInMs: delay });
  }

  #restartAfterExit() {
    if (this.restartPromise) return this.restartPromise;
    const promise = (async () => {
      try {
        await this.start();
      } catch (error) {
        if (!this.desired) return;
        this.#report(error);
        this.#scheduleRestart();
      }
    })();
    this.restartPromise = promise;
    void promise.finally(() => {
      if (this.restartPromise === promise) this.restartPromise = null;
    });
    return promise;
  }

  #clearRestartTimer() {
    if (this.restartTimer != null) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
    this.retryInMs = 0;
  }

  #emitSystemState(appServerStatus, extra = {}) {
    this.#emit({
      type: "system_init",
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      threadId: this.threadId,
      queueLength: this.queueLength,
      sessionAuto: this.approvalBroker?.sessionAuto === true,
      appServerStatus,
      ...extra,
    });
  }

  #assertLifecycle(lifecycleEpoch) {
    if (!this.desired || lifecycleEpoch !== this.lifecycleEpoch) {
      throw new Error("Codex App Server connection was superseded or stopped");
    }
  }

  #assertConnectionCurrent({ lifecycleEpoch, exitSerial, rpc }) {
    this.#assertLifecycle(lifecycleEpoch);
    if (exitSerial !== this.processExitSerial || (this.process && this.process.rpc !== rpc)) {
      throw new Error("Codex App Server connection was superseded during recovery");
    }
  }

  async #request(method, params, options) {
    return this.#rpc().request(method, params, options);
  }

  #rpc() {
    if (!this.rpc) throw new Error("Codex App Server is not connected");
    return this.rpc;
  }

  #emit(event) {
    try {
      this.emit(event);
    } catch (error) {
      this.#report(error);
    }
    for (const listener of this.phoneListeners) {
      try {
        listener(event);
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #report(error) {
    try { this.onError(error); } catch { /* reporting must not break adapter state */ }
  }
}
