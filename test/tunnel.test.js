import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  TunnelManager, buildPhoneUrl, buildRendezvousReadUrl, extractTunnelUrl,
} from "../src/tunnel.js";
import rendezvousWorker from "../cloudflare-worker/rendezvous.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); return true; };
  return child;
}

test("buildPhoneUrl adds the token without changing the published base URL", () => {
  assert.equal(buildPhoneUrl("https://abc.trycloudflare.com/", "a b"), "https://abc.trycloudflare.com/?token=a+b");
  assert.equal(extractTunnelUrl("INF https://bright-river.trycloudflare.com ready"), "https://bright-river.trycloudflare.com");
  assert.equal(extractTunnelUrl("https://example.com"), null);
});

test("tunnel discovers split output and publishes only the base URL", async () => {
  const child = fakeChild();
  const spawns = [];
  const requests = [];
  const manager = new TunnelManager({
    projectDir: "C:\\codex-remote", port: 8766, token: "phone-secret",
    binary: process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
    rendezvous: { url: "https://rendezvous.example/", secret: "publish-secret" },
    spawnImpl: (file, args, options) => { spawns.push({ file, args, options }); return child; },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200 }; },
  });
  const statuses = [];
  manager.on("status", (status) => statuses.push(status));
  manager.start();
  assert.equal(spawns[0].file, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  child.stderr.write("INF https://bright-");
  child.stderr.write("river.trycloudflare.com ready\n");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ["tunnel", "--url", "http://127.0.0.1:8766", "--no-autoupdate"]);
  assert.equal(statuses.at(-1).state, "online");
  assert.equal(statuses.at(-1).url, "https://bright-river.trycloudflare.com");
  assert.equal("phoneUrl" in statuses.at(-1), false);
  assert.equal(requests[0].url, "https://rendezvous.example/publish");
  assert.deepEqual(JSON.parse(requests[0].options.body), { url: "https://bright-river.trycloudflare.com" });
  assert.equal(requests[0].options.headers.authorization, "Bearer publish-secret");
  assert.equal(requests[0].options.body.includes("phone-secret"), false);
  await manager.stop();
});

test("unexpected exits use bounded backoff", () => {
  const children = [];
  const timers = [];
  const manager = new TunnelManager({
    projectDir: ".", port: 8766, token: "phone-secret", maxRestartAttempts: 2, urlAcquireTimeoutMs: 0,
    spawnImpl: () => { const child = fakeChild(); children.push(child); return child; },
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer: () => {},
  });
  const statuses = [];
  manager.on("status", (status) => statuses.push(status));
  manager.start();
  children[0].emit("exit", 1, null);
  assert.equal(timers[0].delay, 1_000);
  timers[0].fn();
  children[1].emit("exit", 1, null);
  assert.equal(timers[1].delay, 2_000);
  timers[1].fn();
  children[2].emit("exit", 1, null);
  assert.equal(children.length, 3);
  assert.equal(timers.length, 2);
  assert.equal(statuses.at(-1).state, "failed");
});

test("stop kills only the child owned by this manager and suppresses restart", async () => {
  const child = fakeChild();
  const timers = [];
  const manager = new TunnelManager({
    projectDir: ".", port: 8766, token: "phone-secret", urlAcquireTimeoutMs: 0,
    spawnImpl: () => child,
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return 1; },
    clearTimer: () => {},
    stopTimeoutMs: 20,
  });
  manager.start();
  const stopping = manager.stop();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("exit", 0, null);
  await stopping;
  assert.equal(timers.filter((timer) => timer.delay !== 20).length, 0);
});



test("rendezvous read URL carries the device identity without changing three-argument behavior", () => {
  assert.equal(
    buildPhoneUrl("https://x.trycloudflare.com", "secret", "https://r.example"),
    "https://x.trycloudflare.com/?token=secret&rz=https%3A%2F%2Fr.example",
  );
  assert.equal(
    buildRendezvousReadUrl("https://r.example/base/", "desk_01"),
    "https://r.example/base/current?deviceId=desk_01",
  );
  assert.equal(
    buildPhoneUrl("https://x.trycloudflare.com", "secret", "https://r.example/base", "desk_01"),
    "https://x.trycloudflare.com/?token=secret&rz=https%3A%2F%2Fr.example%2Fbase%2Fcurrent%3FdeviceId%3Ddesk_01",
  );
});

