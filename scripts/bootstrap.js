import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT_FILES = ["package.json", "server.js"];
const APP_DIRECTORIES = ["src"];
const DEPENDENCY_SCHEMA = "codex-remote-dependencies-v2";
const APP_SCHEMA = "codex-remote-app-v2";
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const LOCK_TIMEOUT_MS = 10 * 60 * 1_000;
const LOCK_STALE_MS = 30 * 60 * 1_000;

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function walkFiles(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported runtime source entry: ${absolute}`);
  }
  return files;
}

function copyWritableFile(source, target) {
  if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
}

function updateFileHash(hash, baseDir, relative) {
  const absolute = path.join(baseDir, relative);
  hash.update(`${relative}\0`);
  if (fs.existsSync(absolute)) hash.update(fs.readFileSync(absolute));
  else hash.update("<missing>");
  hash.update("\0");
}

function readManifest(sourceDir) {
  return JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
}

function normalizedDependencies(manifest) {
  return Object.fromEntries(Object.entries(manifest.dependencies || {}).sort(([left], [right]) => left.localeCompare(right)));
}

function runtimeIdentity(identity = {}) {
  return {
    platform: identity.platform || process.platform,
    arch: identity.arch || process.arch,
    abi: String(identity.abi || process.versions.modules || "unknown"),
  };
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number(String(version || "").split(".")[0]);
  if (!Number.isInteger(major) || major < 18) {
    throw new Error(`Node.js ${version || "unknown"} is too old. Codex Remote requires Node.js 18 or newer.`);
  }
}

export function resolveAppHome(env = process.env) {
  const local = env.LOCALAPPDATA?.trim();
  return local ? path.resolve(local, "CodexRemote") : path.resolve(os.homedir(), ".codex-remote");
}

export function appHash(sourceDir) {
  const hash = createHash("sha256");
  hash.update(`${APP_SCHEMA}\0`);
  for (const relative of APP_ROOT_FILES) updateFileHash(hash, sourceDir, relative);
  for (const directory of APP_DIRECTORIES) {
    const absolute = path.join(sourceDir, directory);
    for (const nested of walkFiles(absolute)) {
      updateFileHash(hash, sourceDir, path.join(directory, nested));
    }
  }
  return hash.digest("hex").slice(0, 24);
}

export const runtimeHash = appHash;

export function dependencyHash(sourceDir, identity = {}) {
  const hash = createHash("sha256");
  const resolvedIdentity = runtimeIdentity(identity);
  hash.update(`${DEPENDENCY_SCHEMA}\0`);
  updateFileHash(hash, sourceDir, "package-lock.json");
  hash.update(`${JSON.stringify(normalizedDependencies(readManifest(sourceDir)))}\0`);
  hash.update(`${resolvedIdentity.platform}\0${resolvedIdentity.arch}\0${resolvedIdentity.abi}\0`);
  return hash.digest("hex").slice(0, 24);
}

function copyAppSource(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const relative of APP_ROOT_FILES) {
    copyWritableFile(path.join(sourceDir, relative), path.join(targetDir, relative));
  }
  for (const directory of APP_DIRECTORIES) {
    const sourceDirectory = path.join(sourceDir, directory);
    fs.mkdirSync(path.join(targetDir, directory), { recursive: true });
    for (const nestedPath of walkFiles(sourceDirectory)) {
      const targetPath = path.join(targetDir, directory, nestedPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      copyWritableFile(path.join(sourceDirectory, nestedPath), targetPath);
    }
  }
}

function copyDependencySource(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  copyWritableFile(path.join(sourceDir, "package.json"), path.join(targetDir, "package.json"));
  const sourceLock = path.join(sourceDir, "package-lock.json");
  if (fs.existsSync(sourceLock)) copyWritableFile(sourceLock, path.join(targetDir, "package-lock.json"));
}

function dependenciesPresent(dependencyDir, dependencyNames) {
  try {
    return dependencyNames.every((name) => {
      const manifestPath = path.join(dependencyDir, "node_modules", ...name.split("/"), "package.json");
      const installed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return installed.name === name;
    });
  } catch {
    return false;
  }
}

function dependencyReady(dependencyDir, expectedKey, identity, dependencyNames) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dependencyDir, ".ready"), "utf8"));
    return marker.schema === DEPENDENCY_SCHEMA
      && marker.key === expectedKey
      && dependencyHash(dependencyDir, identity) === expectedKey
      && dependenciesPresent(dependencyDir, dependencyNames);
  } catch {
    return false;
  }
}

function appReady(appDir, expectedKey) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(appDir, ".ready"), "utf8"));
    return marker.schema === APP_SCHEMA
      && marker.key === expectedKey
      && appHash(appDir) === expectedKey;
  } catch {
    return false;
  }
}

function lockSupportsCi(directory) {
  const lockFile = path.join(directory, "package-lock.json");
  if (!fs.existsSync(lockFile)) return false;
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return Number.isInteger(lock.lockfileVersion) && lock.lockfileVersion >= 1;
  } catch {
    return false;
  }
}

function npmAvailable(env) {
  if (process.platform === "win32") {
    const result = spawnSync(env.ComSpec || process.env.ComSpec || "cmd.exe", [
      "/d", "/s", "/c", "where npm >nul 2>&1",
    ], { env, stdio: "ignore" });
    return !result.error && result.status === 0;
  }
  const result = spawnSync("npm", ["--version"], { env, stdio: "ignore" });
  return !result.error && result.status === 0;
}

function runNpm(command, dependencyDir, env) {
  const args = [command, "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline"];
  if (process.platform === "win32") {
    return spawnSync(env.ComSpec || process.env.ComSpec || "cmd.exe", [
      "/d", "/s", "/c", `call npm ${args.join(" ")}`,
    ], { cwd: dependencyDir, env, stdio: "inherit" });
  }
  return spawnSync("npm", args, { cwd: dependencyDir, env, stdio: "inherit" });
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function lockIsStale(lockDir) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    return Date.now() - Number(owner.createdAt) > LOCK_STALE_MS || !processExists(Number(owner.pid));
  } catch {
    try {
      return Date.now() - fs.statSync(lockDir).mtimeMs > 5_000;
    } catch {
      return false;
    }
  }
}

function acquireCacheLock(parentDir, name) {
  fs.mkdirSync(parentDir, { recursive: true });
  const lockDir = path.join(parentDir, `.lock-${name}`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const nonce = randomBytes(8).toString("hex");
  let announced = false;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
          nonce,
        }));
      } catch (error) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
          if (owner.nonce === nonce) fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // A stale-lock recovery may already have removed our lock.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (lockIsStale(lockDir)) {
      const stale = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        fs.renameSync(lockDir, stale);
        fs.rmSync(stale, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for another launcher to prepare this cache.");
    if (!announced) {
      console.log("[Codex Remote] Another launcher is preparing this version. Waiting...");
      announced = true;
    }
    Atomics.wait(LOCK_WAIT, 0, 0, 50);
  }
}

function restoreDependencyMetadata(sourceDir, dependencyDir) {
  copyWritableFile(path.join(sourceDir, "package.json"), path.join(dependencyDir, "package.json"));
  const sourceLock = path.join(sourceDir, "package-lock.json");
  const dependencyLock = path.join(dependencyDir, "package-lock.json");
  if (fs.existsSync(sourceLock)) copyWritableFile(sourceLock, dependencyLock);
  else fs.rmSync(dependencyLock, { force: true });
}

function promoteCache(staging, target, isReady) {
  if (isReady(target)) return;

  let displaced = "";
  if (fs.existsSync(target)) {
    displaced = `${target}.invalid-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      fs.renameSync(target, displaced);
    } catch (error) {
      if (isReady(target)) return;
      throw error;
    }
  }

  try {
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (!isReady(target)) {
        if (displaced && !fs.existsSync(target)) {
          try {
            fs.renameSync(displaced, target);
            displaced = "";
          } catch {
            // Preserve the original promotion error below.
          }
        }
        throw error;
      }
    }
  } finally {
    if (displaced && fs.existsSync(displaced)) {
      fs.rmSync(displaced, { recursive: true, force: true });
    }
  }
}

