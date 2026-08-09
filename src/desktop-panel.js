import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const SPAWN_OPTIONS = Object.freeze({
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  shell: false,
});
const NO_PANEL_TRUTHY = new Set(["1", "true", "on", "yes"]);

function isLoopbackHttpUrl(value) {
  if (typeof value !== "string") return false;
  if (/^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(value.trim())) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:"
    && parsed.username === ""
    && parsed.password === ""
    && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
}

function browserCandidates(env) {
  const candidates = [];
  const add = (root, ...segments) => {
    if (typeof root === "string" && root.trim() !== "") {
      candidates.push(path.win32.join(root, ...segments));
    }
  };
  add(env?.["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe");
  add(env?.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe");
  add(env?.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe");
  add(env?.["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe");
  add(env?.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
  return candidates;
}

export function openDesktopPanel(url, {
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
  spawnImpl = spawn,
  onError = () => {},
} = {}) {
  if (!isLoopbackHttpUrl(url)) return { opened: false };
  if (platform !== "win32") return { opened: false };
  if (NO_PANEL_TRUTHY.has(String(env?.NO_PANEL ?? "").trim().toLowerCase())) {
    return { opened: false };
  }

  let browser = null;
  for (const candidate of browserCandidates(env)) {
    if (existsSync(candidate)) {
      browser = candidate;
      break;
    }
  }
  const file = browser ?? "explorer.exe";
  const args = browser
    ? [`--app=${url}`, "--window-size=1120,820"]
    : [url];
  let child;
  try {
    child = spawnImpl(file, args, SPAWN_OPTIONS);
  } catch (error) {
    onError(error);
    return { opened: false };
  }
  child.once("error", onError);
  child.unref();
  return { opened: true };
}
