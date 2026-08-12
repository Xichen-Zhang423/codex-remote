import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { benchmarkStartup } from "../scripts/benchmark-startup.mjs";

test("startup benchmark proves HTTP-first behavior and cleans its isolated fixture", {
  timeout: 30_000,
}, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-benchmark-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const lines = [];

  const result = await benchmarkStartup({
    tempParent: parent,
    warmIterations: 1,
    log: (line) => lines.push(String(line)),
  });

  assert.equal(result.adapterPendingAtHttpReady, true);
  assert.equal(result.warmCacheWithoutNpm, true);
  assert.equal(result.healthStatus, 200);
  assert.ok(Number.isFinite(result.warmPrepareMs) && result.warmPrepareMs >= 0);
  assert.ok(Number.isFinite(result.httpReadyMs) && result.httpReadyMs >= 0);
  assert.deepEqual(fs.readdirSync(parent), []);
  assert.match(lines.join("\n"), /HTTP ready while Codex is still initializing: yes/);
  assert.match(lines.join("\n"), /Warm cache reused without npm on PATH: yes/);
  assert.doesNotMatch(lines.join("\n"), /benchmark-only-token|#panel=|\?token=/i);
});

test("startup benchmark times out a stuck server and removes its owned fixture", {
  timeout: 5_000,
}, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-benchmark-stuck-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  await assert.rejects(benchmarkStartup({
    tempParent: parent,
    warmIterations: 1,
    serverTimeoutMs: 25,
    cleanupTimeoutMs: 25,
    prepareRuntimeImpl: () => ({}),
    createRemoteServerImpl: () => new Promise(() => {}),
    log: () => {},
  }), /synthetic HTTP server startup timed out/i);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("startup benchmark bounds a stuck health check and closes the server once", {
  timeout: 5_000,
}, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-benchmark-health-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let closes = 0;

  await assert.rejects(benchmarkStartup({
    tempParent: parent,
    warmIterations: 1,
    healthTimeoutMs: 25,
    cleanupTimeoutMs: 25,
    prepareRuntimeImpl: () => ({}),
    createRemoteServerImpl: async () => ({
      httpUrl: "http://127.0.0.1:1",
      async close() { closes += 1; },
    }),
    fetchImpl: () => new Promise(() => {}),
    log: () => {},
  }), /synthetic HTTP health check timed out/i);
  assert.equal(closes, 1);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("startup benchmark consumes a server that resolves during timeout cleanup exactly once", {
  timeout: 5_000,
}, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-benchmark-late-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let closes = 0;

  await assert.rejects(benchmarkStartup({
    tempParent: parent,
    warmIterations: 1,
    serverTimeoutMs: 10,
    cleanupTimeoutMs: 100,
    prepareRuntimeImpl: () => ({}),
    createRemoteServerImpl: () => new Promise((resolve) => setTimeout(() => resolve({
      httpUrl: "http://127.0.0.1:1",
      async close() { closes += 1; },
    }), 25)),
    log: () => {},
  }), /synthetic HTTP server startup timed out/i);
  assert.equal(closes, 1);
  assert.deepEqual(fs.readdirSync(parent), []);
});
