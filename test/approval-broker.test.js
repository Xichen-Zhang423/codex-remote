import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalBroker } from "../src/approval-broker.js";

const COMMAND = "item/commandExecution/requestApproval";
const FILE = "item/fileChange/requestApproval";
const USER_INPUT = "item/tool/requestUserInput";
const PERMISSIONS = "item/permissions/requestApproval";
const MCP_ELICITATION = "mcpServer/elicitation/request";

function makeBroker() {
  const events = [];
  const broker = new ApprovalBroker({ emit: (event) => events.push(event) });
  return { broker, events };
}

test("maps phone decisions to exact command and file approval payloads", async () => {
  const { broker, events } = makeBroker();
  const commandReplies = [];
  const fileReplies = [];
  const commandId = broker.register({
    rpcId: 10,
    method: COMMAND,
    params: { itemId: "c1", turnId: "t1", command: "npm test" },
    respond: (value) => commandReplies.push(value),
  });
  const fileId = broker.register({
    rpcId: 11,
    method: FILE,
    params: { itemId: "f1", turnId: "t1" },
    respond: (value) => fileReplies.push(value),
  });
  assert.notEqual(commandId, fileId);
  assert.equal(broker.pendingCount, 2);
  assert.equal(await broker.decide(commandId, "allow"), true);
  assert.equal(await broker.decide(fileId, "deny"), true);
  assert.deepEqual(commandReplies, [{ decision: "accept" }]);
  assert.deepEqual(fileReplies, [{ decision: "decline" }]);
  assert.equal(broker.pendingCount, 0);
  assert.equal(events.filter((event) => event.type === "permission_closed").length, 2);
  assert.equal(await broker.decide(commandId, "allow"), false);
});

test("supports explicit session allow and cancellation for command approvals", async () => {
  const { broker } = makeBroker();
  const replies = [];
  const first = broker.register({
    method: COMMAND,
    params: { command: "Get-Content README.md", commandActions: [{ type: "read" }] },
    respond: (value) => replies.push(value),
  });
  const second = broker.register({ method: COMMAND, params: {}, respond: (value) => replies.push(value) });
  await broker.decide(first, "allowSession");
  await broker.decide(second, "cancel");
  assert.deepEqual(replies, [
    { decision: "acceptForSession" },
    { decision: "cancel" },
  ]);
  const unsafe = broker.register({
    method: COMMAND,
    params: { command: "git clean -fdx", commandActions: [{ type: "unknown" }] },
    respond: (value) => replies.push(value),
  });
  assert.equal(await broker.decide(unsafe, "allowSession"), false);
  assert.equal(broker.pendingCount, 1);
  assert.equal(await broker.decide(unsafe, "deny"), true);
  assert.deepEqual(replies[2], { decision: "decline" });
});

test("session auto starts disabled, auto-accepts only proven read actions, and stays conservative", async () => {
  const { broker } = makeBroker();
  assert.equal(broker.sessionAuto, false);
  assert.equal(new ApprovalBroker({ emit: () => {} }).sessionAuto, false);
  broker.setSessionAuto(true);
  assert.equal(broker.sessionAuto, true);
  assert.equal(broker.shouldAutoAccept({ method: FILE, params: {} }), false);
  assert.equal(broker.shouldAutoAccept({ method: COMMAND, params: { command: "npm test" } }), false);
  assert.equal(broker.shouldAutoAccept({
    method: COMMAND,
    params: { command: "Get-Content README.md", commandActions: [{ type: "read" }] },
  }), true);
  for (const request of [
    { method: USER_INPUT, params: {} },
    { method: PERMISSIONS, params: {} },
    { method: MCP_ELICITATION, params: {} },
    { method: COMMAND, params: { destructive: true } },
    { method: COMMAND, params: { command: "git reset --hard" } },
    { method: COMMAND, params: { networkApprovalContext: { host: "example.com" } } },
    { method: FILE, params: { grantRoot: "D:\\outside" } },
  ]) assert.equal(broker.shouldAutoAccept(request), false);

  const replies = [];
  const id = broker.register({
    method: COMMAND,
    params: {
      itemId: "safe",
      command: "Get-Content README.md",
      commandActions: [{ type: "read" }],
    },
    respond: (value) => replies.push(value),
  });
  assert.deepEqual(replies, [{ decision: "acceptForSession" }]);
  assert.equal(broker.pendingCount, 0);
  assert.equal(await broker.decide(id, "deny"), false);
  broker.setSessionAuto(false);
  assert.equal(broker.sessionAuto, false);
});

