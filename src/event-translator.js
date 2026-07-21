const TEXT_LIMIT = 12_000;
const TRUNCATION_MARKER = "[truncated]";

export function truncateText(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= TEXT_LIMIT) return text;

  let end = TEXT_LIMIT - TRUNCATION_MARKER.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}
function jsonSafe(value, ancestors = new WeakSet(), depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 1_000) return "[Node limit]";
  if (depth > 8) return "[Depth limit]";

  if (value === null) return null;
  if (typeof value === "string") return truncateText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return null;
  if (ancestors.has(value)) return "[Circular]";

  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.slice(0, 100)
      .map((entry) => jsonSafe(entry, ancestors, depth + 1, budget));
  } else {
    result = {};
    try {
      for (const [key, entry] of Object.entries(value).slice(0, 100)) {
        if (entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol") {
          result[key] = jsonSafe(entry, ancestors, depth + 1, budget);
        }
      }
    } catch {
      result = { value: "[Unserializable]" };
    }
  }
  ancestors.delete(value);
  return result;
}
function compact(object) {
  return jsonSafe(Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  ));
}

function textFrom(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.text === "string") return value.text;
  return "";
}

function joinedText(value) {
  const entries = Array.isArray(value) ? value : [value];
  return truncateText(entries.map(textFrom).filter(Boolean).join("\n"));
}

function displayContent(value) {
  if (typeof value === "string") return truncateText(value);
  if (value === undefined || value === null) return "";
  try {
    return truncateText(JSON.stringify(jsonSafe(value)));
  } catch {
    return "[Unserializable]";
  }
}

function messageFrom(value, fallback) {
  if (typeof value === "string" && value) return truncateText(value);
  if (value && typeof value.message === "string" && value.message) {
    return truncateText(value.message);
  }
  return fallback;
}

function activity(item, lifecycle) {
  return [compact({
    type: "activity",
    id: item.id,
    activity: typeof item.type === "string" ? item.type : "unknown",
    status: typeof item.status === "string" ? item.status : lifecycle || "completed",
  })];
}

function translateTool(item, lifecycle, kind) {
  const started = lifecycle === "started" || (!lifecycle && item.status === "inProgress");
  const args = item.arguments ?? (item.prompt === undefined ? {} : { prompt: item.prompt });
  if (started) {
    return [compact({
      type: "tool_use",
      id: item.id,
      name: item.tool || kind,
      input: jsonSafe(args),
      meta: { kind },
    })];
  }

  const failureStatuses = new Set(["failed", "declined", "cancelled", "canceled", "error"]);
  const success = typeof item.success === "boolean"
    ? item.success
    : !failureStatuses.has(item.status) && item.error == null;
  return [compact({
    type: "tool_result",
    toolUseId: item.id,
    content: displayContent(
      item.result ?? item.output ?? item.error ?? item.contentItems ?? item.agentStatus,
    ),
    isError: !success,
    meta: { kind },
  })];
}

export function translateNotification(method, params = {}) {
  const data = params && typeof params === "object" ? params : {};
  const delta = () => (typeof data.delta === "string" && data.delta
    ? truncateText(data.delta)
    : "");

  switch (method) {
    case "item/agentMessage/delta":
      return delta() ? [{ type: "assistant_delta", text: delta() }] : [];
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return delta() ? [{ type: "thinking_delta", text: delta() }] : [];
    case "item/plan/delta":
      return delta() ? [{ type: "plan_delta", text: delta() }] : [];
    case "item/commandExecution/outputDelta":
      return delta() ? [compact({
        type: "tool_delta", toolUseId: data.itemId, text: delta(),
      })] : [];
    case "turn/plan/updated":
      return [{
        type: "plan",
        explanation: truncateText(data.explanation ?? ""),
        plan: Array.isArray(data.plan) ? jsonSafe(data.plan) : [],
      }];
    case "turn/diff/updated":
      return [{ type: "diff", diff: truncateText(data.diff ?? "") }];
    case "warning":
      return [{ type: "notice", message: messageFrom(data.message, "Codex warning") }];
    case "configWarning":
      return [{ type: "notice", message: messageFrom(data.summary, "Codex configuration warning") }];
    case "error":
      return [{ type: "error", message: messageFrom(data.error, messageFrom(data.message, "Codex error")) }];
    case "turn/completed": { const turn = data.turn && typeof data.turn === "object" ? data.turn : {}; return [compact({
      type: "result",
      status: typeof turn.status === "string" ? turn.status : "completed",
      error: turn.error === undefined ? undefined : jsonSafe(turn.error),
    })]; }
    case "item/started":
      return data.item && typeof data.item === "object" ? translateItem(data.item, "started") : [];
    case "item/completed":
      return data.item && typeof data.item === "object" ? translateItem(data.item, "completed") : [];
    default:
      return [];
  }
}

export function translateItem(item = {}, lifecycle) {
  const data = item && typeof item === "object" ? item : {};
  switch (data.type) {
    case "userMessage":
      return [{ type: "user_echo", text: joinedText(data.content ?? data.text) }];
    case "agentMessage":
      return [compact({
        type: "assistant",
        text: joinedText(data.text ?? data.content),
        phase: data.phase === undefined ? undefined : truncateText(data.phase),
      })];
    case "plan":
      return [{ type: "plan_text", text: joinedText(data.text ?? data.content) }];
    case "reasoning":
      return [{ type: "thinking", text: joinedText(data.summary ?? data.content) }];
    case "commandExecution": {
      const started = lifecycle === "started" || (!lifecycle && data.status === "inProgress");
      if (started) return [compact({
        type: "tool_use",
        id: data.id,
        name: "command",
        input: compact({
          command: data.command === undefined ? undefined : truncateText(data.command),
          cwd: data.cwd === undefined ? undefined : truncateText(data.cwd),
        }),
      })];
      const exitCode = Number.isFinite(data.exitCode) ? data.exitCode : null;
      const failed = new Set(["failed", "declined", "cancelled", "canceled", "error"]);
      return [compact({
        type: "tool_result",
        toolUseId: data.id,
        content: displayContent(data.aggregatedOutput ?? data.output ?? data.error),
        isError: failed.has(data.status) || data.error != null || (exitCode !== null && exitCode !== 0),
        meta: compact({ kind: "command", exitCode: exitCode ?? undefined }),
      })];
    }
    case "fileChange":
      return [compact({
        type: "file_change",
        id: data.id,
        status: typeof data.status === "string" ? data.status : lifecycle || "completed",
        changes: Array.isArray(data.changes) ? jsonSafe(data.changes) : [],
      })];
    case "mcpToolCall":
      return translateTool(data, lifecycle, "mcp");
    case "dynamicToolCall":
      return translateTool(data, lifecycle, "dynamic");
    case "collabToolCall":
      return translateTool(data, lifecycle, "collab");
    case "webSearch":
    case "imageView":
    case "contextCompaction":
      return activity(data, lifecycle);
    default:
      return activity(data, lifecycle);
  }
}
