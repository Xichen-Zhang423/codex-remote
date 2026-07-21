import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { classifyArtifact } from "./artifact-mime.js";

const MiB = 1024 * 1024;
const DEFAULTS = Object.freeze({
  maxFileBytes: 256 * MiB,
  maxTurnBytes: 1024 * MiB,
  maxVaultBytes: 2 * 1024 * MiB,
});
const PENDING_PROVENANCE = new Set(["watch", "appServer"]);
const MAX_RELATIVE_PATH = 32_768;
const MAX_PENDING_HINTS = 10_000;
const MAX_CLEANUP_DIRECTORIES = 10_000;
const MAX_CLEANUP_ENTRIES = 100_000;
const MAX_EXACT_EVICTION_ENTRIES = 1_024;

class TooLargeError extends Error {
  constructor(size) {
    super("artifact exceeds configured byte limit");
    this.size = size;
  }
}

class ArtifactSourceError extends Error {
  constructor(code, message, { size = 0 } = {}) {
    super(message);
    this.code = code;
    this.size = size;
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function managedFiles(root, { maxDirectories, maxEntries }) {
  const files = [];
  const queue = [root];
  let visitedEntries = 0;
  let limited = false;
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    if (queueIndex >= maxDirectories) {
      limited = true;
      break;
    }
    const directory = queue[queueIndex];
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (visitedEntries >= maxEntries) {
        limited = true;
        return { files, limited };
      }
      visitedEntries += 1;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  return { files, limited };
}

async function jsonFiles(root, limits) {
  const result = await managedFiles(root, limits);
  return {
    files: result.files.filter((file) => file.endsWith(".json")),
    limited: result.limited,
  };
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function validateSegments(workspaceRealPath, normalizedRelativePath) {
  const segments = normalizedRelativePath.split("/");
  let candidate = workspaceRealPath;
  let stats;
  for (let index = 0; index < segments.length; index += 1) {
    candidate = path.join(candidate, segments[index]);
    try {
      stats = await fs.lstat(candidate, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        throw new ArtifactSourceError("artifact_source_changed", "artifact source is unavailable");
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new ArtifactSourceError("blocked_link", "artifact source contains a link", {
        size: Number(stats.size),
      });
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new ArtifactSourceError("blocked_parent", "artifact source parent is not a directory");
    }
  }
  if (!stats.isFile()) {
    throw new ArtifactSourceError("blocked_not_file", "artifact source is not a regular file", {
      size: Number(stats.size),
    });
  }
  let real;
  try {
    real = await fs.realpath(candidate);
  } catch (error) {
    throw new ArtifactSourceError("artifact_source_changed", "artifact source changed", {
      size: Number(stats.size),
    });
  }
  if (!isWithin(workspaceRealPath, real)) {
    throw new ArtifactSourceError("blocked_escape", "artifact source escapes workspace", {
      size: Number(stats.size),
    });
  }
  return { sourcePath: candidate, stats };
}

async function copyAndHash(source, temporaryPath, maxBytes, initialStats, revalidate) {
  let destination;
  let size = 0;
  const hash = crypto.createHash("sha256");
  const headChunks = [];
  let headBytes = 0;
  try {
    destination = await fs.open(temporaryPath, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new TooLargeError(size);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (headBytes < 8192) {
        const piece = Buffer.from(chunk.subarray(0, 8192 - headBytes));
        headChunks.push(piece);
        headBytes += piece.length;
      }
      let written = 0;
      while (written < chunk.length) {
        const result = await destination.write(chunk, written, chunk.length - written, null);
        written += result.bytesWritten;
      }
    }
    const finalOpenedStats = await source.stat({ bigint: true });
    const finalPathStats = await revalidate();
    if (!sameIdentity(initialStats, finalOpenedStats)
        || !sameIdentity(initialStats, finalPathStats)
        || BigInt(size) !== initialStats.size) {
      throw new ArtifactSourceError("artifact_source_changed", "artifact source changed during copy", {
        size,
      });
    }
    await destination.sync();
    await destination.close();
    destination = null;
    return { size, sha256: hash.digest("hex"), head: Buffer.concat(headChunks) };
  } catch (error) {
    await destination?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readHead(filePath, size) {
  const handle = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(8192, size));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashHandle(handle) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
  }
  return hash.digest("hex");
}

async function hashFile(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    return await hashHandle(handle);
  } finally {
    await handle.close();
  }
}

async function cleanupTemporaryFiles(root, limits) {
  const result = await managedFiles(root, limits);
  for (const filePath of result.files) {
    const lower = path.basename(filePath).toLowerCase();
    if (lower.endsWith(".part") || lower.endsWith(".tmp")) {
      await fs.rm(filePath, { force: true });
    }
  }
  return result.limited;
}

function evictionOriginalPath(trashPath) {
  const match = /^\.(.+)\.([a-f0-9]{16})\.evicting$/i.exec(path.basename(trashPath));
  return match ? path.join(path.dirname(trashPath), match[1]) : null;
}

async function restoreExactStagedEviction(objectRoot, objectPath, record) {
  const parentPath = path.dirname(objectPath);
  if (!isWithin(objectRoot, parentPath)) return false;
  try {
    const parentStats = await fs.lstat(parentPath);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) return false;
    if (!isWithin(objectRoot, await fs.realpath(parentPath))) return false;
  } catch {
    return false;
  }
  let directory;
  try {
    directory = await fs.opendir(parentPath);
    for (let visited = 0; visited < MAX_EXACT_EVICTION_ENTRIES; visited += 1) {
      const entry = await directory.read();
      if (!entry) return false;
      if (!entry.isFile()) continue;
      const candidatePath = path.join(parentPath, entry.name);
      const candidateOriginal = evictionOriginalPath(candidatePath);
      if (!candidateOriginal || !samePath(candidateOriginal, objectPath)) continue;
      let handle;
      try {
        const candidateStats = await fs.lstat(candidatePath, { bigint: true });
        if (!candidateStats.isFile()
            || candidateStats.isSymbolicLink()
            || candidateStats.size !== BigInt(record.size)) continue;
        const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
        handle = await fs.open(candidatePath, flags);
        const openedStats = await handle.stat({ bigint: true });
        if (!sameIdentity(candidateStats, openedStats)
            || await hashHandle(handle) !== record.sha256) continue;
      } catch {
        continue;
      } finally {
        await handle?.close().catch(() => {});
      }
      try {
        await fs.rename(candidatePath, objectPath);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    await directory?.close().catch((error) => {
      if (error.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
}

async function quarantineFile(root, filePath) {
  const quarantinePath = path.join(
    root,
    "quarantine",
    `${crypto.randomBytes(8).toString("hex")}-${path.basename(filePath)}`,
  );
  await fs.rename(filePath, quarantinePath);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateManifestShape(manifest) {
  if (!isPlainObject(manifest)
      || manifest.version !== 1
      || typeof manifest.threadId !== "string" || !manifest.threadId || manifest.threadId.includes("\0")
      || typeof manifest.turnId !== "string" || !manifest.turnId || manifest.turnId.includes("\0")
      || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1
      || !Number.isSafeInteger(manifest.startedRevision) || manifest.startedRevision < 1
      || manifest.startedRevision > manifest.revision
      || !Array.isArray(manifest.records)
      || typeof manifest.settled !== "boolean"
      || !(manifest.completedRevision === null
        || (Number.isSafeInteger(manifest.completedRevision)
          && manifest.completedRevision >= manifest.startedRevision
          && manifest.completedRevision <= manifest.revision))
      || (manifest.settled && manifest.completedRevision === null)
      || (!manifest.settled && manifest.completedRevision !== null)
      || typeof manifest.complete !== "boolean"
      || !Array.isArray(manifest.diagnostics)
      || !isPlainObject(manifest.private)
      || !isPlainObject(manifest.private.objects)
      || !isPlainObject(manifest.private.lastAccessedAt)
      || Object.hasOwn(manifest, "workspaceRealPath")
      || Object.hasOwn(manifest, "objects")
      || Object.hasOwn(manifest, "lastAccessedAt")) {
    throw new TypeError("invalid artifact manifest");
  }
  absoluteIdentity(manifest.private.workspaceRealPath, "manifest.private.workspaceRealPath");
  for (const objectPath of Object.values(manifest.private.objects)) {
    absoluteIdentity(objectPath, "manifest.private.objects value");
  }
  for (const accessedAt of Object.values(manifest.private.lastAccessedAt)) {
    if (!Number.isFinite(accessedAt)) throw new TypeError("invalid artifact manifest access time");
  }
}

function publicRecord(record) {
  return {
    id: record.id,
    revision: record.revision,
    threadId: record.threadId,
    turnId: record.turnId,
    relativePath: record.relativePath,
    displayName: record.displayName,
    kind: record.kind,
    provenance: record.provenance,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    state: record.state,
    detectedAt: record.detectedAt,
  };
}

function publicTurn(manifest) {
  return {
    version: manifest.version,
    threadId: manifest.threadId,
    turnId: manifest.turnId,
    revision: manifest.revision,
    startedRevision: manifest.startedRevision,
    records: manifest.records.map(publicRecord),
    settled: manifest.settled,
    completedRevision: manifest.completedRevision,
    complete: manifest.complete,
    diagnostics: structuredClone(manifest.diagnostics),
  };
}

function deduplicatedDiagnostics(...groups) {
  const result = [];
  const seen = new Set();
  for (const group of groups) {
    for (const diagnostic of Array.isArray(group) ? group : []) {
      const cloned = structuredClone(diagnostic);
      const key = JSON.stringify(cloned);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(cloned);
    }
  }
  return result;
}

function relativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RELATIVE_PATH) {
    throw new TypeError("relative path is required and must be at most 32768 characters");
  }
  if (value.includes("\0")
      || path.isAbsolute(value)
      || /^(?:[a-z]:|[/\\]{2}|[/\\]\\[?.]\\)/i.test(value)) {
    throw new TypeError("relative path must be safe");
  }
  const slash = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slash);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new TypeError("relative path escapes root");
  }
  for (const segment of normalized.split("/")) {
    if (!segment || segment.includes(":")) throw new TypeError("relative path must be safe");
    const device = segment.replace(/[ .]+$/u, "").split(".")[0];
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(device)) {
      throw new TypeError("relative path must not use a Windows device name");
    }
  }
  return normalized;
}

function absoluteIdentity(value, name) {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute normalized path`);
  }
  const normalized = path.normalize(value);
  const resolved = path.resolve(value);
  if (value.toLowerCase() !== normalized.toLowerCase()
      || normalized.toLowerCase() !== resolved.toLowerCase()) {
    throw new TypeError(`${name} must be an absolute normalized path`);
  }
  return resolved;
}

function serializeBaseline(baseline, workspaceRealPath) {
  if (!baseline || typeof baseline !== "object") throw new TypeError("baseline is required");
  if (!(baseline.entries instanceof Map) || !(baseline.coveredDirectories instanceof Set)) {
    throw new TypeError("baseline entries and coveredDirectories must be Map and Set");
  }
  const root = absoluteIdentity(baseline.root, "baseline.root");
  if (root.toLowerCase() !== workspaceRealPath.toLowerCase()) {
    throw new TypeError("baseline.root must match handle.workspaceRealPath");
  }
  return {
    root,
    entries: [...baseline.entries].map(([name, value]) => [relativePath(name), structuredClone(value)]),
    coveredDirectories: [...baseline.coveredDirectories].map((name) => (
      name === "." ? "." : relativePath(name)
    )),
    partial: Boolean(baseline.partial),
    reasons: Array.isArray(baseline.reasons) ? structuredClone(baseline.reasons) : [],
    counters: baseline.counters && typeof baseline.counters === "object"
      ? structuredClone(baseline.counters)
      : {},
  };
}

function hydrateBaseline(baseline, workspaceRealPath) {
  if (!baseline || typeof baseline !== "object"
      || !Array.isArray(baseline.entries)
      || !Array.isArray(baseline.coveredDirectories)) {
    throw new TypeError("invalid pending baseline");
  }
  const root = absoluteIdentity(baseline.root, "baseline.root");
  if (root.toLowerCase() !== workspaceRealPath.toLowerCase()) {
    throw new TypeError("baseline.root must match handle.workspaceRealPath");
  }
  return {
    root,
    entries: new Map(baseline.entries.map(([name, value]) => [relativePath(name), structuredClone(value)])),
    coveredDirectories: new Set(baseline.coveredDirectories.map((name) => (
      name === "." ? "." : relativePath(name)
    ))),
    partial: Boolean(baseline.partial),
    reasons: Array.isArray(baseline.reasons) ? structuredClone(baseline.reasons) : [],
    counters: baseline.counters && typeof baseline.counters === "object"
      ? structuredClone(baseline.counters)
      : {},
  };
}

function hintEntries(hints) {
  if (hints instanceof Map || Array.isArray(hints)) return hints;
  const entries = [];
  for (const provenance of PENDING_PROVENANCE) {
    for (const relative of Array.isArray(hints?.[provenance]) ? hints[provenance] : []) {
      entries.push([relative, [provenance]]);
    }
  }
  return entries;
}

function sanitizeHints(hints, { strict }) {
  const sanitized = new Map();
  for (const entry of hintEntries(hints)) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      if (strict) throw new TypeError("hint entries must be [relativePath, provenanceSet]");
      continue;
    }
    let normalized;
    try {
      normalized = relativePath(entry[0]);
    } catch (error) {
      if (strict) throw error;
      continue;
    }
    const sources = entry[1] instanceof Set ? entry[1] : Array.isArray(entry[1]) ? entry[1] : [];
    const accepted = new Set();
    for (const source of sources) {
      if (PENDING_PROVENANCE.has(source)) accepted.add(source);
      else if (strict) throw new TypeError("invalid hint provenance");
    }
    if (accepted.size === 0) continue;
    if (!sanitized.has(normalized) && sanitized.size >= MAX_PENDING_HINTS) break;
    const bucket = sanitized.get(normalized) ?? new Set();
    for (const source of accepted) bucket.add(source);
    sanitized.set(normalized, bucket);
  }
  return sanitized;
}

function normalizeHandle(handle, { legacy = false } = {}) {
  if (!handle || typeof handle !== "object") throw new TypeError("pending handle is required");
  const workspaceRealPath = absoluteIdentity(handle.workspaceRealPath, "handle.workspaceRealPath");
  const localTaskId = requiredString(handle.localTaskId, "localTaskId");
  const threadId = handle.threadId ?? null;
  const turnId = handle.turnId ?? null;
  if (!legacy && (typeof threadId !== "string" || !threadId)) throw new TypeError("handle.threadId is required");
  if (threadId !== null && (typeof threadId !== "string" || !threadId)) throw new TypeError("handle.threadId is invalid");
  if (turnId !== null && (typeof turnId !== "string" || !turnId)) throw new TypeError("handle.turnId is invalid");
  const cwdGeneration = handle.cwdGeneration ?? 0;
  if (!Number.isSafeInteger(cwdGeneration) || cwdGeneration < 0) throw new TypeError("handle.cwdGeneration is invalid");
  const startedAt = handle.startedAt;
  if (!Number.isFinite(startedAt)) throw new TypeError("handle.startedAt is required");
  return { localTaskId, threadId, turnId, workspaceRealPath, cwdGeneration, startedAt };
}

function cloneHandle(handle) {
  return { ...handle };
}

function clonePending(pending) {
  return {
    handle: cloneHandle(pending.handle),
    baseline: hydrateBaseline(
      serializeBaseline(pending.baseline, pending.handle.workspaceRealPath),
      pending.handle.workspaceRealPath,
    ),
    hints: sanitizeHints(pending.hints, { strict: true }),
  };
}

function persistedPending(pending) {
  return {
    version: 1,
    handle: cloneHandle(pending.handle),
    baseline: serializeBaseline(pending.baseline, pending.handle.workspaceRealPath),
    hints: [...sanitizeHints(pending.hints, { strict: true })].map(([relative, sources]) => (
      [relative, [...sources]]
    )),
  };
}

function hydratedPending(value) {
  if (!value || typeof value !== "object") throw new TypeError("invalid pending turn");
  const legacy = !value.handle;
  if (legacy && !PENDING_PROVENANCE.has(value.provenance)) throw new TypeError("invalid pending provenance");
  const handle = normalizeHandle(value.handle ?? value, { legacy });
  return {
    handle,
    baseline: hydrateBaseline(value.baseline, handle.workspaceRealPath),
    hints: sanitizeHints(value.hints, { strict: false }),
  };
}

export class ArtifactStore {
  constructor({
    root,
    now = Date.now,
    maxFileBytes = DEFAULTS.maxFileBytes,
    maxTurnBytes = DEFAULTS.maxTurnBytes,
    maxVaultBytes = DEFAULTS.maxVaultBytes,
    maxTraversalDirectories = MAX_CLEANUP_DIRECTORIES,
    maxTraversalEntries = MAX_CLEANUP_ENTRIES,
    writeJson = atomicJson,
  } = {}) {
    if (typeof root !== "string" || root.length === 0) throw new TypeError("root is required");
    for (const [name, value] of Object.entries({ maxFileBytes, maxTurnBytes, maxVaultBytes })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
    }
    for (const [name, value] of Object.entries({ maxTraversalDirectories, maxTraversalEntries })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    if (typeof writeJson !== "function") throw new TypeError("writeJson must be a function");
    this.root = path.resolve(root);
    this.now = now;
    this.maxFileBytes = maxFileBytes;
    this.maxTurnBytes = maxTurnBytes;
    this.maxVaultBytes = maxVaultBytes;
    this.traversalLimits = { maxDirectories: maxTraversalDirectories, maxEntries: maxTraversalEntries };
    this.writeJson = writeJson;
    this.startupDiagnostics = [];
    this.records = new Map();
    this.manifests = new Map();
    this.threadRevisions = new Map();
    this.pending = new Map();
    this.pins = new Map();
    this.maxPendingTurns = 10_000;
    this.mutationQueue = Promise.resolve();
  }

  static async open(options) {
    const store = new ArtifactStore(options);
    await store.initialize();
    return store;
  }

  async initialize() {
    for (const name of ["manifests", "objects", "pending", "quarantine", "tmp"]) {
      await fs.mkdir(path.join(this.root, name), { recursive: true, mode: 0o700 });
    }
    for (const name of ["tmp", "manifests", "pending"]) {
      if (await cleanupTemporaryFiles(path.join(this.root, name), this.traversalLimits)) {
        this.noteTraversalLimit(name);
      }
    }
    const loadedManifests = [];
    const manifestFiles = await jsonFiles(path.join(this.root, "manifests"), this.traversalLimits);
    if (manifestFiles.limited) this.noteTraversalLimit("manifests");
    for (const manifestPath of manifestFiles.files) {
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        validateManifestShape(manifest);
        loadedManifests.push({ manifestPath, manifest });
        const currentRevision = this.threadRevisions.get(manifest.threadId) ?? 0;
        this.threadRevisions.set(manifest.threadId, Math.max(currentRevision, manifest.revision ?? 0));
      } catch {
        await quarantineFile(this.root, manifestPath).catch(() => {});
      }
    }
    const objectRoot = path.join(this.root, "objects");
    const readyObjectPaths = new Set();
    for (const { manifest } of loadedManifests) {
      for (const record of manifest.records) {
        const objectPath = manifest.private.objects?.[record.id];
        if (record.state === "ready"
            && typeof objectPath === "string"
            && path.isAbsolute(objectPath)
            && isWithin(objectRoot, path.resolve(objectPath))) {
          readyObjectPaths.add(path.normalize(path.resolve(objectPath)).toLowerCase());
        }
      }
    }
    const stagedEvictions = await managedFiles(objectRoot, this.traversalLimits);
    if (stagedEvictions.limited) this.noteTraversalLimit("objects");
    for (const trashPath of stagedEvictions.files) {
      const originalPath = evictionOriginalPath(trashPath);
      if (!originalPath) continue;
      const normalizedOriginal = path.normalize(path.resolve(originalPath)).toLowerCase();
      if (readyObjectPaths.has(normalizedOriginal)) {
        try {
          await fs.lstat(originalPath);
          await fs.rm(trashPath, { force: true });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await fs.rename(trashPath, originalPath);
        }
      } else if (!manifestFiles.limited) {
        await fs.rm(trashPath, { force: true });
      }
    }
    for (const { manifestPath, manifest } of loadedManifests) {
      let changed = false;
      const records = [];
      for (const persisted of manifest.records) {
        let record = publicRecord(persisted);
        if (record.state === "ready") {
          const objectPath = manifest.private.objects[record.id];
          let valid = typeof objectPath === "string"
            && path.isAbsolute(objectPath)
            && isWithin(objectRoot, path.resolve(objectPath));
          if (valid) {
            try {
              const stats = await fs.stat(objectPath);
              valid = stats.isFile()
                && Number(stats.size) === record.size
                && await hashFile(objectPath) === record.sha256;
            } catch (error) {
              const restored = stagedEvictions.limited
                && error.code === "ENOENT"
                && await restoreExactStagedEviction(objectRoot, objectPath, record);
              if (restored) {
                try {
                  const stats = await fs.stat(objectPath);
                  valid = stats.isFile()
                    && Number(stats.size) === record.size
                    && await hashFile(objectPath) === record.sha256;
                } catch {
                  valid = false;
                }
              } else {
                valid = false;
              }
            }
          }
          if (!valid) {
            record = { ...record, state: "failed" };
            changed = true;
          }
        }
        records.push(record);
      }
      if (changed) {
        manifest.records = records;
        manifest.revision = (this.threadRevisions.get(manifest.threadId) ?? 0) + 1;
        await this.writeJson(manifestPath, manifest);
        this.threadRevisions.set(manifest.threadId, manifest.revision);
      }
      this.manifests.set(manifestPath, manifest);
      for (const record of records) {
        this.records.set(record.id, {
          record: publicRecord(record),
          objectPath: record.state === "ready" ? manifest.private.objects?.[record.id] ?? null : null,
          manifestPath,
        });
      }
    }
    if (!manifestFiles.limited && !stagedEvictions.limited) {
      const referencedObjects = new Set();
      for (const { manifest } of loadedManifests) {
        for (const objectPath of Object.values(manifest.private.objects)) {
          if (typeof objectPath === "string"
              && path.isAbsolute(objectPath)
              && isWithin(objectRoot, path.resolve(objectPath))) {
            referencedObjects.add(path.normalize(path.resolve(objectPath)).toLowerCase());
          }
        }
      }
      const objectFiles = await managedFiles(objectRoot, this.traversalLimits);
      if (objectFiles.limited) this.noteTraversalLimit("objects");
      for (const objectPath of objectFiles.files) {
        if (objectPath.toLowerCase().endsWith(".blob")
            && !referencedObjects.has(path.normalize(path.resolve(objectPath)).toLowerCase())) {
          await quarantineFile(this.root, objectPath);
        }
      }
    }
    const pendingFiles = await jsonFiles(path.join(this.root, "pending"), this.traversalLimits);
    if (pendingFiles.limited) this.noteTraversalLimit("pending");
    for (const pendingPath of pendingFiles.files) {
      try {
        const pending = hydratedPending(JSON.parse(await fs.readFile(pendingPath, "utf8")));
        this.pending.set(pending.handle.localTaskId, { pending, pendingPath });
      } catch {
        await quarantineFile(this.root, pendingPath).catch(() => {});
      }
    }
  }

  noteTraversalLimit(tree) {
    if (!this.startupDiagnostics.some((item) => item.code === "startup_traversal_limit" && item.tree === tree)) {
      this.startupDiagnostics.push({ code: "startup_traversal_limit", tree });
    }
  }

  enqueue(operation) {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  manifestPath(workspaceRealPath, threadId, turnId) {
    return path.join(
      this.root,
      "manifests",
      digest(workspaceRealPath),
      digest(threadId),
      `${digest(turnId)}.json`,
    );
  }

  publishManifest(manifestPath, manifest) {
    this.threadRevisions.set(manifest.threadId, manifest.revision);
    this.manifests.set(manifestPath, manifest);
    for (const persisted of manifest.records) {
      const record = publicRecord(persisted);
      this.records.set(record.id, {
        record,
        objectPath: manifest.private.objects?.[record.id] ?? null,
        manifestPath,
      });
    }
  }

  async commitManifest(manifestPath, manifest) {
    await this.writeJson(manifestPath, manifest);
    this.publishManifest(manifestPath, manifest);
  }

  nextRevision(threadId) {
    return (this.threadRevisions.get(threadId) ?? 0) + 1;
  }

  pinLease(id) {
    const internal = this.records.get(id);
    if (!internal || internal.record.state !== "ready" || !internal.objectPath) {
      throw new Error("artifact content is unavailable");
    }
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    let releasePromise;
    return {
      record: publicRecord(internal.record),
      release: () => {
        if (!releasePromise) {
          releasePromise = this.enqueue(async () => {
            const count = this.pins.get(id) ?? 0;
            if (count <= 1) this.pins.delete(id);
            else this.pins.set(id, count - 1);
          });
        }
        return releasePromise;
      },
    };
  }

  async pin(id) {
    return this.enqueue(async () => this.pinLease(id));
  }

  async markRecordFailed(internal) {
    const current = this.manifests.get(internal.manifestPath);
    const manifest = structuredClone(current);
    const recordIndex = manifest.records.findIndex((record) => record.id === internal.record.id);
    if (recordIndex < 0) throw new Error("artifact manifest record is unavailable");
    manifest.records[recordIndex] = {
      ...publicRecord(manifest.records[recordIndex]),
      state: "failed",
    };
    manifest.revision = this.nextRevision(manifest.threadId);
    await this.commitManifest(internal.manifestPath, manifest);
  }

  protectedRecordIds() {
    const protectedIds = new Set();
    const latestCompleted = new Map();
    for (const manifest of this.manifests.values()) {
      if (manifest.settled !== true) {
        for (const record of manifest.records) protectedIds.add(record.id);
      }
      if (manifest.settled === true && Number.isSafeInteger(manifest.completedRevision)) {
        const previous = latestCompleted.get(manifest.threadId);
        if (!previous || manifest.completedRevision > previous.completedRevision) {
          latestCompleted.set(manifest.threadId, manifest);
        }
      }
    }
    for (const manifest of latestCompleted.values()) {
      for (const record of manifest.records) protectedIds.add(record.id);
    }
    return protectedIds;
  }

  async recordRetentionFailure() {
    const latestByThread = new Map();
    for (const [manifestPath, manifest] of this.manifests) {
      const previous = latestByThread.get(manifest.threadId);
      if (!previous || manifest.revision > previous.manifest.revision) {
        latestByThread.set(manifest.threadId, { manifestPath, manifest });
      }
    }
    for (const { manifestPath, manifest: current } of latestByThread.values()) {
      if (!current.records.some((record) => record.state === "ready")) continue;
      const diagnostic = {
        code: "retention_failed",
        message: "Artifact retention quota could not be satisfied without evicting protected content.",
      };
      const alreadyRecorded = current.complete === false
        && current.diagnostics?.some((item) => item?.code === diagnostic.code);
      if (alreadyRecorded) continue;
      const manifest = structuredClone(current);
      manifest.revision = this.nextRevision(manifest.threadId);
      manifest.complete = false;
      manifest.diagnostics = deduplicatedDiagnostics(manifest.diagnostics, [diagnostic]);
      await this.commitManifest(manifestPath, manifest);
    }
  }

  async enforceQuotaUnlocked(limitBytes) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new TypeError("quota byte limit must be a non-negative integer");
    }
    let totalBytes = [...this.records.values()].reduce((total, { record }) => (
      record.state === "ready" ? total + record.size : total
    ), 0);
    const protectedIds = this.protectedRecordIds();
    const candidates = [...this.records.values()]
      .filter(({ record, objectPath }) => record.state === "ready"
        && objectPath
        && !protectedIds.has(record.id)
        && !this.pins.has(record.id))
      .sort((left, right) => {
        const leftManifest = this.manifests.get(left.manifestPath);
        const rightManifest = this.manifests.get(right.manifestPath);
        const leftAccess = leftManifest?.private?.lastAccessedAt?.[left.record.id] ?? 0;
        const rightAccess = rightManifest?.private?.lastAccessedAt?.[right.record.id] ?? 0;
        return leftAccess - rightAccess
          || left.record.revision - right.record.revision
          || left.record.id.localeCompare(right.record.id);
      });
    const evicted = [];
    for (const candidate of candidates) {
      if (totalBytes <= limitBytes) break;
      const current = this.manifests.get(candidate.manifestPath);
      const manifest = structuredClone(current);
      const recordIndex = manifest.records.findIndex((record) => record.id === candidate.record.id);
      if (recordIndex < 0 || manifest.records[recordIndex].state !== "ready") continue;
      const objectPath = candidate.objectPath;
      const trashPath = path.join(
        path.dirname(objectPath),
        `.${path.basename(objectPath)}.${crypto.randomBytes(8).toString("hex")}.evicting`,
      );
      await fs.rename(objectPath, trashPath);
      manifest.records[recordIndex] = {
        ...publicRecord(manifest.records[recordIndex]),
        state: "evicted",
      };
      manifest.revision = this.nextRevision(manifest.threadId);
      delete manifest.private.objects[candidate.record.id];
      try {
        await this.commitManifest(candidate.manifestPath, manifest);
      } catch (error) {
        await fs.rename(trashPath, objectPath);
        throw error;
      }
      try {
        await fs.rm(trashPath, { force: true });
      } catch (error) {
        await fs.rename(trashPath, objectPath);
        const published = this.manifests.get(candidate.manifestPath);
        const rollback = structuredClone(published);
        const rollbackIndex = rollback.records.findIndex((record) => record.id === candidate.record.id);
        rollback.records[rollbackIndex] = {
          ...publicRecord(rollback.records[rollbackIndex]),
          state: "ready",
        };
        rollback.revision = this.nextRevision(rollback.threadId);
        rollback.private.objects[candidate.record.id] = objectPath;
        await this.commitManifest(candidate.manifestPath, rollback);
        throw error;
      }
      totalBytes -= candidate.record.size;
      evicted.push(candidate.record.id);
    }
    const complete = totalBytes <= limitBytes;
    if (!complete) await this.recordRetentionFailure();
    return { limitBytes, totalBytes, evicted, complete };
  }

  async enforceQuota(limitBytes = this.maxVaultBytes) {
    return this.enqueue(async () => this.enforceQuotaUnlocked(limitBytes));
  }

  async ingest(input) {
    return this.enqueue(async () => {
      if (!input || typeof input !== "object") throw new TypeError("artifact input is required");
      const workspaceInput = requiredString(input.workspaceRealPath, "workspaceRealPath");
      const threadId = requiredString(input.threadId, "threadId");
      const turnId = requiredString(input.turnId, "turnId");
      const normalizedRelativePath = relativePath(requiredString(input.relativePath, "relativePath"));
      const sourceInput = requiredString(input.sourcePath, "sourcePath");
      if (!path.isAbsolute(workspaceInput)) throw new TypeError("workspaceRealPath must be absolute");
      if (!path.isAbsolute(sourceInput)) throw new TypeError("sourcePath must be absolute");
      let workspaceRealPath;
      try {
        workspaceRealPath = await fs.realpath(workspaceInput);
        const workspaceStats = await fs.lstat(workspaceRealPath, { bigint: true });
        if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
          throw new TypeError("workspaceRealPath must name a trusted directory");
        }
      } catch (error) {
        if (error instanceof TypeError) throw error;
        throw new TypeError("workspaceRealPath must name a trusted directory", { cause: error });
      }
      const sourcePath = path.resolve(sourceInput);
      const expectedSourcePath = path.resolve(workspaceRealPath, ...normalizedRelativePath.split("/"));
      if (!samePath(expectedSourcePath, sourcePath)) {
        throw new TypeError("sourcePath must match relativePath in the frozen workspace");
      }

      const id = crypto.randomBytes(16).toString("hex");
      const revision = (this.threadRevisions.get(threadId) ?? 0) + 1;
      const objectPath = path.join(this.root, "objects", id.slice(0, 2), id, `${revision}.blob`);
      const temporaryPath = path.join(this.root, "tmp", `${id}.${revision}.part`);
      const turnBytes = [...this.records.values()].reduce((total, { record }) => (
        record.sha256 && record.threadId === threadId && record.turnId === turnId
          ? total + BigInt(record.size)
          : total
      ), 0n);
      const vaultBytes = [...this.records.values()].reduce((total, { record }) => (
        record.state === "ready" ? total + BigInt(record.size) : total
      ), 0n);
      const turnRemaining = BigInt(this.maxTurnBytes) > turnBytes
        ? BigInt(this.maxTurnBytes) - turnBytes
        : 0n;
      const vaultRemaining = BigInt(this.maxVaultBytes) > vaultBytes
        ? BigInt(this.maxVaultBytes) - vaultBytes
        : 0n;
      const remaining = turnRemaining < vaultRemaining ? turnRemaining : vaultRemaining;
      const copyLimit = Number(BigInt(this.maxFileBytes) < remaining ? BigInt(this.maxFileBytes) : remaining);
      let copied = null;
      let sourceSize = 0;
      let state = "failed";
      let source;
      try {
        const validated = await validateSegments(workspaceRealPath, normalizedRelativePath);
        sourceSize = Number(validated.stats.size);
        if (validated.stats.size > BigInt(this.maxFileBytes) || validated.stats.size > remaining) {
          throw new TooLargeError(sourceSize);
        }
        try {
          const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
          source = await fs.open(sourcePath, flags);
          const openedStats = await source.stat({ bigint: true });
          const immediate = await validateSegments(workspaceRealPath, normalizedRelativePath);
          if (!sameIdentity(validated.stats, openedStats) || !sameIdentity(openedStats, immediate.stats)) {
            throw new ArtifactSourceError("artifact_source_changed", "artifact source changed before copy", {
              size: sourceSize,
            });
          }
          copied = await copyAndHash(
            source,
            temporaryPath,
            copyLimit,
            openedStats,
            async () => (await validateSegments(workspaceRealPath, normalizedRelativePath)).stats,
          );
          state = "ready";
        } finally {
          await source?.close().catch(() => {});
          source = null;
        }
        await fs.mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
        await fs.rename(temporaryPath, objectPath);
      } catch (error) {
        await source?.close().catch(() => {});
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        copied = null;
        if (error instanceof TooLargeError) {
          state = "too_large";
          sourceSize = Number(error.size);
        } else if (error instanceof ArtifactSourceError) {
          state = error.code.startsWith("blocked_") ? "blocked" : "failed";
          if (error.size) sourceSize = Number(error.size);
        } else {
          state = "failed";
        }
      }
      const size = copied?.size ?? sourceSize;
      const classification = copied
        ? classifyArtifact({ name: normalizedRelativePath, head: copied.head, size: copied.size })
        : { mime: "application/octet-stream" };
      const record = publicRecord({
        id,
        revision,
        threadId,
        turnId,
        relativePath: normalizedRelativePath,
        displayName: path.posix.basename(normalizedRelativePath),
        kind: input.kind,
        provenance: input.provenance,
        mime: classification.mime,
        size,
        sha256: state === "ready" ? copied.sha256 : null,
        state,
        detectedAt: input.detectedAt,
      });
      const manifestPath = this.manifestPath(workspaceRealPath, threadId, turnId);
      const previous = this.manifests.get(manifestPath);
      const manifest = {
        version: 1,
        threadId,
        turnId,
        revision,
        startedRevision: previous?.startedRevision ?? revision,
        records: [...(previous?.records ?? []), record],
        settled: false,
        completedRevision: null,
        complete: false,
        diagnostics: [],
        private: {
          workspaceRealPath,
          objects: { ...(previous?.private?.objects ?? {}) },
          lastAccessedAt: { ...(previous?.private?.lastAccessedAt ?? {}) },
        },
      };
      if (state === "ready") manifest.private.objects[id] = objectPath;
      manifest.private.lastAccessedAt[id] = this.now();
      try {
        await this.writeJson(manifestPath, manifest);
      } catch (error) {
        if (state === "ready") await fs.rm(objectPath, { force: true });
        throw error;
      }
      this.publishManifest(manifestPath, manifest);
      return publicRecord(record);
    });
  }

  get(id) {
    const internal = this.records.get(id);
    return internal ? publicRecord(internal.record) : null;
  }

  record(id) {
    return this.get(id);
  }

  snapshot(threadId) {
    const all = [...this.records.values()]
      .map(({ record }) => record)
      .filter((record) => record.threadId === threadId)
      .sort((left, right) => right.revision - left.revision
        || right.detectedAt - left.detectedAt
        || right.id.localeCompare(left.id));
    const complete = all.length <= 500;
    const latestManifest = [...this.manifests.values()]
      .filter((manifest) => manifest.threadId === threadId)
      .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0];
    const diagnostics = Array.isArray(latestManifest?.diagnostics)
      ? structuredClone(latestManifest.diagnostics)
      : [];
    if (!complete) {
      diagnostics.push({
        code: "artifact_history_limit",
        message: "Artifact history is limited to the newest 500 records.",
      });
    }
    return {
      revision: this.threadRevisions.get(threadId) ?? 0,
      records: all.slice(0, 500).map(publicRecord),
      complete: Boolean(latestManifest?.complete) && complete,
      diagnostics,
    };
  }

  async finalizeTurn(input) {
    return this.enqueue(async () => {
      if (!input || typeof input !== "object") throw new TypeError("turn finalization is required");
      const threadId = requiredString(input.threadId, "threadId");
      const turnId = requiredString(input.turnId, "turnId");
      const workspaceInput = requiredString(input.workspaceRealPath, "workspaceRealPath");
      if (!path.isAbsolute(workspaceInput)) throw new TypeError("workspaceRealPath must be absolute");
      let workspaceRealPath;
      try {
        workspaceRealPath = await fs.realpath(workspaceInput);
        const stats = await fs.lstat(workspaceRealPath, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TypeError("workspaceRealPath is untrusted");
      } catch (error) {
        if (error instanceof TypeError) throw error;
        throw new TypeError("workspaceRealPath is untrusted", { cause: error });
      }
      const manifestPath = this.manifestPath(workspaceRealPath, threadId, turnId);
      const previous = this.manifests.get(manifestPath);
      if (previous && !samePath(previous.private.workspaceRealPath, workspaceRealPath)) {
        throw new TypeError("workspaceRealPath does not match the turn workspace");
      }
      const revision = this.nextRevision(threadId);
      const manifest = {
        version: 1,
        threadId,
        turnId,
        revision,
        startedRevision: previous?.startedRevision ?? revision,
        records: (previous?.records ?? []).map(publicRecord),
        settled: true,
        completedRevision: revision,
        complete: input.complete === true,
        diagnostics: deduplicatedDiagnostics(previous?.diagnostics, input.diagnostics),
        private: previous?.private
          ? structuredClone(previous.private)
          : { workspaceRealPath, objects: {}, lastAccessedAt: {} },
      };
      await this.commitManifest(manifestPath, manifest);
      return publicTurn(manifest);
    });
  }

  async savePendingTurn(input) {
    return this.enqueue(async () => {
      if (!input || typeof input !== "object") throw new TypeError("pending turn is required");
      const canonical = Boolean(input.handle);
      if (!canonical && !PENDING_PROVENANCE.has(input.provenance)) {
        throw new TypeError("invalid pending provenance");
      }
      const handle = normalizeHandle(input.handle ?? {
        localTaskId: input.localTaskId,
        threadId: input.threadId,
        turnId: input.turnId,
        workspaceRealPath: input.workspaceRealPath,
        cwdGeneration: input.cwdGeneration ?? 0,
        startedAt: input.startedAt ?? this.now(),
      }, { legacy: !canonical });
      if (!this.pending.has(handle.localTaskId) && this.pending.size >= this.maxPendingTurns) {
        throw new RangeError("pending turn limit 10000 exceeded");
      }
      const pending = {
        handle,
        baseline: hydrateBaseline(
          serializeBaseline(input.baseline, handle.workspaceRealPath),
          handle.workspaceRealPath,
        ),
        hints: sanitizeHints(input.hints, { strict: true }),
      };
      const pendingPath = path.join(this.root, "pending", `${digest(handle.localTaskId)}.json`);
      await this.writeJson(pendingPath, persistedPending(pending));
      this.pending.set(handle.localTaskId, { pending, pendingPath });
      return clonePending(pending);
    });
  }

  async bindPendingTurn(localTaskId, binding, maybeTurnId) {
    return this.enqueue(async () => {
      const entry = this.pending.get(localTaskId);
      if (!entry) throw new Error("pending turn not found");
      const threadId = typeof binding === "object" ? binding.threadId : entry.pending.handle.threadId;
      const turnId = typeof binding === "object" ? binding.turnId : binding ?? maybeTurnId;
      if (typeof turnId !== "string" || !turnId) throw new TypeError("turnId is required");
      if (threadId !== null && (typeof threadId !== "string" || !threadId)) throw new TypeError("threadId is invalid");
      const next = clonePending(entry.pending);
      next.handle.threadId = threadId;
      next.handle.turnId = turnId;
      await this.writeJson(entry.pendingPath, persistedPending(next));
      this.pending.set(localTaskId, { pending: next, pendingPath: entry.pendingPath });
      return clonePending(next);
    });
  }

  async updatePendingHints(localTaskId, update, maybeRelativePaths) {
    return this.enqueue(async () => {
      const entry = this.pending.get(localTaskId);
      if (!entry) throw new Error("pending turn not found");
      let incoming;
      if (update instanceof Map) {
        incoming = sanitizeHints(update, { strict: true });
      } else {
        const provenance = typeof update === "object" ? update.provenance : update;
        const paths = typeof update === "object" ? update.relativePaths : maybeRelativePaths;
        if (!PENDING_PROVENANCE.has(provenance)) throw new TypeError("invalid hint provenance");
        if (!Array.isArray(paths)) throw new TypeError("relativePaths must be an array");
        incoming = sanitizeHints({ [provenance]: paths }, { strict: true });
      }
      const next = clonePending(entry.pending);
      for (const [relative, sources] of incoming) {
        if (!next.hints.has(relative) && next.hints.size >= MAX_PENDING_HINTS) break;
        const merged = next.hints.get(relative) ?? new Set();
        for (const source of sources) merged.add(source);
        next.hints.set(relative, merged);
      }
      await this.writeJson(entry.pendingPath, persistedPending(next));
      this.pending.set(localTaskId, { pending: next, pendingPath: entry.pendingPath });
      return clonePending(next);
    });
  }

  pendingTurns() {
    return [...this.pending.values()]
      .map(({ pending }) => clonePending(pending))
      .sort((left, right) => left.handle.startedAt - right.handle.startedAt
        || left.handle.localTaskId.localeCompare(right.handle.localTaskId));
  }

  async complete(localTaskId) {
    return this.enqueue(async () => {
      const entry = this.pending.get(localTaskId);
      if (!entry) return null;
      await fs.rm(entry.pendingPath, { force: true });
      this.pending.delete(localTaskId);
      return clonePending(entry.pending);
    });
  }

  completePendingTurn(localTaskId) {
    return this.complete(localTaskId);
  }

  async abort(localTaskId) {
    return this.enqueue(async () => {
      const entry = this.pending.get(localTaskId);
      if (!entry) return false;
      await fs.rm(entry.pendingPath, { force: true });
      this.pending.delete(localTaskId);
      return true;
    });
  }

  abortPendingTurn(localTaskId) {
    return this.abort(localTaskId);
  }

  async openContent(id) {
    return this.enqueue(async () => {
      const internal = this.records.get(id);
      if (!internal || internal.record.state !== "ready" || !internal.objectPath) {
        throw new Error("artifact content is unavailable");
      }
      let stats;
      try {
        stats = await fs.stat(internal.objectPath);
        if (!stats.isFile()
            || Number(stats.size) !== internal.record.size
            || await hashFile(internal.objectPath) !== internal.record.sha256) {
          throw new Error("artifact integrity check failed");
        }
      } catch (error) {
        await this.markRecordFailed(internal);
        if (error.message === "artifact integrity check failed") throw error;
        throw new Error("artifact integrity check failed", { cause: error });
      }
      const current = this.manifests.get(internal.manifestPath);
      const manifest = structuredClone(current);
      manifest.revision = this.nextRevision(manifest.threadId);
      manifest.private.lastAccessedAt[id] = this.now();
      await this.commitManifest(internal.manifestPath, manifest);
      const published = this.records.get(id);
      const pin = this.pinLease(id);
      return {
        record: pin.record,
        path: published.objectPath,
        size: Number(stats.size),
        release: pin.release,
      };
    });
  }

  async close() {
    await this.mutationQueue;
  }
}
