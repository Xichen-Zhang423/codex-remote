import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ArtifactStore } from "../src/artifact-store.js";

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspaceRealPath = path.join(directory, "workspace");
  const root = path.join(directory, "vault");
  await fs.mkdir(workspaceRealPath, { recursive: true });
  const store = await ArtifactStore.open({ root, ...options });
  t.after(() => store.close());
  return { directory, workspaceRealPath, root, store };
}

function pendingHandle(localTaskId, workspaceRealPath, overrides = {}) {
  return {
    localTaskId,
    threadId: `thread-${localTaskId}`,
    turnId: null,
    workspaceRealPath,
    cwdGeneration: 1,
    startedAt: 1,
    ...overrides,
  };
}

async function walk(root) {
  const files = [];
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const directory = queue[index];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      else files.push(entryPath);
    }
  }
  return files;
}

function sameTestPath(left, right) {
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertPublic(value, forbidden) {
  const serialized = JSON.stringify(value);
  for (const secret of forbidden) assert.equal(serialized.includes(secret), false, secret);
  for (const field of ["sourcePath", "workspaceRealPath", "objectPath", "ticket"]) {
    assert.equal(Object.hasOwn(value, field), false, field);
  }
}

test("ingest atomically copies immutable content and restores metadata after restart", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "nested", "report.txt");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "immutable");

  const record = await store.ingest({
    workspaceRealPath,
    threadId: "thread-1",
    turnId: "turn-1",
    relativePath: "nested/report.txt",
    sourcePath,
    kind: "text",
    provenance: "watch",
    detectedAt: 1_234,
  });

  assert.match(record.id, /^[a-f0-9]{32}$/);
  assert.equal(record.revision, 1);
  assert.equal(record.sha256, "3e58bada6a180c0d7f817bdae51fba96a461575b309bfbc17a6918d20c6617c7");
  assert.equal(record.state, "ready");

  await fs.writeFile(sourcePath, "changed");
  const opened = await store.openContent(record.id);
  assert.equal(await fs.readFile(opened.path, "utf8"), "immutable");
  opened.release();
  opened.release();

  await store.close();
  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.get(record.id), record);
});

test("public records are path-private and snapshots are newest-first with a 500 item cap", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "secret", "one.txt");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "one");
  const record = await store.ingest({
    workspaceRealPath,
    threadId: "privacy-thread",
    turnId: "privacy-turn",
    relativePath: "secret/one.txt",
    sourcePath,
    ticket: "private-ticket",
    kind: "text",
    provenance: "watch",
    detectedAt: 1,
  });
  const forbidden = [workspaceRealPath, root, sourcePath, "private-ticket"];
  assert.equal(record.displayName, "one.txt");
  assertPublic(record, forbidden);
  assertPublic(store.get(record.id), forbidden);

  await store.close();
  const [manifestPath] = (await walk(path.join(root, "manifests"))).filter((file) => file.endsWith(".json"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.records = Array.from({ length: 501 }, (_, index) => ({
    ...record,
    id: index.toString(16).padStart(32, "0"),
    relativePath: `history/${index}.txt`,
    displayName: `${index}.txt`,
    detectedAt: index,
    state: "failed",
    sha256: null,
    size: 0,
  }));
  manifest.private.objects = {};
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  const snapshot = restarted.snapshot("privacy-thread");
  assert.equal(snapshot.revision, manifest.revision);
  assert.equal(snapshot.records.length, 500);
  assert.equal(snapshot.records[0].detectedAt, 500);
  assert.equal(snapshot.records.at(-1).detectedAt, 1);
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.diagnostics, [{
    code: "artifact_history_limit",
    message: "Artifact history is limited to the newest 500 records.",
  }]);
  for (const item of snapshot.records) assertPublic(item, forbidden);
});

test("manifest commits are atomic and keep private paths only in private JSON", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "report.txt");
  await fs.writeFile(sourcePath, "manifest");
  const record = await store.ingest({
    workspaceRealPath,
    threadId: "thread-private",
    turnId: "turn-private",
    relativePath: "report.txt",
    sourcePath,
    kind: "text",
    provenance: "appServer",
    detectedAt: 2,
  });
  const secondSourcePath = path.join(workspaceRealPath, "second.txt");
  await fs.writeFile(secondSourcePath, "second");
  const second = await store.ingest({
    workspaceRealPath,
    threadId: "thread-private",
    turnId: "turn-private",
    relativePath: "second.txt",
    sourcePath: secondSourcePath,
    kind: "text",
    provenance: "appServer",
    detectedAt: 3,
  });
  const files = await walk(root);
  assert.equal(files.some((file) => /\.(?:tmp|part)$/.test(file)), false);
  const [manifestPath] = files.filter((file) => file.endsWith(".json"));
  const raw = await fs.readFile(manifestPath, "utf8");
  const privateManifest = JSON.parse(raw);
  assert.deepEqual(Object.keys(privateManifest).sort(), [
    "complete",
    "completedRevision",
    "diagnostics",
    "private",
    "records",
    "revision",
    "settled",
    "startedRevision",
    "threadId",
    "turnId",
    "version",
  ]);
  assert.equal(privateManifest.version, 1);
  assert.equal(privateManifest.startedRevision, record.revision);
  assert.equal(privateManifest.revision, second.revision);
  assert.equal(record.revision + 1, second.revision);
  assert.equal(privateManifest.settled, false);
  assert.equal(privateManifest.completedRevision, null);
  assert.equal(privateManifest.complete, false);
  assert.deepEqual(privateManifest.diagnostics, []);
  assert.deepEqual(Object.keys(privateManifest.private).sort(), [
    "lastAccessedAt",
    "objects",
    "workspaceRealPath",
  ]);
  assert.equal(privateManifest.private.workspaceRealPath, workspaceRealPath);
  assert.equal(path.isAbsolute(privateManifest.private.objects[record.id]), true);
  assert.equal(path.isAbsolute(privateManifest.private.objects[second.id]), true);
  assert.equal(Object.hasOwn(privateManifest, "workspaceRealPath"), false);
  assert.equal(Object.hasOwn(privateManifest, "objects"), false);
  assert.equal(raw.includes(sourcePath), false);
  assert.equal(JSON.stringify(record).includes(workspaceRealPath), false);
});

