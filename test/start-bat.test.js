import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appHash, assertSupportedNodeVersion, dependencyHash } from "../scripts/bootstrap.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsTest = process.platform === "win32" ? test : test.skip;

function createFixture(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex remote launcher-启动-"));
  const sourceDir = path.join(fixtureRoot, "read only source");
  const localAppData = path.join(fixtureRoot, "local app data");
  const binDir = path.join(fixtureRoot, "bin");
  const nodeOnlyBin = path.join(fixtureRoot, "node only bin");
  const npmLog = path.join(fixtureRoot, "npm-runs.jsonl");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(nodeOnlyBin, { recursive: true });
  for (const directory of ["src", "public", "scripts"]) {
    fs.mkdirSync(path.join(sourceDir, directory));
  }
  fs.copyFileSync(path.join(projectRoot, "scripts", "bootstrap.js"), path.join(sourceDir, "scripts", "bootstrap.js"));
  fs.copyFileSync(path.join(projectRoot, "start.bat"), path.join(sourceDir, "start.bat"));
  fs.writeFileSync(path.join(sourceDir, "package.json"), JSON.stringify({
    name: "launcher-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: { "fixture-dependency": "1.0.0" },
  }));
  fs.writeFileSync(path.join(sourceDir, "package-lock.json"), JSON.stringify({
    name: "launcher-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "launcher-fixture",
        version: "1.0.0",
        dependencies: { "fixture-dependency": "1.0.0" },
      },
      "node_modules/fixture-dependency": { version: "1.0.0" },
    },
  }));
  fs.writeFileSync(path.join(sourceDir, "src", "version.js"), 'export default "one";\n');
  fs.writeFileSync(path.join(sourceDir, "server.js"), [
    'import fs from "node:fs";',
    'import dependency from "fixture-dependency";',
    'import appVersion from "./src/version.js";',
    'if (!fs.existsSync(process.env.CODEX_REMOTE_CONFIG)) fs.writeFileSync(process.env.CODEX_REMOTE_CONFIG, "{}");',
    'console.log(`SERVER_SENTINEL=${process.cwd()}`);',
    'console.log(`SOURCE_SENTINEL=${process.env.CODEX_REMOTE_SOURCE_DIR}`);',
    'console.log(`DEPENDENCY_SENTINEL=${dependency}`);',
    'console.log(`APP_VERSION=${appVersion}`);',
  ].join("\n"));

  const fakeNpm = path.join(binDir, "fake-npm.mjs");
  fs.writeFileSync(fakeNpm, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const record = {',
    '  cwd: process.cwd(),',
    '  args: process.argv.slice(2),',
    '  updateNotifier: process.env.npm_config_update_notifier,',
    '  cache: process.env.npm_config_cache,',
    '};',
    'fs.appendFileSync(process.env.LAUNCHER_TEST_LOG, `${JSON.stringify(record)}\\n`);',
    'const delay = Number(process.env.LAUNCHER_TEST_DELAY_MS || 0);',
    'if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);',
    'const packageDir = path.join(process.cwd(), "node_modules", "fixture-dependency");',
    'fs.mkdirSync(packageDir, { recursive: true });',
    'fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({',
    '  name: "fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js",',
    '}));',
    'fs.writeFileSync(path.join(packageDir, "index.js"), \'export default "fixture-dependency-ok";\\n\');',
  ].join("\n"));
  fs.writeFileSync(path.join(binDir, "npm.cmd"), [
    "@echo off",
    "if defined LAUNCHER_TEST_EXIT exit /b %LAUNCHER_TEST_EXIT%",
    `"${process.execPath}" "%~dp0fake-npm.mjs" %*`,
    "exit /b %ERRORLEVEL%",
  ].join("\r\n"));
  fs.writeFileSync(path.join(nodeOnlyBin, "node.cmd"), [
    "@echo off",
    `"${process.execPath}" %*`,
    "exit /b %ERRORLEVEL%",
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
    nodeOnlyPath: [
      nodeOnlyBin,
      path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
      process.env.SystemRoot || "C:\\Windows",
    ].join(path.delimiter),
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

function visibleDirectories(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(directory, entry.name));
}

function dependencyDirectories(fixture) {
  return visibleDirectories(fixture.runtimeRoot);
}

function appDirectories(dependencyDir) {
  return visibleDirectories(path.join(dependencyDir, "apps"));
}

function npmRuns(fixture) {
  if (!fs.existsSync(fixture.npmLog)) return [];
  return fs.readFileSync(fixture.npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

test("cache keys separate app content from dependency and runtime identity", (t) => {
  const fixture = createFixture(t);
  const identity = { platform: "win32", arch: "x64", abi: "127" };
  const firstAppKey = appHash(fixture.sourceDir);
  const firstDependencyKey = dependencyHash(fixture.sourceDir, identity);

  fs.writeFileSync(path.join(fixture.sourceDir, "src", "version.js"), 'export default "two";\n');
  assert.notEqual(appHash(fixture.sourceDir), firstAppKey);
  assert.equal(dependencyHash(fixture.sourceDir, identity), firstDependencyKey);

  const manifestPath = path.join(fixture.sourceDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.dependencies["another-dependency"] = "2.0.0";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const dependencyChangedKey = dependencyHash(fixture.sourceDir, identity);
  assert.notEqual(dependencyChangedKey, firstDependencyKey);

  const lockPath = path.join(fixture.sourceDir, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/fixture-dependency"].version = "1.0.1";
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  const lockChangedKey = dependencyHash(fixture.sourceDir, identity);
  assert.notEqual(lockChangedKey, dependencyChangedKey);
  assert.notEqual(lockChangedKey, dependencyHash(fixture.sourceDir, { ...identity, abi: "128" }));
  assert.notEqual(lockChangedKey, dependencyHash(fixture.sourceDir, { ...identity, arch: "arm64" }));
  assert.notEqual(lockChangedKey, dependencyHash(fixture.sourceDir, { ...identity, platform: "linux" }));
});

test("bootstrap rejects Node older than 18 in its current process", () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion("18.0.0"));
  assert.throws(() => assertSupportedNodeVersion("17.9.1"), /Node\.js 18 or newer/);
  assert.throws(() => assertSupportedNodeVersion("unknown"), /Node\.js 18 or newer/);
});

windowsTest("launcher installs shared dependencies and the app in separate content-addressed directories", (t) => {
  const fixture = createFixture(t);
  const result = launch(fixture);

  assert.equal(result.status, 0, result.output);
  const [dependencyDir] = dependencyDirectories(fixture);
  assert.ok(dependencyDir);
  assert.equal(fs.existsSync(path.join(dependencyDir, ".ready")), true);
  assert.equal(fs.existsSync(path.join(dependencyDir, "node_modules", "fixture-dependency", "package.json")), true);
  const [appDir] = appDirectories(dependencyDir);
  assert.ok(appDir);
  assert.equal(fs.existsSync(path.join(appDir, ".ready")), true);
  assert.equal(fs.existsSync(path.join(appDir, "server.js")), true);
  assert.equal(fs.existsSync(path.join(appDir, "src", "version.js")), true);
  assert.match(result.output, new RegExp(`SERVER_SENTINEL=${appDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result.output, /DEPENDENCY_SENTINEL=fixture-dependency-ok/);
  assert.match(result.output, /APP_VERSION=one/);
  assert.match(result.output, /SOURCE_SENTINEL=.*read only source/);
  assert.equal(fs.existsSync(fixture.configFile), true);
  assert.equal(fs.existsSync(path.join(fixture.sourceDir, "config.json")), false);
  assert.equal(fs.existsSync(path.join(fixture.sourceDir, "node_modules")), false);

  const [npmRun] = npmRuns(fixture);
  assert.ok(npmRun);
  assert.ok(path.basename(npmRun.cwd).startsWith(".dependency-staging-"), npmRun.cwd);
  assert.deepEqual(npmRun.args, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline"]);
  assert.equal(npmRun.updateNotifier, "false");
  assert.equal(npmRun.cache, path.join(fixture.appHome, "npm-cache"));
});

windowsTest("launcher installs from a fully read-only Unicode source copy", (t) => {
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
  assert.equal(fs.readdirSync(fixture.runtimeRoot).some((name) => name.includes("staging")), false);
});

windowsTest("launcher treats a negative npm exit code as installation failure without partial caches", (t) => {
  const fixture = createFixture(t);
  fixture.env.LAUNCHER_TEST_EXIT = "-4048";
  const result = launch(fixture);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Dependency installation failed/i);
  assert.doesNotMatch(result.output, /\[Codex Remote\] Starting|SERVER_SENTINEL=/);
  assert.deepEqual(fs.readdirSync(fixture.runtimeRoot), []);
});

windowsTest("ready shared cache launches without npm on PATH", (t) => {
  const fixture = createFixture(t);
  const first = launch(fixture);
  assert.equal(first.status, 0, first.output);

  fixture.env.PATH = fixture.nodeOnlyPath;
  const second = launch(fixture);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /DEPENDENCY_SENTINEL=fixture-dependency-ok/);
  assert.equal(npmRuns(fixture).length, 1);
});

windowsTest("cold cache without npm fails with an explicit installation prerequisite", (t) => {
  const fixture = createFixture(t);
  fixture.env.PATH = fixture.nodeOnlyPath;
  const result = launch(fixture);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /npm.*(?:required|not found|install)/i);
  assert.doesNotMatch(result.output, /SERVER_SENTINEL=/);
});

windowsTest("source code updates create a new app while reusing shared dependencies", (t) => {
  const fixture = createFixture(t);
  const first = launch(fixture);
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /APP_VERSION=one/);

  fs.writeFileSync(path.join(fixture.sourceDir, "src", "version.js"), 'export default "two";\n');
  const second = launch(fixture);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /APP_VERSION=two/);

  const dependencies = dependencyDirectories(fixture);
  assert.equal(dependencies.length, 1);
  assert.equal(appDirectories(dependencies[0]).length, 2);
  assert.equal(npmRuns(fixture).length, 1);
});

windowsTest("launcher repairs tampered app code without reinstalling shared dependencies", (t) => {
  const fixture = createFixture(t);
  const first = launch(fixture);
  assert.equal(first.status, 0, first.output);

  const [dependencyDir] = dependencyDirectories(fixture);
  const [appDir] = appDirectories(dependencyDir);
  fs.writeFileSync(path.join(appDir, "server.js"), 'console.log("TAMPERED_APP_EXECUTED");');

  const second = launch(fixture);
  assert.equal(second.status, 0, second.output);
  assert.doesNotMatch(second.output, /TAMPERED_APP_EXECUTED/);
  assert.match(second.output, /DEPENDENCY_SENTINEL=fixture-dependency-ok/);
  assert.equal(npmRuns(fixture).length, 1);
});

windowsTest("missing direct dependency reinstalls the dependency cache exactly once", (t) => {
  const fixture = createFixture(t);
  const first = launch(fixture);
  assert.equal(first.status, 0, first.output);
  const [dependencyDir] = dependencyDirectories(fixture);
  fs.rmSync(path.join(dependencyDir, "node_modules", "fixture-dependency"), { recursive: true, force: true });

  const second = launch(fixture);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /DEPENDENCY_SENTINEL=fixture-dependency-ok/);
  assert.equal(npmRuns(fixture).length, 2);
  assert.equal(dependencyDirectories(fixture).length, 1);
});

windowsTest("invalid dependency marker reinstalls the dependency cache exactly once", (t) => {
  const fixture = createFixture(t);
  const first = launch(fixture);
  assert.equal(first.status, 0, first.output);
  const [dependencyDir] = dependencyDirectories(fixture);
  fs.writeFileSync(path.join(dependencyDir, ".ready"), '{"key":"wrong"}');

  const second = launch(fixture);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /DEPENDENCY_SENTINEL=fixture-dependency-ok/);
  assert.equal(npmRuns(fixture).length, 2);
});

windowsTest("concurrent cold launches serialize one shared dependency installation", async (t) => {
  const fixture = createFixture(t);
  fixture.env.LAUNCHER_TEST_DELAY_MS = "300";

  const results = await Promise.all([launchAsync(fixture), launchAsync(fixture)]);
  for (const result of results) {
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /DEPENDENCY_SENTINEL=fixture-dependency-ok/);
  }
  assert.equal(npmRuns(fixture).length, 1);
  const [dependencyDir] = dependencyDirectories(fixture);
  assert.ok(dependencyDir);
  assert.equal(appDirectories(dependencyDir).length, 1);
  assert.equal(fs.readdirSync(fixture.runtimeRoot).some((name) => name.startsWith(".")), false);
  assert.equal(fs.readdirSync(path.join(dependencyDir, "apps")).some((name) => name.startsWith(".")), false);
});

windowsTest("concurrent app repairs do not reinstall dependencies or leave partial apps", async (t) => {
  const fixture = createFixture(t);
  const first = launch(fixture);
  assert.equal(first.status, 0, first.output);
  const [dependencyDir] = dependencyDirectories(fixture);
  const [appDir] = appDirectories(dependencyDir);
  fs.writeFileSync(path.join(appDir, "server.js"), "// damaged app");

  const results = await Promise.all([launchAsync(fixture), launchAsync(fixture)]);
  for (const result of results) {
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /DEPENDENCY_SENTINEL=fixture-dependency-ok/);
  }
  assert.equal(npmRuns(fixture).length, 1);
  assert.deepEqual(appDirectories(dependencyDir), [appDir]);
  assert.equal(fs.readdirSync(path.join(dependencyDir, "apps")).some((name) => name.startsWith(".")), false);
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
