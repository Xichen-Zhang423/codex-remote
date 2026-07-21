import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as artifactScan from "../src/artifact-scan.js";

const {
  EXCLUDED_DIRECTORY_NAMES,
  HOME_SCOPE_EXCLUSIONS,
  PRESERVED_OUTPUT_DIRECTORY_NAMES,
  diffSnapshots,
  excludedDirectoryNames,
  fileSignature,
  normalizeCandidate,
  snapshotWorkspace,
} = artifactScan;

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-artifact-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("snapshotWorkspace returns bigint-safe signatures and partial coverage evidence", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "result.txt"), "result");

  const complete = await snapshotWorkspace(root);
  const signature = complete.entries.get("result.txt");
  assert.equal(typeof signature.size, "number");
  for (const field of ["mtimeNs", "ctimeNs", "dev", "ino"]) {
    assert.equal(typeof signature[field], "string");
  }

  const huge = fileSignature({
    size: 7n,
    mtimeNs: 900719925474099312345n,
    ctimeNs: 900719925474099312346n,
    dev: 900719925474099312347n,
    ino: 900719925474099312348n,
  });
  assert.deepEqual(huge, {
    size: 7,
    mtimeNs: "900719925474099312345",
    ctimeNs: "900719925474099312346",
    dev: "900719925474099312347",
    ino: "900719925474099312348",
  });

  const partial = await snapshotWorkspace(root, { policy: { maxEntries: 0 } });
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.reasons, ["max_entries"]);
  assert.equal(partial.coveredDirectories.has("."), false);
});

test("diffSnapshots reports created modified and replaced files deterministically", () => {
  const before = {
    coveredDirectories: new Set(["."]),
    entries: new Map([
      ["changed.txt", { size: 3, mtimeNs: "10", ctimeNs: "10", dev: "1", ino: "1" }],
      ["replaced.txt", { size: 3, mtimeNs: "10", ctimeNs: "10", dev: "1", ino: "1" }],
    ]),
  };
  const after = {
    coveredDirectories: new Set(["."]),
    entries: new Map([
      ["changed.txt", { size: 14, mtimeNs: "20", ctimeNs: "10", dev: "1", ino: "1" }],
      ["created.md", { size: 3, mtimeNs: "10", ctimeNs: "10", dev: "1", ino: "3" }],
      ["replaced.txt", { size: 3, mtimeNs: "10", ctimeNs: "10", dev: "1", ino: "2" }],
    ]),
  };

  const result = diffSnapshots(before, after, { hints: new Map() });

  assert.deepEqual(
    result.changes.map(({ relativePath, kind }) => [relativePath, kind]),
    [
      ["changed.txt", "modified"],
      ["created.md", "created"],
      ["replaced.txt", "replaced"],
    ],
  );
  assert.deepEqual(result.changes[0].signature, after.entries.get("changed.txt"));
  assert.deepEqual(result.changes.map((change) => change.provenance), [
    ["snapshot"],
    ["snapshot"],
    ["snapshot"],
  ]);
});

test("watch and App Server hints enrich provenance but do not invent files", async (t) => {
  const root = await workspace(t);
  const before = await snapshotWorkspace(root);
  await fs.writeFile(path.join(root, "report.pdf"), "%PDF-1.7\n");
  const after = await snapshotWorkspace(root);
  const hints = new Map([
    ["report.pdf", new Set(["watch", "appServer"])],
    ["ghost.txt", new Set(["watch"])],
  ]);

  const result = diffSnapshots(before, after, { hints });

  assert.deepEqual(result.changes[0].provenance, ["snapshot", "watch", "appServer"]);
  assert.equal(result.changes.some((change) => change.relativePath === "ghost.txt"), false);
});

test("a covered ancestor proves a nested file was created when its directory was absent", async (t) => {
  const root = await workspace(t);
  const before = await snapshotWorkspace(root);
  assert.equal(before.coveredDirectories.has("."), true);

  await fs.mkdir(path.join(root, "output"));
  await fs.writeFile(path.join(root, "output", "e2e-artifact.txt"), "artifact");
  const after = await snapshotWorkspace(root);

  const withoutHint = diffSnapshots(before, after);
  assert.deepEqual(
    withoutHint.changes.map(({ relativePath, kind }) => [relativePath, kind]),
    [["output/e2e-artifact.txt", "created"]],
  );

  const withHint = diffSnapshots(before, after, {
    hints: new Map([["output/e2e-artifact.txt", new Set(["watch"])]]),
  });
  assert.equal(withHint.changes[0].kind, "created");
  assert.deepEqual(withHint.changes[0].provenance, ["snapshot", "watch"]);
  assert.equal("diagnostics" in withHint.changes[0], false);
});

