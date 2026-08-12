import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { prepareRuntime } from "./bootstrap.js";
import { createRemoteServer } from "../src/remote-server.js";

const PACKAGE_NAME = "codex-remote-startup-benchmark";

function writeFixture(sourceDir) {
  fs.mkdirSync(path.join(sourceDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "package.json"), `${JSON.stringify({
    name: PACKAGE_NAME,
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {},
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(sourceDir, "package-lock.json"), `${JSON.stringify({
    name: PACKAGE_NAME,
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: PACKAGE_NAME, version: "1.0.0" },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(sourceDir, "server.js"), "export const fixture = true;\n");
  fs.writeFileSync(path.join(sourceDir, "src", "fixture.js"), "export default true;\n");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function benchmarkAdapter(gate) {
  const listeners = new Set();
  return {
    cwd: "C:\\benchmark-workspace",
    model: null,
    effort: null,
    threadId: null,
    queueLength: 0,
    appServerStatus: "restarting",
    async start() {
      await gate.promise;
      this.appServerStatus = "online";
    },
    async stop() { gate.resolve(); },
    subscribePhoneEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pendingApprovals() { return []; },
    async listThreads() { return { data: [], nextCursor: null }; },
  };
}

function withDeadline(value, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(value), timeout]).finally(() => clearTimeout(timer));
}

function positiveTimeout(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError(`${name} must be an integer from 1 to 60000`);
  }
  return value;
}

export async function benchmarkStartup({
  tempParent = os.tmpdir(),
  warmIterations = 5,
  log = console.log,
  serverTimeoutMs = 5_000,
  healthTimeoutMs = 2_000,
  cleanupTimeoutMs = 2_000,
  prepareRuntimeImpl = prepareRuntime,
  createRemoteServerImpl = createRemoteServer,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!Number.isInteger(warmIterations) || warmIterations < 1 || warmIterations > 100) {
    throw new TypeError("warmIterations must be an integer from 1 to 100");
  }
  positiveTimeout(serverTimeoutMs, "serverTimeoutMs");
  positiveTimeout(healthTimeoutMs, "healthTimeoutMs");
  positiveTimeout(cleanupTimeoutMs, "cleanupTimeoutMs");
  if (typeof prepareRuntimeImpl !== "function"
      || typeof createRemoteServerImpl !== "function"
      || typeof fetchImpl !== "function") {
    throw new TypeError("benchmark dependencies must be functions");
  }
  const ownedRoot = fs.mkdtempSync(path.join(path.resolve(tempParent), "codex-startup-benchmark-"));
  const sourceDir = path.join(ownedRoot, "source");
  const localAppData = path.join(ownedRoot, "local-app-data");
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  let remote = null;
  let serverStart = null;
  let remoteClosePromise = null;
  let cleanupStarted = false;
  const gate = deferred();
  const closeRemoteOnce = (candidate) => {
    if (!candidate) return Promise.resolve();
    remoteClosePromise ??= Promise.resolve().then(() => candidate.close?.());
    return remoteClosePromise;
  };
  try {
    writeFixture(sourceDir);
    prepareRuntimeImpl({ sourceDir, env });
    const emptyPath = path.join(ownedRoot, "empty-path");
    fs.mkdirSync(emptyPath);
    const warmEnv = { ...env, PATH: emptyPath, Path: emptyPath };

    const warmSamples = [];
    for (let index = 0; index < warmIterations; index += 1) {
      const startedAt = performance.now();
      prepareRuntimeImpl({ sourceDir, env: warmEnv });
      warmSamples.push(performance.now() - startedAt);
    }
    warmSamples.sort((left, right) => left - right);
    const warmPrepareMs = warmSamples[Math.floor(warmSamples.length / 2)];

    const adapter = benchmarkAdapter(gate);
    const httpStartedAt = performance.now();
    serverStart = Promise.resolve().then(() => createRemoteServerImpl({
      adapter,
      token: "benchmark-only-token",
      host: "127.0.0.1",
      port: 0,
      ownAdapter: true,
    }));
    // A late server is still consumed and closed after a timeout, preventing an
    // eventually-created listener from escaping benchmark ownership.
    void serverStart.then((lateRemote) => (
      cleanupStarted ? closeRemoteOnce(lateRemote) : undefined
    ), () => {}).catch(() => {});
    remote = await withDeadline(serverStart, serverTimeoutMs, "synthetic HTTP server startup");
    const httpReadyMs = performance.now() - httpStartedAt;
    const adapterPendingAtHttpReady = adapter.appServerStatus !== "online";
    const health = await withDeadline(
      fetchImpl(`${remote.httpUrl}/api/health`),
      healthTimeoutMs,
      "synthetic HTTP health check",
    );
    const healthStatus = health.status;
    if (!adapterPendingAtHttpReady || healthStatus !== 200) {
      throw new Error("HTTP was not healthy before the synthetic Codex adapter became ready.");
    }

    const result = {
      warmPrepareMs,
      warmCacheWithoutNpm: true,
      httpReadyMs,
      adapterPendingAtHttpReady,
      healthStatus,
    };
    log(`[startup-benchmark] Warm cache preparation median: ${warmPrepareMs.toFixed(2)} ms`);
    log("[startup-benchmark] Warm cache reused without npm on PATH: yes");
    log(`[startup-benchmark] HTTP health ready: ${httpReadyMs.toFixed(2)} ms`);
    log("[startup-benchmark] HTTP ready while Codex is still initializing: yes");
    return result;
  } finally {
    cleanupStarted = true;
    gate.resolve();
    if (!remote && serverStart) {
      try {
        remote = await withDeadline(serverStart, cleanupTimeoutMs, "late synthetic HTTP server cleanup");
      } catch {
        // The attached late-settlement handler remains responsible if it resolves later.
      }
    }
    if (remote) {
      await withDeadline(
        closeRemoteOnce(remote),
        cleanupTimeoutMs,
        "synthetic HTTP server cleanup",
      ).catch(() => {});
    }
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
}

const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  benchmarkStartup().catch((error) => {
    console.error(`[startup-benchmark] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
