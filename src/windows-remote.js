import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveOptionalBinary } from "./optional-binary.js";

const CONTROL_ACTIONS = new Set([
  "ping", "click", "dblclick", "rclick", "move", "key", "type", "combo",
]);
const MAX_CONTROL_TEXT = 4_000;
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const MAX_SCREEN_DIMENSION = 100_000;

function runFile(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        if (stderr) error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function removeFile(filename) {
  try {
    await fs.promises.unlink(filename);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function validateJpeg(buffer) {
  if (!Buffer.isBuffer(buffer)
    || buffer.length < 4
    || buffer.length > MAX_CAPTURE_BYTES
    || buffer[0] !== 0xff
    || buffer[1] !== 0xd8
    || buffer[buffer.length - 2] !== 0xff
    || buffer[buffer.length - 1] !== 0xd9) {
    throw new Error("Screen capture did not produce a valid JPEG");
  }
  return buffer;
}

function errorSummary(error) {
  const message = error?.message || String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

export function clampRatio(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("control coordinates must be finite numbers");
  }
  return Math.min(1, Math.max(0, value));
}

export function controlArgs({ action = "ping", rx = 0, ry = 0, text = "", controlScript } = {}) {
  if (!CONTROL_ACTIONS.has(action)) throw new Error(`Unsupported control action: ${action}`);
  if (typeof controlScript !== "string" || !controlScript) {
    throw new TypeError("controlScript is required");
  }
  if (typeof text !== "string") throw new TypeError("control text must be a string");
  if (text.length > MAX_CONTROL_TEXT) throw new Error("control text is too long");
  return [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", controlScript,
    "-action", action,
    "-rx", String(clampRatio(rx)),
    "-ry", String(clampRatio(ry)),
    "-text", text,
  ];
}

export class WindowsRemote {
  constructor({
    projectDir,
    platform = process.platform,
    tempDir = os.tmpdir(),
    randomId = randomUUID,
    runFile: execute = runFile,
    now = Date.now,
    failureCooldownMs = 30_000,
  } = {}) {
    if (typeof projectDir !== "string" || !projectDir) {
      throw new TypeError("WindowsRemote requires projectDir");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (!Number.isFinite(failureCooldownMs) || failureCooldownMs < 0) {
      throw new TypeError("failureCooldownMs must be a non-negative number");
    }
    this.projectDir = path.resolve(projectDir);
    this.platform = platform;
    this.tempDir = path.resolve(tempDir);
    this.randomId = randomId;
    this.runFile = execute;
    this.now = now;
    this.failureCooldownMs = failureCooldownMs;
    this.ffmpeg = resolveOptionalBinary("ffmpeg.exe", { productRoot: this.projectDir });
    this.powershell = resolveOptionalBinary("powershell.exe", { productRoot: this.projectDir });
    this.controlScript = path.join(this.projectDir, "scripts", "control.ps1");
    this.screenshotScript = path.join(this.projectDir, "scripts", "screenshot.ps1");
    this.getresScript = path.join(this.projectDir, "scripts", "getres.ps1");
    this.captureBackend = null;
    this.blockedUntil = 0;
    this.lastCaptureError = null;
  }

  async capture() {
    this.#assertWindows();
    if (this.now() < this.blockedUntil) {
      const error = new Error("Screen capture is temporarily unavailable; retry after the safety cooldown");
      error.cause = this.lastCaptureError;
      throw error;
    }
    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const id = String(this.randomId());
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("invalid capture identifier");
    const output = path.join(this.tempDir, `codex-remote-${id}.jpg`);
    await removeFile(output);

    const backends = this.captureBackend === "powershell"
      ? ["powershell"]
      : ["ffmpeg", "powershell"];
    const failures = [];
    try {
      for (const backend of backends) {
        await removeFile(output);
        try {
          const image = backend === "ffmpeg"
            ? await this.#captureWithFfmpeg(output)
            : await this.#captureWithPowerShell(output);
          this.captureBackend = backend;
          this.blockedUntil = 0;
          this.lastCaptureError = null;
          return image;
        } catch (error) {
          failures.push(error);
        }
      }
      const details = failures.map(errorSummary).join(" | ");
      const combined = new AggregateError(
        failures,
        `Screen capture failed with the available backends${details ? `: ${details}` : ""}`,
      );
      this.lastCaptureError = combined;
      this.blockedUntil = this.now() + this.failureCooldownMs;
      throw combined;
    } finally {
      await removeFile(output);
    }
  }

  async #captureWithFfmpeg(output) {
    await this.runFile(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "gdigrab", "-framerate", "1", "-i", "desktop",
      "-frames:v", "1",
      "-vf", "scale=1280:-2:force_original_aspect_ratio=decrease",
      "-q:v", "5", output,
    ], { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return validateJpeg(await fs.promises.readFile(output));
  }

  async #physicalSize() {
    try {
      const result = await this.runFile(this.powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-File", this.getresScript,
      ], { timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 });
      const match = String(result?.stdout ?? "").trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) return { width: 0, height: 0 };
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (width < 1 || height < 1 || width > MAX_SCREEN_DIMENSION || height > MAX_SCREEN_DIMENSION) {
        return { width: 0, height: 0 };
      }
      return { width, height };
    } catch {
      return { width: 0, height: 0 };
    }
  }

  async #captureWithPowerShell(output) {
    const { width, height } = await this.#physicalSize();
    await this.runFile(this.powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", this.screenshotScript,
      "-pw", String(width), "-ph", String(height), "-out", output,
    ], { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return validateJpeg(await fs.promises.readFile(output));
  }

  async control(input = {}) {
    this.#assertWindows();
    const args = controlArgs({ ...input, controlScript: this.controlScript });
    await this.runFile(this.powershell, args, {
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true };
  }

  #assertWindows() {
    if (this.platform !== "win32") throw new Error("Desktop control is only available on Windows");
  }
}
