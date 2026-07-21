"use strict";

const params = new URLSearchParams(location.hash.slice(1));
const panelKey = params.get("panel") || "";
history.replaceState(null, "", `${location.pathname}${location.search}`);

const byId = (id) => document.getElementById(id);
let copyUrl = "";
let refreshTimer = null;
let expiryTimer = null;
const headers = () => ({ "X-Codex-Panel-Key": panelKey });
const text = (id, value) => {
  byId(id).textContent = value == null || value === "" ? "—" : String(value);
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  if (!response.ok) {
    throw new Error(response.status === 401
      ? "本机面板权限无效，请从启动窗口重新打开。"
      : `请求失败（${response.status}）`);
  }
  return response.json();
}

function renderState(state) {
  text("serviceStatus", state.serviceStatus);
  text("codexStatus", `${state.codexStatus} / App Server ${state.appServerStatus}`);
  text("workspace", state.workspace);
  text("lanOrigin", state.lanOrigin);
  text("tunnelOrigin", state.tunnelOrigin);
  text("toolStatus", Object.entries(state.tools || {})
    .map(([name, ready]) => `${name}: ${ready ? "可用" : "未发现"}`).join(" · "));
  const diagnostics = Array.isArray(state.diagnostics) ? state.diagnostics : [];
  const items = diagnostics.length ? diagnostics : ["暂无诊断信息"];
  byId("diagnostics").replaceChildren(...items.map((value) => {
    const item = document.createElement("li");
    item.textContent = value;
    return item;
  }));
  byId("panelControls").hidden = false;
  byId("panelActions").hidden = false;
  text("panelStatus", "面板在线，状态仅在本机显示。 ");
}

async function refresh() {
  if (!panelKey) {
    text("panelStatus", "缺少本机面板权限，请从 Codex Remote 启动窗口重新打开此页面。");
    byId("panelActions").hidden = true;
    return;
  }
  try {
    renderState(await request("/api/panel/state"));
  } catch (error) {
    text("panelStatus", error.message);
    byId("panelActions").hidden = true;
  }
}

function expireConnection() {
  copyUrl = "";
  byId("copyConnection").disabled = true;
  byId("connectionQr").removeAttribute("src");
  byId("connectionQr").hidden = true;
  text("connectionError", "连接信息已过期，请重新生成。");
}

async function generateConnection() {
  const result = await request("/api/panel/connection", { method: "POST" });
  copyUrl = result.copyUrl || "";
  text("connectionUrl", result.displayUrl);
  text("connectionError", result.qrError || "");
  byId("connectionPanel").hidden = false;
  byId("copyConnection").disabled = !copyUrl;
  const qr = byId("connectionQr");
  qr.hidden = !result.qrDataUrl;
  if (result.qrDataUrl) qr.src = result.qrDataUrl;
  else qr.removeAttribute("src");
  if (expiryTimer) clearTimeout(expiryTimer);
  const delay = Math.max(0, Number(result.expiresAt) - Date.now());
  expiryTimer = setTimeout(expireConnection, Math.min(delay || 300_000, 300_000));
}

byId("generateConnection").addEventListener("click", () => {
  void generateConnection().catch((error) => text("connectionError", error.message));
});
byId("copyConnection").addEventListener("click", () => {
  if (!copyUrl) return;
  void navigator.clipboard.writeText(copyUrl)
    .then(() => text("connectionError", "连接地址已复制。"), () => text("connectionError", "复制失败，请手动复制。"));
});
byId("refreshPanel").addEventListener("click", () => void refresh());
byId("stopService").addEventListener("click", () => {
  if (!window.confirm("确定要安全停止 Codex Remote 服务吗？")) return;
  void request("/api/panel/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "STOP" }),
  }).then(
    () => text("panelStatus", "服务正在安全停止…"),
    (error) => text("panelStatus", error.message),
  );
});

function updateRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = document.visibilityState === "visible"
    ? setInterval(() => void refresh(), 5_000)
    : null;
}
document.addEventListener("visibilitychange", updateRefreshTimer);
void refresh();
updateRefreshTimer();
