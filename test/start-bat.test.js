import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsTest = process.platform === "win32" ? test : test.skip;

function createFixture(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex remote launcher-启动-"));
  const sourceDir = path.join(fixtureRoot, "read only source");
  const localAppData = path.join(fixtureRoot, "local app data");
  const binDir = path.join(fixtureRoot, "bin");
  const npmLog = path.join(fixtureRoot, "npm-cwd.txt");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  for (const directory of ["src", "public", "scripts"]) {
    fs.mkdirSync(path.join(sourceDir, directory));
  }
  const bootstrap = path.join(projectRoot, "scripts", "bootstrap.js");
  if (fs.existsSync(bootstrap)) {
    fs.copyFileSync(bootstrap, path.join(sourceDir, "scripts", "bootstrap.js"));
  }

  fs.copyFileSync(path.join(projectRoot, "start.bat"), path.join(sourceDir, "start.bat"));
  fs.writeFileSync(path.join(sourceDir, "package.json"), JSON.stringify({
    name: "launcher-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
  }));
  fs.writeFileSync(path.join(sourceDir, "package-lock.json"), JSON.stringify({
    name: "launcher-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "launcher-fixture", version: "1.0.0" } },
  }));
  fs.writeFileSync(path.join(sourceDir, "server.js"), [
    'import fs from "node:fs";',
    'if (!fs.existsSync(process.env.CODEX_REMOTE_CONFIG)) fs.writeFileSync(process.env.CODEX_REMOTE_CONFIG, "{}");',
    'console.log(`SERVER_SENTINEL=${process.cwd()}`);',
    'console.log(`SOURCE_SENTINEL=${process.env.CODEX_REMOTE_SOURCE_DIR}`);',
  ].join("\n"));
  fs.writeFileSync(path.join(binDir, "npm.cmd"), [
    "@echo off",
    "echo NPM_CWD=%CD%",
    '>> "%LAUNCHER_TEST_LOG%" echo %CD%',
    'if defined LAUNCHER_TEST_DELAY_MS node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.LAUNCHER_TEST_DELAY_MS))"',
    "if defined LAUNCHER_TEST_EXIT exit /b %LAUNCHER_TEST_EXIT%",
    "exit /b 0",
  ].join("\r\n"));

  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  return {
    fixtureRoot,
    sourceDir,
    localAppData,
    npmLog,
    appHome: path.join(localAppData, "CodexRemote"),
    configFile: path.join(localAppData, "CodexRemote", "config.json"),
    runtimeRoot: path.join(localAppData, "CodexRemote", "runtime"),
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      LAUNCHER_TEST_LOG: npmLog,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  };
}

function launch({ fixtureRoot, sourceDir, env }) {
  const launcher = path.join(sourceDir, "start.bat");
  const result = spawnSync(process.env.ComSpec, ["/d", "/c", launcher], {
    cwd: fixtureRoot,
    env,
    encoding: "utf8",
    input: "\r\n",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { ...result, output: `${result.stdout || ""}\n${result.stderr || ""}` };
}

function launchAsync({ fixtureRoot, sourceDir, env }) {
  const launcher = path.join(sourceDir, "start.bat");
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec, ["/d", "/c", launcher], {
      cwd: fixtureRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for launcher"));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
    child.stdin.end("\r\n");
  });
}

function setFileTreeMode(directory, mode) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) setFileTreeMode(absolute, mode);
    else if (entry.isFile()) fs.chmodSync(absolute, mode);
  }
}

