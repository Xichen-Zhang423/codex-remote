import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { JsonlRpcClient } from "./jsonl-rpc-client.js";

const APP_SERVER_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_STOP_FORCE_MS = 2_000;

export function resolveCodexLaunch({ env = process.env, packageBin, platform = process.platform } = {}) {
  if (env?.CODEX_BIN) return { command: env.CODEX_BIN, argsPrefix: [], source: "CODEX_BIN" };
  if (packageBin) return { command: process.execPath, argsPrefix: [packageBin], source: "package" };
  return { command: platform === "win32" ? "codex.cmd" : "codex", argsPrefix: [], source: "PATH" };
}

export async function initializeAppServer(rpc, { timeoutMs = APP_SERVER_INITIALIZE_TIMEOUT_MS } = {}) {
  const result = await rpc.request("initialize", {
    clientInfo: { name: "codex_remote", title: "Codex Remote", version: "0.1.0" },
    capabilities: { experimentalApi: false },
  }, { timeoutMs });
  rpc.notify("initialized", {});
  return result;
}

export class CodexProcess extends EventEmitter {
  constructor({
    spawnImpl = spawn,
    packageBin,
    env = process.env,
    platform = process.platform,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    stopForceMs = DEFAULT_STOP_FORCE_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    super();
    if (!Number.isSafeInteger(stopGraceMs) || stopGraceMs < 1
      || !Number.isSafeInteger(stopForceMs) || stopForceMs < 1) {
      throw new TypeError("App Server stop timeouts must be positive integers");
    }
    this.spawnImpl = spawnImpl;
    this.packageBin = packageBin;
    this.env = env;
    this.platform = platform;
    this.stopGraceMs = stopGraceMs;
    this.stopForceMs = stopForceMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.child = null;
    this.rpc = null;
    this._startPromise = null;
    this._state = null;
    this._shutdownPromise = null;
    this._blockedStopError = null;
    this._blockedStopState = null;
  }

  start() {
    if (this._startPromise) return this._startPromise;
    if (this._blockedStopError) {
      const blocked = Promise.reject(this._blockedStopError);
      this._startPromise = blocked;
      blocked.catch(() => {
        if (this._startPromise === blocked) this._startPromise = null;
      });
      return blocked;
    }

    let resolveStart;
    let rejectStart;
    const promise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const state = {
      promise,
      resolveStart,
      rejectStart,
      phase: "starting",
      child: null,
      rpc: null,
      killCalled: false,
      finalized: false,
      retired: false,
      exitInfo: null,
      rpcListeners: [],
      stderrListener: null,
      childErrorListener: null,
      childExitListener: null,
      childCloseListener: null,
      safeErrorListener: null,
      retiredCloseListener: null,
      shutdownPromise: null,
      shutdownCloseListener: null,
      shutdownForceTimer: null,
      shutdownFailureTimer: null,
      rejectShutdown: null,
    };
    this._startPromise = promise;
    this._state = state;

    promise.catch(() => {
      if (state.phase === "failedDraining" && !state.finalized) return;
      if (this._startPromise === promise) this._startPromise = null;
      if (this._state === state) this._state = null;
    });

    try {
      const launch = resolveCodexLaunch({ env: this.env, packageBin: this.packageBin, platform: this.platform });
      const child = this.spawnImpl(launch.command, [...launch.argsPrefix, "app-server"], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      state.child = child;
      this.child = child;

      state.childErrorListener = (error) => {
        if (state.phase === "starting") this._failStart(state, error, true);
        else if (state.phase === "running" && !state.exitInfo) this.emit("processError", error);
      };
      state.childExitListener = (code, signal) => this._recordExit(state, code, signal);
      state.childCloseListener = (code, signal) => this._finalizeClose(state, code, signal);
      child.on("error", state.childErrorListener);
      child.on("exit", state.childExitListener);
      child.on("close", state.childCloseListener);

      const rpc = new JsonlRpcClient({ input: child.stdout, output: child.stdin });
      state.rpc = rpc;
      this.rpc = rpc;
      for (const event of ["notification", "serverRequest", "protocolError"]) {
        const listener = (...args) => this.emit(event, ...args);
        state.rpcListeners.push([event, listener]);
        rpc.on(event, listener);
      }

      child.stderr?.setEncoding?.("utf8");
      state.stderrListener = (...args) => this.emit("log", ...args);
      child.stderr?.on?.("data", state.stderrListener);

      initializeAppServer(rpc).then(
        (result) => {
          if (state.phase !== "starting" || state.exitInfo) return;
          state.phase = "running";
          resolveStart(result);
        },
        (error) => this._failStart(state, error, true),
      );
    } catch (error) {
      this._failStart(state, error, Boolean(state.child));
    }

    return promise;
  }

  stop() {
    const state = this._state;
    if (!state) return this._shutdownPromise ?? Promise.resolve();
    if (state.phase === "starting") {
      state.phase = "stopped";
      state.rejectStart(new Error("Codex App Server stopped during startup"));
    } else {
      state.phase = "stopped";
    }
    const shutdown = this._retire(state, new Error("Codex App Server stopped"), true);
    if (this._startPromise === state.promise) this._startPromise = null;
    return shutdown ?? Promise.resolve();
  }

  _failStart(state, error, kill) {
    if (state.phase !== "starting" || state.retired) return;
    state.rejectStart(error);
    if (state.exitInfo) {
      state.phase = "failedDraining";
      return;
    }
    state.phase = "failed";
    this._retire(state, error, kill);
  }

  _recordExit(state, code, signal) {
    if (state.retired || state.finalized || state.exitInfo) return;
    state.exitInfo = { code, signal };
  }

  _finalizeClose(state, code, signal) {
    if (state.retired || state.finalized) return;
    state.finalized = true;
    const exitInfo = state.exitInfo || { code, signal };
    const wasStarting = state.phase === "starting";
    state.phase = "closed";
    const error = new Error(`Codex App Server exited with code ${exitInfo.code}`);
    if (wasStarting) state.rejectStart(error);
    this._retire(state, error, false);
    if (this._startPromise === state.promise) this._startPromise = null;
    this.emit("exit", exitInfo.code, exitInfo.signal);
  }

  _retire(state, error, kill) {
    if (state.retired) return state.shutdownPromise;
    state.retired = true;
    const shutdown = kill ? this._beginShutdown(state) : null;
    this._detachChildListeners(state);
    if (kill) this._installRetiredGuards(state);
    state.rpc?.close(error);
    for (const [event, listener] of state.rpcListeners) state.rpc?.off(event, listener);
    state.rpcListeners.length = 0;
    if (state.stderrListener) {
      state.child?.stderr?.off?.("data", state.stderrListener);
      state.stderrListener = null;
    }
    if (this.child === state.child) this.child = null;
    if (this.rpc === state.rpc) this.rpc = null;
    if (this._state === state) this._state = null;
    if (kill && state.child && !state.killCalled) {
      state.killCalled = true;
      try {
        state.child.kill();
      } catch (cause) {
        const stopError = new Error("Codex App Server termination failed", { cause });
        stopError.code = "APP_SERVER_STOP_FAILED";
        state.rejectShutdown?.(stopError);
      }
    }
    return shutdown;
  }

  _beginShutdown(state) {
    if (state.shutdownPromise) return state.shutdownPromise;
    const child = state.child;
    if (!child) return Promise.resolve();

    let settled = false;
    const promise = new Promise((resolve, reject) => {
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (state.shutdownForceTimer) this.clearTimer(state.shutdownForceTimer);
        if (state.shutdownFailureTimer) this.clearTimer(state.shutdownFailureTimer);
        if (state.shutdownCloseListener) child.off("close", state.shutdownCloseListener);
        state.shutdownForceTimer = null;
        state.shutdownFailureTimer = null;
        state.shutdownCloseListener = null;
        state.rejectShutdown = null;
        if (error) {
          this._blockedStopError = error;
          this._blockedStopState = state;
          reject(error);
        } else {
          if (this._blockedStopState === state) {
            this._blockedStopError = null;
            this._blockedStopState = null;
          }
          resolve();
        }
      };
      state.shutdownCloseListener = () => finish();
      state.rejectShutdown = (error) => finish(error);
      child.on("close", state.shutdownCloseListener);
      state.shutdownForceTimer = this.setTimer(() => {
        try {
          child.kill("SIGKILL");
        } catch (cause) {
          const stopError = new Error("Codex App Server forced termination failed", { cause });
          stopError.code = "APP_SERVER_STOP_FAILED";
          finish(stopError);
          return;
        }
        state.shutdownFailureTimer = this.setTimer(() => {
          const stopError = new Error("Codex App Server did not close after forced termination");
          stopError.code = "APP_SERVER_STOP_TIMEOUT";
          finish(stopError);
        }, this.stopForceMs);
        state.shutdownFailureTimer?.unref?.();
      }, this.stopGraceMs);
      state.shutdownForceTimer?.unref?.();
    });
    state.shutdownPromise = promise;
    this._shutdownPromise = promise;
    promise.catch(() => {});
    promise.then(
      () => { if (this._shutdownPromise === promise) this._shutdownPromise = null; },
      () => { if (this._shutdownPromise === promise) this._shutdownPromise = null; },
    );
    return promise;
  }

  _detachChildListeners(state) {
    if (!state.child) return;
    if (state.childErrorListener) state.child.off("error", state.childErrorListener);
    if (state.childExitListener) state.child.off("exit", state.childExitListener);
    if (state.childCloseListener) state.child.off("close", state.childCloseListener);
    state.childErrorListener = null;
    state.childExitListener = null;
    state.childCloseListener = null;
  }

  _installRetiredGuards(state) {
    const child = state.child;
    if (!child || state.safeErrorListener) return;

    const safeErrorListener = () => {};
    const retiredCloseListener = () => {
      child.off("error", safeErrorListener);
      child.off("close", retiredCloseListener);
      if (this._blockedStopState === state) {
        this._blockedStopError = null;
        this._blockedStopState = null;
      }
      if (state.safeErrorListener === safeErrorListener) state.safeErrorListener = null;
      if (state.retiredCloseListener === retiredCloseListener) state.retiredCloseListener = null;
    };
    state.safeErrorListener = safeErrorListener;
    state.retiredCloseListener = retiredCloseListener;
    child.on("error", safeErrorListener);
    child.on("close", retiredCloseListener);
  }
}
