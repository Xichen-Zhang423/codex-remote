import test from "node:test";
import assert from "node:assert/strict";

import { createPanelController } from "../public/panel.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function panelState(tunnelOrigin, lanOrigin = "http://192.168.1.8:8766") {
  return {
    serviceStatus: "online",
    codexStatus: "logged-in",
    appServerStatus: "online",
    workspace: "D:\\work",
    tunnelOrigin,
    lanOrigin,
    tools: { cloudflared: true },
    diagnostics: [],
  };
}

function connection(label, expiresAt = 10_000) {
  return {
    copyUrl: `https://${label}.example/connect#secret`,
    displayUrl: `https://${label}.example/connect#redacted`,
    qrDataUrl: `data:image/png;base64,${label}`,
    qrError: null,
    expiresAt,
  };
}

function createFakeView() {
  const view = {
    states: [],
    connections: { remote: [], lan: [] },
    lanVisibility: [],
    panelStatuses: [],
    actionsVisibility: [],
    focused: [],
    copied: [],
    announcements: [],
    connectionErrors: [],
    accessRevocations: [],
    renderState(state) { this.states.push(state); },
    renderConnection(mode, model) { this.connections[mode].push({ ...model }); },
    setLanVisible(visible) { this.lanVisibility.push(visible); },
    setPanelStatus(message) { this.panelStatuses.push(message); },
    setActionsVisible(visible) { this.actionsVisibility.push(visible); },
    focus(target) { this.focused.push(target); },
    async copyText(value) { this.copied.push(value); },
    announceConnection(mode, message) { this.announcements.push({ mode, message }); },
    setConnectionError(mode, message) { this.connectionErrors.push({ mode, message }); },
    setAccessRevoked(revoked) { this.accessRevocations.push(revoked); },
    confirmStop() { return true; },
  };
  return view;
}

function createFakeTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  const clearedTimeouts = [];
  const clearedIntervals = [];
  return {
    timeouts,
    intervals,
    clearedTimeouts,
    clearedIntervals,
    setTimeout(callback, delay) {
      const id = nextId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { clearedTimeouts.push(id); },
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) { clearedIntervals.push(id); },
    runTimeout(id) { timeouts.get(id)?.callback(); },
  };
}

function createFakeEventTarget(initial = {}) {
  const listeners = new Map();
  return Object.assign(initial, {
    addEventListener(type, listener, options = {}) {
      const entries = listeners.get(type) || [];
      entries.push({ listener, once: Boolean(options?.once) });
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      listeners.set(type, entries.filter((entry) => entry.listener !== listener));
    },
    dispatch(type, init = {}) {
      const entries = [...(listeners.get(type) || [])];
      for (const entry of entries) {
        if (entry.once) this.removeEventListener(type, entry.listener);
        entry.listener({ type, target: this, currentTarget: this, ...init });
      }
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  });
}

function activeIntervalIds(timers) {
  const cleared = new Set(timers.clearedIntervals);
  return [...timers.intervals.keys()].filter((id) => !cleared.has(id));
}

function latestConnection(view, mode) {
  return view.connections[mode].at(-1);
}

test("panel client imports without a DOM and exports a controller factory", async () => {
  const client = await import("../public/panel.js");

  assert.equal(typeof client.createPanelController, "function");
});

test("missing tunnel keeps remote waiting without creating a connection and keeps LAN hidden", async () => {
  const calls = [];
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return panelState(null);
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();

  assert.deepEqual(calls.map(({ path }) => path), ["/api/panel/state"]);
  assert.equal(latestConnection(view, "remote").state, "waiting");
  assert.equal(latestConnection(view, "remote").busy, true);
  assert.equal(latestConnection(view, "remote").copyEnabled, false);
  assert.equal(view.lanVisibility.at(-1), false);
});

test("one tunnel origin creates one remote connection and repeated state is deduplicated", async () => {
  const calls = [];
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === "/api/panel/state") return panelState("https://a.trycloudflare.com");
      return connection("remote-a");
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();
  await flush();
  await controller.refresh();
  await flush();

  const connectionCalls = calls.filter(({ path }) => path === "/api/panel/connection");
  assert.equal(connectionCalls.length, 1);
  assert.deepEqual(JSON.parse(connectionCalls[0].options.body), { mode: "remote" });
  assert.equal(latestConnection(view, "remote").state, "ready");
  assert.equal(latestConnection(view, "remote").displayUrl, connection("remote-a").displayUrl);
});

