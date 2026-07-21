import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SCAN_POLICY = Object.freeze({
  maxFiles: 50000,
  maxDirectories: 10000,
  maxEntries: 100000,
  maxDepth: 32,
  maxDurationMs: 5000,
  statConcurrency: 32,
  maxDirtyPaths: 10000,
  maxArtifactsPerTurn: 500,
});

export const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".gradle",
  ".idea",
  ".vscode",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".cache",
]);

export const HOME_SCOPE_EXCLUSIONS = new Set([
  ".codex",
  `.${["clau", "de"].join("")}`,
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  "appdata",
  "$recycle.bin",
  "system volume information",
]);

export const PRESERVED_OUTPUT_DIRECTORY_NAMES = new Set([
  "build",
  "dist",
  "out",
  "target",
  "release",
  "output",
  "outputs",
  "artifacts",
  "coverage",
  "tmp",
  "figures",
  "reports",
]);

export function fileSignature(stats) {
  return {
    size: Number(stats.size),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
    dev: String(stats.dev),
    ino: String(stats.ino),
  };
}

export function sameSignature(left, right) {
  return Boolean(
    left
      && right
      && left.size === right.size
      && left.mtimeNs === right.mtimeNs
      && left.ctimeNs === right.ctimeNs
      && left.dev === right.dev
      && left.ino === right.ino
  );
}

function knownIdentity(signature) {
  if (!signature) return false;
  return [signature.dev, signature.ino].every(
    (value) => value !== undefined && value !== null && String(value) !== "" && String(value) !== "0",
  );
}

export function identityChanged(before, after) {
  return Boolean(
    knownIdentity(before)
      && knownIdentity(after)
      && (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino))
  );
}

function slash(value) {
  return String(value).replaceAll("\\", "/");
}

function comparisonKey(value) {
  const normalized = String(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function setHasName(names, value) {
  return names.has(comparisonKey(value));
}

function parentOf(value) {
  const relative = slash(value);
  const separator = relative.lastIndexOf("/");
  return separator === -1 ? "." : relative.slice(0, separator) || ".";
}

function baselineProvesAbsent(snapshot, relativePath) {
  let directory = parentOf(relativePath);
  if (snapshot.coveredDirectories.has(directory)) return true;
  if (snapshot.partial === true) return false;

  while (directory !== ".") {
    directory = parentOf(directory);
    if (snapshot.coveredDirectories.has(directory)) return true;
  }
  return false;
}

function addReason(state, code) {
  state.partial = true;
  if (!state.reasons.includes(code)) state.reasons.push(code);
}

function expired(state, policy, now) {
  if (now() - state.startedAt < policy.maxDurationMs) return false;
  addReason(state, "timeout");
  return true;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function excludedDirectoryNames(root, home = os.homedir()) {
  const names = new Set([...EXCLUDED_DIRECTORY_NAMES].map(comparisonKey));
  const resolvedRoot = path.resolve(root);
  const resolvedHome = path.resolve(home);
  if (isContained(resolvedRoot, resolvedHome)) {
    for (const name of HOME_SCOPE_EXCLUSIONS) names.add(comparisonKey(name));
  }
  for (const name of PRESERVED_OUTPUT_DIRECTORY_NAMES) names.delete(comparisonKey(name));
  return names;
}

export function normalizeCandidate(root, candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "" || candidate.includes("\0")) {
    return null;
  }
  if (path.isAbsolute(candidate)) return null;

  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, candidate);
  if (!isContained(resolvedRoot, absolute) || absolute === resolvedRoot) return null;
  const relative = slash(path.relative(resolvedRoot, absolute));
  if (!relative || relative === ".") return null;
  return Object.freeze({ absolute, relative });
}

function directoryIdentity(stats, realPath) {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
    realPath,
  };
}

