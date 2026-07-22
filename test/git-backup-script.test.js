import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "create-git-backup.ps1");
const windowsTest = process.platform === "win32" ? test : test.skip;

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return { ...result, output: `${result.stdout || ""}\n${result.stderr || ""}` };
}

function git(cwd, ...args) {
  const result = run("git", ["-C", cwd, ...args]);
  assert.equal(result.status, 0, result.output);
  return result.stdout.trim();
}

function createFixture(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "Codex Remote git backup 测试-"));
  const repository = path.join(fixtureRoot, "codex-remote");
  const backups = path.join(fixtureRoot, "备份输出");
  fs.mkdirSync(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Codex Remote Test");
  git(repository, "config", "user.email", "codex-remote@example.invalid");
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({
    name: "codex-phone-remote",
    version: "0.1.0",
    private: true,
    scripts: { "release:verify": "node -e \"console.log('[release] OK')\"" },
  }, null, 2));
  fs.writeFileSync(path.join(repository, "README.md"), "# fixture\n");
  git(repository, "add", "package.json", "README.md");
  git(repository, "commit", "-m", "initial fixture");
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  return { fixtureRoot, repository, backups };
}

function backup(repository, backups) {
  return run("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-RepositoryRoot", repository,
    "-DestinationRoot", backups,
  ]);
}

windowsTest("creates verifies and restores a full-history bundle from a clean repository", (t) => {
  const fixture = createFixture(t);
  const expectedHead = git(fixture.repository, "rev-parse", "HEAD");
  const result = backup(fixture.repository, fixture.backups);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[git-backup\] OK/);

  const bundles = fs.readdirSync(fixture.backups).filter((name) => name.endsWith(".bundle"));
  assert.equal(bundles.length, 1);
  const bundle = path.join(fixture.backups, bundles[0]);
  const verify = run("git", ["-C", fixture.repository, "bundle", "verify", bundle]);
  assert.equal(verify.status, 0, verify.output);

  const restored = path.join(fixture.fixtureRoot, "恢复仓库");
  const clone = run("git", ["clone", bundle, restored]);
  assert.equal(clone.status, 0, clone.output);
  assert.equal(git(restored, "rev-parse", "HEAD"), expectedHead);
  assert.equal(git(restored, "status", "--porcelain"), "");
});

windowsTest("refuses a dirty tree without writing a partial backup", (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.repository, "uncommitted.txt"), "not backed up\n");
  const result = backup(fixture.repository, fixture.backups);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /working tree must be clean/i);
  assert.equal(fs.existsSync(fixture.backups), false);
});

test("backup entrypoints never stage commit push or handle credentials", () => {
  const powershell = fs.readFileSync(script, "utf8");
  const batch = fs.readFileSync(path.join(root, "创建Git备份.bat"), "utf8");
  const legacyRepository = ["cla", "ude-remote"].join("");
  assert.match(batch, /scripts\\create-git-backup\.ps1/i);
  assert.match(powershell, /git[\s\S]*bundle[\s\S]*create/i);
  assert.match(powershell, /git[\s\S]*bundle[\s\S]*verify/i);
  assert.doesNotMatch(`${powershell}\n${batch}`, new RegExp(`git\\s+(?:push|add|commit)|${legacyRepository}|GH_TOKEN|GITHUB_TOKEN`, "i"));
});