test("a late connection for tunnel A cannot overwrite a completed tunnel B connection", async () => {
  const a = deferred();
  const b = deferred();
  let stateCall = 0;
  let connectionCall = 0;
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path) => {
      if (path === "/api/panel/state") {
        stateCall += 1;
        return panelState(`https://${stateCall === 1 ? "a" : "b"}.trycloudflare.com`);
      }
      connectionCall += 1;
      return (connectionCall === 1 ? a : b).promise;
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();
  await controller.refresh();
  b.resolve(connection("remote-b"));
  await flush();
  a.resolve(connection("remote-a"));
  await flush();

  assert.equal(latestConnection(view, "remote").displayUrl, connection("remote-b").displayUrl);
});

test("clearing the tunnel invalidates an in-flight remote result and clears copy state", async () => {
  const pending = deferred();
  let stateCall = 0;
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path) => {
      if (path === "/api/panel/state") {
        stateCall += 1;
        return panelState(stateCall === 1 ? "https://a.trycloudflare.com" : null);
      }
      return pending.promise;
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();
  await controller.refresh();
  pending.resolve(connection("remote-a"));
  await flush();

  assert.equal(latestConnection(view, "remote").state, "waiting");
  assert.equal(latestConnection(view, "remote").displayUrl, "");
  assert.equal(await controller.copyRemote(), false);
});

test("remote failure never requests LAN and retry requests only remote", async () => {
  let remoteAttempt = 0;
  const modes = [];
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      if (path === "/api/panel/state") return panelState("https://a.trycloudflare.com");
      const { mode } = JSON.parse(options.body);
      modes.push(mode);
      remoteAttempt += 1;
      if (remoteAttempt === 1) throw new Error("public unavailable");
      return connection("remote-retry");
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();
  await flush();
  assert.equal(latestConnection(view, "remote").state, "error");
  await controller.retryRemote();
  await flush();

  assert.deepEqual(modes, ["remote", "remote"]);
  assert.equal(latestConnection(view, "remote").state, "ready");
});

test("opening connection options does not request LAN but explicit show does", async () => {
  const modes = [];
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      if (path === "/api/panel/state") return panelState(null);
      const { mode } = JSON.parse(options.body);
      modes.push(mode);
      return connection(mode);
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();
  controller.setConnectionOptionsOpen(true);
  await flush();
  assert.deepEqual(modes, []);

  await controller.showLan();
  await flush();
  assert.deepEqual(modes, ["lan"]);
  assert.equal(view.lanVisibility.at(-1), true);
  assert.equal(latestConnection(view, "lan").state, "ready");
});

test("closing connection options clears ready LAN access and a later show creates fresh access", async () => {
  let lanAttempt = 0;
  const timers = createFakeTimers();
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      if (path === "/api/panel/state") return panelState(null);
      assert.deepEqual(JSON.parse(options.body), { mode: "lan" });
      lanAttempt += 1;
      return connection(`lan-${lanAttempt}`);
    },
    view,
    timers,
    now: () => 1_000,
  });

  await controller.refresh();
  controller.setConnectionOptionsOpen(true);
  await controller.showLan();
  const expiryTimer = [...timers.timeouts.keys()].at(-1);
  assert.equal(latestConnection(view, "lan").state, "ready");
  assert.equal(await controller.copyLan(), true);

  controller.setConnectionOptionsOpen(false);

  assert.equal(view.lanVisibility.at(-1), false);
  assert.equal(latestConnection(view, "lan").state, "hidden");
  assert.ok(timers.clearedTimeouts.includes(expiryTimer));
  assert.equal(view.focused.at(-1), "connectionOptionsSummary");
  const copiesBefore = view.copied.length;
  assert.equal(await controller.copyLan(), false);
  assert.equal(view.copied.length, copiesBefore);

  await controller.showLan();
  assert.equal(lanAttempt, 2);
  assert.equal(latestConnection(view, "lan").displayUrl, connection("lan-2").displayUrl);
});

