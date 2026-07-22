import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import qrTerminal from "qrcode-terminal";
import qrImage from "qrcode";
import { loadConfig } from "./src/config.js";
import { createPanelSession } from "./src/panel-session.js";
import { checkCodexLoginStatus } from "./src/codex-status.js";
import { CodexProcess } from "./src/codex-process.js";
import { CodexAdapter } from "./src/codex-adapter.js";
import { createRemoteServer } from "./src/remote-server.js";
import { ArtifactStore } from "./src/artifact-store.js";
import { ArtifactTracker } from "./src/artifact-tracker.js";
import { ArtifactTicketStore } from "./src/artifact-tickets.js";
import { WindowsRemote } from "./src/windows-remote.js";
import { TunnelManager, buildPhoneUrl } from "./src/tunnel.js";

const projectDir = path.dirname(fileURLToPath(import.meta.url));

function resolvePackageBin() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("@openai/codex/bin/codex.js");
  } catch {
    return null;
  }
}

export function selectPhoneBaseUrl({
  env = process.env,
  port,
  interfaces = os.networkInterfaces(),
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("invalid phone port");
  const explicitUrl = env.CODEX_REMOTE_PUBLIC_URL?.trim();
  if (explicitUrl) {
    const parsed = new URL(explicitUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("CODEX_REMOTE_PUBLIC_URL must use http or https");
    }
    return explicitUrl.replace(/\/+$/, "");
  }
  const explicitHost = env.CODEX_REMOTE_PUBLIC_HOST?.trim();
  if (explicitHost) return `http://${explicitHost}:${port}`;

  const candidates = Object.entries(interfaces).flatMap(([adapter, entries]) => (
    (entries ?? []).map((entry) => ({ ...entry, adapter }))
  )).filter((entry) => (
    entry && !entry.internal
    && (entry.family === "IPv4" || entry.family === 4)
    && !entry.address.startsWith("169.254.")
  ));
  const isPrivate = (entry) => (
    entry.address.startsWith("10.")
    || entry.address.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)
  );
  const virtualAdapter = /(?:vethernet|wsl|docker|vmware|virtualbox|hyper-v|tailscale|zerotier|loopback|bluetooth|xray|wintun|wireguard|openvpn|vpn)/i;
  const physical = candidates.filter((entry) => !virtualAdapter.test(entry.adapter));
  const selected = physical.find(isPrivate) ?? physical[0] ?? candidates.find(isPrivate) ?? candidates[0];
  const address = selected?.address ?? "127.0.0.1";
  return `http://${address}:${port}`;
}

function isFalseFlag(value) {
  return ["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function isTrueFlag(value) {
  return ["1", "true", "on", "yes"].includes(String(value).trim().toLowerCase());
}

export function isTunnelEnabled(env = process.env) {
  if (env.CODEX_REMOTE_TUNNEL != null) return !isFalseFlag(env.CODEX_REMOTE_TUNNEL);
  if (env.NO_TUNNEL != null) return !isTrueFlag(env.NO_TUNNEL);
  return true;
}

export function createWindowsKeepAwake({
  platform = process.platform,
  spawnImpl = spawn,
  onError = () => {},
} = {}) {
  let child = null;
  return {
    get active() { return Boolean(child); },
    start() {
      if (platform !== "win32" || child) return false;
      const command = [
        "$signature = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);';",
        "$type = Add-Type -MemberDefinition $signature -Name NativePower -Namespace CodexRemote -PassThru;",
        "while ($true) { [void]$type::SetThreadExecutionState(2147483649); Start-Sleep -Seconds 45 }",
      ].join(" ");
      try {
        const owned = spawnImpl("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command,
        ], { stdio: "ignore", windowsHide: true });
        child = owned;
        const release = () => { if (child === owned) child = null; };
        owned.once?.("exit", release);
        owned.once?.("error", (cause) => { release(); onError(cause); });
        return true;
      } catch (cause) {
        onError(cause);
        return false;
      }
    },
    stop() {
      if (!child) return false;
      const owned = child;
      child = null;
      try { owned.kill?.(); } catch (cause) { onError(cause); }
      return true;
    },
  };
}

function showPhoneAccess({ baseUrl, token, rendezvous, label, log, onError, qrGenerate }) {
  log(`${label}: ${baseUrl}`);
  log("Scan this QR code with your phone:");
  const phoneUrl = buildPhoneUrl(baseUrl, token, rendezvous?.url, rendezvous?.deviceId);
  try {
    qrGenerate(phoneUrl, { small: true }, (code) => log(code));
  } catch (cause) {
    let detail = String(cause?.message || cause || "unknown QR renderer error");
    if (phoneUrl) detail = detail.replaceAll(phoneUrl, "[redacted]");
    if (token) detail = detail.replaceAll(token, "[redacted]");
    onError(`[qr] QR code rendering failed; the service is still running: ${detail}`);
  }
}

