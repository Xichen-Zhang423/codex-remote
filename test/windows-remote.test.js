import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WindowsRemote,
  clampRatio,
  controlArgs,
} from "../src/windows-remote.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0xff, 0xd9]);

test("control arguments clamp ratios and keep text as one literal argument", () => {
  assert.equal(clampRatio(-4), 0);
  assert.equal(clampRatio(0.25), 0.25);
  assert.equal(clampRatio(7), 1);
  const args = controlArgs({
    action: "type", rx: -1, ry: 2, text: "hello; $(unsafe)", controlScript: "C:\\remote\\control.ps1",
  });
  assert.deepEqual(args.slice(-8), [
    "-action", "type", "-rx", "0", "-ry", "1", "-text", "hello; $(unsafe)",
  ]);
  assert.throws(() => controlArgs({ action: "shell", controlScript: "control.ps1" }), /Unsupported control action/);
});

test("capture uses ffmpeg first, validates JPEG, and always removes the fresh file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-capture-"));
  const calls = [];
  try {
    const remote = new WindowsRemote({
      projectDir: "C:\\codex-remote",
      platform: "win32",
      tempDir: dir,
      randomId: () => "capture-one",
      runFile: async (file, args, options) => {
        calls.push({ file, args, options });
        const output = args.at(-1);
        fs.writeFileSync(output, JPEG);
      },
    });
    const image = await remote.capture();
    assert.deepEqual(image, JPEG);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, remote.ffmpeg);
    assert.equal(calls[0].options.timeout, 15_000);
    assert.equal(fs.existsSync(path.join(dir, "codex-remote-capture-one.jpg")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capture removes a partial ffmpeg file before PowerShell fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-fallback-"));
  const calls = [];
  try {
    const remote = new WindowsRemote({
      projectDir: "C:\\codex-remote",
      platform: "win32",
      tempDir: dir,
      randomId: () => "capture-two",
      runFile: async (file, args) => {
        calls.push({ file, args });
        if (file === remote.ffmpeg) {
          const output = args.at(-1);
          fs.writeFileSync(output, "partial");
          throw new Error("ffmpeg failed");
        }
        if (args.some((entry) => String(entry).endsWith("getres.ps1"))) {
          return { stdout: "2560 1440\r\n", stderr: "" };
        }
        const output = args[args.indexOf("-out") + 1];
        assert.equal(fs.existsSync(output), false);
        fs.writeFileSync(output, JPEG);
        return { stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(await remote.capture(), JPEG);
    assert.deepEqual(calls.map(({ file }) => file), [
      remote.ffmpeg, remote.powershell, remote.powershell,
    ]);
    const screenshot = calls[2].args;
    assert.equal(screenshot[screenshot.indexOf("-pw") + 1], "2560");
    assert.equal(screenshot[screenshot.indexOf("-ph") + 1], "1440");
    assert.deepEqual(await remote.capture(), JPEG);
    assert.deepEqual(calls.map(({ file }) => file), [
      remote.ffmpeg, remote.powershell, remote.powershell, remote.powershell, remote.powershell,
    ]);
    assert.equal(fs.existsSync(path.join(dir, "codex-remote-capture-two.jpg")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capture rejects unsupported platforms and invalid output", async () => {
  const remote = new WindowsRemote({ projectDir: ".", platform: "linux" });
  await assert.rejects(remote.capture(), /only available on Windows/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-invalid-"));
  try {
    const invalid = new WindowsRemote({
      projectDir: ".", platform: "win32", tempDir: dir, randomId: () => "bad",
      runFile: async (_file, args) => {
        if (args.some((entry) => String(entry).endsWith("getres.ps1"))) {
          return { stdout: "0 0", stderr: "" };
        }
        const output = args.includes("-out") ? args[args.indexOf("-out") + 1] : args.at(-1);
        fs.writeFileSync(output, "not jpeg");
      },
    });
    await assert.rejects(invalid.capture(), /Screen capture failed/);
    assert.equal(fs.existsSync(path.join(dir, "codex-remote-bad.jpg")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capture preserves both backend failures and cools down before retrying", async () => {
  let now = 1_000;
  let calls = 0;
  const remote = new WindowsRemote({
    projectDir: ".",
    platform: "win32",
    randomId: () => "failure",
    now: () => now,
    failureCooldownMs: 30_000,
    runFile: async () => {
      calls += 1;
      throw new Error(`backend-${calls}`);
    },
  });
  await assert.rejects(remote.capture(), (error) => {
    assert.match(error.message, /Screen capture failed/);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /backend-1/);
    assert.match(error.errors[1].message, /backend-3/);
    return true;
  });
  assert.equal(calls, 3);
  await assert.rejects(remote.capture(), /temporarily unavailable/);
  assert.equal(calls, 3);
  now += 30_001;
  await assert.rejects(remote.capture(), /Screen capture failed/);
  assert.equal(calls, 6);
});

test("control invokes the owned script with a timeout and bounded input", async () => {
  const calls = [];
  const remote = new WindowsRemote({
    projectDir: "C:\\codex-remote", platform: "win32",
    runFile: async (file, args, options) => calls.push({ file, args, options }),
  });
  assert.deepEqual(await remote.control({ action: "click", rx: -9, ry: 9 }), { ok: true });
  assert.equal(calls[0].file, "powershell.exe");
  assert.equal(calls[0].options.timeout, 8_000);
  assert.equal(calls[0].args[calls[0].args.indexOf("-rx") + 1], "0");
  assert.equal(calls[0].args[calls[0].args.indexOf("-ry") + 1], "1");
  await assert.rejects(remote.control({ action: "type", text: "x".repeat(4_001) }), /too long/);
});
