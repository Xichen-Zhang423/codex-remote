import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { EventEmitter } from "node:events";
import { createArtifactContentHandler } from "./artifact-http.js";

const DEFAULT_HISTORY_LIMIT = 400;
const DEFAULT_MAX_PAYLOAD = 48 * 1024 * 1024;
const MAX_CLIENT_QUEUE = 200;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES_PER_WINDOW = 120;
const MESSAGE_WINDOW_MS = 10_000;
const MAX_PENDING_INCOMING = 50;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_OUTGOING_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_EVENT_BYTES = 64 * 1024;

export const TRANSCRIPT_TYPES = new Set([
  "user_echo", "assistant_delta", "assistant", "thinking_delta", "thinking",
  "plan_delta", "plan", "plan_text", "diff", "tool_use", "tool_delta",
  "tool_result", "file_change", "activity", "result", "notice", "error",
]);

function safeWire(value, seen = new WeakSet(), depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 2_000) return "[node limit]";
  if (depth > 10) return "[depth limit]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_OUTGOING_MESSAGE_BYTES
    ? `${value.slice(0, MAX_OUTGOING_MESSAGE_BYTES - 12)}[truncated]`
    : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    output = value.slice(0, 500).map((entry) => safeWire(entry, seen, depth + 1, budget));
  } else {
    output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 500)) {
      if (["token", "authorization", "rawparams"].includes(key.toLowerCase())) continue;
      const clean = safeWire(entry, seen, depth + 1, budget);
      if (clean !== undefined) output[key] = clean;
    }
  }
  seen.delete(value);
  return output;
}

function wireBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Number.POSITIVE_INFINITY; }
}

