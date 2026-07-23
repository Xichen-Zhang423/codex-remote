import test from "node:test";
import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      return { record: { ...record }, path: file, size: 5, release() { fs.rmSync(file, { force: true }); } };
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

test("confines directory browsing and creation to the current workspace", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-fs-"));
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, "child"));
  const adapter = new FakeAdapter();
  adapter.cwd = root;
  const remote = await startTestServer({ adapter });
  let ws;
  try {
    ws = await openPhone(remote);
    for (let index = 0; index < 5; index += 1) await nextJson(ws);
    ws.send(JSON.stringify({ type: "listDir", path: outside }));
    assert.match((await nextJson(ws)).message, /workspace/i);
    ws.send(JSON.stringify({ type: "mkdir", path: path.join(outside, "blocked") }));
    assert.match((await nextJson(ws)).message, /workspace/i);
    assert.equal(fs.existsSync(path.join(outside, "blocked")), false);
    ws.send(JSON.stringify({ type: "listDir", path: path.join(root, "child") }));
    const directory = await nextJson(ws);
    assert.equal(directory.type, "directory");
    ws.send(JSON.stringify({ type: "mkdir", path: path.join(root, "created") }));
    assert.equal((await nextJson(ws)).type, "directory");
    assert.equal(fs.existsSync(path.join(root, "created")), true);
  } finally {
    ws?.close();
    await remote.close();
    fs.rmSync(parent, { recursive: true, force: true });
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

test("rolls back the owned adapter when HTTP listen fails", async () => {
  const blocker = http.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  const adapter = new FakeAdapter();
  try {
    await assert.rejects(createRemoteServer({
      adapter,
      token: "secret-token",
      host: "127.0.0.1",
      port: address.port,
      ownAdapter: true,
    }), /EADDRINUSE/);
    assert.equal(adapter.started, 1);
    assert.equal(adapter.stopped, 1);
    assert.equal(adapter.listenerCount("phoneEvent"), 0);
  } finally {
    await new Promise((resolve) => blocker.close(() => resolve()));
  }
});

test("startup rollback preserves the start failure and still stops an owned adapter after unsubscribe errors", async () => {
  const adapter = new FakeAdapter();
  const original = new Error("adapter start failed");
  const reported = [];
  adapter.subscribePhoneEvents = (listener) => {
    adapter.on("phoneEvent", listener);
    return () => {
      adapter.off("phoneEvent", listener);
      throw new Error("unsubscribe failed");
    };
  };
  adapter.start = async () => { adapter.started += 1; throw original; };
  await assert.rejects(createRemoteServer({
    adapter,
    token: "secret-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
    onError: (error) => reported.push(error),
  }), (error) => error === original);
  assert.equal(adapter.stopped, 1);
  assert.equal(adapter.listenerCount("phoneEvent"), 0);
  assert.match(reported.map((error) => error.message).join("\n"), /unsubscribe failed/);
});

test("close owns and stops the adapter exactly once", async () => {
  const remote = await startTestServer();
  await remote.close();
  await remote.close();
  assert.equal(remote.adapter.started, 1);
  assert.equal(remote.adapter.stopped, 1);
});
