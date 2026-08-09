# Desktop Launcher and Public-First Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open Codex Remote in a desktop app-style window and make its local control panel show the public tunnel QR by default while keeping LAN access hidden until explicitly requested.

**Architecture:** Add a small parameterized Windows browser launcher, split panel connection generation into explicit `remote` and `lan` modes, and make the existing local panel a public-first state machine. Keep the panel capability in the URL fragment, keep phone tokens out of state/logs, and preserve a headless `NO_PANEL=1` path for CI and troubleshooting.

**Tech Stack:** Node.js ESM, Express 5, native `node:test`, browser DOM/CSS/JavaScript, Edge/Chrome app mode, Cloudflare Quick Tunnel.

---

## File map

- Create `src/desktop-panel.js`: safely opens the local panel in Edge/Chrome app mode with a default-browser fallback.
- Create `test/desktop-panel.test.js`: unit coverage for browser selection, argument safety, fallback, and disabled mode.
- Modify `src/panel-session.js`: validate and forward explicit `remote`/`lan` connection modes.
- Modify `src/remote-server.js`: parse the panel connection JSON body and return stable status/code pairs.
- Modify `server.js`: provide mode-specific URLs, auto-open the panel, and remove terminal QR/token output.
- Modify `public/panel.html`: public-first connection card and hidden LAN connection option.
- Modify `public/panel.js`: automatic remote QR state machine and explicit LAN reveal behavior.
- Modify `public/styles.css`: desktop-app visual hierarchy, connection states, responsive layout, and reduced-motion-safe feedback.
- Modify `test/panel-session.test.js`, `test/remote-server.test.js`, `test/server.test.js`, and `test/public-contract.test.js`: regression coverage.
- Modify `package.json`, `package-lock.json`, `scripts/release-verify.js`, `README.md`, `docs/使用教程.md`, and `CHANGELOG.md`: remove unused terminal QR dependency and document the new launch flow.
- Update `docs/images/desktop-panel.png`: verified screenshot of the finished public-first desktop panel.

### Task 1: Safe desktop app-mode launcher

