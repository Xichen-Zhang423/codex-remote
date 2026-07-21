import { spawn as nodeSpawn } from "node:child_process";
import { resolveCodexLaunch } from "./codex-process.js";

export function checkCodexLoginStatus({
  env = process.env, packageBin, platform = process.platform, spawnImpl = nodeSpawn,
  timeoutMs = 5_000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  return new Promise((resolve) => {
    const launch = resolveCodexLaunch({ env, packageBin, platform });
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl(launch.command, [...launch.argsPrefix, "login", "status"], {
        shell: false, stdio: "ignore", windowsHide: true,
      });
    } catch {
      resolve("unknown");
      return;
    }
    timer = setTimer(() => { child.kill?.(); finish("unknown"); }, timeoutMs);
    timer?.unref?.();
    child.once("error", () => finish("unknown"));
    child.once("close", (code) => finish(code === 0 ? "logged-in" : (code === 1 ? "logged-out" : "unknown")));
  });
}