async function cleanupStartupFailure(cause, resources) {
  const failures = [];
  const attempt = async (operation) => {
    try { await operation(); } catch (error) { failures.push(error); }
  };
  if (resources.remote) await attempt(() => resources.remote.close?.());
  if (resources.artifactTickets) await attempt(() => resources.artifactTickets.close?.());
  if (resources.windowsRemote) {
    await attempt(() => {
      const close = resources.windowsRemote.close ?? resources.windowsRemote.stop;
      return typeof close === "function" ? close.call(resources.windowsRemote) : undefined;
    });
  }
  if (resources.adapter && !resources.adapterOwnedByRemote) {
    await attempt(() => resources.adapter.stop?.());
  } else if (!resources.adapter && resources.codexProcess) {
    await attempt(() => resources.codexProcess.stop?.());
  }
  if (resources.artifactTracker) await attempt(() => resources.artifactTracker.close?.());
  if (resources.artifactStore) await attempt(() => resources.artifactStore.close?.());
  if (failures.length) {
    throw new AggregateError([cause, ...failures], "Codex Remote startup failed", { cause });
  }
  throw cause;
}

export async function main(options = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    platform = process.platform,
    installSignalHandlers = true,
    loadConfigImpl = loadConfig,
    createCodexProcess = (settings) => new CodexProcess(settings),
    createAdapter = (settings) => new CodexAdapter(settings),
    createArtifactStore = (settings) => ArtifactStore.open(settings),
    createArtifactTracker = (settings) => new ArtifactTracker(settings),
    createArtifactTickets = (settings) => new ArtifactTicketStore(settings),
    createWindowsRemote = (settings) => new WindowsRemote(settings),
    createRemoteServerImpl = createRemoteServer,
    createTunnel = (settings) => new TunnelManager(settings),
    createKeepAwake = (settings) => createWindowsKeepAwake(settings),
    qrGenerate = qrTerminal.generate.bind(qrTerminal),
    qrToDataUrl = (url) => qrImage.toDataURL(url, { width: 360, margin: 2 }),
    createPanelSessionImpl = createPanelSession,
    checkCodexLoginStatusImpl = checkCodexLoginStatus,
  } = options;

  const diagnostics = [];
  let configuredToken = null;
  function reportDiagnostic(scope, cause) {
    let detail = String(cause?.message || cause || "unknown error");
    if (configuredToken) detail = detail.replaceAll(configuredToken, "[redacted]");
    if (env.USERPROFILE) detail = detail.replaceAll(env.USERPROFILE, "%USERPROFILE%");
    detail = detail
      .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
      .slice(0, 240);
    const line = `[${scope}] ${detail}`;
    diagnostics.push(line);
    if (diagnostics.length > 20) diagnostics.splice(0, diagnostics.length - 20);
    error(line);
  }

  const sourceDir = path.resolve(env.CODEX_REMOTE_SOURCE_DIR?.trim() || projectDir);
  const configFile = path.resolve(env.CODEX_REMOTE_CONFIG?.trim() || path.join(projectDir, "config.json"));
  const config = loadConfigImpl({ file: configFile, env });
  configuredToken = config.token;
  const artifactRoot = path.join(env.LOCALAPPDATA || os.tmpdir(), "CodexRemote", "artifacts");
  let artifactStore = null;
  let artifactTracker = null;
  let codexProcess = null;
  let adapter = null;
  let windowsRemote = null;
  let artifactTickets = null;
  let remote = null;
  let panelSession = null;
  let phoneBaseUrl = null;
  let tunnel = null;
  let keepAwake = null;
  let tunnelOrigin = null;
  let codexStatus = "checking";
  let adapterOwnedByRemote = false;
  try {
    artifactStore = await createArtifactStore({ root: artifactRoot });
    artifactTracker = createArtifactTracker({
      store: artifactStore,
      onError: (cause) => reportDiagnostic("artifacts", cause),
    });
    let recoveredArtifacts = [];
    try {
      recoveredArtifacts = await artifactTracker.recoverPendingTurns();
    } catch (cause) {
      reportDiagnostic("artifacts", cause);
    }
    for (const recovery of recoveredArtifacts ?? []) {
      if (recovery?.recovered !== false) continue;
      const detail = recovery.diagnostics?.[0]?.message || "A pending artifact turn could not be recovered.";
      reportDiagnostic("artifacts", detail);
    }
    codexProcess = createCodexProcess({ packageBin: resolvePackageBin(), env });
    adapter = createAdapter({
      process: codexProcess,
      artifactTracker,
      cwd: config.cwd,
      model: config.model,
      effort: config.effort,
      onError: (cause) => reportDiagnostic("adapter", cause),
    });
    windowsRemote = platform === "win32"
      ? createWindowsRemote({ projectDir: sourceDir, platform, onError: (cause) => reportDiagnostic("desktop", cause) })
      : null;
    void checkCodexLoginStatusImpl({ env, packageBin: codexProcess.packageBin, platform })
      .then((status) => { codexStatus = status; }, () => { codexStatus = "unknown"; });
    panelSession = createPanelSessionImpl({
      stateProvider: () => ({
        serviceStatus: "online",
        uptimeMs: Math.round(process.uptime() * 1_000),
        lanOrigin: phoneBaseUrl,
        tunnelOrigin,
        codexStatus,
        appServerStatus: adapter.appServerStatus ?? "starting",
        threadDisplayId: adapter.threadId ?? null,
        workspace: adapter.cwd ?? config.cwd,
        tools: { ffmpeg: Boolean(windowsRemote?.ffmpeg), cloudflared: Boolean(tunnel?.binary) },
        diagnostics,
      }),
      connectionProvider: async () => {
        if (!phoneBaseUrl) throw new Error("phone URL is not ready");
        return buildPhoneUrl(
          tunnelOrigin || phoneBaseUrl,
          config.token,
          config.rendezvous?.url,
          config.rendezvous?.deviceId,
        );
      },
      qrToDataUrl,
    });
    artifactTickets = createArtifactTickets({});
    remote = await createRemoteServerImpl({
      adapter,
      artifactStore,
      artifactTracker,
      artifactTickets,
      token: config.token,
      host: env.CODEX_REMOTE_HOST || "0.0.0.0",
      port: config.port,
      publicDir: path.join(sourceDir, "public"),
      windowsRemote,
      panelSession,
      ownAdapter: true,
      onAdapterOwnership: () => { adapterOwnedByRemote = true; },
      onError: (cause) => reportDiagnostic("server", cause),
    });
  } catch (cause) {
    await cleanupStartupFailure(cause, {
      artifactStore,
      artifactTracker,
      codexProcess,
      adapter,
      windowsRemote,
      artifactTickets,
      remote,
      adapterOwnedByRemote,
    });
  }

  log(`Codex Remote is running at ${remote.httpUrl}`);
  try {
    keepAwake = createKeepAwake({ platform, onError: (cause) => reportDiagnostic("power", cause) });
    keepAwake?.start?.();
  } catch (cause) {
    reportDiagnostic("power", cause);
    keepAwake = null;
  }
  phoneBaseUrl = selectPhoneBaseUrl({ env, port: remote.address.port });
  log(`Desktop panel: ${panelSession.panelUrl(remote.httpUrl)}`);
  showPhoneAccess({
    baseUrl: phoneBaseUrl,
    token: config.token,
    rendezvous: config.rendezvous,
    label: "Phone base URL",
    log,
    onError: (cause) => reportDiagnostic("qr", cause),
    qrGenerate,
  });

  let tunnelListener = null;
  let shownTunnelUrl = null;
  if (isTunnelEnabled(env)) {
    try {
      tunnel = createTunnel({
        projectDir: sourceDir,
        port: remote.address.port,
        token: config.token,
        rendezvous: config.rendezvous,
        onError: (cause) => reportDiagnostic("tunnel", cause),
      });
      tunnelListener = (status) => {
        tunnelOrigin = status?.state === "online" && status.url ? status.url : null;
        const event = { type: "tunnel", ...status };
        remote.broadcast?.(event);
        if (status?.state === "online" && status.url && status.url !== shownTunnelUrl) {
          shownTunnelUrl = status.url;
          showPhoneAccess({
            baseUrl: status.url,
            token: config.token,
            rendezvous: config.rendezvous,
            label: "Tunnel base URL",
            log,
            onError: (cause) => reportDiagnostic("qr", cause),
            qrGenerate,
          });
        }
      };
      tunnel.on?.("status", tunnelListener);
      try {
        const starting = tunnel.start?.();
        if (starting && typeof starting.catch === "function") {
          void starting.catch((cause) => reportDiagnostic("tunnel", cause));
        }
      } catch (cause) {
        reportDiagnostic("tunnel", cause);
      }
    } catch (cause) {
      reportDiagnostic("tunnel", cause);
      tunnel = null;
      tunnelListener = null;
    }
  }

  let closing = null;
  let shutdown = null;
  const removeSignalHandlers = () => {
    if (!shutdown || !installSignalHandlers) return;
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
  const close = () => {
    closing ??= (async () => {
      removeSignalHandlers();
      if (tunnel && tunnelListener) tunnel.off?.("status", tunnelListener);
      const failures = [];
      try { await tunnel?.stop?.(); } catch (cause) { failures.push(cause); }
      try { await keepAwake?.stop?.(); } catch (cause) { failures.push(cause); }
      try { await remote.close(); } catch (cause) { failures.push(cause); }
      try { await artifactTickets.close?.(); } catch (cause) { failures.push(cause); }
      try { await artifactTracker.close(); } catch (cause) { failures.push(cause); }
      try { await artifactStore.close?.(); } catch (cause) { failures.push(cause); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Codex Remote shutdown failed");
    })();
    return closing;
  };
  shutdown = (signal) => {
    log(`Received ${signal}; stopping Codex Remote...`);
    void close().then(
      () => { process.exitCode = 0; },
      (cause) => { error(cause); process.exitCode = 1; },
    );
  };
  remote.once?.("shutdownRequested", () => shutdown("panel"));
  if (installSignalHandlers) {
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return { ...remote, tunnel, windowsRemote, keepAwake, close };
}

const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((cause) => {
    console.error(`Codex Remote failed to start: ${cause?.message || cause}`);
    process.exitCode = 1;
  });
}
