import json
import os
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
OUTPUT = Path(os.environ.get("CODEX_VISUAL_DIR", ROOT / "test-artifacts"))
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")

VIEWPORTS = [
    (320, 568),
    (360, 800),
    (390, 844),
    (430, 932),
    (844, 390),
    (1280, 800),
    (1440, 900),
]

MOCK_SOCKET = r"""
(() => {
  window.__pendingApprovals = [];
  window.__artifactRecords = [
    { id: "ready", revision: 1, threadId: "thread-1", turnId: "turn-1", relativePath: "reports/final.txt",
      displayName: "final.txt", kind: "created", provenance: ["snapshot"], mime: "text/plain; charset=utf-8",
      size: 128, sha256: "a".repeat(64), state: "ready", detectedAt: new Date().toISOString() },
    { id: "long", revision: 2, threadId: "thread-1", turnId: "turn-1", relativePath: "output/very/long/path/result.pdf",
      displayName: "这是一个用于验证两行截断并且不能覆盖操作按钮的非常非常长的最终报告文件名.pdf", kind: "modified",
      provenance: ["snapshot", "watch"], mime: "application/pdf", size: 4096, sha256: "b".repeat(64), state: "ready", detectedAt: new Date().toISOString() },
    { id: "large", revision: 3, threadId: "thread-1", turnId: "turn-1", relativePath: "output/large.png",
      displayName: "large.png", kind: "created", provenance: ["snapshot"], mime: "image/png", size: 30 * 1024 * 1024,
      sha256: "c".repeat(64), state: "too_large", detectedAt: new Date().toISOString() },
    { id: "evicted", revision: 4, threadId: "thread-1", turnId: "turn-0", relativePath: "old/archive.zip",
      displayName: "archive.zip", kind: "created", provenance: ["snapshot"], mime: "application/octet-stream", size: 1024,
      sha256: "d".repeat(64), state: "evicted", detectedAt: new Date().toISOString() },
  ];
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.listeners = new Map();
      window.__mockSocket = this;
      setTimeout(() => {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open", {});
        this.message({ type: "hello", version: 1, capabilities: ["codex", "threads", "images", "approvals", "screen", "control", "artifacts"] });
        this.message({ type: "system_init", cwd: "D:\\work\\codex-remote", model: "gpt-5.4", effort: "high", threadId: "thread-1", queueLength: 0, sessionAuto: false });
        this.message({ type: "history", events: [
          { type: "user_echo", text: "检查当前实现并给出可执行结论。" },
          { type: "thinking", text: "我会先核对协议边界，再检查界面与测试。" },
          { type: "plan", plan: [{ step: "检查协议", status: "completed" }, { step: "验证界面", status: "in_progress" }, { step: "交付结果", status: "pending" }] },
          { type: "tool_use", id: "tool-1", name: "command", input: { command: "npm test", cwd: "D:\\work\\codex-remote" } },
          { type: "tool_result", toolUseId: "tool-1", content: "150 tests passed", isError: false, meta: { exitCode: 0 } },
          { type: "diff", diff: "--- a/src/app.js\n+++ b/src/app.js\n@@\n- old\n+ verified" },
          { type: "assistant", text: "## 检查完成\n\n核心链路已经连通，测试全部通过。下一步只需完成真实设备验证。" },
          { type: "result", status: "completed", durationMs: 1840 }
        ] });
        this.message({ type: "conversations", conversations: [
          { id: "thread-1", name: "Codex Remote 发布检查", updatedAt: Date.now() },
          { id: "thread-2", name: "Windows 截图与控制", updatedAt: Date.now() - 60000 }
        ] });
        this.message({ type: "models", models: [{ id: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningEfforts: ["low", "medium", "high"] }] });
        this.message({ type: "artifact_update", threadId: "thread-1", turnId: "turn-1", revision: 4,
          records: window.__artifactRecords, complete: true, diagnostics: [] });
        for (const approval of window.__pendingApprovals) this.message(approval);
      }, 40);
    }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    emit(type, event) {
      for (const callback of this.listeners.get(type) || []) callback(event);
    }
    message(payload) { this.emit("message", { data: JSON.stringify(payload) }); }
    send(raw) {
      const message = JSON.parse(raw);
      window.__lastWire = message;
      if (message.type === "listArtifacts") {
        this.message({ type: "artifact_snapshot", requestId: message.requestId, threadId: message.threadId,
          revision: 4, complete: window.__artifactComplete !== false,
          diagnostics: window.__artifactComplete === false ? [{ code: "timeout", message: "部分目录未完成扫描" }] : [],
          records: message.threadId === "thread-1" ? (window.__artifactRecords ?? []) : [] });
        return;
      }
      if (message.type === "createArtifactTicket") {
        this.message({ type: "artifact_access", requestId: message.requestId, artifactId: message.artifactId,
          purpose: message.purpose, expiresAt: Date.now() + 60_000,
          url: `/visual-artifacts/${encodeURIComponent(message.artifactId)}?ticket=visual-ticket` });
        return;
      }
      if (message.type === "permission") {
        window.__pendingApprovals = window.__pendingApprovals.filter((item) => item.id !== message.id);
        setTimeout(() => this.message({ type: "permission_closed", id: message.id }), 20);
      } else if (message.type === "listConversations") {
        setTimeout(() => this.message({ type: "conversations", conversations: [
          { id: "thread-1", name: "Codex Remote 发布检查", updatedAt: Date.now() },
          { id: "thread-2", name: "Windows 截图与控制", updatedAt: Date.now() - 60000 }
        ] }), 20);
      } else if (message.type === "listModels") {
        setTimeout(() => this.message({ type: "models", models: [{ id: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningEfforts: ["low", "medium", "high"] }] }), 20);
      } else if (message.type === "listDir") {
        setTimeout(() => this.message({ type: "directory", path: message.path, entries: [
          { name: "src", path: `${message.path}\\src`, isDirectory: true, isFile: false },
          { name: "package.json", path: `${message.path}\\package.json`, isDirectory: false, isFile: true }
        ] }), 20);
      }
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", { code: 1000 });
    }
  }
  window.WebSocket = MockWebSocket;
  window.__mockEmit = (payload) => {
    if (payload?.type === "permission_request") {
      window.__pendingApprovals = window.__pendingApprovals.filter((item) => item.id !== payload.id);
      window.__pendingApprovals.push(payload);
    } else if (payload?.type === "permission_closed") {
      window.__pendingApprovals = window.__pendingApprovals.filter((item) => item.id !== payload.id);
    }
    window.__mockSocket?.message(payload);
  };
})();
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return


def metrics(page):
    return page.evaluate(
        """() => {
          const visible = (node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return !node.matches('.sr-only') && style.display !== 'none' && style.visibility !== 'hidden'
              && !node.hidden && rect.width > 0 && rect.height > 0;
          };
          const smallTargets = [...document.querySelectorAll('button, a[href], input:not([type="checkbox"]):not([type="radio"]), select, textarea, summary, [role="button"], label[for], .switch')]
            .filter(visible)
            .map((node) => {
              const rect = node.getBoundingClientRect();
              return { id: node.id || node.className || node.textContent.trim().slice(0, 24), width: rect.width, height: rect.height };
            })
            .filter((item) => item.width < 44 || item.height < 44);
          const composer = document.querySelector('#composer').getBoundingClientRect();
          return {
            viewport: { width: innerWidth, height: innerHeight },
            scrollWidth: document.documentElement.scrollWidth,
            overflowX: document.documentElement.scrollWidth - innerWidth,
            composer: { top: composer.top, bottom: composer.bottom, height: composer.height },
            smallTargets,
            messagesVisible: visible(document.querySelector('#messages')),
          };
        }"""
    )


def visual_pdf_bytes():
    stream = b"BT /F1 18 Tf 36 400 Td (Codex Remote artifact preview) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{number} 0 obj\n".encode("ascii"))
        pdf.extend(body)
        pdf.extend(b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    return bytes(pdf)


VISUAL_PDF = visual_pdf_bytes()


def fulfill_visual_artifact(route):
    url = route.request.url
    if "/visual-artifacts/long" in url:
        route.fulfill(status=200, content_type="application/pdf", body=VISUAL_PDF)
    elif "/visual-artifacts/ready" in url:
        route.fulfill(
            status=200,
            content_type="text/plain; charset=utf-8",
            body="Codex Remote visual artifact\n",
        )
    else:
        route.fulfill(status=404, content_type="text/plain", body="not found")


def settle(page):
    page.evaluate(
        "() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    )


def wait_for_condition(page, expression, timeout_ms=5000):
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        if page.evaluate(expression):
            return
        page.wait_for_timeout(25)
    raise AssertionError(f"browser condition timed out: {expression}")


def assert_visible_artifact_layout(page, selector, label):
    current = page.evaluate(
        """([selector, label]) => {
          const root = document.querySelector(selector);
          if (!root) return { label, missing: true };
          const visible = (node) => { const style = getComputedStyle(node); const box = node.getBoundingClientRect();
            return !node.hidden && style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0; };
          const targets = [root, ...root.querySelectorAll('button,a[href],[role="button"],input,select,textarea')]
            .filter((node) => visible(node) && node.matches('button,a[href],[role="button"],input,select,textarea'))
            .map((node) => { const box = node.getBoundingClientRect();
              return { name: node.id || node.textContent.trim().slice(0, 32), width: box.width, height: box.height }; })
            .filter((item) => item.width < 44 || item.height < 44);
          return {
            label, hidden: !visible(root),
            componentOverflow: root.scrollWidth - root.clientWidth,
            viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            smallTargets: targets,
          };
        }""",
        [selector, label],
    )
    if (current.get("missing") or current.get("hidden") or current["componentOverflow"] > 1
            or current["viewportOverflow"] > 1 or current["smallTargets"]):
        raise AssertionError(f"visible artifact layout failed: {current}")


def artifact_groups(page):
    return page.evaluate(
        """() => Object.fromEntries([...document.querySelectorAll('.artifact-group')].map((group) => [
          group.querySelector('h3 > span')?.textContent.trim(),
          [...group.querySelectorAll('.artifact-row strong')].map((node) => node.textContent.trim()),
        ]))"""
    )


def assert_artifact_groups(page):
    groups = artifact_groups(page)
    expected_current = {
        "final.txt",
        "large.png",
        "这是一个用于验证两行截断并且不能覆盖操作按钮的非常非常长的最终报告文件名.pdf",
    }
    if set(groups.get("本轮", [])) != expected_current or groups.get("较早产出") != ["archive.zip"]:
        raise AssertionError(f"artifact turn grouping is incorrect: {groups}")


def assert_artifact_turn_cleared(page):
    groups = artifact_groups(page)
    expected = {
        "archive.zip",
        "final.txt",
        "large.png",
        "这是一个用于验证两行截断并且不能覆盖操作按钮的非常非常长的最终报告文件名.pdf",
    }
    if "本轮" in groups or set(groups.get("较早产出", [])) != expected:
        raise AssertionError(f"artifact turn identity survived a thread switch: {groups}")


def open_artifact_page(browser, base, width, height):
    context = browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=1,
        reduced_motion="reduce",
        locale="zh-CN",
        service_workers="block",
    )
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.on(
        "console",
        lambda message: errors.append(f"console {message.type}: {message.text}")
        if message.type == "error"
        else None,
    )
    page.route("**/visual-artifacts/**", fulfill_visual_artifact)
    page.add_init_script(MOCK_SOCKET)
    page.goto(base, wait_until="networkidle")
    page.wait_for_selector("#artifactsBtn:not([hidden])")
    wait_for_condition(
        page,
        "() => document.querySelectorAll('.artifact-row').length === 4 && document.querySelectorAll('.artifact-summary').length > 0",
    )
    page.locator("#toastRegion").evaluate("node => node.replaceChildren()")
    assert_artifact_groups(page)
    return context, page, errors


def verify_artifact_viewports(browser, base):
    for width, height in VIEWPORTS:
        context, page, errors = open_artifact_page(browser, base, width, height)
        try:
            page.locator("#artifactsBtn").click()
            current = page.evaluate(
                """() => ({
                  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                  smallTargets: [...document.querySelectorAll('#artifactsDrawer button,#artifactPreview button,.artifact-timeline button,.artifact-summary button,.artifact-summary a')]
                    .filter((node) => { const box = node.getBoundingClientRect();
                      return box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44); }).length
                })"""
            )
            if current["overflow"] > 1 or current["smallTargets"] or errors:
                raise AssertionError(
                    f"artifact layout failed at {width}x{height}: {current}, errors={errors}"
                )
        finally:
            context.close()


def verify_artifact_interactions(browser, base):
    context, page, errors = open_artifact_page(browser, base, 390, 844)
    try:
        page.locator("#artifactsBtn").click()
        page.locator(".artifact-row.state-ready").filter(has_text="final.txt").click()
        page.wait_for_selector("#artifactPreviewBody pre")
        assert_visible_artifact_layout(page, "#artifactPreview", "text preview 390x844")
        modal = page.evaluate(
            """() => ({
              appInert: document.querySelector('#app').inert,
              focusInside: document.querySelector('#artifactPreview').contains(document.activeElement)
            })"""
        )
        if not modal["appInert"] or not modal["focusInside"]:
            raise AssertionError(f"artifact modal isolation failed: {modal}")
        page.keyboard.press("Escape")
        page.wait_for_selector("#artifactPreview", state="hidden")
        wait_for_condition(
            page,
            "() => !document.querySelector('#app').inert && document.activeElement?.classList.contains('artifact-row')",
        )
        if not page.evaluate("document.activeElement?.classList.contains('artifact-row')"):
            raise AssertionError("Escape did not restore focus to the artifact row")

        settle(page)
        page.screenshot(path=str(OUTPUT / "codex-artifacts-390x844.png"), full_page=False)

        page.evaluate("window.__artifactComplete = false")
        page.locator("#artifactRefreshBtn").click()
        wait_for_condition(
            page,
            "() => document.querySelector('#artifactStatus').dataset.state === 'partial'",
        )
        assert_artifact_groups(page)
        settle(page)
        page.screenshot(
            path=str(OUTPUT / "codex-artifacts-partial-390x844.png"), full_page=False
        )
        page.evaluate("window.__artifactComplete = true")
        page.locator("#artifactRefreshBtn").click()
        wait_for_condition(
            page,
            "() => document.querySelector('#artifactStatus').dataset.state === 'ready'",
        )
        assert_artifact_groups(page)

        page.locator(".artifact-row.state-ready").filter(has_text=".pdf").click()
        page.wait_for_selector("#artifactPreviewBody canvas")
        wait_for_condition(
            page,
            """() => { const canvas = document.querySelector('#artifactPreviewBody canvas');
              return canvas?.width > 0 && canvas?.height > 0 && document.querySelector('#artifactPageStatus').textContent.trim() === '1 / 1'; }"""
        )
        assert_visible_artifact_layout(page, "#artifactPreview", "PDF preview 390x844")
        settle(page)
        page.screenshot(
            path=str(OUTPUT / "codex-artifacts-pdf-390x844.png"), full_page=False
        )
        page.keyboard.press("Escape")
        page.wait_for_selector("#artifactPreview", state="hidden")
        wait_for_condition(
            page,
            "() => !document.querySelector('#app').inert && !document.querySelector('#artifactPreviewBody canvas')",
        )
        page.set_viewport_size({"width": 844, "height": 390})
        settle(page)
        assert_visible_artifact_layout(page, "#artifactsDrawer", "artifact drawer 844x390")
        page.screenshot(path=str(OUTPUT / "codex-artifacts-844x390.png"), full_page=False)

        page.evaluate(
            """window.__mockEmit({
              type: 'system_init', cwd: 'D:\\\\work\\\\codex-remote', model: 'gpt-5.4', effort: 'high',
              threadId: 'other', queueLength: 0, sessionAuto: false, appServerStatus: 'online', restartAttempt: 0, retryInMs: 0
            })"""
        )
        wait_for_condition(page, "() => document.querySelectorAll('.artifact-row').length === 0")
        if page.locator(".artifact-row").count() != 0:
            raise AssertionError("thread switch retained stale artifact rows")
        page.evaluate(
            """window.__mockEmit({
              type: 'system_init', cwd: 'D:\\\\work\\\\codex-remote', model: 'gpt-5.4', effort: 'high',
              threadId: 'thread-1', queueLength: 0, sessionAuto: false, appServerStatus: 'online', restartAttempt: 0, retryInMs: 0
            })"""
        )
        wait_for_condition(page, "() => document.querySelectorAll('.artifact-row').length === 4")
        assert_artifact_turn_cleared(page)
        if errors:
            raise AssertionError(f"artifact interaction browser errors: {errors}")
    finally:
        context.close()


def verify_artifact_narrow_preview(browser, base):
    context, page, errors = open_artifact_page(browser, base, 320, 568)
    try:
        page.locator("#artifactsBtn").click()
        page.locator(".artifact-row.state-ready").filter(has_text="final.txt").click()
        page.wait_for_selector("#artifactPreviewBody pre")
        assert_visible_artifact_layout(page, "#artifactPreview", "text preview 320x568")
        if errors:
            raise AssertionError(f"narrow artifact preview browser errors: {errors}")
    finally:
        context.close()


def assert_layout(page, state, width, height):
    current = metrics(page)
    current["state"] = state
    current["size"] = f"{width}x{height}"
    if current["overflowX"] > 1:
        raise AssertionError(f"{state} horizontal overflow at {width}x{height}: {current}")
    if current["smallTargets"]:
        raise AssertionError(
            f"{state} targets below 44px at {width}x{height}: {current['smallTargets']}"
        )
    return current


def unexpected_disconnected_errors(errors):
    return [
        error
        for error in errors
        if not ("WebSocket connection to" in error and "failed" in error)
    ]


def run():
    if not EDGE.exists():
        raise RuntimeError(f"Microsoft Edge was not found at {EDGE}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    handler = partial(QuietHandler, directory=str(PUBLIC))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/index.html?token=visual-test-token"
    results = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=str(EDGE), headless=True)
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                    reduced_motion="reduce",
                    locale="zh-CN",
                )
                disconnected = context.new_page()
                disconnected_errors = []
                disconnected.on(
                    "pageerror",
                    lambda error, target=disconnected_errors: target.append(
                        f"pageerror: {error}"
                    ),
                )
                disconnected.on(
                    "console",
                    lambda message, target=disconnected_errors: target.append(
                        f"console {message.type}: {message.text}"
                    )
                    if message.type == "error"
                    else None,
                )
                disconnected.goto(base, wait_until="networkidle")
                disconnected.wait_for_timeout(80)
                assert_layout(disconnected, "disconnected-onboarding", width, height)
                disconnected_errors = unexpected_disconnected_errors(disconnected_errors)
                if disconnected_errors:
                    raise AssertionError(
                        f"disconnected browser errors at {width}x{height}: {disconnected_errors}"
                    )
                disconnected.screenshot(
                    path=str(OUTPUT / f"codex-ui-disconnected-{width}x{height}.png"),
                    full_page=False,
                )
                disconnected.close()

                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error, target=errors: target.append(f"pageerror: {error}"))
                page.on("console", lambda message, target=errors: target.append(f"console {message.type}: {message.text}") if message.type == "error" else None)
                page.add_init_script(MOCK_SOCKET)
                page.goto(base, wait_until="networkidle")
                page.wait_for_selector("#connectionText", state="attached")
                page.wait_for_timeout(120)
                page.locator("#toastRegion").evaluate("node => node.replaceChildren()")
                current = assert_layout(page, "connected-idle", width, height)
                current["errors"] = errors
                page.screenshot(path=str(OUTPUT / f"codex-ui-{width}x{height}.png"), full_page=False)
                if not current["messagesVisible"] or current["composer"]["bottom"] > height + 1:
                    raise AssertionError(f"core workspace is not visible at {width}x{height}: {current}")
                if errors:
                    raise AssertionError(f"browser errors at {width}x{height}: {errors}")

                focus_check = page.evaluate("""() => {
                  const button = document.querySelector('button:not([hidden]):not(:disabled)');
                  button.focus();
                  const style = getComputedStyle(button);
                  return { focused: document.activeElement === button, outline: style.outlineStyle,
                    duration: getComputedStyle(document.documentElement).scrollBehavior };
                }""")
                if (
                    not focus_check["focused"]
                    or focus_check["outline"] == "none"
                    or focus_check["duration"] != "auto"
                ):
                    raise AssertionError(
                        f"focus or reduced-motion contract failed at {width}x{height}: {focus_check}"
                    )

                page.evaluate(r"""() => {
                  window.__mockEmit({ type: 'directory', path: String.raw`D:\研究项目\一个非常长的工作目录名称\包含-English-and-Chinese-segments`, entries: [] });
                  window.__mockEmit({ type: 'assistant_delta', text: '正在生成很长的流式回答。'.repeat(80) });
                  window.__mockEmit({ type: 'tool_delta', toolUseId: 'tool-1', delta: String.raw`C:\very-long\path\segment`.repeat(20) });
                }""")
                page.wait_for_timeout(80)
                assert_layout(page, "streaming-long-path", width, height)

                if width in (390, 844):
                    page.locator("#artifactsBtn").click()
                    page.wait_for_timeout(80)
                    assert_layout(page, "artifact-drawer", width, height)
                    page.screenshot(
                        path=str(OUTPUT / f"codex-ui-artifacts-{width}x{height}.png"),
                        full_page=False,
                    )
                    page.keyboard.press("Escape")

                if width == 390:
                    page.locator("#historyBtn").click()
                    page.wait_for_timeout(80)
                    if page.locator("#historyDrawer").is_hidden():
                        raise AssertionError("history drawer did not open")
                    page.screenshot(path=str(OUTPUT / "codex-ui-history-390x844.png"), full_page=False)
                    page.keyboard.press("Escape")
                    page.evaluate("""window.__mockEmit({
                      type: 'permission_request', id: 'approval-visual', kind: 'command',
                      reason: '需要运行项目测试以验证修改', cwd: 'D:\\\\work\\\\codex-remote',
                      command: 'npm run verify', eligibleForSessionAuto: true
                    })""")
                    page.wait_for_timeout(80)
                    if page.locator("#approvalSheet").is_hidden():
                        raise AssertionError("approval sheet did not open")
                    approval_access = page.evaluate("""() => ({
                      appInert: document.querySelector('#app').inert,
                      focusInside: document.querySelector('#approvalSheet').contains(document.activeElement),
                    })""")
                    if not approval_access["appInert"] or not approval_access["focusInside"]:
                        raise AssertionError(f"approval modal is not isolated or focused: {approval_access}")
                    page.screenshot(path=str(OUTPUT / "codex-ui-approval-390x844.png"), full_page=False)
                    page.locator(".approval-deny").click()
                    page.wait_for_timeout(40)
                    if page.evaluate("document.querySelector('#app').inert"):
                        raise AssertionError("approval close did not restore the application")
                    page.evaluate("""window.__mockEmit({
                      type: 'permission_request', id: 'approval-other', kind: 'user_input',
                      questions: [{
                        id: 'q1', header: '发布方式', question: '请选择或输入发布方式', isOther: true,
                        options: [{ label: '仅局域网', description: '只在同一网络访问' }]
                      }]
                    })""")
                    page.wait_for_timeout(80)
                    page.locator("[data-question-id='q1'] [data-answer-text]").fill("自定义安全隧道")
                    page.evaluate("""() => {
                      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
                      document.dispatchEvent(new Event('visibilitychange'));
                    }""")
                    page.wait_for_timeout(180)
                    restored = page.locator("[data-question-id='q1'] [data-answer-text]").input_value()
                    if restored != "自定义安全隧道":
                        raise AssertionError(f"approval draft was lost across foreground reconnect: {restored!r}")
                    page.locator(".approval-allow").click()
                    page.wait_for_timeout(40)
                    other_answer = page.evaluate("window.__lastWire?.payload?.answers?.q1")
                    if other_answer != ["自定义安全隧道"]:
                        raise AssertionError(f"custom approval answer was not exclusive: {other_answer}")
                    page.locator("#screenBtn").click()
                    page.evaluate("""() => {
                      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
                        <rect width="1280" height="720" fill="#111512"/>
                        <path d="M0 90H1280M0 180H1280M0 270H1280M0 360H1280M0 450H1280M0 540H1280M0 630H1280" stroke="#273129"/>
                        <path d="M160 0V720M320 0V720M480 0V720M640 0V720M800 0V720M960 0V720M1120 0V720" stroke="#273129"/>
                        <rect x="72" y="72" width="520" height="360" rx="24" fill="#182019" stroke="#b7f34b"/>
                        <text x="112" y="150" fill="#b7f34b" font-family="Segoe UI" font-size="34">CODEX REMOTE / WINDOWS FEED</text>
                        <text x="112" y="220" fill="#f2f0e8" font-family="Segoe UI" font-size="25">Physical desktop mapping preview</text>
                      </svg>`;
                      const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
                      for (const id of ['screenImage', 'controlImage']) {
                        const image = document.getElementById(id);
                        image.src = source;
                        image.hidden = false;
                      }
                      document.getElementById('screenHint').hidden = true;
                    }""")
                    page.wait_for_timeout(40)
                    screen_access = page.evaluate("""() => ({
                      appInert: document.querySelector('#app').inert,
                      focusInside: document.querySelector('#screenViewer').contains(document.activeElement),
                    })""")
                    if not screen_access["appInert"] or not screen_access["focusInside"]:
                        raise AssertionError(f"screen modal is not isolated or focused: {screen_access}")
                    page.screenshot(path=str(OUTPUT / "codex-ui-screen-390x844.png"), full_page=False)
                    page.locator("#openControlBtn").click()
                    page.wait_for_timeout(40)
                    control_access = page.evaluate("""() => ({
                      appInert: document.querySelector('#app').inert,
                      screenInert: document.querySelector('#screenViewer').inert,
                      focusInside: document.querySelector('#controlViewer').contains(document.activeElement),
                    })""")
                    if not all(control_access.values()):
                        raise AssertionError(f"control modal stack is not isolated or focused: {control_access}")
                    page.keyboard.press("Shift+Tab")
                    if not page.evaluate("document.querySelector('#controlViewer').contains(document.activeElement)"):
                        raise AssertionError("keyboard focus escaped the control modal")
                    page.screenshot(path=str(OUTPUT / "codex-ui-control-390x844.png"), full_page=False)
                    modal_metrics = metrics(page)
                    if modal_metrics["overflowX"] > 1 or modal_metrics["smallTargets"]:
                        raise AssertionError(f"screen control layout failed: {modal_metrics}")
                results.append(current)
                context.close()
            verify_artifact_viewports(browser, base)
            verify_artifact_interactions(browser, base)
            verify_artifact_narrow_preview(browser, base)

            offline_context = browser.new_context(
                viewport={"width": 390, "height": 844},
                locale="zh-CN",
                reduced_motion="reduce",
                service_workers="allow",
            )
            offline_page = offline_context.new_page()
            offline_page.goto(base, wait_until="networkidle")
            offline_page.evaluate("navigator.serviceWorker.ready")
            offline_page.reload(wait_until="networkidle")
            offline_context.set_offline(True)
            offline_page.reload(wait_until="domcontentloaded")
            offline_page.wait_for_selector("#app")
            if not offline_page.locator("#app").is_visible():
                raise AssertionError("installed PWA shell did not reopen offline")
            offline_context.set_offline(False)
            offline_page.locator("#settingsBtn").click()
            offline_page.wait_for_selector("#backendUrl")
            settle(offline_page)
            if offline_page.locator("#backendUrl").is_disabled():
                raise AssertionError("backend replacement is unavailable after returning online")
            offline_page.locator("#toastRegion").evaluate("node => node.replaceChildren()")
            offline_page.screenshot(
                path=str(OUTPUT / "codex-ui-offline-shell-390x844.png"), full_page=False
            )
            offline_context.close()

            panel = browser.new_page(viewport={"width": 1280, "height": 800})
            panel_errors = []
            panel.on(
                "pageerror", lambda error: panel_errors.append(f"pageerror: {error}")
            )
            panel.on(
                "console",
                lambda message: panel_errors.append(
                    f"console {message.type}: {message.text}"
                )
                if message.type == "error"
                else None,
            )
            panel.route(
                "**/api/panel/state",
                lambda route: route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        {
                            "serviceStatus": "online",
                            "codexStatus": "logged-in",
                            "appServerStatus": "online",
                            "workspace": "D:\\研究项目\\Codex Remote",
                            "lanOrigin": "http://192.168.1.2:8766",
                            "tunnelOrigin": "https://redacted.trycloudflare.com",
                            "tools": {"ffmpeg": True, "cloudflared": True},
                            "diagnostics": ["QR 渲染器已恢复", "隧道在线"],
                        },
                        ensure_ascii=False,
                    ),
                ),
            )
            panel.goto(
                base.replace(
                    "index.html?token=visual-test-token",
                    "panel.html#panel=visual-panel-key",
                ),
                wait_until="networkidle",
            )
            panel.wait_for_selector("#panelControls:not([hidden])")
            panel.screenshot(path=str(OUTPUT / "codex-ui-panel-1280x800.png"), full_page=False)
            if panel.evaluate("document.documentElement.scrollWidth - innerWidth") > 1:
                raise AssertionError("desktop relay panel has horizontal overflow")
            if panel_errors:
                raise AssertionError(f"desktop relay panel browser errors: {panel_errors}")
            panel.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print(json.dumps({"ok": True, "results": results, "output": str(OUTPUT)}, ensure_ascii=False))


if __name__ == "__main__":
    run()