test("a queued directory replaced by a link cannot escape the frozen workspace", async (t) => {
  const root = await workspace(t);
  const external = await workspace(t);
  const queued = path.join(root, "queued");
  const probe = path.join(root, "probe");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.mkdir(queued);
  await fs.writeFile(path.join(external, "outside.txt"), "outside");

  try {
    await fs.symlink(external, probe, linkType);
    await fs.rm(probe, { recursive: true, force: true });
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const originalOpendir = fs.opendir;
  let replaced = false;
  fs.opendir = async (candidate, ...args) => {
    if (!replaced && path.resolve(candidate) === path.resolve(queued)) {
      replaced = true;
      await fs.rm(queued, { recursive: true, force: true });
      await fs.symlink(external, queued, linkType);
    }
    return originalOpendir.call(fs, candidate, ...args);
  };

  let snapshot;
  try {
    snapshot = await snapshotWorkspace(root);
  } finally {
    fs.opendir = originalOpendir;
  }

  assert.equal(replaced, true);
  assert.equal(snapshot.entries.has("queued/outside.txt"), false);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.reasons.includes("directory_changed"), true);
  assert.equal(snapshot.coveredDirectories.has("queued"), false);
});

test("directory metadata changes at EOF prevent coverage and false created reports", async (t) => {
  const root = await workspace(t);
  const lateFile = path.join(root, "late.txt");
  const originalOpendir = fs.opendir;
  let injected = false;
  fs.opendir = async (candidate, ...args) => {
    const directory = await originalOpendir.call(fs, candidate, ...args);
    if (path.resolve(candidate) !== path.resolve(root)) return directory;

    const originalRead = directory.read.bind(directory);
    directory.read = async (...readArgs) => {
      const entry = await originalRead(...readArgs);
      if (!entry && !injected) {
        injected = true;
        await fs.writeFile(lateFile, "late");
        const future = new Date(Date.now() + 60_000);
        await fs.utimes(root, future, future);
      }
      return entry;
    };
    return directory;
  };

  let before;
  try {
    before = await snapshotWorkspace(root);
  } finally {
    fs.opendir = originalOpendir;
  }

  assert.equal(injected, true);
  assert.equal(before.entries.has("late.txt"), false);
  assert.equal(before.partial, true);
  assert.equal(before.reasons.includes("directory_changed"), true);
  assert.equal(before.coveredDirectories.has("."), false);

  const after = await snapshotWorkspace(root);
  const result = diffSnapshots(before, after);
  assert.deepEqual(result.changes, []);
});

test("maxArtifactsPerTurn is a finite integer capped at the hard limit", () => {
  const signature = { size: 1, mtimeNs: "1", ctimeNs: "1", dev: "1", ino: "1" };
  const before = { coveredDirectories: new Set(["."]), entries: new Map() };
  const after = {
    coveredDirectories: new Set(["."]),
    entries: new Map(
      Array.from({ length: 501 }, (_, index) => [
        `artifact-${String(index).padStart(3, "0")}.txt`,
        signature,
      ]),
    ),
  };

  const infinite = diffSnapshots(before, after, { maxArtifactsPerTurn: Infinity });
  assert.equal(infinite.changes.length, 500);
  assert.equal(infinite.diagnostics.at(-1).code, "artifact_limit");
  assert.equal(infinite.diagnostics.at(-1).message, "本轮检测到 501 个候选，仅登记前 500 个");

  assert.equal(diffSnapshots(before, after, { maxArtifactsPerTurn: 2.9 }).changes.length, 2);
  assert.equal(diffSnapshots(before, after, { maxArtifactsPerTurn: NaN }).changes.length, 500);
});

test("excludes metadata and dependency trees but preserves output directories", async (t) => {
  const root = await workspace(t);
  const files = [
    [".git/secret", "secret"],
    ["node_modules/pkg/index.js", "dependency"],
    ["build/app.zip", "build"],
    ["reports/final.pdf", "report"],
    ["notes/extra.txt", "note"],
  ];
  for (const [relativePath, contents] of files) {
    const absolute = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, contents);
  }

  const complete = await snapshotWorkspace(root);
  assert.deepEqual([...complete.entries.keys()].sort(), [
    "build/app.zip",
    "notes/extra.txt",
    "reports/final.pdf",
  ]);
  assert.equal(complete.coveredDirectories.has("build"), true);
  assert.equal(complete.coveredDirectories.has("reports"), true);

  const limited = await snapshotWorkspace(root, { policy: { maxFiles: 2 } });
  assert.equal(limited.entries.size, 2);
  assert.equal(limited.partial, true);
  assert.deepEqual(limited.reasons, ["max_files"]);
});