function installDependencies({ sourceDir, runtimeRoot, dependencyDir, appHome, key, identity, dependencies, env }) {
  const dependencyNames = Object.keys(dependencies);
  const isReady = (directory) => dependencyReady(directory, key, identity, dependencyNames);
  if (isReady(dependencyDir)) return dependencyDir;

  const releaseLock = acquireCacheLock(runtimeRoot, `dependency-${key}`);
  try {
    if (isReady(dependencyDir)) return dependencyDir;
    const staging = path.join(runtimeRoot, `.dependency-staging-${key}-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      copyDependencySource(sourceDir, staging);
      const useCi = lockSupportsCi(staging);
      if (!npmAvailable(env)) {
        throw new Error("npm is required to install Codex Remote dependencies but was not found on PATH.");
      }
      console.log("[Codex Remote] Installing project dependencies. This normally happens only once...");
      if (!useCi) console.warn("[WARN] Invalid or missing package-lock.json. Rebuilding it with npm install...");
      const result = runNpm(useCi ? "ci" : "install", staging, {
        ...env,
        npm_config_cache: path.join(appHome, "npm-cache"),
        npm_config_update_notifier: "false",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Dependency installation failed: npm exited with code ${result.status ?? "unknown"}.`);
      }
      restoreDependencyMetadata(sourceDir, staging);
      if (!dependenciesPresent(staging, dependencyNames)) {
        throw new Error("Dependency installation failed: required packages are missing after npm completed.");
      }
      fs.writeFileSync(path.join(staging, ".ready"), JSON.stringify({
        schema: DEPENDENCY_SCHEMA,
        key,
        installedAt: new Date().toISOString(),
      }));
      promoteCache(staging, dependencyDir, isReady);
      if (!isReady(dependencyDir)) {
        throw new Error(`Dependency installation failed its integrity check for cache ${key}.`);
      }
      return dependencyDir;
    } finally {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    releaseLock();
  }
}