function cleanHistory(events, limit) {
  return (Array.isArray(events) ? events : [])
    .map((entry) => safeWire(entry))
    .filter((entry) => entry && typeof entry === "object"
      && TRANSCRIPT_TYPES.has(entry.type)
      && wireBytes(entry) <= MAX_TRANSCRIPT_EVENT_BYTES)
    .slice(-limit);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".."
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function tokenMatches(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return "";
  return header.slice(7);
}

function systemState(adapter) {
  return {
    type: "system_init",
    cwd: adapter.cwd ?? null,
    model: adapter.model ?? null,
    effort: adapter.effort ?? null,
    threadId: adapter.threadId ?? null,
    queueLength: adapter.queueLength ?? 0,
    sessionAuto: adapter.approvalBroker?.sessionAuto ?? adapter.sessionAuto ?? false,
    appServerStatus: adapter.appServerStatus ?? "online",
    restartAttempt: adapter.restartAttempts ?? 0,
    retryInMs: adapter.retryInMs ?? 0,
  };
}

function conversationEvent(result) {
  return {
    type: "conversations",
    conversations: Array.isArray(result?.data)
      ? safeWire(result.data)
      : Array.isArray(result?.threads) ? safeWire(result.threads) : [],
    nextCursor: result?.nextCursor ?? null,
  };
}

function validateShortString(value, name, { optional = false, max = 4_096 } = {}) {
  if (optional && (value == null || value === "")) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} is too long`);
  return value;
}

function asyncOnce(callback) {
  let result;
  return () => {
    result ??= Promise.resolve().then(() => callback());
    return result;
  };
}

export class RemoteServer extends EventEmitter {
  constructor({
    adapter,
    token,
    host = "0.0.0.0",
    port = 8766,
    publicDir,
    initialHistory = [],
    historyLimit = DEFAULT_HISTORY_LIMIT,
    maxPayload = DEFAULT_MAX_PAYLOAD,
    windowsRemote = null,
    panelSession = null,
    artifactStore = null,
    artifactTracker = null,
    artifactTickets = null,
    ownAdapter = true,
    onAdapterOwnership = null,
    onError = () => {},
  } = {}) {
    super();
    if (!adapter) throw new TypeError("RemoteServer requires an adapter");
    if (typeof token !== "string" || token.length < 8) throw new TypeError("RemoteServer token is too short");
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("invalid port");
    if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 10_000) {
      throw new TypeError("invalid historyLimit");
    }
    this.adapter = adapter;
    this.token = token;
    this.host = host;
    this.port = port;
    this.publicDir = publicDir ? path.resolve(publicDir) : null;
    this.historyLimit = historyLimit;
    this.maxPayload = maxPayload;
    this.windowsRemote = windowsRemote;
    this.panelSession = panelSession;
    this.artifactStore = artifactStore;
    this.artifactTracker = artifactTracker;
    this.artifactTickets = artifactTickets;
    this.artifactsEnabled = Boolean(artifactStore && artifactTracker && artifactTickets);
    this.ownAdapter = ownAdapter;
    this.onAdapterOwnership = typeof onAdapterOwnership === "function" ? onAdapterOwnership : null;
    this.onError = onError;
    this.history = cleanHistory(initialHistory, historyLimit);
    this.historyThreadId = adapter.threadId ?? null;
    this.clients = new Set();
    this.app = null;
    this.httpServer = null;
    this.wss = null;
    this.heartbeat = null;
    this.unsubscribe = null;
    this.unsubscribeArtifacts = null;
    this.visibleThreadId = adapter.threadId ?? null;
    this.startPromise = null;
    this.closePromise = null;
    this.adapterStarted = false;
    this.address = null;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    return this.startPromise;
  }

  async #start() {
    try {
      this.#subscribeAdapter();
      if (this.artifactsEnabled && !this.unsubscribeArtifacts) {
        this.unsubscribeArtifacts = this.artifactTracker.subscribe((event) => {
          this.#syncThreadSystemState();
          if (event?.type !== "artifact_update"
              || typeof event.threadId !== "string"
              || !event.threadId
              || event.threadId !== this.adapter.threadId) return;
          this.#broadcast(safeWire(event));
        });
      }
      if (this.ownAdapter) {
        this.adapterStarted = true;
        this.onAdapterOwnership?.();
        this.onAdapterOwnership = null;
      }
      await this.adapter.start?.();
      this.#createHttpSurface();
      await new Promise((resolve, reject) => {
        const onError = (error) => { this.httpServer.off("listening", onListening); reject(error); };
        const onListening = () => { this.httpServer.off("error", onError); resolve(); };
        this.httpServer.once("error", onError);
        this.httpServer.once("listening", onListening);
        this.httpServer.listen(this.port, this.host);
      });
      this.address = this.httpServer.address();
      this.heartbeat = setInterval(() => this.#heartbeat(), 30_000);
      this.heartbeat.unref?.();
      return this;
    } catch (error) {
      await this.#rollbackStart();
      throw error;
    }
  }

  async #rollbackStart() {
    try { this.unsubscribe?.(); } catch (error) { this.#report(error); }
    this.unsubscribe = null;
    try { this.unsubscribeArtifacts?.(); } catch (error) { this.#report(error); }
    this.unsubscribeArtifacts = null;
    for (const client of this.clients) {
      client.closed = true;
      this.#revokeClientTickets(client);
      try { client.ws.terminate(); } catch (error) { this.#report(error); }
    }
    this.clients.clear();
    if (this.wss) {
      await new Promise((resolve) => {
        try { this.wss.close(() => resolve()); } catch { resolve(); }
      });
    }
    this.wss = null;
    if (this.httpServer?.listening) {
      await new Promise((resolve) => this.httpServer.close((error) => {
        if (error) this.#report(error);
        resolve();
      }));
    } else {
      try { this.httpServer?.removeAllListeners(); } catch (error) { this.#report(error); }
    }
    this.httpServer = null;
    if (this.ownAdapter && this.adapterStarted) {
      try { await this.adapter.stop?.(); } catch (stopError) { this.#report(stopError); }
    }
    this.adapterStarted = false;
  }

  #createHttpSurface() {
    const app = express();
    app.disable("x-powered-by");
    app.use((request, response, next) => {
      response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' https: ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
      next();
    });
    app.get("/api/health", (_request, response) => response.json({ ok: true, service: "codex-remote" }));
    app.get("/api/state", (request, response) => {
      if (!tokenMatches(this.token, bearerToken(request))) {
        response.setHeader("Cache-Control", "no-store");
        return response.status(401).json({ error: "unauthorized" });
      }
      response.setHeader("Cache-Control", "no-store");
      return response.json({ ...systemState(this.adapter), type: undefined });
    });
    if (this.artifactsEnabled) {
      const content = createArtifactContentHandler({
        store: this.artifactStore,
        tickets: this.artifactTickets,
      });
      app.get("/api/artifacts/:artifactId/content", content);
      app.head("/api/artifacts/:artifactId/content", content);
    }
    const requirePanel = (request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      const key = request.get("X-Codex-Panel-Key");
      if (!this.panelSession?.authorize(key)) return response.status(401).json({ error: "unauthorized" });
      return next();
    };
    app.get("/api/panel/state", requirePanel, (_request, response) => response.json(this.panelSession.state()));
    app.post("/api/panel/connection", requirePanel, async (_request, response) => {
      try {
        response.json(await this.panelSession.createConnection());
      } catch (error) {
        this.#report(error);
        response.status(503).json({ error: "connection unavailable" });
      }
    });
    app.post("/api/panel/stop", requirePanel, express.json({ limit: "1kb" }), (request, response) => {
      if (request.body?.confirm !== "STOP") return response.status(400).json({ error: "confirmation required" });
      response.status(202).json({ ok: true });
      queueMicrotask(() => this.emit("shutdownRequested"));
    });
    app.use((error, _request, response, next) => {
      if (error?.type !== "entity.parse.failed") return next(error);
      response.setHeader("Cache-Control", "no-store");
      return response.status(400).json({ error: "invalid JSON" });
    });
    if (this.publicDir && fs.existsSync(this.publicDir)) {
      app.use(express.static(this.publicDir, { etag: true, fallthrough: true, index: "index.html" }));
    }
    app.get("/", (_request, response) => {
      response.type("html").send("<!doctype html><title>Codex Remote</title><h1>Codex Remote</h1>");
    });
    app.use((_request, response) => response.status(404).json({ error: "not found" }));
    this.app = app;
    this.httpServer = http.createServer(app);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload, perMessageDeflate: false });
    this.httpServer.on("upgrade", (request, socket, head) => {
      let url;
      try { url = new URL(request.url, "http://codex-remote.local"); } catch { socket.destroy(); return; }
      if (url.pathname !== "/ws") { socket.destroy(); return; }
      request.codexAuthorized = tokenMatches(this.token, url.searchParams.get("token") ?? "");
      this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit("connection", ws, request));
    });
    this.wss.on("connection", (ws, request) => {
      if (!request.codexAuthorized) {
        ws.close(4001, "Unauthorized");
        return;
      }
      void this.#connect(ws).catch((error) => {
        this.#report(error);
        ws.close(1011, "Initialization failed");
      });
    });
  }

  async #connect(ws) {
    const client = {
      ws,
      sessionId: randomBytes(16).toString("base64url"),
      closed: false,
      ticketsRevoked: false,
      ready: false,
      queued: [],
      incoming: [],
      alive: true,
      chain: Promise.resolve(),
      windowStart: Date.now(),
      messageCount: 0,
    };
    this.clients.add(client);
    ws.on("pong", () => { client.alive = true; });
    ws.on("close", () => {
      client.closed = true;
      this.#revokeClientTickets(client);
      this.clients.delete(client);
    });
    ws.on("error", (error) => this.#report(error));
    ws.on("message", (data, isBinary) => {
      if (!this.#consumeRate(client)) {
        ws.close(4008, "Message rate exceeded");
        return;
      }
      if (isBinary) {
        ws.close(1003, "Binary messages are unsupported");
        return;
      }
      const wire = data.toString();
      if (!client.ready) {
        if (client.incoming.length >= MAX_PENDING_INCOMING) {
          ws.close(4008, "Too many messages during initialization");
        } else {
          client.incoming.push(wire);
        }
        return;
      }
      this.#enqueueMessage(client, wire);
    });

    const capabilities = ["codex", "threads", "images", "approvals", "screen", "control"];
    if (this.artifactsEnabled) capabilities.push("artifacts");
    this.#send(client, {
      type: "hello",
      version: 1,
      capabilities,
    }, true);
    this.#send(client, systemState(this.adapter), true);
    this.#send(client, { type: "history", events: safeWire(this.history) }, true);
    if (this.artifactsEnabled && this.adapter.threadId) {
      this.#send(client, {
        type: "artifact_snapshot",
        requestId: null,
        threadId: this.adapter.threadId,
        ...this.artifactStore.snapshot(this.adapter.threadId),
      }, true);
    }
    let conversations;
    try {
      conversations = await this.adapter.listThreads({ limit: 50 });
    } catch (error) {
      this.#report(error);
      conversations = { data: [], nextCursor: null };
    }
    this.#send(client, conversationEvent(conversations), true);
    for (const approval of this.adapter.pendingApprovals?.() ?? []) this.#send(client, safeWire(approval), true);
    client.ready = true;
    for (const event of client.queued.splice(0)) this.#send(client, event, true);
    for (const wire of client.incoming.splice(0)) this.#enqueueMessage(client, wire);
  }

  #enqueueMessage(client, wire) {
    client.chain = client.chain
      .then(() => this.#handleMessage(client, wire))
      .catch((error) => {
        this.#send(client, { type: "error", message: error?.message || "Request failed" }, true);
      });
  }

  #consumeRate(client) {
    const now = Date.now();
    if (now - client.windowStart >= MESSAGE_WINDOW_MS) {
      client.windowStart = now;
      client.messageCount = 0;
    }
    client.messageCount += 1;
    return client.messageCount <= MAX_MESSAGES_PER_WINDOW;
  }

  async #handleMessage(client, wire) {
    let message;
    try { message = JSON.parse(wire); } catch { throw new Error("Invalid JSON message"); }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("Message must be an object");
    }
    const type = validateShortString(message.type, "message type", { max: 80 });
    switch (type) {
      case "prompt": {
        const text = typeof message.text === "string" ? message.text : "";
        const images = Array.isArray(message.images) ? message.images : [];
        if (text.length > 200_000 || images.length > 4 || images.some((entry) => typeof entry !== "string")) {
          throw new Error("Prompt payload is too large or invalid");
        }
        const completion = this.adapter.sendPrompt({ text, images });
        this.#send(client, {
          type: "prompt_queued",
          requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 200) : null,
          queueLength: this.adapter.queueLength ?? 0,
        }, true);
        void Promise.resolve(completion).catch((error) => {
          this.#send(client, { type: "error", message: error?.message || "Prompt failed" }, true);
        });
        return;
      }
      case "interrupt": {
        const accepted = await this.adapter.interrupt();
        this.#send(client, { type: "interrupt_ack", accepted }, true);
        return;
      }
      case "permission": {
        const id = validateShortString(message.id, "permission id", { max: 500 });
        const action = validateShortString(message.action, "permission action", { max: 40 });
        const accepted = await this.adapter.decideApproval(id, action, message.payload ?? {});
        this.#send(client, { type: "permission_ack", id, accepted }, true);
        return;
      }
      case "setSessionAuto":
        this.adapter.setSessionAuto(message.enabled === true);
        this.#broadcastSystemState();
        return;
      case "setCwd":
        this.adapter.setCwd(validateShortString(message.cwd, "cwd", { max: 32_768 }));
        this.#broadcastSystemState();
        return;
      case "setModel":
        this.adapter.setModel(validateShortString(message.model, "model", { optional: true, max: 500 }));
        this.#broadcastSystemState();
        return;
      case "setEffort":
        this.adapter.setEffort(validateShortString(message.effort, "effort", { optional: true, max: 100 }));
        this.#broadcastSystemState();
        return;
      case "newConversation":
        await this.adapter.newThread({ cwd: message.cwd, model: message.model, effort: message.effort });
        this.#replaceHistory(this.adapter.threadId, []);
        this.#broadcast({ type: "history", threadId: this.adapter.threadId ?? null, events: [] });
        this.#broadcastSystemState();
        await this.#refreshConversations();
        return;
      case "listConversations": {
        const result = await this.adapter.listThreads({
          searchTerm: message.searchTerm,
          cwd: message.cwd,
          cursor: message.cursor,
          limit: 50,
        });
        this.#send(client, conversationEvent(result), true);
        return;
      }
      case "loadConversation": {
        const id = validateShortString(message.threadId, "threadId", { max: 500 });
        const metadata = await this.adapter.readThread(id, { includeTurns: false });
        const storedCwd = typeof metadata?.thread?.cwd === "string" && metadata.thread.cwd.trim()
          ? metadata.thread.cwd
          : this.adapter.cwd;
        const resumed = await this.adapter.resumeThread(id, { cwd: storedCwd });
        this.#replaceHistory(id, resumed.events ?? []);
        this.#broadcast({ type: "history", threadId: id, events: safeWire(this.history) });
        this.#broadcastSystemState();
        return;
      }
      case "listArtifacts": {
        let requestId;
        let threadId;
        try {
          requestId = validateShortString(message.requestId, "requestId", { max: 200 });
          threadId = validateShortString(message.threadId, "threadId", { max: 500 });
        } catch {
          this.#sendArtifactError(client, {
            requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 200) : null,
            artifactId: null,
            code: "artifact_invalid_request",
            message: "The artifact request is invalid.",
          });
          return;
        }
        if (!this.artifactsEnabled) {
          this.#sendArtifactError(client, { requestId, artifactId: null,
            code: "artifact_unavailable", message: "The artifact center is unavailable." });
          return;
        }
        if (threadId !== this.adapter.threadId) {
          this.#sendArtifactError(client, { requestId, artifactId: null,
            code: "artifact_thread_unavailable",
            message: "The requested task is not currently available." });
          return;
        }
        this.#send(client, {
          type: "artifact_snapshot", requestId, threadId,
          ...this.artifactStore.snapshot(threadId),
        }, true);
        return;
      }
      case "createArtifactTicket": {
        let requestId;
        let artifactId;
        let purpose;
        try {
          requestId = validateShortString(message.requestId, "requestId", { max: 200 });
          artifactId = validateShortString(message.artifactId, "artifactId", { max: 100 });
          purpose = validateShortString(message.purpose, "purpose", { max: 20 });
        } catch {
          this.#sendArtifactError(client, {
            requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 200) : null,
            artifactId: typeof message.artifactId === "string" ? message.artifactId.slice(0, 100) : null,
            code: "artifact_invalid_request",
            message: "The artifact request is invalid.",
          });
          return;
        }
        if (!this.artifactsEnabled) {
          this.#sendArtifactError(client, { requestId, artifactId,
            code: "artifact_unavailable", message: "The artifact center is unavailable." });
          return;
        }
        const record = this.artifactStore.get(artifactId);
        if (!["preview", "download"].includes(purpose)
            || !record
            || record.threadId !== this.adapter.threadId
            || record.state !== "ready") {
          this.#sendArtifactError(client, { requestId, artifactId,
            code: "artifact_unavailable", message: "This artifact is not currently available." });
          return;
        }
        let release;
        let ticketIssued = false;
        try {
          const pin = await this.artifactStore.pin(artifactId);
          const rawRelease = typeof pin === "function" ? pin : pin?.release;
          const pinnedRecord = pin?.record ?? record;
          if (typeof rawRelease !== "function"
              || pinnedRecord.threadId !== this.adapter.threadId
              || pinnedRecord.state !== "ready") {
            throw new Error("artifact pin is unavailable");
          }
          release = asyncOnce(rawRelease);
          if (client.closed || client.ws.readyState !== WebSocket.OPEN) {
            await release();
            return;
          }
          const issued = this.artifactTickets.issue({
            artifactId,
            sha256: pinnedRecord.sha256,
            purpose,
            sessionId: client.sessionId,
            release,
          });
          ticketIssued = true;
          if (client.closed || client.ws.readyState !== WebSocket.OPEN) {
            this.#revokeClientTickets(client);
            return;
          }
          this.#send(client, {
            type: "artifact_access",
            requestId,
            artifactId,
            purpose,
            expiresAt: issued.expiresAt,
            url: `/api/artifacts/${encodeURIComponent(artifactId)}/content?ticket=${encodeURIComponent(issued.token)}`,
          }, true);
        } catch {
          if (ticketIssued) this.#revokeClientTickets(client);
          else if (release) {
            try { await release(); } catch { /* cleanup cannot reveal service details */ }
          }
          this.#sendArtifactError(client, { requestId, artifactId,
            code: "artifact_unavailable", message: "This artifact is not currently available." });
        }
        return;
      }
      case "renameConversation":
        await this.adapter.renameThread(
          validateShortString(message.threadId, "threadId", { max: 500 }),
          validateShortString(message.name, "name", { max: 500 }),
        );
        await this.#refreshConversations();
        return;
      case "archiveConversation":
        await this.adapter.archiveThread(validateShortString(message.threadId, "threadId", { max: 500 }));
        await this.#refreshConversations();
        return;
      case "refreshHistory": {
        if (!this.adapter.threadId) throw new Error("No active conversation");
        const history = await this.adapter.readThread(this.adapter.threadId);
        this.#replaceHistory(this.adapter.threadId, history.events ?? []);
        this.#broadcast({
          type: "history", threadId: this.adapter.threadId, events: safeWire(this.history),
        });
        return;
      }
      case "listModels": {
        const result = await this.adapter.listModels({ cursor: message.cursor, limit: 100 });
        this.#send(client, { type: "models", models: safeWire(result?.data ?? []), nextCursor: result?.nextCursor ?? null }, true);
        return;
      }
      case "listDir":
        await this.#listDirectory(client, message.path ?? this.adapter.cwd);
        return;
      case "mkdir": {
        const directory = await this.#workspacePath(
          validateShortString(message.path, "path", { max: 32_768 }),
          { allowMissing: true },
        );
        await fs.promises.mkdir(directory, { recursive: false });
        await this.#listDirectory(client, path.dirname(directory));
        return;
      }
      case "screenshot": {
        if (!this.windowsRemote?.capture) throw new Error("Screen capture is unavailable");
        const jpeg = Buffer.from(await this.windowsRemote.capture());
        if (jpeg.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot is too large");
        this.#send(client, { type: "screenshot", data: `data:image/jpeg;base64,${jpeg.toString("base64")}` }, true);
        return;
      }
      case "control": {
        if (!this.windowsRemote?.control) throw new Error("Desktop control is unavailable");
        const { type: _ignored, ...control } = message;
        const result = await this.windowsRemote.control(safeWire(control));
        this.#send(client, { type: "control_result", ...(safeWire(result) ?? {}) }, true);
        return;
      }
      default:
        throw new Error(`Unsupported message type: ${type}`);
    }
  }

  async #workspacePath(value, { allowMissing = false } = {}) {
    const workspace = await fs.promises.realpath(this.adapter.cwd);
    const requested = path.resolve(value);
    let resolved;
    if (allowMissing) {
      const parent = await fs.promises.realpath(path.dirname(requested));
      resolved = path.join(parent, path.basename(requested));
    } else {
      resolved = await fs.promises.realpath(requested);
    }
    if (!isWithin(workspace, resolved)) throw new Error("Path is outside the current workspace");
    return resolved;
  }

  async #listDirectory(client, directoryValue) {
    const requested = validateShortString(directoryValue, "path", { max: 32_768 });
    const directory = await this.#workspacePath(requested);
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const limited = entries.slice(0, 500).map((entry) => ({
      name: entry.name,
      path: path.join(directory, entry.name),
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
    this.#send(client, { type: "directory", path: directory, entries: limited }, true);
  }

  async #refreshConversations() {
    const result = await this.adapter.listThreads({ limit: 50 });
    this.#broadcast(conversationEvent(result));
  }

  #subscribeAdapter() {
    if (this.unsubscribe) return;
    const listener = (event) => this.#acceptAdapterEvent(event);
    if (typeof this.adapter.subscribePhoneEvents === "function") {
      this.unsubscribe = this.adapter.subscribePhoneEvents(listener);
    } else if (typeof this.adapter.on === "function") {
      this.adapter.on("phoneEvent", listener);
      this.unsubscribe = () => this.adapter.off("phoneEvent", listener);
    } else {
      throw new TypeError("adapter does not expose phone event subscription");
    }
  }

  broadcast(event) {
    this.#acceptAdapterEvent(event);
  }

  #broadcastSystemState() {
    this.visibleThreadId = this.adapter.threadId ?? null;
    this.#broadcast(systemState(this.adapter));
  }

  #syncThreadSystemState() {
    if ((this.adapter.threadId ?? null) === this.visibleThreadId) return;
    this.#broadcastSystemState();
  }

  #acceptAdapterEvent(event) {
    this.#syncThreadSystemState();
    const activeThreadId = this.adapter.threadId ?? null;
    if (activeThreadId && activeThreadId !== this.historyThreadId) {
      const preserveRestartHistory = event?.type === "notice"
        && event?.code === "app_server_recovered"
        && event?.preserveHistory === true
        && event?.previousThreadId === this.historyThreadId
        && event?.threadId === activeThreadId;
      if (preserveRestartHistory) this.historyThreadId = activeThreadId;
      else this.#replaceHistory(activeThreadId, []);
    }
    const clean = safeWire(event);
    if (!clean || typeof clean !== "object") return;
    if (TRANSCRIPT_TYPES.has(clean.type) && wireBytes(clean) <= MAX_TRANSCRIPT_EVENT_BYTES) {
      this.history.push(clean);
      if (this.history.length > this.historyLimit) {
        this.history.splice(0, this.history.length - this.historyLimit);
      }
    }
    this.#broadcast(clean);
  }

  #replaceHistory(threadId, events) {
    this.historyThreadId = threadId ?? null;
    this.history = cleanHistory(events, this.historyLimit);
  }

  #broadcast(event) {
    for (const client of this.clients) this.#send(client, event);
  }

  #sendArtifactError(client, { requestId, artifactId, code, message }) {
    this.#send(client, { type: "artifact_error", requestId, artifactId, code, message }, true);
  }

  #revokeClientTickets(client) {
    if (client.ticketsRevoked) return;
    client.ticketsRevoked = true;
    try { this.artifactTickets?.revokeSession(client.sessionId); }
    catch (error) { this.#report(error); }
  }

  #send(client, event, force = false) {
    if (!force && !client.ready) {
      if (client.queued.length >= MAX_CLIENT_QUEUE) client.queued.shift();
      client.queued.push(event);
      return;
    }
    if (client.ws.readyState !== WebSocket.OPEN) return;
    let wire;
    try { wire = JSON.stringify(safeWire(event)); } catch (error) { this.#report(error); return; }
    const bytes = Buffer.byteLength(wire);
    if (bytes > MAX_OUTGOING_MESSAGE_BYTES
      || client.ws.bufferedAmount + bytes > MAX_BUFFERED_BYTES) {
      client.ws.close(1013, "Client is too slow");
      return;
    }
    try { client.ws.send(wire); } catch (error) { this.#report(error); }
  }

  #heartbeat() {
    for (const client of this.clients) {
      if (!client.alive) {
        client.closed = true;
        this.#revokeClientTickets(client);
        client.ws.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      try { client.ws.ping(); } catch (error) { this.#report(error); }
    }
  }

  #report(error) {
    try { this.onError(error); } catch { /* reporting must not break the service */ }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.#close();
    return this.closePromise;
  }

  async #close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeArtifacts?.();
    this.unsubscribeArtifacts = null;
    for (const client of this.clients) {
      client.closed = true;
      this.#revokeClientTickets(client);
      client.ws.terminate();
    }
    this.clients.clear();
    if (this.wss) await new Promise((resolve) => this.wss.close(() => resolve()));
    if (this.httpServer?.listening) {
      await new Promise((resolve, reject) => this.httpServer.close((error) => error ? reject(error) : resolve()));
    }
    if (this.ownAdapter && this.adapterStarted) await this.adapter.stop?.();
    this.adapterStarted = false;
  }
}

export async function createRemoteServer(options) {
  const remote = new RemoteServer(options);
  await remote.start();
  const host = remote.address?.address === "::" || remote.address?.address === "0.0.0.0"
    ? "127.0.0.1"
    : remote.address.address;
  const httpUrl = `http://${host}:${remote.address.port}`;
  return {
    token: remote.token,
    address: remote.address,
    httpUrl,
    wsUrl: httpUrl.replace(/^http/, "ws"),
    close: () => remote.close(),
    broadcast: (event) => remote.broadcast(event),
    once: (event, listener) => remote.once(event, listener),
    off: (event, listener) => remote.off(event, listener),
    instance: remote,
  };
}
