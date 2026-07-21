import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { main as startServer } from "../server.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ArtifactTicketStore } from "../src/artifact-tickets.js";
import { ArtifactTracker } from "../src/artifact-tracker.js";
import { CodexProcess } from "../src/codex-process.js";
import { CodexAdapter } from "../src/codex-adapter.js";
import { createRemoteServer } from "../src/remote-server.js";

const WAIT_MS = 5_000;
const TRANSCRIPT_TYPES = new Set([
  "user_echo", "assistant_delta", "assistant", "thinking_delta", "thinking",
  "plan_delta", "plan", "plan_text", "diff", "tool_use", "tool_delta",
  "tool_result", "file_change", "activity", "result", "notice", "error",
]);
const fixturePath = fileURLToPath(new URL("./fixtures/fake-app-server.js", import.meta.url));
const pendingArtifactFixturePath = fileURLToPath(
  new URL("./fixtures/pending-artifact-child.js", import.meta.url),
);

function withTimeout(promise, label, timeoutMs = WAIT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function waitForEvent(emitter, event, label, timeoutMs = WAIT_MS) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      if (event !== "error") emitter.off("error", onError);
    };
    const onEvent = (...args) => { cleanup(); resolve(args); };
    const onError = (error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    timer.unref?.();
    emitter.once(event, onEvent);
    if (event !== "error") emitter.once("error", onError);
  });
}

class JsonProbe {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = new Set();
    this.closed = false;
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      this.messages.push(message);
      for (const waiter of [...this.waiters]) this.#settle(waiter);
    });
    ws.on("close", () => {
      this.closed = true;
      for (const waiter of [...this.waiters]) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`socket closed while waiting for ${waiter.label}`));
      }
    });
  }

  waitFor(predicate, label, { after = 0, timeoutMs = WAIT_MS } = {}) {
    const existing = this.messages.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.closed) return Promise.reject(new Error(`socket closed while waiting for ${label}`));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, label, after, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  waitForCount(count, label) {
    return this.waitFor((_message, index) => index + 1 >= count, label);
  }

  #settle(waiter) {
    const match = this.messages.slice(waiter.after).find(waiter.predicate);
    if (!match) return;
    this.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(match);
  }
}

async function openPhone(wsUrl, token) {
  const ws = new WebSocket(`${wsUrl}/ws?token=${encodeURIComponent(token)}`);
  const probe = new JsonProbe(ws);
  await waitForEvent(ws, "open", "authenticated WebSocket open");
  return { ws, probe };
}

async function closePhone(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = waitForEvent(ws, "close", "WebSocket close");
  ws.close();
  await closed;
}