test("URL acquisition timeout kills the owned child and enters bounded restart", () => {
  const children = [];
  const timers = [];
  const manager = new TunnelManager({
    projectDir: ".", port: 8766, token: "secret-value",
    urlAcquireTimeoutMs: 250, maxRestartAttempts: 1,
    spawnImpl: () => { const child = fakeChild(); children.push(child); return child; },
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  manager.start();
  assert.equal(timers[0].delay, 250);
  timers[0].fn();
  assert.deepEqual(children[0].kills, ["SIGTERM"]);
  const restart = timers.find((timer) => timer.delay === 1_000 && !timer.cleared);
  assert.ok(restart);
  restart.fn();
  assert.equal(children.length, 2);
});

test("coming online resets consecutive tunnel restart attempts", () => {
  const children = [];
  const timers = [];
  const manager = new TunnelManager({
    projectDir: ".", port: 8766, token: "secret-value", urlAcquireTimeoutMs: 0,
    maxRestartAttempts: 2,
    spawnImpl: () => { const child = fakeChild(); children.push(child); return child; },
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });
  manager.start();
  children[0].emit("exit", 1, null);
  timers.at(-1).fn();
  children[1].stderr.write("https://stable.trycloudflare.com\n");
  children[1].emit("exit", 1, null);
  assert.equal(timers.at(-1).delay, 1_000);
});

test("rendezvous publishing retries with backoff and stays token-free", async () => {
  const child = fakeChild();
  const calls = [];
  const timers = [];
  const manager = new TunnelManager({
    projectDir: ".", port: 8766, token: "phone-secret", urlAcquireTimeoutMs: 0,
    rendezvous: {
      url: "https://rendezvous.example/base",
      secret: "publish-secret",
      deviceId: "desk_01",
    },
    spawnImpl: () => child,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: calls.length >= 2, status: calls.length >= 2 ? 200 : 503 };
    },
    publishRetryBaseMs: 100,
    publishTimeoutMs: 10_000,
    republishIntervalMs: 1_000,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  manager.start();
  child.stderr.write("https://retry-me.trycloudflare.com\n");
  await new Promise((resolve) => setImmediate(resolve));
  const retry = timers.find((timer) => timer.delay === 100 && !timer.cleared);
  assert.ok(retry);
  retry.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://rendezvous.example/base/publish");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    url: "https://retry-me.trycloudflare.com",
    deviceId: "desk_01",
  });
  assert.equal(
    manager.rendezvousReadUrl,
    "https://rendezvous.example/base/current?deviceId=desk_01",
  );
  assert.equal(JSON.stringify(calls).includes("phone-secret"), false);
  const republish = timers.find((timer) => timer.delay === 1_000 && !timer.cleared);
  assert.ok(republish);
  republish.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
});

test("periodic rendezvous republishing is cancelled when the tunnel stops", async () => {
  const child = fakeChild();
  const calls = [];
  const timers = [];
  const manager = new TunnelManager({
    projectDir: ".", port: 8766, token: "phone-secret", urlAcquireTimeoutMs: 0,
    rendezvous: {
      url: "https://rendezvous.example",
      secret: "publish-secret",
      deviceId: "desk_01",
    },
    spawnImpl: () => child,
    fetchImpl: async () => { calls.push(true); return { ok: true, status: 200 }; },
    republishIntervalMs: 1_000,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  manager.start();
  child.stderr.write("https://renew-me.trycloudflare.com\n");
  await new Promise((resolve) => setImmediate(resolve));
  const firstRenewal = timers.find((timer) => timer.delay === 1_000 && !timer.cleared);
  assert.ok(firstRenewal);
  firstRenewal.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);

  const nextRenewal = timers.filter((timer) => timer.delay === 1_000).at(-1);
  await manager.stop();
  assert.equal(nextRenewal.cleared, true);
  nextRenewal.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
});

test("rendezvous helpers reject plaintext HTTP endpoints", () => {
  assert.throws(
    () => buildRendezvousReadUrl("http://rendezvous.example", "desk_01"),
    /HTTPS/,
  );
  assert.throws(() => new TunnelManager({
    projectDir: ".",
    port: 8766,
    rendezvous: { url: "http://rendezvous.example", secret: "must-not-send" },
  }), /HTTPS/);
});

test("rendezvous worker binds device IDs, expires records, and rejects unsafe URLs and fields", async () => {
  const values = new Map();
  const puts = [];
  const env = {
    PUBLISH_SECRET: "publisher-secret",
    DEVICE_ID: "desk_01",
    RENDEZVOUS_TTL_SECONDS: "60",
    RZ: {
      async put(key, value, options) { puts.push({ key, value, options }); values.set(key, value); },
      async get(key) { return values.get(key) ?? null; },
    },
  };
  const publish = await rendezvousWorker.fetch(new Request("https://worker.example/publish", {
    method: "POST",
    headers: {
      authorization: "Bearer publisher-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ url: "https://fresh.trycloudflare.com", deviceId: "desk_01" }),
  }), env);
  assert.equal(publish.status, 200);
  assert.equal(puts[0].key, "current:desk_01");
  assert.equal(puts[0].options.expirationTtl, 60);
  assert.equal(puts[0].value.includes("publisher-secret"), false);

  const current = await rendezvousWorker.fetch(
    new Request("https://worker.example/current?deviceId=desk_01"),
    env,
  );
  assert.equal(current.status, 200);
  assert.equal(current.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal((await current.json()).url, "https://fresh.trycloudflare.com");

  const unsafe = await rendezvousWorker.fetch(new Request("https://worker.example/publish", {
    method: "POST",
    headers: {
      authorization: "Bearer publisher-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url: "http://fresh.trycloudflare.com",
      deviceId: "desk_01",
      token: "must-not-store",
    }),
  }), env);
  assert.equal(unsafe.status, 400);
  assert.equal(puts.length, 1);

  const unknown = await rendezvousWorker.fetch(new Request("https://worker.example/anything"), env);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("cache-control"), "no-store, max-age=0");
});
