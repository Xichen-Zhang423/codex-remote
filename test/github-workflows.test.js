import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8");

test("Windows CI performs clean and strict verification", () => {
  const workflow = read("verify.yml");
  for (const pattern of [
    /windows-latest/, /node-version:\s*["']22["']/, /cache:\s*npm/,
    /npm ci --no-audit --no-fund/, /npm run verify/, /npm run release:verify/,
    /permissions:[\s\S]*contents:\s*read/, /timeout-minutes:\s*20/,
    /cancel-in-progress:\s*true/,
  ]) assert.match(workflow, pattern);
});

test("APK CI remains unsigned Debug-only", () => {
  const workflow = read("build-apk.yml");
  for (const pattern of [
    /ubuntu-latest/, /node-version:\s*["']22["']/, /java-version:\s*["']21["']/,
    /android-actions\/setup-android@v3/, /npx cap add android/, /npx cap sync android/,
    /node scripts\/patch-android\.mjs/, /assembleDebug --no-daemon/,
    /app-android\/android\/app\/build\/outputs\/apk\/debug\/app-debug\.apk/,
  ]) assert.match(workflow, pattern);
  assert.doesNotMatch(workflow, /keystore|storePassword|keyPassword|signingConfig|secrets\./i);
});