test("does not follow a directory link outside workspace", async (t) => {
  const root = await workspace(t);
  const external = await workspace(t);
  const link = path.join(root, "linked");
  await fs.writeFile(path.join(external, "outside.txt"), "outside");

  try {
    await fs.symlink(external, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const regular = await snapshotWorkspace(root);
  const candidates = await snapshotWorkspace(root, {
    candidateOnly: true,
    candidates: ["linked/outside.txt"],
  });
  assert.equal(regular.entries.has("linked/outside.txt"), false);
  assert.equal(candidates.entries.has("linked/outside.txt"), false);
});

test("Windows exclusion matching is case-insensitive for traversal and candidates", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await workspace(t);
  const home = path.join(root, "Users", "Profile");
  const files = [
    [".GIT/secret.txt", "secret"],
    ["Users/Profile/AppData/private.txt", "private"],
    ["safe.txt", "safe"],
  ];
  for (const [relativePath, contents] of files) {
    const absolute = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, contents);
  }

  const expected = ["safe.txt"];
  const candidates = [".git/secret.txt", "users/profile/appdata/private.txt", "SAFE.TXT"];
  const regular = await snapshotWorkspace(root, { home });
  const candidateOnly = await snapshotWorkspace(root, { candidateOnly: true, candidates, home });
  const volumeRoot = await snapshotWorkspace(root, {
    candidates,
    home,
    isVolumeRoot: () => true,
  });

  assert.deepEqual([...regular.entries.keys()], expected);
  assert.deepEqual([...candidateOnly.entries.keys()], expected);
  assert.deepEqual([...volumeRoot.entries.keys()], expected);
  assert.equal(candidateOnly.partial, false);
  assert.deepEqual(volumeRoot.reasons, ["volume_root"]);
});

