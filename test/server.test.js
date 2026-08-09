import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isTunnelEnabled, main, selectPhoneBaseUrl } from "../server.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function privateLanInterfaces(address = "192.168.10.25") {
  return {
    Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    WLAN: [{ address, family: "IPv4", internal: false }],
  };
}

function unavailableLanInterfaces() {
  return {
    Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    "vEthernet (WSL)": [{ address: "172.18.0.1", family: "IPv4", internal: false }],
    Ethernet: [{ address: "203.0.113.25", family: "IPv4", internal: false }],
  };
}

async function startPanelHarness({
  platform = "linux",
  env = {},
  openPanelImpl = () => ({ opened: false }),
} = {}) {
  const logs = [];
  const errors = [];
  const app = await main({
    env: {
      CODEX_REMOTE_TUNNEL: "0",
      ...env,
    },
    platform,
    installSignalHandlers: false,
    log: (line) => logs.push(String(line)),
    error: (line) => errors.push(String(line)),
    loadConfigImpl: () => ({
      port: 9123,
      token: "literal-phone-secret",
      cwd: "/work",
      model: null,
      effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    createArtifactStore: async () => ({ async close() {} }),
    createArtifactTracker: () => ({ async recoverPendingTurns() { return []; }, async close() {} }),
    createArtifactTickets: () => ({ async close() {} }),
    createCodexProcess: () => ({ packageBin: "C:\\runtime\\codex.js" }),
    createAdapter: () => ({}),
    createWindowsRemote: () => ({}),
    createRemoteServerImpl: async () => ({
      address: { port: 9123 },
      httpUrl: "http://127.0.0.1:9123",
      broadcast() {},
      async close() {},
    }),
    createKeepAwake: () => null,
    networkInterfacesImpl: () => privateLanInterfaces(),
    checkCodexLoginStatusImpl: async () => "unknown",
    openPanelImpl,
  });
  return { app, logs, errors };
}

test("selectPhoneBaseUrl ignores public overrides and selects only a reachable LAN IPv4", () => {
  const interfaces = {
    Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    "vEthernet (WSL)": [
      { address: "172.20.1.5", family: "IPv4", internal: false },
    ],
    Ethernet: [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "192.168.10.25", family: "IPv4", internal: false },
    ],
  };
  assert.equal(selectPhoneBaseUrl({
    env: { CODEX_REMOTE_PUBLIC_URL: "https://remote.example/" }, port: 8766, interfaces,
  }), "http://192.168.10.25:8766");
  assert.equal(selectPhoneBaseUrl({ env: {}, port: 8766, interfaces }), "http://192.168.10.25:8766");
  assert.equal(selectPhoneBaseUrl({
    env: { CODEX_REMOTE_PUBLIC_HOST: "codex-pc.local" }, port: 9000, interfaces,
  }), "http://192.168.10.25:9000");
  assert.equal(selectPhoneBaseUrl({
    env: {
      CODEX_REMOTE_PUBLIC_URL: "https://remote.example/",
      CODEX_REMOTE_PUBLIC_HOST: "codex-pc.local",
    },
    port: 8766,
    interfaces: unavailableLanInterfaces(),
  }), null);
});

test("selectPhoneBaseUrl returns null when no reachable LAN address exists", () => {
  assert.equal(selectPhoneBaseUrl({
    env: {},
    port: 8766,
    interfaces: {
      Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      IPv6: [{ address: "fe80::1", family: "IPv6", internal: false }],
    },
  }), null);
});

test("selectPhoneBaseUrl ignores VPN tunnel adapters before choosing WLAN", () => {
  const interfaces = {
    xray_tun: [{ address: "172.18.0.1", family: "IPv4", internal: false }],
    Tailscale: [{ address: "100.104.123.11", family: "IPv4", internal: false }],
    WLAN: [{ address: "10.38.7.142", family: "IPv4", internal: false }],
  };
  assert.equal(
    selectPhoneBaseUrl({ env: {}, port: 8766, interfaces }),
    "http://10.38.7.142:8766",
  );
});

test("selectPhoneBaseUrl returns null when only virtual or VPN adapters are available", () => {
  assert.equal(selectPhoneBaseUrl({
    env: {},
    port: 8766,
    interfaces: {
      "vEthernet (WSL)": [{ address: "172.18.0.1", family: "IPv4", internal: false }],
      xray_tun: [{ address: "172.19.0.1", family: "IPv4", internal: false }],
      Tailscale: [{ address: "100.104.123.11", family: "IPv4", internal: false }],
    },
  }), null);
});

test("selectPhoneBaseUrl does not expose an unencrypted fallback on a public IPv4", () => {
  assert.equal(selectPhoneBaseUrl({
    env: {},
    port: 8766,
    interfaces: {
      Ethernet: [{ address: "203.0.113.25", family: "IPv4", internal: false }],
    },
  }), null);
});

test("main never promotes public URL or host configuration into LAN panel access", async () => {
  let panelOptions;
  const app = await main({
    env: {
      CODEX_REMOTE_TUNNEL: "0",
      CODEX_REMOTE_PUBLIC_URL: "https://public.example",
      CODEX_REMOTE_PUBLIC_HOST: "public-host.example",
    },
    platform: "linux",
    installSignalHandlers: false,
    log: () => {},
    error: () => {},
    loadConfigImpl: () => ({
      port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    createArtifactStore: async () => ({ async close() {} }),
    createArtifactTracker: () => ({ async recoverPendingTurns() { return []; }, async close() {} }),
    createArtifactTickets: () => ({ async close() {} }),
    createCodexProcess: () => ({ packageBin: "C:\\runtime\\codex.js" }),
    createAdapter: () => ({}),
    checkCodexLoginStatusImpl: async () => "unknown",
    createPanelSessionImpl: (options) => {
      panelOptions = options;
      return { panelUrl: (baseUrl) => `${baseUrl}/panel.html#panel=test` };
    },
    createRemoteServerImpl: async () => ({
      address: { port: 9123 }, httpUrl: "http://127.0.0.1:9123", broadcast() {}, async close() {},
    }),
    createKeepAwake: () => null,
    networkInterfacesImpl: () => unavailableLanInterfaces(),
  });

  assert.equal(panelOptions.stateProvider().lanOrigin, null);
  await assert.rejects(panelOptions.connectionProvider("lan"), { code: "LAN_CONNECTION_NOT_READY" });
  await app.close();
});

test("isTunnelEnabled supports the dedicated switch and legacy NO_TUNNEL", () => {
  assert.equal(isTunnelEnabled({}), true);
  for (const value of ["0", "false", "off", "no"]) {
    assert.equal(isTunnelEnabled({ CODEX_REMOTE_TUNNEL: value }), false);
  }
  assert.equal(isTunnelEnabled({ CODEX_REMOTE_TUNNEL: "1" }), true);
  assert.equal(isTunnelEnabled({ NO_TUNNEL: "1" }), false);
});

test("Windows keep-awake owns one hidden helper and releases it on stop", async () => {
  const server = await import("../server.js");
  assert.equal(typeof server.createWindowsKeepAwake, "function");
  const calls = [];
  const child = new EventEmitter();
  child.kill = () => { calls.push("kill"); child.emit("exit"); return true; };
  const keepAwake = server.createWindowsKeepAwake({
    platform: "win32",
    spawnImpl(file, args, options) {
      calls.push({ file, args, options });
      return child;
    },
  });
  assert.equal(keepAwake.start(), true);
  assert.equal(keepAwake.start(), false);
  assert.equal(calls[0].file, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(0, 4), [
    "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
  ]);
  assert.match(calls[0].args.at(-1), /SetThreadExecutionState[\s\S]*2147483649/);
  assert.deepEqual(calls[0].options, { stdio: "ignore", windowsHide: true });
  assert.equal(keepAwake.stop(), true);
  assert.equal(keepAwake.stop(), false);
  assert.deepEqual(calls.slice(1), ["kill"]);

  const otherPlatform = server.createWindowsKeepAwake({
    platform: "linux",
    spawnImpl() { throw new Error("must not spawn"); },
  });
  assert.equal(otherPlatform.start(), false);
});

test("main opens, recovers, wires, and closes artifact services in lifecycle order", async () => {
  const events = [];
  const errors = [];
  const localAppData = path.resolve("C:\\user data\\Local");
  const store = { async close() { events.push("store:close"); } };
  const tracker = {
    async recoverPendingTurns() {
      events.push("tracker:recover");
      return [{ recovered: false, diagnostics: [{ message: "pending turn could not be recovered" }] }];
    },
    async close() { events.push("tracker:close"); },
  };
  const tickets = { async close() { events.push("tickets:close"); } };
  const adapter = { adapter: true };
  const remote = {
    address: { port: 9123 }, httpUrl: "http://127.0.0.1:9123", broadcast() {},
    async close() { events.push("remote:close"); },
  };
  const tunnel = new EventEmitter();
  tunnel.start = () => {};
  tunnel.stop = async () => events.push("tunnel:close");

  const app = await main({
    env: { LOCALAPPDATA: localAppData }, platform: "linux", installSignalHandlers: false,
    log: () => {}, error: (message) => errors.push(String(message)),
    loadConfigImpl: () => ({
      port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    createArtifactStore: async (options) => {
      events.push("store:open");
      assert.equal(options.root, path.join(localAppData, "CodexRemote", "artifacts"));
      assert.equal(options.root.startsWith(path.resolve("codex-remote")), false);
      return store;
    },
    createArtifactTracker: (options) => {
      assert.equal(options.store, store);
      return tracker;
    },
    createCodexProcess: () => ({}),
    checkCodexLoginStatusImpl: async () => "unknown",
    createAdapter: (options) => {
      events.push("adapter:create");
      assert.equal(options.artifactTracker, tracker);
      return adapter;
    },
    createArtifactTickets: () => { events.push("tickets:create"); return tickets; },
    createRemoteServerImpl: async (options) => {
      events.push("remote:start");
      assert.equal(options.adapter, adapter);
      assert.equal(options.artifactStore, store);
      assert.equal(options.artifactTracker, tracker);
      assert.equal(options.artifactTickets, tickets);
      return remote;
    },
    createTunnel: () => tunnel,
    createKeepAwake: () => ({
      start() { events.push("awake:start"); return true; },
      stop() { events.push("awake:close"); return true; },
    }),
    networkInterfacesImpl: () => unavailableLanInterfaces(),
  });

  assert.deepEqual(events.slice(0, 5), [
    "store:open", "tracker:recover", "adapter:create", "tickets:create", "remote:start",
  ]);
  assert.match(errors.join("\n"), /pending turn could not be recovered/);
  await app.close();
  assert.deepEqual(events.slice(-6), [
    "tunnel:close", "awake:close", "remote:close", "tickets:close", "tracker:close", "store:close",
  ]);
});

test("startup failures release acquired services in reverse order without double-owning the adapter", async (t) => {
  const scenarios = [
    {
      name: "tracker construction",
      failAt: "tracker",
      expected: ["store:open", "tracker:create", "store:close"],
    },
    {
      name: "adapter construction",
      failAt: "adapter",
      expected: [
        "store:open", "tracker:create", "tracker:recover", "process:create", "adapter:create",
        "process:stop", "tracker:close", "store:close",
      ],
    },
    {
      name: "ticket construction",
      failAt: "tickets",
      expected: [
        "store:open", "tracker:create", "tracker:recover", "process:create", "adapter:create",
        "tickets:create", "adapter:stop", "tracker:close", "store:close",
      ],
    },
    {
      name: "remote creation before ownership",
      failAt: "remote",
      expected: [
        "store:open", "tracker:create", "tracker:recover", "process:create", "adapter:create",
        "tickets:create", "remote:start", "tickets:close", "adapter:stop", "tracker:close", "store:close",
      ],
    },
    {
      name: "remote start after ownership",
      failAt: "remote",
      transferAdapter: true,
      expected: [
        "store:open", "tracker:create", "tracker:recover", "process:create", "adapter:create",
        "tickets:create", "remote:start", "adapter:stop", "tickets:close", "tracker:close", "store:close",
      ],
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const events = [];
      const store = { async close() { events.push("store:close"); } };
      const tracker = {
        async recoverPendingTurns() { events.push("tracker:recover"); return []; },
        async close() { events.push("tracker:close"); },
      };
      const processOwner = { stop() { events.push("process:stop"); } };
      const adapter = { async stop() { events.push("adapter:stop"); } };
      const tickets = { close() { events.push("tickets:close"); } };
      const options = {
        env: { CODEX_REMOTE_TUNNEL: "0" }, platform: "linux", installSignalHandlers: false,
        log: () => {}, error: () => {},
        loadConfigImpl: () => ({
          port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
          rendezvous: { url: "", secret: "", deviceId: "device-1" },
        }),
        createArtifactStore: async () => { events.push("store:open"); return store; },
        checkCodexLoginStatusImpl: async () => "unknown",
        createArtifactTracker: () => {
          events.push("tracker:create");
          if (scenario.failAt === "tracker") throw new Error("tracker startup failed");
          return tracker;
        },
        createCodexProcess: () => { events.push("process:create"); return processOwner; },
        createAdapter: () => {
          events.push("adapter:create");
          if (scenario.failAt === "adapter") throw new Error("adapter startup failed");
          return adapter;
        },
        createArtifactTickets: () => {
          events.push("tickets:create");
          if (scenario.failAt === "tickets") throw new Error("tickets startup failed");
          return tickets;
        },
        createRemoteServerImpl: async (settings) => {
          events.push("remote:start");
          if (scenario.transferAdapter) {
            assert.equal(typeof settings.onAdapterOwnership, "function");
            settings.onAdapterOwnership();
            await adapter.stop();
          }
          throw new Error("remote startup failed");
        },
      };
      await assert.rejects(main(options), /startup failed/);
      assert.deepEqual(events, scenario.expected);
    });
  }
});

test("startup cleanup preserves the acquisition failure when cleanup also fails", async () => {
  const original = new Error("tracker acquisition failed");
  let thrown;
  try {
    await main({
      env: { CODEX_REMOTE_TUNNEL: "0" }, platform: "linux", installSignalHandlers: false,
      log: () => {}, error: () => {},
      loadConfigImpl: () => ({
        port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
        rendezvous: { url: "", secret: "", deviceId: "device-1" },
      }),
      createArtifactStore: async () => ({ async close() { throw new Error("store cleanup failed"); } }),
      checkCodexLoginStatusImpl: async () => "unknown",
      createArtifactTracker: () => { throw original; },
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof AggregateError);
  assert.equal(thrown.errors[0], original);
  assert.match(thrown.errors[1].message, /store cleanup failed/);
});

test("main opens one Windows desktop panel after HTTP startup and logs only safe public URLs", async () => {
  const lifecycle = [];
  const broadcasts = [];
  const logs = [];
  const errors = [];
  const opened = [];
  let panelOptions;
  let launcherOptions;
  const env = {
    CODEX_REMOTE_SOURCE_DIR: path.resolve("C:\\read only source"),
    CODEX_REMOTE_CONFIG: path.resolve("C:\\user data\\CodexRemote\\config.json"),
  };
  const tunnel = new EventEmitter();
  tunnel.start = () => lifecycle.push("tunnel-start");
  tunnel.stop = async () => lifecycle.push("tunnel-stop");
  const app = await main({
    env,
    platform: "win32",
    installSignalHandlers: false,
    log: (line) => logs.push(String(line)),
    error: (line) => errors.push(String(line)),
    loadConfigImpl: () => ({
      port: 9123,
      token: "literal-phone-secret",
      cwd: "C:\\work",
      model: null,
      effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    createArtifactStore: async () => ({ async close() {} }),
    createArtifactTracker: () => ({ async recoverPendingTurns() { return []; }, async close() {} }),
    createArtifactTickets: () => ({ async close() {} }),
    createCodexProcess: () => ({ packageBin: "C:\\runtime\\codex.js" }),
    createAdapter: () => ({}),
    createWindowsRemote: () => ({}),
    createKeepAwake: () => null,
    networkInterfacesImpl: () => privateLanInterfaces(),
    checkCodexLoginStatusImpl: async () => "unknown",
    createPanelSessionImpl: (options) => {
      panelOptions = options;
      return {
        key: "panel-capability-key",
        panelUrl: (baseUrl) => `${baseUrl}/panel.html#panel=panel-capability-key`,
      };
    },
    createRemoteServerImpl: async () => {
      lifecycle.push("remote-listening");
      return {
        address: { port: 9123 },
        httpUrl: "http://127.0.0.1:9123",
        broadcast: (event) => broadcasts.push(event),
        async close() { lifecycle.push("remote-close"); },
      };
    },
    createTunnel: () => tunnel,
    openPanelImpl: (url, options) => {
      lifecycle.push("panel-open");
      assert.equal(panelOptions.stateProvider().lanOrigin, "http://192.168.10.25:9123");
      opened.push(url);
      launcherOptions = options;
      return { opened: true };
    },
  });

  assert.deepEqual(lifecycle, ["remote-listening", "panel-open", "tunnel-start"]);
  assert.deepEqual(opened, ["http://127.0.0.1:9123/panel.html#panel=panel-capability-key"]);
  assert.equal(launcherOptions.platform, "win32");
  assert.equal(launcherOptions.env, env);
  assert.equal(typeof launcherOptions.onError, "function");
  assert.equal(logs.filter((line) => line === "Desktop control panel opened.").length, 1);
  assert.doesNotMatch(logs.join("\n"), /literal-phone-secret|panel-capability-key|Phone base URL|LAN ONLY|Scan this QR code|[█▀▄]/u);

  launcherOptions.onError(new Error(
    "child failed for http://127.0.0.1:9123/panel.html#panel=panel-capability-key and panel-capability-key",
  ));
  assert.match(errors.at(-1), /^\[panel\] child failed/);
  assert.doesNotMatch(errors.at(-1), /panel-capability-key/);

  tunnel.emit("status", { state: "online", url: "https://public-a.example" });
  assert.deepEqual(broadcasts.at(-1), {
    type: "tunnel", state: "online", url: "https://public-a.example",
  });
  assert.equal(
    await panelOptions.connectionProvider("remote"),
    "https://public-a.example/?token=literal-phone-secret",
  );
  tunnel.emit("status", { state: "reconnecting", url: "https://public-a.example" });
  await assert.rejects(panelOptions.connectionProvider("remote"), { code: "PUBLIC_CONNECTION_NOT_READY" });
  tunnel.emit("status", { state: "online", url: "https://public-b.example" });
  assert.equal(
    await panelOptions.connectionProvider("remote"),
    "https://public-b.example/?token=literal-phone-secret",
  );
  assert.deepEqual(logs.filter((line) => line.startsWith("Public remote URL:")), [
    "Public remote URL: https://public-a.example",
    "Public remote URL: https://public-b.example",
  ]);
  assert.doesNotMatch(logs.join("\n"), /literal-phone-secret|panel-capability-key|\?token=/);

  tunnel.emit("status", {
    state: "online",
    url: "https://user:password@public-c.example/path/?token=literal-phone-secret#panel=panel-capability-key",
  });
  assert.equal(logs.at(-1), "Public remote URL: https://public-c.example/path");
  assert.doesNotMatch(logs.join("\n"), /literal-phone-secret|panel-capability-key|user:password|\?token=/);

  await app.close();
  assert.deepEqual(lifecycle.slice(-2), ["tunnel-stop", "remote-close"]);
});

test("desktop panel auto-open respects platform and NO_PANEL true flags", async (t) => {
  const scenarios = [
    { name: "Windows default", platform: "win32", env: {}, expected: 1 },
    { name: "non-Windows", platform: "linux", env: {}, expected: 0 },
    ...["1", "true", "on", "yes"].map((value) => ({
      name: `NO_PANEL=${value}`, platform: "win32", env: { NO_PANEL: value }, expected: 0,
    })),
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const { app } = await startPanelHarness({
        platform: scenario.platform,
        env: scenario.env,
        openPanelImpl: () => { calls += 1; return { opened: false }; },
      });
      assert.equal(calls, scenario.expected);
      await app.close();
    });
  }
});

test("desktop panel launcher failures are diagnostic and non-fatal", async (t) => {
  await t.test("synchronous launcher failure", async () => {
    const { app, logs, errors } = await startPanelHarness({
      platform: "win32",
      openPanelImpl: () => {
        throw new Error("cannot launch #panel=secret-panel-key with literal-phone-secret");
      },
    });
    assert.equal(logs.includes("Desktop control panel opened."), false);
    assert.match(errors.join("\n"), /\[panel\].*cannot launch/);
    assert.doesNotMatch(errors.join("\n"), /secret-panel-key|literal-phone-secret/);
    await app.close();
  });

  await t.test("launcher declines to open", async () => {
    const { app, logs } = await startPanelHarness({
      platform: "win32",
      openPanelImpl: () => ({ opened: false }),
    });
    assert.equal(logs.includes("Desktop control panel opened."), false);
    await app.close();
  });
});

test("post-listen URL initialization failures clean up every acquired service", async (t) => {
  for (const scenario of [
    {
      name: "invalid remote port", platform: "linux", invalidPort: true,
      env: {},
    },
    {
      name: "panel URL construction", platform: "win32",
      env: {}, panelThrows: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const events = [];
      await assert.rejects(main({
        env: { CODEX_REMOTE_TUNNEL: "0", ...scenario.env },
        platform: scenario.platform,
        installSignalHandlers: false,
        log: () => {},
        error: () => {},
        loadConfigImpl: () => ({
          port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
          rendezvous: { url: "", secret: "", deviceId: "device-1" },
        }),
        createArtifactStore: async () => ({ async close() { events.push("store-close"); } }),
        checkCodexLoginStatusImpl: async () => "unknown",
        createArtifactTracker: () => ({
          async recoverPendingTurns() { return []; },
          async close() { events.push("tracker-close"); },
        }),
        createArtifactTickets: () => ({ async close() { events.push("tickets-close"); } }),
        createCodexProcess: () => ({ packageBin: "C:\\runtime\\codex.js" }),
        createAdapter: () => ({ async stop() { events.push("adapter-stop"); } }),
        createWindowsRemote: () => ({ async close() { events.push("windows-close"); } }),
        createPanelSessionImpl: (options) => ({
          ...options,
          panelUrl() {
            if (scenario.panelThrows) throw new Error("panel URL failed");
            return "http://127.0.0.1:9123/panel.html#panel=test";
          },
        }),
        createRemoteServerImpl: async () => ({
          address: { port: scenario.invalidPort ? 0 : 9123 },
          httpUrl: "http://127.0.0.1:9123", broadcast() {},
          async close() { events.push("remote-close"); },
        }),
        networkInterfacesImpl: () => privateLanInterfaces(),
        createKeepAwake: () => { throw new Error("keep-awake must not start before URL initialization"); },
        openPanelImpl: () => { throw new Error("panel opener must not run after URL construction fails"); },
      }), scenario.panelThrows ? /panel URL failed/ : /invalid phone port/);
      assert.deepEqual(events, scenario.platform === "win32"
        ? ["remote-close", "tickets-close", "windows-close", "adapter-stop", "tracker-close", "store-close"]
        : ["remote-close", "tickets-close", "adapter-stop", "tracker-close", "store-close"]);
    });
  }
});

test("main wires Windows control and an owned tunnel, then closes in order", async (t) => {
  const lifecycle = [];
  const broadcasts = [];
  const logs = [];
  const tunnel = new EventEmitter();
  tunnel.start = () => lifecycle.push("tunnel-start");
  tunnel.stop = async () => lifecycle.push("tunnel-stop");
  const windowsRemote = { capture() {}, control() {} };
  const remote = {
    address: { port: 9123 },
    httpUrl: "http://127.0.0.1:9123",
    broadcast: (event) => broadcasts.push(event),
    close: async () => lifecycle.push("remote-close"),
  };
  const config = {
    port: 9123,
    token: "literal-phone-secret",
    cwd: "C:\\work",
    model: null,
    effort: null,
    rendezvous: { url: "https://rendezvous.example", secret: "publish", deviceId: "device-1" },
  };
  const sourceDir = path.resolve("C:\\read only source");
  const configFile = path.resolve("C:\\user data\\CodexRemote\\config.json");
  const app = await main({
    env: {
      CODEX_REMOTE_SOURCE_DIR: sourceDir,
      CODEX_REMOTE_CONFIG: configFile,
    },
    log: (message) => logs.push(String(message)),
    error: () => {},
    platform: "win32",
    installSignalHandlers: false,
    loadConfigImpl: (options) => {
      assert.equal(options.file, configFile);
      return config;
    },
    checkCodexLoginStatusImpl: async () => "unknown",
    createCodexProcess: () => ({ process: true }),
    createAdapter: () => ({ adapter: true }),
    createWindowsRemote: (options) => {
      assert.equal(options.projectDir, sourceDir);
      return windowsRemote;
    },
    createRemoteServerImpl: async (options) => {
      assert.equal(options.windowsRemote, windowsRemote);
      assert.equal(options.publicDir, path.join(sourceDir, "public"));
      return remote;
    },
    createTunnel: (options) => {
      assert.equal(options.port, 9123);
      assert.equal(options.rendezvous.deviceId, "device-1");
      assert.equal(options.projectDir, sourceDir);
      return tunnel;
    },
    createKeepAwake: () => null,
    networkInterfacesImpl: () => privateLanInterfaces(),
    openPanelImpl: () => ({ opened: false }),
  });
  t.after(() => app.close());
  assert.deepEqual(lifecycle, ["tunnel-start"]);
  assert.equal(logs.join("\n").includes("literal-phone-secret"), false);
  assert.doesNotMatch(logs.join("\n"), /Phone base URL|LAN ONLY|Scan this QR code|[█▀▄]/u);

  tunnel.emit("status", { state: "online", url: "https://bright-river.trycloudflare.com" });
  assert.deepEqual(broadcasts.at(-1), {
    type: "tunnel", state: "online", url: "https://bright-river.trycloudflare.com",
  });
  assert.equal(logs.at(-1), "Public remote URL: https://bright-river.trycloudflare.com");

  await app.close();
  assert.deepEqual(lifecycle, ["tunnel-start", "tunnel-stop", "remote-close"]);
  await app.close();
  assert.deepEqual(lifecycle, ["tunnel-start", "tunnel-stop", "remote-close"]);
});

test("main keeps public and LAN panel connection providers isolated across tunnel state changes", async () => {
  let connectionProvider;
  const tunnel = new EventEmitter();
  tunnel.start = () => {};
  tunnel.stop = async () => {};
  const assertCode = (promise, code) => assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
  const app = await main({
    env: {},
    log: () => {}, error: () => {}, platform: "linux", installSignalHandlers: false,
    loadConfigImpl: () => ({
      port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    createArtifactStore: async () => ({ async close() {} }),
    createArtifactTracker: () => ({ async recoverPendingTurns() { return []; }, async close() {} }),
    createArtifactTickets: () => ({ async close() {} }),
    createCodexProcess: () => ({ packageBin: "C:\\runtime\\codex.js" }),
    createAdapter: () => ({}),
    checkCodexLoginStatusImpl: async () => "unknown",
    createPanelSessionImpl: (options) => {
      connectionProvider = options.connectionProvider;
      return { panelUrl: (baseUrl) => `${baseUrl}/panel.html#panel=test` };
    },
    createRemoteServerImpl: async () => {
      await assertCode(connectionProvider("remote"), "PUBLIC_CONNECTION_NOT_READY");
      await assertCode(connectionProvider("lan"), "LAN_CONNECTION_NOT_READY");
      return {
        address: { port: 9123 }, httpUrl: "http://127.0.0.1:9123", broadcast() {}, async close() {},
      };
    },
    createTunnel: () => tunnel,
    createKeepAwake: () => null,
    networkInterfacesImpl: () => privateLanInterfaces(),
  });

  await assertCode(connectionProvider("remote"), "PUBLIC_CONNECTION_NOT_READY");
  assert.equal(
    await connectionProvider("lan"),
    "http://192.168.10.25:9123/?token=literal-phone-secret",
  );

  tunnel.emit("status", { state: "online", url: "https://public-a.example" });
  assert.equal(
    await connectionProvider("remote"),
    "https://public-a.example/?token=literal-phone-secret",
  );

  tunnel.emit("status", { state: "reconnecting", url: "https://public-a.example" });
  await assertCode(connectionProvider("remote"), "PUBLIC_CONNECTION_NOT_READY");
  assert.equal(
    await connectionProvider("lan"),
    "http://192.168.10.25:9123/?token=literal-phone-secret",
  );
  await app.close();
});

test("close revokes public and LAN connections before awaiting tunnel shutdown and ignores late status", async () => {
  let connectionProvider;
  const broadcasts = [];
  const stop = deferred();
  const tunnel = new EventEmitter();
  tunnel.start = () => {};
  tunnel.stop = () => stop.promise;
  const app = await main({
    env: {},
    log: () => {}, error: () => {}, platform: "linux", installSignalHandlers: false,
    loadConfigImpl: () => ({
      port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    createArtifactStore: async () => ({ async close() {} }),
    createArtifactTracker: () => ({ async recoverPendingTurns() { return []; }, async close() {} }),
    createArtifactTickets: () => ({ async close() {} }),
    createCodexProcess: () => ({ packageBin: "C:\\runtime\\codex.js" }),
    createAdapter: () => ({}),
    checkCodexLoginStatusImpl: async () => "unknown",
    createPanelSessionImpl: (options) => {
      connectionProvider = options.connectionProvider;
      return { panelUrl: (baseUrl) => `${baseUrl}/panel.html#panel=test` };
    },
    createRemoteServerImpl: async () => ({
      address: { port: 9123 }, httpUrl: "http://127.0.0.1:9123",
      broadcast: (event) => broadcasts.push(event), async close() {},
    }),
    createTunnel: () => tunnel,
    createKeepAwake: () => null,
    networkInterfacesImpl: () => privateLanInterfaces(),
  });

  tunnel.emit("status", { state: "online", url: "https://public-a.example" });
  assert.equal(
    await connectionProvider("remote"),
    "https://public-a.example/?token=literal-phone-secret",
  );
  const closing = app.close();
  await assert.rejects(connectionProvider("remote"), { code: "PUBLIC_CONNECTION_NOT_READY" });
  await assert.rejects(connectionProvider("lan"), { code: "LAN_CONNECTION_NOT_READY" });
  const broadcastsBeforeLateStatus = broadcasts.length;
  tunnel.emit("status", { state: "online", url: "https://public-b.example" });
  await assert.rejects(connectionProvider("remote"), { code: "PUBLIC_CONNECTION_NOT_READY" });
  assert.equal(broadcasts.length, broadcastsBeforeLateStatus);

  stop.resolve();
  await closing;
  tunnel.emit("status", { state: "online", url: "https://public-c.example" });
  await assert.rejects(connectionProvider("remote"), { code: "PUBLIC_CONNECTION_NOT_READY" });
  assert.equal(broadcasts.length, broadcastsBeforeLateStatus);
});

test("main keeps desktop and tunnel features disabled when unavailable", async () => {
  let tunnelCreated = false;
  let receivedWindowsRemote = "unset";
  const app = await main({
    env: { CODEX_REMOTE_TUNNEL: "0" },
    log: () => {},
    error: () => {},
    platform: "linux",
    installSignalHandlers: false,
    loadConfigImpl: () => ({
      port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    checkCodexLoginStatusImpl: async () => "unknown",
    createCodexProcess: () => ({}),
    createAdapter: () => ({}),
    createWindowsRemote: () => { throw new Error("must not create"); },
    createRemoteServerImpl: async (options) => {
      receivedWindowsRemote = options.windowsRemote;
      return {
        address: { port: 9123 }, httpUrl: "http://127.0.0.1:9123", broadcast() {}, async close() {},
      };
    },
    createTunnel: () => { tunnelCreated = true; },
    networkInterfacesImpl: () => unavailableLanInterfaces(),
  });
  assert.equal(receivedWindowsRemote, null);
  assert.equal(tunnelCreated, false);
  await app.close();
});

test("main still closes the HTTP service when owned tunnel cleanup fails", async () => {
  let remoteClosed = false;
  const tunnel = new EventEmitter();
  tunnel.start = () => {};
  tunnel.stop = async () => { throw new Error("tunnel stop failed"); };
  const app = await main({
    env: {}, log: () => {}, error: () => {}, platform: "linux", installSignalHandlers: false,
    loadConfigImpl: () => ({
      port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    checkCodexLoginStatusImpl: async () => "unknown",
    createCodexProcess: () => ({}), createAdapter: () => ({}),
    createRemoteServerImpl: async () => ({
      address: { port: 9123 }, httpUrl: "http://127.0.0.1:9123", broadcast() {},
      close: async () => { remoteClosed = true; },
    }),
    createTunnel: () => tunnel,
    networkInterfacesImpl: () => unavailableLanInterfaces(),
  });
  await assert.rejects(app.close(), /tunnel stop failed/);
  assert.equal(remoteClosed, true);
});

test("server source and package metadata contain no terminal QR implementation", () => {
  const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

  assert.equal(manifest.dependencies.qrcode, "^1.5.4");
  assert.equal(manifest.dependencies["qrcode-terminal"], undefined);
  assert.equal(lock.packages[""].dependencies["qrcode-terminal"], undefined);
  assert.equal(lock.packages["node_modules/qrcode-terminal"], undefined);
  assert.doesNotMatch(source, /qrcode-terminal|showPhoneAccess|qrGenerate|Scan this QR code/);
});

test("shutdown closes artifact tickets once and preserves aggregated cleanup failures", async () => {
  const events = [];
  const app = await main({
    env: { CODEX_REMOTE_TUNNEL: "0" }, log: () => {}, error: () => {},
    platform: "linux", installSignalHandlers: false,
    loadConfigImpl: () => ({
      port: 9123, token: "literal-phone-secret", cwd: "/work", model: null, effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    createArtifactStore: async () => ({
      async close() { events.push("store:close"); },
    }),
    createArtifactTracker: () => ({
      async recoverPendingTurns() { return []; },
      async close() { events.push("tracker:close"); },
    }),
    createArtifactTickets: () => ({
      async close() { events.push("tickets:close"); throw new Error("ticket cleanup failed"); },
    }),
    createCodexProcess: () => ({ packageBin: "C:\\runtime\\codex.js" }),
    createAdapter: () => ({}),
    checkCodexLoginStatusImpl: async () => "unknown",
    createRemoteServerImpl: async () => ({
      address: { port: 9123 }, httpUrl: "http://127.0.0.1:9123", broadcast() {},
      async close() { events.push("remote:close"); throw new Error("remote cleanup failed"); },
    }),
    networkInterfacesImpl: () => unavailableLanInterfaces(),
  });

  let failure;
  try { await app.close(); } catch (error) { failure = error; }
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors.map((error) => error.message), [
    "remote cleanup failed", "ticket cleanup failed",
  ]);
  assert.deepEqual(events, ["remote:close", "tickets:close", "tracker:close", "store:close"]);
  await assert.rejects(app.close(), AggregateError);
  assert.deepEqual(events, ["remote:close", "tickets:close", "tracker:close", "store:close"]);
});

test("main wires a redacted live panel state, local fragment URL, and panel shutdown", async () => {
  const logs = [];
  const errors = [];
  let adapterOptions;
  let remoteOptions;
  let panelOptions;
  let shutdownListener;
  let remoteClosed = 0;
  let ticketsClosed = 0;
  const adapter = {
    appServerStatus: "online", threadId: "thread-secret", cwd: "C:\\Users\\Alice\\workspace",
  };
  const panelSession = {
    key: "panel-key",
    panelUrl: (base) => `${base}/panel.html#panel=panel-key`,
    state: () => panelOptions.stateProvider(),
    createConnection: (mode = "remote") => panelOptions.connectionProvider(mode),
  };
  const app = await main({
    env: {
      CODEX_REMOTE_TUNNEL: "0",
      USERPROFILE: "C:\\Users\\Alice",
    },
    platform: "linux", installSignalHandlers: false,
    log: (line) => logs.push(String(line)), error: (line) => errors.push(String(line)),
    loadConfigImpl: () => ({
      port: 9123, token: "literal-phone-secret", cwd: "C:\\Users\\Alice\\workspace",
      model: null, effort: null, rendezvous: { url: "", secret: "", deviceId: "device-1" },
    }),
    createArtifactStore: async () => ({ async close() {} }),
    createArtifactTracker: () => ({ async recoverPendingTurns() { return []; }, async close() {} }),
    createArtifactTickets: () => ({ async close() { ticketsClosed += 1; } }),
    createCodexProcess: () => ({ packageBin: "C:\\runtime\\codex.js" }),
    createAdapter: (options) => { adapterOptions = options; return adapter; },
    checkCodexLoginStatusImpl: async () => "logged-in",
    createPanelSessionImpl: (options) => { panelOptions = options; return panelSession; },
    qrToDataUrl: async () => "data:image/png;base64,AA==",
    createRemoteServerImpl: async (options) => {
      remoteOptions = options;
      return {
        address: { port: 9123 }, httpUrl: "http://127.0.0.1:9123", broadcast() {},
        once(event, listener) { assert.equal(event, "shutdownRequested"); shutdownListener = listener; },
        async close() { remoteClosed += 1; },
      };
    },
    networkInterfacesImpl: () => privateLanInterfaces(),
  });

  assert.equal(remoteOptions.panelSession, panelSession);
  assert.equal(typeof shutdownListener, "function");
  assert.doesNotMatch(logs.join("\n"), /panel-key|#panel=/);
  adapterOptions.onError(new Error("failed for literal-phone-secret at C:\\Users\\Alice\\private"));
  await new Promise((resolve) => setImmediate(resolve));
  const state = panelSession.state();
  assert.equal(state.codexStatus, "logged-in");
  assert.equal(state.appServerStatus, "online");
  assert.equal(state.workspace, "C:\\Users\\Alice\\workspace");
  assert.equal(JSON.stringify(state).includes("literal-phone-secret"), false);
  assert.equal(JSON.stringify(state).includes("C:\\Users\\Alice\\private"), false);
  assert.match(state.diagnostics.at(-1), /%USERPROFILE%/);
  assert.equal(errors.join("\n").includes("literal-phone-secret"), false);
  assert.equal(await panelSession.createConnection("lan"), "http://192.168.10.25:9123/?token=literal-phone-secret");

  shutdownListener();
  await app.close();
  assert.equal(remoteClosed, 1);
  assert.equal(ticketsClosed, 1);
  await app.close();
  assert.equal(remoteClosed, 1);
  assert.equal(ticketsClosed, 1);
});
