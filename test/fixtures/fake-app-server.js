import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.argv[2] === "app-server") {
  const threadId = "thread-e2e";
  const modelId = "gpt-e2e";
  const turns = [];
  const approvals = new Map();
  let phase = "new";
  let cwd = process.cwd();
  let turnNumber = 0;
  let threadName = "E2E fixture";
  let archived = false;
  let attached = false;

  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const result = (id, value) => send({ id, result: value });
  const error = (id, message) => send({ id, error: { code: -32000, message } });
  const notify = (method, params) => send({ method, params });
  const initialized = (message) => {
    if (phase === "initialized") return true;
    if (Object.hasOwn(message, "id")) error(message.id, "initialized notification required first");
    return false;
  };

  function handleApprovalResponse(message) {
    const pending = approvals.get(message.id);
    if (!pending) return;
    approvals.delete(message.id);
    const decision = message.result?.decision ?? "missing";
    const accepted = decision === "accept" || decision === "acceptForSession";
    const command = {
      id: pending.commandId,
      type: "commandExecution",
      command: "fake-command --requires-approval",
      cwd,
      status: accepted ? "completed" : "declined",
      aggregatedOutput: `approval-response:${decision}`,
      exitCode: accepted ? 0 : 1,
    };
    pending.turn.items.push(command);
    pending.turn.status = "completed";
    notify("item/completed", {
      threadId,
      turnId: pending.turn.id,
      item: command,
    });
    notify("turn/completed", { threadId, turn: pending.turn });
  }

  function handleRequest(message) {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        if (phase !== "new") return error(message.id, "initialize must be first");
        phase = "initialize-replied";
        return result(message.id, {
          serverInfo: { name: "fake-app-server", version: "1.0.0" },
          capabilities: {},
        });
      case "initialized":
        if (phase !== "initialize-replied" || Object.hasOwn(message, "id")) {
          phase = "invalid";
          return;
        }
        phase = "initialized";
        return;
      case "thread/list":
        if (!initialized(message)) return;
        return result(message.id, {
          data: params.archived === archived ? [{ id: threadId, name: threadName, cwd }] : [],
          nextCursor: null,
        });
      case "thread/start":
        if (!initialized(message)) return;
        cwd = params.cwd ?? cwd;
        archived = false;
        attached = true;
        return result(message.id, { thread: { id: threadId, name: threadName, cwd } });
      case "thread/resume":
        if (!initialized(message)) return;
        if (params.threadId !== threadId) return error(message.id, "unknown thread");
        cwd = params.cwd ?? cwd;
        attached = true;
        return result(message.id, { thread: { id: threadId, name: threadName, cwd } });
      case "thread/read":
        if (!initialized(message)) return;
        return result(message.id, {
          thread: { id: params.threadId ?? threadId, name: threadName, cwd, turns },
        });
      case "thread/name/set":
        if (!initialized(message)) return;
        if (params.threadId !== threadId) return error(message.id, "unknown thread");
        threadName = params.name;
        return result(message.id, {});
      case "thread/archive":
        if (!initialized(message)) return;
        if (params.threadId !== threadId) return error(message.id, "unknown thread");
        archived = true;
        return result(message.id, {});
      case "model/list":
        if (!initialized(message)) return;
        return result(message.id, {
          data: [{ id: modelId, displayName: "E2E model" }],
          nextCursor: null,
        });
      case "turn/start": {
        if (!initialized(message)) return;
        if (!attached || params.threadId !== threadId) {
          return error(message.id, "thread must be resumed before starting a turn");
        }
        const text = params.input?.find((entry) => entry?.type === "text")?.text ?? "";
        if (text === "__E2E_WRITE_ARTIFACT__") {
          turnNumber += 1;
          const turnId = `turn-${turnNumber}`;
          const user = {
            id: `user-${turnNumber}`,
            type: "userMessage",
            content: [{ type: "text", text }],
            status: "completed",
          };
          const assistant = {
            id: `assistant-${turnNumber}`,
            type: "agentMessage",
            text: "artifact written",
            status: "completed",
          };
          const turn = { id: turnId, status: "completed", items: [user, assistant] };
          const output = path.join(cwd, "output");
          fs.mkdirSync(output, { recursive: true });
          fs.writeFileSync(
            path.join(output, "e2e-artifact.txt"),
            "artifact from fake app server\n",
            "utf8",
          );
          turns.push(turn);
          result(message.id, { turn: { id: turnId, status: "inProgress" } });
          notify("turn/started", {
            threadId,
            turn: { id: turnId, status: "inProgress" },
          });
          notify("item/completed", { threadId, turnId, item: user });
          notify("item/completed", { threadId, turnId, item: assistant });
          notify("turn/completed", { threadId, turn });
          return;
        }
        if (text === "__E2E_CRASH_APP_SERVER__") {
          setImmediate(() => process.exit(86));
          return;
        }
        turnNumber += 1;
        const turnId = `turn-${turnNumber}`;
        const commandId = `command-${turnNumber}`;
        const approvalId = `rpc-approval-${turnNumber}`;
        const user = {
          id: `user-${turnNumber}`,
          type: "userMessage",
          content: [{ type: "text", text }],
          status: "completed",
        };
        const assistant = {
          id: `assistant-${turnNumber}`,
          type: "agentMessage",
          text: `assistant:${text}`,
          status: "completed",
        };
        const turn = { id: turnId, status: "inProgress", items: [user, assistant] };
        turns.push(turn);
        approvals.set(approvalId, { commandId, turn });

        result(message.id, { turn: { id: turnId, status: "inProgress" } });
        notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
        notify("item/completed", { threadId, turnId, item: user });
        notify("item/agentMessage/delta", {
          threadId,
          turnId,
          itemId: assistant.id,
          delta: `stream:${text}`,
        });
        notify("item/completed", { threadId, turnId, item: assistant });
        notify("item/started", {
          threadId,
          turnId,
          item: {
            id: commandId,
            type: "commandExecution",
            command: "fake-command --requires-approval",
            cwd,
            status: "inProgress",
          },
        });
        send({
          id: approvalId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: commandId,
            command: "fake-command --requires-approval",
            cwd,
            reason: "exercise the phone approval bridge",
            commandActions: [{ type: "write" }],
            rawParams: { secret: "fixture-child-secret" },
            secret: "fixture-child-secret",
          },
        });
        return;
      }
      default:
        if (Object.hasOwn(message, "id")) error(message.id, `unsupported method: ${message.method}`);
    }
  }

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      handleApprovalResponse(message);
    } else if (typeof message.method === "string") {
      handleRequest(message);
    }
  });
}
