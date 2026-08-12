import test from "node:test";
import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import http from "node:http";
import WebSocket from "ws";
import { createRemoteServer, TRANSCRIPT_TYPES } from "../src/remote-server.js";

function prepareJsonQueue(ws) {
  if (ws.nextJsonMessage) return;
  const queued = [];
  const waiters = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queued.push(message);
  });
  ws.on("close", () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("socket closed"));
  });
  ws.nextJsonMessage = () => {
    if (queued.length) return Promise.resolve(queued.shift());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
}

async function nextJson(ws) {
  prepareJsonQueue(ws);
  return ws.nextJsonMessage();
}

async function nextJsonWithin(ws, label = "socket message") {
  let timer;
  try {
    return await Promise.race([
      nextJson(ws),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function openPhone(remote, token = remote.token) {
  const ws = new WebSocket(`${remote.wsUrl}/ws?token=${encodeURIComponent(token)}`);
  prepareJsonQueue(ws);
  await once(ws, "open");
  return ws;
}

async function readInitialization(ws) {
  const messages = [];
  while (messages.length < 10) {
    const message = await nextJson(ws);
    messages.push(message);
    if (message.type === "permission_request") return messages;
  }
  throw new Error("initialization did not reach pending approvals");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label = "condition") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

class FakeAdapter extends EventEmitter {
  constructor() {
    super();
    this.cwd = "D:\\repo";
    this.model = "gpt-test";
    this.effort = "high";
    this.threadId = "thr-current";
    this.queueLength = 0;
    this.calls = [];
    this.started = 0;
    this.stopped = 0;
    this.sessionAuto = false;
    this.appServerStatus = "online";
    this.restartAttempts = 0;
    this.retryInMs = 0;
    this.pending = [{ type: "permission_request", id: "approval-1", kind: "command" }];
  }
  subscribePhoneEvents(listener) {
    this.on("phoneEvent", listener);
    return () => this.off("phoneEvent", listener);
  }
  emitPhone(event) { this.emit("phoneEvent", event); }
  async start() { this.started += 1; }
  async stop() { this.stopped += 1; }
  pendingApprovals() { return this.pending; }
  async listThreads(params) {
    this.calls.push(["listThreads", params]);
    return { data: [{ id: "thr-current", name: "Current", cwd: this.cwd }], nextCursor: null };
  }
  async readThread(id, options) {
    this.calls.push(["readThread", id, options]);
    return {
      thread: { id, cwd: this.cwd },
      events: options?.includeTurns === false ? [] : [{ type: "assistant", text: `history:${id}` }],
    };
  }
  async resumeThread(id, options) {
    this.calls.push(["resumeThread", id, options]);
    this.threadId = id;
    if (options?.cwd) this.cwd = options.cwd;
    return { thread: { id, cwd: this.cwd }, events: [{ type: "assistant", text: `history:${id}` }] };
  }
  async newThread(value) { this.calls.push(["newThread", value]); this.threadId = "thr-new"; return { thread: { id: "thr-new" } }; }
  async renameThread(id, name) { this.calls.push(["renameThread", id, name]); }
  async archiveThread(id) { this.calls.push(["archiveThread", id]); }
  async listModels(value) { this.calls.push(["listModels", value]); return { data: [{ id: "gpt-test" }] }; }
  sendPrompt(value) { this.calls.push(["sendPrompt", value]); return Promise.resolve({ id: "turn-1", status: "completed" }); }
  async interrupt() { this.calls.push(["interrupt"]); return true; }
  async decideApproval(id, action, payload) { this.calls.push(["decideApproval", id, action, payload]); return true; }
  setSessionAuto(value) { this.calls.push(["setSessionAuto", value]); this.sessionAuto = value === true; return this.sessionAuto; }
  setCwd(value) { this.calls.push(["setCwd", value]); this.cwd = value; return value; }
  setModel(value) { this.calls.push(["setModel", value]); this.model = value || null; return this.model; }
  setEffort(value) { this.calls.push(["setEffort", value]); this.effort = value || null; return this.effort; }
}

async function startTestServer(options = {}) {
  const adapter = options.adapter ?? new FakeAdapter();
  const remote = await createRemoteServer({
    adapter,
    token: options.token ?? "secret-token",
    host: "127.0.0.1",
    port: 0,
    initialHistory: options.history ?? [],
    historyLimit: options.historyLimit ?? 400,
    publicDir: options.publicDir,
    windowsRemote: options.windowsRemote,
    panelSession: options.panelSession,
    artifactStore: options.artifactStore,
    artifactTracker: options.artifactTracker,
    artifactTickets: options.artifactTickets,
    ownAdapter: true,
    onError: options.onError,
  });
  return { ...remote, adapter };
}

test("panel routes require their own capability and emit one confirmed shutdown", async () => {
  const panelState = {
    serviceStatus: "online", uptimeMs: 1_000, lanOrigin: "http://192.168.1.2:8766",
    tunnelOrigin: null, codexStatus: "logged-in", appServerStatus: "online",
    threadDisplayId: "thr-current", workspace: "D:\\repo",
    tools: { ffmpeg: true, cloudflared: false }, diagnostics: [],
  };
  const connection = {
    displayUrl: "https://remote.invalid/connect", copyUrl: "https://remote.invalid/connect",
    qrDataUrl: null, qrError: null, expiresAt: 301_000,
  };
  let stateCalls = 0;
  let connectionCalls = 0;
  const panelSession = {
    authorize: (value) => value === "panel-key",
    state() { stateCalls += 1; return panelState; },
    async createConnection() { connectionCalls += 1; return connection; },
  };
  const remote = await startTestServer({ panelSession });
  let shutdownCount = 0;
  const onShutdown = () => { shutdownCount += 1; };
  remote.instance.on("shutdownRequested", onShutdown);
  try {
    const malformedUnauthorized = await fetch(`${remote.httpUrl}/api/panel/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{malformed",
    });
    assert.equal(malformedUnauthorized.status, 401);
    assert.equal(malformedUnauthorized.headers.get("cache-control"), "no-store");
    assert.match(malformedUnauthorized.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await malformedUnauthorized.json(), { error: "unauthorized" });

    const protectedRequests = [
      { path: "/api/panel/state", options: {} },
      { path: "/api/panel/connection", options: { method: "POST" } },
      { path: "/api/panel/stop", options: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "STOP" }) } },
    ];
    const phoneBearer = ["Bearer", "phone-token-must-not-authorize-panel"].join(" ");
    for (const accessHeaders of [{}, { Authorization: phoneBearer }, { "X-Codex-Panel-Key": "wrong-panel-key" }]) {
      for (const request of protectedRequests) {
        const response = await fetch(`${remote.httpUrl}${request.path}`, { ...request.options, headers: { ...(request.options.headers || {}), ...accessHeaders } });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), { error: "unauthorized" });
      }
    }
    assert.equal(stateCalls, 0); assert.equal(connectionCalls, 0); assert.equal(shutdownCount, 0);
    const headers = { "X-Codex-Panel-Key": "panel-key" };
    const malformedAuthorized = await fetch(`${remote.httpUrl}/api/panel/stop`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{malformed",
    });
    assert.equal(malformedAuthorized.status, 400);
    assert.equal(malformedAuthorized.headers.get("cache-control"), "no-store");
    assert.match(malformedAuthorized.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await malformedAuthorized.json(), { error: "invalid JSON" });

    const stateResponse = await fetch(`${remote.httpUrl}/api/panel/state`, { headers });
    assert.equal(stateResponse.status, 200); assert.deepEqual(await stateResponse.json(), panelState);
    assert.equal(stateCalls, 1);
    const connectionResponse = await fetch(`${remote.httpUrl}/api/panel/connection`, { method: "POST", headers });
    assert.equal(connectionResponse.status, 200); assert.deepEqual(await connectionResponse.json(), connection);
    assert.equal(connectionCalls, 1);
    const rejected = await fetch(`${remote.httpUrl}/api/panel/stop`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ confirm: "NO" }) });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "confirmation required" });
    assert.equal(shutdownCount, 0);
    const accepted = await fetch(`${remote.httpUrl}/api/panel/stop`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ confirm: "STOP" }) });
    assert.equal(accepted.status, 202); assert.deepEqual(await accepted.json(), { ok: true });
    await waitFor(() => shutdownCount === 1, "one panel shutdown request");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownCount, 1);
  } finally {
    remote.off("shutdownRequested", onShutdown);
    await remote.close();
  }
});

test("panel connection authenticates before bounded JSON parsing and validates modes before provider calls", async () => {
  const connectionModes = [];
  const connection = {
    displayUrl: "https://remote.invalid/connect", copyUrl: "https://remote.invalid/connect",
    qrDataUrl: null, qrError: null, expiresAt: 301_000,
  };
  const panelSession = {
    authorize: (value) => value === "panel-key",
    state: () => ({}),
    async createConnection(mode) { connectionModes.push(mode); return connection; },
  };
  const remote = await startTestServer({ panelSession });
  const authorized = { "X-Codex-Panel-Key": "panel-key" };
  const postJson = (value, headers = authorized) => fetch(`${remote.httpUrl}/api/panel/connection`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  try {
    const malformedUnauthorized = await postJson("{malformed", {});
    assert.equal(malformedUnauthorized.status, 401);
    assert.deepEqual(await malformedUnauthorized.json(), { error: "unauthorized" });
    assert.equal(connectionModes.length, 0);

    const noBody = await fetch(`${remote.httpUrl}/api/panel/connection`, {
      method: "POST", headers: authorized,
    });
    assert.equal(noBody.status, 200);
    assert.deepEqual(await noBody.json(), connection);

    const emptyObject = await postJson({});
    assert.equal(emptyObject.status, 200);
    assert.deepEqual(await emptyObject.json(), connection);

    const lan = await postJson({ mode: "lan" });
    assert.equal(lan.status, 200);
    assert.deepEqual(await lan.json(), connection);
    assert.deepEqual(connectionModes, ["remote", "remote", "lan"]);

    const malformedAuthorized = await postJson("{malformed");
    assert.equal(malformedAuthorized.status, 400);
    assert.deepEqual(await malformedAuthorized.json(), { error: "invalid JSON" });
    assert.equal(connectionModes.length, 3);

    for (const body of [
      { mode: null }, { mode: "REMOTE" }, { mode: " lan" }, { mode: "lan " }, { mode: {} }, [],
    ]) {
      const response = await postJson(body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "invalid connection mode", code: "PANEL_CONNECTION_MODE",
      });
      assert.equal(connectionModes.length, 3);
    }

    const oversized = await postJson({ padding: "x".repeat(1_100) });
    assert.equal(oversized.status, 413);
    assert.match(oversized.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await oversized.json(), { error: "request body too large" });
    assert.equal(connectionModes.length, 3);
  } finally {
    await remote.close();
  }
});

test("panel connection rejects non-empty non-JSON media without invoking the provider", async () => {
  const connectionModes = [];
  const connection = {
    displayUrl: "https://remote.invalid/connect", copyUrl: "https://remote.invalid/connect",
    qrDataUrl: null, qrError: null, expiresAt: 301_000,
  };
  const panelSession = {
    authorize: (value) => value === "panel-key",
    state: () => ({}),
    async createConnection(mode) { connectionModes.push(mode); return connection; },
  };
  const remote = await startTestServer({ panelSession });
  const panelHeaders = { "X-Codex-Panel-Key": "panel-key" };
  try {
    const unauthorized = await fetch(`${remote.httpUrl}/api/panel/connection`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: "not json",
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
    assert.equal(connectionModes.length, 0);

    const text = await fetch(`${remote.httpUrl}/api/panel/connection`, {
      method: "POST",
      headers: { ...panelHeaders, "content-type": "text/plain" },
      body: "not json",
    });
    assert.equal(text.status, 415);
    assert.deepEqual(await text.json(), { error: "application/json required" });
    assert.equal(connectionModes.length, 0);

    const chunked = await new Promise((resolve, reject) => {
      const request = http.request(`${remote.httpUrl}/api/panel/connection`, {
        method: "POST",
        headers: { ...panelHeaders, "content-type": "application/octet-stream" },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      request.on("error", reject);
      request.write(Buffer.from([0, 1, 2, 3]));
      request.end();
    });
    assert.equal(chunked.status, 415);
    assert.deepEqual(chunked.body, { error: "application/json required" });
    assert.equal(connectionModes.length, 0);

    const legacy = await fetch(`${remote.httpUrl}/api/panel/connection`, {
      method: "POST", headers: panelHeaders,
    });
    assert.equal(legacy.status, 200);
    assert.deepEqual(await legacy.json(), connection);
    assert.deepEqual(connectionModes, ["remote"]);
  } finally {
    await remote.close();
  }
});

test("panel connection maps expected availability errors without reporting them", async () => {
  const reported = [];
  const connectionModes = [];
  let providerError;
  const panelSession = {
    authorize: (value) => value === "panel-key",
    state: () => ({}),
    async createConnection(mode) {
      connectionModes.push(mode);
      throw providerError;
    },
  };
  const remote = await startTestServer({ panelSession, onError: (error) => reported.push(error) });
  const request = (mode) => fetch(`${remote.httpUrl}/api/panel/connection`, {
    method: "POST",
    headers: { "X-Codex-Panel-Key": "panel-key", "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  try {
    const expected = [
      {
        mode: "remote", code: "PANEL_CONNECTION_MODE", status: 400,
        body: { error: "invalid connection mode", code: "PANEL_CONNECTION_MODE" },
      },
      {
        mode: "remote", code: "PUBLIC_CONNECTION_NOT_READY", status: 503,
        body: { error: "public connection not ready", code: "PUBLIC_CONNECTION_NOT_READY" },
      },
      {
        mode: "lan", code: "LAN_CONNECTION_NOT_READY", status: 503,
        body: { error: "LAN connection not ready", code: "LAN_CONNECTION_NOT_READY" },
      },
    ];
    for (const testCase of expected) {
      providerError = Object.assign(new Error(`private ${testCase.code} detail`), { code: testCase.code });
      const response = await request(testCase.mode);
      assert.equal(response.status, testCase.status);
      assert.deepEqual(await response.json(), testCase.body);
      assert.equal(reported.length, 0);
    }

    providerError = new Error("private provider failure");
    const unavailable = await request("remote");
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "connection unavailable" });
    assert.deepEqual(reported, [providerError]);
    assert.deepEqual(connectionModes, ["remote", "remote", "lan", "remote"]);
  } finally {
    await remote.close();
  }
});

function artifactServices() {
  const record = {
    id: "art-1", revision: 1, threadId: "thr-current", turnId: "turn-1",
    relativePath: "out/report.txt", displayName: "report.txt", kind: "created",
    provenance: ["snapshot"], mime: "text/plain; charset=utf-8", size: 5,
    sha256: "abc123", state: "ready", detectedAt: 1,
  };
  const listeners = new Set();
  const releases = [];
  const revoked = [];
  const issued = [];
  const store = {
    snapshot(threadId) {
      return { revision: threadId === record.threadId ? 1 : 0,
        records: threadId === record.threadId ? [record] : [], complete: true, diagnostics: [] };
    },
    get(id) { return id === record.id ? { ...record } : null; },
    async pin(id) {
      if (id !== record.id) throw new Error("missing artifact");
      let released = false;
      return {
        record: { ...record },
        release: () => { if (!released) { released = true; releases.push(id); } },
      };
    },
    async openContent(id) {
      if (id !== record.id) throw new Error("missing artifact");
      const file = path.join(os.tmpdir(), `codex-remote-${process.pid}-artifact.txt`);
      fs.writeFileSync(file, "hello");
      return {
        record: { ...record },
        path: file,
        size: 5,
        createReadStream: ({ start, end }) => createReadStream(file, { start, end }),
        release() { fs.rmSync(file, { force: true }); },
      };
    },
  };
  const tracker = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of listeners) listener(event); },
  };
  const grants = new Map();
  const tickets = {
    issue(input) {
      if (typeof input.release !== "function") throw new TypeError("release must be a function");
      issued.push(input);
      const token = `ticket-${issued.length}`;
      grants.set(token, input);
      return { token, expiresAt: 60_000 };
    },
    consume(token, expected) {
      const grant = grants.get(token);
      if (!grant || grant.artifactId !== expected.artifactId || grant.sha256 !== expected.sha256) return null;
      return { purpose: grant.purpose, sessionId: grant.sessionId, expiresAt: 60_000 };
    },
    revokeSession(sessionId) {
      revoked.push(sessionId);
      for (const [token, grant] of grants) {
        if (grant.sessionId === sessionId) { grants.delete(token); grant.release(); }
      }
    },
  };
  return { store, tracker, tickets, record, releases, revoked, issued };
}

test("advertises artifacts only when every artifact service is configured", async () => {
  const services = artifactServices();
  const plain = await startTestServer();
  const partial = await startTestServer({ artifactStore: services.store, artifactTracker: services.tracker });
  const enabled = await startTestServer({
    artifactStore: services.store, artifactTracker: services.tracker, artifactTickets: services.tickets,
  });
  const sockets = [];
  try {
    for (const remote of [plain, partial, enabled]) {
      const ws = await openPhone(remote);
      sockets.push(ws);
      const hello = await nextJson(ws);
      assert.equal(hello.capabilities.includes("artifacts"), remote === enabled);
    }
  } finally {
    for (const ws of sockets) ws.close();
    await Promise.all([plain.close(), partial.close(), enabled.close()]);
  }
});

test("artifact transcript types remain outside conversation history", () => {
  for (const type of ["artifact_snapshot", "artifact_update", "artifact_access", "artifact_error"]) {
    assert.equal(TRANSCRIPT_TYPES.has(type), false);
  }
});

test("lists only the active thread artifacts with exact request correlation", async () => {
  const services = artifactServices();
  const remote = await startTestServer({
    artifactStore: services.store, artifactTracker: services.tracker, artifactTickets: services.tickets,
  });
  let ws;
  try {
    ws = await openPhone(remote);
    const initial = await readInitialization(ws);
    const boot = initial.find((message) => message.type === "artifact_snapshot");
    assert.equal(boot.requestId, null);
    assert.equal(boot.threadId, "thr-current");

    ws.send(JSON.stringify({ type: "listArtifacts", requestId: "req-1", threadId: "thr-current" }));
    assert.deepEqual(await nextJson(ws), {
      type: "artifact_snapshot", requestId: "req-1", threadId: "thr-current",
      revision: 1, records: [services.record], complete: true, diagnostics: [],
    });

    ws.send(JSON.stringify({ type: "listArtifacts", requestId: "req-old", threadId: "thr-other" }));
    assert.deepEqual(await nextJson(ws), {
      type: "artifact_error", requestId: "req-old", artifactId: null,
      code: "artifact_thread_unavailable", message: "The requested task is not currently available.",
    });
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("broadcasts artifact updates without adding them to transcript history", async () => {
  const services = artifactServices();
  const remote = await startTestServer({
    artifactStore: services.store, artifactTracker: services.tracker, artifactTickets: services.tickets,
  });
  let first;
  let second;
  try {
    first = await openPhone(remote);
    await readInitialization(first);
    const update = {
      type: "artifact_update", threadId: "thr-current", turnId: "turn-1", revision: 2,
      records: [services.record], complete: true, diagnostics: [],
    };
    services.tracker.emit({
      ...update,
      threadId: "thr-stale",
      records: [{ ...services.record, threadId: "thr-stale", relativePath: "private/secret.txt" }],
    });
    services.tracker.emit(update);
    assert.deepEqual(await nextJson(first), update);
    first.close();
    await once(first, "close");

    second = await openPhone(remote);
    assert.equal((await nextJson(second)).type, "hello");
    assert.equal((await nextJson(second)).type, "system_init");
    const history = await nextJson(second);
    assert.equal(history.type, "history");
    assert.equal(history.events.some((event) => event.type.startsWith("artifact_")), false);
  } finally {
    first?.terminate();
    second?.close();
    await remote.close();
  }
});

test("publishes the first auto-created thread before its events", async () => {
  const adapter = new FakeAdapter();
  adapter.threadId = null;
  const remote = await startTestServer({ adapter });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    adapter.threadId = "thr-first";
    adapter.emitPhone({ type: "turn_started", threadId: "thr-first", turnId: "turn-first" });
    const system = await nextJson(ws);
    const started = await nextJson(ws);
    assert.equal(system.type, "system_init");
    assert.equal(system.threadId, "thr-first");
    assert.deepEqual(started, { type: "turn_started", threadId: "thr-first", turnId: "turn-first" });
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("creates purpose-bound socket tickets and serves content without bearer credentials or raw paths", async () => {
  const services = artifactServices();
  const remote = await startTestServer({
    artifactStore: services.store, artifactTracker: services.tracker, artifactTickets: services.tickets,
  });
  let ws;
  try {
    ws = await openPhone(remote);
    await readInitialization(ws);
    ws.send(JSON.stringify({
      type: "createArtifactTicket", requestId: "req-ticket", artifactId: "art-1",
      purpose: "preview", path: "C:\\secret\\report.txt",
    }));
    const access = await nextJson(ws);
    assert.deepEqual({ ...access, url: undefined }, {
      type: "artifact_access", requestId: "req-ticket", artifactId: "art-1",
      purpose: "preview", expiresAt: 60_000, url: undefined,
    });
    assert.match(access.url, /^\/api\/artifacts\/art-1\/content\?ticket=ticket-1$/);
    assert.doesNotMatch(access.url, /secret|report\.txt/i);
    assert.deepEqual(Object.keys(services.issued[0]).sort(),
      ["artifactId", "purpose", "release", "sessionId", "sha256"].sort());

    const response = await fetch(`${remote.httpUrl}${access.url}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "hello");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("returns stable artifact errors without revealing other tasks", async () => {
  const services = artifactServices();
  const remote = await startTestServer({
    artifactStore: services.store, artifactTracker: services.tracker, artifactTickets: services.tickets,
  });
  let ws;
  try {
    ws = await openPhone(remote);
    await readInitialization(ws);
    for (const message of [
      { type: "createArtifactTicket", requestId: "bad-purpose", artifactId: "art-1", purpose: "open" },
      { type: "createArtifactTicket", requestId: "missing", artifactId: "other-thread-secret", purpose: "download" },
    ]) {
      ws.send(JSON.stringify(message));
      const reply = await nextJson(ws);
      assert.deepEqual(reply, {
        type: "artifact_error", requestId: message.requestId, artifactId: message.artifactId,
        code: "artifact_unavailable", message: "This artifact is not currently available.",
      });
      assert.doesNotMatch(reply.message, /thread|path|secret/i);
    }
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("revokes outstanding artifact tickets when the socket closes", async () => {
  const services = artifactServices();
  const remote = await startTestServer({
    artifactStore: services.store, artifactTracker: services.tracker, artifactTickets: services.tickets,
  });
  let ws;
  try {
    ws = await openPhone(remote);
    await readInitialization(ws);
    ws.send(JSON.stringify({
      type: "createArtifactTicket", requestId: "req-close", artifactId: "art-1", purpose: "download",
    }));
    await nextJson(ws);
    ws.close();
    await once(ws, "close");
    await waitFor(() => services.revoked.length === 1, "ticket revocation");
    assert.equal(services.revoked[0], services.issued[0].sessionId);
    assert.deepEqual(services.releases, ["art-1"]);
  } finally {
    ws?.terminate();
    await remote.close();
  }
});

test("a socket closed during an awaited pin cannot leave a late ticket or pin", async () => {
  const services = artifactServices();
  const pendingPin = deferred();
  let pinStarted = false;
  services.store.pin = async () => {
    pinStarted = true;
    return pendingPin.promise;
  };
  const remote = await startTestServer({
    artifactStore: services.store, artifactTracker: services.tracker, artifactTickets: services.tickets,
  });
  let ws;
  try {
    ws = await openPhone(remote);
    await readInitialization(ws);
    ws.send(JSON.stringify({
      type: "createArtifactTicket", requestId: "req-race", artifactId: "art-1", purpose: "download",
    }));
    await waitFor(() => pinStarted, "deferred artifact pin");
    ws.close();
    await once(ws, "close");
    await waitFor(() => services.revoked.length === 1, "server socket close");
    pendingPin.resolve({
      record: { ...services.record },
      release: () => services.releases.push("art-1"),
    });
    await waitFor(() => services.releases.length === 1 || services.issued.length > 0, "pin race cleanup");
    assert.deepEqual(services.issued, []);
    assert.deepEqual(services.releases, ["art-1"]);
  } finally {
    pendingPin.resolve({ record: services.record, release() {} });
    ws?.terminate();
    await remote.close();
  }
});

test("rejects an invalid phone token with the stable close code", async () => {
  const remote = await startTestServer();
  try {
    const ws = new WebSocket(`${remote.wsUrl}/ws?token=wrong`);
    const [code, reason] = await once(ws, "close");
    assert.equal(code, 4001);
    assert.match(reason.toString(), /unauthorized/i);
  } finally {
    await remote.close();
  }
});

test("sends deterministic initial state and then broadcasts adapter events", async () => {
  const remote = await startTestServer({
    history: [
      { type: "permission_request", id: "raw", rawParams: { secret: "never replay" } },
      { type: "assistant", text: "saved" },
      { type: "internal_debug", rawParams: { secret: "never replay" } },
    ],
  });
  let ws;
  try {
    ws = await openPhone(remote);
    const initial = [];
    for (let index = 0; index < 5; index += 1) initial.push(await nextJson(ws));
    assert.deepEqual(initial.map((message) => message.type), [
      "hello", "system_init", "history", "conversations", "permission_request",
    ]);
    assert.equal(initial[1].cwd, "D:\\repo");
    assert.equal(initial[1].appServerStatus, "online");
    assert.deepEqual(initial[2].events, [{ type: "assistant", text: "saved" }]);
    assert.doesNotMatch(JSON.stringify(initial[2]), /never replay|rawParams/);
    assert.equal(initial[3].conversations[0].id, "thr-current");
    remote.adapter.emitPhone({ type: "assistant_delta", text: "now" });
    assert.deepEqual(await nextJson(ws), { type: "assistant_delta", text: "now" });
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("queues commands until deterministic initialization is complete", async () => {
  const gate = deferred();
  const adapter = new FakeAdapter();
  const listThreads = adapter.listThreads.bind(adapter);
  adapter.listThreads = async (params) => {
    await gate.promise;
    return listThreads(params);
  };
  const starting = createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    initialHistory: [],
    ownAdapter: true,
  });
  // The HTTP listener waits for adapter.start, not listThreads, so obtain the
  // facade after startup and hold only the per-client initialization.
  const remote = await starting;
  let ws;
  try {
    ws = await openPhone(remote);
    ws.send(JSON.stringify({ type: "prompt", text: "early" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(adapter.calls.some(([name]) => name === "sendPrompt"), false);
    gate.resolve();
    const initial = [];
    for (let index = 0; index < 5; index += 1) initial.push(await nextJson(ws));
    assert.deepEqual(initial.map((message) => message.type), [
      "hello", "system_init", "history", "conversations", "permission_request",
    ]);
    assert.equal((await nextJson(ws)).type, "prompt_queued");
    assert.equal(adapter.calls.some(([name]) => name === "sendPrompt"), true);
  } finally {
    gate.resolve();
    ws?.close();
    await remote.close();
  }
});

test("records a bounded transcript and restores it on reconnect", async () => {
  const remote = await startTestServer({ historyLimit: 3 });
  let first;
  let second;
  try {
    first = await openPhone(remote);
    for (let index = 0; index < 4; index += 1) await nextJson(first);
    await nextJson(first); // pending approval
    for (let index = 0; index < 5; index += 1) {
      remote.adapter.emitPhone({ type: "notice", message: `event-${index}` });
      await nextJson(first);
    }
    first.close();
    await once(first, "close");

    second = await openPhone(remote);
    assert.equal((await nextJson(second)).type, "hello");
    assert.equal((await nextJson(second)).type, "system_init");
    const history = await nextJson(second);
    assert.equal(history.type, "history");
    assert.deepEqual(history.events.map((event) => event.message), ["event-2", "event-3", "event-4"]);
  } finally {
    first?.close();
    second?.close();
    await remote.close();
  }
});

test("a replacement thread recovery preserves the local transcript for reconnects", async () => {
  const remote = await startTestServer({
    history: [{ type: "assistant", text: "history before App Server restart" }],
  });
  let ws;
  try {
    remote.adapter.threadId = "thr-replacement";
    remote.adapter.emitPhone({
      type: "notice",
      code: "app_server_recovered",
      previousThreadId: "thr-current",
      threadId: "thr-replacement",
      resumed: false,
      preserveHistory: true,
      message: "A new thread was created after restart.",
    });

    ws = await openPhone(remote);
    assert.equal((await nextJson(ws)).type, "hello");
    const state = await nextJson(ws);
    assert.equal(state.threadId, "thr-replacement");
    const history = await nextJson(ws);
    assert.deepEqual(history.events.map((event) => event.message ?? event.text), [
      "history before App Server restart",
      "A new thread was created after restart.",
    ]);
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("replacing the active thread replaces the canonical reconnect history", async () => {
  const remote = await startTestServer({
    history: [{ type: "assistant", text: "old-thread-history" }],
  });
  let first;
  let second;
  try {
    first = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(first);
    first.send(JSON.stringify({ type: "loadConversation", threadId: "thr-old" }));
    let loaded;
    for (let index = 0; index < 4; index += 1) {
      const message = await nextJson(first);
      if (message.type === "history") { loaded = message; break; }
    }
    assert.deepEqual(loaded?.events, [{ type: "assistant", text: "history:thr-old" }]);
    remote.adapter.emitPhone({ type: "assistant_delta", text: "new-thread-delta" });
    while ((await nextJson(first)).type !== "assistant_delta") { /* drain system state */ }
    first.close();
    await once(first, "close");

    second = await openPhone(remote);
    assert.equal((await nextJson(second)).type, "hello");
    assert.equal((await nextJson(second)).threadId, "thr-old");
    const history = await nextJson(second);
    assert.equal(history.type, "history");
    assert.deepEqual(history.events, [
      { type: "assistant", text: "history:thr-old" },
      { type: "assistant_delta", text: "new-thread-delta" },
    ]);
  } finally {
    first?.close();
    second?.close();
    await remote.close();
  }
});

test("loading a conversation adopts its stored workspace and reuses resume history", async () => {
  const adapter = new FakeAdapter();
  adapter.readThread = async (id, options) => {
    adapter.calls.push(["readThread", id, options]);
    return { thread: { id, cwd: "E:\\stored-workspace" }, events: [] };
  };
  adapter.resumeThread = async (id, options) => {
    adapter.calls.push(["resumeThread", id, options]);
    adapter.threadId = id;
    adapter.cwd = options?.cwd ?? adapter.cwd;
    return {
      thread: { id, cwd: options?.cwd ?? adapter.cwd },
      events: [{ type: "assistant", text: "history from resume" }],
    };
  };
  const remote = await startTestServer({ adapter });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "loadConversation", threadId: "thr-stored" }));
    let history;
    for (let index = 0; index < 4; index += 1) {
      const message = await nextJson(ws);
      if (message.type === "history") { history = message; break; }
    }
    assert.deepEqual(history?.events, [{ type: "assistant", text: "history from resume" }]);
    assert.equal(adapter.cwd, "E:\\stored-workspace");
    assert.deepEqual(adapter.calls.filter(([name]) => ["readThread", "resumeThread"].includes(name)), [
      ["readThread", "thr-stored", { includeTurns: false }],
      ["resumeThread", "thr-stored", { cwd: "E:\\stored-workspace" }],
    ]);
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("a failed history read cannot partially switch the active thread", async () => {
  const adapter = new FakeAdapter();
  adapter.readThread = async (id) => {
    adapter.calls.push(["readThread", id]);
    throw new Error("history unavailable");
  };
  const remote = await startTestServer({ adapter });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "loadConversation", threadId: "thr-unavailable" }));
    const error = await nextJson(ws);
    assert.deepEqual(error, { type: "error", message: "history unavailable" });
    assert.equal(adapter.threadId, "thr-current");
    assert.deepEqual(adapter.calls.filter(([name]) => ["readThread", "resumeThread"].includes(name)), [
      ["readThread", "thr-unavailable"],
    ]);
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("maps phone commands to adapter operations without blocking on turn completion", async () => {
  const remote = await startTestServer();
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    const messages = [
      { type: "prompt", requestId: "r1", text: "ship", images: ["data:image/png;base64,AA=="] },
      { type: "interrupt" },
      { type: "permission", id: "approval-1", action: "allow", payload: { scope: "turn" } },
      { type: "setSessionAuto", enabled: true },
      { type: "setModel", model: "gpt-next" },
      { type: "setEffort", effort: "medium" },
      { type: "newConversation", cwd: "D:\\repo", model: "gpt-next", effort: "medium" },
      { type: "loadConversation", threadId: "thr-old" },
      { type: "renameConversation", threadId: "thr-old", name: "Old work" },
      { type: "archiveConversation", threadId: "thr-old" },
      { type: "listConversations", searchTerm: "work", cursor: "c1" },
      { type: "refreshHistory" },
    ];
    for (const message of messages) ws.send(JSON.stringify(message));
    await waitFor(() => remote.adapter.calls.some(([name]) => name === "archiveThread"), "adapter commands");
    assert.ok(remote.adapter.calls.some(([name, value]) => name === "sendPrompt" && value.text === "ship"));
    assert.ok(remote.adapter.calls.some(([name]) => name === "interrupt"));
    assert.ok(remote.adapter.calls.some(([name, id, action]) => name === "decideApproval" && id === "approval-1" && action === "allow"));
    assert.ok(remote.adapter.calls.some(([name, value]) => name === "setSessionAuto" && value === true));
    assert.ok(remote.adapter.calls.some(([name, id]) => name === "resumeThread" && id === "thr-old"));
    assert.ok(remote.adapter.calls.some(([name, id, value]) => name === "renameThread" && id === "thr-old" && value === "Old work"));
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("closes binary clients instead of buffering repeated unsupported frames", async () => {
  const remote = await startTestServer();
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(Buffer.alloc(1_024), { binary: true });
    const [code] = await once(ws, "close");
    assert.equal(code, 1003);
  } finally {
    ws?.terminate();
    await remote.close();
  }
});

test("validates messages and keeps the socket usable after a client error", async () => {
  const remote = await startTestServer();
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send("not-json");
    const invalidJson = await nextJson(ws);
    assert.equal(invalidJson.type, "error");
    assert.match(invalidJson.message, /JSON/i);
    ws.send(JSON.stringify({ type: "unknownCommand" }));
    const unknown = await nextJson(ws);
    assert.equal(unknown.type, "error");
    assert.match(unknown.message, /unsupported/i);
    ws.send(JSON.stringify({ type: "interrupt" }));
    await waitFor(() => remote.adapter.calls.some(([name]) => name === "interrupt"));
    assert.equal(ws.readyState, WebSocket.OPEN);
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("protects API state and serves static assets with security headers", async () => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-public-"));
  fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>Codex Remote</title>");
  const remote = await startTestServer({ publicDir });
  try {
    const denied = await fetch(`${remote.httpUrl}/api/state`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${remote.httpUrl}/api/state`, {
      headers: { authorization: `Bearer ${remote.token}` },
    });
    assert.equal(allowed.status, 200);
    const state = await allowed.json();
    assert.equal(state.cwd, "D:\\repo");
    assert.equal("token" in state, false);

    const page = await fetch(`${remote.httpUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Codex Remote/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self' https: ws: wss:/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  } finally {
    await remote.close();
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
});

test("browses and creates directories outside the current workspace for workspace switching", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-fs-"));
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, "child"));
  const adapter = new FakeAdapter();
  adapter.cwd = root;
  adapter.newThread = async (value) => {
    adapter.calls.push(["newThread", value]);
    adapter.cwd = value.cwd;
    adapter.threadId = "thr-switched";
    return { thread: { id: adapter.threadId, cwd: adapter.cwd } };
  };
  const remote = await startTestServer({ adapter });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "listDir", path: outside }));
    const outsideDirectory = await nextJson(ws);
    assert.equal(outsideDirectory.type, "directory");
    assert.equal(outsideDirectory.path, await fs.promises.realpath(outside));
    ws.send(JSON.stringify({ type: "mkdir", path: path.join(outside, "created") }));
    assert.equal((await nextJson(ws)).type, "directory");
    assert.equal(fs.existsSync(path.join(outside, "created")), true);
    ws.send(JSON.stringify({ type: "listDir", path: path.join(root, "child") }));
    const directory = await nextJson(ws);
    assert.equal(directory.type, "directory");
    ws.send(JSON.stringify({ type: "mkdir", path: path.join(root, "created") }));
    assert.equal((await nextJson(ws)).type, "directory");
    assert.equal(fs.existsSync(path.join(root, "created")), true);
    ws.send(JSON.stringify({ type: "newConversation", cwd: outside }));
    assert.equal((await nextJson(ws)).type, "history");
    const switchedState = await nextJson(ws);
    assert.equal(switchedState.type, "system_init");
    assert.equal(switchedState.cwd, outside);
  } finally {
    ws?.close();
    await remote.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("lists filesystem roots for cross-drive workspace switching", async () => {
  const remote = await startTestServer();
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "listRoots" }));
    const roots = await nextJson(ws);
    assert.equal(roots.type, "directory_roots");
    assert.ok(Array.isArray(roots.roots));
    assert.ok(roots.roots.length >= 1);
    for (const root of roots.roots) {
      assert.equal(typeof root.name, "string");
      assert.equal(typeof root.path, "string");
    }
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("rejects oversized screenshots before base64 expansion", async () => {
  const remote = await startTestServer({
    windowsRemote: { async capture() { return Buffer.alloc(6 * 1024 * 1024); } },
  });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "screenshot" }));
    const error = await nextJson(ws);
    assert.equal(error.type, "error");
    assert.match(error.message, /large|size/i);
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("delegates screen and control messages only when the Windows service is available", async () => {
  const calls = [];
  const windowsRemote = {
    async capture() { calls.push(["capture"]); return Buffer.from("jpeg"); },
    async control(value) { calls.push(["control", value]); return { ok: true }; },
  };
  const remote = await startTestServer({ windowsRemote });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "screenshot" }));
    const screenshot = await nextJson(ws);
    assert.equal(screenshot.type, "screenshot");
    assert.equal(screenshot.data, "data:image/jpeg;base64,anBlZw==");
    ws.send(JSON.stringify({ type: "control", action: "click", rx: 0.5, ry: 0.5 }));
    const result = await nextJson(ws);
    assert.deepEqual(result, { type: "control_result", ok: true });
    assert.deepEqual(calls, [
      ["capture"],
      ["control", { action: "click", rx: 0.5, ry: 0.5 }],
    ]);
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("HTTP listens before adapter startup and refreshes early clients when Codex becomes ready", async () => {
  const gate = deferred();
  const adapter = new FakeAdapter();
  const reported = [];
  let remote;
  adapter.appServerStatus = "restarting";
  adapter.start = async () => {
    adapter.started += 1;
    assert.ok(remote?.address, "remote address must be committed before adapter startup");
    const health = await fetch(`${remote.httpUrl}/api/health`);
    assert.equal(health.status, 200);
    await gate.promise;
    adapter.appServerStatus = "online";
  };
  const creation = createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
    onError: (error) => reported.push(error),
  });
  let ws;
  try {
    let creationTimer;
    try {
      remote = await Promise.race([
        creation,
        new Promise((_, reject) => {
          creationTimer = setTimeout(() => reject(new Error("timed out waiting for HTTP listener")), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(creationTimer);
    }
    assert.equal(adapter.started, 0, "createRemoteServer must resolve before adapter startup is invoked");
    const health = await fetch(`${remote.httpUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "codex-remote" });

    ws = await openPhone(remote);
    assert.equal((await nextJson(ws)).type, "hello");
    const initialState = await nextJson(ws);
    assert.equal(initialState.type, "system_init");
    assert.notEqual(initialState.appServerStatus, "online");
    assert.equal((await nextJson(ws)).type, "history");
    const initialConversations = await nextJson(ws);
    assert.deepEqual(initialConversations, {
      type: "conversations",
      conversations: [],
      nextCursor: null,
    });
    assert.equal(adapter.calls.some(([method]) => method === "listThreads"), false);
    assert.deepEqual(reported, []);

    gate.resolve();
    let onlineState = null;
    let refreshedConversations = null;
    for (let attempt = 0; attempt < 5 && (!onlineState || !refreshedConversations); attempt += 1) {
      const message = await nextJsonWithin(ws, "adapter-ready broadcasts");
      if (message.type === "system_init" && message.appServerStatus === "online") onlineState = message;
      if (message.type === "conversations" && message.conversations.length) refreshedConversations = message;
    }
    assert.equal(onlineState?.appServerStatus, "online");
    assert.equal(refreshedConversations?.conversations[0]?.id, "thr-current");
    assert.equal(adapter.calls.filter(([method]) => method === "listThreads").length, 1);
    assert.deepEqual(reported, []);
  } finally {
    gate.resolve();
    ws?.close();
    if (!remote) {
      try { remote = await creation; } catch { /* assertion reports the startup failure */ }
    }
    await remote?.close();
  }
});

test("queues client messages while the adapter starts and flushes them in FIFO order", async () => {
  const gate = deferred();
  const adapter = new FakeAdapter();
  adapter.appServerStatus = "restarting";
  adapter.start = async () => {
    adapter.started += 1;
    await gate.promise;
    adapter.appServerStatus = "online";
  };
  const remote = await createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
  });
  let ws;
  try {
    ws = await openPhone(remote);
    const initial = [];
    for (let index = 0; index < 4; index += 1) initial.push(await nextJson(ws));
    assert.deepEqual(initial.map((message) => message.type), [
      "hello", "system_init", "history", "conversations",
    ]);

    ws.send(JSON.stringify({ type: "listModels", cursor: "queued-models" }));
    ws.send(JSON.stringify({ type: "listConversations", searchTerm: "queued-search" }));
    ws.send(JSON.stringify({ type: "prompt", requestId: "queued-prompt", text: "queued" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.messageCount === 3,
      "three early messages to reach the service",
    );
    assert.deepEqual(
      adapter.calls.filter(([method, params]) => method === "listModels"
        || (method === "listThreads" && params?.searchTerm === "queued-search")
        || method === "sendPrompt"),
      [],
      "adapter-dependent messages must not run before startup completes",
    );

    gate.resolve();
    let queuedAck = null;
    for (let attempt = 0; attempt < 8 && !queuedAck; attempt += 1) {
      const message = await nextJsonWithin(ws, "queued message flush");
      if (message.type === "prompt_queued" && message.requestId === "queued-prompt") queuedAck = message;
    }
    assert.ok(queuedAck, "the queued prompt must be acknowledged after startup");
    assert.deepEqual(
      adapter.calls
        .filter(([method, params]) => method === "listModels"
          || (method === "listThreads" && params?.searchTerm === "queued-search")
          || method === "sendPrompt")
        .map(([method]) => method),
      ["listModels", "listThreads", "sendPrompt"],
    );
  } finally {
    gate.resolve();
    ws?.close();
    await remote.close();
  }
});

test("keeps local workspace and screen commands available while the adapter starts", async () => {
  const gate = deferred();
  const adapter = new FakeAdapter();
  const windowsRemote = {
    capture: async () => Buffer.from("local-screen"),
  };
  adapter.appServerStatus = "restarting";
  adapter.start = async () => {
    adapter.started += 1;
    await gate.promise;
    adapter.appServerStatus = "online";
  };
  const remote = await createRemoteServer({
    adapter,
    windowsRemote,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
  });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 4; index += 1) await nextJson(ws);

    ws.send(JSON.stringify({ type: "setCwd", cwd: "D:\\ready-without-codex" }));
    ws.send(JSON.stringify({ type: "screenshot" }));
    let cwdState = null;
    let screenshot = null;
    for (let attempt = 0; attempt < 4 && (!cwdState || !screenshot); attempt += 1) {
      const message = await nextJsonWithin(ws, "local command response during adapter startup");
      if (message.type === "system_init" && message.cwd === "D:\\ready-without-codex") cwdState = message;
      if (message.type === "screenshot") screenshot = message;
    }
    assert.equal(cwdState?.cwd, "D:\\ready-without-codex");
    assert.equal(screenshot?.data, `data:image/jpeg;base64,${Buffer.from("local-screen").toString("base64")}`);
    assert.equal(remote.instance.clients.values().next().value.incoming.length, 0);
  } finally {
    gate.resolve();
    ws?.close();
    await remote.close();
  }
});

test("queues client messages during an App Server restart and flushes them in FIFO order", async () => {
  const adapter = new FakeAdapter();
  const remote = await startTestServer({ adapter });
  await waitFor(() => adapter.started === 1, "initial adapter startup");
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    adapter.appServerStatus = "restarting";
    adapter.emitPhone({ type: "system_init", appServerStatus: "restarting" });
    assert.equal((await nextJson(ws)).appServerStatus, "restarting");

    ws.send(JSON.stringify({ type: "listModels", cursor: "restart-models" }));
    ws.send(JSON.stringify({ type: "listConversations", searchTerm: "restart-search" }));
    ws.send(JSON.stringify({ type: "prompt", requestId: "restart-prompt", text: "after restart" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.messageCount === 3,
      "restart-period messages to reach the service",
    );
    assert.deepEqual(
      adapter.calls.filter(([method, params]) => method === "listModels"
        || (method === "listThreads" && params?.searchTerm === "restart-search")
        || method === "sendPrompt"),
      [],
    );

    adapter.appServerStatus = "online";
    adapter.emitPhone({ type: "system_init", appServerStatus: "online" });
    let queuedAck = null;
    for (let attempt = 0; attempt < 8 && !queuedAck; attempt += 1) {
      const message = await nextJsonWithin(ws, "restart-period message flush");
      if (message.type === "prompt_queued" && message.requestId === "restart-prompt") queuedAck = message;
    }
    assert.ok(queuedAck);
    assert.deepEqual(
      adapter.calls
        .filter(([method, params]) => method === "listModels"
          || (method === "listThreads" && params?.searchTerm === "restart-search")
          || method === "sendPrompt")
        .map(([method]) => method),
      ["listModels", "listThreads", "sendPrompt"],
    );
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("rejects queued RPC messages when an App Server restart becomes unavailable", async () => {
  const adapter = new FakeAdapter();
  const remote = await startTestServer({ adapter });
  await waitFor(() => adapter.started === 1, "initial adapter startup");
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    adapter.appServerStatus = "restarting";
    adapter.emitPhone({ type: "system_init", appServerStatus: "restarting" });
    assert.equal((await nextJson(ws)).appServerStatus, "restarting");
    ws.send(JSON.stringify({ type: "listModels", cursor: "never-run" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.incoming.length === 1,
      "RPC message queued during restart",
    );

    adapter.appServerStatus = "offline";
    adapter.emitPhone({ type: "system_init", appServerStatus: "offline" });
    const messages = [
      await nextJsonWithin(ws, "offline system state"),
      await nextJsonWithin(ws, "offline queued RPC rejection"),
    ];
    assert.ok(messages.some((message) => message.type === "system_init"
      && message.appServerStatus === "offline"));
    assert.ok(messages.some((message) => message.type === "error"
      && message.code === "APP_SERVER_UNAVAILABLE"));
    assert.equal(remote.instance.clients.values().next().value.incoming.length, 0);
    assert.equal(adapter.calls.some(([method]) => method === "listModels"), false);
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("rechecks adapter readiness before each queued RPC after an online flush", async () => {
  const firstGate = deferred();
  const adapter = new FakeAdapter();
  const listModels = adapter.listModels.bind(adapter);
  adapter.listModels = async (params) => {
    adapter.calls.push(["blockingListModels", params]);
    await firstGate.promise;
    return listModels(params);
  };
  const remote = await startTestServer({ adapter });
  await waitFor(() => adapter.started === 1, "initial adapter startup");
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    adapter.appServerStatus = "restarting";
    adapter.emitPhone({ type: "system_init", appServerStatus: "restarting" });
    assert.equal((await nextJson(ws)).appServerStatus, "restarting");
    ws.send(JSON.stringify({ type: "listModels", cursor: "blocking-first" }));
    ws.send(JSON.stringify({ type: "newConversation", cwd: "D:\\must-not-run" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.incoming.length === 2,
      "two RPC messages queued during restart",
    );

    adapter.appServerStatus = "online";
    adapter.emitPhone({ type: "system_init", appServerStatus: "online" });
    await waitFor(
      () => adapter.calls.some(([method]) => method === "blockingListModels"),
      "first queued RPC to start",
    );
    assert.equal(adapter.calls.some(([method]) => method === "newThread"), false);
    adapter.appServerStatus = "offline";
    adapter.emitPhone({ type: "system_init", appServerStatus: "offline" });
    firstGate.resolve();

    const received = [];
    for (let attempt = 0; attempt < 6
      && !received.some((message) => message.code === "APP_SERVER_UNAVAILABLE"); attempt += 1) {
      received.push(await nextJsonWithin(ws, "mid-drain offline rejection"));
    }
    assert.ok(received.some((message) => message.type === "error"
      && message.code === "APP_SERVER_UNAVAILABLE"));
    assert.equal(
      received.filter((message) => message.type === "error"
        && message.code === "APP_SERVER_UNAVAILABLE").length,
      1,
    );
    assert.equal(adapter.calls.some(([method]) => method === "newThread"), false);
    assert.equal(remote.instance.clients.values().next().value.pendingRpcCount, 0);
  } finally {
    firstGate.resolve();
    ws?.close();
    await remote.close();
  }
});

test("does not execute remaining queued RPC messages after the client closes", async () => {
  const firstGate = deferred();
  const adapter = new FakeAdapter();
  const listModels = adapter.listModels.bind(adapter);
  adapter.listModels = async (params) => {
    adapter.calls.push(["blockingListModels", params]);
    await firstGate.promise;
    return listModels(params);
  };
  const remote = await startTestServer({ adapter });
  await waitFor(() => adapter.started === 1, "initial adapter startup");
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    adapter.appServerStatus = "restarting";
    adapter.emitPhone({ type: "system_init", appServerStatus: "restarting" });
    assert.equal((await nextJson(ws)).appServerStatus, "restarting");
    ws.send(JSON.stringify({ type: "listModels", cursor: "blocking-first" }));
    ws.send(JSON.stringify({ type: "newConversation", cwd: "D:\\must-not-run" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.incoming.length === 2,
      "two RPC messages queued before close",
    );

    adapter.appServerStatus = "online";
    adapter.emitPhone({ type: "system_init", appServerStatus: "online" });
    await waitFor(
      () => adapter.calls.some(([method]) => method === "blockingListModels"),
      "first queued RPC to start",
    );
    assert.equal(adapter.calls.some(([method]) => method === "newThread"), false);
    const closed = once(ws, "close");
    ws.close();
    await closed;
    await waitFor(() => remote.instance.clients.size === 0, "closed client removal");
    firstGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.calls.some(([method]) => method === "newThread"), false);
    assert.equal(remote.instance.clients.size, 0);
  } finally {
    firstGate.resolve();
    ws?.terminate();
    await remote.close();
  }
});

test("keeps queued RPC and local messages serialized on one client", async () => {
  const firstGate = deferred();
  const adapter = new FakeAdapter();
  const listModels = adapter.listModels.bind(adapter);
  adapter.listModels = async (params) => {
    adapter.calls.push(["blockingListModels", params]);
    await firstGate.promise;
    return listModels(params);
  };
  const remote = await startTestServer({ adapter });
  await waitFor(() => adapter.started === 1, "initial adapter startup");
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    adapter.appServerStatus = "restarting";
    adapter.emitPhone({ type: "system_init", appServerStatus: "restarting" });
    assert.equal((await nextJson(ws)).appServerStatus, "restarting");
    ws.send(JSON.stringify({ type: "listModels", cursor: "blocking-first" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.incoming.length === 1,
      "RPC message queued before serialization check",
    );
    adapter.appServerStatus = "online";
    adapter.emitPhone({ type: "system_init", appServerStatus: "online" });
    await waitFor(
      () => adapter.calls.some(([method]) => method === "blockingListModels"),
      "queued RPC to begin",
    );

    ws.send(JSON.stringify({ type: "setCwd", cwd: "D:\\after-blocked-rpc" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.messageCount === 2,
      "local message to reach the service",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.calls.some(([method]) => method === "setCwd"), false);
    firstGate.resolve();
    await waitFor(() => adapter.calls.some(([method]) => method === "setCwd"), "serialized local message");
    assert.ok(
      adapter.calls.findIndex(([method]) => method === "listModels")
      < adapter.calls.findIndex(([method]) => method === "setCwd"),
    );
  } finally {
    firstGate.resolve();
    ws?.close();
    await remote.close();
  }
});

test("defers an RPC whose execution turn reaches a new restart", async () => {
  const localGate = deferred();
  const adapter = new FakeAdapter();
  const windowsRemote = {
    capture: async () => {
      await localGate.promise;
      return Buffer.from("delayed-screen");
    },
  };
  const remote = await startTestServer({ adapter, windowsRemote });
  await waitFor(() => adapter.started === 1, "initial adapter startup");
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "screenshot" }));
    ws.send(JSON.stringify({ type: "listModels", cursor: "deferred-at-execution" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.incoming.length === 1,
      "RPC queued behind local operation",
    );
    adapter.appServerStatus = "restarting";
    adapter.emitPhone({ type: "system_init", appServerStatus: "restarting" });
    localGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.calls.some(([method]) => method === "listModels"), false);
    assert.equal(remote.instance.clients.values().next().value.incoming.length, 1);

    adapter.appServerStatus = "online";
    adapter.emitPhone({ type: "system_init", appServerStatus: "online" });
    await waitFor(() => adapter.calls.some(([method]) => method === "listModels"), "deferred RPC recovery");
    assert.equal(remote.instance.clients.values().next().value.incoming.length, 0);
  } finally {
    localGate.resolve();
    ws?.close();
    await remote.close();
  }
});

test("drains restarting RPC queues independently for multiple clients", async () => {
  const adapter = new FakeAdapter();
  const remote = await startTestServer({ adapter });
  await waitFor(() => adapter.started === 1, "initial adapter startup");
  let first;
  let second;
  try {
    first = await openPhone(remote);
    second = await openPhone(remote);
    for (const ws of [first, second]) {
      for (let index = 0; index < 5; index += 1) await nextJson(ws);
    }
    adapter.appServerStatus = "restarting";
    adapter.emitPhone({ type: "system_init", appServerStatus: "restarting" });
    assert.equal((await nextJson(first)).appServerStatus, "restarting");
    assert.equal((await nextJson(second)).appServerStatus, "restarting");
    first.send(JSON.stringify({ type: "listModels", cursor: "first-client" }));
    second.send(JSON.stringify({ type: "listModels", cursor: "second-client" }));
    await waitFor(
      () => [...remote.instance.clients].every((client) => client.pendingRpcCount === 1),
      "one queued RPC for each client",
    );

    adapter.appServerStatus = "online";
    adapter.emitPhone({ type: "system_init", appServerStatus: "online" });
    await waitFor(
      () => adapter.calls.filter(([method]) => method === "listModels").length === 2,
      "both client queues to drain",
    );
    await waitFor(
      () => [...remote.instance.clients].every((client) => client.pendingRpcCount === 0),
      "both pending RPC counts to settle",
    );
    assert.ok(adapter.calls.some(([method, params]) => method === "listModels"
      && params.cursor === "first-client"));
    assert.ok(adapter.calls.some(([method, params]) => method === "listModels"
      && params.cursor === "second-client"));
    assert.ok([...remote.instance.clients].every((client) => client.pendingRpcCount === 0));
  } finally {
    first?.close();
    second?.close();
    await remote.close();
  }
});

test("runs local messages received during initialization when Codex starts restarting", async () => {
  const initGate = deferred();
  const adapter = new FakeAdapter();
  const listThreads = adapter.listThreads.bind(adapter);
  const windowsRemote = { capture: async () => Buffer.from("init-local-screen") };
  let initializationListPending = false;
  adapter.listThreads = async (params) => {
    initializationListPending = true;
    await initGate.promise;
    return listThreads(params);
  };
  const remote = await startTestServer({ adapter, windowsRemote });
  await waitFor(() => adapter.started === 1, "initial adapter startup");
  let ws;
  try {
    ws = await openPhone(remote);
    await waitFor(() => initializationListPending, "blocked connection initialization");
    ws.send(JSON.stringify({ type: "setCwd", cwd: "D:\\local-during-init" }));
    ws.send(JSON.stringify({ type: "screenshot" }));
    ws.send(JSON.stringify({ type: "listModels", cursor: "rpc-during-init" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.messageCount === 3,
      "three messages to arrive during connection initialization",
    );
    adapter.appServerStatus = "restarting";
    adapter.emitPhone({ type: "system_init", appServerStatus: "restarting" });
    initGate.resolve();

    const initial = [];
    for (let index = 0; index < 4; index += 1) initial.push(await nextJson(ws));
    assert.deepEqual(initial.map((message) => message.type), [
      "hello", "system_init", "history", "conversations",
    ]);
    let cwdState = null;
    let screenshot = null;
    for (let attempt = 0; attempt < 5 && (!cwdState || !screenshot); attempt += 1) {
      const message = await nextJsonWithin(ws, "local command after initialization");
      if (message.type === "system_init" && message.cwd === "D:\\local-during-init") cwdState = message;
      if (message.type === "screenshot") screenshot = message;
    }
    assert.equal(cwdState?.cwd, "D:\\local-during-init");
    assert.equal(
      screenshot?.data,
      `data:image/jpeg;base64,${Buffer.from("init-local-screen").toString("base64")}`,
    );
    assert.equal(adapter.calls.some(([method]) => method === "listModels"), false);
    assert.equal(remote.instance.clients.values().next().value.incoming.length, 1);
  } finally {
    initGate.resolve();
    ws?.close();
    await remote.close();
  }
});

test("bounds client messages queued while the adapter starts", async () => {
  const gate = deferred();
  const adapter = new FakeAdapter();
  adapter.appServerStatus = "restarting";
  adapter.start = async () => {
    adapter.started += 1;
    await gate.promise;
    adapter.appServerStatus = "online";
  };
  const remote = await createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
  });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 4; index += 1) await nextJson(ws);
    const closed = once(ws, "close");
    for (let index = 0; index <= 50; index += 1) {
      ws.send(JSON.stringify({ type: "listModels", cursor: `queued-${index}` }));
    }
    const [code] = await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("timed out waiting for queued-message overflow rejection")),
        1_000,
      )),
    ]);
    assert.equal(code, 4008);
    assert.equal(adapter.calls.some(([method]) => method === "listModels"), false);
  } finally {
    gate.resolve();
    ws?.terminate();
    await remote.close();
  }
});

test("rejects queued client messages when background adapter startup fails", async () => {
  const gate = deferred();
  const adapter = new FakeAdapter();
  const original = new Error("adapter start failed");
  adapter.appServerStatus = "restarting";
  adapter.start = async () => {
    adapter.started += 1;
    try { await gate.promise; }
    finally { adapter.appServerStatus = "offline"; }
  };
  const remote = await createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
    onError: () => {},
  });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 4; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "listModels", cursor: "never-applied" }));
    ws.send(JSON.stringify({ type: "prompt", requestId: "never-run", text: "never run" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.messageCount === 2,
      "two early messages to reach the service",
    );
    assert.equal(adapter.calls.some(([method]) => method === "listModels"), false);
    assert.equal(adapter.calls.some(([method]) => method === "sendPrompt"), false);

    gate.reject(original);
    const rejected = [];
    for (let attempt = 0; attempt < 5 && rejected.length < 2; attempt += 1) {
      const message = await nextJsonWithin(ws, "queued request rejection");
      if (message.type === "error" && message.code === "APP_SERVER_UNAVAILABLE") rejected.push(message);
    }
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((message) => /not processed/i.test(message.message)));
    assert.equal(remote.instance.clients.values().next().value.incoming.length, 0);
  } finally {
    gate.reject(original);
    ws?.close();
    await remote.close();
  }
});

test("rejects new client messages after adapter startup has failed without retaining them", async () => {
  const adapter = new FakeAdapter();
  const original = new Error("adapter start failed");
  adapter.appServerStatus = "restarting";
  adapter.start = async () => {
    adapter.started += 1;
    adapter.appServerStatus = "offline";
    throw original;
  };
  const remote = await createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
    onError: () => {},
  });
  let ws;
  try {
    await remote.instance.adapterStartPromise;
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "listModels", cursor: "never-applied" }));
    const rejected = await nextJsonWithin(ws, "post-failure request rejection");
    assert.equal(rejected.type, "error");
    assert.equal(rejected.code, "APP_SERVER_UNAVAILABLE");
    assert.match(rejected.message, /not processed/i);
    assert.equal(adapter.calls.some(([method]) => method === "listModels"), false);
    assert.equal(remote.instance.clients.values().next().value.incoming.length, 0);
  } finally {
    ws?.close();
    await remote.close();
  }
});

test("drops queued client messages on close without invoking the adapter", async () => {
  const gate = deferred();
  const adapter = new FakeAdapter();
  const intentional = new Error("adapter stopped during startup");
  adapter.appServerStatus = "restarting";
  adapter.start = async () => { adapter.started += 1; await gate.promise; };
  adapter.stop = async () => { adapter.stopped += 1; gate.reject(intentional); };
  const remote = await createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
  });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 4; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "listModels", cursor: "never-applied" }));
    ws.send(JSON.stringify({ type: "prompt", requestId: "never-run", text: "never run" }));
    await waitFor(
      () => remote.instance.clients.values().next().value?.incoming.length === 2,
      "queued client messages before close",
    );

    await remote.close();
    assert.equal(adapter.calls.some(([method]) => method === "listModels"), false);
    assert.equal(adapter.calls.some(([method]) => method === "sendPrompt"), false);
    assert.equal(remote.instance.clients.size, 0);
    assert.equal(adapter.stopped, 1);
  } finally {
    gate.reject(intentional);
    ws?.terminate();
    await remote.close();
  }
});

test("a background adapter startup failure is reported once while HTTP stays healthy", async () => {
  const gate = deferred();
  const adapter = new FakeAdapter();
  const reported = [];
  const original = new Error("adapter start failed");
  adapter.appServerStatus = "restarting";
  adapter.start = async () => {
    adapter.started += 1;
    try { await gate.promise; }
    finally { adapter.appServerStatus = "offline"; }
  };
  let remote;
  let creationError;
  let creationSettled = false;
  const creation = createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
    onError: (error) => reported.push(error),
  });
  creation.then(
    (value) => { remote = value; creationSettled = true; },
    (error) => { creationError = error; creationSettled = true; },
  );
  let ws;
  try {
    await waitFor(() => creationSettled, "HTTP listener before background failure");
    assert.ifError(creationError);
    ws = await openPhone(remote);
    assert.deepEqual(
      [await nextJson(ws), await nextJson(ws), await nextJson(ws), await nextJson(ws)].map((message) => message.type),
      ["hello", "system_init", "history", "conversations"],
    );
    gate.reject(original);
    await waitFor(() => reported.length === 1, "background startup diagnostic");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reported, [original]);
    let failedState = null;
    for (let attempt = 0; attempt < 3 && !failedState; attempt += 1) {
      const message = await nextJsonWithin(ws, "failed adapter system state");
      if (message.type === "system_init") failedState = message;
    }
    assert.ok(failedState, "expected a failed adapter system state broadcast");
    assert.equal(failedState.type, "system_init");
    assert.equal(failedState.appServerStatus, "offline");
    const health = await fetch(`${remote.httpUrl}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    gate.reject(original);
    ws?.close();
    if (!remote) await creation.catch(() => {});
    await remote?.close();
  }
});

test("close during background adapter startup stops once without an unhandled rejection", async () => {
  const gate = deferred();
  const adapter = new FakeAdapter();
  const intentional = new Error("adapter stopped during startup");
  const unhandled = [];
  adapter.appServerStatus = "restarting";
  adapter.start = async () => { adapter.started += 1; await gate.promise; };
  adapter.stop = async () => { adapter.stopped += 1; gate.reject(intentional); };
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let remote;
  let creationError;
  let creationSettled = false;
  const creation = createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
  });
  creation.then(
    (value) => { remote = value; creationSettled = true; },
    (error) => { creationError = error; creationSettled = true; },
  );
  try {
    await waitFor(() => creationSettled, "HTTP listener before close");
    assert.ifError(creationError);
    await waitFor(() => adapter.started === 1, "background adapter startup");
    await remote.close();
    await remote.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.started, 1);
    assert.equal(adapter.stopped, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    gate.reject(intentional);
    if (!remote) await creation.catch(() => {});
    await remote?.close();
  }
});

test("close before scheduled adapter startup cancels it and stops the owned adapter once", async () => {
  const adapter = new FakeAdapter();
  const unhandled = [];
  adapter.appServerStatus = "restarting";
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let remote;
  try {
    remote = await createRemoteServer({
      adapter,
      token: "secret-token",
      host: "127.0.0.1",
      port: 0,
      ownAdapter: true,
    });
    assert.equal(adapter.started, 0);
    await Promise.all([remote.close(), remote.close()]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.started, 0);
    assert.equal(adapter.stopped, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await remote?.close();
  }
});

test("rolls back an owned adapter without starting it when HTTP listen fails", async () => {
  const blocker = http.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  const adapter = new FakeAdapter();
  adapter.appServerStatus = "restarting";
  let creationError;
  let creationSettled = false;
  const creation = createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: address.port,
    ownAdapter: true,
  });
  creation.then(
    () => { creationSettled = true; },
    (error) => { creationError = error; creationSettled = true; },
  );
  try {
    await waitFor(() => creationSettled, "listen failure while adapter startup is pending");
    assert.match(creationError?.message ?? "", /EADDRINUSE/);
    assert.equal(adapter.started, 0);
    assert.equal(adapter.stopped, 1);
    assert.equal(adapter.listenerCount("phoneEvent"), 0);
  } finally {
    await creation.catch(() => {});
    await new Promise((resolve) => blocker.close(() => resolve()));
  }
});

test("startup rollback preserves the listen failure and still stops an owned adapter after unsubscribe errors", async () => {
  const blocker = http.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  const adapter = new FakeAdapter();
  const reported = [];
  adapter.subscribePhoneEvents = (listener) => {
    adapter.on("phoneEvent", listener);
    return () => {
      adapter.off("phoneEvent", listener);
      throw new Error("unsubscribe failed");
    };
  };
  try {
    await assert.rejects(createRemoteServer({
      adapter,
      token: "secret-token",
      host: "127.0.0.1",
      port: address.port,
      ownAdapter: true,
      onError: (error) => reported.push(error),
    }), /EADDRINUSE/);
    assert.equal(adapter.started, 0);
    assert.equal(adapter.stopped, 1);
    assert.equal(adapter.listenerCount("phoneEvent"), 0);
    assert.match(reported.map((error) => error.message).join("\n"), /unsubscribe failed/);
  } finally {
    await new Promise((resolve) => blocker.close(() => resolve()));
  }
});

test("close owns and stops the adapter exactly once", async () => {
  const remote = await startTestServer();
  await waitFor(() => remote.adapter.started === 1, "owned adapter startup");
  await remote.close();
  await remote.close();
  assert.equal(remote.adapter.started, 1);
  assert.equal(remote.adapter.stopped, 1);
});
