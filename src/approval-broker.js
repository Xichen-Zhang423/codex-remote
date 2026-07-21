const TEXT_LIMIT = 12_000;
const SHORT_TEXT_LIMIT = 2_000;
const MAX_LIST = 100;

const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_APPROVAL = "item/fileChange/requestApproval";
const USER_INPUT = "item/tool/requestUserInput";
const PERMISSIONS_APPROVAL = "item/permissions/requestApproval";
const MCP_ELICITATION = "mcpServer/elicitation/request";
const SAFE_COMMAND_ACTIONS = new Set(["read", "listFiles", "search"]);

const DANGEROUS_COMMAND = /(?:\brm\s+-rf\b|\bremove-item\b[^\r\n]*(?:-recurse|-force)|\bgit\s+reset\s+--hard\b|\bdiskpart\b|\bformat(?:\.com)?\b|\bshutdown\b|\bstop-computer\b|\bdel\s+\/[a-z]*[sq])/i;

function truncate(value, limit = TEXT_LIMIT) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= limit) return text;
  const suffix = "\n[truncated]";
  let end = Math.max(0, limit - suffix.length);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end) + suffix;
}

function optionalText(value, limit = TEXT_LIMIT) {
  return typeof value === "string" && value ? truncate(value, limit) : undefined;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function immutableSnapshot(value) {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return deepFreeze(safeJson(value));
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function safeJson(value, seen = new WeakSet(), depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 1_000) return "[node limit]";
  if (depth > 8) return "[depth limit]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    output = value.slice(0, MAX_LIST).map((entry) => safeJson(entry, seen, depth + 1, budget));
  } else {
    output = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_LIST)) {
      const clean = safeJson(entry, seen, depth + 1, budget);
      if (clean !== undefined) output[key] = clean;
    }
  }
  seen.delete(value);
  return output;
}

function kindFor(method) {
  switch (method) {
    case COMMAND_APPROVAL: return "command";
    case FILE_APPROVAL: return "file";
    case USER_INPUT: return "user_input";
    case PERMISSIONS_APPROVAL: return "permissions";
    case MCP_ELICITATION: return "mcp_elicitation";
    default: return "unknown";
  }
}

function sanitizeQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.slice(0, 20).map((question) => compact({
    id: optionalText(question?.id, SHORT_TEXT_LIMIT),
    header: optionalText(question?.header, SHORT_TEXT_LIMIT),
    question: optionalText(question?.question, SHORT_TEXT_LIMIT),
    isOther: question?.isOther === true,
    isSecret: question?.isSecret === true,
    options: Array.isArray(question?.options)
      ? question.options.slice(0, 20).map((option) => compact({
        label: optionalText(option?.label, SHORT_TEXT_LIMIT),
        description: optionalText(option?.description, SHORT_TEXT_LIMIT),
      }))
      : [],
  }));
}

function sanitizeFileSystem(fileSystem) {
  if (!fileSystem || typeof fileSystem !== "object") return undefined;
  const clean = {};
  for (const key of ["read", "write"]) {
    if (Array.isArray(fileSystem[key])) {
      clean[key] = fileSystem[key].slice(0, MAX_LIST)
        .filter((entry) => typeof entry === "string")
        .map((entry) => truncate(entry));
    }
  }
  if (Array.isArray(fileSystem.entries)) {
    clean.entries = fileSystem.entries.slice(0, MAX_LIST).map((entry) => safeJson(entry));
  }
  if (Number.isInteger(fileSystem.globScanMaxDepth) && fileSystem.globScanMaxDepth > 0) {
    clean.globScanMaxDepth = fileSystem.globScanMaxDepth;
  }
  return Object.keys(clean).length ? clean : undefined;
}