test("pending turns persist Map and Set baselines and serialize concurrent mutations", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const baseline = {
    root: workspaceRealPath,
    entries: new Map([["a.txt", { size: 1, mtimeNs: "2" }]]),
    coveredDirectories: new Set([".", "out"]),
    partial: true,
    reasons: ["duration_limit"],
    counters: { files: 1, directories: 2 },
  };
  await store.savePendingTurn({
    handle: pendingHandle("local-later", workspaceRealPath, { threadId: "thread-2", startedAt: 20 }),
    baseline,
    hints: new Map(),
  });
  await store.savePendingTurn({
    handle: pendingHandle("local-first", workspaceRealPath, { startedAt: 10 }),
    baseline,
    hints: new Map(),
  });
  await Promise.all([
    store.updatePendingHints("local-later", new Map([["one.txt", new Set(["watch"])]])),
    store.updatePendingHints("local-later", new Map([["two.txt", new Set(["watch"])]])),
    store.updatePendingHints("local-later", new Map([["three.txt", new Set(["appServer"])]])),
    store.bindPendingTurn("local-later", "turn-2"),
  ]);

  await store.close();
  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  const pending = restarted.pendingTurns();
  assert.deepEqual(pending.map((item) => item.handle.localTaskId), ["local-first", "local-later"]);
  const restored = pending[1];
  assert.ok(restored.baseline.entries instanceof Map);
  assert.ok(restored.baseline.coveredDirectories instanceof Set);
  assert.deepEqual(restored.baseline.entries.get("a.txt"), { size: 1, mtimeNs: "2" });
  assert.deepEqual([...restored.baseline.coveredDirectories], [".", "out"]);
  assert.ok(restored.hints instanceof Map);
  assert.deepEqual([...restored.hints.get("one.txt")], ["watch"]);
  assert.deepEqual([...restored.hints.get("two.txt")], ["watch"]);
  assert.deepEqual([...restored.hints.get("three.txt")], ["appServer"]);
  assert.equal(restored.handle.threadId, "thread-2");
  assert.equal(restored.handle.turnId, "turn-2");

  restored.baseline.entries.clear();
  assert.equal(restarted.pendingTurns()[1].baseline.entries.size, 1, "pendingTurns returns clones");
  assert.equal((await restarted.complete("local-later")).handle.localTaskId, "local-later");
  assert.equal(await restarted.abort("local-first"), true);
  assert.deepEqual(restarted.pendingTurns(), []);
  assert.equal((await walk(path.join(root, "pending"))).some((file) => /\.(?:tmp|part)$/.test(file)), false);
});

test("pending inputs allow only trusted provenance and bounded relative hints", async (t) => {
  const { workspaceRealPath, store } = await fixture(t);
  const baseline = {
    root: workspaceRealPath,
    entries: new Map(),
    coveredDirectories: new Set(),
    partial: false,
    reasons: [],
    counters: {},
  };
  await assert.rejects(
    store.savePendingTurn({
      localTaskId: "bad",
      workspaceRealPath,
      provenance: "ticket",
      baseline,
      startedAt: 1,
    }),
    /provenance/,
  );
  await store.savePendingTurn({
    localTaskId: "bounded",
    workspaceRealPath,
    provenance: "watch",
    baseline,
    startedAt: 1,
  });
  await assert.rejects(
    store.updatePendingHints("bounded", { provenance: "watch", relativePaths: ["x".repeat(32_769)] }),
    /relative/i,
  );
  await assert.rejects(
    store.updatePendingHints("bounded", { provenance: "other", relativePaths: ["safe.txt"] }),
    /provenance/,
  );
  store.maxPendingTurns = 1;
  await assert.rejects(
    store.savePendingTurn({
      localTaskId: "overflow",
      workspaceRealPath,
      provenance: "watch",
      baseline,
      startedAt: 2,
    }),
    /10000|limit/i,
  );
});

test("pending hints are stably deduplicated and capped at 10000 total", async (t) => {
  const { workspaceRealPath, store } = await fixture(t);
  const baseline = {
    root: workspaceRealPath,
    entries: new Map(),
    coveredDirectories: new Set(),
    partial: false,
    reasons: [],
    counters: {},
  };
  await store.savePendingTurn({
    handle: pendingHandle("hint-cap", workspaceRealPath),
    baseline,
    hints: new Map([
      ["seed.txt", new Set(["watch"])],
      ["app.txt", new Set(["appServer"])],
    ]),
  });
  const relativePaths = Array.from({ length: 10_005 }, (_, index) => `watch/${index}.txt`);
  const updated = await store.updatePendingHints("hint-cap", new Map(
    relativePaths.map((relative) => [relative, new Set(["watch"])]),
  ));
  assert.equal(updated.hints.size, 10_000);
  assert.deepEqual([...updated.hints.keys()].slice(0, 4), ["seed.txt", "app.txt", "watch/0.txt", "watch/1.txt"]);
  assert.equal([...updated.hints.keys()].at(-1), "watch/9997.txt");
  assert.deepEqual([...updated.hints.get("app.txt")], ["appServer"]);
});

test("malicious persisted hints are sanitized and capped during restart", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  await store.close();
  const localTaskId = "malicious-hints";
  const pendingPath = path.join(root, "pending", `${crypto.createHash("sha256").update(localTaskId).digest("hex")}.json`);
  const raw = {
    version: 1,
    handle: pendingHandle(localTaskId, workspaceRealPath),
    baseline: {
      root: workspaceRealPath,
      entries: [],
      coveredDirectories: [],
      partial: false,
      reasons: [],
      counters: {},
    },
    hints: [
      ...Array.from({ length: 10_005 }, (_, index) => [`safe/${index}.txt`, ["watch"]]),
      ["../escape.txt", ["watch"]],
      ["x".repeat(32_769), ["watch"]],
      ["app.txt", ["appServer"]],
      ["secret.txt", ["ticket"]],
    ],
  };
  await fs.writeFile(pendingPath, `${JSON.stringify(raw)}\n`);
  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  const [pending] = restarted.pendingTurns();
  assert.ok(pending.hints instanceof Map);
  assert.equal(pending.hints.size, 10_000);
  assert.equal([...pending.hints.keys()][0], "safe/0.txt");
  assert.equal([...pending.hints.keys()].at(-1), "safe/9999.txt");
  assert.equal(pending.hints.has("app.txt"), false);
});

test("failed pending writes never publish uncommitted bind or hint state", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const baseline = {
    root: workspaceRealPath,
    entries: new Map(),
    coveredDirectories: new Set(),
    partial: false,
    reasons: [],
    counters: {},
  };
  for (const localTaskId of ["failed-bind", "failed-hints"]) {
    await store.savePendingTurn({
      handle: pendingHandle(localTaskId, workspaceRealPath),
      baseline,
      hints: new Map(),
    });
    const pendingPath = path.join(root, "pending", `${crypto.createHash("sha256").update(localTaskId).digest("hex")}.json`);
    await fs.rm(pendingPath);
    await fs.mkdir(pendingPath);
  }
  await assert.rejects(
    store.bindPendingTurn("failed-bind", "turn"),
  );
  await assert.rejects(
    store.updatePendingHints("failed-hints", { provenance: "watch", relativePaths: ["new.txt"] }),
  );
  const pending = new Map(store.pendingTurns().map((item) => [item.handle.localTaskId, item]));
  assert.equal(pending.get("failed-bind").handle.turnId, null);
  assert.equal(pending.get("failed-hints").hints.size, 0);
});

test("ingest rejects missing and unsafe workspace inputs", async (t) => {
  assert.throws(() => new ArtifactStore(), /root/);
  const { directory, workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "safe.txt");
  await fs.writeFile(sourcePath, "safe");
  const valid = {
    workspaceRealPath,
    threadId: "safe-thread",
    turnId: "safe-turn",
    relativePath: "safe.txt",
    sourcePath,
    kind: "text",
    provenance: "watch",
    detectedAt: 3,
  };
  for (const field of ["workspaceRealPath", "threadId", "turnId", "relativePath", "sourcePath"]) {
    const input = { ...valid };
    delete input[field];
    await assert.rejects(store.ingest(input), new RegExp(field, "i"), field);
  }
  for (const badRelative of [path.resolve(workspaceRealPath, "safe.txt"), "../escape.txt", "bad\0name.txt"]) {
    await assert.rejects(store.ingest({ ...valid, relativePath: badRelative }), /relative/i);
  }

  const outside = path.join(directory, "outside.txt");
  await fs.writeFile(outside, "outside");
  await assert.rejects(store.ingest({ ...valid, sourcePath: outside }), /workspace|source/i);
  await assert.rejects(
    store.ingest({ ...valid, relativePath: "folder", sourcePath: workspaceRealPath }),
    /file|source/i,
  );
  const linkPath = path.join(workspaceRealPath, "link.txt");
  try {
    await fs.symlink(sourcePath, linkPath, "file");
    await assert.rejects(store.ingest({ ...valid, relativePath: "link.txt", sourcePath: linkPath }), /link|file|source/i);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }
  assert.equal((await walk(path.join(root, "tmp"))).length, 0);
});

