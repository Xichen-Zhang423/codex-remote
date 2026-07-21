import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolveOptionalBinary } from "./optional-binary.js";

const MAX_OUTPUT_BUFFER = 16 * 1024;

export function extractTunnelUrl(output) {
  if (typeof output !== "string") return null;
  const match = output.match(/https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.trycloudflare\.com(?=[\s/'"<>]|$)/i);
  if (!match) return null;
  try {
    const candidate = new URL(match[0]);
    if (candidate.protocol !== "https:" || !candidate.hostname.endsWith(".trycloudflare.com")) return null;
    return candidate.origin;
  } catch {
    return null;
  }
}

export function buildRendezvousReadUrl(baseUrl, deviceId = "") {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") {
    throw new TypeError("rendezvous URL must use HTTPS");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/current`;
  url.search = "";
  url.hash = "";
  if (deviceId) url.searchParams.set("deviceId", deviceId);
  return url.toString();
}

export function buildPhoneUrl(baseUrl, token, rendezvousUrl = "", deviceId = "") {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  if (typeof rendezvousUrl === "string" && rendezvousUrl.trim()) {
    const readUrl = deviceId
      ? buildRendezvousReadUrl(rendezvousUrl.trim(), deviceId)
      : rendezvousUrl.trim();
    url.searchParams.set("rz", readUrl);
  }
  return url.toString();
}

function publishEndpoint(baseUrl) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:") {
    throw new TypeError("rendezvous URL must use HTTPS");
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/publish`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function boundedDelay(attempt, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
}

export class TunnelManager extends EventEmitter {
  constructor({
    projectDir,
    port,
    token: _token,
    rendezvous = null,
    binary,
    spawnImpl = spawn,
    fetchImpl = globalThis.fetch,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    maxRestartAttempts = 6,
    restartBaseMs = 1_000,
    maxRestartDelayMs = 30_000,
    urlAcquireTimeoutMs = 20_000,
    maxPublishAttempts = 4,
    publishRetryBaseMs = 3_000,
    maxPublishRetryDelayMs = 12_000,
    publishTimeoutMs = 6_000,
    republishIntervalMs = 45_000,
    stopTimeoutMs = 5_000,
  } = {}) {
    super();
    if (typeof projectDir !== "string" || !projectDir) throw new TypeError("projectDir is required");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("invalid tunnel port");
    if (!Number.isInteger(maxRestartAttempts) || maxRestartAttempts < 0 || maxRestartAttempts > 100) {
      throw new TypeError("invalid maxRestartAttempts");
    }
    this.projectDir = path.resolve(projectDir);
    this.port = port;
    if (rendezvous?.url) buildRendezvousReadUrl(rendezvous.url, rendezvous.deviceId || "");
    this.rendezvous = rendezvous;
    this.binary = binary || resolveOptionalBinary(
      process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
      { productRoot: this.projectDir },
    );
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.maxRestartAttempts = maxRestartAttempts;
    this.restartBaseMs = Math.max(1, restartBaseMs);
    this.maxRestartDelayMs = Math.max(this.restartBaseMs, maxRestartDelayMs);
    this.urlAcquireTimeoutMs = Math.max(0, urlAcquireTimeoutMs);
    this.maxPublishAttempts = Math.max(1, maxPublishAttempts);
    this.publishRetryBaseMs = Math.max(1, publishRetryBaseMs);
    this.maxPublishRetryDelayMs = Math.max(this.publishRetryBaseMs, maxPublishRetryDelayMs);
    this.publishTimeoutMs = Math.max(1, publishTimeoutMs);
    this.republishIntervalMs = Math.max(1_000, republishIntervalMs);
    this.stopTimeoutMs = Math.max(1, stopTimeoutMs);

    this.child = null;
    this.childSerial = 0;
    this.generation = 0;
    this.desired = false;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.acquireTimer = null;
    this.outputBuffer = "";
    this.url = null;
    this.publishController = null;
    this.publishPromise = null;
    this.publishRetryTimer = null;
    this.republishTimer = null;
    this.stopPromise = null;
  }

  get rendezvousReadUrl() {
    const config = this.rendezvous;
    if (!config?.url) return null;
    return buildRendezvousReadUrl(config.url, config.deviceId || "");
  }

  start() {
    if (this.desired && (this.child || this.restartTimer)) return this;
    this.desired = true;
    this.restartAttempts = 0;
    const generation = ++this.generation;
    this.#clearRestartTimer();
    this.#cancelPublish();
    this.#spawn(generation);
    return this;
  }

  async restart() {
    await this.stop();
    this.start();
    return this;
  }

  #spawn(generation) {
    if (!this.desired || generation !== this.generation) return;
    this.outputBuffer = "";
    this.url = null;
    let child;
    try {
      child = this.spawnImpl(
        this.binary,
        ["tunnel", "--url", `http://127.0.0.1:${this.port}`, "--no-autoupdate"],
        { cwd: this.projectDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      this.#scheduleRestart(generation);
      return;
    }
    const serial = ++this.childSerial;
    this.child = child;
    this.#emitStatus({ state: "connecting" });

    const acceptOutput = (chunk) => this.#acceptOutput(child, serial, generation, chunk);
    child.stdout?.on("data", acceptOutput);
    child.stderr?.on("data", acceptOutput);
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      this.#childEnded(child, serial, generation);
    };
    child.once("error", onEnd);
    child.once("exit", onEnd);
    this.#armAcquireTimeout(child, serial, generation);
  }

  #acceptOutput(child, serial, generation, chunk) {
    if (!this.#isCurrent(child, serial, generation)) return;
    this.outputBuffer = `${this.outputBuffer}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`
      .slice(-MAX_OUTPUT_BUFFER);
    if (this.url) return;
    const discovered = extractTunnelUrl(this.outputBuffer);
    if (!discovered) return;
    this.#clearAcquireTimer();
    this.url = discovered;
    this.restartAttempts = 0;
    this.#emitStatus({
      state: "online",
      url: discovered,
      generation,
      rendezvousUrl: this.rendezvousReadUrl,
    });
    void this.#publish(discovered, child, serial, generation, 1);
  }

  #childEnded(child, serial, generation) {
    if (!this.#isCurrent(child, serial, generation)) return;
    this.child = null;
    this.url = null;
    this.outputBuffer = "";
    this.#clearAcquireTimer();
    this.#cancelPublish();
    if (!this.desired) return;
    this.#scheduleRestart(generation);
  }

  #scheduleRestart(generation) {
    if (!this.desired || generation !== this.generation || this.restartTimer) return;
    if (this.restartAttempts >= this.maxRestartAttempts) {
      this.desired = false;
      this.#emitStatus({ state: "failed" });
      return;
    }
    this.restartAttempts += 1;
    const delay = boundedDelay(this.restartAttempts, this.restartBaseMs, this.maxRestartDelayMs);
    this.#emitStatus({ state: "restarting", attempt: this.restartAttempts, delay });
    const timer = this.setTimer(() => {
      if (this.restartTimer !== timer) return;
      this.restartTimer = null;
      if (this.desired && generation === this.generation) this.#spawn(generation);
    }, delay);
    this.restartTimer = timer;
    timer?.unref?.();
  }

  #clearRestartTimer() {
    if (this.restartTimer != null) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
  }

  #armAcquireTimeout(child, serial, generation) {
    this.#clearAcquireTimer();
    if (this.urlAcquireTimeoutMs <= 0) return;
    const timer = this.setTimer(() => {
      if (this.acquireTimer !== timer) return;
      this.acquireTimer = null;
      if (!this.#isCurrent(child, serial, generation) || this.url) return;
      try { child.kill?.("SIGTERM"); } catch { /* the owned process is already gone */ }
      this.#childEnded(child, serial, generation);
    }, this.urlAcquireTimeoutMs);
    this.acquireTimer = timer;
    timer?.unref?.();
  }

  #clearAcquireTimer() {
    if (this.acquireTimer != null) this.clearTimer(this.acquireTimer);
    this.acquireTimer = null;
  }

  #isCurrent(child, serial, generation) {
    return this.desired
      && this.child === child
      && this.childSerial === serial
      && this.generation === generation;
  }

  async #publish(url, child, serial, generation, attempt) {
    const config = this.rendezvous;
    if (!config?.url || !config?.secret || typeof this.fetchImpl !== "function") return;
    if (!this.#isCurrent(child, serial, generation) || this.url !== url || this.publishPromise) return;
    this.#clearPublishRetryTimer();
    this.#clearRepublishTimer();
    const controller = new AbortController();
    this.publishController = controller;
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = this.setTimer(() => {
        controller.abort();
        reject(new Error("rendezvous publish timed out"));
      }, this.publishTimeoutMs);
      timeout?.unref?.();
    });
    const body = { url };
    if (typeof config.deviceId === "string" && config.deviceId) body.deviceId = config.deviceId;
    const request = Promise.resolve().then(() => this.fetchImpl(publishEndpoint(config.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    }));
    const currentPromise = Promise.race([request, timeoutPromise]);
    this.publishPromise = currentPromise;
    try {
      const response = await currentPromise;
      if (!response?.ok) throw new Error("rendezvous rejected publish");
      if (this.#isCurrent(child, serial, generation) && this.url === url) {
        this.#emitStatus({
          state: "online",
          url,
          generation,
          rendezvousUrl: this.rendezvousReadUrl,
          published: true,
        });
        this.#scheduleRepublish(url, child, serial, generation);
      }
    } catch {
      if (this.#isCurrent(child, serial, generation)) {
        this.#emitStatus({
          state: "online",
          url,
          generation,
          rendezvousUrl: this.rendezvousReadUrl,
          published: false,
        });
        this.#schedulePublishRetry(url, child, serial, generation, attempt + 1);
      }
    } finally {
      if (timeout != null) this.clearTimer(timeout);
      if (this.publishPromise === currentPromise) this.publishPromise = null;
      if (this.publishController === controller) this.publishController = null;
    }
  }

  #schedulePublishRetry(url, child, serial, generation, attempt) {
    if (!this.#isCurrent(child, serial, generation) || this.url !== url) return;
    if (attempt > this.maxPublishAttempts) {
      this.#scheduleRepublish(url, child, serial, generation);
      return;
    }
    const delay = boundedDelay(attempt - 1, this.publishRetryBaseMs, this.maxPublishRetryDelayMs);
    const timer = this.setTimer(() => {
      if (this.publishRetryTimer !== timer) return;
      this.publishRetryTimer = null;
      void this.#publish(url, child, serial, generation, attempt);
    }, delay);
    this.publishRetryTimer = timer;
    timer?.unref?.();
  }

  #scheduleRepublish(url, child, serial, generation) {
    if (!this.#isCurrent(child, serial, generation) || this.url !== url) return;
    this.#clearRepublishTimer();
    const timer = this.setTimer(() => {
      if (this.republishTimer !== timer) return;
      this.republishTimer = null;
      void this.#publish(url, child, serial, generation, 1);
    }, this.republishIntervalMs);
    this.republishTimer = timer;
    timer?.unref?.();
  }

  #clearPublishRetryTimer() {
    if (this.publishRetryTimer != null) this.clearTimer(this.publishRetryTimer);
    this.publishRetryTimer = null;
  }

  #clearRepublishTimer() {
    if (this.republishTimer != null) this.clearTimer(this.republishTimer);
    this.republishTimer = null;
  }

  #cancelPublish() {
    this.#clearPublishRetryTimer();
    this.#clearRepublishTimer();
    this.publishController?.abort();
    this.publishController = null;
    this.publishPromise = null;
  }

  #emitStatus(status) {
    this.emit("status", Object.freeze({ ...status }));
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    this.desired = false;
    const stopGeneration = ++this.generation;
    this.child = null;
    this.url = null;
    this.outputBuffer = "";
    this.#clearRestartTimer();
    this.#clearAcquireTimer();
    this.#cancelPublish();
    this.stopPromise = this.#stopChild(child);
    try {
      await this.stopPromise;
      if (!this.desired && this.generation === stopGeneration) {
        this.#emitStatus({ state: "stopped" });
      }
    } finally {
      this.stopPromise = null;
    }
  }

  async #stopChild(child) {
    if (!child) return;
    await new Promise((resolve) => {
      let settled = false;
      let timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout != null) this.clearTimer(timeout);
        child.off?.("exit", finish);
        child.off?.("close", finish);
        resolve();
      };
      child.once?.("exit", finish);
      child.once?.("close", finish);
      timeout = this.setTimer(() => {
        try { child.kill?.("SIGKILL"); } catch { /* the owned process is already gone */ }
        finish();
      }, this.stopTimeoutMs);
      timeout?.unref?.();
      try {
        if (child.exitCode != null || child.signalCode != null) finish();
        else if (child.kill?.("SIGTERM") === false) finish();
        else if (child.pid === undefined && child.exitCode === undefined) finish();
      } catch {
        finish();
      }
    });
  }
}
