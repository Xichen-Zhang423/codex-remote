import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("README presents the product and links every redacted showcase image", () => {
  const readme = read("README.md");
  assert.match(read(".gitignore"), /^!docs\/images\/\*\.png$/m);
  for (const phrase of [
    "手机遥控 Codex", "Phone Remote for Codex", "任务产出", "逐项批准",
    "五分钟开始", "GitHub 发布与备份",
  ]) assert.match(readme, new RegExp(phrase, "i"));
  for (const image of ["mobile-console.png", "mobile-artifacts.png", "desktop-panel.png"]) {
    assert.match(readme, new RegExp(`docs/images/${image.replaceAll(".", "\\.")}`));
    const bytes = fs.readFileSync(path.join(root, "docs", "images", image));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", image);
    assert.ok(bytes.length < 500_000, `${image} should remain repository-friendly`);
  }
  assert.doesNotMatch(readme, /\?token=|trycloudflare\.com|[A-Z]:\\Users\\|D:\\EdgeDownload/i);
});

test("publishing documentation is reachable from README and never targets the previous remote", () => {
  const readme = read("README.md");
  const guide = read("docs/GitHub发布与备份.md");
  const legacyBrand = ["Cla", "ude Remote"].join("");
  const legacyRepository = ["cla", "ude-remote"].join("");
  assert.match(readme, /\.\/docs\/GitHub发布与备份\.md/);
  assert.match(guide, /git remote add origin/);
  assert.match(guide, /git push -u origin main/);
  assert.match(guide, /git bundle (?:create|verify)/);
  assert.match(guide, /git clone[^\n]*\.bundle/);
  assert.doesNotMatch(`${readme}\n${guide}`, new RegExp(`Xichen-Zhang423/${legacyRepository}|${legacyBrand} repository`, "i"));
});
