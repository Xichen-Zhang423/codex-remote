(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const BACKEND_KEY = "codex-remote.backend.v1";
  const QUICK_KEY = "codex-remote.quick.v1";
  const NOTIFY_KEY = "codex-remote.notify.v1";
  const MAX_IMAGES = 4;
  const MAX_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
  const RECONNECT_DELAYS = [800, 1_500, 3_000, 5_000, 8_000, 12_000, 18_000];
  const DEFAULT_QUICK = [
    { label: "检查现场", prompt: "检查当前工作区的状态，指出最值得先处理的问题。" },
    { label: "运行测试", prompt: "运行与当前项目匹配的测试，定位失败原因并修复。" },
    { label: "审查改动", prompt: "审查当前未提交的改动，检查正确性、安全性和可维护性。" },
  ];

  const el = {
    messages: $("messages"), input: $("input"), composer: $("composer"),
    sendBtn: $("sendBtn"), stopBtn: $("stopBtn"), attachBtn: $("attachBtn"),
    imageInput: $("imageInput"), attachments: $("attachments"), micBtn: $("micBtn"),
    connectionDot: $("connectionDot"), connectionText: $("connectionText"),
    currentModel: $("currentModel"), currentCwd: $("currentCwd"), settingsCwd: $("settingsCwd"),
    runState: $("runState"), queueState: $("queueState"), tunnelState: $("tunnelState"),
    historyBtn: $("historyBtn"), settingsBtn: $("settingsBtn"), screenBtn: $("screenBtn"),
    artifactsBtn: $("artifactsBtn"), artifactBadge: $("artifactBadge"),
    artifactsDrawer: $("artifactsDrawer"), artifactRefreshBtn: $("artifactRefreshBtn"),
    artifactStatus: $("artifactStatus"), artifactList: $("artifactList"),
    artifactPreview: $("artifactPreview"), artifactPreviewCloseBtn: $("artifactPreviewCloseBtn"),
    artifactPreviewTitle: $("artifactPreviewTitle"), artifactPreviewMeta: $("artifactPreviewMeta"),
    artifactPreviewBody: $("artifactPreviewBody"), artifactPageStatus: $("artifactPageStatus"),
    artifactPrevPageBtn: $("artifactPrevPageBtn"), artifactNextPageBtn: $("artifactNextPageBtn"),
    artifactFitBtn: $("artifactFitBtn"), artifactDownloadBtn: $("artifactDownloadBtn"),
    modelBtn: $("modelBtn"), cwdBtn: $("cwdBtn"), brandBtn: $("brandBtn"),
    quickCommands: $("quickCommands"), toastRegion: $("toastRegion"),
    drawerBackdrop: $("drawerBackdrop"), historyDrawer: $("historyDrawer"),
    settingsDrawer: $("settingsDrawer"), workspaceDrawer: $("workspaceDrawer"),
    conversationSearch: $("conversationSearch"), conversationList: $("conversationList"),
    newConversationBtn: $("newConversationBtn"), modelSelect: $("modelSelect"),
    effortSelect: $("effortSelect"), browseCwdBtn: $("browseCwdBtn"),
    sessionAutoToggle: $("sessionAutoToggle"), notificationToggle: $("notificationToggle"),
    notificationStatus: $("notificationStatus"), backendStatus: $("backendStatus"),
    backendUrl: $("backendUrl"), saveBackendBtn: $("saveBackendBtn"), scanBtn: $("scanBtn"),
    reconnectBtn: $("reconnectBtn"), quickEditor: $("quickEditor"),
    saveQuickBtn: $("saveQuickBtn"), resetQuickBtn: $("resetQuickBtn"),
    directoryRootsBtn: $("directoryRootsBtn"), directoryUpBtn: $("directoryUpBtn"), directoryPath: $("directoryPath"),
    directoryList: $("directoryList"), mkdirName: $("mkdirName"), mkdirBtn: $("mkdirBtn"),
    useDirectoryBtn: $("useDirectoryBtn"), approvalSheet: $("approvalSheet"),
    approvalKind: $("approvalKind"), approvalTitle: $("approvalTitle"),
    approvalCount: $("approvalCount"), approvalBody: $("approvalBody"),
    approvalForm: $("approvalForm"), approvalActions: $("approvalActions"),
    screenViewer: $("screenViewer"), screenImage: $("screenImage"),
    screenHint: $("screenHint"), screenRefreshBtn: $("screenRefreshBtn"),
    screenAuto: $("screenAuto"), screenCloseBtn: $("screenCloseBtn"),
    openControlBtn: $("openControlBtn"), controlViewer: $("controlViewer"),
    controlStage: $("controlStage"), controlTransform: $("controlTransform"),
    controlImage: $("controlImage"), controlRipple: $("controlRipple"),
    controlHint: $("controlHint"), controlRefreshBtn: $("controlRefreshBtn"),
    controlResetBtn: $("controlResetBtn"), controlExitBtn: $("controlExitBtn"),
    controlText: $("controlText"), controlTypeBtn: $("controlTypeBtn"),
    scannerModal: $("scannerModal"), scannerVideo: $("scannerVideo"),
    scannerCanvas: $("scannerCanvas"), scannerHint: $("scannerHint"),
    scannerCloseBtn: $("scannerCloseBtn"),
  };

  const state = {
    backend: null,
    socket: null,
    socketEpoch: 0,
    connected: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    socketOpenTimer: null,
    busy: false,
    queueLength: 0,
    threadId: null,
    cwd: null,
    model: null,
    effort: null,
    sessionAuto: false,
    appServerStatus: "online",
    conversations: [],
    models: [],
    directoryPath: null,
    approvals: [],
    approvalDrafts: new Map(),
    images: [],
    optimisticEchoes: [],
    lastServerEcho: null,
    quick: [],
    streamQueue: [],
    streamFrame: 0,
    stream: { assistant: null, thinking: null, plan: null },
    structuredPlan: null,
    diffCard: null,
    toolCards: new Map(),
    fileCards: new Map(),
    activityCards: new Map(),
    stickToBottom: true,
    screenPending: false,
    screenTimer: null,
    lastScreenshot: "",
    scannerStream: null,
    scannerFrame: 0,
    recognition: null,
    modalStack: [],
    control: {
      action: "click",
      zoom: 1,
      tx: 0,
      ty: 0,
      pointers: new Map(),
      startPoint: null,
      panStart: null,
      pinchStart: null,
      moved: false,
      longTimer: null,
      longFired: false,
    },
  };

  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function append(parent, ...children) {
    for (const child of children) if (child) parent.appendChild(child);
    return parent;
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  }

  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch { /* storage may be unavailable */ }
  }

  function validOrigin(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function cleanRendezvous(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return "";
      return url.toString();
    } catch {
      return "";
    }
  }

  function validTunnelOrigin(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      const suffix = ".trycloudflare.com";
      const hostname = url.hostname.toLowerCase();
      if (!hostname.endsWith(suffix)) return null;
      const label = hostname.slice(0, -suffix.length);
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function normalizeBackend(value) {
    if (!value || typeof value !== "object") return null;
    const origin = validOrigin(value.origin);
    const token = typeof value.token === "string" ? value.token : "";
    const rz = cleanRendezvous(value.rz);
    if (!origin || token.length < 8) return null;
    return { origin, token, rz };
  }

  function persistBackend(backend) {
    const clean = normalizeBackend(backend);
    if (!clean) return false;
    state.backend = clean;
    const stored = storageSet(BACKEND_KEY, JSON.stringify(clean));
    updateBackendStatus();
    return stored;
  }

  function parseBackendUrl(raw) {
    const text = String(raw || "").trim();
    if (!text) throw new Error("请粘贴完整连接网址");
    let url;
    try { url = new URL(text); } catch { throw new Error("连接网址格式不正确"); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("连接网址必须使用 HTTP 或 HTTPS");
    if (url.username || url.password) throw new Error("连接网址不能包含账号或密码");
    const token = url.searchParams.get("token") || "";
    if (token.length < 8) throw new Error("连接网址中缺少有效 token");
    return normalizeBackend({
      origin: url.origin,
      token,
      rz: url.searchParams.get("rz") || "",
    });
  }

  function captureBackendFromAddressBar() {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    if (!token) return null;
    const backend = normalizeBackend({
      origin: url.origin,
      token,
      rz: url.searchParams.get("rz") || "",
    });
    url.searchParams.delete("token");
    url.searchParams.delete("rz");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    if (backend) persistBackend(backend);
    return backend;
  }

  function loadBackend() {
    const captured = captureBackendFromAddressBar();
    if (captured) return captured;
    try {
      const current = normalizeBackend(JSON.parse(storageGet(BACKEND_KEY) || "null"));
      if (current) return current;
    } catch { /* ignore invalid local data */ }

    try {
      const legacy = JSON.parse(storageGet("backend") || "null");
      if (legacy?.host && legacy?.token) {
        const scheme = legacy.secure ? "https:" : "http:";
        const migrated = normalizeBackend({
          origin: `${scheme}//${legacy.host}`,
          token: legacy.token,
          rz: legacy.rz || "",
        });
        if (migrated) {
          persistBackend(migrated);
          storageRemove("backend");
          storageRemove("token");
          storageRemove("server");
        }
        return migrated;
      }
    } catch { /* ignore invalid legacy data */ }
    return null;
  }

  function updateBackendStatus() {
    if (!state.backend) {
      el.backendStatus.textContent = "未配置";
      return;
    }
    try { el.backendStatus.textContent = new URL(state.backend.origin).host; }
    catch { el.backendStatus.textContent = "已保存"; }
  }

  async function resolveRendezvous(backend) {
    if (!backend?.rz) return backend;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await fetch(backend.rz, {
        cache: "no-store",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) return backend;
      const payload = await response.json();
      const origin = validTunnelOrigin(payload?.url);
      if (!origin) return backend;
      const next = { ...backend, origin };
      persistBackend(next);
      return next;
    } catch {
      return backend;
    } finally {
      clearTimeout(timeout);
    }
  }

  function toast(message, kind = "info") {
    const node = create("div", `toast${kind === "error" ? " is-error" : ""}`, message);
    el.toastRegion.appendChild(node);
    setTimeout(() => node.remove(), 3_600);
  }

  function setConnection(status, text) {
    el.connectionDot.className = `signal-dot is-${status}`;
    el.connectionText.textContent = text;
  }

  function setBusy(value) {
    state.busy = value === true;
    el.runState.classList.toggle("is-active", state.busy);
    el.runState.lastChild.textContent = state.busy ? " 运行中" : " 空闲";
    el.stopBtn.hidden = !state.busy;
    el.connectionDot.classList.toggle("is-busy", state.busy && state.connected);
  }

  function updateQueue(length) {
    if (Number.isInteger(length) && length >= 0) state.queueLength = length;
    el.queueState.textContent = `队列 ${state.queueLength}`;
  }

  function resetConnectionTransients({ preserveApprovalDrafts = true } = {}) {
    if (preserveApprovalDrafts) captureApprovalDraft();
    else state.approvalDrafts.clear();
    state.screenPending = false;
    stopScreenTimer();
    state.approvals = [];
    showApproval();
  }

  function syncSystem(message) {
    const previousThreadId = state.threadId;
    state.cwd = typeof message.cwd === "string" ? message.cwd : state.cwd;
    state.model = typeof message.model === "string" ? message.model : null;
    state.effort = typeof message.effort === "string" ? message.effort : null;
    state.threadId = typeof message.threadId === "string" ? message.threadId : null;
    if (state.threadId !== previousThreadId) artifactUI.onThreadChanged(state.threadId);
    state.sessionAuto = message.sessionAuto === true;
    if (["online", "restarting", "offline"].includes(message.appServerStatus)) {
      state.appServerStatus = message.appServerStatus;
    }
    updateQueue(Number.isInteger(message.queueLength) ? message.queueLength : state.queueLength);
    el.currentModel.textContent = state.model || "Codex 默认";
    el.currentCwd.textContent = state.cwd || "未选择";
    el.currentCwd.title = state.cwd || "";
    el.settingsCwd.textContent = state.cwd || "未选择";
    el.settingsCwd.title = state.cwd || "";
    el.sessionAutoToggle.checked = state.sessionAuto;
    el.modelSelect.value = state.model || "";
    refreshEffortOptions();
    if (state.connected && state.appServerStatus === "restarting") {
      setBusy(false);
      setConnection("connecting", "Codex 正在恢复");
    } else if (state.connected && state.appServerStatus === "online") {
      setConnection("online", "电脑在线");
    }
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  function clearSocketOpenTimer() {
    if (state.socketOpenTimer) clearTimeout(state.socketOpenTimer);
    state.socketOpenTimer = null;
  }

  function scheduleReconnect() {
    if (!state.backend || state.reconnectTimer) return;
    const index = Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1);
    const jitter = Math.floor(Math.random() * 350);
    const delay = RECONNECT_DELAYS[index] + jitter;
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      void connect();
    }, delay);
  }

  async function connect(force = false) {
    if (!state.backend) {
      setConnection("offline", "需要配对");
      updateBackendStatus();
      return;
    }
    if (!force && state.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.socket.readyState)) return;
    if (force) resetConnectionTransients();
    clearReconnectTimer();
    clearSocketOpenTimer();
    if (state.socket) {
      const old = state.socket;
      state.socket = null;
      try { old.close(); } catch { /* already closed */ }
    }

    const epoch = ++state.socketEpoch;
    state.connected = false;
    setConnection("connecting", "正在连接");
    const backend = await resolveRendezvous(state.backend);
    if (epoch !== state.socketEpoch) return;

    let socketUrl;
    try {
      socketUrl = new URL("/ws", backend.origin);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set("token", backend.token);
    } catch {
      setConnection("offline", "连接配置无效");
      return;
    }

    const socket = new WebSocket(socketUrl.toString());
    state.socket = socket;
    state.socketOpenTimer = setTimeout(() => {
      if (state.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      state.socket = null;
      state.connected = false;
      setConnection("offline", "连接超时，正在重试");
      try { socket.close(); } catch { /* the browser may already be closing it */ }
      scheduleReconnect();
    }, 12_000);
    socket.addEventListener("open", () => {
      if (state.socket !== socket) return;
      clearSocketOpenTimer();
      state.connected = true;
      state.reconnectAttempt = 0;
      if (!el.screenViewer.hidden || !el.controlViewer.hidden) requestScreenshot();
      setConnection("online", "电脑在线");
      toast("已连接 Codex Remote");
    });
    socket.addEventListener("message", (event) => {
      if (state.socket !== socket || typeof event.data !== "string") return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      receive(message);
    });
    socket.addEventListener("close", (event) => {
      if (state.socket !== socket) return;
      clearSocketOpenTimer();
      state.socket = null;
      state.connected = false;
      resetConnectionTransients({ preserveApprovalDrafts: event.code !== 4001 });
      setConnection("offline", event.code === 4001 ? "连接密钥无效" : "连接已断开");
      if (event.code === 4001) toast("连接密钥无效，请重新扫码", "error");
      else scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (state.socket === socket) setConnection("offline", "网络不可用");
    });
  }

  function sendWire(message) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      toast("电脑尚未连接", "error");
      return false;
    }
    try {
      state.socket.send(JSON.stringify(message));
      return true;
    } catch {
      toast("发送失败，正在重连", "error");
      void connect(true);
      return false;
    }
  }

  function removeEmptyState() {
    $("emptyState")?.remove();
  }

  function buildEmptyState() {
    const section = create("section", "empty-state");
    section.id = "emptyState";
    const title = create("h1");
    append(title, document.createTextNode("把下一步工作"), create("br"), document.createTextNode("交给 "), create("em", "", "Codex"));
    append(section,
      create("div", "empty-index", "01 / READY"),
      title,
      create("p", "", "从真实任务开始。工作过程、命令、文件变更与审批会按时间留在这张现场记录上。"),
    );
    const grid = create("div", "starter-grid");
    for (const item of DEFAULT_QUICK) {
      const button = create("button");
      button.type = "button";
      button.dataset.starter = item.prompt;
      append(button, create("span", "", item.label), create("small", "", item.prompt));
      grid.appendChild(button);
    }
    section.appendChild(grid);
    return section;
  }

  function clearTimeline() {
    el.messages.replaceChildren(buildEmptyState());
    state.stream = { assistant: null, thinking: null, plan: null };
    state.structuredPlan = null;
    state.diffCard = null;
    state.toolCards.clear();
    state.fileCards.clear();
    state.activityCards.clear();
  }

  function timestamp() {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date());
  }

  function addEntry(kind, label) {
    removeEmptyState();
    const entry = create("article", `timeline-entry is-${kind}`);
    const pin = create("span", "timeline-pin");
    pin.setAttribute("aria-hidden", "true");
    const card = create("div", "entry-card");
    const head = create("div", "entry-label");
    append(head, create("span", "", label), create("time", "", timestamp()));
    card.appendChild(head);
    append(entry, pin, card);
    el.messages.appendChild(entry);
    if (state.stickToBottom) requestAnimationFrame(scrollToBottom);
    return { entry, card, head };
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function renderInline(parent, text) {
    const parts = String(text || "").split(/(`[^`\n]+`)/g);
    for (const part of parts) {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        parent.appendChild(create("code", "inline-code", part.slice(1, -1)));
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
  }

  function renderRich(container, text) {
    container.replaceChildren();
    container.classList.remove("streaming");
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    let code = null;
    let codeLines = [];
    let list = null;
    const finishCode = () => {
      if (!code) return;
      code.textContent = codeLines.join("\n");
      container.appendChild(code);
      code = null;
      codeLines = [];
    };
    for (const line of lines) {
      if (/^```/.test(line)) {
        if (code) finishCode();
        else { code = create("pre"); list = null; }
        continue;
      }
      if (code) { codeLines.push(line); continue; }
      if (!line.trim()) { list = null; continue; }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        list = null;
        const node = create(`h${Math.min(4, heading[1].length + 1)}`);
        renderInline(node, heading[2]);
        container.appendChild(node);
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || numbered) {
        const tag = numbered ? "ol" : "ul";
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = create(tag);
          container.appendChild(list);
        }
        const item = create("li");
        renderInline(item, (bullet || numbered)[1]);
        list.appendChild(item);
        continue;
      }
      list = null;
      const paragraph = create("p");
      renderInline(paragraph, line);
      container.appendChild(paragraph);
    }
    finishCode();
    if (!container.childNodes.length) container.appendChild(document.createTextNode(""));
  }

  function renderUser(message) {
    const text = message.text || "";
    if (!text && !message.images?.length) return;
    const optimisticIndex = state.optimisticEchoes.findIndex((item) => item.text === (message.text || ""));
    if (optimisticIndex >= 0) {
      state.optimisticEchoes.splice(optimisticIndex, 1);
      state.lastServerEcho = { text, at: Date.now() };
      return;
    }
    if (state.lastServerEcho?.text === text && Date.now() - state.lastServerEcho.at < 2_500) return;
    state.lastServerEcho = { text, at: Date.now() };
    const { card } = addEntry("user", "YOU / REQUEST");
    const content = create("div", "entry-content");
    content.textContent = message.text || (message.images?.length ? "已附加图片" : "");
    card.appendChild(content);
    if (Array.isArray(message.images) && message.images.length) renderUserImages(card, message.images);
  }

  function renderOptimisticUser(text, images) {
    const { card } = addEntry("user", "YOU / QUEUED");
    const content = create("div", "entry-content", text || "已附加图片");
    card.appendChild(content);
    if (images.length) renderUserImages(card, images);
    state.optimisticEchoes.push({ text, at: Date.now() });
    state.optimisticEchoes = state.optimisticEchoes.filter((item) => Date.now() - item.at < 120_000);
  }

  function renderUserImages(card, images) {
    const grid = create("div", "user-images");
    for (const source of images.slice(0, MAX_IMAGES)) {
      if (typeof source !== "string" || !source.startsWith("data:image/")) continue;
      const image = create("img");
      image.src = source;
      image.alt = "用户附加图片";
      image.loading = "lazy";
      grid.appendChild(image);
    }
    if (grid.childNodes.length) card.appendChild(grid);
  }

  function ensureAssistantStream() {
    if (state.stream.assistant?.content?.isConnected) return state.stream.assistant;
    const entry = addEntry("assistant", "CODEX / STREAM");
    const content = create("div", "entry-content streaming");
    entry.card.appendChild(content);
    state.stream.assistant = { ...entry, content, text: "" };
    return state.stream.assistant;
  }

  function assistantDelta(text) {
    const record = ensureAssistantStream();
    record.text += String(text || "");
    record.content.textContent = record.text;
  }

  function assistantFinal(message) {
    if (!state.stream.assistant?.content?.isConnected && !message.text) return;
    const record = state.stream.assistant?.content?.isConnected
      ? state.stream.assistant
      : ensureAssistantStream();
    record.text = typeof message.text === "string" ? message.text : record.text;
    renderRich(record.content, record.text);
    record.head.firstChild.textContent = message.phase ? `CODEX / ${message.phase}` : "CODEX / RESPONSE";
    state.stream.assistant = null;
  }

  function ensureThinkingStream() {
    if (state.stream.thinking?.content?.isConnected) return state.stream.thinking;
    const entry = addEntry("thinking", "CODEX / REASONING");
    const details = create("details", "thinking-details");
    const summary = create("summary", "", "推理过程");
    const content = create("div", "entry-content streaming");
    append(details, summary, content);
    entry.card.appendChild(details);
    state.stream.thinking = { ...entry, details, content, text: "" };
    return state.stream.thinking;
  }

  function thinkingDelta(text) {
    const record = ensureThinkingStream();
    record.text += String(text || "");
    record.content.textContent = record.text;
  }

  function thinkingFinal(message) {
    if (!state.stream.thinking?.content?.isConnected && !message.text) return;
    const record = state.stream.thinking?.content?.isConnected
      ? state.stream.thinking
      : ensureThinkingStream();
    record.text = typeof message.text === "string" ? message.text : record.text;
    renderRich(record.content, record.text);
    state.stream.thinking = null;
  }

  function planDelta(text) {
    if (!state.stream.plan?.content?.isConnected) {
      const entry = addEntry("assistant", "CODEX / PLAN");
      const content = create("div", "entry-content streaming");
      entry.card.appendChild(content);
      state.stream.plan = { ...entry, content, text: "" };
    }
    state.stream.plan.text += String(text || "");
    state.stream.plan.content.textContent = state.stream.plan.text;
  }

  function planText(message) {
    if (!state.stream.plan?.content?.isConnected && !message.text) return;
    if (!state.stream.plan?.content?.isConnected) planDelta("");
    const record = state.stream.plan;
    record.text = typeof message.text === "string" ? message.text : record.text;
    renderRich(record.content, record.text);
    state.stream.plan = null;
  }

  function renderPlan(message) {
    let card = state.structuredPlan?.isConnected ? state.structuredPlan : null;
    if (!card) {
      card = addEntry("assistant", "CODEX / PLAN UPDATE").card;
      state.structuredPlan = card;
    }
    card.classList.add("plan-card");
    card.replaceChildren();
    const head = create("div", "plan-head");
    append(head, create("span", "", "EXECUTION PLAN"), create("span", "", `${Array.isArray(message.plan) ? message.plan.length : 0} STEPS`));
    card.appendChild(head);
    if (message.explanation) {
      const explanation = create("div", "entry-content");
      explanation.style.padding = "12px";
      renderRich(explanation, message.explanation);
      card.appendChild(explanation);
    }
    const list = create("ol", "plan-list");
    for (const raw of Array.isArray(message.plan) ? message.plan : []) {
      const step = typeof raw === "string" ? raw : raw?.step || raw?.text || JSON.stringify(raw);
      const item = create("li", raw?.status ? `is-${String(raw.status).replaceAll("_", "-")}` : "", step);
      list.appendChild(item);
    }
    if (!list.childNodes.length) list.appendChild(create("li", "", "计划已更新"));
    card.appendChild(list);
  }

  function compactJson(value) {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value ?? {}, null, 2); } catch { return "[无法显示]"; }
  }

  function toolGlyph(name) {
    const lower = String(name || "").toLowerCase();
    if (lower.includes("command")) return ">_";
    if (lower.includes("mcp")) return "M";
    if (lower.includes("web") || lower.includes("search")) return "⌕";
    return "◇";
  }

  function ensureToolCard(id, name = "tool") {
    const key = id || `tool-${Date.now()}-${Math.random()}`;
    if (state.toolCards.has(key)) return state.toolCards.get(key);
    const entry = addEntry("assistant", "CODEX / TOOL");
    const details = create("details", "activity-card");
    const summary = create("summary");
    const glyph = create("span", "activity-glyph", toolGlyph(name));
    const title = create("span", "activity-name", name || "tool");
    const status = create("span", "activity-status", "RUNNING");
    append(summary, glyph, title, status);
    const body = create("div", "activity-body");
    const input = create("pre", "tool-input");
    const output = create("pre", "tool-output");
    output.hidden = true;
    append(body, input, output);
    append(details, summary, body);
    entry.card.appendChild(details);
    const record = { key, entry, details, title, status, input, output, outputText: "" };
    state.toolCards.set(key, record);
    return record;
  }

  function renderToolUse(message) {
    const record = ensureToolCard(message.id, message.name || message.meta?.kind || "tool");
    record.title.textContent = message.name || message.meta?.kind || "tool";
    record.status.textContent = "RUNNING";
    record.status.classList.remove("is-error");
    record.input.textContent = compactJson(message.input);
  }

  function renderToolDelta(message) {
    const record = ensureToolCard(message.toolUseId, "command");
    record.outputText += String(message.text || "");
    record.output.textContent = record.outputText;
    record.output.hidden = false;
  }

  function renderToolResult(message) {
    const record = ensureToolCard(message.toolUseId, message.meta?.kind || "tool");
    record.outputText = typeof message.content === "string" ? message.content : compactJson(message.content);
    record.output.textContent = record.outputText || (message.isError ? "操作失败" : "完成");
    record.output.hidden = false;
    record.status.textContent = message.isError ? "FAILED" : "DONE";
    record.status.classList.toggle("is-error", message.isError === true);
    record.details.open = message.isError === true;
  }

  function renderDiff(message) {
    let card = state.diffCard?.isConnected ? state.diffCard : null;
    if (!card) {
      card = addEntry("assistant", "CODEX / DIFF").card;
      state.diffCard = card;
    }
    card.replaceChildren();
    const details = create("details", "activity-card");
    const summary = create("summary");
    append(summary, create("span", "activity-glyph", "±"), create("span", "activity-name", "工作区差异"), create("span", "activity-status", "UPDATED"));
    const body = create("div", "activity-body");
    const pre = create("pre", "diff-output");
    for (const line of String(message.diff || "").split("\n")) {
      let cls = "diff-line";
      if (line.startsWith("+") && !line.startsWith("+++")) cls += " is-add";
      else if (line.startsWith("-") && !line.startsWith("---")) cls += " is-delete";
      else if (line.startsWith("@@") || line.startsWith("diff ")) cls += " is-header";
      pre.appendChild(create("span", cls, line));
    }
    append(body, pre);
    append(details, summary, body);
    card.appendChild(details);
  }

  function renderFileChange(message) {
    const key = message.id || `file-${Date.now()}-${Math.random()}`;
    let record = state.fileCards.get(key);
    if (!record) {
      const entry = addEntry("assistant", "CODEX / FILE CHANGE");
      const details = create("details", "activity-card");
      const summary = create("summary");
      const status = create("span", "activity-status");
      append(summary, create("span", "activity-glyph", "Δ"), create("span", "activity-name", "文件变更"), status);
      const body = create("div", "activity-body");
      append(details, summary, body);
      entry.card.appendChild(details);
      record = { details, status, body };
      state.fileCards.set(key, record);
    }
    record.status.textContent = String(message.status || "UPDATED").toUpperCase();
    record.body.replaceChildren();
    const list = create("div", "file-change-list");
    for (const change of Array.isArray(message.changes) ? message.changes : []) {
      const row = create("div", "file-change-item");
      const kind = change?.kind || change?.type || "edit";
      const path = change?.path || change?.filePath || change?.file || compactJson(change);
      append(row, create("span", "file-change-kind", kind), create("span", "", path));
      list.appendChild(row);
    }
    if (!list.childNodes.length) list.appendChild(create("div", "file-change-item", "文件内容已更新"));
    record.body.appendChild(list);
  }

  function renderActivity(message) {
    const key = message.id || `${message.activity || "activity"}-${Date.now()}`;
    let record = state.activityCards.get(key);
    if (!record) {
      const entry = addEntry("assistant", "CODEX / ACTIVITY");
      const details = create("details", "activity-card");
      const summary = create("summary");
      const title = create("span", "activity-name", message.activity || "activity");
      const status = create("span", "activity-status", message.status || "RUNNING");
      append(summary, create("span", "activity-glyph", toolGlyph(message.activity)), title, status);
      const body = create("div", "activity-body");
      append(details, summary, body);
      entry.card.appendChild(details);
      record = { title, status, body };
      state.activityCards.set(key, record);
    }
    record.title.textContent = message.activity || "activity";
    record.status.textContent = String(message.status || "RUNNING").toUpperCase();
  }

  function renderNotice(message, error = false) {
    const { card } = addEntry(error ? "error" : "notice", error ? "SYSTEM / ERROR" : "SYSTEM / NOTICE");
    card.appendChild(create("div", "entry-content", message.message || (error ? "发生错误" : "系统通知")));
  }

  function renderResult(message, replay = false) {
    const { card } = addEntry("result", "TURN / COMPLETE");
    const content = create("div", "result-card");
    const status = String(message.status || "completed");
    append(content,
      create("strong", "", status === "completed" ? "任务完成" : `任务${status}`),
      create("code", "", message.error ? compactJson(message.error) : "WORK LOG SEALED"),
    );
    card.appendChild(content);
    if (!replay) {
      if (state.queueLength > 0) {
        updateQueue(state.queueLength - 1);
        setBusy(true);
      } else {
        setBusy(false);
      }
      notifyCompletion(status, message.error);
    }
  }

  function queueStream(message) {
    state.streamQueue.push(message);
    if (!state.streamFrame) state.streamFrame = requestAnimationFrame(flushStreams);
  }

  function flushStreams() {
    state.streamFrame = 0;
    const queue = state.streamQueue.splice(0);
    for (const message of queue) {
      if (message.type === "assistant_delta") assistantDelta(message.text);
      else if (message.type === "thinking_delta") thinkingDelta(message.text);
      else if (message.type === "plan_delta") planDelta(message.text);
      else if (message.type === "tool_delta") renderToolDelta(message);
    }
    if (state.stickToBottom) scrollToBottom();
  }

  function renderHistory(message) {
    if (state.streamFrame) cancelAnimationFrame(state.streamFrame);
    state.streamFrame = 0;
    state.streamQueue.length = 0;
    state.optimisticEchoes.length = 0;
    state.lastServerEcho = null;
    clearTimeline();
    const events = Array.isArray(message.events) ? message.events : [];
    for (const event of events) routeEvent(event, true);
    artifactUI.onHistoryRendered();
    if (!events.length) setBusy(false);
    requestAnimationFrame(scrollToBottom);
  }

  function routeEvent(message, replay = false) {
    if (!message || typeof message !== "object") return;
    if (!replay && [
      "assistant_delta", "thinking_delta", "plan_delta", "tool_use", "tool_delta",
      "file_change", "activity", "turn_started",
    ].includes(message.type)) setBusy(true);
    if (!["assistant_delta", "thinking_delta", "plan_delta", "tool_delta"].includes(message.type)) flushStreams();
    switch (message.type) {
      case "user_echo": renderUser(message); break;
      case "assistant_delta": queueStream(message); break;
      case "assistant": assistantFinal(message); break;
      case "thinking_delta": queueStream(message); break;
      case "thinking": thinkingFinal(message); break;
      case "plan_delta": queueStream(message); break;
      case "plan_text": planText(message); break;
      case "plan": renderPlan(message); break;
      case "diff": renderDiff(message); break;
      case "tool_use": renderToolUse(message); break;
      case "tool_delta": queueStream(message); break;
      case "tool_result": renderToolResult(message); break;
      case "file_change": renderFileChange(message); break;
      case "activity": renderActivity(message); break;
      case "notice": renderNotice(message); break;
      case "error": renderNotice(message, true); break;
      case "result": renderResult(message, replay); break;
      case "turn_started": setBusy(true); break;
      default: break;
    }
  }

  function receive(message) {
    if (!message || typeof message !== "object") return;
    if (artifactUI.handleMessage(message)) return;
    switch (message.type) {
      case "hello": resetConnectionTransients(); artifactUI.onHello(message); break;
      case "system_init": syncSystem(message); break;
      case "history": renderHistory(message); break;
      case "conversations":
        state.conversations = Array.isArray(message.conversations) ? message.conversations : [];
        renderConversations();
        break;
      case "models":
        state.models = Array.isArray(message.models) ? message.models : [];
        renderModels();
        break;
      case "directory": renderDirectory(message); break;
      case "directory_roots": renderDirectoryRoots(message); break;
      case "permission_request": addApproval(message); break;
      case "permission_closed": closeApproval(message.id); break;
      case "permission_ack":
        if (message.accepted === false) {
          closeApproval(message.id);
          toast("该审批已失效，请刷新", "error");
        }
        break;
      case "prompt_queued":
        updateQueue(message.queueLength);
        setBusy(true);
        break;
      case "interrupt_ack":
        toast(message.accepted ? "已请求中断当前任务" : "当前没有可中断的任务");
        break;
      case "screenshot": handleScreenshot(message.data); break;
      case "control_result":
        if (message.ok === false) toast("桌面操作失败", "error");
        if (!el.controlViewer.hidden && !el.screenAuto.checked) setTimeout(requestScreenshot, 420);
        break;
      case "tunnel": handleTunnel(message); break;
      case "error":
        if (state.screenPending) {
          state.screenPending = false;
          el.screenHint.hidden = false;
          el.screenHint.querySelector("p").textContent = "屏幕获取失败，请稍后重试。";
        }
        routeEvent(message);
        break;
      default: routeEvent(message); break;
    }
  }

  function handleTunnel(message) {
    const stateText = String(message.state || "unknown");
    el.tunnelState.textContent = stateText === "online" ? "公网隧道在线" : `公网隧道 ${stateText}`;
    el.tunnelState.classList.toggle("is-online", stateText === "online");
    const tunnelOrigin = validTunnelOrigin(message.url);
    if (stateText === "online" && tunnelOrigin && state.backend) {
      persistBackend({ ...state.backend, origin: tunnelOrigin });
    }
  }

  function submitPrompt(forcedText) {
    const text = forcedText === undefined ? el.input.value.trim() : String(forcedText).trim();
    const images = [...state.images];
    if (!text && !images.length) return;
    if (!state.connected) {
      toast("尚未连接电脑，请检查连接设置", "error");
      return;
    }
    if (state.appServerStatus === "restarting") {
      toast("Codex 正在恢复，请稍后再试", "error");
      return;
    }
    const requestId = globalThis.crypto?.randomUUID?.() || `prompt-${Date.now()}`;
    if (!sendWire({ type: "prompt", text, images, requestId })) return;
    renderOptimisticUser(text, images);
    el.input.value = "";
    autoResizeInput();
    clearImages();
    setBusy(true);
    state.stickToBottom = true;
    scrollToBottom();
  }

  function autoResizeInput() {
    el.input.style.height = "auto";
    el.input.style.height = `${Math.min(180, el.input.scrollHeight)}px`;
  }

  function renderAttachments() {
    el.attachments.replaceChildren();
    for (const [index, source] of state.images.entries()) {
      const cell = create("div", "attachment");
      const image = create("img");
      image.src = source;
      image.alt = `待发送图片 ${index + 1}`;
      const remove = create("button", "", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `移除第 ${index + 1} 张图片`);
      remove.addEventListener("click", () => {
        state.images.splice(index, 1);
        renderAttachments();
      });
      append(cell, image, remove);
      el.attachments.appendChild(cell);
    }
    el.attachments.hidden = !state.images.length;
    el.attachBtn.classList.toggle("is-active", state.images.length > 0);
  }

  function clearImages() {
    state.images.length = 0;
    renderAttachments();
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      if (!file?.type?.startsWith("image/")) { reject(new Error("不是图片文件")); return; }
      const image = new Image();
      const objectUrl = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const maxSide = 1_600;
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const data = canvas.toDataURL("image/jpeg", .8);
        if (data.length > MAX_IMAGE_DATA_LENGTH) reject(new Error("图片压缩后仍然过大"));
        else resolve(data);
      };
      image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("图片无法读取")); };
      image.src = objectUrl;
    });
  }

  async function addImageFiles(files) {
    for (const file of files) {
      if (state.images.length >= MAX_IMAGES) { toast("一次最多发送 4 张图片", "error"); break; }
      try {
        const data = await compressImage(file);
        state.images.push(data);
      } catch (error) {
        toast(error?.message || "图片读取失败", "error");
      }
    }
    renderAttachments();
  }

  function parseQuick(raw) {
    const items = [];
    for (const line of String(raw || "").split(/\r?\n/)) {
      const separator = line.indexOf("|");
      if (separator < 1) continue;
      const label = line.slice(0, separator).trim().slice(0, 28);
      const prompt = line.slice(separator + 1).trim().slice(0, 2_000);
      if (label && prompt) items.push({ label, prompt });
      if (items.length >= 6) break;
    }
    return items;
  }

  function loadQuick() {
    try {
      const stored = JSON.parse(storageGet(QUICK_KEY) || "null");
      if (Array.isArray(stored) && stored.length) return stored.slice(0, 6)
        .filter((item) => typeof item?.label === "string" && typeof item?.prompt === "string");
    } catch { /* use defaults */ }
    return [...DEFAULT_QUICK];
  }

  function quickText(items) {
    return items.map((item) => `${item.label} | ${item.prompt}`).join("\n");
  }

  function renderQuick() {
    el.quickCommands.replaceChildren();
    for (const item of state.quick) {
      const button = create("button", "", item.label);
      button.type = "button";
      button.title = item.prompt;
      button.addEventListener("click", () => submitPrompt(item.prompt));
      el.quickCommands.appendChild(button);
    }
    el.quickEditor.value = quickText(state.quick);
  }

  function conversationName(item) {
    return item?.name || item?.title || item?.preview || `会话 ${String(item?.id || "").slice(0, 8)}`;
  }

  function renderConversations() {
    el.conversationList.replaceChildren();
    if (!state.conversations.length) {
      el.conversationList.appendChild(create("div", "empty-list", "没有找到会话记录"));
      return;
    }
    for (const item of state.conversations) {
      if (!item?.id) continue;
      const row = create("div", `conversation-row${item.id === state.threadId ? " is-current" : ""}`);
      const main = create("button", "conversation-main");
      main.type = "button";
      const dateValue = item.updatedAt || item.createdAt;
      let date = "";
      if (dateValue) {
        const parsed = new Date(typeof dateValue === "number" && dateValue < 1e12 ? dateValue * 1000 : dateValue);
        if (!Number.isNaN(parsed.getTime())) date = parsed.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      }
      append(main,
        create("strong", "conversation-copy", conversationName(item)),
        create("small", "", date || item.status || "Codex 会话"),
        create("code", "", item.cwd || ""),
      );
      main.addEventListener("click", () => {
        if (item.id !== state.threadId) {
          clearTimeline();
          sendWire({ type: "loadConversation", threadId: item.id });
        }
        closeDrawers();
      });
      const actions = create("div", "conversation-actions");
      const rename = create("button", "", "✎");
      rename.type = "button";
      rename.title = "重命名";
      rename.setAttribute("aria-label", `重命名 ${conversationName(item)}`);
      rename.addEventListener("click", () => {
        const next = window.prompt("新的会话名称", conversationName(item));
        if (next?.trim()) sendWire({ type: "renameConversation", threadId: item.id, name: next.trim() });
      });
      const archive = create("button", "", "□");
      archive.type = "button";
      archive.title = "归档";
      archive.setAttribute("aria-label", `归档 ${conversationName(item)}`);
      archive.addEventListener("click", () => {
        if (window.confirm(`归档“${conversationName(item)}”？可在 Codex 历史中恢复。`)) {
          sendWire({ type: "archiveConversation", threadId: item.id });
        }
      });
      append(actions, rename, archive);
      append(row, main, actions);
      el.conversationList.appendChild(row);
    }
  }

  function modelId(model) {
    return typeof model === "string" ? model : model?.id || model?.model || "";
  }

  function modelName(model) {
    return typeof model === "string" ? model : model?.displayName || model?.name || modelId(model);
  }

  function renderModels() {
    const current = state.model || "";
    el.modelSelect.replaceChildren();
    const fallback = create("option", "", "使用 Codex 默认模型");
    fallback.value = "";
    el.modelSelect.appendChild(fallback);
    for (const model of state.models) {
      const id = modelId(model);
      if (!id) continue;
      const option = create("option", "", modelName(model));
      option.value = id;
      if (model?.description) option.title = model.description;
      el.modelSelect.appendChild(option);
    }
    if (current && ![...el.modelSelect.options].some((option) => option.value === current)) {
      const option = create("option", "", current);
      option.value = current;
      el.modelSelect.appendChild(option);
    }
    el.modelSelect.value = current;
    refreshEffortOptions();
  }

  function supportedEfforts() {
    const selected = state.models.find((item) => modelId(item) === (el.modelSelect.value || state.model));
    const source = selected?.supportedReasoningEfforts || selected?.reasoningEfforts || [];
    const values = source.map((item) => typeof item === "string" ? item : item?.reasoningEffort || item?.effort || item?.value).filter(Boolean);
    return [...new Set(values)];
  }

  function refreshEffortOptions() {
    const current = state.effort || "";
    const efforts = supportedEfforts();
    const common = ["minimal", "low", "medium", "high", "xhigh"];
    const values = efforts.length ? efforts : common;
    el.effortSelect.replaceChildren();
    const fallback = create("option", "", "使用默认强度");
    fallback.value = "";
    el.effortSelect.appendChild(fallback);
    for (const value of values) {
      const option = create("option", "", value);
      option.value = value;
      el.effortSelect.appendChild(option);
    }
    if (current && !values.includes(current)) {
      const option = create("option", "", current);
      option.value = current;
      el.effortSelect.appendChild(option);
    }
    el.effortSelect.value = current;
  }

  function parentPath(value) {
    const path = String(value || "");
    if (!path) return null;
    if (path.includes("\\")) {
      const trimmed = path.replace(/\\+$/, "");
      if (/^[A-Za-z]:$/.test(trimmed)) return null;
      const index = trimmed.lastIndexOf("\\");
      if (index <= 2) return `${trimmed.slice(0, 2)}\\`;
      return trimmed.slice(0, index);
    }
    const trimmed = path.replace(/\/+$/, "") || "/";
    if (trimmed === "/") return null;
    const index = trimmed.lastIndexOf("/");
    return index <= 0 ? "/" : trimmed.slice(0, index);
  }

  function joinPath(base, name) {
    const separator = String(base).includes("\\") ? "\\" : "/";
    return `${String(base).replace(/[\\/]+$/, "")}${separator}${name}`;
  }

  function renderDirectory(message) {
    state.directoryPath = typeof message.path === "string" ? message.path : state.cwd;
    el.directoryPath.textContent = state.directoryPath || "—";
    el.directoryPath.title = state.directoryPath || "";
    const parent = parentPath(state.directoryPath);
    el.directoryUpBtn.disabled = !parent;
    el.mkdirBtn.disabled = false;
    el.mkdirName.disabled = false;
    el.useDirectoryBtn.disabled = !state.directoryPath;
    el.directoryList.replaceChildren();
    const entries = Array.isArray(message.entries) ? [...message.entries] : [];
    entries.sort((a, b) => Number(Boolean(b.isDirectory)) - Number(Boolean(a.isDirectory)) || String(a.name).localeCompare(String(b.name), "zh-CN"));
    for (const item of entries) {
      const button = create("button", "directory-entry");
      button.type = "button";
      button.disabled = !item.isDirectory;
      append(button,
        create("span", "entry-icon", item.isDirectory ? "▰" : "·"),
        create("span", "", item.name || item.path),
        create("small", "", item.isDirectory ? "DIR" : "FILE"),
      );
      if (item.isDirectory) button.addEventListener("click", () => sendWire({ type: "listDir", path: item.path }));
      el.directoryList.appendChild(button);
    }
    if (!entries.length) el.directoryList.appendChild(create("div", "empty-list", "此目录为空"));
  }

  function renderDirectoryRoots(message) {
    state.directoryPath = null;
    el.directoryPath.textContent = "此电脑 / 选择磁盘";
    el.directoryPath.title = "选择磁盘";
    el.directoryUpBtn.disabled = true;
    el.mkdirBtn.disabled = true;
    el.mkdirName.disabled = true;
    el.useDirectoryBtn.disabled = true;
    el.directoryList.replaceChildren();
    const roots = Array.isArray(message.roots) ? message.roots : [];
    for (const root of roots) {
      if (typeof root?.path !== "string") continue;
      const button = create("button", "directory-entry");
      button.type = "button";
      append(button,
        create("span", "entry-icon", "▣"),
        create("span", "", root.name || root.path),
        create("small", "", "DISK"),
      );
      button.addEventListener("click", () => sendWire({ type: "listDir", path: root.path }));
      el.directoryList.appendChild(button);
    }
    if (!el.directoryList.childElementCount) el.directoryList.appendChild(create("div", "empty-list", "未找到可用磁盘"));
  }

  function captureApprovalDraft() {
    const current = state.approvals[0];
    if (!current?.id || el.approvalSheet.hidden
      || !["user_input", "mcp_elicitation"].includes(current.kind)) return;
    const questions = new Map();
    for (const fieldset of el.approvalForm.querySelectorAll("[data-question-id]")) {
      const selected = fieldset.querySelector("input[type=radio]:checked");
      questions.set(fieldset.dataset.questionId, {
        selected: selected?.value ?? null,
        text: fieldset.querySelector("[data-answer-text]")?.value ?? "",
      });
    }
    state.approvalDrafts.delete(current.id);
    state.approvalDrafts.set(current.id, {
      questions,
      mcpContent: el.approvalForm.querySelector("[data-mcp-content]")?.value ?? "",
    });
    while (state.approvalDrafts.size > 24) {
      state.approvalDrafts.delete(state.approvalDrafts.keys().next().value);
    }
  }

  function restoreApprovalDraft(current) {
    const draft = state.approvalDrafts.get(current?.id);
    if (!draft) return;
    for (const fieldset of el.approvalForm.querySelectorAll("[data-question-id]")) {
      const answer = draft.questions?.get(fieldset.dataset.questionId);
      if (!answer) continue;
      for (const radio of fieldset.querySelectorAll("input[type=radio]")) {
        radio.checked = radio.value === answer.selected;
      }
      const input = fieldset.querySelector("[data-answer-text]");
      if (input) input.value = answer.text;
    }
    const mcp = el.approvalForm.querySelector("[data-mcp-content]");
    if (mcp) mcp.value = draft.mcpContent;
  }

  function addApproval(message) {
    captureApprovalDraft();
    const existing = state.approvals.findIndex((item) => item.id === message.id);
    if (existing >= 0) state.approvals[existing] = message;
    else state.approvals.push(message);
    showApproval();
    navigator.vibrate?.([80, 50, 80]);
  }

  function closeApproval(id) {
    captureApprovalDraft();
    state.approvals = state.approvals.filter((item) => item.id !== id);
    state.approvalDrafts.delete(id);
    showApproval();
  }

  function approvalKindLabel(kind) {
    return {
      command: "COMMAND REVIEW", file: "FILE REVIEW", user_input: "INPUT NEEDED",
      permissions: "PERMISSION GRANT", mcp_elicitation: "MCP CONNECTOR",
    }[kind] || "ACTION REVIEW";
  }

  function approvalTitle(kind) {
    return {
      command: "允许执行这条命令？", file: "允许修改这些文件？", user_input: "Codex 需要你的回答",
      permissions: "授予额外权限？", mcp_elicitation: "连接器请求输入",
    }[kind] || "Codex 请求确认";
  }

  function addApprovalField(list, label, value, command = false) {
    if (value === undefined || value === null || value === "") return;
    const row = create("div", "approval-field");
    const term = create("dt", "", label);
    const detail = create("dd", command ? "approval-command" : "", typeof value === "string" ? value : compactJson(value));
    append(row, term, detail);
    list.appendChild(row);
  }

  function actionButton(label, className, handler) {
    const button = create("button", className, label);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  function approvalQuestion(question, index) {
    const fieldset = create("fieldset", "approval-question");
    const id = question?.id || `question-${index}`;
    fieldset.dataset.questionId = id;
    const legend = create("legend", "", question?.header || question?.question || `问题 ${index + 1}`);
    fieldset.appendChild(legend);
    if (question?.header && question?.question) fieldset.appendChild(create("p", "", question.question));
    const options = Array.isArray(question?.options) ? question.options : [];
    for (const [optionIndex, option] of options.entries()) {
      const label = create("label", "approval-option");
      const radio = create("input");
      radio.type = "radio";
      radio.name = `approval-${id}`;
      radio.value = option?.label || String(optionIndex + 1);
      if (optionIndex === 0) radio.checked = true;
      const copy = create("span");
      append(copy, create("strong", "", option?.label || `选项 ${optionIndex + 1}`), create("small", "", option?.description || ""));
      append(label, radio, copy);
      fieldset.appendChild(label);
    }
    if (!options.length || question?.isOther) {
      let otherRadio = null;
      if (question?.isOther) {
        const label = create("label", "approval-option");
        otherRadio = create("input");
        otherRadio.type = "radio";
        otherRadio.name = `approval-${id}`;
        otherRadio.value = "__codex_other__";
        otherRadio.dataset.otherAnswer = "true";
        const copy = create("span");
        append(copy, create("strong", "", "其他"), create("small", "", "输入自定义回答"));
        append(label, otherRadio, copy);
        fieldset.appendChild(label);
      }
      const input = create("input");
      input.type = question?.isSecret ? "password" : "text";
      input.placeholder = question?.isOther ? "其他回答" : "输入回答";
      input.dataset.answerText = "true";
      if (otherRadio) {
        input.addEventListener("focus", () => { otherRadio.checked = true; });
        input.addEventListener("input", () => { otherRadio.checked = true; });
      }
      fieldset.appendChild(input);
    }
    return fieldset;
  }

  function collectQuestionAnswers() {
    const answers = {};
    for (const fieldset of el.approvalForm.querySelectorAll("[data-question-id]")) {
      const id = fieldset.dataset.questionId;
      const selected = fieldset.querySelector("input[type=radio]:checked");
      const text = fieldset.querySelector("[data-answer-text]")?.value?.trim();
      const values = [];
      if (selected?.dataset.otherAnswer === "true") {
        if (text) values.push(text);
      } else if (selected?.value) {
        values.push(selected.value);
      } else if (text) {
        values.push(text);
      }
      answers[id] = values;
    }
    return answers;
  }

  function decideApproval(action, payload = {}) {
    const current = state.approvals[0];
    if (!current) return;
    for (const button of el.approvalActions.querySelectorAll("button")) button.disabled = true;
    if (!sendWire({ type: "permission", id: current.id, action, payload })) {
      for (const button of el.approvalActions.querySelectorAll("button")) button.disabled = false;
    }
  }

  function showApproval() {
    const current = state.approvals[0];
    if (!current) { deactivateModal(el.approvalSheet); return; }
    el.approvalSheet.hidden = false;
    const finalize = () => {
      restoreApprovalDraft(current);
      activateModal(el.approvalSheet, el.approvalActions.querySelector("button"));
    };
    el.approvalKind.textContent = approvalKindLabel(current.kind);
    el.approvalTitle.textContent = approvalTitle(current.kind);
    el.approvalCount.textContent = `1 / ${state.approvals.length}`;
    el.approvalBody.replaceChildren();
    el.approvalForm.replaceChildren();
    el.approvalActions.replaceChildren();
    const fields = create("dl");
    addApprovalField(fields, "原因", current.reason);
    addApprovalField(fields, "工作目录", current.cwd);
    addApprovalField(fields, "命令", current.command, true);
    addApprovalField(fields, "网络目标", current.networkTarget);
    addApprovalField(fields, "授权目录", current.grantRoot);
    addApprovalField(fields, "MCP 服务", current.serverName);
    addApprovalField(fields, "请求信息", current.message);
    addApprovalField(fields, "打开网址", current.url);
    addApprovalField(fields, "权限", current.permissions);
    addApprovalField(fields, "数据结构", current.requestedSchema);
    if (!fields.childNodes.length) addApprovalField(fields, "请求", current.method || current.kind);
    el.approvalBody.appendChild(fields);

    if (current.kind === "user_input") {
      for (const [index, question] of (current.questions || []).entries()) {
        el.approvalForm.appendChild(approvalQuestion(question, index));
      }
      append(el.approvalActions,
        actionButton("拒绝", "approval-deny", () => decideApproval("deny")),
        actionButton("提交回答", "approval-allow", () => decideApproval("answer", { answers: collectQuestionAnswers() })),
      );
      finalize();
      return;
    }

    if (current.kind === "permissions") {
      append(el.approvalActions,
        actionButton("拒绝", "approval-deny", () => decideApproval("deny")),
        actionButton("仅本轮授权", "approval-allow", () => decideApproval("grant", { permissions: current.permissions, scope: "turn" })),
        actionButton("本次会话授权", "approval-session", () => decideApproval("grant", { permissions: current.permissions, scope: "session" })),
      );
      finalize();
      return;
    }

    if (current.kind === "mcp_elicitation") {
      const input = create("textarea");
      input.rows = 3;
      input.placeholder = "可选：填写连接器需要的 JSON 或文本";
      input.dataset.mcpContent = "true";
      el.approvalForm.appendChild(input);
      append(el.approvalActions,
        actionButton("拒绝", "approval-deny", () => decideApproval("deny")),
        actionButton("允许并提交", "approval-allow", () => {
          const raw = input.value.trim();
          let content = raw;
          if (raw) { try { content = JSON.parse(raw); } catch { /* plain text is valid */ } }
          decideApproval("answer", raw ? { content } : {});
        }),
      );
      finalize();
      return;
    }

    append(el.approvalActions,
      actionButton("拒绝", "approval-deny", () => decideApproval("deny")),
      actionButton("允许一次", "approval-allow", () => decideApproval("allow")),
    );
    if (current.eligibleForSessionAuto) {
      el.approvalActions.appendChild(actionButton("本次服务自动", "approval-session", () => decideApproval("allowSession")));
    }
    finalize();
  }

  const MODAL_FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

  function modalFocusables(modal) {
    return [...modal.querySelectorAll(MODAL_FOCUSABLE)]
      .filter((node) => !node.hidden && node.getClientRects().length > 0);
  }

  function updateModalState() {
    const top = state.modalStack.at(-1)?.modal ?? null;
    for (const child of document.body.children) child.inert = Boolean(top && child !== top);
    for (const modal of [el.approvalSheet, el.screenViewer, el.controlViewer, el.scannerModal, el.artifactPreview]) {
      modal.classList.toggle("is-modal-top", modal === top);
    }
  }

  function activateModal(modal, preferredFocus) {
    const existing = state.modalStack.findIndex((record) => record.modal === modal);
    const record = existing >= 0
      ? state.modalStack.splice(existing, 1)[0]
      : { modal, restoreFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    modal.hidden = false;
    state.modalStack.push(record);
    updateModalState();
    requestAnimationFrame(() => {
      const target = preferredFocus?.isConnected ? preferredFocus : modalFocusables(modal)[0] || modal;
      if (target === modal && !modal.hasAttribute("tabindex")) modal.tabIndex = -1;
      target.focus?.();
    });
  }

  function deactivateModal(modal) {
    const index = state.modalStack.findIndex((record) => record.modal === modal);
    if (index < 0) { modal.hidden = true; return; }
    const wasTop = index === state.modalStack.length - 1;
    const [record] = state.modalStack.splice(index, 1);
    modal.hidden = true;
    updateModalState();
    if (!wasTop) return;
    requestAnimationFrame(() => {
      const next = state.modalStack.at(-1)?.modal;
      const restore = record.restoreFocus;
      if (restore?.isConnected && (!next || next.contains(restore))) restore.focus?.();
      else if (next) (modalFocusables(next)[0] || next).focus?.();
    });
  }

  function trapModalFocus(event) {
    if (event.key !== "Tab") return;
    const modal = state.modalStack.at(-1)?.modal;
    if (!modal) return;
    const items = modalFocusables(modal);
    if (!items.length) { event.preventDefault(); modal.focus(); return; }
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  function openDrawer(drawer) {
    for (const item of [el.historyDrawer, el.settingsDrawer, el.workspaceDrawer, el.artifactsDrawer]) item.hidden = item !== drawer;
    el.drawerBackdrop.hidden = false;
    drawer.hidden = false;
    drawer.querySelector("input,button,select,textarea")?.focus();
  }

  function closeDrawers() {
    el.drawerBackdrop.hidden = true;
    el.historyDrawer.hidden = true;
    el.settingsDrawer.hidden = true;
    el.workspaceDrawer.hidden = true;
    el.artifactsDrawer.hidden = true;
  }

  const artifactUI = globalThis.CodexArtifactUI.createController({
    elements: {
      trigger: el.artifactsBtn,
      badge: el.artifactBadge,
      drawer: el.artifactsDrawer,
      refresh: el.artifactRefreshBtn,
      status: el.artifactStatus,
      list: el.artifactList,
      preview: el.artifactPreview,
      close: el.artifactPreviewCloseBtn,
      title: el.artifactPreviewTitle,
      meta: el.artifactPreviewMeta,
      body: el.artifactPreviewBody,
      pageStatus: el.artifactPageStatus,
      previousPage: el.artifactPrevPageBtn,
      nextPage: el.artifactNextPageBtn,
      fit: el.artifactFitBtn,
      download: el.artifactDownloadBtn,
    },
    sendWire,
    backendOrigin: () => new URL(state.backend?.origin || location.origin),
    addTimelineEntry: (records, result) => {
      const { card } = addEntry("assistant", "CODEX / OUTPUTS");
      const sortedRecords = [...records].sort((a, b) => Number(b.revision) - Number(a.revision));
      const visibleRecords = sortedRecords.slice(0, 4);
      const heading = create("div", "artifact-timeline-heading");
      append(heading,
        create("strong", "", `本次产出 · ${sortedRecords.length} 个文件`),
        create("small", "", "已保存到任务产出中心"),
      );
      const summaries = create("div", "artifact-timeline-list");
      for (const record of visibleRecords) {
        const summary = create("button", "artifact-summary");
        summary.type = "button";
        summary.setAttribute("aria-label", `打开 ${record.displayName || record.relativePath || "未命名文件"}`);
        const summaryHead = create("span", "artifact-summary-head");
        append(summaryHead,
          create("strong", "", record.displayName || record.relativePath || "未命名文件"),
          create("span", "artifact-change-label", globalThis.CodexArtifactUI.changeLabel(record.kind)),
        );
        const summaryPath = create("small", "artifact-summary-path", record.relativePath || "工作区产出");
        const summaryMeta = create("span", "artifact-summary-meta");
        append(summaryMeta,
          create("span", "", globalThis.CodexArtifactUI.typeLabel(record)),
          create("span", "", globalThis.CodexArtifactUI.formatBytes(record.size)),
        );
        summary.append(summaryHead, summaryPath, summaryMeta);
        summary.addEventListener("click", () => { void artifactUI.open(record); });
        summaries.appendChild(summary);
      }
      const timelineFooter = create("div", "artifact-timeline-footer");
      const remainder = Math.max(0, sortedRecords.length - visibleRecords.length);
      timelineFooter.appendChild(create("span", "artifact-remainder", remainder ? `另有 ${remainder} 个产出` : "所有产出已列出"));
      const viewAll = create("button", "artifact-view-all", "查看全部");
      viewAll.type = "button";
      viewAll.addEventListener("click", () => artifactUI.showAll());
      timelineFooter.appendChild(viewAll);
      card.append(heading, summaries, timelineFooter);
      if (result?.complete === false) {
        card.appendChild(create("small", "artifact-partial-note", "部分目录未完成扫描，可在产出抽屉中刷新。"));
      }
    },
    openDrawer,
    closeDrawers,
    activateModal,
    deactivateModal,
  });

  function openWorkspace() {
    if (!state.cwd) { toast("工作目录尚未同步", "error"); return; }
    state.directoryPath = state.cwd;
    openDrawer(el.workspaceDrawer);
    sendWire({ type: "listDir", path: state.cwd });
  }

  function requestScreenshot() {
    if (state.screenPending || !state.connected) return;
    state.screenPending = true;
    el.screenHint.hidden = false;
    el.screenHint.querySelector("p").textContent = "正在获取屏幕画面…";
    if (!sendWire({ type: "screenshot" })) state.screenPending = false;
  }

  function stopScreenTimer() {
    if (state.screenTimer) clearTimeout(state.screenTimer);
    state.screenTimer = null;
  }

  function handleScreenshot(data) {
    state.screenPending = false;
    if (typeof data !== "string" || !data.startsWith("data:image/jpeg;base64,")) {
      toast("收到的屏幕画面无效", "error");
      return;
    }
    state.lastScreenshot = data;
    el.screenImage.src = data;
    el.controlImage.src = data;
    el.screenImage.hidden = false;
    el.screenHint.hidden = true;
    stopScreenTimer();
    if (el.screenAuto.checked && (!el.screenViewer.hidden || !el.controlViewer.hidden)) {
      state.screenTimer = setTimeout(requestScreenshot, 260);
    }
  }

  function openScreen() {
    closeDrawers();
    activateModal(el.screenViewer, el.screenCloseBtn);
    requestScreenshot();
  }

  function closeScreen() {
    deactivateModal(el.screenViewer);
    el.screenAuto.checked = false;
    stopScreenTimer();
  }

  function openControl() {
    activateModal(el.controlViewer, el.controlExitBtn);
    resetControlTransform();
    el.screenAuto.checked = true;
    requestScreenshot();
  }

  function closeControl() {
    deactivateModal(el.controlViewer);
    el.screenAuto.checked = false;
    stopScreenTimer();
    requestScreenshot();
  }

  function updateControlTransform() {
    const control = state.control;
    el.controlTransform.style.transform = `translate(${control.tx}px, ${control.ty}px) scale(${control.zoom})`;
    el.controlResetBtn.textContent = `${control.zoom.toFixed(control.zoom === 1 ? 0 : 1)}×`;
  }

  function resetControlTransform() {
    Object.assign(state.control, { zoom: 1, tx: 0, ty: 0 });
    updateControlTransform();
  }

  function mapControlPoint(clientX, clientY) {
    if (!el.controlImage.naturalWidth || !el.controlImage.naturalHeight) return null;
    const rect = el.controlImage.getBoundingClientRect();
    const imageRatio = el.controlImage.naturalWidth / el.controlImage.naturalHeight;
    const boxRatio = rect.width / rect.height;
    let width;
    let height;
    let left;
    let top;
    if (boxRatio > imageRatio) {
      height = rect.height;
      width = height * imageRatio;
      left = rect.left + (rect.width - width) / 2;
      top = rect.top;
    } else {
      width = rect.width;
      height = width / imageRatio;
      left = rect.left;
      top = rect.top + (rect.height - height) / 2;
    }
    if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;
    return {
      rx: Math.max(0, Math.min(1, (clientX - left) / width)),
      ry: Math.max(0, Math.min(1, (clientY - top) / height)),
    };
  }

  function showControlRipple(clientX, clientY) {
    const rect = el.controlStage.getBoundingClientRect();
    el.controlRipple.style.left = `${clientX - rect.left}px`;
    el.controlRipple.style.top = `${clientY - rect.top}px`;
    el.controlRipple.classList.remove("is-active");
    void el.controlRipple.offsetWidth;
    el.controlRipple.classList.add("is-active");
  }

  function sendControl(action, point, text = "") {
    const payload = { type: "control", action };
    if (point) Object.assign(payload, point);
    if (text) payload.text = text;
    if (sendWire(payload) && point) showControlRipple(
      state.control.startPoint?.clientX ?? 0,
      state.control.startPoint?.clientY ?? 0,
    );
  }

  function clearLongPress() {
    if (state.control.longTimer) clearTimeout(state.control.longTimer);
    state.control.longTimer = null;
  }

  function pointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    el.controlStage.setPointerCapture?.(event.pointerId);
    state.control.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.control.pointers.size === 1) {
      state.control.startPoint = { clientX: event.clientX, clientY: event.clientY };
      state.control.panStart = { x: event.clientX, y: event.clientY, tx: state.control.tx, ty: state.control.ty };
      state.control.moved = false;
      state.control.longFired = false;
      clearLongPress();
      state.control.longTimer = setTimeout(() => {
        if (state.control.moved || state.control.pointers.size !== 1) return;
        const point = mapControlPoint(event.clientX, event.clientY);
        if (!point) return;
        state.control.longFired = true;
        sendControl("rclick", point);
        navigator.vibrate?.(40);
      }, 560);
    } else if (state.control.pointers.size === 2) {
      clearLongPress();
      const [a, b] = [...state.control.pointers.values()];
      state.control.pinchStart = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        zoom: state.control.zoom,
      };
    }
    event.preventDefault();
  }

  function pointerMove(event) {
    if (!state.control.pointers.has(event.pointerId)) return;
    state.control.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.control.pointers.size === 2 && state.control.pinchStart) {
      const [a, b] = [...state.control.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      state.control.zoom = Math.max(1, Math.min(5, state.control.pinchStart.zoom * distance / Math.max(1, state.control.pinchStart.distance)));
      state.control.moved = true;
      updateControlTransform();
    } else if (state.control.pointers.size === 1 && state.control.panStart) {
      const dx = event.clientX - state.control.panStart.x;
      const dy = event.clientY - state.control.panStart.y;
      if (Math.hypot(dx, dy) > 7) {
        state.control.moved = true;
        clearLongPress();
      }
      if (state.control.zoom > 1 && state.control.moved) {
        state.control.tx = state.control.panStart.tx + dx;
        state.control.ty = state.control.panStart.ty + dy;
        updateControlTransform();
      }
    }
    event.preventDefault();
  }

  function pointerUp(event) {
    if (!state.control.pointers.has(event.pointerId)) return;
    const wasMulti = state.control.pointers.size > 1;
    state.control.pointers.delete(event.pointerId);
    clearLongPress();
    if (event.type !== "pointercancel" && !wasMulti && !state.control.longFired && (!state.control.moved || state.control.action === "move")) {
      const point = mapControlPoint(event.clientX, event.clientY);
      if (point) {
        state.control.startPoint = { clientX: event.clientX, clientY: event.clientY };
        sendControl(state.control.action, point);
      }
    }
    if (!state.control.pointers.size) {
      state.control.startPoint = null;
      state.control.panStart = null;
      state.control.pinchStart = null;
    }
    event.preventDefault();
  }

  function notificationEnabled() {
    return storageGet(NOTIFY_KEY) === "1";
  }

  function refreshNotificationStatus() {
    el.notificationToggle.checked = notificationEnabled();
    if (!("Notification" in window)) {
      el.notificationStatus.textContent = "此浏览器不支持系统通知，仍可使用振动。";
      return;
    }
    const labels = { granted: "系统通知已授权。", denied: "系统已拒绝通知权限。", default: "开启时将请求系统通知权限。" };
    el.notificationStatus.textContent = labels[Notification.permission] || "任务完成后发送提醒。";
  }

  function notifyCompletion(status, error) {
    navigator.vibrate?.(error ? [100, 60, 100] : [70, 40, 70]);
    if (!notificationEnabled() || document.visibilityState === "visible" || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const notification = new Notification(error ? "Codex 任务需要检查" : "Codex 任务完成", {
        body: error ? "任务结束时返回了错误。" : `状态：${status}`,
        icon: "icon.svg",
        tag: "codex-remote-result",
      });
      notification.onclick = () => { window.focus(); notification.close(); };
    } catch { /* notification is optional */ }
  }

  async function openScanner() {
    if (!navigator.mediaDevices?.getUserMedia) { toast("此设备不支持相机扫码", "error"); return; }
    activateModal(el.scannerModal, el.scannerCloseBtn);
    el.scannerHint.textContent = "请允许相机权限，并将二维码放入框内。";
    try {
      state.scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      el.scannerVideo.srcObject = state.scannerStream;
      await el.scannerVideo.play();
      scanFrame();
    } catch {
      el.scannerHint.textContent = "无法打开相机。请在设置中允许相机权限，或粘贴连接网址。";
    }
  }

  function closeScanner() {
    if (state.scannerFrame) cancelAnimationFrame(state.scannerFrame);
    state.scannerFrame = 0;
    for (const track of state.scannerStream?.getTracks?.() || []) track.stop();
    state.scannerStream = null;
    el.scannerVideo.srcObject = null;
    deactivateModal(el.scannerModal);
  }

  function scanFrame() {
    if (el.scannerModal.hidden) return;
    const video = el.scannerVideo;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && typeof globalThis.jsQR === "function") {
      const max = 720;
      const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      el.scannerCanvas.width = width;
      el.scannerCanvas.height = height;
      const context = el.scannerCanvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(video, 0, 0, width, height);
      const frame = context.getImageData(0, 0, width, height);
      const result = globalThis.jsQR(frame.data, width, height, { inversionAttempts: "attemptBoth" });
      if (result?.data) {
        try {
          const backend = parseBackendUrl(result.data);
          persistBackend(backend);
          closeScanner();
          toast("连接码已保存，正在连接");
          void connect(true);
          return;
        } catch {
          el.scannerHint.textContent = "识别到的二维码不是 Codex Remote 连接码。";
        }
      }
    }
    state.scannerFrame = requestAnimationFrame(scanFrame);
  }

  function setupVoice() {
    const SpeechRecognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!SpeechRecognition) { el.micBtn.hidden = true; return; }
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    let base = "";
    recognition.addEventListener("start", () => {
      base = el.input.value;
      el.micBtn.classList.add("is-active");
      el.micBtn.setAttribute("aria-label", "停止语音输入");
    });
    recognition.addEventListener("result", (event) => {
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) transcript += event.results[index][0]?.transcript || "";
      el.input.value = `${base}${base && transcript ? " " : ""}${transcript}`;
      autoResizeInput();
    });
    const stop = () => {
      el.micBtn.classList.remove("is-active");
      el.micBtn.setAttribute("aria-label", "语音输入");
    };
    recognition.addEventListener("end", stop);
    recognition.addEventListener("error", () => { stop(); toast("语音输入未成功", "error"); });
    state.recognition = recognition;
    el.micBtn.addEventListener("click", () => {
      if (el.micBtn.classList.contains("is-active")) recognition.stop();
      else { try { recognition.start(); } catch { /* already starting */ } }
    });
  }

  function registerEvents() {
    el.composer.addEventListener("submit", (event) => { event.preventDefault(); submitPrompt(); });
    el.input.addEventListener("input", autoResizeInput);
    el.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submitPrompt();
      }
    });
    el.input.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
      if (files.length) { event.preventDefault(); void addImageFiles(files); }
    });
    el.attachBtn.addEventListener("click", () => el.imageInput.click());
    el.imageInput.addEventListener("change", () => {
      void addImageFiles([...(el.imageInput.files || [])]);
      el.imageInput.value = "";
    });
    el.stopBtn.addEventListener("click", () => sendWire({ type: "interrupt" }));

    el.messages.addEventListener("scroll", () => {
      state.stickToBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 90;
    }, { passive: true });
    el.messages.addEventListener("click", (event) => {
      const starter = event.target.closest("[data-starter]");
      if (starter) submitPrompt(starter.dataset.starter);
    });
    el.brandBtn.addEventListener("click", () => { state.stickToBottom = true; scrollToBottom(); });

    el.historyBtn.addEventListener("click", () => {
      openDrawer(el.historyDrawer);
      sendWire({ type: "listConversations", searchTerm: el.conversationSearch.value.trim() || undefined });
      renderConversations();
    });
    el.settingsBtn.addEventListener("click", () => {
      openDrawer(el.settingsDrawer);
      sendWire({ type: "listModels" });
      updateBackendStatus();
    });
    el.modelBtn.addEventListener("click", () => { openDrawer(el.settingsDrawer); sendWire({ type: "listModels" }); el.modelSelect.focus(); });
    el.cwdBtn.addEventListener("click", openWorkspace);
    el.browseCwdBtn.addEventListener("click", openWorkspace);
    el.drawerBackdrop.addEventListener("click", closeDrawers);
    for (const button of document.querySelectorAll("[data-close-drawer]")) button.addEventListener("click", closeDrawers);

    let searchTimer;
    el.conversationSearch.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => sendWire({ type: "listConversations", searchTerm: el.conversationSearch.value.trim() || undefined }), 250);
    });
    el.newConversationBtn.addEventListener("click", () => {
      sendWire({ type: "newConversation", cwd: state.cwd, model: state.model, effort: state.effort });
      clearTimeline();
      closeDrawers();
      toast("已开始新会话");
    });

    el.modelSelect.addEventListener("change", () => {
      state.model = el.modelSelect.value || null;
      sendWire({ type: "setModel", model: state.model });
      el.currentModel.textContent = state.model || "Codex 默认";
      refreshEffortOptions();
    });
    el.effortSelect.addEventListener("change", () => {
      state.effort = el.effortSelect.value || null;
      sendWire({ type: "setEffort", effort: state.effort });
    });
    el.sessionAutoToggle.addEventListener("change", () => {
      if (!sendWire({ type: "setSessionAuto", enabled: el.sessionAutoToggle.checked })) {
        el.sessionAutoToggle.checked = state.sessionAuto;
        return;
      }
      if (el.sessionAutoToggle.checked) toast("自动审批只对可证明为只读的命令生效");
    });

    el.notificationToggle.addEventListener("change", async () => {
      if (el.notificationToggle.checked && "Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch { /* keep vibration fallback */ }
      }
      storageSet(NOTIFY_KEY, el.notificationToggle.checked ? "1" : "0");
      refreshNotificationStatus();
    });

    el.saveBackendBtn.addEventListener("click", () => {
      try {
        persistBackend(parseBackendUrl(el.backendUrl.value));
        el.backendUrl.value = "";
        toast("连接信息已保存");
        void connect(true);
      } catch (error) { toast(error?.message || "连接网址无效", "error"); }
    });
    el.reconnectBtn.addEventListener("click", () => void connect(true));
    el.scanBtn.addEventListener("click", openScanner);
    el.scannerCloseBtn.addEventListener("click", closeScanner);

    el.saveQuickBtn.addEventListener("click", () => {
      const parsed = parseQuick(el.quickEditor.value);
      if (!parsed.length) { toast("至少保留一条“名称 | 提示词”", "error"); return; }
      state.quick = parsed;
      storageSet(QUICK_KEY, JSON.stringify(parsed));
      renderQuick();
      toast("快捷任务已保存");
    });
    el.resetQuickBtn.addEventListener("click", () => {
      state.quick = [...DEFAULT_QUICK];
      storageSet(QUICK_KEY, JSON.stringify(state.quick));
      renderQuick();
    });

    el.directoryRootsBtn.addEventListener("click", () => sendWire({ type: "listRoots" }));
    el.directoryUpBtn.addEventListener("click", () => {
      const parent = parentPath(state.directoryPath);
      if (parent) sendWire({ type: "listDir", path: parent });
    });
    el.mkdirBtn.addEventListener("click", () => {
      const name = el.mkdirName.value.trim();
      if (!name || /[\\/:*?"<>|]/.test(name)) { toast("文件夹名称不合法", "error"); return; }
      sendWire({ type: "mkdir", path: joinPath(state.directoryPath, name) });
      el.mkdirName.value = "";
    });
    el.useDirectoryBtn.addEventListener("click", () => {
      if (!state.directoryPath) return;
      sendWire({ type: "newConversation", cwd: state.directoryPath, model: state.model, effort: state.effort });
      clearTimeline();
      closeDrawers();
      toast("已在所选目录开始新会话");
    });

    el.screenBtn.addEventListener("click", openScreen);
    el.screenRefreshBtn.addEventListener("click", requestScreenshot);
    el.screenCloseBtn.addEventListener("click", closeScreen);
    el.screenAuto.addEventListener("change", () => {
      stopScreenTimer();
      if (el.screenAuto.checked) requestScreenshot();
    });
    el.openControlBtn.addEventListener("click", openControl);
    el.controlExitBtn.addEventListener("click", closeControl);
    el.controlRefreshBtn.addEventListener("click", requestScreenshot);
    el.controlResetBtn.addEventListener("click", resetControlTransform);
    for (const button of document.querySelectorAll("[data-pointer-action]")) {
      button.addEventListener("click", () => {
        state.control.action = button.dataset.pointerAction;
        for (const peer of document.querySelectorAll("[data-pointer-action]")) {
          const active = peer === button;
          peer.classList.toggle("is-active", active);
          peer.setAttribute("aria-pressed", String(active));
        }
        el.controlHint.textContent = `${button.textContent}模式 · 长按可右键 · 双指缩放`;
      });
    }
    for (const button of document.querySelectorAll("[data-key]")) button.addEventListener("click", () => sendControl("key", null, button.dataset.key));
    for (const button of document.querySelectorAll("[data-combo]")) button.addEventListener("click", () => sendControl("combo", null, button.dataset.combo));
    el.controlTypeBtn.addEventListener("click", () => {
      const text = el.controlText.value;
      if (!text) return;
      sendControl("type", null, text);
      el.controlText.value = "";
    });
    el.controlText.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); el.controlTypeBtn.click(); }
    });
    el.controlStage.addEventListener("pointerdown", pointerDown);
    el.controlStage.addEventListener("pointermove", pointerMove);
    el.controlStage.addEventListener("pointerup", pointerUp);
    el.controlStage.addEventListener("pointercancel", pointerUp);
    el.controlStage.addEventListener("wheel", (event) => {
      state.control.zoom = Math.max(1, Math.min(5, state.control.zoom + (event.deltaY < 0 ? .25 : -.25)));
      updateControlTransform();
      event.preventDefault();
    }, { passive: false });

    document.addEventListener("keydown", (event) => {
      trapModalFocus(event);
      if (event.defaultPrevented || event.key !== "Escape") return;
      const top = state.modalStack.at(-1)?.modal;
      if (top === el.approvalSheet) { event.preventDefault(); return; }
      if (top === el.artifactPreview) artifactUI.closePreview();
      else if (top === el.scannerModal) closeScanner();
      else if (top === el.controlViewer) closeControl();
      else if (top === el.screenViewer) closeScreen();
      else closeDrawers();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void connect(true);
    });
    window.addEventListener("pageshow", (event) => { if (event.persisted) void connect(true); });
    window.addEventListener("online", () => void connect(true));
    window.addEventListener("offline", () => setConnection("offline", "设备离线"));
    window.addEventListener("pagehide", (event) => { if (!event.persisted) artifactUI.destroy(); });
  }

  function registerServiceWorker() {
    if (globalThis.Capacitor) return;
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => { /* offline support is optional */ });
    });
  }

  function init() {
    state.backend = loadBackend();
    state.quick = loadQuick();
    updateBackendStatus();
    renderQuick();
    renderAttachments();
    refreshNotificationStatus();
    registerEvents();
    setupVoice();
    registerServiceWorker();
    autoResizeInput();
    void connect();
  }

  init();
})();
