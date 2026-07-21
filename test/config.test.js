import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.js";

function waitForFiles(files, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (files.every((file) => fs.existsSync(file))) return resolve();
      if (Date.now() >= deadline) return reject(new Error("Timed out waiting for config workers"));
      setTimeout(check, 10);
    };
    check();
  });
}

function configWorker({ file, ready, go }) {
  const moduleUrl = pathToFileURL(path.resolve("src/config.js")).href;
  const script = [
    'import fs from "node:fs";',
    `import { loadConfig } from ${JSON.stringify(moduleUrl)};`,
    'fs.writeFileSync(process.env.READY_FILE, "ready");',
    'const waiter = new Int32Array(new SharedArrayBuffer(4));',
    'while (!fs.existsSync(process.env.GO_FILE)) Atomics.wait(waiter, 0, 0, 5);',
    'console.log(loadConfig({ file: process.env.CONFIG_FILE, env: {} }).token);',
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, CONFIG_FILE: file, READY_FILE: ready, GO_FILE: go },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

test("loadConfig uses an isolated port and never persists auto approval", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-config-"));
  const file = path.join(dir, "config.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      port: 8766,
      token: "saved-token",
      autoApprove: true,
      sessionAutoApprove: true,
    }));
    const cfg = loadConfig({ file, env: {} });
    const serialized = JSON.parse(fs.readFileSync(file, "utf8"));

    assert.equal(cfg.port, 8766);
    assert.equal(cfg.sessionAutoApprove, false);
    assert.equal("autoApprove" in cfg.persisted, false);
    assert.equal("sessionAutoApprove" in cfg.persisted, false);
    assert.equal("autoApprove" in serialized, false);
    assert.equal("sessionAutoApprove" in serialized, false);
    assert.match(serialized.rendezvous.deviceId, /^[a-f0-9]{32}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent first runs all use the same atomically published config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-config-race-"));
  const file = path.join(dir, "config.json");
  const go = path.join(dir, "go");
  const readyFiles = Array.from({ length: 12 }, (_, index) => path.join(dir, `ready-${index}`));
  try {
    const workers = readyFiles.map((ready) => configWorker({ file, ready, go }));
    await waitForFiles(readyFiles);
    fs.writeFileSync(go, "go");
    const results = await Promise.all(workers);
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const tokens = results.map((result) => result.stdout.trim());
    assert.equal(new Set(tokens).size, 1, `workers returned different tokens: ${tokens.join(", ")}`);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, tokens[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex Remote environment variables override persisted values", () => {
  const cfg = loadConfig({
    file: "unused.json",
    env: {
      CODEX_REMOTE_PORT: "9010",
      CODEX_CWD: "D:\\work",
      CODEX_MODEL: "gpt-test",
      CODEX_REMOTE_RENDEZVOUS_URL: "https://rendezvous.example/",
      CODEX_REMOTE_RENDEZVOUS_SECRET: "publish-secret",
      CODEX_REMOTE_DEVICE_ID: "device-test-123",
    },
    read: () => ({ port: 8000, cwd: "C:\\old" }),
    write: false,
  });
  assert.equal(cfg.port, 9010);
  assert.equal(cfg.cwd, "D:\\work");
  assert.equal(cfg.model, "gpt-test");
  assert.deepEqual(cfg.rendezvous, {
    url: "https://rendezvous.example",
    secret: "publish-secret",
    deviceId: "device-test-123",
  });
});

test("environment overrides stay transient and are not written into config.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-env-"));
  const file = path.join(dir, "config.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      port: 8766,
      token: "saved-token",
      cwd: "C:\\saved",
      rendezvous: {
        url: "https://saved.example",
        secret: "saved-secret",
        deviceId: "saved-device-01",
      },
    }));
    const cfg = loadConfig({
      file,
      env: {
        CODEX_REMOTE_PORT: "9010",
        CODEX_REMOTE_TOKEN: "environment-token",
        CODEX_CWD: "D:\\runtime",
        CODEX_REMOTE_RENDEZVOUS_URL: "https://runtime.example",
        CODEX_REMOTE_RENDEZVOUS_SECRET: "runtime-secret",
      },
    });
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(cfg.port, 9010);
    assert.equal(cfg.token, "environment-token");
    assert.equal(cfg.rendezvous.secret, "runtime-secret");
    assert.equal(saved.port, 8766);
    assert.equal(saved.token, "saved-token");
    assert.equal(saved.cwd, "C:\\saved");
    assert.equal(saved.rendezvous.url, "https://saved.example");
    assert.equal(saved.rendezvous.secret, "saved-secret");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid environment ports", () => {
  for (const port of ["0", "65536", "12.5", "not-a-port"]) {
    assert.throws(
      () => loadConfig({ env: { CODEX_REMOTE_PORT: port }, read: () => ({}), write: false }),
      /port must be an integer between 1 and 65535/,
    );
  }
});

test("loadConfig rejects invalid saved ports", () => {
  for (const port of [0, 65536, 12.5, "not-a-port"]) {
    assert.throws(
      () => loadConfig({ env: {}, read: () => ({ port }), write: false }),
      /port must be an integer between 1 and 65535/,
    );
  }
});

test("loadConfig accepts both port boundaries", () => {
  for (const port of ["1", "65535"]) {
    const cfg = loadConfig({ env: { CODEX_REMOTE_PORT: port }, read: () => ({}), write: false });
    assert.equal(cfg.port, Number(port));
  }
});

test("loadConfig warns before replacing malformed JSON values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-malformed-"));
  const file = path.join(dir, "config.json");
  const warnings = [];
  let contentsDuringWarning;
  try {
    fs.writeFileSync(file, "{ malformed json", "utf8");
    loadConfig({
      file,
      env: {},
      warn: (message) => {
        warnings.push(message);
        contentsDuringWarning = fs.readFileSync(file, "utf8");
      },
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not parse config file/);
    assert.equal(contentsDuringWarning, "{ malformed json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rendezvous settings reject unsafe URLs and invalid device IDs", () => {
  assert.throws(() => loadConfig({
    env: { CODEX_REMOTE_RENDEZVOUS_URL: "http://attacker.example" }, read: () => ({}), write: false,
  }), /must use https/);
  assert.throws(() => loadConfig({
    env: { CODEX_REMOTE_DEVICE_ID: "bad/id" }, read: () => ({}), write: false,
  }), /device ID/);
  assert.throws(() => loadConfig({
    env: { CODEX_REMOTE_DEVICE_ID: "a".repeat(65) }, read: () => ({}), write: false,
  }), /device ID/);
});
