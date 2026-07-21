import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveOptionalBinary } from "../src/optional-binary.js";

test("prefers a product-root binary and never probes the parent", () => {
  const checked = [];
  const productRoot = path.resolve("standalone", "codex-remote");
  const local = path.join(productRoot, "ffmpeg.exe");
  const result = resolveOptionalBinary("ffmpeg.exe", {
    productRoot,
    existsSync(candidate) { checked.push(candidate); return candidate === local; },
  });
  assert.equal(result, local);
  assert.deepEqual(checked, [local]);
});

test("falls back to PATH lookup by command name only", () => {
  const productRoot = path.resolve("standalone", "codex-remote");
  const checked = [];
  const result = resolveOptionalBinary("cloudflared.exe", {
    productRoot,
    existsSync(candidate) { checked.push(candidate); return false; },
  });
  assert.equal(result, "cloudflared.exe");
  assert.deepEqual(checked, [path.join(productRoot, "cloudflared.exe")]);
});