test("hiding a pending LAN connection invalidates its result and showing again uses a new epoch", async () => {
  const first = deferred();
  const second = deferred();
  let lanAttempt = 0;
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path) => {
      if (path === "/api/panel/state") return panelState(null);
      lanAttempt += 1;
      return (lanAttempt === 1 ? first : second).promise;
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();
  void controller.showLan();
  await flush();
  controller.hideLan();
  assert.equal(view.focused.at(-1), "showLanConnection");
  first.resolve(connection("lan-old"));
  await flush();
  assert.equal(view.lanVisibility.at(-1), false);
  assert.notEqual(latestConnection(view, "lan").displayUrl, connection("lan-old").displayUrl);

  void controller.showLan();
  await flush();
  second.resolve(connection("lan-new"));
  await flush();
  assert.equal(lanAttempt, 2);
  assert.equal(latestConnection(view, "lan").displayUrl, connection("lan-new").displayUrl);
});

test("remote and LAN expiry timers are independent and stale callbacks cannot clear newer results", async () => {
  let remoteAttempt = 0;
  const timers = createFakeTimers();
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      if (path === "/api/panel/state") return panelState("https://a.trycloudflare.com");
      const { mode } = JSON.parse(options.body);
      if (mode === "lan") return connection("lan", 3_000);
      remoteAttempt += 1;
      return connection(`remote-${remoteAttempt}`, remoteAttempt === 1 ? 2_000 : 4_000);
    },
    view,
    timers,
    now: () => 1_000,
  });

  await controller.refresh();
  await flush();
  await controller.showLan();
  await flush();
  const [oldRemoteTimer, lanTimer] = [...timers.timeouts.keys()];

  await controller.retryRemote();
  await flush();
  const newRemoteTimer = [...timers.timeouts.keys()].at(-1);
  timers.runTimeout(oldRemoteTimer);
  assert.equal(latestConnection(view, "remote").displayUrl, connection("remote-2").displayUrl);

  timers.runTimeout(lanTimer);
  assert.equal(latestConnection(view, "lan").state, "expired");
  assert.equal(latestConnection(view, "remote").state, "ready");
  assert.notEqual(newRemoteTimer, oldRemoteTimer);
});

test("stale clipboard success after a remote origin change cannot announce over the new connection", async () => {
  const clipboard = deferred();
  let stateAttempt = 0;
  let connectionAttempt = 0;
  const view = createFakeView();
  view.copyText = async (value) => {
    view.copied.push(value);
    return clipboard.promise;
  };
  const controller = createPanelController({
    request: async (path) => {
      if (path === "/api/panel/state") {
        stateAttempt += 1;
        return panelState(`https://${stateAttempt === 1 ? "a" : "b"}.trycloudflare.com`);
      }
      connectionAttempt += 1;
      return connection(`remote-${connectionAttempt}`);
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();
  await flush();
  const staleCopy = controller.copyRemote();
  await controller.refresh();
  await flush();
  assert.equal(latestConnection(view, "remote").displayUrl, connection("remote-2").displayUrl);

  clipboard.resolve();

  assert.equal(await staleCopy, false);
  assert.deepEqual(view.announcements, []);
  assert.deepEqual(view.connectionErrors, []);
  assert.equal(latestConnection(view, "remote").displayUrl, connection("remote-2").displayUrl);
});

test("stale clipboard failure after LAN hide and re-show cannot report over fresh access", async () => {
  const clipboard = deferred();
  let lanAttempt = 0;
  const view = createFakeView();
  view.copyText = async (value) => {
    view.copied.push(value);
    return clipboard.promise;
  };
  const controller = createPanelController({
    request: async (path) => {
      if (path === "/api/panel/state") return panelState(null);
      lanAttempt += 1;
      return connection(`lan-${lanAttempt}`);
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();
  await controller.showLan();
  const staleCopy = controller.copyLan();
  controller.hideLan();
  await controller.showLan();
  assert.equal(latestConnection(view, "lan").displayUrl, connection("lan-2").displayUrl);

  clipboard.reject(new Error("clipboard denied"));

  assert.equal(await staleCopy, false);
  assert.deepEqual(view.announcements, []);
  assert.deepEqual(view.connectionErrors, []);
  assert.equal(latestConnection(view, "lan").displayUrl, connection("lan-2").displayUrl);
});

test("expired-at-or-before-now results expire immediately instead of receiving a fallback delay", async () => {
  const timers = createFakeTimers();
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path) => path === "/api/panel/state"
      ? panelState("https://a.trycloudflare.com")
      : connection("already-expired", 1_000),
    view,
    timers,
    now: () => 1_000,
  });

  await controller.refresh();
  await flush();

  assert.equal(latestConnection(view, "remote").state, "expired");
  assert.equal(timers.timeouts.size, 0);
});

test("concurrent state refreshes accept only the newer response", async () => {
  const first = deferred();
  const second = deferred();
  let stateAttempt = 0;
  const modes = [];
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      if (path === "/api/panel/state") {
        stateAttempt += 1;
        return (stateAttempt === 1 ? first : second).promise;
      }
      modes.push(JSON.parse(options.body).mode);
      return connection("remote-b");
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  const oldRefresh = controller.refresh();
  const newRefresh = controller.refresh();
  second.resolve(panelState("https://b.trycloudflare.com"));
  await newRefresh;
  await flush();
  first.resolve(panelState("https://a.trycloudflare.com"));
  await oldRefresh;
  await flush();

  assert.deepEqual(modes, ["remote"]);
  assert.equal(view.states.at(-1).tunnelOrigin, "https://b.trycloudflare.com");
  assert.equal(latestConnection(view, "remote").displayUrl, connection("remote-b").displayUrl);
});

test("changing the tunnel clears the old remote result before the replacement resolves", async () => {
  const replacement = deferred();
  let stateAttempt = 0;
  let connectionAttempt = 0;
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path) => {
      if (path === "/api/panel/state") {
        stateAttempt += 1;
        return panelState(`https://${stateAttempt === 1 ? "a" : "b"}.trycloudflare.com`);
      }
      connectionAttempt += 1;
      return connectionAttempt === 1 ? connection("remote-a") : replacement.promise;
    },
    view,
    timers: createFakeTimers(),
    now: () => 1_000,
  });

  await controller.refresh();
  await flush();
  await controller.refresh();

  assert.equal(latestConnection(view, "remote").state, "loading");
  assert.equal(latestConnection(view, "remote").displayUrl, "");
  assert.equal(await controller.copyRemote(), false);
  replacement.resolve(connection("remote-b"));
  await flush();
  assert.equal(latestConnection(view, "remote").displayUrl, connection("remote-b").displayUrl);
});

