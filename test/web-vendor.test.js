import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("committed PDF.js assets match the pinned development package", () => {
  const run = spawnSync(process.execPath, ["scripts/sync-web-vendor.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test("Git checkout preserves byte-exact PDF.js vendor assets", () => {
  const attributes = fs.readFileSync(path.join(root, ".gitattributes"), "utf8");
  for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs", "LICENSE"]) {
    const escaped = name.replaceAll(".", "\\.");
    assert.match(attributes, new RegExp(`^/public/vendor/pdfjs/${escaped}\\s+.*(?:-text|eol=lf)`, "m"));
  }
});

test("service worker caches local PDF modules and no PDF CDN", () => {
  const sw = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");
  assert.match(sw, /artifact-ui\.js/);
  assert.match(sw, /vendor\/pdfjs\/pdf\.min\.mjs/);
  assert.match(sw, /vendor\/pdfjs\/pdf\.worker\.min\.mjs/);
  assert.match(sw, /vendor\/pdfjs\/LICENSE/);
  assert.doesNotMatch(sw, /https?:\/\//);
});
