import test from "node:test";
import assert from "node:assert/strict";
import { createPanelSession } from "../src/panel-session.js";

test("panel capability is 256-bit, fragment-only, and state is token-free", async () => {
  const calls = [];
  const connectionModes = [];
  const session = createPanelSession({
    randomBytes: (size) => { calls.push(size); return Buffer.alloc(size, 7); },
    now: () => 1_000,
    stateProvider: () => ({
      serviceStatus: "online", lanOrigin: "http://192.168.1.2:8766", tunnelOrigin: null,
      codexStatus: "logged-in", appServerStatus: "online", threadDisplayId: "thread-1",
      workspace: "C:\\work", tools: { ffmpeg: true }, diagnostics: ["GET /?token=secret-value"],
      token: "must-not-leak",
    }),
    connectionProvider: async (mode) => {
      connectionModes.push(mode);
      return "https://remote.example/?token=phone-secret";
    },
    qrToDataUrl: async (url) => `data:image/png;base64,${Buffer.from(url).toString("base64")}`,
  });
  assert.deepEqual(calls, [32]);
  assert.equal(session.key.length, 43);
  assert.match(session.panelUrl("http://127.0.0.1:8766"), /^http:\/\/127\.0\.0\.1:8766\/panel\.html#panel=/);
  assert.equal(session.panelUrl("http://127.0.0.1:8766").includes("?panel="), false);
  assert.equal(session.authorize(session.key), true);
  assert.equal(session.authorize(`${session.key}x`), false);
  assert.equal(JSON.stringify(session.state()).includes("must-not-leak"), false);
  assert.match(session.state().diagnostics[0], /token=\[redacted\]/);
  const connection = await session.createConnection();
  assert.deepEqual(connectionModes, ["remote"]);
  assert.equal(connection.copyUrl, "https://remote.example/?token=phone-secret");
  assert.equal(connection.displayUrl, "https://remote.example/?token=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2");
  assert.equal(connection.expiresAt, 301_000);
});

test("connection creation accepts only exact remote and lan modes before calling the provider", async () => {
  const connectionModes = [];
  const session = createPanelSession({
    randomBytes: () => Buffer.alloc(32, 2),
    connectionProvider: async (mode) => {
      connectionModes.push(mode);
      return `https://${mode}.example/?token=phone-secret`;
    },
    qrToDataUrl: async () => null,
  });

  assert.equal((await session.createConnection("remote")).copyUrl, "https://remote.example/?token=phone-secret");
  assert.equal((await session.createConnection("lan")).copyUrl, "https://lan.example/?token=phone-secret");
  assert.deepEqual(connectionModes, ["remote", "lan"]);

  for (const mode of [null, "REMOTE", " remote", "remote ", {}, [], "", 0]) {
    await assert.rejects(session.createConnection(mode), (error) => {
      assert.equal(error.code, "PANEL_CONNECTION_MODE");
      return true;
    });
  }
  assert.deepEqual(connectionModes, ["remote", "lan"]);
});

test("QR failure remains copyable and redacts the renderer error", async () => {
  const session = createPanelSession({
    randomBytes: () => Buffer.alloc(32, 9), now: () => 10,
    stateProvider: () => ({}),
    connectionProvider: async () => "https://remote.example/?token=phone-secret",
    qrToDataUrl: async () => { throw new Error("renderer phone-secret failed"); },
  });
  const result = await session.createConnection();
  assert.equal(result.qrDataUrl, null);
  assert.equal(result.qrError.includes("phone-secret"), false);
  assert.equal(result.copyUrl.includes("phone-secret"), true);
});

test("panel state exposes only the public allowlist and bounds diagnostics", () => {
  const session = createPanelSession({
    randomBytes: () => Buffer.alloc(32, 1),
    stateProvider: () => ({
      workspace: "D:\\repo", internalPath: "D:\\private", diagnostics: Array.from({ length: 25 }, (_, i) => `${i}:${"x".repeat(600)}`),
    }),
    connectionProvider: async () => "http://127.0.0.1/?token=x",
    qrToDataUrl: async () => null,
  });
  const state = session.state();
  assert.equal("internalPath" in state, false);
  assert.equal(state.diagnostics.length, 20);
  assert.equal(state.diagnostics.every((line) => line.length <= 500), true);
});