test("binary file, turn, and vault limits persist too_large metadata without partial objects", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t, {
    maxFileBytes: 4,
    maxTurnBytes: 7,
    maxVaultBytes: 10,
  });
  async function ingest(name, content, turnId) {
    const sourcePath = path.join(workspaceRealPath, name);
    await fs.writeFile(sourcePath, content);
    return store.ingest({
      workspaceRealPath,
      threadId: "limit-thread",
      turnId,
      relativePath: name,
      sourcePath,
      kind: "file",
      provenance: "watch",
      detectedAt: content.length,
    });
  }

  const fileTooLarge = await ingest("file.bin", "12345", "file-turn");
  assert.equal(fileTooLarge.state, "too_large");
  assert.equal(fileTooLarge.size, 5);
  assert.equal(fileTooLarge.sha256, null);

  assert.equal((await ingest("turn-a.bin", "1234", "same-turn")).state, "ready");
  const turnTooLarge = await ingest("turn-b.bin", "5678", "same-turn");
  assert.equal(turnTooLarge.state, "too_large");
  assert.equal(turnTooLarge.sha256, null);

  assert.equal((await ingest("vault-a.bin", "abcd", "vault-a")).state, "ready");
  const vaultTooLarge = await ingest("vault-b.bin", "xyz", "vault-b");
  assert.equal(vaultTooLarge.state, "too_large");
  assert.equal(vaultTooLarge.sha256, null);

  const files = await walk(root);
  assert.equal(files.some((file) => /\.(?:tmp|part)$/.test(file)), false);
  assert.equal(files.filter((file) => file.endsWith(".blob")).length, 2);
  await store.close();
  const restarted = await ArtifactStore.open({ root, maxFileBytes: 4, maxTurnBytes: 7, maxVaultBytes: 10 });
  t.after(() => restarted.close());
  assert.equal(restarted.get(fileTooLarge.id).state, "too_large");
  await assert.rejects(restarted.openContent(fileTooLarge.id), /unavailable/);
});

test("startup cleans partials, quarantines invalid JSON, and marks corrupt objects failed", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "integrity.txt");
  await fs.writeFile(sourcePath, "integrity");
  const record = await store.ingest({
    workspaceRealPath,
    threadId: "integrity-thread",
    turnId: "integrity-turn",
    relativePath: "integrity.txt",
    sourcePath,
    kind: "text",
    provenance: "watch",
    detectedAt: 4,
  });
  const opened = await store.openContent(record.id);
  await store.close();
  await fs.writeFile(opened.path, "tampered!");
  await fs.writeFile(path.join(root, "tmp", "stale.part"), "partial");
  await fs.writeFile(path.join(root, "tmp", "stale.tmp"), "temporary");
  await fs.writeFile(path.join(root, "tmp", "keep.txt"), "keep");
  await fs.writeFile(path.join(root, "manifests", "invalid.json"), "{broken");
  await fs.writeFile(path.join(root, "pending", "invalid.json"), "[]");

  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  assert.equal(restarted.get(record.id).state, "failed");
  await assert.rejects(restarted.openContent(record.id), /unavailable|integrity/);
  assert.deepEqual((await fs.readdir(path.join(root, "tmp"))).sort(), ["keep.txt"]);
  assert.equal((await fs.readdir(path.join(root, "quarantine"))).length, 2);

  const freshSource = path.join(workspaceRealPath, "fresh.txt");
  await fs.writeFile(freshSource, "fresh");
  const fresh = await restarted.ingest({
    workspaceRealPath,
    threadId: "integrity-thread",
    turnId: "fresh-turn",
    relativePath: "fresh.txt",
    sourcePath: freshSource,
    kind: "text",
    provenance: "watch",
    detectedAt: 5,
  });
  const freshContent = await restarted.openContent(fresh.id);
  await fs.writeFile(freshContent.path, "other");
  await assert.rejects(restarted.openContent(fresh.id), /integrity/);
});

test("startup removes crash suffixes only from managed tmp manifest and pending trees", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "kept.txt");
  await fs.writeFile(sourcePath, "kept-object");
  const record = await store.ingest({
    workspaceRealPath,
    threadId: "cleanup-thread",
    turnId: "cleanup-turn",
    relativePath: "kept.txt",
    sourcePath,
    kind: "text",
    provenance: "watch",
    detectedAt: 6,
  });
  await store.savePendingTurn({
    handle: pendingHandle("cleanup-pending", workspaceRealPath),
    baseline: {
      root: workspaceRealPath,
      entries: new Map(),
      coveredDirectories: new Set(),
      partial: false,
      reasons: [],
      counters: {},
    },
    hints: new Map(),
  });
  const opened = await store.openContent(record.id);
  await store.close();

  const [manifestPath] = (await walk(path.join(root, "manifests"))).filter((file) => file.endsWith(".json"));
  const [pendingPath] = (await walk(path.join(root, "pending"))).filter((file) => file.endsWith(".json"));
  const manifestBefore = await fs.readFile(manifestPath, "utf8");
  const pendingBefore = await fs.readFile(pendingPath, "utf8");
  const blobBefore = await fs.readFile(opened.path, "utf8");

  const manifestCrash = path.join(path.dirname(manifestPath), ".manifest-crash.tmp");
  const pendingCrashDirectory = path.join(root, "pending", "nested");
  const pendingCrash = path.join(pendingCrashDirectory, "pending-crash.part");
  const tmpCrashDirectory = path.join(root, "tmp", "nested");
  const tmpCrash = path.join(tmpCrashDirectory, "copy-crash.part");
  const objectNamedTmp = path.join(root, "objects", "legitimate.tmp");
  const quarantinedPart = path.join(root, "quarantine", "evidence.part");
  await fs.mkdir(pendingCrashDirectory, { recursive: true });
  await fs.mkdir(tmpCrashDirectory, { recursive: true });
  await fs.writeFile(manifestCrash, "crash");
  await fs.writeFile(pendingCrash, "crash");
  await fs.writeFile(tmpCrash, "crash");
  await fs.writeFile(objectNamedTmp, "legitimate");
  await fs.writeFile(quarantinedPart, "evidence");

  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  for (const crashPath of [manifestCrash, pendingCrash, tmpCrash]) {
    await assert.rejects(fs.stat(crashPath), { code: "ENOENT" });
  }
  assert.equal(await fs.readFile(manifestPath, "utf8"), manifestBefore);
  assert.equal(await fs.readFile(pendingPath, "utf8"), pendingBefore);
  assert.equal(await fs.readFile(opened.path, "utf8"), blobBefore);
  assert.equal(await fs.readFile(objectNamedTmp, "utf8"), "legitimate");
  assert.equal(await fs.readFile(quarantinedPart, "utf8"), "evidence");
  assert.equal(restarted.get(record.id).state, "ready");
  assert.equal(restarted.pendingTurns()[0].handle.localTaskId, "cleanup-pending");
});