async function artifactRoots() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cr-artifact-e2e-"));
  return {
    root,
    workspace: path.join(root, "workspace"),
    vault: path.join(root, "vault"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function startArtifactRuntime(roots) {
  const store = await ArtifactStore.open({ root: roots.vault });
  const tracker = new ArtifactTracker({ store });
  const tickets = new ArtifactTicketStore();
  const codex = new CodexProcess({
    packageBin: fixturePath,
    env: { ...process.env, CODEX_BIN: "" },
  });
  const adapter = new CodexAdapter({
    process: codex,
    cwd: roots.workspace,
    artifactTracker: tracker,
  });
  const remote = await createRemoteServer({
    adapter,
    artifactStore: store,
    artifactTracker: tracker,
    artifactTickets: tickets,
    token: "artifact-restart-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
  });
  return { store, tracker, tickets, codex, adapter, remote };
}

async function stopArtifactRuntime(runtime) {
  if (!runtime) return;
  await runtime.remote.close();
  await runtime.tracker.close();
}

async function loadArtifactThread(phone, threadId) {
  const after = phone.probe.messages.length;
  phone.ws.send(JSON.stringify({ type: "loadConversation", threadId }));
  const [system, history] = await Promise.all([
    phone.probe.waitFor(
      (message) => message.type === "system_init" && message.threadId === threadId,
      `system state for ${threadId}`,
      { after },
    ),
    phone.probe.waitFor(
      (message) => message.type === "history" && message.threadId === threadId,
      `history for ${threadId}`,
      { after },
    ),
  ]);
  assert.ok(Array.isArray(history.events));
  return { system, history };
}

test("runs the authenticated phone-to-App-Server lifecycle over real JSONL and WebSocket streams", {
  timeout: 30_000,
}, async () => {
  const codex = new CodexProcess({
    packageBin: fixturePath,
    env: { ...process.env, CODEX_BIN: "" },
  });
  const adapter = new CodexAdapter({
    process: codex,
    cwd: path.resolve("."),
    model: "gpt-e2e",
    effort: "medium",
  });
  const errors = [];
  let remote;
  let phone;
  let reconnected;

  try {
    remote = await withTimeout(createRemoteServer({
      adapter,
      token: "e2e-secret-token",
      host: "127.0.0.1",
      port: 0,
      ownAdapter: true,
      onError: (error) => errors.push(error),
    }), "remote server startup");
    const child = codex.child;
    assert.ok(child?.pid, "CodexProcess should own a live child process");

    const unauthorized = new WebSocket(`${remote.wsUrl}/ws?token=wrong-token`);
    let unauthorizedMessages = 0;
    unauthorized.on("message", () => { unauthorizedMessages += 1; });
    const [closeCode] = await waitForEvent(unauthorized, "close", "unauthorized WebSocket rejection");
    assert.equal(closeCode, 4001);
    assert.equal(unauthorizedMessages, 0);

    phone = await openPhone(remote.wsUrl, remote.token);
    await phone.probe.waitForCount(4, "deterministic authenticated initialization");
    const initial = phone.probe.messages.slice(0, 4);
    assert.deepEqual(initial.map((message) => message.type), [
      "hello", "system_init", "history", "conversations",
    ]);
    assert.deepEqual(initial[2].events, []);
    assert.deepEqual(initial[3].conversations.map((thread) => thread.id), ["thread-e2e"]);

    const modelsStart = phone.probe.messages.length;
    phone.ws.send(JSON.stringify({ type: "listModels" }));
    const models = await phone.probe.waitFor(
      (message) => message.type === "models",
      "model/list response",
      { after: modelsStart },
    );
    assert.deepEqual(models.models.map((model) => model.id), ["gpt-e2e"]);

    const promptStart = phone.probe.messages.length;
    phone.ws.send(JSON.stringify({
      type: "prompt",
      requestId: "phone-prompt-1",
      text: "inspect the fixture",
    }));
    const approval = await phone.probe.waitFor(
      (message) => message.type === "permission_request",
      "command approval request",
      { after: promptStart },
    );
    const beforeApproval = phone.probe.messages.slice(promptStart);
    const beforeTypes = beforeApproval.map((message) => message.type);
    const userEchoIndex = beforeTypes.indexOf("user_echo");
    const streamIndex = beforeTypes.indexOf("assistant_delta");
    const approvalIndex = beforeTypes.indexOf("permission_request");
    assert.ok(beforeTypes.indexOf("prompt_queued") >= 0);
    assert.ok(userEchoIndex >= 0);
    assert.ok(streamIndex > userEchoIndex);
    assert.ok(approvalIndex > streamIndex);
    assert.equal(approval.kind, "command");
    assert.equal(approval.command, "fake-command --requires-approval");
    assert.doesNotMatch(JSON.stringify(approval), /rawParams|fixture-child-secret/);

    const decisionStart = phone.probe.messages.length;
    phone.ws.send(JSON.stringify({ type: "permission", id: approval.id, action: "deny" }));
    const [ack, toolResult, result] = await Promise.all([
      phone.probe.waitFor(
        (message) => message.type === "permission_ack" && message.id === approval.id,
        "permission acknowledgement",
        { after: decisionStart },
      ),
      phone.probe.waitFor(
        (message) => message.type === "tool_result" && message.toolUseId === "command-1",
        "tool result emitted after child receives the approval response",
        { after: decisionStart },
      ),
      phone.probe.waitFor(
        (message) => message.type === "result",
        "completed turn result",
        { after: decisionStart },
      ),
    ]);
    assert.equal(ack.accepted, true);
    assert.equal(toolResult.content, "approval-response:decline");
    assert.equal(toolResult.isError, true);
    assert.equal(result.status, "completed");

    const allowPromptStart = phone.probe.messages.length;
    phone.ws.send(JSON.stringify({
      type: "prompt",
      requestId: "phone-prompt-2",
      text: "allow the fixture",
    }));
    const allowedApproval = await phone.probe.waitFor(
      (message) => message.type === "permission_request" && message.id !== approval.id,
      "second command approval request",
      { after: allowPromptStart },
    );
    const allowDecisionStart = phone.probe.messages.length;
    phone.ws.send(JSON.stringify({ type: "permission", id: allowedApproval.id, action: "allow" }));
    const [allowAck, allowedToolResult, allowedResult] = await Promise.all([
      phone.probe.waitFor(
        (message) => message.type === "permission_ack" && message.id === allowedApproval.id,
        "allow permission acknowledgement",
        { after: allowDecisionStart },
      ),
      phone.probe.waitFor(
        (message) => message.type === "tool_result" && message.toolUseId === "command-2",
        "tool result emitted after child receives the allow response",
        { after: allowDecisionStart },
      ),
      phone.probe.waitFor(
        (message) => message.type === "result",
        "allowed turn result",
        { after: allowDecisionStart },
      ),
    ]);
    assert.equal(allowAck.accepted, true);
    assert.equal(allowedToolResult.content, "approval-response:accept");
    assert.equal(allowedToolResult.isError, false);
    assert.equal(allowedResult.status, "completed");

    await closePhone(phone.ws);
    const canonicalHistory = phone.probe.messages
      .slice(4)
      .filter((message) => TRANSCRIPT_TYPES.has(message.type));
    phone = null;

    reconnected = await openPhone(remote.wsUrl, remote.token);
    await reconnected.probe.waitForCount(4, "reconnect initialization");
    const restored = reconnected.probe.messages.slice(0, 4);
    assert.deepEqual(restored.map((message) => message.type), [
      "hello", "system_init", "history", "conversations",
    ]);
    assert.equal(restored[1].threadId, "thread-e2e");
    assert.deepEqual(restored[2].events, canonicalHistory);
    assert.doesNotMatch(JSON.stringify(restored[2]), /rawParams|fixture-child-secret|e2e-secret-token/);

    const oldChildPid = codex.child?.pid;
    const crashStart = reconnected.probe.messages.length;
    const childExit = waitForEvent(codex, "exit", "fixture App Server crash");
    reconnected.ws.send(JSON.stringify({
      type: "prompt",
      requestId: "phone-crash-1",
      text: "__E2E_CRASH_APP_SERVER__",
    }));
    await reconnected.probe.waitFor(
      (message) => message.type === "prompt_queued" && message.requestId === "phone-crash-1",
      "crash prompt acknowledgement",
      { after: crashStart },
    );
    const [crashCode] = await childExit;
    assert.equal(crashCode, 86);
    const crashError = await reconnected.probe.waitFor(
      (message) => message.type === "error",
      "crashed prompt rejection",
      { after: crashStart },
    );
    assert.match(crashError.message, /exited|closed|restart/i);
    const recovered = await reconnected.probe.waitFor(
      (message) => message.type === "notice"
        && message.code === "app_server_recovered"
        && message.resumed === true,
      "App Server restart and thread resume",
      { after: crashStart },
    );
    assert.equal(recovered.threadId, "thread-e2e");
    assert.notEqual(codex.child?.pid, oldChildPid);
    assert.equal(reconnected.ws.readyState, WebSocket.OPEN);
    assert.equal(reconnected.probe.messages.filter((message) => message.type === "hello").length, 1);
    assert.ok(reconnected.probe.messages.slice(crashStart).some(
      (message) => message.type === "system_init" && message.appServerStatus === "restarting",
    ));
    assert.ok(reconnected.probe.messages.slice(crashStart).some(
      (message) => message.type === "system_init" && message.appServerStatus === "online",
    ));

    const continuedStart = reconnected.probe.messages.length;
    reconnected.ws.send(JSON.stringify({
      type: "prompt",
      requestId: "phone-prompt-after-restart",
      text: "continue after restart",
    }));
    const continuedApproval = await reconnected.probe.waitFor(
      (message) => message.type === "permission_request",
      "post-restart command approval",
      { after: continuedStart },
    );
    const continuedDecisionStart = reconnected.probe.messages.length;
    reconnected.ws.send(JSON.stringify({
      type: "permission",
      id: continuedApproval.id,
      action: "allow",
    }));
    const [continuedAck, continuedTool, continuedResult] = await Promise.all([
      reconnected.probe.waitFor(
        (message) => message.type === "permission_ack" && message.id === continuedApproval.id,
        "post-restart permission acknowledgement",
        { after: continuedDecisionStart },
      ),
      reconnected.probe.waitFor(
        (message) => message.type === "tool_result" && message.content === "approval-response:accept",
        "post-restart tool result",
        { after: continuedDecisionStart },
      ),
      reconnected.probe.waitFor(
        (message) => message.type === "result" && message.status === "completed",
        "post-restart completed turn",
        { after: continuedDecisionStart },
      ),
    ]);
    assert.equal(continuedAck.accepted, true);
    assert.equal(continuedTool.isError, false);
    assert.equal(continuedResult.status, "completed");
    assert.doesNotMatch(
      JSON.stringify(reconnected.probe.messages.slice(crashStart)),
      /rawParams|fixture-child-secret|e2e-secret-token/,
    );

    const renameStart = reconnected.probe.messages.length;
    reconnected.ws.send(JSON.stringify({
      type: "renameConversation",
      threadId: "thread-e2e",
      name: "Renamed E2E fixture",
    }));
    const renamed = await reconnected.probe.waitFor(
      (message) => message.type === "conversations"
        && message.conversations?.[0]?.name === "Renamed E2E fixture",
      "renamed conversation refresh",
      { after: renameStart },
    );
    assert.deepEqual(renamed.conversations.map((thread) => thread.id), ["thread-e2e"]);

    const archiveStart = reconnected.probe.messages.length;
    reconnected.ws.send(JSON.stringify({ type: "archiveConversation", threadId: "thread-e2e" }));
    const archived = await reconnected.probe.waitFor(
      (message) => message.type === "conversations" && message.conversations?.length === 0,
      "archived conversation refresh",
      { after: archiveStart },
    );
    assert.deepEqual(archived.conversations, []);

    await closePhone(reconnected.ws);
    reconnected = null;
    const finalChild = codex.child;
    assert.ok(finalChild?.pid, "recovered App Server child should still be owned before shutdown");
    const childClosed = waitForEvent(finalChild, "close", "owned App Server child cleanup");
    await withTimeout(remote.close(), "remote server shutdown");
    remote = null;
    const [exitCode, signal] = await childClosed;
    assert.equal(codex.child, null);
    assert.equal(finalChild.killed, true);
    assert.ok(exitCode !== null || signal !== null);
    assert.deepEqual(errors, []);
  } finally {
    phone?.ws.terminate();
    reconnected?.ws.terminate();
    if (remote) await withTimeout(remote.close(), "remote server cleanup");
  }
});

test("discovers and downloads a command-created artifact without fileChange notifications", {
  timeout: 30_000,
}, async (t) => {
  const roots = await artifactRoots();
  let tracker = null;
  let remote = null;
  let phone = null;
  let reconnected = null;
  t.after(async () => {
    await closePhone(phone?.ws).catch(() => undefined);
    await closePhone(reconnected?.ws).catch(() => undefined);
    await remote?.close().catch(() => undefined);
    await tracker?.close().catch(() => undefined);
    await roots.cleanup();
  });

  await fs.mkdir(roots.workspace);
  const store = await ArtifactStore.open({ root: roots.vault });
  tracker = new ArtifactTracker({ store });
  const tickets = new ArtifactTicketStore();
  const codex = new CodexProcess({
    packageBin: fixturePath,
    env: { ...process.env, CODEX_BIN: "" },
  });
  const adapter = new CodexAdapter({
    process: codex,
    cwd: roots.workspace,
    artifactTracker: tracker,
  });
  remote = await createRemoteServer({
    adapter,
    artifactStore: store,
    artifactTracker: tracker,
    artifactTickets: tickets,
    token: "artifact-e2e-token",
    host: "127.0.0.1",
    port: 0,
    ownAdapter: true,
  });
  phone = await openPhone(remote.wsUrl, remote.token);

  const after = phone.probe.messages.length;
  phone.ws.send(JSON.stringify({
    type: "prompt",
    requestId: "artifact-prompt",
    text: "__E2E_WRITE_ARTIFACT__",
  }));
  const [system, update, result] = await Promise.all([
    phone.probe.waitFor(
      (message) => message.type === "system_init" && message.threadId === "thread-e2e",
      "first task system state",
      { after },
    ),
    phone.probe.waitFor(
      (message) => message.type === "artifact_update"
        && message.complete
        && message.records.some((record) => record.relativePath === "output/e2e-artifact.txt"),
      "artifact update",
      { after, timeoutMs: 15_000 },
    ),
    phone.probe.waitFor(
      (message) => message.type === "result" && message.status === "completed",
      "artifact turn completion",
      { after, timeoutMs: 15_000 },
    ),
  ]);
  assert.ok(
    phone.probe.messages.indexOf(system) < phone.probe.messages.indexOf(update),
    "system_init for the auto-created thread must precede its artifact update",
  );
  assert.equal(result.status, "completed");

  const record = update.records.find(
    (item) => item.relativePath === "output/e2e-artifact.txt",
  );
  assert.equal(record.kind, "created");
  assert.ok(record.provenance.includes("snapshot"));
  assert.equal(record.provenance.includes("appServer"), false);

  const ticketStart = phone.probe.messages.length;
  phone.ws.send(JSON.stringify({
    type: "createArtifactTicket",
    requestId: "download-1",
    artifactId: record.id,
    purpose: "download",
  }));
  const access = await phone.probe.waitFor(
    (message) => message.type === "artifact_access" && message.requestId === "download-1",
    "artifact access",
    { after: ticketStart },
  );
  assert.equal(access.url.includes(remote.token), false);
  const response = await fetch(new URL(access.url, remote.httpUrl));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(bytes.toString("utf8"), "artifact from fake app server\n");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);

  await closePhone(phone.ws);
  phone = null;
  reconnected = await openPhone(remote.wsUrl, remote.token);
  const requestStart = reconnected.probe.messages.length;
  reconnected.ws.send(JSON.stringify({
    type: "listArtifacts",
    requestId: "snapshot-2",
    threadId: record.threadId,
  }));
  const snapshot = await reconnected.probe.waitFor(
    (message) => message.type === "artifact_snapshot" && message.requestId === "snapshot-2",
    "artifact snapshot",
    { after: requestStart },
  );
  assert.ok(snapshot.records.some((item) => item.id === record.id));
});

test("restores artifact metadata and bytes through service and App Server restarts", {
  timeout: 30_000,
}, async (t) => {
  const roots = await artifactRoots();
  let first = null;
  let firstPhone = null;
  let second = null;
  let secondPhone = null;
  t.after(async () => {
    await closePhone(firstPhone?.ws).catch(() => undefined);
    await closePhone(secondPhone?.ws).catch(() => undefined);
    await stopArtifactRuntime(first).catch(() => undefined);
    await stopArtifactRuntime(second).catch(() => undefined);
    await roots.cleanup();
  });

  await fs.mkdir(roots.workspace);
  const source = path.join(roots.workspace, "restored.txt");
  await fs.writeFile(source, "restored");
  const seed = await ArtifactStore.open({ root: roots.vault });
  const record = await seed.ingest({
    sourcePath: source,
    workspaceRealPath: roots.workspace,
    threadId: "thread-e2e",
    turnId: "turn-restart",
    relativePath: "restored.txt",
    kind: "created",
    provenance: ["snapshot"],
    detectedAt: new Date().toISOString(),
  });
  await seed.finalizeTurn({
    threadId: "thread-e2e",
    turnId: "turn-restart",
    workspaceRealPath: roots.workspace,
    complete: true,
  });

  first = await startArtifactRuntime(roots);
  firstPhone = await openPhone(first.remote.wsUrl, first.remote.token);
  await firstPhone.probe.waitForCount(4, "first service initialization");
  assert.equal((await loadArtifactThread(firstPhone, "thread-e2e")).system.threadId, "thread-e2e");

  const firstStart = firstPhone.probe.messages.length;
  firstPhone.ws.send(JSON.stringify({
    type: "listArtifacts",
    requestId: "before-service-restart",
    threadId: "thread-e2e",
  }));
  const beforeRestart = await firstPhone.probe.waitFor(
    (message) => message.type === "artifact_snapshot"
      && message.requestId === "before-service-restart",
    "artifact snapshot before restart",
    { after: firstStart },
  );
  assert.equal(beforeRestart.complete, true);
  assert.equal(beforeRestart.records.find((item) => item.id === record.id)?.sha256, record.sha256);
  await closePhone(firstPhone.ws);
  firstPhone = null;
  await stopArtifactRuntime(first);
  first = null;

  second = await startArtifactRuntime(roots);
  secondPhone = await openPhone(second.remote.wsUrl, second.remote.token);
  await secondPhone.probe.waitForCount(4, "service restart initialization");
  const selected = await loadArtifactThread(secondPhone, "thread-e2e");
  assert.equal(selected.system.threadId, "thread-e2e");
  const listStart = secondPhone.probe.messages.length;
  secondPhone.ws.send(JSON.stringify({
    type: "listArtifacts",
    requestId: "after-service-restart",
    threadId: "thread-e2e",
  }));
  const restored = await secondPhone.probe.waitFor(
    (message) => message.type === "artifact_snapshot"
      && message.requestId === "after-service-restart",
    "artifact snapshot after service restart",
    { after: listStart },
  );
  assert.equal(restored.threadId, "thread-e2e");
  assert.equal(restored.records.find((item) => item.id === record.id)?.sha256, record.sha256);

  const crashStart = secondPhone.probe.messages.length;
  secondPhone.ws.send(JSON.stringify({
    type: "prompt",
    requestId: "artifact-crash",
    text: "__E2E_CRASH_APP_SERVER__",
  }));
  await secondPhone.probe.waitFor(
    (message) => message.type === "notice"
      && message.code === "app_server_recovered"
      && message.resumed === true,
    "App Server recovery with the same thread",
    { after: crashStart, timeoutMs: 15_000 },
  );
  const recoveredStart = secondPhone.probe.messages.length;
  secondPhone.ws.send(JSON.stringify({
    type: "listArtifacts",
    requestId: "after-app-server-restart",
    threadId: "thread-e2e",
  }));
  const recovered = await secondPhone.probe.waitFor(
    (message) => message.type === "artifact_snapshot"
      && message.requestId === "after-app-server-restart",
    "artifact snapshot after App Server recovery",
    { after: recoveredStart },
  );
  assert.ok(recovered.records.some((item) => item.id === record.id));

  const ticketStart = secondPhone.probe.messages.length;
  secondPhone.ws.send(JSON.stringify({
    type: "createArtifactTicket",
    requestId: "restart-download",
    artifactId: record.id,
    purpose: "download",
  }));
  const access = await secondPhone.probe.waitFor(
    (message) => message.type === "artifact_access"
      && message.requestId === "restart-download",
    "fresh ticket after restart",
    { after: ticketStart },
  );
  assert.equal(access.url.includes(second.remote.token), false);
  const response = await fetch(new URL(access.url, second.remote.httpUrl));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(bytes.toString("utf8"), "restored");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
});

test("production startup recovers a pending turn left by a dead service process", {
  timeout: 30_000,
}, async (t) => {
  const roots = await artifactRoots();
  let runtime = null;
  let phone = null;
  t.after(async () => {
    await closePhone(phone?.ws).catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await roots.cleanup();
  });

  await fs.mkdir(roots.workspace);
  const child = spawnSync(
    process.execPath,
    [pendingArtifactFixturePath, roots.workspace, roots.vault],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
  assert.equal(child.signal, null, child.stderr || child.stdout);
  assert.equal(child.status, 0, child.stderr || child.stdout);

  const errors = [];
  runtime = await startServer({
    env: {
      ...process.env,
      CODEX_BIN: "",
      NO_TUNNEL: "1",
      LOCALAPPDATA: roots.root,
    },
    platform: "linux",
    installSignalHandlers: false,
    log: () => {},
    error: (value) => errors.push(String(value?.message || value)),
    qrGenerate: (_url, _options, callback) => callback("fixture-qr"),
    loadConfigImpl: () => ({
      token: "pending-recovery-token",
      port: 0,
      cwd: roots.workspace,
      model: "gpt-e2e",
      effort: "medium",
      rendezvous: null,
    }),
    createCodexProcess: () => new CodexProcess({
      packageBin: fixturePath,
      env: { ...process.env, CODEX_BIN: "" },
    }),
    createArtifactStore: () => ArtifactStore.open({ root: roots.vault }),
    createArtifactTracker: (settings) => new ArtifactTracker(settings),
    createArtifactTickets: () => new ArtifactTicketStore(),
  });
  phone = await openPhone(runtime.wsUrl, runtime.token);
  await phone.probe.waitForCount(4, "production recovery initialization");
  await loadArtifactThread(phone, "thread-e2e");

  const listStart = phone.probe.messages.length;
  phone.ws.send(JSON.stringify({
    type: "listArtifacts",
    requestId: "pending-recovery-list",
    threadId: "thread-e2e",
  }));
  const snapshot = await phone.probe.waitFor(
    (message) => message.type === "artifact_snapshot"
      && message.requestId === "pending-recovery-list",
    "recovered pending artifact snapshot",
    { after: listStart },
  );
  const record = snapshot.records.find((item) => item.relativePath === "late.txt");
  assert.equal(record?.state, "ready");
  assert.ok(snapshot.diagnostics.some((item) => item.code === "recovered_after_restart"));
  assert.equal(
    errors.some((line) => /pending workspace.*unavailable|冻结工作区.*不可用/i.test(line)),
    false,
  );

  const ticketStart = phone.probe.messages.length;
  phone.ws.send(JSON.stringify({
    type: "createArtifactTicket",
    requestId: "pending-recovery-download",
    artifactId: record.id,
    purpose: "download",
  }));
  const access = await phone.probe.waitFor(
    (message) => message.type === "artifact_access"
      && message.requestId === "pending-recovery-download",
    "ticket for recovered pending artifact",
    { after: ticketStart },
  );
  const response = await fetch(new URL(access.url, runtime.httpUrl));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(bytes.toString("utf8"), "late from crashed service\n");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
});

test("previews UTF-16LE and UTF-16BE text using the trusted response charset", async (t) => {
  const roots = await artifactRoots();
  t.after(() => roots.cleanup());
  await fs.mkdir(roots.workspace);
  const littlePath = path.join(roots.workspace, "little.txt");
  const bigPath = path.join(roots.workspace, "big.txt");
  await fs.writeFile(littlePath, Buffer.from([0xff, 0xfe, 0x2d, 0x4e]));
  await fs.writeFile(bigPath, Buffer.from([0xfe, 0xff, 0x4e, 0x2d]));
  const store = await ArtifactStore.open({ root: roots.vault });
  const base = {
    workspaceRealPath: roots.workspace,
    threadId: "thread-utf",
    turnId: "turn-utf",
    kind: "created",
    provenance: ["snapshot"],
    detectedAt: new Date().toISOString(),
  };
  const little = await store.ingest({
    ...base,
    sourcePath: littlePath,
    relativePath: "little.txt",
  });
  const big = await store.ingest({
    ...base,
    sourcePath: bigPath,
    relativePath: "big.txt",
  });
  assert.equal(little.mime, "text/plain; charset=utf-16le");
  assert.equal(big.mime, "text/plain; charset=utf-16be");
  assert.equal(Object.hasOwn(little, "encoding"), false);
  assert.equal(Object.hasOwn(big, "encoding"), false);
  assert.equal(
    new TextDecoder("utf-16le").decode(await fs.readFile(littlePath)).includes("中"),
    true,
  );
  assert.equal(
    new TextDecoder("utf-16be").decode(await fs.readFile(bigPath)).includes("中"),
    true,
  );
});
