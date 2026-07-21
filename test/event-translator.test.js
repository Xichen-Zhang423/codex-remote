import test from "node:test";
import assert from "node:assert/strict";
import {
  translateItem,
  translateNotification,
  truncateText,
} from "../src/event-translator.js";

test("maps every streaming delta", () => {
  assert.deepEqual(translateNotification("item/agentMessage/delta", { delta: "hi" }), [
    { type: "assistant_delta", text: "hi" },
  ]);
  for (const method of ["item/reasoning/summaryTextDelta", "item/reasoning/textDelta"]) {
    assert.deepEqual(translateNotification(method, { delta: "checking" }), [
      { type: "thinking_delta", text: "checking" },
    ]);
  }
  assert.deepEqual(translateNotification("item/plan/delta", { delta: "1. test" }), [
    { type: "plan_delta", text: "1. test" },
  ]);
  assert.deepEqual(translateNotification("item/commandExecution/outputDelta", {
    itemId: "cmd1", delta: "ok\n",
  }), [{ type: "tool_delta", toolUseId: "cmd1", text: "ok\n" }]);
});

test("maps turn snapshots, notices, errors, and terminal results", () => {
  assert.deepEqual(translateNotification("turn/plan/updated", {
    explanation: "First", plan: [{ step: "Test", status: "inProgress" }],
  }), [{
    type: "plan", explanation: "First", plan: [{ step: "Test", status: "inProgress" }],
  }]);
  assert.deepEqual(translateNotification("turn/diff/updated", { diff: "+new" }), [
    { type: "diff", diff: "+new" },
  ]);
  assert.deepEqual(translateNotification("warning", { message: "careful" }), [
    { type: "notice", message: "careful" },
  ]);
  assert.deepEqual(translateNotification("configWarning", { summary: "bad config" }), [
    { type: "notice", message: "bad config" },
  ]);
  assert.deepEqual(translateNotification("error", { error: { message: "quota" } }), [
    { type: "error", message: "quota" },
  ]);
  assert.deepEqual(translateNotification("turn/completed", {
    turn: { status: "failed", error: { message: "quota" }, cost: 99 },
  }), [{ type: "result", status: "failed", error: { message: "quota" } }]);
});

test("routes item lifecycle notifications through translateItem", () => {
  const item = { id: "a1", type: "agentMessage", text: "done", phase: "final_answer" };
  assert.deepEqual(
    translateNotification("item/started", { item }),
    translateItem(item, "started"),
  );
  assert.deepEqual(
    translateNotification("item/completed", { item }),
    translateItem(item, "completed"),
  );
});

test("maps conversational, plan, and readable reasoning items", () => {
  assert.deepEqual(translateItem({
    id: "u1", type: "userMessage", content: [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ],
  }), [{ type: "user_echo", text: "hello\nworld" }]);
  assert.deepEqual(translateItem({
    id: "a1", type: "agentMessage", text: "answer", phase: "final_answer",
  }), [{ type: "assistant", text: "answer", phase: "final_answer" }]);
  assert.deepEqual(translateItem({ id: "p1", type: "plan", text: "Do it" }), [
    { type: "plan_text", text: "Do it" },
  ]);
  assert.deepEqual(translateItem({
    id: "r1", type: "reasoning", summary: ["Inspect", { text: "Verify" }], content: ["raw"],
  }), [{ type: "thinking", text: "Inspect\nVerify" }]);
});

test("maps command start and completion without inventing cost", () => {
  const command = {
    id: "cmd1", type: "commandExecution", command: "npm test", cwd: "D:\\repo",
    status: "inProgress",
  };
  assert.deepEqual(translateItem(command, "started"), [{
    type: "tool_use", id: "cmd1", name: "command",
    input: { command: "npm test", cwd: "D:\\repo" },
  }]);
  assert.deepEqual(translateItem({
    ...command, status: "completed", aggregatedOutput: "2 passed", exitCode: 0,
  }, "completed"), [{
    type: "tool_result", toolUseId: "cmd1", content: "2 passed", isError: false,
    meta: { kind: "command", exitCode: 0 },
  }]);
  const [failed] = translateItem({
    ...command, status: "failed", aggregatedOutput: "boom", exitCode: 1,
  }, "completed");
  assert.equal(failed.isError, true);
  assert.equal(failed.meta.exitCode, 1);
  assert.equal("cost" in failed, false);
  const [declined] = translateItem({
    ...command, status: "declined", aggregatedOutput: "not approved",
  }, "completed");
  assert.equal(declined.isError, true);
});

test("maps file changes", () => {
  assert.deepEqual(translateItem({
    id: "f1", type: "fileChange", status: "completed",
    changes: [{ path: "a.js", kind: "update", diff: "+x" }],
  }, "completed"), [{
    type: "file_change", id: "f1", status: "completed",
    changes: [{ path: "a.js", kind: "update", diff: "+x" }],
  }]);
});