function installApp({ sourceDir, dependencyDir, appDir, key }) {
  if (appReady(appDir, key)) return appDir;

  const appsRoot = path.join(dependencyDir, "apps");
  const releaseLock = acquireCacheLock(appsRoot, `app-${key}`);
  try {
    if (appReady(appDir, key)) return appDir;
    const staging = path.join(appsRoot, `.app-staging-${key}-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      copyAppSource(sourceDir, staging);
      fs.writeFileSync(path.join(staging, ".ready"), JSON.stringify({
        schema: APP_SCHEMA,
        key,
        installedAt: new Date().toISOString(),
      }));
      promoteCache(staging, appDir, (directory) => appReady(directory, key));
      if (!appReady(appDir, key)) {
        throw new Error(`Application snapshot failed its integrity check for cache ${key}.`);
      }
      return appDir;
    } finally {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    releaseLock();
  }
}

function migrateConfig(sourceDir, configFile) {
  if (fs.existsSync(configFile)) return;
  const legacy = path.join(sourceDir, "config.json");
  if (!fs.existsSync(legacy)) return;
  try {
    fs.copyFileSync(legacy, configFile, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

export function prepareRuntime({ sourceDir, env = process.env, identity = {} } = {}) {
  assertSupportedNodeVersion();
  const source = path.resolve(sourceDir || ".");
  const appHome = resolveAppHome(env);
  const runtimeRoot = path.join(appHome, "runtime");
  if (isInside(source, appHome) || isInside(appHome, source)) {
    throw new Error("Source and user runtime directories must be separate.");
  }
  for (const relative of [...APP_ROOT_FILES, ...APP_DIRECTORIES]) {
    if (!fs.existsSync(path.join(source, relative))) throw new Error(`Missing runtime source: ${relative}`);
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const configFile = path.join(appHome, "config.json");
  migrateConfig(source, configFile);

  const resolvedIdentity = runtimeIdentity(identity);
  const dependencyKey = dependencyHash(source, resolvedIdentity);
  const appKey = appHash(source);
  const dependencyDir = path.join(runtimeRoot, dependencyKey);
  const appDir = path.join(dependencyDir, "apps", appKey);
  const dependencies = normalizedDependencies(readManifest(source));
  installDependencies({
    sourceDir: source,
    runtimeRoot,
    dependencyDir,
    appHome,
    key: dependencyKey,
    identity: resolvedIdentity,
    dependencies,
    env,
  });
  installApp({ sourceDir: source, dependencyDir, appDir, key: appKey });
  return {
    sourceDir: source,
    appHome,
    configFile,
    runtimeDir: appDir,
    appDir,
    appKey,
    dependencyDir,
    dependencyKey,
  };
}

export function run({ sourceDir, env = process.env } = {}) {
  const prepared = prepareRuntime({ sourceDir, env });
  const childEnv = {
    ...env,
    CODEX_REMOTE_CONFIG: prepared.configFile,
    CODEX_REMOTE_SOURCE_DIR: prepared.sourceDir,
    PATH: [prepared.sourceDir, env.PATH || ""].filter(Boolean).join(path.delimiter),
  };
  console.log("[Codex Remote] Starting...");
  const result = spawnSync(process.execPath, [path.join(prepared.runtimeDir, "server.js")], {
    cwd: prepared.runtimeDir,
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status === 0 ? 0 : 1;
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  try {
    process.exitCode = run({ sourceDir: process.argv[2] });
  } catch (error) {
    console.error(`[ERROR] ${error?.message || error}`);
    process.exitCode = 1;
  }
}