test("ordinary refresh errors keep safety actions visible while 401 revokes them", async () => {
  let attempt = 0;
  const timers = createFakeTimers();
  const view = createFakeView();
  const controller = createPanelController({
    request: async () => {
      attempt += 1;
      const error = new Error(attempt === 1 ? "temporary failure" : "unauthorized");
      error.status = attempt === 1 ? 503 : 401;
      throw error;
    },
    view,
    timers,
    now: () => 1_000,
  });

  controller.start();
  await flush();
  assert.notEqual(view.actionsVisibility.at(-1), false);
  assert.equal(timers.intervals.size, 1);

  await controller.refresh();
  assert.deepEqual(timers.clearedIntervals, [[...timers.intervals.keys()][0]]);
  assert.equal(view.actionsVisibility.at(-1), false);
  assert.deepEqual(view.accessRevocations, [true]);
});

test("a state 401 revokes pending remote and LAN access and permanently blocks new requests", async () => {
  const remote = deferred();
  const lan = deferred();
  const calls = [];
  let stateAttempt = 0;
  const connectionAttempts = { remote: 0, lan: 0 };
  const timers = createFakeTimers();
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === "/api/panel/state") {
        stateAttempt += 1;
        if (stateAttempt === 1) {
          return panelState("https://public.example", "http://192.168.1.8:8766");
        }
        const error = new Error("unauthorized state request");
        error.status = 401;
        throw error;
      }
      const { mode } = JSON.parse(options.body);
      connectionAttempts[mode] += 1;
      if (connectionAttempts[mode] === 1) return mode === "remote" ? remote.promise : lan.promise;
      return connection(`unexpected-${mode}`);
    },
    view,
    timers,
    now: () => 1_000,
  });

  controller.start();
  await flush();
  void controller.showLan();
  await flush();
  assert.deepEqual(calls.filter(({ path }) => path === "/api/panel/connection")
    .map(({ options }) => JSON.parse(options.body).mode), ["remote", "lan"]);

  await controller.refresh();

  assert.equal(latestConnection(view, "remote").state, "unauthorized");
  assert.equal(latestConnection(view, "remote").copyEnabled, false);
  assert.equal(latestConnection(view, "lan").state, "hidden");
  assert.equal(view.lanVisibility.at(-1), false);
  assert.equal(view.actionsVisibility.at(-1), false);
  assert.deepEqual(view.accessRevocations, [true]);
  assert.equal(timers.clearedIntervals.length, 1);

  remote.resolve(connection("stale-remote"));
  lan.resolve(connection("stale-lan"));
  await flush();
  assert.equal(latestConnection(view, "remote").state, "unauthorized");
  assert.equal(latestConnection(view, "lan").state, "hidden");
  assert.equal(await controller.copyRemote(), false);
  assert.equal(await controller.copyLan(), false);

  const requestCount = calls.length;
  assert.equal(await controller.retryRemote(), false);
  assert.equal(await controller.showLan(), false);
  assert.equal(await controller.refresh(), null);
  assert.equal(calls.length, requestCount);
});

