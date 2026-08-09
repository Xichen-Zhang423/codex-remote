"use strict";

const WAITING_REMOTE = "正在建立安全公网隧道…";
const WAITING_LAN = "等待局域网地址…";
const PANEL_UNAUTHORIZED = "本机面板权限已失效，请从启动窗口重新打开。";

function blankConnection(state, status, busy = false) {
  return {
    state,
    status,
    displayUrl: "",
    qrDataUrl: "",
    error: "",
    copyEnabled: false,
    busy,
  };
}

function originOf(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function createPanelController({
  request,
  view,
  timers = globalThis,
  now = Date.now,
} = {}) {
  if (typeof request !== "function") throw new TypeError("request must be a function");
  if (!view) throw new TypeError("view is required");

  const modes = {
    remote: { epoch: 0, origin: "", copyUrl: "", expiryTimer: null },
    lan: { epoch: 0, origin: "", copyUrl: "", expiryTimer: null },
  };
  let stateEpoch = 0;
  let pollTimer = null;
  let pollingAllowed = true;
  let started = false;
  let pageVisible = true;
  let lanVisible = false;
  let revoked = false;

  const callView = (method, ...args) => view[method]?.(...args);

  function clearExpiry(mode) {
    const slot = modes[mode];
    if (slot.expiryTimer !== null) {
      timers.clearTimeout(slot.expiryTimer);
      slot.expiryTimer = null;
    }
  }

  function invalidate(mode) {
    const slot = modes[mode];
    slot.epoch += 1;
    slot.copyUrl = "";
    clearExpiry(mode);
  }

  function renderWaiting(mode) {
    callView("renderConnection", mode, blankConnection(
      "waiting",
      mode === "remote" ? WAITING_REMOTE : WAITING_LAN,
      mode === "remote",
    ));
  }

  function revokeAccess() {
    if (revoked) return;
    revoked = true;
    pollingAllowed = false;
    stateEpoch += 1;
    stopPolling();
    for (const mode of ["remote", "lan"]) {
      modes[mode].origin = "";
      invalidate(mode);
    }
    lanVisible = false;
    callView("renderConnection", "remote", blankConnection(
      "unauthorized",
      PANEL_UNAUTHORIZED,
    ));
    callView("renderConnection", "lan", blankConnection("hidden", ""));
    callView("setLanVisible", false);
    callView("setConnectionOptionsOpen", false);
    callView("setPanelStatus", PANEL_UNAUTHORIZED);
    callView("setActionsVisible", false);
    callView("setAccessRevoked", true);
  }

  function expire(mode, epoch) {
    const slot = modes[mode];
    if (slot.epoch !== epoch) return;
    slot.expiryTimer = null;
    slot.copyUrl = "";
    callView("renderConnection", mode, blankConnection(
      "expired",
      mode === "remote" ? "公网连接信息已过期，请重试。" : "局域网连接信息已过期，请重新显示。",
    ));
  }

  async function loadConnection(mode) {
    if (revoked) return false;
    const slot = modes[mode];
    const epoch = ++slot.epoch;
    slot.copyUrl = "";
    clearExpiry(mode);
    callView("renderConnection", mode, blankConnection(
      "loading",
      mode === "remote" ? "正在生成公网连接…" : "正在生成局域网连接…",
      true,
    ));

    try {
      const result = await request("/api/panel/connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (slot.epoch !== epoch || (mode === "lan" && !lanVisible)) return false;

      const expiresAt = Number(result?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
        expire(mode, epoch);
        return false;
      }

      slot.copyUrl = typeof result?.copyUrl === "string" ? result.copyUrl : "";
      callView("renderConnection", mode, {
        state: "ready",
        status: mode === "remote" ? "公网连接已就绪" : "局域网连接已就绪",
        displayUrl: typeof result?.displayUrl === "string" ? result.displayUrl : "",
        qrDataUrl: typeof result?.qrDataUrl === "string" ? result.qrDataUrl : "",
        error: typeof result?.qrError === "string" ? result.qrError : "",
        copyEnabled: Boolean(slot.copyUrl),
        busy: false,
      });
      slot.expiryTimer = timers.setTimeout(() => expire(mode, epoch), expiresAt - now());
      return true;
    } catch (error) {
      if (error?.status === 401) {
        revokeAccess();
        return false;
      }
      if (slot.epoch !== epoch || (mode === "lan" && !lanVisible)) return false;
      slot.copyUrl = "";
      callView("renderConnection", mode, {
        ...blankConnection(
          "error",
          mode === "remote" ? "公网连接暂不可用" : "局域网连接暂不可用",
        ),
        error: error?.message || "连接请求失败",
      });
      return false;
    }
  }

  function syncOrigin(mode, nextOrigin) {
    const slot = modes[mode];
    if (slot.origin === nextOrigin) return;
    invalidate(mode);
    slot.origin = nextOrigin;

    if (mode === "remote") {
      if (nextOrigin) void loadConnection("remote");
      else renderWaiting("remote");
      return;
    }

    if (!lanVisible) return;
    if (nextOrigin) void loadConnection("lan");
    else renderWaiting("lan");
  }

  function stopPolling() {
    if (pollTimer === null) return;
    timers.clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    if (!pollingAllowed || pollTimer !== null) return;
    pollTimer = timers.setInterval(() => void refresh(), 5_000);
  }

  async function refresh() {
    if (revoked) return null;
    const epoch = ++stateEpoch;
    try {
      const state = await request("/api/panel/state");
      if (revoked || stateEpoch !== epoch) return null;
      callView("renderState", state);
      callView("setPanelStatus", "面板在线，状态仅在本机显示。");
      callView("setActionsVisible", true);
      syncOrigin("remote", originOf(state?.tunnelOrigin));
      syncOrigin("lan", originOf(state?.lanOrigin));
      return state;
    } catch (error) {
      if (error?.status === 401) {
        revokeAccess();
        return null;
      }
      if (revoked || stateEpoch !== epoch) return null;
      callView("setPanelStatus", error?.message || "状态刷新失败");
      return null;
    }
  }

  function retryRemote() {
    if (revoked) return Promise.resolve(false);
    invalidate("remote");
    if (!modes.remote.origin) {
      renderWaiting("remote");
      return Promise.resolve(false);
    }
    return loadConnection("remote");
  }

  function setConnectionOptionsOpen(open) {
    const optionsOpen = Boolean(open);
    callView("setConnectionOptionsOpen", optionsOpen);
    if (!optionsOpen && lanVisible) {
      hideLan(false);
      callView("focus", "connectionOptionsSummary");
    }
  }

  function showLan() {
    if (revoked) return Promise.resolve(false);
    if (lanVisible) return Promise.resolve(false);
    lanVisible = true;
    invalidate("lan");
    callView("setLanVisible", true);
    callView("focus", "lanConnection");
    if (!modes.lan.origin) {
      renderWaiting("lan");
      return Promise.resolve(false);
    }
    return loadConnection("lan");
  }

  function hideLan(restoreFocus = true) {
    if (!lanVisible) return;
    lanVisible = false;
    invalidate("lan");
    callView("renderConnection", "lan", blankConnection("hidden", ""));
    callView("setLanVisible", false);
    if (restoreFocus) callView("focus", "showLanConnection");
  }

  async function copy(mode) {
    const slot = modes[mode];
    const epoch = slot.epoch;
    const copyUrl = slot.copyUrl;
    if (!copyUrl) return false;
    const isCurrent = () => slot.epoch === epoch && slot.copyUrl === copyUrl;
    try {
      await callView("copyText", copyUrl);
      if (!isCurrent()) return false;
      callView("announceConnection", mode, "连接地址已复制");
      return true;
    } catch {
      if (!isCurrent()) return false;
      callView("setConnectionError", mode, "复制失败，请手动复制。");
      return false;
    }
  }

  async function stopService() {
    if (revoked) return false;
    if (callView("confirmStop") === false) return false;
    try {
      await request("/api/panel/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "STOP" }),
      });
      if (revoked) return false;
      callView("setPanelStatus", "服务正在安全停止…");
      return true;
    } catch (error) {
      if (error?.status === 401) {
        revokeAccess();
        return false;
      }
      if (revoked) return false;
      callView("setPanelStatus", error?.message || "停止服务失败");
      return false;
    }
  }

  function start() {
    if (started || revoked) return;
    started = true;
    pollingAllowed = true;
    callView("setActionsVisible", true);
    if (pageVisible) {
      startPolling();
      void refresh();
    }
  }

  function setPageVisible(visible) {
    const nextVisible = Boolean(visible);
    if (pageVisible === nextVisible) return;
    pageVisible = nextVisible;
    if (!pageVisible) {
      stopPolling();
      return;
    }
    if (!started || !pollingAllowed) return;
    startPolling();
    void refresh();
  }

  function stop() {
    started = false;
    stateEpoch += 1;
    stopPolling();
    invalidate("remote");
    invalidate("lan");
  }

  callView("setLanVisible", false);
  renderWaiting("remote");
  callView("renderConnection", "lan", blankConnection("hidden", ""));

  return {
    start,
    stop,
    refresh,
    retryRemote,
    setConnectionOptionsOpen,
    showLan,
    hideLan,
    copyRemote: () => copy("remote"),
    copyLan: () => copy("lan"),
    stopService,
    setPageVisible,
  };
}

export function createDomView(doc, browser) {
  const byId = (id) => doc.getElementById(id);
  const setValue = (id, value, fallback = "—") => {
    byId(id).textContent = value == null || value === "" ? fallback : String(value);
  };
  const setPlainText = (id, value) => {
    byId(id).textContent = typeof value === "string" ? value : "";
  };

  return {
    renderState(state) {
      setValue("serviceStatus", state?.serviceStatus);
      setValue("codexStatus", `${state?.codexStatus || "—"} / App Server ${state?.appServerStatus || "—"}`);
      setValue("workspace", state?.workspace);
      setValue("tunnelOrigin", state?.tunnelOrigin, "等待公网隧道");
      setValue("toolStatus", Object.entries(state?.tools || {})
        .map(([name, ready]) => `${name}: ${ready ? "可用" : "未发现"}`)
        .join(" · "));

      const diagnostics = Array.isArray(state?.diagnostics) ? state.diagnostics : [];
      const items = diagnostics.length ? diagnostics : ["暂无诊断信息"];
      byId("diagnostics").replaceChildren(...items.map((value) => {
        const item = doc.createElement("li");
        item.textContent = String(value);
        return item;
      }));
      byId("panelControls").hidden = false;
    },

    renderConnection(mode, model) {
      const remote = mode === "remote";
      const card = byId(remote ? "remoteConnection" : "lanConnection");
      const state = byId(remote ? "remoteState" : "lanState");
      const url = byId(remote ? "remoteUrl" : "lanUrl");
      const error = byId(remote ? "remoteError" : "lanError");
      const qr = byId(remote ? "remoteQr" : "lanQr");
      const copyButton = byId(remote ? "copyRemoteConnection" : "copyLanConnection");

      card.dataset.state = model.state;
      card.setAttribute("aria-busy", String(Boolean(model.busy)));
      state.textContent = model.status || "";
      url.textContent = model.displayUrl
        || (remote ? "等待公网地址" : "等待局域网地址");
      error.textContent = model.error || "";
      copyButton.disabled = !model.copyEnabled || Boolean(model.busy);
      if (remote) byId("retryRemoteConnection").disabled = Boolean(model.busy);

      if (model.qrDataUrl) {
        qr.src = model.qrDataUrl;
        qr.hidden = false;
      } else {
        qr.removeAttribute("src");
        qr.hidden = true;
      }
    },

    setLanVisible(visible) {
      byId("lanConnection").hidden = !visible;
      byId("showLanConnection").hidden = visible;
    },

    setConnectionOptionsOpen(open) {
      const options = byId("connectionOptions");
      if (options.open !== open) options.open = open;
    },

    setPanelStatus(message) {
      setPlainText("panelStatus", message);
    },

    setActionsVisible(visible) {
      byId("panelActions").hidden = !visible;
    },

    setAccessRevoked(revoked) {
      for (const id of [
        "retryRemoteConnection",
        "copyRemoteConnection",
        "showLanConnection",
        "copyLanConnection",
        "hideLanConnection",
        "refreshPanel",
        "stopService",
      ]) {
        byId(id).disabled = Boolean(revoked);
      }
      byId("connectionOptions").hidden = Boolean(revoked);
    },

    focus(target) {
      byId(target)?.focus();
    },

    async copyText(value) {
      if (!browser.navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await browser.navigator.clipboard.writeText(value);
    },

    announceConnection(mode, message) {
      setPlainText(mode === "remote" ? "remoteState" : "lanState", message);
    },

    setConnectionError(mode, message) {
      setPlainText(mode === "remote" ? "remoteError" : "lanError", message);
    },

    confirmStop() {
      return window.confirm("确定要安全停止 Codex Remote 服务吗？");
    },
  };
}

export function bindPanelLifecycle(controller, doc, browser) {
  let bound = true;
  const onVisibilityChange = () => {
    controller.setPageVisible(doc.visibilityState === "visible");
  };
  const onPageShow = (event) => {
    if (event.persisted) onVisibilityChange();
  };
  const unbind = () => {
    if (!bound) return;
    bound = false;
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    browser.removeEventListener("pagehide", onPageHide);
    browser.removeEventListener("pageshow", onPageShow);
  };
  const onPageHide = (event) => {
    if (event.persisted) {
      controller.setPageVisible(false);
      return;
    }
    controller.stop();
    unbind();
  };

  doc.addEventListener("visibilitychange", onVisibilityChange);
  browser.addEventListener("pagehide", onPageHide);
  browser.addEventListener("pageshow", onPageShow);
  onVisibilityChange();
  return unbind;
}

function createBrowserRequest(panelKey) {
  return async (path, options = {}) => {
    const response = await window.fetch(path, {
      cache: "no-store",
      ...options,
      headers: {
        "X-Codex-Panel-Key": panelKey,
        ...(options.headers || {}),
      },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = response.status === 401
        ? "本机面板权限无效，请从启动窗口重新打开。"
        : payload?.error
          ? `请求失败：${payload.error}`
          : `请求失败（${response.status}）`;
      const error = new Error(message);
      error.status = response.status;
      error.code = payload?.code;
      throw error;
    }
    return payload;
  };
}

function bootPanel() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const panelKey = params.get("panel") || "";
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

  const controller = createPanelController({
    request: createBrowserRequest(panelKey),
    view: createDomView(document, window),
    timers: window,
    now: () => Date.now(),
  });
  const byId = (id) => document.getElementById(id);

  byId("retryRemoteConnection").addEventListener("click", () => void controller.retryRemote());
  byId("copyRemoteConnection").addEventListener("click", () => void controller.copyRemote());
  byId("showLanConnection").addEventListener("click", () => void controller.showLan());
  byId("copyLanConnection").addEventListener("click", () => void controller.copyLan());
  byId("hideLanConnection").addEventListener("click", () => controller.hideLan());
  byId("refreshPanel").addEventListener("click", () => void controller.refresh());
  byId("stopService").addEventListener("click", () => void controller.stopService());
  byId("connectionOptions").addEventListener("toggle", (event) => {
    controller.setConnectionOptionsOpen(event.currentTarget.open);
  });
  bindPanelLifecycle(controller, document, window);
  controller.start();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  bootPanel();
}