test("a failed manifest commit removes the published object and leaves memory unchanged", async (t) => {
  const failure = new Error("injected manifest write failure");
  const { workspaceRealPath, root, store } = await fixture(t, {
    writeJson: async () => { throw failure; },
  });
  const sourcePath = path.join(workspaceRealPath, "orphan.txt");
  await fs.writeFile(sourcePath, "must-not-orphan");
  await assert.rejects(store.ingest({
    workspaceRealPath,
    threadId: "failed-thread",
    turnId: "failed-turn",
    relativePath: "orphan.txt",
    sourcePath,
    kind: "text",
    provenance: "watch",
    detectedAt: 7,
  }), failure);
  assert.equal((await walk(path.join(root, "objects"))).some((file) => file.endsWith(".blob")), false);
  assert.deepEqual(store.snapshot("failed-thread"), {
    revision: 0,
    records: [],
    complete: false,
    diagnostics: [],
  });
});

test("startup quarantines only unreferenced blobs without following linked directories", async (t) => {
  const { directory, workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "referenced.txt");
  await fs.writeFile(sourcePath, "referenced");
  const record = await store.ingest({
    workspaceRealPath,
    threadId: "orphan-thread",
    turnId: "orphan-turn",
    relativePath: "referenced.txt",
    sourcePath,
    kind: "text",
    provenance: "watch",
    detectedAt: 8,
  });
  const opened = await store.openContent(record.id);
  await store.close();
  const orphanPath = path.join(root, "objects", "ff", "orphan", "1.blob");
  await fs.mkdir(path.dirname(orphanPath), { recursive: true });
  await fs.copyFile(opened.path, orphanPath);
  const outsideDirectory = path.join(directory, "outside-objects");
  const outsideBlob = path.join(outsideDirectory, "outside.blob");
  await fs.mkdir(outsideDirectory);
  await fs.writeFile(outsideBlob, "outside");
  try {
    await fs.symlink(outsideDirectory, path.join(root, "objects", "linked"), "junction");
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }

  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  await assert.rejects(fs.stat(orphanPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(opened.path, "utf8"), "referenced");
  assert.equal(await fs.readFile(outsideBlob, "utf8"), "outside");
  assert.equal(restarted.get(record.id).state, "ready");
  const quarantine = await fs.readdir(path.join(root, "quarantine"));
  assert.equal(quarantine.some((name) => name.endsWith("-1.blob")), true);
});

test("startup JSON and object traversal stop at injected hard limits", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-store-bounds-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "vault");
  const ignoredManifest = path.join(root, "manifests", "a", "b", "ignored.json");
  const ignoredBlob = path.join(root, "objects", "a", "b", "ignored.blob");
  await fs.mkdir(path.dirname(ignoredManifest), { recursive: true });
  await fs.mkdir(path.dirname(ignoredBlob), { recursive: true });
  await fs.writeFile(ignoredManifest, "{bad");
  await fs.writeFile(ignoredBlob, "orphan");
  const store = await ArtifactStore.open({
    root,
    maxTraversalDirectories: 1,
    maxTraversalEntries: 1,
  });
  t.after(() => store.close());
  assert.equal((await fs.stat(ignoredManifest)).isFile(), true);
  assert.equal((await fs.stat(ignoredBlob)).isFile(), true);
  assert.equal(store.startupDiagnostics.some((item) => item.code === "startup_traversal_limit"), true);
});

test("limited manifest discovery skips all orphan reconciliation", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "hidden-reference.txt");
  await fs.writeFile(sourcePath, "still-referenced");
  const record = await store.ingest({
    workspaceRealPath,
    threadId: "hidden-thread",
    turnId: "hidden-turn",
    relativePath: "hidden-reference.txt",
    sourcePath,
    kind: "text",
    provenance: "watch",
    detectedAt: 9,
  });
  const opened = await store.openContent(record.id);
  await store.close();
  const [manifestPath] = (await walk(path.join(root, "manifests"))).filter((file) => file.endsWith(".json"));
  const hiddenManifest = path.join(root, "manifests", "extra", "depth", "beyond", "hidden.json");
  await fs.mkdir(path.dirname(hiddenManifest), { recursive: true });
  await fs.rename(manifestPath, hiddenManifest);
  const unseenTrash = path.join(path.dirname(opened.path), ".unseen.blob.0123456789abcdef.evicting");
  await fs.writeFile(unseenTrash, "possibly-referenced");

  const restarted = await ArtifactStore.open({
    root,
    maxTraversalDirectories: 3,
    maxTraversalEntries: 100,
  });
  t.after(() => restarted.close());
  assert.equal(
    restarted.startupDiagnostics.some((item) => (
      item.code === "startup_traversal_limit" && item.tree === "manifests"
    )),
    true,
  );
  assert.equal(await fs.readFile(opened.path, "utf8"), "still-referenced");
  assert.equal(await fs.readFile(unseenTrash, "utf8"), "possibly-referenced");
  assert.equal(
    (await fs.readdir(path.join(root, "quarantine"))).some((name) => name.endsWith(".blob")),
    false,
  );
});

test("canonical pending rejects non-frozen workspaces before persistence", async (t) => {
  const { directory, workspaceRealPath, root, store } = await fixture(t);
  const baseline = {
    root: workspaceRealPath,
    entries: new Map(),
    coveredDirectories: new Set(),
    partial: false,
    reasons: [],
    counters: {},
  };
  await assert.rejects(store.savePendingTurn({
    handle: pendingHandle("relative-workspace", "relative/workspace"),
    baseline: { ...baseline, root: "relative/workspace" },
    hints: new Map(),
  }), /workspaceRealPath|absolute/);
  const nonCanonicalWorkspace = `${workspaceRealPath}${path.sep}..${path.sep}${path.basename(workspaceRealPath)}`;
  await assert.rejects(store.savePendingTurn({
    handle: pendingHandle("noncanonical", nonCanonicalWorkspace),
    baseline: { ...baseline, root: nonCanonicalWorkspace },
    hints: new Map(),
  }), /workspaceRealPath|normalized/);
  await assert.rejects(store.savePendingTurn({
    handle: pendingHandle("mismatch", workspaceRealPath),
    baseline: { ...baseline, root: directory },
    hints: new Map(),
  }), /baseline\.root|workspace/i);
  assert.deepEqual(await fs.readdir(path.join(root, "pending")), []);
});

test("restart quarantines canonical pending JSON with unfrozen workspace identity", async (t) => {
  const { directory, workspaceRealPath, root, store } = await fixture(t);
  await store.close();
  const baseline = {
    entries: [],
    coveredDirectories: [],
    partial: false,
    reasons: [],
    counters: {},
  };
  for (const [localTaskId, workspace, baselineRoot] of [
    ["relative", "relative/workspace", "relative/workspace"],
    ["mismatch", workspaceRealPath, directory],
  ]) {
    const pendingPath = path.join(root, "pending", `${crypto.createHash("sha256").update(localTaskId).digest("hex")}.json`);
    await fs.writeFile(pendingPath, `${JSON.stringify({
      version: 1,
      handle: pendingHandle(localTaskId, workspace),
      baseline: { root: baselineRoot, ...baseline },
      hints: [],
    })}\n`);
  }
  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.pendingTurns(), []);
  assert.equal((await fs.readdir(path.join(root, "quarantine"))).length, 2);
});