test("a connection 401 clears ready credentials, expiry timers, and all future access", async () => {
  const calls = [];
  let remoteAttempt = 0;
  const timers = createFakeTimers();
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === "/api/panel/state") {
        return panelState("https://public.example", "http://192.168.1.8:8766");
      }
      const { mode } = JSON.parse(options.body);
      if (mode === "lan") return connection("lan-ready");
      remoteAttempt += 1;
      if (remoteAttempt === 1) return connection("remote-ready");
      const error = new Error("unauthorized connection request");
      error.status = 401;
      throw error;
    },
    view,
    timers,
    now: () => 1_000,
  });

  await controller.refresh();
  await flush();
  await controller.showLan();
  assert.equal(await controller.copyRemote(), true);
  assert.equal(await controller.copyLan(), true);
  const expiryTimers = [...timers.timeouts.keys()];
  assert.equal(expiryTimers.length, 2);

  assert.equal(await controller.retryRemote(), false);

  assert.equal(latestConnection(view, "remote").state, "unauthorized");
  assert.equal(latestConnection(view, "remote").copyEnabled, false);
  assert.equal(latestConnection(view, "lan").state, "hidden");
  assert.equal(view.lanVisibility.at(-1), false);
  assert.equal(view.actionsVisibility.at(-1), false);
  assert.deepEqual(view.accessRevocations, [true]);
  assert.deepEqual(new Set(timers.clearedTimeouts), new Set(expiryTimers));
  assert.equal(await controller.copyRemote(), false);
  assert.equal(await controller.copyLan(), false);

  const requestCount = calls.length;
  controller.hideLan();
  assert.equal(await controller.retryRemote(), false);
  assert.equal(await controller.showLan(), false);
  assert.equal(await controller.refresh(), null);
  assert.equal(calls.length, requestCount);
});

test("a stop endpoint 401 revokes both ready connection modes and blocks future requests", async () => {
  const calls = [];
  const timers = createFakeTimers();
  const view = createFakeView();
  const controller = createPanelController({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === "/api/panel/state") {
        return panelState("https://public.example", "http://192.168.1.8:8766");
      }
      if (path === "/api/panel/stop") {
        const error = new Error("unauthorized stop request");
        error.status = 401;
        throw error;
      }
      return connection(JSON.parse(options.body).mode);
    },
    view,
    timers,
    now: () => 1_000,
  });

  await controller.refresh();
  await flush();
  await controller.showLan();
  const expiryTimers = [...timers.timeouts.keys()];
  assert.equal(expiryTimers.length, 2);

  assert.equal(await controller.stopService(), false);

  assert.equal(latestConnection(view, "remote").state, "unauthorized");
  assert.equal(latestConnection(view, "lan").state, "hidden");
  assert.equal(view.actionsVisibility.at(-1), false);
  assert.deepEqual(view.accessRevocations, [true]);
  assert.deepEqual(new Set(timers.clearedTimeouts), new Set(expiryTimers));
  assert.equal(await controller.copyRemote(), false);
  assert.equal(await controller.copyLan(), false);

  const requestCount = calls.length;
  assert.equal(await controller.stopService(), false);
  assert.equal(await controller.retryRemote(), false);
  assert.equal(await controller.showLan(), false);
  assert.equal(await controller.refresh(), null);
  assert.equal(calls.length, requestCount);
});

test("late stop completions cannot overwrite a newer unauthorized state", async (t) => {
  for (const outcome of ["success", "failure"]) {
    await t.test(outcome, async () => {
      const stop = deferred();
      let stateAttempt = 0;
      const view = createFakeView();
      const controller = createPanelController({
        request: async (path) => {
          if (path === "/api/panel/stop") return stop.promise;
          stateAttempt += 1;
          if (stateAttempt === 1) return panelState(null, null);
          const error = new Error("unauthorized state request");
          error.status = 401;
          throw error;
        },
        view,
        timers: createFakeTimers(),
        now: () => 1_000,
      });

      await controller.refresh();
      const stopping = controller.stopService();
      await flush();
      await controller.refresh();
      const unauthorizedStatus = view.panelStatuses.at(-1);
      assert.deepEqual(view.accessRevocations, [true]);

      if (outcome === "success") stop.resolve({});
      else stop.reject(new Error("late ordinary stop failure"));

      assert.equal(await stopping, false);
      assert.equal(view.panelStatuses.at(-1), unauthorizedStatus);
      assert.deepEqual(view.accessRevocations, [true]);
    });
  }
});

