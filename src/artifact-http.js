import fs from "node:fs";

import { previewKindForRecord } from "./artifact-mime.js";

function rangeError() {
  return Object.assign(new Error("invalid_range"), { statusCode: 416 });
}

export function parseSingleRange(value, size) {
  if (value == null) return null;
  if (!Number.isSafeInteger(size) || size < 0 || typeof value !== "string" || value.includes(",")) {
    throw rangeError();
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw rangeError();

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1 || size === 0) throw rangeError();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || start >= size
      || end < start) {
    throw rangeError();
  }
  return { start, end: Math.min(end, size - 1) };
}

function contentDisposition(kind, displayName) {
  const clean = String(displayName || "artifact")
    .replace(/[\u0000-\u001f\u007f"\\/]/g, "_")
    .slice(0, 180) || "artifact";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function setArtifactHeaders(response, record, disposition) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Content-Disposition, Accept-Ranges",
  );
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("Content-Type", record.mime);
  response.setHeader("Content-Disposition", disposition);
}

function releaseOnce(lease) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const result = lease.release();
      if (result && typeof result.then === "function") result.catch(() => {});
    } catch {
      // A failed cleanup callback must not destabilize the response lifecycle.
    }
  };
}

function streamGrantedArtifact({ request, response, lease, grant, release }) {
  response.once("finish", release);
  response.once("close", release);
  response.once("error", release);

  const safeInline = grant.purpose === "preview"
    && lease.record.state === "ready"
    && Boolean(previewKindForRecord(lease.record));
  const disposition = contentDisposition(
    safeInline ? "inline" : "attachment",
    lease.record.displayName,
  );
  setArtifactHeaders(response, lease.record, disposition);

  let range;
  try {
    range = parseSingleRange(request.headers.range, lease.size);
  } catch {
    response.setHeader("Content-Range", `bytes */${lease.size}`);
    response.status(416);
    release();
    return response.end();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? lease.size - 1;
  const length = lease.size === 0 ? 0 : end - start + 1;
  response.status(range ? 206 : 200);
  response.setHeader("Content-Length", String(length));
  if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${lease.size}`);

  if (request.method === "HEAD" || lease.size === 0) {
    release();
    return response.end();
  }

  const stream = fs.createReadStream(lease.path, { start, end });
  stream.once("error", (error) => {
    release();
    if (!response.destroyed) response.destroy(error);
  });
  response.once("close", () => {
    if (!stream.destroyed) stream.destroy();
  });
  return stream.pipe(response);
}

export function createArtifactContentHandler({ store, tickets } = {}) {
  if (!store || typeof store.get !== "function" || typeof store.openContent !== "function") {
    throw new TypeError("store must provide get and openContent");
  }
  if (!tickets || typeof tickets.consume !== "function") {
    throw new TypeError("tickets must provide consume");
  }

  return async function artifactContent(request, response) {
    let lease;
    let release;
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return response.status(405).json({ error: "method_not_allowed" });
      }
      const artifactId = request.params.artifactId;
      const token = request.query.ticket;
      if (typeof artifactId !== "string" || artifactId.length === 0 || typeof token !== "string") {
        return response.status(401).json({ error: "artifact_access_denied" });
      }
      const record = store.get(artifactId);
      if (!record || typeof record.sha256 !== "string" || record.sha256.length === 0) {
        return response.status(401).json({ error: "artifact_access_denied" });
      }
      const grant = tickets.consume(token, { artifactId, sha256: record.sha256 });
      if (!grant) return response.status(401).json({ error: "artifact_access_denied" });

      lease = await store.openContent(artifactId);
      release = releaseOnce(lease);
      return streamGrantedArtifact({ request, response, lease, grant, release });
    } catch (error) {
      release?.();
      if (response.headersSent) {
        if (!response.destroyed) response.destroy(error);
        return undefined;
      }
      return response.status(error?.statusCode ?? 404).json({
        error: error?.message === "invalid_range" ? "invalid_range" : "artifact_unavailable",
      });
    }
  };
}