async function validateDirectory(state, absolute, expectedIdentity) {
  let stats;
  let realPath;
  try {
    stats = await fs.lstat(absolute, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      addReason(state, "directory_changed");
      return null;
    }
    realPath = await fs.realpath(absolute);
  } catch {
    addReason(state, "directory_unavailable");
    return null;
  }

  if (!isContained(state.root, realPath)) {
    addReason(state, "directory_outside_workspace");
    return null;
  }

  const identity = directoryIdentity(stats, realPath);
  if (expectedIdentity && (
    expectedIdentity.dev !== identity.dev
    || expectedIdentity.ino !== identity.ino
    || expectedIdentity.mtimeNs !== identity.mtimeNs
    || expectedIdentity.ctimeNs !== identity.ctimeNs
    || expectedIdentity.realPath !== identity.realPath
  )) {
    addReason(state, "directory_changed");
    return null;
  }
  return identity;
}

function pathIdentity(stats, realPath) {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
    realPath,
    directory: stats.isDirectory(),
    file: stats.isFile(),
  };
}

function samePathIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.realPath === right.realPath
    && left.directory === right.directory
    && left.file === right.file;
}

async function inspectCandidateSegment(state, absolute, finalSegment, existingIdentity = null) {
  let initialStats;
  try {
    initialStats = await fs.lstat(absolute, { bigint: true });
  } catch {
    if (existingIdentity) addReason(state, "entry_changed");
    return null;
  }
  if (initialStats.isSymbolicLink()) return null;
  if (finalSegment ? !initialStats.isFile() : !initialStats.isDirectory()) return null;

  let realPath;
  let stableStats;
  try {
    realPath = await fs.realpath(absolute);
    stableStats = await fs.lstat(absolute, { bigint: true });
  } catch {
    addReason(state, "entry_changed");
    return null;
  }
  if (!isContained(state.root, realPath)
      || stableStats.isSymbolicLink()
      || (finalSegment ? !stableStats.isFile() : !stableStats.isDirectory())) {
    addReason(state, "entry_changed");
    return null;
  }

  const initialIdentity = pathIdentity(initialStats, realPath);
  const stableIdentity = pathIdentity(stableStats, realPath);
  if (!samePathIdentity(initialIdentity, stableIdentity)
      || (existingIdentity && !samePathIdentity(existingIdentity, stableIdentity))) {
    addReason(state, "entry_changed");
    return null;
  }
  return { identity: stableIdentity, stats: stableStats, realPath };
}

async function inspectCandidateFile(state, candidate, policy, now, rootIdentity) {
  if (expired(state, policy, now)) return null;
  if (!await validateDirectory(state, state.root, rootIdentity)) return null;

  const segments = candidate.relative.split("/");
  const inspected = [];
  let absolute = state.root;
  for (let index = 0; index < segments.length; index += 1) {
    if (expired(state, policy, now)) return null;
    absolute = path.join(absolute, segments[index]);
    const segment = await inspectCandidateSegment(
      state,
      absolute,
      index === segments.length - 1,
    );
    if (!segment) return null;
    inspected.push({ absolute, finalSegment: index === segments.length - 1, ...segment });
  }

  let finalInspection = null;
  for (const segment of inspected) {
    if (expired(state, policy, now)) return null;
    const repeated = await inspectCandidateSegment(
      state,
      segment.absolute,
      segment.finalSegment,
      segment.identity,
    );
    if (!repeated) return null;
    if (segment.finalSegment) finalInspection = repeated;
  }
  if (!await validateDirectory(state, state.root, rootIdentity)) return null;
  if (!finalInspection) return null;

  return {
    relative: slash(path.relative(state.root, finalInspection.realPath)),
    signature: fileSignature(finalInspection.stats),
  };
}

function candidateValues(options) {
  const supplied = options.candidates ?? options.dirtyPaths ?? [];
  if (typeof supplied === "string" || supplied == null || !supplied[Symbol.iterator]) return [];
  return supplied;
}

function boundedCandidates(root, options, policy, exclusions, state) {
  const configuredLimit = Number.isFinite(policy.maxDirtyPaths)
    ? Math.max(0, Math.floor(policy.maxDirtyPaths))
    : DEFAULT_SCAN_POLICY.maxDirtyPaths;
  const requestedLimit = Math.min(DEFAULT_SCAN_POLICY.maxDirtyPaths, configuredLimit);
  const candidates = [];
  const seen = new Set();
  let suppliedCount = 0;
  for (const supplied of candidateValues(options)) {
    suppliedCount += 1;
    if (suppliedCount > requestedLimit) {
      addReason(state, "dirty_overflow");
      break;
    }
    const normalized = normalizeCandidate(root, supplied);
    if (!normalized) continue;
    const key = comparisonKey(normalized.relative);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(normalized);
  }

  return candidates
    .filter((candidate) => (
      !candidate.relative.split("/").some((segment) => setHasName(exclusions, segment))
    ));
}

