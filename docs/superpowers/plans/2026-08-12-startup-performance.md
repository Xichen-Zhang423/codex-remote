# Startup Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex Remote's local control panel and public-tunnel startup available without waiting for Codex App Server initialization, and stop reinstalling the 390 MB Codex dependency when only application code changes.

**Architecture:** RemoteServer will establish the HTTP/WebSocket surface first and own an adapter startup promise in the background, reporting failures without taking the already-useful panel offline. The launcher will maintain one content-addressed dependency store keyed by lockfile, production dependency declarations, platform, architecture, and Node ABI, plus small content-addressed app snapshots below that store; Node's ancestor lookup resolves the shared `node_modules` directory. Existing token, shutdown, atomic-promotion, read-only-source, and tamper-repair guarantees remain intact.

**Tech Stack:** Node.js ESM, Express 5, WebSocket, Windows batch/PowerShell fixtures, native `node:test`, Git worktrees.

---

## File map

- Modify `src/remote-server.js`: listen before Codex initialization settles, own and observe the background start promise, and make close/rollback race-safe.
- Modify `test/remote-server.test.js`: event-gated startup, failure, close-during-start, and listen-rollback coverage.
- Modify `scripts/bootstrap.js`: separate dependency and app keys, build shared dependencies atomically, build app snapshots without npm, and validate Node inside bootstrap.
- Modify `start.bat`: retain the friendly Node-not-found guard but remove redundant Node-version and npm preflight processes.
- Modify `test/start-bat.test.js`: use a real fake production dependency and cover source-only updates, dependency repair/reinstall, warm startup without npm, and concurrent app repair.
- Modify `test/package-identity.test.js`: preserve the thin, ASCII-safe launcher contract while accepting the bootstrap-owned Node version check.
- Modify `README.md`, `docs/使用教程.md`, and `CHANGELOG.md`: explain instant panel availability, background Codex initialization, and shared dependency caching.
- Create `scripts/benchmark-startup.mjs`: deterministic non-destructive benchmark for bootstrap preparation and HTTP-before-adapter readiness.
- Modify `package.json`: syntax-check and expose the startup benchmark.

### Task 1: HTTP-first service startup

**Files:**
- Modify: `src/remote-server.js:190-269,877-902`
- Modify: `test/remote-server.test.js:1145-1200`

- [ ] **Step 1: Write failing event-gated tests**

Add a deferred adapter whose `start()` does not settle. Assert `createRemoteServer()` resolves, `/api/health` returns 200, and the initial WebSocket state reports a non-online App Server before resolving the deferred start. Add tests that a late startup rejection is reported once while HTTP remains healthy, close during startup stops the owned adapter once without unhandled rejection, and a listening failure still stops the owned adapter.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="HTTP listens before|background adapter|close during background|rolls back the owned" test/remote-server.test.js`

Expected: the first three tests fail because `RemoteServer.#start()` still awaits `adapter.start()` before listening.

- [ ] **Step 3: Implement background adapter ownership**

Create the HTTP surface and await `listen()` first. After the address is committed, invoke `adapter.start()` without awaiting it, retain a caught promise, report only failures that are not caused by an intentional close, and keep adapter ownership explicit. `close()` and rollback must stop the adapter once and consume the background promise so no rejection escapes.

- [ ] **Step 4: Run focused and component tests**

Run: `node --test test/remote-server.test.js test/server.test.js test/codex-adapter.test.js test/codex-process.test.js`

Expected: PASS, with no hung Node/Codex child process.

- [ ] **Step 5: Commit**

Commit message: `perf: open remote panel before Codex initialization`

### Task 2: Shared dependency cache and lightweight app snapshots

**Files:**
- Modify: `scripts/bootstrap.js:8-123,148-288,301-335`
- Modify: `start.bat:1-25`
- Modify: `test/start-bat.test.js`
- Modify: `test/package-identity.test.js:84-105`

- [ ] **Step 1: Strengthen the launcher fixture and write failing cache tests**

