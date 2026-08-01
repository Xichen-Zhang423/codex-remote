import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";

import { createArtifactContentHandler, parseSingleRange } from "../src/artifact-http.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ArtifactTicketStore } from "../src/artifact-tickets.js";

async function fixture(t, {
  now = Date.now,
  ttlMs = 60_000,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-http-"));
  const directory = await fs.realpath(temporaryDirectory);
  const workspaceRealPath = path.join(directory, "workspace");
  await fs.mkdir(workspaceRealPath, { recursive: true });
  const actualStore = await ArtifactStore.open({ root: path.join(directory, "vault") });
  const counters = { acquired: 0, released: 0 };
  const store = {
    get: (id) => actualStore.get(id),
    async openContent(id) {
      const lease = await actualStore.openContent(id);
      counters.acquired += 1;
      let released = false;
      return {
        ...lease,
        release() {
          if (released) return;
          released = true;
          counters.released += 1;
          return lease.release();
        },
      };
    },
  };
  const tickets = new ArtifactTicketStore({ now, ttlMs, setTimer, clearTimer });
  const app = express();
  app.all("/artifacts/:artifactId/content", createArtifactContentHandler({ store, tickets }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    tickets.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections?.();
    });
    await actualStore.close();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function artifact(name, content) {
    const sourcePath = path.join(workspaceRealPath, name);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, content);
    return actualStore.ingest({
      workspaceRealPath,
      threadId: "thread-http",
      turnId: "turn-http",
      relativePath: name.replaceAll("\\", "/"),
      sourcePath,
      kind: "created",
      provenance: ["snapshot"],
      detectedAt: Date.now(),
    });
  }

  function ticket(record, purpose = "preview", overrides = {}) {
    return tickets.issue({
      artifactId: record.id,
      sha256: record.sha256,
      purpose,
      sessionId: "session-http",
      ...overrides,
    }).token;
  }

  function url(record, token, extra = "") {
    return `${base}/artifacts/${record.id}/content?ticket=${encodeURIComponent(token)}${extra}`;
  }

  return { actualStore, artifact, base, counters, store, tickets, ticket, url };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("serves GET HEAD and exact single byte ranges from the immutable copy", async (t) => {
  const fx = await fixture(t);
  const record = await fx.artifact("report.txt", "0123456789");
  const get = await fetch(fx.url(record, fx.ticket(record)));
  assert.equal(get.status, 200);
  assert.equal(await get.text(), "0123456789");
  assert.equal(get.headers.get("content-length"), "10");
  assert.equal(get.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(get.headers.get("content-disposition"), /^inline;/);

  const head = await fetch(fx.url(record, fx.ticket(record)), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");

  for (const [range, expected, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=8-99", "89", "bytes 8-9/10"],
  ]) {
    const response = await fetch(fx.url(record, fx.ticket(record)), { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(await response.text(), expected, range);
    assert.equal(response.headers.get("content-range"), contentRange, range);
    assert.equal(response.headers.get("content-length"), String(expected.length), range);
  }
  assert.equal(fx.counters.acquired, 6);
  assert.equal(fx.counters.released, 6);
});

test("returns 416 for malformed unsatisfiable and multi-range requests, including empty files", async (t) => {
  const fx = await fixture(t);
  const record = await fx.artifact("range.txt", "abcdef");
  for (const range of ["items=0-1", "bytes=", "bytes=3-2", "bytes=6-", "bytes=-0", "bytes=0-1,3-4", "bytes=9007199254740992-"]) {
    const response = await fetch(fx.url(record, fx.ticket(record)), { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get("content-range"), "bytes */6", range);
  }
  const empty = await fx.artifact("empty.txt", Buffer.alloc(0));
  const whole = await fetch(fx.url(empty, fx.ticket(empty)));
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-length"), "0");
  assert.equal((await whole.arrayBuffer()).byteLength, 0);
  const ranged = await fetch(fx.url(empty, fx.ticket(empty)), { headers: { Range: "bytes=0-0" } });
  assert.equal(ranged.status, 416);
  assert.equal(ranged.headers.get("content-range"), "bytes */0");
  assert.equal(fx.counters.acquired, 9);
  assert.equal(fx.counters.released, 9);
});

test("rejects expired cross-artifact and stale-sha tickets and prevents cross-purpose elevation", async (t) => {
  let now = 1_000;
  const fx = await fixture(t, { now: () => now, ttlMs: 10, setTimer: () => null });
  const first = await fx.artifact("first.txt", "first");
  const second = await fx.artifact("second.txt", "second");

  const expired = fx.ticket(first);
  now = 1_010;
  assert.equal((await fetch(fx.url(first, expired))).status, 401);

  now = 2_000;
  assert.equal((await fetch(fx.url(second, fx.ticket(first)))).status, 401);
  const stale = fx.tickets.issue({
    artifactId: first.id,
    sha256: "0".repeat(64),
    purpose: "preview",
    sessionId: "session-http",
  }).token;
  assert.equal((await fetch(fx.url(first, stale))).status, 401);

  const download = await fetch(fx.url(first, fx.ticket(first, "download"), "&purpose=preview"));
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  const preview = await fetch(fx.url(first, fx.ticket(first, "preview"), "&purpose=download"));
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-disposition"), /^inline;/);
  assert.equal(fx.counters.acquired, 2);
  assert.equal(fx.counters.released, 2);
});

test("releases the artifact lease after completion invalid ranges stream errors and client disconnect", async (t) => {
  const fx = await fixture(t);
  const record = await fx.artifact("large.txt", Buffer.alloc(2 * 1024 * 1024, 0x61));

  const completed = await fetch(fx.url(record, fx.ticket(record)));
  await completed.arrayBuffer();
  await waitFor(() => fx.counters.released === 1);

  const invalid = await fetch(fx.url(record, fx.ticket(record)), { headers: { Range: "bytes=9-2" } });
  assert.equal(invalid.status, 416);
  await waitFor(() => fx.counters.released === 2);

  const originalOpen = fx.store.openContent;
  fx.store.openContent = async (id) => {
    const lease = await originalOpen.call(fx.store, id);
    await fs.rm(lease.path, { force: true });
    return lease;
  };
  await assert.rejects(fetch(fx.url(record, fx.ticket(record))));
  await waitFor(() => fx.counters.released === 3);

  const abortRecord = await fx.artifact("abort.txt", Buffer.alloc(4 * 1024 * 1024, 0x62));
  fx.store.openContent = originalOpen;
  await new Promise((resolve, reject) => {
    const request = http.get(fx.url(abortRecord, fx.ticket(abortRecord)), (response) => {
      response.once("data", () => response.destroy());
      response.once("close", resolve);
    });
    request.once("error", (error) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
  });
  await waitFor(() => fx.counters.released === 4);
  assert.equal(fx.counters.acquired, 4);
  assert.equal(fx.counters.released, 4);
});

test("forces active unknown and signature-conflicting content to attachment", async (t) => {
  const fx = await fixture(t);
  const active = await fx.artifact("page.html", "<h1>active</h1>");
  const unknown = await fx.artifact("payload.bin", Buffer.from([1, 2, 3]));
  const conflict = await fx.artifact("fake.png", "not a png");
  const utf16 = await fx.artifact("wide.txt", Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  for (const record of [active, unknown, conflict]) {
    const response = await fetch(fx.url(record, fx.ticket(record, "preview")));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    await response.arrayBuffer();
  }
  const wide = await fetch(fx.url(utf16, fx.ticket(utf16, "preview")));
  assert.equal(wide.headers.get("content-type"), "text/plain; charset=utf-16le");
  assert.match(wide.headers.get("content-disposition"), /^inline;/);
  await wide.arrayBuffer();
});

test("sanitizes filename and filename-star without CRLF control quote or slash injection", async (t) => {
  const fx = await fixture(t);
  const record = await fx.artifact("safe.txt", "safe");
  const hostile = "报告\r\nInjected: yes\u0001\"/\\.txt";
  const wrapped = {
    get(id) {
      const found = fx.store.get(id);
      return found ? { ...found, displayName: hostile } : null;
    },
    async openContent(id) {
      const lease = await fx.store.openContent(id);
      return { ...lease, record: { ...lease.record, displayName: hostile } };
    },
  };
  const app = express();
  app.get("/hostile/:artifactId", createArtifactContentHandler({ store: wrapped, tickets: fx.tickets }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeIdleConnections?.();
  }));
  const token = fx.ticket(record, "download");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/hostile/${record.id}?ticket=${token}`);
  const disposition = response.headers.get("content-disposition");
  assert.match(disposition, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
  assert.doesNotMatch(disposition, /[\r\n\u0000-\u001f\u007f\\/]/);
  assert.ok(disposition.includes("%E6%8A%A5%E5%91%8A"));
  await response.arrayBuffer();
});

test("allows credential-free CORS without accepting or requiring the long-lived remote token", async (t) => {
  const fx = await fixture(t);
  const record = await fx.artifact("cors.txt", "cors");
  const unrelatedBearer = `Bearer ${"x".repeat(24)}`;
  const response = await fetch(fx.url(record, fx.ticket(record)), {
    headers: { Authorization: unrelatedBearer },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.match(response.headers.get("access-control-expose-headers"), /Content-Range/);
  await response.text();
  assert.equal((await fetch(`${fx.base}/artifacts/${record.id}/content`, {
    headers: { Authorization: unrelatedBearer },
  })).status, 401);
});

test("parseSingleRange is strict and deterministic", () => {
  assert.equal(parseSingleRange(null, 10), null);
  assert.deepEqual(parseSingleRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseSingleRange("bytes=-20", 10), { start: 0, end: 9 });
  assert.throws(() => parseSingleRange("bytes=0-0,2-2", 10), /invalid_range/);
  assert.throws(() => parseSingleRange("bytes=0-0", 0), /invalid_range/);
});