export async function enumerateDirectory(
  state,
  absolute,
  relative,
  depth,
  policy,
  now,
  expectedIdentity,
) {
  if (depth > policy.maxDepth) {
    addReason(state, "max_depth");
    return { children: [], complete: false };
  }
  if (state.counters.directories >= policy.maxDirectories) {
    addReason(state, "max_directories");
    return { children: [], complete: false };
  }
  if (expired(state, policy, now)) return { children: [], complete: false };
  const preOpenIdentity = await validateDirectory(state, absolute, expectedIdentity);
  if (!preOpenIdentity) {
    return { children: [], complete: false };
  }

  let directory;
  try {
    directory = await fs.opendir(absolute);
  } catch {
    addReason(state, "directory_unavailable");
    return { children: [], complete: false };
  }
  const scanIdentity = await validateDirectory(state, absolute, preOpenIdentity);
  if (!scanIdentity) {
    await directory.close().catch(() => {});
    return { children: [], complete: false };
  }

  state.counters.directories += 1;
  const children = [];
  let complete = false;
  try {
    while (true) {
      if (expired(state, policy, now)) break;
      if (state.counters.entries >= policy.maxEntries) {
        addReason(state, "max_entries");
        break;
      }

      const entry = await directory.read();
      if (!entry) {
        complete = Boolean(await validateDirectory(state, absolute, scanIdentity));
        break;
      }
      state.counters.entries += 1;
      if (entry.isSymbolicLink()) continue;
      children.push({
        absolute: path.join(absolute, entry.name),
        relative: relative === "." ? slash(entry.name) : `${relative}/${slash(entry.name)}`,
        entry,
      });
    }
  } catch {
    addReason(state, "directory_unavailable");
  } finally {
    await directory.close().catch(() => {});
  }

  children.sort((left, right) => {
    if (left.relative < right.relative) return -1;
    if (left.relative > right.relative) return 1;
    return 0;
  });
  return { children, complete };
}

export async function snapshotWorkspace(root, options = {}) {
  const policy = { ...DEFAULT_SCAN_POLICY, ...(options.policy ?? {}) };
  const now = options.now ?? (() => os.uptime() * 1000);
  const resolvedRoot = await fs.realpath(root);
  const exclusions = excludedDirectoryNames(resolvedRoot, options.home);
  const suppliedExclusions = options.excludedDirectoryNames ?? [];
  if (typeof suppliedExclusions !== "string" && suppliedExclusions?.[Symbol.iterator]) {
    for (const name of suppliedExclusions) exclusions.add(comparisonKey(name));
  }
  for (const name of PRESERVED_OUTPUT_DIRECTORY_NAMES) exclusions.delete(comparisonKey(name));
  const state = {
    root: resolvedRoot,
    entries: new Map(),
    coveredDirectories: new Set(),
    partial: false,
    reasons: [],
    counters: { files: 0, directories: 0, entries: 0 },
    startedAt: now(),
  };
  const rootIdentity = await validateDirectory(state, resolvedRoot);
  const volumeRoot = Boolean((
    options.isVolumeRoot ?? ((value) => path.parse(value).root === value)
  )(resolvedRoot));
  const candidateOnly = options.candidateOnly === true;
  if (volumeRoot) addReason(state, "volume_root");

  if (volumeRoot || candidateOnly) {
    if (!rootIdentity) return state;
    const candidates = boundedCandidates(resolvedRoot, options, policy, exclusions, state);
    for (const candidate of candidates) {
      if (expired(state, policy, now)) break;
      const inspected = await inspectCandidateFile(state, candidate, policy, now, rootIdentity);
      if (!inspected) continue;
      if (state.counters.files >= policy.maxFiles) {
        addReason(state, "max_files");
        break;
      }
      state.entries.set(inspected.relative, inspected.signature);
      state.counters.files += 1;
    }
    return state;
  }

  const queue = rootIdentity
    ? [{ absolute: resolvedRoot, relative: ".", depth: 0, identity: rootIdentity }]
    : [];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    if (expired(state, policy, now)) break;
    const current = queue[queueIndex];
    queueIndex += 1;
    const { children, complete } = await enumerateDirectory(
      state,
      current.absolute,
      current.relative,
      current.depth,
      policy,
      now,
      current.identity,
    );
    let directoryCovered = complete;

    for (const child of children) {
      if (child.entry.isDirectory()) {
        if (!setHasName(exclusions, child.entry.name)) {
          const identity = await validateDirectory(state, child.absolute);
          if (identity) {
            queue.push({
              absolute: child.absolute,
              relative: child.relative,
              depth: current.depth + 1,
              identity,
            });
          }
        }
        continue;
      }
      if (!child.entry.isFile()) continue;
      if (state.counters.files >= policy.maxFiles) {
        addReason(state, "max_files");
        directoryCovered = false;
        continue;
      }
      if (expired(state, policy, now)) {
        directoryCovered = false;
        break;
      }

      let stats;
      try {
        stats = await fs.lstat(child.absolute, { bigint: true });
      } catch {
        addReason(state, "entry_unavailable");
        directoryCovered = false;
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        addReason(state, "entry_changed");
        directoryCovered = false;
        continue;
      }
      state.entries.set(slash(child.relative), fileSignature(stats));
      state.counters.files += 1;
    }
    if (directoryCovered) state.coveredDirectories.add(current.relative);
  }

  return state;
}

