import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expected = new Map([
  ["public/icons/icon-16.png", 16], ["public/icons/icon-32.png", 32],
  ["public/icons/icon-180.png", 180], ["public/icons/icon-192.png", 192],
  ["public/icons/icon-512.png", 512], ["public/icons/icon-maskable-512.png", 512],
  ["app-android/resources/mipmap-mdpi/ic_launcher.png", 48],
  ["app-android/resources/mipmap-hdpi/ic_launcher.png", 72],
  ["app-android/resources/mipmap-xhdpi/ic_launcher.png", 96],
  ["app-android/resources/mipmap-xxhdpi/ic_launcher.png", 144],
  ["app-android/resources/mipmap-xxxhdpi/ic_launcher.png", 192],
  ["app-harmony/resources/base/media/app_icon.png", 512],
]);

test("committed brand PNGs have exact dimensions", () => {
  for (const [relative, size] of expected) {
    const png = fs.readFileSync(path.join(root, relative));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], relative);
    assert.equal(png.readUInt32BE(16), size, `${relative} width`);
    assert.equal(png.readUInt32BE(20), size, `${relative} height`);
  }
});

test("manifest, HTML, service worker, Android, and Harmony use one identity", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "public/manifest.webmanifest"), "utf8"));
  assert.ok(manifest.icons.some((icon) => icon.src === "icons/icon-192.png" && icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.src === "icons/icon-maskable-512.png" && /maskable/.test(icon.purpose)));
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  assert.match(html, /apple-touch-icon[^>]+icons\/icon-180\.png/);
  assert.match(html, /icons\/icon-16\.png/);
  assert.match(html, /icons\/icon-32\.png/);
  const panel = fs.readFileSync(path.join(root, "public/panel.html"), "utf8");
  assert.match(panel, /apple-touch-icon[^>]+icons\/icon-180\.png/);
  assert.match(panel, /icons\/icon-16\.png/);
  assert.match(panel, /icons\/icon-32\.png/);
  const sw = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");
  for (const relative of [...expected.keys()].filter((name) => name.startsWith("public/")))
    assert.match(sw, new RegExp(relative.slice(7).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "app-harmony/resources/base/element/string.json"), "utf8")).string[0].value, "Codex Remote");
});

test("generated files are byte-current", () => {
  const result = spawnSync(process.execPath, ["scripts/generate-brand-assets.mjs", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
