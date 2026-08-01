import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  assert.match(html, /id=["']artifactStatus["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  assert.match(panel, /id=["']panelStatus["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  assert.match(panel, /id=["']connectionError["'][^>]*role=["']alert["']/);
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

test("desktop panel requires an in-memory fragment capability", () => {
  const html = read("panel.html");
  const client = read("panel.js");
  for (const id of ["panelStatus", "serviceStatus", "codexStatus", "workspace", "lanOrigin", "tunnelOrigin", "toolStatus", "diagnostics", "connectionPanel", "generateConnection", "copyConnection", "refreshPanel", "stopService"])
    assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(client, /location\.hash/);
  assert.match(client, /history\.replaceState/);
  assert.match(client, /X-Codex-Panel-Key/);
  assert.match(client, /textContent/);
  assert.match(client, /window\.confirm/);
  assert.doesNotMatch(client, /innerHTML|localStorage|sessionStorage/);
  assert.doesNotMatch(html + client, /<iframe|https:\/\/[^"']+(?:\.js|\.css)|\?token=[^"']+/i);
  assert.doesNotMatch(client, /fetch\(["']\/api\/panel\/connection["']\)[\s\S]*DOMContentLoaded/);
  assert.doesNotMatch(html + client, /鎵嬫満宸ヤ綔鍙|鏈満涓户|涓户鎺у埗/);
});