Give the fixture a production dependency named `fixture-dependency`; make fake npm create its manifest. Assert the layout is `runtime/<dependencyKey>/node_modules` plus `runtime/<dependencyKey>/apps/<appKey>`. After changing only `src`, assert the new server executes and the npm log remains at one line. After removing the direct dependency manifest, assert exactly one reinstall. Assert a ready cache launches when npm is absent, while a cold cache reports a bounded npm error. Retain read-only Unicode path, tamper repair, and concurrent repair checks.

- [ ] **Step 2: Run launcher tests and verify RED**

Run: `node --test test/start-bat.test.js test/package-identity.test.js`

Expected: failures show code-only changes still create a full runtime and rerun npm.

- [ ] **Step 3: Implement two-level content addressing**

Export `appHash(sourceDir)` for `package.json`, `server.js`, and `src/**`; export `dependencyHash(sourceDir, runtime identity)` for the lockfile, normalized production dependency declarations, platform, architecture, Node ABI, and cache schema. Install dependencies in a staging dependency directory using `npm ci --omit=dev --no-audit --no-fund --prefer-offline` with `npm_config_update_notifier=false`, then atomically promote it. Copy and integrity-check each small app into `apps/<appHash>` under a separate app lock without invoking npm. Return the app directory as `runtimeDir`, preserving the existing server working-directory behavior and source/config environment variables.

- [ ] **Step 4: Remove redundant BAT preflights**

Keep `where node` and the friendly `node_missing` branch. Let bootstrap check `process.versions.node` against `package.json.engines.node` before preparing the runtime. Do not call `where npm` or spawn a separate `node -p`; npm is needed only on a dependency-cache miss and is diagnosed from `runNpm()`.

- [ ] **Step 5: Run launcher and integrity tests**

Run: `node --test test/start-bat.test.js test/package-identity.test.js test/release-verify.test.js`

Expected: PASS; code-only update npm calls remain one, missing dependency causes one additional install, no staging/lock remains.

- [ ] **Step 6: Commit**

Commit message: `perf: reuse dependencies across app updates`

### Task 3: Benchmark, documentation, and release integration

**Files:**
- Create: `scripts/benchmark-startup.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/使用教程.md`
- Modify: `CHANGELOG.md`
- Modify: `test/documentation.test.js`

- [ ] **Step 1: Add deterministic behavior contracts**

Add documentation assertions for “control panel first / Codex initializes in background” and “code update reuses shared dependencies.” Add a benchmark script that measures warm `prepareRuntime()` without starting the user service and measures a synthetic deferred adapter to prove HTTP readiness occurs before adapter completion. It must write only inside an owned temporary directory and delete it in `finally`.

- [ ] **Step 2: Run focused docs/benchmark checks and verify RED where applicable**

Run: `node --test test/documentation.test.js && npm run benchmark:startup`

Expected before implementation: docs contract fails; benchmark exits nonzero if HTTP waits for the deferred adapter.

- [ ] **Step 3: Document the user-visible behavior**

Explain that the desktop panel and Quick Tunnel begin immediately, status can briefly show App Server starting, and first task execution becomes available when initialization finishes. Explain that the first launch after this cache-format upgrade may install once, while later code-only upgrades reuse the large dependency cache.

- [ ] **Step 4: Run the full release gates and inspect processes**

Run: `npm ci`, `npm run benchmark:startup`, `npm run verify`, `npm run release:copy`, `git diff --check`, plus a process inspection confirming no benchmark-owned Codex/Node/keep-awake child remains.

Expected: all tests and release validators pass; benchmark reports HTTP readiness before synthetic adapter completion; no secret/token/QR is printed.

- [ ] **Step 5: Commit and publish**

Commit message: `docs: explain faster startup behavior`. Sync the source repository to the standalone GitHub repository, verify the exact copied tree, commit, and push the standalone `main` branch.

## Self-review

- Spec coverage: recurring startup, first launch after code update, failure behavior, shutdown ownership, read-only source, tamper repair, documentation, benchmark, and publishing all map to explicit tasks.
- Security: no token-bearing URL enters benchmark output; panel capability remains fragment-only; cache integrity and atomic promotion are retained.
- Performance: no wall-clock threshold is used as a flaky test gate; behavior is proven by event ordering and npm call counts.
- Scope: historical 5 GB cache cleanup is intentionally deferred from the startup critical path because synchronous deletion would make the requested problem worse.
