const DEFAULT_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_400;
const MAX_BODY_BYTES = 4_096;
const KNOWN_PATHS = new Set(["/", "/current", "/publish"]);

const COMMON_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "cache-control": "no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...COMMON_HEADERS, ...extraHeaders },
  });
}

function ttlSeconds(env) {
  const configured = Number.parseInt(env.RENDEZVOUS_TTL_SECONDS, 10);
  if (!Number.isFinite(configured)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, configured));
}

export function normalizeTunnelUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    const validHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+trycloudflare\.com$/i
      .test(url.hostname);
    if (url.protocol !== "https:"
      || !validHost
      || url.username
      || url.password
      || url.port
      || url.pathname !== "/"
      || url.search
      || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeDeviceId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return null;
  return value;
}

function resolveDeviceId(provided, env) {
  const configured = env.DEVICE_ID == null || env.DEVICE_ID === ""
    ? null
    : normalizeDeviceId(env.DEVICE_ID);
  if (env.DEVICE_ID && !configured) return { error: "misconfigured" };
  if (provided != null && provided !== "") {
    const requested = normalizeDeviceId(provided);
    if (!requested) return { error: "invalid" };
    if (configured && requested !== configured) return { error: "mismatch" };
    return { value: configured || requested };
  }
  return { value: configured || "default" };
}

function storage(env) {
  return env.RZ
    && typeof env.RZ.get === "function"
    && typeof env.RZ.put === "function"
    ? env.RZ
    : null;
}

async function publish(request, env) {
  if (!storage(env) || typeof env.PUBLISH_SECRET !== "string" || !env.PUBLISH_SECRET) {
    return json({ error: "service unavailable" }, 503);
  }
  if (request.headers.get("authorization") !== `Bearer ${env.PUBLISH_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "content type must be application/json" }, 415);
  }
  const contentLength = Number.parseInt(request.headers.get("content-length"), 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: "request body too large" }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid request" }, 400);
  }
  const keys = Object.keys(body);
  if (!keys.includes("url") || keys.some((key) => key !== "url" && key !== "deviceId")) {
    return json({ error: "invalid request fields" }, 400);
  }
  const tunnelUrl = normalizeTunnelUrl(body.url);
  if (!tunnelUrl) return json({ error: "invalid tunnel URL" }, 400);
  const device = resolveDeviceId(body.deviceId, env);
  if (device.error === "misconfigured") return json({ error: "service unavailable" }, 503);
  if (device.error === "mismatch") return json({ error: "device mismatch" }, 403);
  if (device.error) return json({ error: "invalid deviceId" }, 400);

  const now = Date.now();
  const ttl = ttlSeconds(env);
  const record = { url: tunnelUrl, at: now, deviceId: device.value };
  await env.RZ.put(`current:${device.value}`, JSON.stringify(record), { expirationTtl: ttl });
  return json({ ok: true });
}

function getQueryDevice(url) {
  for (const key of url.searchParams.keys()) {
    if (key !== "deviceId") return { error: true };
  }
  const values = url.searchParams.getAll("deviceId");
  if (values.length > 1) return { error: true };
  return { value: values[0] };
}

async function current(requestUrl, env) {
  if (!storage(env)) return json({ error: "service unavailable" }, 503);
  const query = getQueryDevice(requestUrl);
  if (query.error) return json({ error: "invalid query" }, 400);
  const device = resolveDeviceId(query.value, env);
  if (device.error === "misconfigured") return json({ error: "service unavailable" }, 503);
  if (device.error === "mismatch") return json({ error: "device mismatch" }, 403);
  if (device.error) return json({ error: "invalid deviceId" }, 400);

  const raw = await env.RZ.get(`current:${device.value}`);
  if (!raw) return json({ url: null }, 404);
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return json({ url: null }, 404);
  }
  const normalized = normalizeTunnelUrl(record?.url);
  const maxAgeMs = ttlSeconds(env) * 1_000;
  if (!normalized
    || record.deviceId !== device.value
    || !Number.isFinite(record.at)
    || record.at > Date.now() + 60_000
    || Date.now() - record.at > maxAgeMs) {
    return json({ url: null }, 404);
  }
  return json({ url: normalized, at: record.at });
}

function methodNotAllowed(allow) {
  return json({ error: "method not allowed" }, 405, { allow });
}

export default {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return json({ error: "bad request" }, 400);
    }
    if (!KNOWN_PATHS.has(url.pathname)) return json({ error: "not found" }, 404);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: COMMON_HEADERS });
    }
    if (url.pathname === "/publish") {
      if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS");
      if (url.search) return json({ error: "invalid query" }, 400);
      return publish(request, env);
    }
    if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS");
    return current(url, env);
  },
};