test("emits bounded, JSON-safe summaries without exposing raw params", async () => {
  const { broker, events } = makeBroker();
  const circular = { visible: "ok", rawSecret: "do-not-leak" };
  circular.self = circular;
  broker.register({
    method: COMMAND,
    params: {
      itemId: "c1",
      turnId: "t1",
      command: "x".repeat(20_000),
      cwd: "D:\\repo",
      reason: "network access",
      networkApprovalContext: { host: "api.example.com", port: 443 },
      internal: circular,
    },
    respond: () => {},
  });
  broker.register({
    method: FILE,
    params: { itemId: "f1", grantRoot: "D:\\extra", reason: "write output" },
    respond: () => {},
  });
  broker.register({
    method: USER_INPUT,
    params: { itemId: "q1", questions: [{ id: "mode", header: "Mode", question: "Choose", options: [{ label: "Safe", description: "No writes" }] }] },
    respond: () => {},
  });
  broker.register({
    method: PERMISSIONS,
    params: { itemId: "p1", cwd: "D:\\repo", permissions: { network: { enabled: true } } },
    respond: () => {},
  });

  const requests = events.filter((event) => event.type === "permission_request");
  assert.equal(requests.length, 4);
  for (const event of requests) {
    assert.equal("params" in event, false);
    assert.doesNotThrow(() => JSON.stringify(event));
    assert.doesNotMatch(JSON.stringify(event), /do-not-leak|rawSecret|internal/);
  }
  assert.ok(requests[0].command.length <= 12_000);
  assert.equal(requests[0].networkTarget, "api.example.com:443");
  assert.equal(requests[1].grantRoot, "D:\\extra");
  assert.equal(requests[2].questions[0].options[0].label, "Safe");
  assert.deepEqual(requests[3].permissions, { network: { enabled: true } });
});

test("normalizes user-input answers to the pinned App Server response schema", async () => {
  const { broker } = makeBroker();
  const replies = [];
  const id = broker.register({
    method: USER_INPUT,
    params: { questions: [
      { id: "mode", question: "Mode", options: [{ label: "Safe", description: "" }] },
      { id: "note", question: "Note", isOther: true },
    ] },
    respond: (value) => replies.push(value),
  });
  await broker.decide(id, "answer", { answers: {
    mode: { answers: ["Safe"] },
    note: ["custom"],
    unknown: { answers: ["drop"] },
  } });
  assert.deepEqual(replies, [{ answers: {
    mode: { answers: ["Safe"] },
    note: { answers: ["custom"] },
  } }]);
});

test("handles MCP form and URL elicitations with the pinned response schema", async () => {
  const { broker, events } = makeBroker();
  const replies = [];
  const formId = broker.register({
    method: MCP_ELICITATION,
    params: {
      serverName: "payments",
      turnId: "t1",
      mode: "form",
      message: "Confirm invoice",
      requestedSchema: {
        type: "object",
        properties: { approved: { type: "boolean", title: "Approve" } },
        required: ["approved"],
      },
      _meta: { rawSecret: "never expose" },
    },
    respond: (value) => replies.push(value),
  });
  const request = events.find((event) => event.id === formId);
  assert.equal(request.kind, "mcp_elicitation");
  assert.equal(request.serverName, "payments");
  assert.equal(request.message, "Confirm invoice");
  assert.equal("params" in request, false);
  assert.doesNotMatch(JSON.stringify(request), /rawSecret|never expose/);
  assert.equal(await broker.decide(formId, "answer", { content: { approved: true } }), true);
  assert.deepEqual(replies[0], { action: "accept", content: { approved: true } });

  const urlId = broker.register({
    method: MCP_ELICITATION,
    params: { serverName: "oauth", mode: "url", message: "Sign in", url: "https://example.com/auth" },
    respond: (value) => replies.push(value),
  });
  assert.equal(await broker.decide(urlId, "deny"), true);
  assert.deepEqual(replies[1], { action: "decline" });

  const cancelId = broker.register({
    method: MCP_ELICITATION,
    params: { serverName: "oauth", mode: "url", message: "Sign in", url: "https://example.com/auth" },
    respond: (value) => replies.push(value),
  });
  assert.equal(await broker.decide(cancelId, "cancel"), true);
  assert.deepEqual(replies[2], { action: "cancel" });
});

