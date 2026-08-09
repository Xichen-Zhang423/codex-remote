import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

function redactDefault(value) {
  return String(value)
    .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

function sameSecret(expected, actual) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createPanelSession({
  randomBytes = nodeRandomBytes,
  now = Date.now,
  stateProvider = () => ({}),
  connectionProvider,
  qrToDataUrl,
  redact = redactDefault,
} = {}) {
  if (typeof connectionProvider !== "function") throw new TypeError("connectionProvider is required");
  if (typeof qrToDataUrl !== "function") throw new TypeError("qrToDataUrl is required");
  const key = randomBytes(32).toString("base64url");
  const sanitizeDiagnostic = (value) => redact(String(value)).slice(0, 500);
  return {
    key,
    authorize: (value) => sameSecret(key, value),
    panelUrl(baseUrl) {
      const url = new URL("panel.html", `${String(baseUrl).replace(/\/+$/, "")}/`);
      url.hash = `panel=${encodeURIComponent(key)}`;
      return url.toString();
    },
    sanitizeDiagnostic,
    state() {
      const source = stateProvider() ?? {};
      return {
        serviceStatus: source.serviceStatus ?? "unknown",
        uptimeMs: Math.max(0, Number(source.uptimeMs) || 0),
        lanOrigin: source.lanOrigin ?? null,
        tunnelOrigin: source.tunnelOrigin ?? null,
        codexStatus: source.codexStatus ?? "unknown",
        appServerStatus: source.appServerStatus ?? "unknown",
        threadDisplayId: source.threadDisplayId ?? null,
        workspace: source.workspace ?? null,
        tools: source.tools && typeof source.tools === "object" ? { ...source.tools } : {},
        diagnostics: (Array.isArray(source.diagnostics) ? source.diagnostics : [])
          .slice(-20).map(sanitizeDiagnostic),
      };
    },
    async createConnection(mode = "remote") {
      if (mode !== "remote" && mode !== "lan") {
        const error = new Error("invalid connection mode");
        error.code = "PANEL_CONNECTION_MODE";
        throw error;
      }
      const copyUrl = String(await connectionProvider(mode));
      const display = new URL(copyUrl);
      const secret = display.searchParams.get("token") || "";
      if (display.searchParams.has("token")) display.searchParams.set("token", "••••••");
      try {
        return {
          displayUrl: display.toString(), copyUrl,
          qrDataUrl: await qrToDataUrl(copyUrl), qrError: null, expiresAt: now() + 300_000,
        };
      } catch (error) {
        const diagnostic = sanitizeDiagnostic(error?.message || error);
        const qrError = secret ? diagnostic.replaceAll(secret, "[redacted]") : diagnostic;
        return { displayUrl: display.toString(), copyUrl, qrDataUrl: null, qrError, expiresAt: now() + 300_000 };
      }
    },
  };
}