test("volume roots scan only bounded terminal candidates", async (t) => {
  const root = await workspace(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-escape.txt`);
  t.after(() => fs.rm(outside, { force: true }));
  await fs.writeFile(path.join(root, "hinted.txt"), "hinted");
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "nested", "report.pdf"), "report");
  await fs.writeFile(path.join(root, "third.txt"), "third");
  await fs.writeFile(outside, "escape");

  const candidates = ["hinted.txt", "nested/report.pdf", "../escape.txt", "missing.txt"];
  const volume = await snapshotWorkspace(root, {
    candidates,
    isVolumeRoot: () => true,
  });
  assert.deepEqual([...volume.entries.keys()], ["hinted.txt", "nested/report.pdf"]);
  assert.equal(volume.coveredDirectories.size, 0);
  assert.equal(volume.partial, true);
  assert.deepEqual(volume.reasons, ["volume_root"]);

  const candidateOnly = await snapshotWorkspace(root, { candidateOnly: true, candidates });
  assert.deepEqual([...candidateOnly.entries.keys()], ["hinted.txt", "nested/report.pdf"]);
  assert.equal(candidateOnly.partial, false);
  assert.deepEqual(candidateOnly.reasons, []);
  assert.equal(candidateOnly.coveredDirectories.size, 0);

  const bounded = await snapshotWorkspace(root, {
    candidateOnly: true,
    candidates: ["hinted.txt", "nested/report.pdf", "third.txt"],
    policy: { maxDirtyPaths: 2 },
  });
  assert.deepEqual([...bounded.entries.keys()], ["hinted.txt", "nested/report.pdf"]);
  assert.equal(bounded.partial, true);
  assert.deepEqual(bounded.reasons, ["dirty_overflow"]);
});

test("partial baselines require evidence before reporting a change", () => {
  const signature = { size: 3, mtimeNs: "2", ctimeNs: "2", dev: "1", ino: "1" };
  const partialBefore = { coveredDirectories: new Set(), entries: new Map() };
  const after = {
    coveredDirectories: new Set(["."]),
    entries: new Map([["old.txt", signature]]),
  };

  assert.deepEqual(diffSnapshots(partialBefore, after), { changes: [], diagnostics: [] });

  const hinted = diffSnapshots(partialBefore, after, {
    hints: new Map([["old.txt", new Set(["watch"])]]),
  });
  assert.equal(hinted.changes.length, 1);
  assert.equal(hinted.changes[0].kind, "modified");
  assert.deepEqual(hinted.changes[0].diagnostics, ["baseline_unproven"]);
  assert.deepEqual(hinted.changes[0].provenance, ["snapshot", "watch"]);

  const completeBefore = { coveredDirectories: new Set(["."]), entries: new Map() };
  const created = diffSnapshots(completeBefore, after);
  assert.equal(created.changes[0].kind, "created");
  assert.equal("diagnostics" in created.changes[0], false);

  const nestedAfter = {
    coveredDirectories: new Set([".", "output"]),
    entries: new Map([["output/result.txt", signature]]),
  };
  const limitedBefore = {
    partial: true,
    coveredDirectories: new Set(["."]),
    entries: new Map(),
  };
  assert.deepEqual(diffSnapshots(limitedBefore, nestedAfter), { changes: [], diagnostics: [] });
  const limitedHinted = diffSnapshots(limitedBefore, nestedAfter, {
    hints: new Map([["output/result.txt", new Set(["watch"])]]),
  });
  assert.equal(limitedHinted.changes[0].kind, "modified");
  assert.deepEqual(limitedHinted.changes[0].diagnostics, ["baseline_unproven"]);
});

test("artifact limit is explicit and deterministic", () => {
  const signature = { size: 1, mtimeNs: "1", ctimeNs: "1", dev: "1", ino: "1" };
  const before = { coveredDirectories: new Set(["."]), entries: new Map() };
  const paths = Array.from({ length: 501 }, (_, index) => (
    `result-${String(500 - index).padStart(3, "0")}.txt`
  ));
  const after = {
    coveredDirectories: new Set(["."]),
    entries: new Map(paths.map((relativePath) => [relativePath, signature])),
  };

  const result = diffSnapshots(before, after);
  assert.equal(result.changes.length, 500);
  assert.equal(result.changes[0].relativePath, "result-000.txt");
  assert.equal(result.changes.at(-1).relativePath, "result-499.txt");
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ["artifact_limit"]);
});

test("normalizes only contained relative candidates and exports stable exclusions", async (t) => {
  const root = await workspace(t);
  const normalized = normalizeCandidate(root, "nested/report.pdf");
  assert.equal(normalized.relative, "nested/report.pdf");
  assert.equal(normalized.absolute, path.join(root, "nested", "report.pdf"));
  assert.equal(Object.isFrozen(normalized), true);
  for (const invalid of [null, "", "\0", "../escape.txt", path.resolve(root, "absolute.txt")]) {
    assert.equal(normalizeCandidate(root, invalid), null);
  }

  assert.equal(EXCLUDED_DIRECTORY_NAMES.has(".git"), true);
  assert.equal(HOME_SCOPE_EXCLUSIONS.has("appdata"), true);
  assert.equal(PRESERVED_OUTPUT_DIRECTORY_NAMES.has("build"), true);
  const exclusions = excludedDirectoryNames(root, path.join(root, "Users", "Profile"));
  assert.equal(exclusions.has("node_modules"), true);
  assert.equal(exclusions.has("appdata"), true);
  assert.equal(exclusions.has("build"), false);
});

test("bounds raw candidate iteration before normalization and deduplication", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "hinted.txt"), "hinted");

  for (const [first, expectedPaths] of [
    ["hinted.txt", ["hinted.txt"]],
    ["", []],
  ]) {
    let nextCalls = 0;
    const candidates = {
      [Symbol.iterator]() {
        return this;
      },
      next() {
        nextCalls += 1;
        if (nextCalls > 2) throw new Error("candidate iterable was over-consumed");
        return { done: false, value: nextCalls === 1 ? first : "hinted.txt" };
      },
    };

    const snapshot = await snapshotWorkspace(root, {
      candidateOnly: true,
      candidates,
      policy: { maxDirtyPaths: 1 },
    });
    assert.equal(nextCalls, 2);
    assert.deepEqual([...snapshot.entries.keys()], expectedPaths);
    assert.deepEqual(snapshot.reasons, ["dirty_overflow"]);
  }
});

test("clamps unsafe dirty path limits to the default hard ceiling", async (t) => {
  const root = await workspace(t);

  for (const maxDirtyPaths of [Infinity, NaN, 50_000]) {
    let nextCalls = 0;
    const candidates = {
      [Symbol.iterator]() {
        return this;
      },
      next() {
        nextCalls += 1;
        if (nextCalls > 10_001) throw new Error("candidate hard ceiling was exceeded");
        return { done: false, value: "" };
      },
    };

    const snapshot = await snapshotWorkspace(root, {
      candidateOnly: true,
      candidates,
      policy: { maxDirtyPaths },
    });
    assert.equal(nextCalls, 10_001);
    assert.deepEqual(snapshot.entries.size, 0);
    assert.deepEqual(snapshot.reasons, ["dirty_overflow"]);
  }
});

test("BFS traversal advances by index instead of shifting the queue", async () => {
  const source = await fs.readFile(new URL("../src/artifact-scan.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /queue\.shift\s*\(/);
});