function sanitizePermissions(permissions) {
  if (!permissions || typeof permissions !== "object") return {};
  const fileSystem = sanitizeFileSystem(permissions.fileSystem);
  const network = permissions.network && typeof permissions.network === "object"
    && typeof permissions.network.enabled === "boolean"
    ? { enabled: permissions.network.enabled }
    : undefined;
  return compact({ fileSystem, network });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function intersectList(requested, proposed) {
  if (!Array.isArray(requested) || !Array.isArray(proposed)) return undefined;
  const allowed = new Set(requested.map((entry) => canonical(entry)));
  const result = [];
  for (const entry of proposed.slice(0, MAX_LIST)) {
    if (allowed.has(canonical(entry))) result.push(safeJson(entry));
  }
  return result;
}

function intersectPermissions(requestedValue, proposedValue) {
  const requested = sanitizePermissions(requestedValue);
  const proposed = sanitizePermissions(proposedValue);
  const output = {};
  if (requested.fileSystem && proposed.fileSystem) {
    const fileSystem = {};
    for (const key of ["read", "write", "entries"]) {
      const values = intersectList(requested.fileSystem[key], proposed.fileSystem[key]);
      if (values !== undefined) fileSystem[key] = values;
    }
    if (Number.isInteger(requested.fileSystem.globScanMaxDepth)
      && Number.isInteger(proposed.fileSystem.globScanMaxDepth)) {
      fileSystem.globScanMaxDepth = Math.min(
        requested.fileSystem.globScanMaxDepth,
        proposed.fileSystem.globScanMaxDepth,
      );
    }
    if (Object.keys(fileSystem).length) output.fileSystem = fileSystem;
  }
  if (requested.network && proposed.network) {
    output.network = { enabled: requested.network.enabled === true && proposed.network.enabled === true };
  }
  return output;
}

function networkTarget(params) {
  const context = params?.networkApprovalContext;
  const host = optionalText(context?.host ?? context?.hostname, SHORT_TEXT_LIMIT)
    ?? optionalText(params?.proposedNetworkPolicyAmendments?.[0]?.host, SHORT_TEXT_LIMIT);
  if (!host) return undefined;
  const port = Number.isInteger(context?.port) && context.port > 0 && context.port <= 65_535
    ? context.port
    : undefined;
  return port ? `${host}:${port}` : host;
}

function summarize(id, method, params, eligibleForSessionAuto) {
  return compact({
    type: "permission_request",
    id,
    kind: kindFor(method),
    method,
    itemId: optionalText(params?.itemId, SHORT_TEXT_LIMIT),
    turnId: optionalText(params?.turnId, SHORT_TEXT_LIMIT),
    command: optionalText(params?.command),
    cwd: optionalText(params?.cwd),
    reason: optionalText(params?.reason),
    networkTarget: networkTarget(params),
    grantRoot: optionalText(params?.grantRoot),
    questions: method === USER_INPUT ? sanitizeQuestions(params?.questions) : undefined,
    permissions: method === PERMISSIONS_APPROVAL
      ? sanitizePermissions(params?.permissions)
      : undefined,
    serverName: method === MCP_ELICITATION
      ? optionalText(params?.serverName, SHORT_TEXT_LIMIT)
      : undefined,
    mode: method === MCP_ELICITATION
      ? optionalText(params?.mode, SHORT_TEXT_LIMIT)
      : undefined,
    message: method === MCP_ELICITATION
      ? optionalText(params?.message)
      : undefined,
    url: method === MCP_ELICITATION
      ? optionalText(params?.url)
      : undefined,
    requestedSchema: method === MCP_ELICITATION
      ? safeJson(params?.requestedSchema)
      : undefined,
    eligibleForSessionAuto,
  });
}

function normalizeAnswers(params, payload) {
  const supplied = payload?.answers && typeof payload.answers === "object"
    ? payload.answers
    : {};
  const answers = {};
  for (const question of Array.isArray(params?.questions) ? params.questions.slice(0, 20) : []) {
    if (typeof question?.id !== "string" || !Object.hasOwn(supplied, question.id)) continue;
    const raw = supplied[question.id];
    const values = Array.isArray(raw) ? raw : raw?.answers;
    const array = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
    answers[question.id] = {
      answers: array.slice(0, 10).filter((value) => typeof value === "string")
        .map((value) => truncate(value, SHORT_TEXT_LIMIT)),
    };
  }
  return { answers };
}

function denialFor(method) {
  if (method === USER_INPUT) return { answers: {} };
  if (method === PERMISSIONS_APPROVAL) return { permissions: {}, scope: "turn" };
  if (method === MCP_ELICITATION) return { action: "decline" };
  return { decision: "decline" };
}

function responseFor(record, action, payload = {}) {
  if (record.method === COMMAND_APPROVAL || record.method === FILE_APPROVAL) {
    const decisions = {
      allow: "accept",
      allowSession: "acceptForSession",
      deny: "decline",
      cancel: "cancel",
    };
    if (action === "allowSession" && !record.eligibleForSessionAuto) return null;
    return decisions[action] ? { decision: decisions[action] } : null;
  }
  if (record.method === USER_INPUT) {
    if (action === "answer") return normalizeAnswers(record.params, payload);
    if (action === "deny" || action === "cancel") return { answers: {} };
    return null;
  }
  if (record.method === MCP_ELICITATION) {
    if (action === "deny") return { action: "decline" };
    if (action === "cancel") return { action: "cancel" };
    if (action !== "answer" && action !== "accept") return null;
    const response = { action: "accept" };
    if (payload && Object.hasOwn(payload, "content")) response.content = safeJson(payload.content);
    return response;
  }
  if (record.method === PERMISSIONS_APPROVAL) {
    if (action === "deny" || action === "cancel") return denialFor(record.method);
    if (action !== "grant" && action !== "allow") return null;
    const proposed = payload.permissions ?? record.params?.permissions ?? {};
    const response = {
      permissions: intersectPermissions(record.params?.permissions, proposed),
      scope: payload.scope === "session" ? "session" : "turn",
    };
    if (typeof payload.strictAutoReview === "boolean") {
      response.strictAutoReview = payload.strictAutoReview;
    }
    return response;
  }
  return action === "deny" || action === "cancel" ? { decision: "decline" } : null;
}

export class ApprovalBroker {
  constructor({ emit = () => {}, onError = () => {} } = {}) {
    this.emit = emit;
    this.onError = onError;
    this.sessionAuto = false;
    this.pending = new Map();
    this.nextId = 1;
  }

  get pendingCount() {
    return this.pending.size;
  }

  setSessionAuto(enabled) {
    this.sessionAuto = enabled === true;
    return this.sessionAuto;
  }

  shouldAutoAccept({ method, params = {} } = {}) {
    // File approval params contain no diff, so a remote client cannot prove that
    // a change is non-destructive. Only App Server actions parsed as read-only
    // are eligible for process-local automatic approval.
    if (method !== COMMAND_APPROVAL) return false;
    if (!params || typeof params !== "object" || params.destructive === true) return false;
    if (params.networkApprovalContext
      || (Array.isArray(params.proposedNetworkPolicyAmendments)
        && params.proposedNetworkPolicyAmendments.length)) return false;
    const command = String(params.command ?? "");
    if (!command || DANGEROUS_COMMAND.test(command) || /[;&|><]/.test(command)) return false;
    const actions = Array.isArray(params.commandActions) ? params.commandActions : [];
    return actions.length > 0
      && actions.every((action) => SAFE_COMMAND_ACTIONS.has(action?.type));
  }

  register({ rpcId, method, params = {}, respond } = {}) {
    if (typeof respond !== "function") throw new TypeError("approval respond must be a function");
    const safeMethod = typeof method === "string" ? method : "unknown";
    const safeParams = immutableSnapshot(params && typeof params === "object" ? params : {});
    const id = `approval-${this.nextId++}`;
    const eligibleForSessionAuto = this.shouldAutoAccept({ method: safeMethod, params: safeParams });
    const record = {
      id,
      rpcId,
      method: safeMethod,
      params: safeParams,
      respond,
      event: summarize(id, safeMethod, safeParams, eligibleForSessionAuto),
      eligibleForSessionAuto,
    };
    this.pending.set(id, record);
    this.#emit(record.event);
    if (this.sessionAuto && eligibleForSessionAuto) {
      void this.#resolve(record, { decision: "acceptForSession" }, "session_auto")
        .catch((error) => this.#report(error));
    }
    return id;
  }

  async decide(id, action, payload = {}) {
    const record = this.pending.get(id);
    if (!record) return false;
    const response = responseFor(record, action, payload);
    if (!response) return false;
    await this.#resolve(record, response, action);
    return true;
  }

  pendingEvents() {
    return [...this.pending.values()].map((record) => safeJson(record.event));
  }

  async clear({ turnId, reason = "cleared" } = {}) {
    let count = 0;
    for (const record of [...this.pending.values()]) {
      if (turnId != null && record.params?.turnId !== turnId) continue;
      count += 1;
      try {
        await this.#resolve(record, denialFor(record.method), reason);
      } catch (error) {
        this.#report(error);
      }
    }
    return count;
  }

  async close(reason = "closed") {
    return this.clear({ reason });
  }

  async #resolve(record, response, reason) {
    if (!this.pending.delete(record.id)) return false;
    try {
      await record.respond(response);
    } finally {
      this.#emit({ type: "permission_closed", id: record.id, reason });
    }
    return true;
  }

  #emit(event) {
    try {
      this.emit(safeJson(event));
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error) {
    try { this.onError(error); } catch { /* error reporting must not break approval cleanup */ }
  }
}
