import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { openDesktopPanel } from "../src/desktop-panel.js";

function createChild() {
  const child = new EventEmitter();
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls += 1; };
  return child;
}

test("accepts only loopback HTTP URLs without userinfo", () => {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = createChild();
    calls.push({ file, args, options, child });
    return child;
  };

  const validUrls = [
    "http://127.0.0.1:8766/panel.html#panel=abc",
    "http://localhost:8766/",
    "http://[::1]:8766/",
  ];
  for (const url of validUrls) {
    const result = openDesktopPanel(url, {
      platform: "win32",
      env: {},
      existsSync: () => false,
      spawnImpl,
    });
    assert.equal(result.opened, true);
  }

  const invalidUrls = [
    "https://localhost:8766/",
    "http://user@localhost:8766/",
    "http://:secret@localhost:8766/",
    "http://@localhost:8766/",
    "http://:@localhost:8766/",
    "http://example.com:8766/",
    "file://127.0.0.1/panel.html",
    "not a URL",
  ];
  for (const url of invalidUrls) {
    const before = calls.length;
    const result = openDesktopPanel(url, {
      platform: "win32",
      env: {},
      existsSync: () => false,
      spawnImpl,
    });
    assert.equal(result.opened, false);
    assert.equal(calls.length, before);
  }

  assert.equal(calls.length, validUrls.length);
  for (let index = 0; index < calls.length; index += 1) {
    assert.equal(calls[index].file, "explorer.exe");
    assert.deepEqual(calls[index].args, [validUrls[index]]);
    assert.deepEqual(calls[index].options, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    assert.equal(calls[index].child.unrefCalls, 1);
  }
});

test("does not open the panel outside Windows", () => {
  let spawnCalls = 0;
  const result = openDesktopPanel("http://localhost:8766/", {
    platform: "linux",
    env: {},
    existsSync: () => false,
    spawnImpl: () => { spawnCalls += 1; return createChild(); },
  });
  assert.equal(result.opened, false);
  assert.equal(spawnCalls, 0);
});

test("honors the documented NO_PANEL truthy values", () => {
  let spawnCalls = 0;
  for (const value of ["1", "true", "on", "yes", " TRUE ", "Yes"]) {
    const result = openDesktopPanel("http://127.0.0.1:8766/", {
      platform: "win32",
      env: { NO_PANEL: value },
      existsSync: () => false,
      spawnImpl: () => { spawnCalls += 1; return createChild(); },
    });
    assert.equal(result.opened, false);
  }
  assert.equal(spawnCalls, 0);
});

test("uses the first installed browser in the documented Windows order", () => {
  const env = {
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  };
  const candidates = [
    path.win32.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    path.win32.join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.win32.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.win32.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    path.win32.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ];
  const url = "http://localhost:8766/panel.html#panel=secret";

  for (let selected = 0; selected < candidates.length; selected += 1) {
    const checked = [];
    const calls = [];
    const result = openDesktopPanel(url, {
      platform: "win32",
      env,
      existsSync(candidate) {
        checked.push(candidate);
        return candidate === candidates[selected];
      },
      spawnImpl(file, args, options) {
        const child = createChild();
        calls.push({ file, args, options, child });
        return child;
      },
    });

    assert.equal(result.opened, true);
    assert.deepEqual(checked, candidates.slice(0, selected + 1));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, candidates[selected]);
    assert.deepEqual(calls[0].args, [
      `--app=${url}`,
      "--window-size=1120,820",
    ]);
    assert.deepEqual(calls[0].options, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    assert.equal(calls[0].child.unrefCalls, 1);
  }
});

test("reports a synchronous spawn failure without throwing", () => {
  const failure = new Error("spawn failed");
  const errors = [];
  const result = openDesktopPanel("http://127.0.0.1:8766/", {
    platform: "win32",
    env: {},
    existsSync: () => false,
    spawnImpl: () => { throw failure; },
    onError: (error) => { errors.push(error); },
  });
  assert.equal(result.opened, false);
  assert.deepEqual(errors, [failure]);
});

test("forwards asynchronous child errors to onError", () => {
  const child = createChild();
  const errors = [];
  const result = openDesktopPanel("http://localhost:8766/", {
    platform: "win32",
    env: {},
    existsSync: () => false,
    spawnImpl: () => child,
    onError: (error) => { errors.push(error); },
  });
  const failure = new Error("late failure");
  child.emit("error", failure);
  assert.equal(result.opened, true);
  assert.deepEqual(errors, [failure]);
});