windowsTest("launcher installs and writes config only in the user-local runtime", (t) => {
  const fixture = createFixture(t);
  const result = launch(fixture);

  assert.equal(result.status, 0, result.output);
  const npmCwd = fs.readFileSync(fixture.npmLog, "utf8").trim();
  assert.equal(path.dirname(npmCwd), fixture.runtimeRoot);
  assert.match(path.basename(npmCwd), /^\.staging-/);
  const runtimes = fs.readdirSync(fixture.runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".staging-"));
  assert.equal(runtimes.length, 1);
  const installedRuntime = path.join(fixture.runtimeRoot, runtimes[0].name);
  assert.equal(fs.existsSync(path.join(installedRuntime, ".ready")), true);
  assert.match(result.output, /SERVER_SENTINEL=/);
  assert.match(result.output, new RegExp(`SERVER_SENTINEL=${installedRuntime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result.output, /SOURCE_SENTINEL=.*read only source/);
  assert.equal(fs.existsSync(fixture.configFile), true);
  assert.equal(fs.existsSync(path.join(fixture.sourceDir, "config.json")), false);
  assert.equal(fs.existsSync(path.join(fixture.sourceDir, "node_modules")), false);
});

windowsTest("launcher installs from a fully read-only source copy", (t) => {
  const fixture = createFixture(t);
  let result;
  try {
    setFileTreeMode(fixture.sourceDir, 0o444);
    result = launch(fixture);
  } finally {
    setFileTreeMode(fixture.sourceDir, 0o666);
  }

  assert.equal(result.status, 0, result.output);
  assert.equal(fs.existsSync(path.join(fixture.sourceDir, "node_modules")), false);
  assert.equal(fs.readdirSync(fixture.runtimeRoot).some((name) => name.startsWith(".staging-")), false);
});

windowsTest("launcher treats a negative npm exit code as installation failure", (t) => {
  const fixture = createFixture(t);
  fixture.env.LAUNCHER_TEST_EXIT = "-4048";
  const result = launch(fixture);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Dependency installation failed/i);
  assert.doesNotMatch(result.output, /\[Codex Remote\] Starting|SERVER_SENTINEL=/);
});

windowsTest("launcher reuses a completed content-addressed runtime", (t) => {
  const fixture = createFixture(t);
  const first = launch(fixture);
  assert.equal(first.status, 0, first.output);

  fixture.env.LAUNCHER_TEST_EXIT = "-4048";
  const second = launch(fixture);
  assert.equal(second.status, 0, second.output);
  const npmRuns = fs.readFileSync(fixture.npmLog, "utf8").trim().split(/\r?\n/);
  assert.equal(npmRuns.length, 1);
});

windowsTest("launcher repairs a runtime whose executable code was changed", (t) => {
  const fixture = createFixture(t);
  const first = launch(fixture);
  assert.equal(first.status, 0, first.output);

  const runtimeName = fs.readdirSync(fixture.runtimeRoot)
    .find((name) => !name.startsWith(".staging-"));
  assert.ok(runtimeName);
  const runtimeServer = path.join(fixture.runtimeRoot, runtimeName, "server.js");
  fs.writeFileSync(runtimeServer, 'console.log("TAMPERED_RUNTIME_EXECUTED");');

  const second = launch(fixture);
  assert.equal(second.status, 0, second.output);
  assert.doesNotMatch(second.output, /TAMPERED_RUNTIME_EXECUTED/);
  assert.match(second.output, /SERVER_SENTINEL=/);
  const npmRuns = fs.readFileSync(fixture.npmLog, "utf8").trim().split(/\r?\n/);
  assert.equal(npmRuns.length, 2);
});

windowsTest("concurrent repairs serialize one dependency installation per runtime hash", async (t) => {
  const fixture = createFixture(t);
  const first = launch(fixture);
  assert.equal(first.status, 0, first.output);

  const runtimeName = fs.readdirSync(fixture.runtimeRoot)
    .find((name) => !name.startsWith("."));
  assert.ok(runtimeName);
  fs.writeFileSync(path.join(fixture.runtimeRoot, runtimeName, "server.js"), "// damaged runtime");
  fixture.env.LAUNCHER_TEST_DELAY_MS = "300";

  const results = await Promise.all([launchAsync(fixture), launchAsync(fixture)]);
  for (const result of results) {
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /SERVER_SENTINEL=/);
  }
  const npmRuns = fs.readFileSync(fixture.npmLog, "utf8").trim().split(/\r?\n/);
  assert.equal(npmRuns.length, 2);
  assert.deepEqual(fs.readdirSync(fixture.runtimeRoot), [runtimeName]);
});

windowsTest("launcher migrates an existing source config without changing it", (t) => {
  const fixture = createFixture(t);
  const legacyConfig = '{"token":"existing-phone-token"}';
  fs.writeFileSync(path.join(fixture.sourceDir, "config.json"), legacyConfig);

  const result = launch(fixture);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(fixture.configFile, "utf8"), legacyConfig);
  assert.equal(fs.readFileSync(path.join(fixture.sourceDir, "config.json"), "utf8"), legacyConfig);
});