test("permission grants are restricted to the requested subset", async () => {
  const { broker } = makeBroker();
  const replies = [];
  const entry = { access: "write", path: { type: "path", path: "D:\\repo\\out" } };
  const evil = { access: "write", path: { type: "path", path: "C:\\Windows" } };
  const id = broker.register({
    method: PERMISSIONS,
    params: { permissions: {
      fileSystem: { read: ["D:\\repo"], write: ["D:\\repo\\out"], entries: [entry] },
      network: { enabled: true },
    } },
    respond: (value) => replies.push(value),
  });
  await broker.decide(id, "grant", {
    permissions: {
      fileSystem: {
        read: ["D:\\repo", "C:\\secret"],
        write: ["D:\\repo\\out"],
        entries: [entry, evil],
      },
      network: { enabled: true },
      admin: true,
    },
    scope: "session",
    strictAutoReview: true,
  });
  assert.deepEqual(replies, [{
    permissions: {
      fileSystem: { read: ["D:\\repo"], write: ["D:\\repo\\out"], entries: [entry] },
      network: { enabled: true },
    },
    scope: "session",
    strictAutoReview: true,
  }]);
});

test("turn completion and process exit safely resolve every matching request", async () => {
  const { broker, events } = makeBroker();
  const replies = [];
  const register = (method, turnId) => broker.register({
    method, params: { turnId, questions: [{ id: "q", question: "?" }], permissions: {} },
    respond: (value) => replies.push([method, value]),
  });
  register(COMMAND, "t1");
  register(USER_INPUT, "t1");
  register(PERMISSIONS, "t2");
  assert.equal(await broker.clear({ turnId: "t1", reason: "turn_completed" }), 2);
  assert.equal(broker.pendingCount, 1);
  assert.deepEqual(replies.slice(0, 2), [
    [COMMAND, { decision: "decline" }],
    [USER_INPUT, { answers: {} }],
  ]);
  assert.equal(await broker.close("app_server_exit"), 1);
  assert.deepEqual(replies[2], [PERMISSIONS, { permissions: {}, scope: "turn" }]);
  assert.equal(broker.pendingCount, 0);
  const closed = events.filter((event) => event.type === "permission_closed");
  assert.equal(closed.length, 3);
  assert.deepEqual(closed.map((event) => event.reason), ["turn_completed", "turn_completed", "app_server_exit"]);
});

test("registration snapshots params to prevent approval and cleanup races", async () => {
  const { broker } = makeBroker();
  const replies = [];
  const params = {
    turnId: "original",
    permissions: { fileSystem: { write: ["D:\\repo"] } },
  };
  const id = broker.register({
    method: PERMISSIONS,
    params,
    respond: (value) => replies.push(value),
  });
  params.turnId = "mutated";
  params.permissions.fileSystem.write.push("C:\\Windows");
  assert.equal(await broker.decide(id, "grant", {
    permissions: { fileSystem: { write: ["D:\\repo", "C:\\Windows"] } },
  }), true);
  assert.deepEqual(replies[0].permissions, {
    fileSystem: { write: ["D:\\repo"] },
  });

  const kept = broker.register({
    method: COMMAND,
    params: { turnId: "original", command: "npm test" },
    respond: (value) => replies.push(value),
  });
  assert.equal(await broker.clear({ turnId: "mutated" }), 0);
  assert.equal(broker.pendingCount, 1);
  assert.equal(await broker.clear({ turnId: "original" }), 1);
  assert.equal(await broker.decide(kept, "allow"), false);
});

test("waits for async responders before emitting permission_closed", async () => {
  const { broker, events } = makeBroker();
  let release;
  const responseReached = new Promise((resolve) => { release = resolve; });
  const id = broker.register({
    method: COMMAND,
    params: {},
    respond: async () => responseReached,
  });
  const decision = broker.decide(id, "allow");
  assert.equal(events.some((event) => event.type === "permission_closed"), false);
  release();
  assert.equal(await decision, true);
  assert.equal(events.filter((event) => event.type === "permission_closed").length, 1);
});

test("responder errors cannot leave stale requests or duplicate close events", async () => {
  const { broker, events } = makeBroker();
  const id = broker.register({
    method: COMMAND,
    params: {},
    respond: () => { throw new Error("transport closed"); },
  });
  await assert.rejects(() => broker.decide(id, "allow"), /transport closed/);
  assert.equal(broker.pendingCount, 0);
  assert.equal(events.filter((event) => event.type === "permission_closed").length, 1);
  assert.equal(await broker.decide(id, "allow"), false);
});