test("BFCache pagehide and pageshow pause and resume exactly once across repeated cycles", async () => {
  const client = await import("../public/panel.js");
  assert.equal(typeof client.bindPanelLifecycle, "function");

  const requests = [];
  const timers = createFakeTimers();
  const documentTarget = createFakeEventTarget({ visibilityState: "visible" });
  const windowTarget = createFakeEventTarget();
  const controller = createPanelController({
    request: async (path) => {
      requests.push(path);
      return panelState(null, null);
    },
    view: createFakeView(),
    timers,
    now: () => 1_000,
  });
  const unbind = client.bindPanelLifecycle(controller, documentTarget, windowTarget);

  controller.start();
  await flush();
  assert.equal(requests.filter((path) => path === "/api/panel/state").length, 1);
  assert.equal(activeIntervalIds(timers).length, 1);

  windowTarget.dispatch("pagehide", { persisted: true });
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatch("visibilitychange");
  assert.equal(activeIntervalIds(timers).length, 0);

  documentTarget.visibilityState = "visible";
  windowTarget.dispatch("pageshow", { persisted: true });
  documentTarget.dispatch("visibilitychange");
  await flush();
  assert.equal(requests.filter((path) => path === "/api/panel/state").length, 2);
  assert.equal(activeIntervalIds(timers).length, 1);

  documentTarget.visibilityState = "hidden";
  documentTarget.dispatch("visibilitychange");
  windowTarget.dispatch("pagehide", { persisted: true });
  assert.equal(activeIntervalIds(timers).length, 0);

  documentTarget.visibilityState = "visible";
  documentTarget.dispatch("visibilitychange");
  windowTarget.dispatch("pageshow", { persisted: true });
  await flush();
  assert.equal(requests.filter((path) => path === "/api/panel/state").length, 3);
  assert.equal(activeIntervalIds(timers).length, 1);
  assert.equal(documentTarget.listenerCount("visibilitychange"), 1);
  assert.equal(windowTarget.listenerCount("pagehide"), 1);
  assert.equal(windowTarget.listenerCount("pageshow"), 1);

  unbind();
  controller.stop();
  assert.equal(documentTarget.listenerCount("visibilitychange"), 0);
  assert.equal(windowTarget.listenerCount("pagehide"), 0);
  assert.equal(windowTarget.listenerCount("pageshow"), 0);
});

test("a non-persisted pagehide stops the controller and cannot be revived by later page events", async () => {
  const client = await import("../public/panel.js");
  assert.equal(typeof client.bindPanelLifecycle, "function");

  const requests = [];
  const timers = createFakeTimers();
  const documentTarget = createFakeEventTarget({ visibilityState: "visible" });
  const windowTarget = createFakeEventTarget();
  const controller = createPanelController({
    request: async (path) => {
      requests.push(path);
      return panelState(null, null);
    },
    view: createFakeView(),
    timers,
    now: () => 1_000,
  });
  const originalStop = controller.stop;
  let stopCalls = 0;
  controller.stop = () => {
    stopCalls += 1;
    originalStop();
  };
  client.bindPanelLifecycle(controller, documentTarget, windowTarget);

  controller.start();
  await flush();
  windowTarget.dispatch("pagehide", { persisted: false });
  assert.equal(stopCalls, 1);
  assert.equal(activeIntervalIds(timers).length, 0);

  documentTarget.visibilityState = "visible";
  windowTarget.dispatch("pageshow", { persisted: true });
  documentTarget.dispatch("visibilitychange");
  windowTarget.dispatch("pageshow", { persisted: true });
  await flush();
  assert.equal(requests.filter((path) => path === "/api/panel/state").length, 1);
  assert.equal(timers.intervals.size, 1);
  assert.equal(documentTarget.listenerCount("visibilitychange"), 0);
  assert.equal(windowTarget.listenerCount("pagehide"), 0);
  assert.equal(windowTarget.listenerCount("pageshow"), 0);
});