test("maps MCP, dynamic, and collaboration tool start/result cards", () => {
  const cases = [
    [{ id: "m1", type: "mcpToolCall", server: "github", tool: "search", arguments: { q: "x" }, status: "inProgress" }, "mcp"],
    [{ id: "d1", type: "dynamicToolCall", tool: "lookup", arguments: { id: 7 }, status: "inProgress" }, "dynamic"],
    [{ id: "c1", type: "collabToolCall", tool: "spawn_agent", prompt: "help", status: "inProgress" }, "collab"],
  ];
  for (const [item, kind] of cases) {
    const [start] = translateItem(item, "started");
    assert.equal(start.type, "tool_use");
    assert.equal(start.id, item.id);
    assert.equal(start.meta.kind, kind);
    const [result] = translateItem({ ...item, status: "completed", result: { ok: true }, success: true }, "completed");
    assert.equal(result.type, "tool_result");
    assert.equal(result.toolUseId, item.id);
    assert.equal(result.isError, false);
    assert.equal(result.meta.kind, kind);
    assert.doesNotThrow(() => JSON.stringify(result));
  }
  for (const item of [
    { id: "m2", type: "mcpToolCall", status: "failed", error: { message: "MCP failed" } },
    { id: "d2", type: "dynamicToolCall", status: "completed", contentItems: [{ text: "dynamic result" }] },
    { id: "c2", type: "collabToolCall", status: "completed", agentStatus: { state: "done" } },
  ]) {
    const [result] = translateItem(item, "completed");
    assert.notEqual(result.content, "");
    if (item.status === "failed") assert.equal(result.isError, true);
  }
});

test("maps web search, image view, and context compaction to activities", () => {
  for (const item of [
    { id: "w1", type: "webSearch", query: "Codex" },
    { id: "i1", type: "imageView", path: "C:\\x.png" },
    { id: "x1", type: "contextCompaction" },
  ]) {
    const [event] = translateItem(item, "completed");
    assert.equal(event.type, "activity");
    assert.equal(event.activity, item.type);
    assert.equal(event.id, item.id);
    assert.doesNotThrow(() => JSON.stringify(event));
  }
});

test("keeps unknown items as compact serializable activities", () => {
  const cyclic = { id: "z1", type: "futureThing", status: "odd", payload: "secret" };
  cyclic.self = cyclic;
  assert.deepEqual(translateItem(cyclic), [{
    type: "activity", id: "z1", activity: "futureThing", status: "odd",
  }]);
});

test("truncates untrusted text at 12k without splitting a surrogate pair", () => {
  const face = String.fromCodePoint(0x1f63a);
  const text = `${"x".repeat(11_990)}${face.repeat(100)}`;
  const truncated = truncateText(text);
  assert.ok(truncated.length <= 12_000);
  assert.match(truncated, /\[truncated\]$/);
  const markerIndex = truncated.lastIndexOf("[truncated]");
  const beforeMarker = truncated.charCodeAt(markerIndex - 1);
  assert.equal(beforeMarker >= 0xd800 && beforeMarker <= 0xdbff, false);
  const [result] = translateItem({
    id: "cmd", type: "commandExecution", status: "completed",
    aggregatedOutput: "o".repeat(20_000), exitCode: 0,
  });
  assert.ok(result.content.length <= 12_000);
});

test("missing, undefined, and cyclic inputs never leak non-JSON values", () => {
  assert.deepEqual(translateNotification(), []);
  assert.deepEqual(translateNotification("item/started"), []);
  assert.deepEqual(translateNotification("turn/plan/updated"), [
    { type: "plan", explanation: "", plan: [] },
  ]);
  assert.deepEqual(translateItem(), [{
    type: "activity", activity: "unknown", status: "completed",
  }]);
  const circular = { message: "warn" };
  circular.self = circular;
  const outputs = [
    translateNotification("warning", circular),
    translateNotification("turn/completed", { turn: circular }),
    translateItem({ id: "m", type: "mcpToolCall", status: "completed", result: circular }),
  ];
  for (const output of outputs) assert.doesNotThrow(() => JSON.stringify(output));
  const cyclicId = {};
  cyclicId.self = cyclicId;
  assert.doesNotThrow(() => JSON.stringify(translateItem({
    id: cyclicId, type: "mcpToolCall", status: "completed", result: 1n,
  })));
});

test("sanitization is bounded for deeply nested and wide tool results", () => {
  let deep = "leaf";
  for (let index = 0; index < 10_000; index += 1) deep = [deep];
  const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`k${index}`, index]));
  for (const result of [deep, wide]) {
    const output = translateItem({ id: "bounded", type: "mcpToolCall", status: "completed", result });
    assert.doesNotThrow(() => JSON.stringify(output));
    assert.ok(JSON.stringify(output).length < 20_000);
  }
});