**Files:**
- Create: `src/desktop-panel.js`
- Create: `test/desktop-panel.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing launcher tests**

Cover Edge preference, Chrome fallback, shell-free arguments, default-browser fallback, `NO_PANEL`, non-Windows no-op, and non-fatal spawn errors. The central assertion must require an argument array:

```js
assert.equal(calls[0].file, edgePath);
assert.deepEqual(calls[0].args, [
  `--app=${panelUrl}`,
  "--window-size=1120,820",
]);
assert.equal(calls[0].options.shell, false);
```

- [ ] **Step 2: Run the launcher test and verify RED**

Run: `node --test test/desktop-panel.test.js`

Expected: FAIL because `src/desktop-panel.js` does not exist.

- [ ] **Step 3: Implement the minimal launcher**

Expose one testable function with injected filesystem and process creation:

```js
export function openDesktopPanel(url, {
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
  spawnImpl = spawn,
  onError = () => {},
} = {}) {
  if (isTrueFlag(env.NO_PANEL) || platform !== "win32") return { opened: false, mode: "disabled" };
  const browser = browserCandidates(env).find((candidate) => candidate && existsSync(candidate));
  const file = browser || "explorer.exe";
  const args = browser ? [`--app=${url}`, "--window-size=1120,820"] : [url];
  const child = spawnImpl(file, args, {
    detached: true, stdio: "ignore", windowsHide: true, shell: false,
  });
  child.once?.("error", onError);
  child.unref?.();
  return { opened: true, mode: browser ? "app" : "browser", file };
}
```

The function must validate that `url` is a loopback `http:` URL before spawning.

- [ ] **Step 4: Run tests and syntax check**

Run: `node --test test/desktop-panel.test.js && node --check src/desktop-panel.js`

Expected: all launcher tests PASS and syntax check exits 0.

- [ ] **Step 5: Commit the launcher unit**

```powershell
git add -- codex-remote/src/desktop-panel.js codex-remote/test/desktop-panel.test.js codex-remote/package.json
git commit -m "feat: add desktop panel launcher"
```

### Task 2: Explicit remote and LAN connection modes

**Files:**
- Modify: `src/panel-session.js`
- Modify: `src/remote-server.js`
- Modify: `test/panel-session.test.js`
- Modify: `test/remote-server.test.js`

- [ ] **Step 1: Write failing panel-session mode tests**

Require the default mode to be `remote`, allow explicit `lan`, and reject every other value before calling the provider:

```js
const modes = [];
const session = createPanelSession({
  connectionProvider: async (mode) => {
    modes.push(mode);
    return `https://${mode}.example/?token=phone-secret`;
  },
  qrToDataUrl: async () => null,
});
await session.createConnection();
await session.createConnection("lan");
assert.deepEqual(modes, ["remote", "lan"]);
await assert.rejects(session.createConnection("other"), (error) => error.code === "PANEL_CONNECTION_MODE");
```

- [ ] **Step 2: Run panel-session tests and verify RED**

Run: `node --test test/panel-session.test.js`

Expected: FAIL because the provider receives no mode and unknown modes are accepted.

- [ ] **Step 3: Implement mode validation in `panel-session.js`**

Use the exact public signature `createConnection(mode = "remote")`. Throw a typed error with `code = "PANEL_CONNECTION_MODE"` for values other than `remote` or `lan`, then call `connectionProvider(mode)`.

- [ ] **Step 4: Run panel-session tests and verify GREEN**

Run: `node --test test/panel-session.test.js`

Expected: all panel-session tests PASS.

- [ ] **Step 5: Write failing HTTP route tests**

Extend the authorized panel route test to submit JSON bodies and assert the provider modes:

```js
await fetch(`${remote.httpUrl}/api/panel/connection`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ mode: "lan" }),
});
assert.deepEqual(connectionModes, ["remote", "lan"]);
```

Also assert malformed JSON returns 400, invalid mode returns `{ error: "invalid connection mode", code: "PANEL_CONNECTION_MODE" }` with 400, and an error carrying `PUBLIC_CONNECTION_NOT_READY` returns 503 with that stable code.

- [ ] **Step 6: Run route tests and verify RED**

Run: `node --test --test-name-pattern="panel routes" test/remote-server.test.js`

Expected: FAIL because the route does not parse or forward `mode`.

- [ ] **Step 7: Implement the mode-aware HTTP route**

Add `express.json({ limit: "1kb" })` only to the connection route and call:

```js
const mode = request.body?.mode ?? "remote";
response.json(await this.panelSession.createConnection(mode));
```

Map `PANEL_CONNECTION_MODE` to HTTP 400, `PUBLIC_CONNECTION_NOT_READY` to HTTP 503, and other provider failures to the existing generic 503 response. Never include the provider exception text in the response.

- [ ] **Step 8: Run both focused test files and commit**

Run: `node --test test/panel-session.test.js test/remote-server.test.js`

Expected: all tests PASS.

```powershell
git add -- codex-remote/src/panel-session.js codex-remote/src/remote-server.js codex-remote/test/panel-session.test.js codex-remote/test/remote-server.test.js
git commit -m "feat: split public and LAN panel connections"
```

### Task 3: Public-first panel behavior and visual hierarchy

**Files:**
- Modify: `public/panel.html`
- Modify: `public/panel.js`
- Modify: `public/styles.css`
- Modify: `test/public-contract.test.js`

- [ ] **Step 1: Write failing public contract tests**

Require these IDs: `remoteConnection`, `remoteState`, `remoteUrl`, `remoteQr`, `copyRemoteConnection`, `retryRemoteConnection`, `connectionOptions`, `showLanConnection`, `lanConnection`, `lanUrl`, `lanQr`, `copyLanConnection`, and `hideLanConnection`. Remove `lanOrigin` and `generateConnection` from the default panel contract.

Assert the client sends explicit mode JSON and tracks tunnel changes:

```js
assert.match(client, /JSON\.stringify\(\{ mode \}\)/);
assert.match(client, /mode === "remote"/);
assert.match(client, /state\.tunnelOrigin !== lastRemoteOrigin/);
assert.match(client, /generateConnection\("lan"\)/);
assert.doesNotMatch(html, /<h2>局域网<\/h2>/);
```

- [ ] **Step 2: Run the public contract test and verify RED**

Run: `node --test --test-name-pattern="desktop panel|status and error" test/public-contract.test.js`

Expected: FAIL because the old panel exposes LAN by default and has one generic connection card.

- [ ] **Step 3: Implement the public-first HTML**

Make the remote connection card visible at page load. Its primary copy is “公网远程连接” with the waiting text “正在建立安全公网隧道…”. Put LAN controls inside a collapsed `<details id="connectionOptions">` section and keep `<section id="lanConnection" hidden>` until user action. Keep all status/error elements accessible with `role="status"`, `role="alert"`, labels, and 44px controls.

- [ ] **Step 4: Implement the connection state machine**

Use separate connection records and request epochs:

```js
async function generateConnection(mode) {
  const epoch = ++connectionEpoch[mode];
  const result = await request("/api/panel/connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (epoch !== connectionEpoch[mode]) return;
  renderConnection(mode, result);
}
```

In `renderState`, only call `generateConnection("remote")` when a non-empty `state.tunnelOrigin` differs from `lastRemoteOrigin`. When it is empty, render the public waiting state and do not call the connection API. The LAN button must reveal its section and call `generateConnection("lan")`; hiding it must clear its QR, copy URL, and expiry timer.

- [ ] **Step 5: Implement the visual treatment**

Use the existing industrial black/acid-green design tokens. Give the public connection card the strongest hierarchy, a restrained animated online/waiting beacon, a high-contrast QR stage, a monospace redacted URL, and a quiet outlined LAN options block. Motion must stop under `prefers-reduced-motion`, text must wrap, and the layout must collapse to one column below 720px.

- [ ] **Step 6: Run public tests and syntax checks**

Run: `node --test test/public-contract.test.js && node --check public/panel.js`

Expected: all public contract tests PASS and syntax check exits 0.

- [ ] **Step 7: Commit the panel UI**

```powershell
git add -- codex-remote/public/panel.html codex-remote/public/panel.js codex-remote/public/styles.css codex-remote/test/public-contract.test.js
git commit -m "feat: make desktop panel public first"
```

### Task 4: Wire the launcher and remove automatic terminal QR output

**Files:**
- Modify: `server.js`
- Modify: `test/server.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing server lifecycle tests**

Inject `openPanelImpl` into `main()` and require exactly one call after HTTP startup:

```js
openPanelImpl: (url, options) => opened.push({ url, options }),
```

Assert that the URL is the fragment-capability panel URL, that `platform`, `env`, and a diagnostic callback are supplied, and that no log line contains the panel key, phone token, `Phone base URL`, `LAN ONLY`, `Scan this QR code`, or block QR characters. Assert that a tunnel online event logs only its public base URL.

- [ ] **Step 2: Run focused server tests and verify RED**

Run: `node --test --test-name-pattern="main wires Windows|desktop panel|QR" test/server.test.js`

Expected: FAIL because the panel is not opened and LAN/public terminal QR output still exists.

- [ ] **Step 3: Implement mode-specific connection providers**

Change the panel provider to:

```js
connectionProvider: async (mode) => {
  const origin = mode === "lan" ? phoneBaseUrl : tunnelOrigin;
  if (!origin) {
    const error = new Error(mode === "lan" ? "LAN connection is not ready" : "Public connection is not ready");
    error.code = mode === "lan" ? "LAN_CONNECTION_NOT_READY" : "PUBLIC_CONNECTION_NOT_READY";
    throw error;
  }
  return buildPhoneUrl(origin, config.token, config.rendezvous?.url, config.rendezvous?.deviceId);
},
```

- [ ] **Step 4: Auto-open the panel without logging secrets**

Import `openDesktopPanel`, inject it as `openPanelImpl`, and after `phoneBaseUrl` is selected call it only for Windows and when `NO_PANEL` is not true. Log `Desktop control panel opened.` instead of the capability URL. Route launcher exceptions and child errors through `reportDiagnostic("panel", cause)` without stopping the service.

- [ ] **Step 5: Remove terminal QR generation**

Delete `showPhoneAccess`, the `qrcode-terminal` import, `qrGenerate` injection, and every LAN/public QR invocation. When the tunnel reaches `online`, log only `Public remote URL: <base-url>`; this line must contain neither panel key nor phone token. Run `npm uninstall qrcode-terminal --ignore-scripts --no-audit --no-fund` to update both dependency files.

- [ ] **Step 6: Run focused and full server tests**

Run: `node --test test/desktop-panel.test.js test/panel-session.test.js test/remote-server.test.js test/server.test.js`

Expected: all tests PASS.

- [ ] **Step 7: Commit the server integration**

```powershell
git add -- codex-remote/server.js codex-remote/test/server.test.js codex-remote/package.json codex-remote/package-lock.json
git commit -m "feat: open public-first desktop console"
```

### Task 5: Documentation, release rules, and visual QA

**Files:**
- Modify: `scripts/release-verify.js`
- Modify: `test/release-verify.test.js`
- Modify: `README.md`
- Modify: `docs/使用教程.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/images/desktop-panel.png`

- [ ] **Step 1: Write failing documentation/release assertions**

Update documentation tests to require “启动后自动打开桌面控制台”, “默认显示公网二维码”, and “显示局域网连接”. Add `src/desktop-panel.js` to release source/syntax coverage and assert `qrcode-terminal` is absent from runtime dependencies.

- [ ] **Step 2: Run release and documentation tests and verify RED**

Run: `node --test test/documentation.test.js test/release-verify.test.js test/package-identity.test.js`

Expected: FAIL until implementation and documentation describe the new behavior.

- [ ] **Step 3: Update documentation and release checks**

Document that the desktop UI opens automatically, the public QR appears after Quick Tunnel is ready, LAN is behind “连接选项”, closing the UI does not stop the service, and `NO_PANEL=1` disables automatic opening. Replace instructions that tell users to scan the first LAN QR or wait for terminal QR output.

- [ ] **Step 4: Start an isolated live instance for visual QA**

Use an unused local port, isolated config, `CODEX_REMOTE_TUNNEL=0`, and a test double only where needed to render the online public state without exposing a real token. Verify at 1120×820 and a narrow viewport that the LAN section starts hidden, controls remain keyboard accessible, and no horizontal overflow appears.

- [ ] **Step 5: Capture and inspect the desktop panel image**

Replace `docs/images/desktop-panel.png` with a sanitized screenshot containing no real token, host name, account, workspace, or QR payload. Inspect the PNG at full resolution before accepting it.

- [ ] **Step 6: Run focused documentation tests and commit**

Run: `node --test test/documentation.test.js test/github-presentation.test.js test/release-verify.test.js test/package-identity.test.js`

Expected: all tests PASS.

```powershell
git add -- codex-remote/scripts/release-verify.js codex-remote/test/release-verify.test.js codex-remote/README.md codex-remote/docs/使用教程.md codex-remote/CHANGELOG.md codex-remote/docs/images/desktop-panel.png
git commit -m "docs: explain public-first desktop launch"
```

### Task 6: Full verification, standalone synchronization, and GitHub publication

**Files:**
- Modify: `deliverables/CodexRemote-GitHub/**` to match the release source.

- [ ] **Step 1: Run the complete source verification**

Run: `npm run verify`

Expected: syntax checks, all Node tests, brand checks, and `[release] OK` pass with zero failures or cancellations.

- [ ] **Step 2: Run an actual Windows launch smoke test**

Start the source with an isolated port/config and confirm the desktop opener receives a loopback panel URL, the service reaches health, the public connection does not fall back to LAN, and shutdown leaves no owned Node or cloudflared child. Do not record or print the phone token.

- [ ] **Step 3: Review the complete diff and secret scan**

Run:

```powershell
git diff --check HEAD~5..HEAD
git diff --stat HEAD~5..HEAD
git grep -n -I -E 'sk-[A-Za-z0-9_-]{20,}|[?&]token=[^"[:space:]]+' -- . ':!test/**'
```

Expected: no whitespace errors and no committed credentials or live connection links.

- [ ] **Step 4: Synchronize the standalone repository**

Copy only the tracked Codex Remote release files to the sibling `deliverables/CodexRemote-GitHub` directory, preserving its `.git`. Verify source-to-standalone hashes for every changed file after line-ending normalization.

- [ ] **Step 5: Verify the standalone repository**

Run: `npm ci` if its lock changed, then `npm run verify` in the standalone repository.

Expected: the same full suite passes with `[release] OK`.

- [ ] **Step 6: Independent code and design review**

Dispatch one code reviewer for security/lifecycle correctness and one design reviewer for public-first clarity, accessibility, and narrow-window behavior. Fix every confirmed issue with a failing regression test before proceeding.

- [ ] **Step 7: Commit and push the standalone release**

```powershell
git add --all
git commit -m "feat: add public-first desktop launcher"
git push origin main
```

- [ ] **Step 8: Confirm GitHub Windows CI**

Wait for the pushed Windows Verify workflow to complete. Completion requires `conclusion: success`; a merely queued or running workflow is not sufficient.
