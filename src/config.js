import fs from "node:fs";
import os from "node:os";
import { randomBytes } from "node:crypto";

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return port;
}

function optionalString(value, name, { max = 4_096 } = {}) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const clean = value.trim();
  if (clean.length > max) throw new Error(`${name} is too long`);
  return clean;
}

function rendezvousUrl(value) {
  const clean = optionalString(value, "rendezvous URL", { max: 2_048 });
  if (!clean) return "";
  let parsed;
  try { parsed = new URL(clean); } catch { throw new Error("rendezvous URL is invalid"); }
  if (parsed.protocol !== "https:") throw new Error("rendezvous URL must use https");
  if (parsed.username || parsed.password) throw new Error("rendezvous URL must not contain credentials");
  return clean.replace(/\/+$/, "");
}

function deviceId(value) {
  const clean = optionalString(value, "device ID", { max: 64 });
  if (!clean) return randomBytes(16).toString("hex");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clean)) {
    throw new Error("device ID must use 8-64 letters, digits, underscores, or hyphens");
  }
  return clean;
}

function publishNewFile(file, contents) {
  const temporary = `${file}.new-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    try {
      // Linking publishes a fully written file atomically and fails if another
      // first-run process already published the destination.
      fs.linkSync(temporary, file);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function replaceFile(file, contents) {
  try {
    if (fs.readFileSync(file, "utf8") === contents) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${file}.replace-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      let concurrentMatch = false;
      if (["EPERM", "EACCES", "EEXIST"].includes(error?.code)) {
        try { concurrentMatch = fs.readFileSync(file, "utf8") === contents; } catch {}
      }
      if (!concurrentMatch) throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function loadConfig({ file, env = process.env, read, write = true, warn = console.warn } = {}) {
  let missing = false;
  const readJson = read || (() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") missing = true;
      if (error?.code !== "ENOENT") warn(`Could not parse config file: ${error.message}`);
      return {};
    }
  });
  const saved = readJson() || {};
  const savedRendezvous = saved.rendezvous && typeof saved.rendezvous === "object"
    && !Array.isArray(saved.rendezvous) ? saved.rendezvous : {};
  const persistedRendezvous = {
    url: rendezvousUrl(savedRendezvous.url ?? ""),
    secret: optionalString(savedRendezvous.secret ?? "", "rendezvous secret", { max: 4_096 }),
    deviceId: deviceId(savedRendezvous.deviceId ?? ""),
  };
  const persisted = {
    port: parsePort(saved.port ?? 8766),
    token: saved.token || randomBytes(16).toString("hex"),
    cwd: saved.cwd || os.homedir(),
    model: saved.model || null,
    effort: saved.effort || null,
    rendezvous: persistedRendezvous,
  };
  if (typeof persisted.token !== "string" || persisted.token.length < 8) {
    throw new Error("remote token must contain at least 8 characters");
  }

  const rendezvous = {
    url: rendezvousUrl(env.CODEX_REMOTE_RENDEZVOUS_URL ?? persistedRendezvous.url),
    secret: optionalString(
      env.CODEX_REMOTE_RENDEZVOUS_SECRET ?? persistedRendezvous.secret,
      "rendezvous secret",
      { max: 4_096 },
    ),
    deviceId: deviceId(env.CODEX_REMOTE_DEVICE_ID ?? persistedRendezvous.deviceId),
  };
  const runtime = {
    port: parsePort(env.CODEX_REMOTE_PORT ?? persisted.port),
    token: env.CODEX_REMOTE_TOKEN || persisted.token,
    cwd: env.CODEX_CWD || persisted.cwd,
    model: env.CODEX_MODEL || persisted.model,
    effort: env.CODEX_EFFORT || persisted.effort,
    rendezvous,
  };
  if (typeof runtime.token !== "string" || runtime.token.length < 8) {
    throw new Error("remote token must contain at least 8 characters");
  }
  if (write && file) {
    const serialized = JSON.stringify(persisted, null, 2);
    if (missing && !publishNewFile(file, serialized)) {
      return loadConfig({ file, env, write, warn });
    }
    if (!missing) replaceFile(file, serialized);
  }
  return { ...runtime, sessionAutoApprove: false, persisted };
}