function normalizedHints(hints) {
  const normalized = new Map();
  for (const [relativePath, sources] of hints) normalized.set(slash(relativePath), sources);
  return normalized;
}

function provenanceFor(sources) {
  const provenance = ["snapshot"];
  if (sources?.has("watch")) provenance.push("watch");
  if (sources?.has("appServer")) provenance.push("appServer");
  return provenance;
}

export function diffSnapshots(
  before,
  after,
  { hints = new Map(), maxArtifactsPerTurn = DEFAULT_SCAN_POLICY.maxArtifactsPerTurn } = {},
) {
  const changes = [];
  const diagnostics = [];
  const hintsByPath = normalizedHints(hints);
  const afterEntries = [...after.entries].sort(([left], [right]) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });

  for (const [relativePath, afterSignature] of afterEntries) {
    const beforeSignature = before.entries.get(relativePath);
    if (sameSignature(beforeSignature, afterSignature)) continue;

    const sources = hintsByPath.get(relativePath);
    let type;
    let changeDiagnostics;
    if (!beforeSignature) {
      if (!baselineProvesAbsent(before, relativePath)) {
        if (!sources?.size) continue;
        type = "modified";
        changeDiagnostics = ["baseline_unproven"];
        diagnostics.push({
          code: "baseline_unproven",
          relativePath,
          message: "基线快照未完整覆盖父目录，无法确认文件为新建",
        });
      } else {
        type = "created";
      }
    } else {
      type = identityChanged(beforeSignature, afterSignature) ? "replaced" : "modified";
    }

    const change = {
      relativePath,
      kind: type,
      signature: afterSignature,
      provenance: provenanceFor(sources),
    };
    if (changeDiagnostics) change.diagnostics = changeDiagnostics;
    changes.push(change);
  }

  const requestedLimit = Number.isFinite(maxArtifactsPerTurn)
    ? Math.floor(maxArtifactsPerTurn)
    : DEFAULT_SCAN_POLICY.maxArtifactsPerTurn;
  const limit = Math.min(
    DEFAULT_SCAN_POLICY.maxArtifactsPerTurn,
    Math.max(0, requestedLimit),
  );
  if (changes.length > limit) {
    diagnostics.push({
      code: "artifact_limit",
      message: `本轮检测到 ${changes.length} 个候选，仅登记前 ${limit} 个`,
    });
  }

  return { changes: changes.slice(0, limit), diagnostics };
}
