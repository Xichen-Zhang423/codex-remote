import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = ["package.json", "server.js"];
const HASH_FILES = [...ROOT_FILES, "package-lock.json"];
const CODE_DIRECTORIES = ["src"];
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

export function resolveAppHome(env = process.env) {
  const local = env.LOCALAPPDATA?.trim();
  return local ? path.resolve(local, "CodexRemote") : path.resolve(os.homedir(), ".codex-remote");
}

export function runtimeHash(sourceDir) {
  const hash = createHash("sha256");
  hash.update("codex-remote-runtime-v1\0");
  for (const relative of HASH_FILES) {
    const absolute = path.join(sourceDir, relative);
    hash.update(`${relative}\0`);
    if (fs.existsSync(absolute)) hash.update(fs.readFileSync(absolute));
    else hash.update("<missing>");
    hash.update("\0");
  }
  for (const directory of CODE_DIRECTORIES) {
    const absolute = path.join(sourceDir, directory);
    for (const nested of walkFiles(absolute)) {
      hash.update(`${path.join(directory, nested)}\0`);
      hash.update(fs.readFileSync(path.join(absolute, nested)));
      hash.update("\0");
    }
  }
  return hash.digest("hex").slice(0, 24);
}

function copyRuntimeSource(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const relative of ROOT_FILES) {
    copyWritableFile(path.join(sourceDir, relative), path.join(targetDir, relative));
  }
  const sourceLock = path.join(sourceDir, "package-lock.json");
  if (fs.existsSync(sourceLock)) copyWritableFile(sourceLock, path.join(targetDir, "package-lock.json"));
  for (const directory of CODE_DIRECTORIES) {
    fs.cpSync(path.join(sourceDir, directory), path.join(targetDir, directory), {
      recursive: true,
      force: true,
    });
  }
}

function dependenciesPresent(runtimeDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8"));
    return Object.keys(manifest.dependencies || {}).every((name) => (
      fs.existsSync(path.join(runtimeDir, "node_modules", ...name.split("/"), "package.json"))
    ));
  } catch {
    return false;
  }
}

function runtimeReady(runtimeDir, expectedHash) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(runtimeDir, ".ready"), "utf8"));
    return marker.hash === expectedHash
      && runtimeHash(runtimeDir) === expectedHash
      && dependenciesPresent(runtimeDir);
  } catch {
    return false;
  }
}

function lockSupportsCi(runtimeDir) {
  const lockFile = path.join(runtimeDir, "package-lock.json");
  if (!fs.existsSync(lockFile)) return false;
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return Number.isInteger(lock.lockfileVersion) && lock.lockfileVersion >= 1;
  } catch {
    return false;
  }
}

function runNpm(command, runtimeDir, env) {
  const args = [command, "--omit=dev", "--no-audit", "--no-fund"];
  if (process.platform === "win32") {
    return spawnSync(env.ComSpec || process.env.ComSpec || "cmd.exe", [
      "/d", "/s", "/c", `call npm ${args.join(" ")}`,
    ], { cwd: runtimeDir, env, stdio: "inherit" });
  }
  return spawnSync("npm", args, { cwd: runtimeDir, env, stdio: "inherit" });
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

function acquireRuntimeLock(runtimeRoot, hash) {
  const lockDir = path.join(runtimeRoot, `.lock-${hash}`);
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
    if (Date.now() >= deadline) throw new Error("Timed out waiting for another launcher to prepare this runtime.");
    if (!announced) {
      console.log("[Codex Remote] Another launcher is preparing this version. Waiting...");
      announced = true;
    }
    Atomics.wait(LOCK_WAIT, 0, 0, 50);
  }
}

function restoreSourceLock(sourceDir, runtimeDir) {
  const sourceLock = path.join(sourceDir, "package-lock.json");
  const runtimeLock = path.join(runtimeDir, "package-lock.json");
  if (fs.existsSync(sourceLock)) copyWritableFile(sourceLock, runtimeLock);
  else fs.rmSync(runtimeLock, { force: true });
}

function promoteRuntime(staging, runtimeDir, hash) {
  if (runtimeReady(runtimeDir, hash)) return;

  let displaced = "";
  if (fs.existsSync(runtimeDir)) {
    displaced = `${runtimeDir}.invalid-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      fs.renameSync(runtimeDir, displaced);
    } catch (error) {
      if (runtimeReady(runtimeDir, hash)) return;
      throw error;
    }

    // Another launcher may have repaired the runtime after our first check.
    if (runtimeReady(displaced, hash)) {
      try {
        fs.renameSync(displaced, runtimeDir);
        displaced = "";
      } catch (error) {
        if (!runtimeReady(runtimeDir, hash)) throw error;
      }
      return;
    }
  }

  try {
    try {
      fs.renameSync(staging, runtimeDir);
    } catch (error) {
      if (!runtimeReady(runtimeDir, hash)) {
        if (displaced && !fs.existsSync(runtimeDir)) {
          try {
            fs.renameSync(displaced, runtimeDir);
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

function installRuntime({ sourceDir, runtimeRoot, runtimeDir, appHome, hash, env }) {
  if (runtimeReady(runtimeDir, hash)) return runtimeDir;
  const releaseLock = acquireRuntimeLock(runtimeRoot, hash);
  try {
    if (runtimeReady(runtimeDir, hash)) return runtimeDir;
    const staging = path.join(runtimeRoot, `.staging-${hash}-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      copyRuntimeSource(sourceDir, staging);
      const useCi = lockSupportsCi(staging);
      console.log("[Codex Remote] Installing project dependencies. This normally happens only once...");
      if (!useCi) console.warn("[WARN] Invalid or missing package-lock.json. Rebuilding it with npm install...");
      const result = runNpm(useCi ? "ci" : "install", staging, {
        ...env,
        npm_config_cache: path.join(appHome, "npm-cache"),
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Dependency installation failed: npm exited with code ${result.status ?? "unknown"}.`);
      }
      if (!dependenciesPresent(staging)) {
        throw new Error("Dependency installation failed: required packages are missing after npm completed.");
      }
      restoreSourceLock(sourceDir, staging);
      fs.writeFileSync(path.join(staging, ".ready"), JSON.stringify({ hash, installedAt: new Date().toISOString() }));
      promoteRuntime(staging, runtimeDir, hash);
      if (!runtimeReady(runtimeDir, hash)) throw new Error("Runtime installation failed its integrity check.");
      return runtimeDir;
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

export function prepareRuntime({ sourceDir, env = process.env } = {}) {
  const source = path.resolve(sourceDir || ".");
  const appHome = resolveAppHome(env);
  const runtimeRoot = path.join(appHome, "runtime");
  if (isInside(source, appHome) || isInside(appHome, source)) {
    throw new Error("Source and user runtime directories must be separate.");
  }
  for (const relative of [...ROOT_FILES, ...CODE_DIRECTORIES]) {
    if (!fs.existsSync(path.join(source, relative))) throw new Error(`Missing runtime source: ${relative}`);
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const configFile = path.join(appHome, "config.json");
  migrateConfig(source, configFile);
  const hash = runtimeHash(source);
  const runtimeDir = path.join(runtimeRoot, hash);
  installRuntime({ sourceDir: source, runtimeRoot, runtimeDir, appHome, hash, env });
  return { sourceDir: source, appHome, configFile, runtimeDir };
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
