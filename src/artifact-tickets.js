import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_USES = 8;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PURPOSES = new Set(["preview", "download"]);

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function isNonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function digestToken(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function validToken(token) {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

function validSha256(value) {
  return isNonemptyString(value);
}

export class ArtifactTicketStore {
  #grants = new Map();
  #now;
  #ttlMs;
  #maxUses;
  #setTimer;
  #clearTimer;

  constructor({
    now = Date.now,
    ttlMs = DEFAULT_TTL_MS,
    maxUses = DEFAULT_MAX_USES,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
  } = {}) {
    this.#now = requireFunction(now, "now");
    this.#ttlMs = positiveSafeInteger(ttlMs, "ttlMs");
    this.#maxUses = positiveSafeInteger(maxUses, "maxUses");
    this.#setTimer = requireFunction(setTimer, "setTimer");
    this.#clearTimer = requireFunction(clearTimer, "clearTimer");
  }

  issue({ artifactId, sha256, purpose, sessionId, release = () => {} } = {}) {
    if (!isNonemptyString(artifactId)) throw new TypeError("artifactId must be a nonempty string");
    if (!validSha256(sha256)) throw new TypeError("sha256 must be a nonempty string");
    if (!PURPOSES.has(purpose)) throw new TypeError("purpose must be preview or download");
    if (!isNonemptyString(sessionId)) throw new TypeError("sessionId must be a nonempty string");
    requireFunction(release, "release");

    let token;
    let digest;
    let key;
    do {
      token = randomBytes(32).toString("base64url");
      digest = digestToken(token);
      key = digest.toString("hex");
    } while (this.#grants.has(key));

    const issuedAt = this.#now();
    if (!Number.isFinite(issuedAt)) throw new TypeError("now must return a finite number");
    const expiresAt = issuedAt + this.#ttlMs;
    const entry = {
      digest,
      artifactId,
      sha256,
      purpose,
      sessionId,
      expiresAt,
      uses: 0,
      timer: null,
      release,
    };
    this.#grants.set(key, entry);
    try {
      entry.timer = this.#setTimer(() => this.#drop(key, entry), this.#ttlMs);
      entry.timer?.unref?.();
    } catch (error) {
      this.#drop(key, entry);
      throw error;
    }
    return { token, expiresAt };
  }

  consume(token, options) {
    if (!validToken(token) || !options || typeof options !== "object") return null;
    const { artifactId, sha256, expectedPurpose = null } = options;
    if (!isNonemptyString(artifactId) || !validSha256(sha256)) return null;
    if (expectedPurpose !== null && !PURPOSES.has(expectedPurpose)) return null;

    const digest = digestToken(token);
    const key = digest.toString("hex");
    const entry = this.#grants.get(key);
    if (!entry || entry.digest.length !== digest.length || !timingSafeEqual(entry.digest, digest)) return null;
    if (entry.expiresAt <= this.#now() || entry.uses >= this.#maxUses) {
      this.#drop(key, entry);
      return null;
    }
    if (entry.artifactId !== artifactId || entry.sha256 !== sha256) return null;
    if (expectedPurpose !== null && entry.purpose !== expectedPurpose) return null;

    entry.uses += 1;
    const grant = {
      artifactId: entry.artifactId,
      sha256: entry.sha256,
      purpose: entry.purpose,
      sessionId: entry.sessionId,
      expiresAt: entry.expiresAt,
    };
    if (entry.uses >= this.#maxUses) this.#drop(key, entry);
    return grant;
  }

  revokeSession(sessionId) {
    if (!isNonemptyString(sessionId)) return 0;
    let dropped = 0;
    for (const [key, entry] of [...this.#grants]) {
      if (entry.sessionId === sessionId && this.#drop(key, entry)) dropped += 1;
    }
    return dropped;
  }

  prune() {
    const now = this.#now();
    let dropped = 0;
    for (const [key, entry] of [...this.#grants]) {
      if ((entry.expiresAt <= now || entry.uses >= this.#maxUses) && this.#drop(key, entry)) {
        dropped += 1;
      }
    }
    return dropped;
  }

  close() {
    let dropped = 0;
    for (const [key, entry] of [...this.#grants]) {
      if (this.#drop(key, entry)) dropped += 1;
    }
    return dropped;
  }

  revokeAll() {
    return this.close();
  }

  toJSON() {
    return { active: this.#grants.size };
  }

  #drop(key, expectedEntry) {
    const entry = this.#grants.get(key);
    if (!entry || (expectedEntry && entry !== expectedEntry)) return false;
    this.#grants.delete(key);
    try {
      if (entry.timer != null) this.#clearTimer(entry.timer);
    } catch {
      // A timer adapter cannot prevent the lease from being released.
    }
    try {
      const released = entry.release();
      if (released && typeof released.then === "function") released.catch(() => {});
    } catch {
      // Release is best effort after the grant is irreversibly revoked.
    }
    return true;
  }
}
