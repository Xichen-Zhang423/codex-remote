import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release copy script archives HEAD into two clean Unicode copies", () => {
  const script = fs.readFileSync(path.join(root, "scripts/verify-release-copy.ps1"), "utf8");
  const legacyRemoteName = new RegExp(["Cla", "ude Remote"].join(""), "i");
  for (const pattern of [
    /rev-parse[\s\S]*--show-prefix/, /rev-parse[\s\S]*--show-toplevel/, /HEAD:\$prefix/,
    /Invoke-Native 'git' @\('-c', 'core\.autocrlf=false', '-C', \$repoRoot,[^\r\n]*'archive'/,
    /\$installCopyName = -join @\(\[char\]0x5B89,[^\r\n]*\[char\]0x672C\)/,
    /\$launcherCopyName = -join @\(\[char\]0x542F,[^\r\n]*\[char\]0x672C\)/,
    /Expand-Archive/,
    /npm_config_cache/, /package-lock\.json/, /app-android[\\/]package-lock\.json/,
    /npm\.cmd[\s\S]*ci/, /npm\.cmd[\s\S]*run[\s\S]*verify/,
    /test[\\/]start-bat\.test\.js/, /finally/, /Remove-Item[\s\S]*-Recurse/,
  ]) assert.match(script, pattern);
  const destinations = [...script.matchAll(/Expand-Archive[^\r\n]*-DestinationPath\s+\$(installCopy|launcherCopy)/g)]
    .map((match) => match[1]).sort();
  assert.deepEqual(destinations, ["installCopy", "launcherCopy"]);
  assert.doesNotMatch(script, /Copy-Item[\s\S]*-Recurse|\.\.\\ffmpeg|\.\.\\cloudflared/i);
  assert.doesNotMatch(script, legacyRemoteName);
});

test("release copy is an explicit final gate", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "verify.yml"), "utf8");
  assert.match(pkg.scripts["release:copy"], /verify-release-copy\.ps1/);
  assert.doesNotMatch(pkg.scripts.test, /release:copy/);
  assert.match(workflow, /Verify standalone archive[\s\S]*npm run release:copy/);
});
