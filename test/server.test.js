import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { isTunnelEnabled, main, selectPhoneBaseUrl } from "../server.js";

test("selectPhoneBaseUrl prefers explicit public URL then a reachable LAN IPv4", () => {
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
  }), "https://remote.example");
  assert.equal(selectPhoneBaseUrl({ env: {}, port: 8766, interfaces }), "http://192.168.10.25:8766");
  assert.equal(selectPhoneBaseUrl({
    env: { CODEX_REMOTE_PUBLIC_HOST: "codex-pc.local" }, port: 9000, interfaces,
  }), "http://codex-pc.local:9000");
});

test("selectPhoneBaseUrl falls back to loopback when no LAN address exists", () => {
  assert.equal(selectPhoneBaseUrl({ env: {}, port: 8766, interfaces: {} }), "http://127.0.0.1:8766");
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
    qrGenerate: (_url, _options, callback) => callback("[qr]"),
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
        qrGenerate: (_url, _options, callback) => callback("[qr]"),
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
      createArtifactTracker: () => { throw original; },
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof AggregateError);
  assert.equal(thrown.errors[0], original);
  assert.match(thrown.errors[1].message, /store cleanup failed/);
});

test("main wires Windows control and an owned tunnel, then closes in order", async () => {
  const lifecycle = [];
  const broadcasts = [];
  const logs = [];
  const qrUrls = [];
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
      CODEX_REMOTE_PUBLIC_HOST: "codex-pc.local",
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
    qrGenerate: (url, _options, callback) => { qrUrls.push(url); callback("[qr]"); },
  });
  assert.deepEqual(lifecycle, ["tunnel-start"]);
  assert.equal(qrUrls[0], "http://codex-pc.local:9123/?token=literal-phone-secret&rz=https%3A%2F%2Frendezvous.example%2Fcurrent%3FdeviceId%3Ddevice-1");
  assert.equal(logs.join("\n").includes("literal-phone-secret"), false);

  tunnel.emit("status", { state: "online", url: "https://bright-river.trycloudflare.com" });
  assert.deepEqual(broadcasts.at(-1), {
    type: "tunnel", state: "online", url: "https://bright-river.trycloudflare.com",
  });
  assert.equal(qrUrls.at(-1), "https://bright-river.trycloudflare.com/?token=literal-phone-secret&rz=https%3A%2F%2Frendezvous.example%2Fcurrent%3FdeviceId%3Ddevice-1");

  await app.close();
  assert.deepEqual(lifecycle, ["tunnel-start", "tunnel-stop", "remote-close"]);
  await app.close();
  assert.deepEqual(lifecycle, ["tunnel-start", "tunnel-stop", "remote-close"]);
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
    qrGenerate: (_url, _options, callback) => callback("[qr]"),
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
    createCodexProcess: () => ({}), createAdapter: () => ({}),
    createRemoteServerImpl: async () => ({
      address: { port: 9123 }, httpUrl: "http://127.0.0.1:9123", broadcast() {},
      close: async () => { remoteClosed = true; },
    }),
    createTunnel: () => tunnel,
    qrGenerate: (_url, _options, callback) => callback("[qr]"),
  });
  await assert.rejects(app.close(), /tunnel stop failed/);
  assert.equal(remoteClosed, true);
});

test("main keeps the real qrcode-terminal receiver when using the default generator", async () => {
  const logs = [];
  let remoteClosed = false;
  const app = await main({
    env: { NO_TUNNEL: "1", CODEX_REMOTE_PUBLIC_HOST: "phone.test" },
    log: (message) => logs.push(String(message)),
    error: () => {},
    platform: "linux",
    installSignalHandlers: false,
    loadConfigImpl: () => ({
      port: 8766,
      token: "default-qr-token",
      cwd: ".",
      model: null,
      effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-test-01" },
    }),
    createCodexProcess: () => ({}),
    createAdapter: () => ({}),
    createRemoteServerImpl: async () => ({
      httpUrl: "http://127.0.0.1:8766",
      address: { port: 8766 },
      close: async () => { remoteClosed = true; },
    }),
  });

  assert.equal(logs.some((message) => message.includes("Scan this QR code")), true);
  assert.equal(logs.some((message) => /[█▀▄]/u.test(message)), true);
  await app.close();
  assert.equal(remoteClosed, true);
});

test("a QR rendering failure is reported without aborting the running service", async () => {
  const errors = [];
  let remoteClosed = false;
  const app = await main({
    env: { NO_TUNNEL: "1", CODEX_REMOTE_PUBLIC_HOST: "phone.test" },
    log: () => {},
    error: (message) => errors.push(String(message)),
    platform: "linux",
    installSignalHandlers: false,
    loadConfigImpl: () => ({
      port: 8766,
      token: "secret-qr-token",
      cwd: ".",
      model: null,
      effort: null,
      rendezvous: { url: "", secret: "", deviceId: "device-test-01" },
    }),
    createCodexProcess: () => ({}),
    createAdapter: () => ({}),
    createRemoteServerImpl: async () => ({
      httpUrl: "http://127.0.0.1:8766",
      address: { port: 8766 },
      close: async () => { remoteClosed = true; },
    }),
    qrGenerate: (url) => { throw new Error(`renderer unavailable: ${url}; secret-qr-token`); },
  });

  assert.match(errors.join("\n"), /\[qr\].*renderer unavailable/i);
  assert.doesNotMatch(errors.join("\n"), /secret-qr-token/);
  assert.doesNotMatch(errors.join("\n"), /\?token=/);
  await app.close();
  assert.equal(remoteClosed, true);
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
    qrGenerate: (_url, _options, callback) => callback("[qr]"),
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
    createConnection: () => panelOptions.connectionProvider(),
  };
  const app = await main({
    env: {
      CODEX_REMOTE_TUNNEL: "0", CODEX_REMOTE_PUBLIC_HOST: "codex-pc.local",
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
    qrGenerate: (_url, _options, callback) => callback("[qr]"),
  });

  assert.equal(remoteOptions.panelSession, panelSession);
  assert.equal(typeof shutdownListener, "function");
  assert.match(logs.join("\n"), /Desktop panel: http:\/\/127\.0\.0\.1:9123\/panel\.html#panel=panel-key/);
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
  assert.equal(await panelSession.createConnection(), "http://codex-pc.local:9123/?token=literal-phone-secret");

  shutdownListener();
  await app.close();
  assert.equal(remoteClosed, 1);
  assert.equal(ticketsClosed, 1);
  await app.close();
  assert.equal(remoteClosed, 1);
  assert.equal(ticketsClosed, 1);
});
