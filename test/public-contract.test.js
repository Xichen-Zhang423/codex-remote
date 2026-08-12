import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RPC_DEPENDENT_MESSAGE_TYPES } from "../src/remote-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, "public", name), "utf8");

test("PWA is Codex-branded and exposes the accessible core controls", () => {
  const html = read("index.html");
  assert.match(html, /Codex Remote/);
  for (const id of [
    "messages", "input", "sendBtn", "stopBtn", "historyBtn", "screenBtn",
    "approvalSheet", "settingsDrawer", "screenViewer", "imageInput",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /aria-live=["']polite["']/);
  assert.match(html, /rel=["']manifest["']/);
  assert.match(html, /http-equiv=["']Content-Security-Policy["']/i);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
});

test("CSS includes touch, narrow-screen, overflow, and reduced-motion safeguards", () => {
  const css = read("styles.css");
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /@media\s*\(min-width:\s*900px\)/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /\.artifact-drawer,\s*\.settings-drawer,\s*\.history-drawer\s*\{[^}]*max-width:\s*min\(100vw,\s*460px\)/s);
  assert.match(css, /@media\s*\(max-height:\s*430px\)\s*and\s*\(orientation:\s*landscape\)/);
  assert.match(css, /@media\s*\(min-width:\s*1200px\)/);
  assert.match(css, /\.switch\s*\{[^}]*min-height:\s*44px/s);
});

test("status and error regions announce stable UI state", () => {
  const html = read("index.html");
  const panel = read("panel.html");
  assert.match(html, /id=["']historyDrawer["'][^>]*class=["'][^"']*history-drawer/);
  assert.match(html, /id=["']settingsDrawer["'][^>]*class=["'][^"']*settings-drawer/);
  assert.match(html, /id=["']connectionText["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  assert.match(html, /id=["']artifactStatus["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  assert.match(panel, /id=["']panelStatus["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  assert.match(panel, /id=["']remoteState["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  assert.match(panel, /id=["']remoteError["'][^>]*role=["']alert["']/);
  assert.match(panel, /id=["']lanState["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  assert.match(panel, /id=["']lanError["'][^>]*role=["']alert["']/);
  assert.doesNotMatch(panel, /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+frame-ancestors/i);
});

test("frontend handles the stable phone protocol and avoids untrusted innerHTML", () => {
  const app = read("app.js");
  for (const type of [
    "assistant_delta", "thinking_delta", "plan", "tool_use", "tool_delta",
    "tool_result", "file_change", "activity", "permission_request",
    "permission_closed", "history", "conversations", "result", "notice",
    "models", "directory", "screenshot", "tunnel",
  ]) {
    assert.match(app, new RegExp(`["']${type}["']`));
  }
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /new WebSocket/);
  assert.match(app, /history\.replaceState/);
  assert.match(app, /function validTunnelOrigin/);
  assert.match(app, /\.trycloudflare\.com/);
  assert.match(app, /const origin = validTunnelOrigin\(payload\?\.url\)/);
  assert.match(app, /if \(event\.code === 4001\)[\s\S]{0,180}else scheduleReconnect\(\)/);
  assert.match(app, /socketOpenTimer/);
  assert.match(app, /visibilityState === "visible"\) void connect\(true\)/);
  assert.match(app, /dataset\.otherAnswer/);
  assert.match(app, /appServerStatus/);
  assert.match(app, /Codex 正在恢复/);
  assert.match(app, /function activateModal/);
  assert.match(app, /\.inert =/);
  assert.match(app, /if \(globalThis\.Capacitor\) return/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
});

test("frontend treats Codex readiness separately from the phone WebSocket", () => {
  const app = read("app.js");
  assert.doesNotMatch(app, /appServerStatus:\s*["']online["']/);
  assert.match(
    app,
    /function\s+isCodexReady\(\)\s*\{[\s\S]{0,180}state\.connected\s*&&\s*state\.appServerStatus\s*===\s*["']online["']/,
  );

  const socketOpen = app.match(/socket\.addEventListener\(["']open["'][\s\S]*?socket\.addEventListener\(["']message["']/)?.[0] || "";
  assert.match(socketOpen, /setConnection\(["']connecting["']/);
  assert.doesNotMatch(socketOpen, /setConnection\(["']online["']/);

  const syncSystem = app.match(/function\s+syncSystem\(message\)[\s\S]*?\r?\n\s*}\r?\n\r?\n\s*function\s+clearReconnectTimer/)?.[0] || "";
  assert.match(syncSystem, /appServerStatus\s*===\s*["']restarting["'][\s\S]{0,180}setBusy\(false\)/);
  assert.match(syncSystem, /appServerStatus\s*===\s*["']offline["'][\s\S]{0,180}setBusy\(false\)/);
  assert.match(syncSystem, /appServerStatus\s*===\s*["']online["'][\s\S]{0,180}setConnection\(["']online["']/);

  const submitPrompt = app.match(/function\s+submitPrompt\(forcedText\)[\s\S]*?\r?\n\s*}\r?\n\r?\n\s*function\s+sameImages/)?.[0] || "";
  assert.match(submitPrompt, /if\s*\(!isCodexReady\(\)\)[\s\S]{0,260}return/);
  assert.ok(
    submitPrompt.indexOf("if (!isCodexReady())") < submitPrompt.indexOf("const requestId"),
    "readiness must be checked before an optimistic prompt can clear the draft",
  );
});

test("frontend disables Codex RPC controls without blocking PC-local tools", () => {
  const app = read("app.js");
  const readyTypes = app.match(/const\s+CODEX_RPC_MESSAGE_TYPES\s*=\s*new Set\(\[[\s\S]*?\]\);/)?.[0] || "";
  for (const type of [
    "prompt", "interrupt", "permission", "newConversation", "listConversations",
    "loadConversation", "renameConversation", "archiveConversation", "refreshHistory", "listModels",
  ]) assert.match(readyTypes, new RegExp(`["']${type}["']`));
  for (const type of [
    "screenshot", "control", "listDir", "listRoots", "mkdir",
    "setModel", "setEffort", "setSessionAuto", "listArtifacts", "createArtifactTicket",
  ]) assert.doesNotMatch(readyTypes, new RegExp(`["']${type}["']`));
  const frontendTypes = [...readyTypes.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(frontendTypes, [...RPC_DEPENDENT_MESSAGE_TYPES]);

  const controls = app.match(/function\s+syncCodexControls\(\)[\s\S]*?\r?\n\s*}\r?\n\r?\n/)?.[0] || "";
  assert.match(controls, /el\.sendBtn\.disabled\s*=\s*!ready\s*\|\|\s*Boolean\(state\.pendingPrompt\)/);
  assert.match(controls, /el\.newConversationBtn\.disabled\s*=\s*!acceptsConversationAction/);
  assert.match(controls, /el\.useDirectoryBtn\.disabled\s*=\s*!acceptsConversationAction\s*\|\|\s*!state\.directoryPath/);
  assert.match(controls, /el\.conversationList\.querySelectorAll\(["']\[data-codex-action\]["']\)/);
  assert.match(controls, /el\.approvalActions\.querySelectorAll\(["']button["']\)/);

  assert.match(app, /if\s*\(!sendCodexWire\(\{\s*type:\s*["']newConversation["'][\s\S]{0,180}\}\)\)\s*return;[\s\S]{0,100}clearTimeline\(\)/);
  assert.match(app, /if\s*\(!sendCodexWire\(\{\s*type:\s*["']loadConversation["'][\s\S]{0,120}\}\)\)\s*return;[\s\S]{0,100}clearTimeline\(\)/);
  assert.match(app, /if\s*\(!sendCodexWire\(\{\s*type:\s*["']permission["']/);

  const screenshot = app.match(/function\s+requestScreenshot\(\)[\s\S]*?\r?\n\s*}\r?\n/)?.[0] || "";
  assert.doesNotMatch(screenshot, /isCodexReady|sendCodexWire/);
  assert.match(screenshot, /sendWire\(\{\s*type:\s*["']screenshot["']/);
  assert.match(app, /sendWire\(\{\s*type:\s*["']setModel["']/);
  assert.match(app, /sendWire\(\{\s*type:\s*["']setEffort["']/);
  assert.match(app, /sendWire\(\{\s*type:\s*["']setSessionAuto["']/);
});

test("frontend commits prompts only after the matching server acknowledgement", () => {
  const app = read("app.js");
  const stateBlock = app.match(/const\s+state\s*=\s*\{[\s\S]*?\r?\n\s*\};/)?.[0] || "";
  assert.match(stateBlock, /pendingPrompt:\s*null/);

  const submitPrompt = app.match(/function\s+submitPrompt\(forcedText\)[\s\S]*?\r?\n\s*}\r?\n\r?\n\s*function\s+sameImages/)?.[0] || "";
  assert.match(submitPrompt, /if\s*\(state\.pendingPrompt\)/);
  assert.match(submitPrompt, /state\.pendingPrompt\s*=\s*pending/);
  assert.match(submitPrompt, /const\s+images\s*=\s*forced\s*\?\s*\[\]\s*:\s*\[\.\.\.state\.images\]/);
  assert.doesNotMatch(submitPrompt, /renderOptimisticUser\(/);
  assert.doesNotMatch(submitPrompt, /clearImages\(\)/);
  assert.doesNotMatch(submitPrompt, /el\.input\.value\s*=\s*["']/);

  const acknowledge = app.match(/function\s+acknowledgePrompt\(message\)[\s\S]*?\r?\n\s*}\r?\n\r?\n\s*function\s+autoResizeInput/)?.[0] || "";
  assert.match(acknowledge, /message\.requestId\s*!==\s*pending\.requestId/);
  assert.match(acknowledge, /renderOptimisticUser\(pending\.text,\s*pending\.images\)/);
  assert.match(acknowledge, /const\s+composerUnchanged\s*=\s*el\.input\.value\s*===\s*pending\.composerText\s*&&\s*sameImages\(state\.images,\s*pending\.composerImages\)/);
  assert.match(acknowledge, /if\s*\(!pending\.forced\s*&&\s*composerUnchanged\)\s*\{[\s\S]{0,180}el\.input\.value\s*=\s*["']["'][\s\S]{0,120}clearImages\(\)/);
  assert.match(acknowledge, /state\.pendingPrompt\s*=\s*null/);

  const receive = app.match(/function\s+receive\(message\)[\s\S]*?\r?\n\s*}\r?\n\r?\n\s*function\s+handleTunnel/)?.[0] || "";
  assert.match(receive, /case\s+["']prompt_queued["']:[\s\S]{0,160}if\s*\(acknowledgePrompt\(message\)\)\s*\{[\s\S]{0,120}updateQueue\(message\.queueLength\)[\s\S]{0,80}setBusy\(true\)/);
  assert.match(receive, /case\s+["']error["']:[\s\S]{0,400}message\.code\s*===\s*["']APP_SERVER_UNAVAILABLE["'][\s\S]{0,120}cancelPendingPrompt\(/);
});

test("frontend preserves pending prompt drafts across disconnect paths", () => {
  const app = read("app.js");
  const cancelPending = app.match(/function\s+cancelPendingPrompt\([^)]*\)[\s\S]*?\r?\n\s*}\r?\n/)?.[0] || "";
  assert.match(cancelPending, /state\.pendingPrompt\s*=\s*null/);
  assert.match(cancelPending, /setBusy\(false\)/);
  assert.doesNotMatch(cancelPending, /clearImages\(|el\.input\.value\s*=/);

  const socketError = app.match(/socket\.addEventListener\(["']error["'][\s\S]*?\r?\n\s*}\);/)?.[0] || "";
  assert.match(socketError, /state\.connected\s*=\s*false/);
  assert.match(socketError, /state\.appServerStatus\s*=\s*["']offline["']/);
  assert.match(socketError, /cancelPendingPrompt\(/);
  assert.match(socketError, /syncCodexControls\(\)/);

  const offline = app.match(/window\.addEventListener\(["']offline["'][\s\S]*?\r?\n\s*}\);/)?.[0] || "";
  assert.match(offline, /state\.connected\s*=\s*false/);
  assert.match(offline, /state\.appServerStatus\s*=\s*["']offline["']/);
  assert.match(offline, /cancelPendingPrompt\(/);
  assert.match(offline, /syncCodexControls\(\)/);
});

test("workspace picker can leave the current folder and switch filesystem roots", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.match(html, /id=["']directoryRootsBtn["']/);
  assert.match(app, /type:\s*["']listRoots["']/);
  assert.match(app, /case\s+["']directory_roots["']/);
  assert.doesNotMatch(app, /state\.directoryPath\s*===\s*state\.directoryRoot/);
});

test("manifest and service worker provide a standalone offline shell", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.name, "Codex Remote");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, ".");
  assert.deepEqual(manifest.icons, [
    { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ]);

  const sw = read("sw.js");
  assert.match(sw, /codex-remote-v1/);
  assert.match(sw, /if \(!response\.ok\)[\s\S]{0,160}caches\.match\("index\.html"\)/);
  for (const asset of ["index.html", "styles.css", "app.js", "icon.svg", "manifest.webmanifest", "jsqr.min.js"])
    assert.match(sw, new RegExp(asset.replace(".", "\\.")));
});

test("artifact center exposes accessible drawer and preview controls", () => {
  const html = read("index.html");
  for (const id of [
    "artifactsBtn", "artifactBadge", "artifactsDrawer", "artifactRefreshBtn", "artifactStatus",
    "artifactList", "artifactPreview", "artifactPreviewCloseBtn", "artifactPreviewBody", "artifactPrevPageBtn",
    "artifactNextPageBtn", "artifactFitBtn", "artifactDownloadBtn",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /id=["']artifactPreview["'][^>]*role=["']dialog["'][^>]*aria-modal=["']true["']/);
  assert.match(html, /id=["']artifactStatus["'][^>]*aria-live=["']polite["']/);
  assert.match(html, /artifact-ui\.js[\s\S]*app\.js/);
});

test("artifact messages stay isolated from transcript routing", () => {
  const app = read("app.js");
  const artifacts = read("artifact-ui.js");
  assert.match(app, /artifactUI\.handleMessage\(message\)/);
  assert.match(app, /artifactUI\.onThreadChanged\(state\.threadId\)/);
  assert.match(app, /artifactUI\.onHistoryRendered\(\)/);
  assert.doesNotMatch(artifacts, /\.innerHTML\s*=|<iframe|<object|\beval\s*\(/i);
  for (const type of ["artifact_snapshot", "artifact_update", "artifact_access", "artifact_error"])
    assert.match(artifacts, new RegExp(type));
});

test("artifact preview stays same-origin and tears down owned resources", () => {
  const html = read("index.html");
  const artifacts = read("artifact-ui.js");
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(artifacts, /const base = backendOrigin\(\)/);
  assert.match(artifacts, /new URL\(message\.url, base\)/);
  assert.match(artifacts, /if \(url\.origin !== base\.origin\) throw/);
  for (const token of [
    "textContent", "AbortController", "URL.revokeObjectURL", "renderTask?.cancel", "pdfDoc.destroy",
    "isEvalSupported: false", "credentials: \"omit\"", "cache: \"no-store\"", "Range: \"bytes=0-2097151\"",
  ]) assert.ok(artifacts.includes(token), token);
  assert.doesNotMatch(artifacts, /https?:\/\/|Authorization|credentials:\s*["']include/);
});

test("artifact UI enforces persisted preview policy and cancels stale work", () => {
  const artifacts = read("artifact-ui.js");
  assert.match(artifacts, /record\.mime === "application\/pdf"/);
  assert.match(artifacts, /record\.mime\.startsWith\("text\/plain;"\)/);
  assert.match(artifacts, /25 \* 1024 \* 1024/);
  assert.match(artifacts, /2 \* 1024 \* 1024/);
  assert.match(artifacts, /100 \* 1024 \* 1024/);
  assert.match(artifacts, /previewEpoch !== state\.epoch/);
  assert.match(artifacts, /state\.tickets\.clear\(\)/);
  assert.match(artifacts, /canvas\.width = 0/);
});

test("artifact change labels and drawer groups preserve provenance", () => {
  const artifacts = read("artifact-ui.js");
  for (const [kind, label] of [["created", "新文件"], ["modified", "已修改"], ["replaced", "已替换"]]) {
    assert.match(artifacts, new RegExp(`${kind}: ["']${label}["']`));
  }
  assert.match(artifacts, /return labels\[kind\] \|\| ["']变更["']/);
  assert.match(artifacts, /currentTurnId: null/);
  assert.match(artifacts, /state\.currentTurnId = null/);
  assert.match(artifacts, /message\.type === ["']artifact_update["'][\s\S]{0,500}message\.turnId[\s\S]{0,250}state\.currentTurnId/);
  assert.match(artifacts, /const currentRecords = state\.currentTurnId[\s\S]{0,160}record\.turnId === state\.currentTurnId/);
  assert.doesNotMatch(artifacts, /const latestTurnId = typeof records\[0\]\?\.turnId/);
  assert.match(artifacts, /renderGroup\(["']本轮["']/);
  assert.match(artifacts, /renderGroup\(["']较早产出["']/);
  assert.match(artifacts, /document\.createElement\(["']section["']\)/);
});

test("artifact timeline summaries are bounded, informative, and link to the full drawer", () => {
  const app = read("app.js");
  assert.match(app, /const visibleRecords = sortedRecords\.slice\(0, 4\)/);
  assert.match(app, /record\.displayName \|\| record\.relativePath/);
  assert.match(app, /record\.relativePath \|\| ["']工作区产出["']/);
  assert.match(app, /CodexArtifactUI\.typeLabel\(record\)/);
  assert.match(app, /CodexArtifactUI\.formatBytes\(record\.size\)/);
  assert.match(app, /CodexArtifactUI\.changeLabel\(record\.kind\)/);
  assert.match(app, /["']查看全部["']/);
  assert.match(app, /artifactUI\.showAll\(\)/);
});

test("artifact tickets time out and clear every owned timer", () => {
  const artifacts = read("artifact-ui.js");
  assert.match(artifacts, /const TICKET_TIMEOUT_MS = 15_000/);
  assert.match(artifacts, /pending\.timer = setTimeout/);
  assert.match(artifacts, /state\.tickets\.get\(id\) !== pending/);
  assert.match(artifacts, /clearTimeout\(pending\.timer\)/);
  assert.match(artifacts, /产出授权等待超时/);
  assert.match(artifacts, /if \(!sendWire[\s\S]{0,500}clearTimeout\(pending\.timer\)/);
});

test("PDF preview generations own loading, rendering, and bounded canvases", () => {
  const artifacts = read("artifact-ui.js");
  assert.match(artifacts, /pdfLoadingTask: null/);
  assert.match(artifacts, /pdfRenderRun: 0/);
  assert.match(artifacts, /const renderRun = \+\+state\.pdfRenderRun/);
  assert.match(artifacts, /renderRun !== state\.pdfRenderRun/);
  assert.match(artifacts, /state\.pdfRenderRun \+= 1/);
  assert.match(artifacts, /state\.pdfLoadingTask === loadingTask/);
  assert.match(artifacts, /loadingTask\.destroy\(\)/);
  assert.match(artifacts, /const PDF_MAX_DIMENSION = 8_192/);
  assert.match(artifacts, /const PDF_MAX_PIXELS = 16 \* 1024 \* 1024/);
  assert.match(artifacts, /Number\.isFinite\(baseViewport\.width\)/);
  assert.match(artifacts, /width \* height > PDF_MAX_PIXELS/);
  assert.match(artifacts, /PDF 页面尺寸超出安全预览范围/);
});

test("desktop panel CSS makes public access primary and LAN progressive without narrow overflow", () => {
  const css = read("styles.css");
  assert.doesNotMatch(css, /var\(--bg\)/);
  assert.match(css, /\.remote-connection\s*\{/);
  assert.match(css, /\.lan-connection\s*\{/);
  assert.match(css, /\.qr-stage[^}]*background:\s*(?:#fff|white)/s);
  assert.match(css, /\.qr-stage[^}]*aspect-ratio:\s*1/s);
  assert.match(css, /#copyRemoteConnection[^}]*min-height:\s*44px/s);
  assert.match(css, /\.lan-connection:focus\s*,\s*\.lan-connection:focus-visible/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*no-preference\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test("desktop panel requires an in-memory fragment capability", () => {
  const html = read("panel.html");
  const client = read("panel.js");
  for (const id of [
    "panelStatus", "serviceStatus", "codexStatus", "workspace", "tunnelOrigin", "toolStatus", "diagnostics",
    "remoteConnection", "remoteState", "remoteUrl", "remoteQr", "copyRemoteConnection", "retryRemoteConnection",
    "connectionOptions", "connectionOptionsSummary", "showLanConnection", "lanConnection", "lanState", "lanUrl", "lanQr",
    "copyLanConnection", "hideLanConnection", "refreshPanel", "stopService",
  ])
    assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /<script[^>]*type=["']module["'][^>]*src=["']panel\.js["']/i);
  assert.match(html, /id=["']remoteConnection["'][^>]*aria-labelledby=["']remoteConnectionTitle["'][^>]*aria-busy=["']true["']/);
  assert.doesNotMatch(html, /id=["']remoteConnection["'][^>]*\shidden(?:\s|>)/);
  assert.match(html, /id=["']remoteConnectionTitle["'][^>]*>\s*公网远程连接\s*</);
  assert.match(html, /id=["']remoteState["'][^>]*>\s*正在建立安全公网隧道…\s*</);
  assert.match(html, /<details[^>]*id=["']connectionOptions["']/);
  assert.match(html, /<section[^>]*id=["']lanConnection["'][^>]*\shidden(?:\s|>)/);
  assert.match(html, /id=["']remoteQr["'][^>]*alt=["'][^"']*公网[^"']*二维码[^"']*["']/);
  assert.match(html, /id=["']lanQr["'][^>]*alt=["'][^"']*局域网[^"']*二维码[^"']*["']/);
  assert.doesNotMatch(html, /id=["']lanOrigin["']|id=["']generateConnection["']|id=["']connectionPanel["']/);
  assert.match(client, /location\.hash/);
  assert.match(client, /history\.replaceState/);
  assert.match(client, /X-Codex-Panel-Key/);
  assert.match(client, /export function createPanelController/);
  assert.match(client, /JSON\.stringify\(\{ mode \}\)/);
  assert.match(client, /textContent/);
  assert.match(client, /window\.confirm/);
  assert.doesNotMatch(client, /innerHTML|localStorage|sessionStorage/);
  assert.doesNotMatch(html + client, /<iframe|https:\/\/[^"']+(?:\.js|\.css)|\?token=[^"']+/i);
  assert.doesNotMatch(client, /generateConnection/);
  assert.doesNotMatch(html + client, /鎵嬫満宸ヤ綔鍙|鏈満涓户|涓户鎺у埗/);
});