function artifactInput(workspaceRealPath, relative, overrides = {}) {
  return {
    workspaceRealPath,
    threadId: "task5-thread",
    turnId: "task5-turn",
    relativePath: relative,
    sourcePath: path.join(workspaceRealPath, ...relative.replaceAll("\\", "/").split("/")),
    kind: "file",
    provenance: "watch",
    detectedAt: 100,
    ...overrides,
  };
}

async function mutateAfterFirstSourceRead(sourcePath, mutate, operation) {
  const originalOpen = fs.open;
  let mutated = false;
  fs.open = async function patchedOpen(filePath, ...args) {
    const handle = await originalOpen.call(this, filePath, ...args);
    if (path.resolve(String(filePath)).toLowerCase() !== path.resolve(sourcePath).toLowerCase()) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === "read") {
          return async (...readArgs) => {
            const result = await target.read(...readArgs);
            if (!mutated && result.bytesRead > 0) {
              mutated = true;
              await mutate();
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  try {
    return await operation();
  } finally {
    fs.open = originalOpen;
  }
}

test("ready is unpublished until immutable object and manifest commit both complete", async (t) => {
  let allowCommit;
  let writeStarted;
  const commitStarted = new Promise((resolve) => { writeStarted = resolve; });
  const commitAllowed = new Promise((resolve) => { allowCommit = resolve; });
  const { workspaceRealPath, store } = await fixture(t, {
    writeJson: async (filePath, value) => {
      writeStarted();
      await commitAllowed;
      const temporary = `${filePath}.test.tmp`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`);
      await fs.rename(temporary, filePath);
    },
  });
  const sourcePath = path.join(workspaceRealPath, "publish.txt");
  await fs.writeFile(sourcePath, "publish-only-after-commit");

  const ingesting = store.ingest(artifactInput(workspaceRealPath, "publish.txt"));
  await commitStarted;
  assert.deepEqual(store.snapshot("task5-thread").records, []);
  allowCommit();
  const record = await ingesting;
  assert.equal(record.state, "ready");
  assert.equal(record.size, Buffer.byteLength("publish-only-after-commit"));
  assert.equal(record.sha256, crypto.createHash("sha256").update("publish-only-after-commit").digest("hex"));
  assert.deepEqual(store.get(record.id), record);
});

test("source deletion growth truncation replacement and same-metadata rewrite never publish ready", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t, {
    maxFileBytes: 2 * 1024 * 1024,
    maxTurnBytes: 20 * 1024 * 1024,
    maxVaultBytes: 20 * 1024 * 1024,
  });
  const cases = [
    ["deleted", async (sourcePath) => fs.rm(sourcePath)],
    ["grown", async (sourcePath) => fs.appendFile(sourcePath, "growth")],
    ["truncated", async (sourcePath) => fs.truncate(sourcePath, 1)],
    ["replaced", async (sourcePath) => {
      const replacement = `${sourcePath}.replacement`;
      await fs.writeFile(replacement, Buffer.alloc(128 * 1024, 0x72));
      await fs.rm(sourcePath);
      await fs.rename(replacement, sourcePath);
    }],
    ["rewritten", async (sourcePath) => {
      const before = await fs.stat(sourcePath);
      await fs.writeFile(sourcePath, Buffer.alloc(128 * 1024, 0x78));
      await fs.utimes(sourcePath, before.atime, before.mtime);
    }],
  ];
  for (const [name, mutate] of cases) {
    const relative = `${name}.bin`;
    const sourcePath = path.join(workspaceRealPath, relative);
    await fs.writeFile(sourcePath, Buffer.alloc(128 * 1024, 0x61));
    const blobsBefore = (await walk(path.join(root, "objects"))).filter((file) => file.endsWith(".blob")).length;
    const record = await mutateAfterFirstSourceRead(sourcePath, () => mutate(sourcePath), () => (
      store.ingest(artifactInput(workspaceRealPath, relative, { sourcePath }))
    ));
    assert.notEqual(record.state, "ready", name);
    assert.equal(record.sha256, null, name);
    assert.equal(
      (await walk(path.join(root, "objects"))).filter((file) => file.endsWith(".blob")).length,
      blobsBefore,
      name,
    );
  }
});

test("unsafe relative paths and untrusted workspaces reject without publishing metadata", async (t) => {
  const { directory, workspaceRealPath, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "safe.txt");
  await fs.writeFile(sourcePath, "safe");
  const unsafe = [
    "", "../escape.txt", path.resolve(workspaceRealPath, "safe.txt"),
    "\\\\server\\share\\x.txt", "\\\\?\\C:\\x.txt", "\\\\.\\C:\\x.txt",
    "stream.txt:secret", "bad\0name", "CON", "prn.txt", "folder/AUX.log", "COM1", "lpt9.txt",
  ];
  for (const relative of unsafe) {
    await assert.rejects(
      store.ingest(artifactInput(workspaceRealPath, relative, { sourcePath })),
      /relative|safe|required/i,
      relative,
    );
  }
  await assert.rejects(
    store.ingest(artifactInput(path.join(directory, "missing-workspace"), "safe.txt", { sourcePath })),
  );
  assert.deepEqual(store.snapshot("task5-thread").records, []);
});

test("directories and links inside a trusted workspace commit blocked metadata", async (t) => {
  const { directory, workspaceRealPath, store } = await fixture(t);
  const directoryPath = path.join(workspaceRealPath, "folder");
  await fs.mkdir(directoryPath);
  const blockedDirectory = await store.ingest(artifactInput(workspaceRealPath, "folder", {
    sourcePath: directoryPath,
  }));
  assert.equal(blockedDirectory.state, "blocked");
  assert.equal(blockedDirectory.sha256, null);

  const outside = path.join(directory, "outside.txt");
  const linkPath = path.join(workspaceRealPath, "linked.txt");
  await fs.writeFile(outside, "outside");
  try {
    await fs.symlink(outside, linkPath, "file");
  } catch (error) {
    if (error.code === "EPERM") return;
    throw error;
  }
  const blockedLink = await store.ingest(artifactInput(workspaceRealPath, "linked.txt", { sourcePath: linkPath }));
  assert.equal(blockedLink.state, "blocked");
  assert.equal(blockedLink.sha256, null);
});

test("swapping a validated parent for an outside junction cannot copy outside content", async (t) => {
  const { directory, workspaceRealPath, store } = await fixture(t);
  const parent = path.join(workspaceRealPath, "parent");
  const movedParent = path.join(workspaceRealPath, "parent-original");
  const outside = path.join(directory, "outside");
  const sourcePath = path.join(parent, "victim.txt");
  await fs.mkdir(parent);
  await fs.mkdir(outside);
  await fs.writeFile(sourcePath, "inside");
  await fs.writeFile(path.join(outside, "victim.txt"), "outside-secret");
  const originalOpen = fs.open;
  let swapped = false;
  fs.open = async function swapBeforeOpen(filePath, ...args) {
    if (!swapped && path.resolve(String(filePath)).toLowerCase() === path.resolve(sourcePath).toLowerCase()) {
      swapped = true;
      await fs.rename(parent, movedParent);
      try {
        await fs.symlink(outside, parent, "junction");
      } catch (error) {
        await fs.rename(movedParent, parent);
        if (error.code === "EPERM") throw Object.assign(new Error("junction unavailable"), { code: "SKIP_JUNCTION" });
        throw error;
      }
    }
    return originalOpen.call(this, filePath, ...args);
  };
  let record;
  try {
    record = await store.ingest(artifactInput(workspaceRealPath, "parent/victim.txt", { sourcePath }));
  } catch (error) {
    if (error.code === "SKIP_JUNCTION") return;
    throw error;
  } finally {
    fs.open = originalOpen;
  }
  assert.notEqual(record.state, "ready");
  assert.equal(record.sha256, null);
  await assert.rejects(store.openContent(record.id), /unavailable/);
});

async function onlyManifest(root) {
  const manifests = (await walk(path.join(root, "manifests"))).filter((file) => file.endsWith(".json"));
  assert.equal(manifests.length, 1);
  return JSON.parse(await fs.readFile(manifests[0], "utf8"));
}

test("same path changes create distinct revisions and snapshot orders by newest revision", async (t) => {
  const { workspaceRealPath, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "revision.txt");
  await fs.writeFile(sourcePath, "first");
  const first = await store.ingest(artifactInput(workspaceRealPath, "revision.txt", {
    sourcePath,
    detectedAt: 500,
  }));
  await fs.writeFile(sourcePath, "second");
  const second = await store.ingest(artifactInput(workspaceRealPath, "revision.txt", {
    sourcePath,
    detectedAt: 500,
  }));
  assert.notEqual(first.id, second.id);
  assert.ok(second.revision > first.revision);
  assert.deepEqual(store.snapshot("task5-thread").records.map((record) => record.id), [second.id, first.id]);
});

test("every manifest mutation advances the thread envelope while turn boundaries stay fixed", async (t) => {
  let clock = 1_000;
  const { workspaceRealPath, root, store } = await fixture(t, { now: () => clock++ });
  const sourcePath = path.join(workspaceRealPath, "envelope.txt");
  await fs.writeFile(sourcePath, "envelope");
  const record = await store.ingest(artifactInput(workspaceRealPath, "envelope.txt", { sourcePath }));
  const afterIngest = await onlyManifest(root);
  assert.equal(afterIngest.startedRevision, record.revision);

  const lease = await store.openContent(record.id);
  lease.release();
  const afterOpen = await onlyManifest(root);
  assert.ok(afterOpen.revision > afterIngest.revision);
  assert.equal(afterOpen.startedRevision, afterIngest.startedRevision);

  await store.finalizeTurn({
    threadId: "task5-thread",
    turnId: "task5-turn",
    workspaceRealPath,
    complete: true,
    diagnostics: [{ code: "same" }, { code: "same" }],
  });
  const finalized = await onlyManifest(root);
  assert.ok(finalized.revision > afterOpen.revision);
  assert.equal(finalized.startedRevision, afterIngest.startedRevision);
  assert.equal(finalized.settled, true);
  assert.equal(finalized.completedRevision, finalized.revision);
  assert.equal(finalized.complete, true);
  assert.deepEqual(finalized.diagnostics, [{ code: "same" }]);
});

test("finalizeTurn atomically creates an empty settled turn and snapshot reflects completion", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const result = await store.finalizeTurn({
    threadId: "empty-thread",
    turnId: "empty-turn",
    workspaceRealPath,
    complete: true,
    diagnostics: [{ code: "empty-note", message: "kept" }, { code: "empty-note", message: "kept" }],
  });
  assert.equal(result.settled, true);
  assert.equal(result.complete, true);
  assert.equal(result.completedRevision, result.revision);
  assert.deepEqual(result.records, []);
  const manifest = await onlyManifest(root);
  assert.equal(Object.hasOwn(result, "private"), false);
  assert.equal(manifest.revision, result.revision);
  assert.deepEqual(manifest.records, result.records);
  assert.deepEqual(store.snapshot("empty-thread"), {
    revision: result.revision,
    records: [],
    complete: true,
    diagnostics: [{ code: "empty-note", message: "kept" }],
  });
});

test("quota eviction honors explicit and content pins, protects latest completed turns, and uses LRU", async (t) => {
  let clock = 1_000;
  const { workspaceRealPath, store } = await fixture(t, {
    now: () => clock++,
    maxFileBytes: 100,
    maxTurnBytes: 100,
    maxVaultBytes: 100,
  });
  async function completed(turnId, name, content) {
    const sourcePath = path.join(workspaceRealPath, name);
    await fs.writeFile(sourcePath, content);
    const record = await store.ingest(artifactInput(workspaceRealPath, name, {
      sourcePath,
      threadId: "quota-thread",
      turnId,
    }));
    await store.finalizeTurn({
      workspaceRealPath,
      threadId: "quota-thread",
      turnId,
      complete: true,
      diagnostics: [],
    });
    return record;
  }

  const first = await completed("quota-turn-1", "quota-1.txt", "1111");
  const second = await completed("quota-turn-2", "quota-2.txt", "2222");
  const latest = await completed("quota-turn-3", "quota-3.txt", "3333");
  const explicitPin = await store.pin(first.id);

  const firstPass = await store.enforceQuota(8);
  assert.equal(firstPass.complete, true);
  assert.equal(store.get(first.id).state, "ready");
  assert.equal(store.get(second.id).state, "evicted");
  assert.equal(store.get(second.id).sha256, second.sha256);
  assert.equal(store.get(latest.id).state, "ready");
  await assert.rejects(store.openContent(second.id), /unavailable/);

  await explicitPin.release();
  await explicitPin.release();
  const contentPin = await store.openContent(first.id);
  const pinnedPass = await store.enforceQuota(4);
  assert.equal(pinnedPass.complete, false);
  assert.equal(store.get(first.id).state, "ready");
  assert.equal(store.get(latest.id).state, "ready");

  await contentPin.release();
  await contentPin.release();
  const releasedPass = await store.enforceQuota(4);
  assert.equal(releasedPass.complete, true);
  assert.equal(store.get(first.id).state, "evicted");
  assert.equal(store.get(first.id).sha256, first.sha256);
  assert.equal(store.get(latest.id).state, "ready");
});

async function evictionCandidate(t) {
  const { workspaceRealPath, root, store } = await fixture(t, {
    maxFileBytes: 100,
    maxTurnBytes: 100,
    maxVaultBytes: 100,
  });
  async function completed(turnId, name, content) {
    const sourcePath = path.join(workspaceRealPath, name);
    await fs.writeFile(sourcePath, content);
    const record = await store.ingest(artifactInput(workspaceRealPath, name, {
      sourcePath,
      threadId: "eviction-failure-thread",
      turnId,
    }));
    await store.finalizeTurn({
      workspaceRealPath,
      threadId: "eviction-failure-thread",
      turnId,
      complete: true,
      diagnostics: [],
    });
    return record;
  }
  const candidate = await completed("eviction-old", "eviction-old.txt", "old1");
  const lease = await store.openContent(candidate.id);
  const objectPath = lease.path;
  await lease.release();
  await completed("eviction-latest", "eviction-latest.txt", "new2");
  return { root, store, candidate, objectPath };
}

test("quota remove failure rolls staged content back without publishing evicted", async (t) => {
  const { root, store, candidate, objectPath } = await evictionCandidate(t);
  const failure = new Error("injected eviction remove failure");
  const originalRemove = fs.rm;
  fs.rm = async function failEvictionTrash(filePath, ...args) {
    if (String(filePath).endsWith(".evicting")) throw failure;
    return originalRemove.call(this, filePath, ...args);
  };
  try {
    await assert.rejects(store.enforceQuota(4), failure);
  } finally {
    fs.rm = originalRemove;
  }
  assert.equal(store.get(candidate.id).state, "ready");
  assert.equal(await fs.readFile(objectPath, "utf8"), "old1");
  assert.equal((await walk(path.join(root, "objects"))).some((file) => file.endsWith(".evicting")), false);
});

test("quota stage rename failure leaves ready metadata and the original blob untouched", async (t) => {
  const { root, store, candidate, objectPath } = await evictionCandidate(t);
  const failure = new Error("injected eviction stage failure");
  const originalRename = fs.rename;
  fs.rename = async function failEvictionStage(source, destination, ...args) {
    if (sameTestPath(source, objectPath) && String(destination).endsWith(".evicting")) throw failure;
    return originalRename.call(this, source, destination, ...args);
  };
  try {
    await assert.rejects(store.enforceQuota(4), failure);
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(store.get(candidate.id).state, "ready");
  assert.equal(await fs.readFile(objectPath, "utf8"), "old1");
  assert.equal((await walk(path.join(root, "objects"))).some((file) => file.endsWith(".evicting")), false);
});

test("quota manifest failure renames staged content back before returning", async (t) => {
  const { root, store, candidate, objectPath } = await evictionCandidate(t);
  const failure = new Error("injected eviction manifest failure");
  const originalRename = fs.rename;
  const originalWriteJson = store.writeJson;
  const renames = [];
  fs.rename = async function trackEvictionRename(source, destination, ...args) {
    if (sameTestPath(source, objectPath) || sameTestPath(destination, objectPath)) {
      renames.push([String(source), String(destination)]);
    }
    return originalRename.call(this, source, destination, ...args);
  };
  store.writeJson = async (filePath, value) => {
    if (value.records.some((record) => record.id === candidate.id && record.state === "evicted")) throw failure;
    return originalWriteJson(filePath, value);
  };
  try {
    await assert.rejects(store.enforceQuota(4), failure);
  } finally {
    store.writeJson = originalWriteJson;
    fs.rename = originalRename;
  }
  assert.equal(renames.length, 2);
  assert.equal(store.get(candidate.id).state, "ready");
  assert.equal(await fs.readFile(objectPath, "utf8"), "old1");
  assert.equal((await walk(path.join(root, "objects"))).some((file) => file.endsWith(".evicting")), false);
});

test("startup restores staged eviction when its manifest is still ready", async (t) => {
  const { root, store, candidate, objectPath } = await evictionCandidate(t);
  await store.close();
  const trashPath = path.join(
    path.dirname(objectPath),
    `.${path.basename(objectPath)}.0123456789abcdef.evicting`,
  );
  await fs.rename(objectPath, trashPath);

  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  assert.equal(restarted.get(candidate.id).state, "ready");
  assert.equal(await fs.readFile(objectPath, "utf8"), "old1");
  await assert.rejects(fs.stat(trashPath), { code: "ENOENT" });
});

test("startup removes staged eviction after its manifest committed evicted", async (t) => {
  const { root, store, candidate, objectPath } = await evictionCandidate(t);
  await store.close();
  const trashPath = path.join(
    path.dirname(objectPath),
    `.${path.basename(objectPath)}.fedcba9876543210.evicting`,
  );
  await fs.rename(objectPath, trashPath);
  const manifestPaths = (await walk(path.join(root, "manifests"))).filter((file) => file.endsWith(".json"));
  let candidateManifestPath;
  for (const file of manifestPaths) {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value.records.some((record) => record.id === candidate.id)) {
      candidateManifestPath = file;
      value.records = value.records.map((record) => (
        record.id === candidate.id ? { ...record, state: "evicted" } : record
      ));
      value.revision += 10;
      delete value.private.objects[candidate.id];
      await fs.writeFile(file, `${JSON.stringify(value)}\n`);
      break;
    }
  }
  assert.equal(typeof candidateManifestPath, "string");

  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  assert.equal(restarted.get(candidate.id).state, "evicted");
  await assert.rejects(fs.stat(trashPath), { code: "ENOENT" });
});

test("limited staged-eviction discovery restores a matching stage from the exact object directory", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "deep-staged.txt");
  await fs.writeFile(sourcePath, "deep-staged-content");
  const record = await store.ingest(artifactInput(workspaceRealPath, "deep-staged.txt", { sourcePath }));
  const lease = await store.openContent(record.id);
  const originalObjectPath = lease.path;
  await lease.release();
  await store.close();

  const deepObjectPath = path.join(root, "objects", "deep", "a", "b", "c", "deep-staged.blob");
  const trashPath = path.join(
    path.dirname(deepObjectPath),
    `.${path.basename(deepObjectPath)}.0123456789abcdef.evicting`,
  );
  await fs.mkdir(path.dirname(deepObjectPath), { recursive: true });
  await fs.rename(originalObjectPath, deepObjectPath);
  const [manifestPath] = (await walk(path.join(root, "manifests"))).filter((file) => file.endsWith(".json"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.private.objects[record.id] = deepObjectPath;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await fs.rename(deepObjectPath, trashPath);

  const limited = await ArtifactStore.open({
    root,
    maxTraversalDirectories: 3,
    maxTraversalEntries: 100,
  });
  assert.equal(limited.get(record.id).state, "ready");
  assert.equal(
    limited.startupDiagnostics.some((item) => item.code === "startup_traversal_limit" && item.tree === "objects"),
    true,
  );
  const limitedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(limitedManifest.records.find((item) => item.id === record.id).state, "ready");
  assert.equal(await fs.readFile(deepObjectPath, "utf8"), "deep-staged-content");
  await assert.rejects(fs.stat(trashPath), { code: "ENOENT" });
  await limited.close();

  const recovered = await ArtifactStore.open({ root });
  t.after(() => recovered.close());
  assert.equal(recovered.get(record.id).state, "ready");
  assert.equal(await fs.readFile(deepObjectPath, "utf8"), "deep-staged-content");
  await assert.rejects(fs.stat(trashPath), { code: "ENOENT" });
});

test("limited staged-eviction discovery fails a missing ready object with no matching local stage", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "missing-without-stage.txt");
  await fs.writeFile(sourcePath, "missing-without-stage");
  const record = await store.ingest(artifactInput(workspaceRealPath, "missing-without-stage.txt", { sourcePath }));
  const lease = await store.openContent(record.id);
  const objectPath = lease.path;
  await lease.release();
  await store.close();
  await fs.rm(objectPath);
  await fs.mkdir(path.join(root, "objects", "padding", "a", "b", "c"), { recursive: true });
  const [manifestPath] = (await walk(path.join(root, "manifests"))).filter((file) => file.endsWith(".json"));
  const before = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  const limited = await ArtifactStore.open({
    root,
    maxTraversalDirectories: 3,
    maxTraversalEntries: 100,
  });
  t.after(() => limited.close());
  assert.equal(
    limited.startupDiagnostics.some((item) => item.code === "startup_traversal_limit" && item.tree === "objects"),
    true,
  );
  assert.equal(limited.get(record.id).state, "failed");
  assert.equal(limited.get(record.id).sha256, record.sha256);
  assert.equal(limited.snapshot("task5-thread").records[0].state, "failed");
  const after = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.ok(after.revision > before.revision);
  assert.equal(after.records.find((item) => item.id === record.id).state, "failed");
});

test("quota excludes unsettled turns from eviction", async (t) => {
  const { workspaceRealPath, store } = await fixture(t, {
    maxFileBytes: 100,
    maxTurnBytes: 100,
    maxVaultBytes: 100,
  });
  const sourcePath = path.join(workspaceRealPath, "unsettled.txt");
  await fs.writeFile(sourcePath, "unsettled");
  const record = await store.ingest(artifactInput(workspaceRealPath, "unsettled.txt", {
    sourcePath,
    threadId: "unsettled-thread",
    turnId: "unsettled-turn",
  }));

  const result = await store.enforceQuota(0);
  assert.equal(result.complete, false);
  assert.equal(store.get(record.id).state, "ready");
});

test("openContent atomically records live corruption as failed while retaining the original hash", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  const sourcePath = path.join(workspaceRealPath, "live-corrupt.txt");
  await fs.writeFile(sourcePath, "original-content");
  const record = await store.ingest(artifactInput(workspaceRealPath, "live-corrupt.txt", { sourcePath }));
  const lease = await store.openContent(record.id);
  const objectPath = lease.path;
  await lease.release();
  const revisionBeforeCorruption = store.snapshot("task5-thread").revision;
  await fs.writeFile(objectPath, "tampered-content");

  await assert.rejects(store.openContent(record.id), /integrity/);
  const failed = store.get(record.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.sha256, record.sha256);
  assert.ok(store.snapshot("task5-thread").revision > revisionBeforeCorruption);
  const manifest = await onlyManifest(root);
  assert.equal(manifest.records.find((item) => item.id === record.id).state, "failed");
  assert.equal(manifest.records.find((item) => item.id === record.id).sha256, record.sha256);

  await store.close();
  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  assert.equal(restarted.get(record.id).state, "failed");
  assert.equal(restarted.get(record.id).sha256, record.sha256);
  await assert.rejects(restarted.openContent(record.id), /unavailable/);
});

test("pending recovery keeps a missing workspace retryable", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  await store.savePendingTurn({
    handle: pendingHandle("missing-workspace", workspaceRealPath),
    baseline: {
      root: workspaceRealPath,
      entries: new Map([["retry.txt", { size: 1 }]]),
      coveredDirectories: new Set(["."]),
      partial: false,
      reasons: [],
      counters: {},
    },
    hints: new Map([["retry.txt", new Set(["watch"])]]),
  });
  await store.close();
  await fs.rm(workspaceRealPath, { recursive: true, force: true });

  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  const [pending] = restarted.pendingTurns();
  assert.equal(pending.handle.localTaskId, "missing-workspace");
  assert.equal(pending.handle.workspaceRealPath, workspaceRealPath);
  assert.deepEqual([...pending.baseline.entries], [["retry.txt", { size: 1 }]]);
  assert.deepEqual([...pending.hints.get("retry.txt")], ["watch"]);
});

test("restart quarantines parseable manifests with invalid v1 private identity", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t);
  await store.close();
  const base = {
    version: 1,
    threadId: "invalid-manifest-thread",
    turnId: "invalid-manifest-turn",
    revision: 1,
    startedRevision: 1,
    records: [],
    settled: false,
    completedRevision: null,
    complete: false,
    diagnostics: [],
    private: { workspaceRealPath, objects: {}, lastAccessedAt: {} },
  };
  const invalid = [
    { ...base, version: 2 },
    {
      ...base,
      turnId: "noncanonical-workspace",
      private: {
        ...base.private,
        workspaceRealPath: `${workspaceRealPath}${path.sep}..${path.sep}${path.basename(workspaceRealPath)}`,
      },
    },
    {
      ...base,
      turnId: "invalid-private-map",
      private: { ...base.private, objects: [] },
    },
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    await fs.writeFile(
      path.join(root, "manifests", `invalid-semantic-${index}.json`),
      `${JSON.stringify(invalid[index])}\n`,
    );
  }

  const restarted = await ArtifactStore.open({ root });
  t.after(() => restarted.close());
  assert.equal((await fs.readdir(path.join(root, "quarantine"))).length, invalid.length);
  assert.equal((await walk(path.join(root, "manifests"))).filter((file) => file.endsWith(".json")).length, 0);
});

test("restart rebuilds per-turn bytes before admitting another artifact", async (t) => {
  const { workspaceRealPath, root, store } = await fixture(t, {
    maxFileBytes: 10,
    maxTurnBytes: 7,
    maxVaultBytes: 100,
  });
  const firstPath = path.join(workspaceRealPath, "restart-budget-a.txt");
  await fs.writeFile(firstPath, "1234");
  await store.ingest(artifactInput(workspaceRealPath, "restart-budget-a.txt", {
    sourcePath: firstPath,
    threadId: "restart-budget-thread",
    turnId: "restart-budget-turn",
  }));
  await store.close();

  const restarted = await ArtifactStore.open({
    root,
    maxFileBytes: 10,
    maxTurnBytes: 7,
    maxVaultBytes: 100,
  });
  t.after(() => restarted.close());
  const secondPath = path.join(workspaceRealPath, "restart-budget-b.txt");
  await fs.writeFile(secondPath, "5678");
  const second = await restarted.ingest(artifactInput(workspaceRealPath, "restart-budget-b.txt", {
    sourcePath: secondPath,
    threadId: "restart-budget-thread",
    turnId: "restart-budget-turn",
  }));
  assert.equal(second.state, "too_large");
  assert.equal(second.sha256, null);
});

test("quota failure after a ready commit reports retention_failed without rewriting copy state", async (t) => {
  const { workspaceRealPath, store } = await fixture(t, {
    maxFileBytes: 100,
    maxTurnBytes: 100,
    maxVaultBytes: 100,
  });
  const sourcePath = path.join(workspaceRealPath, "retained.txt");
  await fs.writeFile(sourcePath, "retained");
  const record = await store.ingest(artifactInput(workspaceRealPath, "retained.txt", {
    sourcePath,
    threadId: "retention-thread",
    turnId: "retention-turn",
  }));
  await store.finalizeTurn({
    workspaceRealPath,
    threadId: "retention-thread",
    turnId: "retention-turn",
    complete: true,
    diagnostics: [],
  });

  const result = await store.enforceQuota(0);
  assert.equal(result.complete, false);
  assert.equal(store.get(record.id).state, "ready");
  assert.equal(store.get(record.id).sha256, record.sha256);
  const snapshot = store.snapshot("retention-thread");
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.diagnostics.some((item) => item.code === "retention_failed"), true);
});
