import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { ArtifactTicketStore } from "../src/artifact-tickets.js";

const SHA = "a".repeat(64);

function ticketInput(overrides = {}) {
  return {
    artifactId: "artifact-1",
    sha256: SHA,
    purpose: "preview",
    sessionId: "session-1",
    release: () => {},
    ...overrides,
  };
}

function fakeClock(start = 1_000) {
  let time = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    set(value) { time = value; },
    setTimer(callback, delay) {
      const timer = { id: nextId++, callback, delay, unrefCalled: false };
      timer.unref = () => { timer.unrefCalled = true; };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimer(timer) { timers.delete(timer.id); },
    timers,
  };
}

test("issues a 32-byte base64url secret with its expiry while exposing only safe store state", () => {
  const clock = fakeClock();
  const store = new ArtifactTicketStore({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const issued = store.issue(ticketInput());
  assert.deepEqual(Object.keys(issued).sort(), ["expiresAt", "token"]);
  assert.equal(issued.expiresAt, 61_000);
  const { token } = issued;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.deepEqual(JSON.parse(JSON.stringify(store)), { active: 1 });
  assert.doesNotMatch(inspect(store, { showHidden: true, depth: 10 }), new RegExp(token));

  const grant = store.consume(token, {
    artifactId: "artifact-1",
    sha256: SHA,
    expectedPurpose: "preview",
  });
  assert.deepEqual(grant, {
    artifactId: "artifact-1",
    sha256: SHA,
    purpose: "preview",
    sessionId: "session-1",
    expiresAt: grant.expiresAt,
  });
  assert.equal(grant.expiresAt, issued.expiresAt);
  assert.equal("release" in grant, false);
  assert.equal("digest" in grant, false);
  store.close();
});

test("allows an omitted release callback and treats short sha256 values as opaque bindings", () => {
  const store = new ArtifactTicketStore({ maxUses: 1 });
  const issued = store.issue({
    artifactId: "artifact-short-sha",
    sha256: "h",
    purpose: "preview",
    sessionId: "session-short-sha",
  });
  assert.equal(store.consume(issued.token, {
    artifactId: "artifact-short-sha",
    sha256: "hash",
  }), null);
  assert.ok(store.consume(issued.token, {
    artifactId: "artifact-short-sha",
    sha256: "h",
    expectedPurpose: "preview",
  }));
});

test("binding mismatches do not consume a use and purpose may be returned without an expectation", () => {
  let released = 0;
  const store = new ArtifactTicketStore({ maxUses: 1 });
  const issued = store.issue(ticketInput({ purpose: "download", release: () => { released += 1; } }));
  const { token } = issued;
  assert.equal(store.consume(token, { artifactId: "other", sha256: SHA }), null);
  assert.equal(store.consume(token, { artifactId: "artifact-1", sha256: "b".repeat(64) }), null);
  assert.equal(store.consume(token, {
    artifactId: "artifact-1",
    sha256: SHA,
    expectedPurpose: "preview",
  }), null);
  assert.equal(released, 0);

  const grant = store.consume(token, { artifactId: "artifact-1", sha256: SHA });
  assert.equal(grant.purpose, "download");
  assert.equal(grant.sessionId, "session-1");
  assert.equal(released, 1);
  assert.equal(store.consume(token, { artifactId: "artifact-1", sha256: SHA }), null);
});

test("defaults to a 60 second TTL and eight successful uses, releasing exactly once", () => {
  const clock = fakeClock();
  let released = 0;
  const store = new ArtifactTicketStore({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const issued = store.issue(ticketInput({ release: () => { released += 1; } }));
  const { token } = issued;
  const options = { artifactId: "artifact-1", sha256: SHA };
  for (let use = 1; use <= 8; use += 1) {
    const grant = store.consume(token, options);
    assert.equal(grant.expiresAt, 61_000);
    assert.equal(released, use === 8 ? 1 : 0);
  }
  assert.equal(store.consume(token, options), null);
  assert.equal(released, 1);
  assert.deepEqual(store.toJSON(), { active: 0 });
});

test("expires at the exact TTL boundary and timer expiry is idempotent", () => {
  const clock = fakeClock(5_000);
  let released = 0;
  const store = new ArtifactTicketStore({
    now: clock.now,
    ttlMs: 25,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const issued = store.issue(ticketInput({ release: () => { released += 1; } }));
  const { token } = issued;
  const [timer] = clock.timers.values();
  assert.equal(timer.delay, 25);
  assert.equal(timer.unrefCalled, true);
  clock.set(5_025);
  assert.equal(store.consume(token, { artifactId: "artifact-1", sha256: SHA }), null);
  assert.equal(released, 1);
  timer.callback();
  assert.equal(released, 1);

  const timerIssued = store.issue(ticketInput({ artifactId: "artifact-2", release: () => { released += 1; } }));
  const activeTimer = [...clock.timers.values()][0];
  activeTimer.callback();
  assert.equal(store.consume(timerIssued.token, { artifactId: "artifact-2", sha256: SHA }), null);
  assert.equal(released, 2);
  assert.deepEqual(store.toJSON(), { active: 0 });
});

test("revokes a session and prunes expired or exhausted grants", () => {
  const clock = fakeClock();
  const releases = [];
  const store = new ArtifactTicketStore({
    now: clock.now,
    ttlMs: 10,
    maxUses: 2,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const one = store.issue(ticketInput({ release: () => releases.push("one") }));
  const two = store.issue(ticketInput({ artifactId: "artifact-2", release: () => releases.push("two") }));
  const other = store.issue(ticketInput({ artifactId: "artifact-3", sessionId: "session-2", release: () => releases.push("other") }));
  assert.equal(store.revokeSession("session-1"), 2);
  assert.deepEqual(releases.sort(), ["one", "two"]);
  assert.equal(store.consume(one.token, { artifactId: "artifact-1", sha256: SHA }), null);
  assert.equal(store.consume(two.token, { artifactId: "artifact-2", sha256: SHA }), null);

  const options = { artifactId: "artifact-3", sha256: SHA };
  assert.ok(store.consume(other.token, options));
  assert.ok(store.consume(other.token, options));
  assert.equal(store.prune(), 0);

  const expired = store.issue(ticketInput({ artifactId: "artifact-4", sessionId: "session-3", release: () => releases.push("expired") }));
  clock.set(1_010);
  assert.equal(store.prune(), 1);
  assert.equal(store.consume(expired.token, { artifactId: "artifact-4", sha256: SHA }), null);
  assert.equal(releases.includes("expired"), true);
  assert.deepEqual(store.toJSON(), { active: 0 });
});

test("release failures are isolated after deletion across consume, revoke, timer, and close", () => {
  const clock = fakeClock();
  const store = new ArtifactTicketStore({
    now: clock.now,
    maxUses: 1,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const throwing = () => { throw new Error("release failed"); };
  const consumed = store.issue(ticketInput({ release: throwing }));
  assert.doesNotThrow(() => store.consume(consumed.token, { artifactId: "artifact-1", sha256: SHA }));
  assert.equal(store.consume(consumed.token, { artifactId: "artifact-1", sha256: SHA }), null);

  store.issue(ticketInput({ artifactId: "artifact-2", release: throwing }));
  assert.doesNotThrow(() => store.revokeSession("session-1"));
  const timed = store.issue(ticketInput({ artifactId: "artifact-3", sessionId: "session-3", release: throwing }));
  const timer = [...clock.timers.values()][0];
  assert.doesNotThrow(() => timer.callback());
  assert.equal(store.consume(timed.token, { artifactId: "artifact-3", sha256: SHA }), null);
  store.issue(ticketInput({ artifactId: "artifact-4", sessionId: "session-4", release: throwing }));
  assert.doesNotThrow(() => store.close());
  assert.doesNotThrow(() => store.close());
  assert.deepEqual(store.toJSON(), { active: 0 });
});

test("rejects invalid configuration and issue inputs", () => {
  for (const ttlMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ArtifactTicketStore({ ttlMs }), /ttlMs/);
  }
  for (const maxUses of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ArtifactTicketStore({ maxUses }), /maxUses/);
  }
  const store = new ArtifactTicketStore();
  for (const [field, value] of [
    ["artifactId", ""], ["artifactId", 1], ["sha256", ""], ["sha256", 1],
    ["purpose", "share"], ["purpose", ""], ["sessionId", ""], ["sessionId", null],
    ["release", null], ["release", "release"],
  ]) {
    assert.throws(() => store.issue(ticketInput({ [field]: value })), new RegExp(field));
  }
  assert.deepEqual(store.toJSON(), { active: 0 });
});

test("malformed tokens and consume inputs fail closed without consuming a valid ticket", () => {
  const store = new ArtifactTicketStore({ maxUses: 1 });
  const issued = store.issue(ticketInput());
  const { token } = issued;
  for (const badToken of [null, undefined, "", 1, {}, "x", `${token}=`, "!".repeat(43)]) {
    assert.equal(store.consume(badToken, { artifactId: "artifact-1", sha256: SHA }), null);
  }
  for (const options of [
    null,
    {},
    { artifactId: "", sha256: SHA },
    { artifactId: "artifact-1", sha256: "" },
    { artifactId: "artifact-1", sha256: SHA, expectedPurpose: "share" },
  ]) assert.equal(store.consume(token, options), null);
  assert.equal(store.revokeSession(""), 0);
  assert.ok(store.consume(token, { artifactId: "artifact-1", sha256: SHA, expectedPurpose: null }));
  assert.equal(store.consume(token, { artifactId: "artifact-1", sha256: SHA }), null);
});
