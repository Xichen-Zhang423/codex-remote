import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateForbiddenFiles,
  validateGitHistory,
  validateLockfile,
  validateMarkdownLinks,
  validatePwaShell,
  validateRuntimeIndependence,
  verifyRelease,
} from "../scripts/release-verify.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "app-android"), { recursive: true });
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  const pkg = { name: "codex-phone-remote", version: "0.1.0", private: true, dependencies: { x: "1.0.0" } };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies } } };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  fs.writeFileSync(path.join(root, "README.md"), "[license](LICENSE)\n");
  fs.writeFileSync(path.join(root, "LICENSE"), "MIT\n");
  return root;
}

test("lockfile failures name only the offending relative path", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "package-lock.json"), "{broken");
  assert.deepEqual(validateLockfile(root, "package.json", "package-lock.json"), ["package-lock.json: invalid JSON"]);
});

test("lockfile dependency comparison ignores object key order", (t) => {
  const root = fixture(t);
  const manifest = { name: "codex-phone-remote", version: "0.1.0", dependencies: { alpha: "1", beta: "2" }, devDependencies: { delta: "4", gamma: "3" } };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { "": {
    name: manifest.name, version: manifest.version,
    dependencies: { beta: "2", alpha: "1" }, devDependencies: { gamma: "3", delta: "4" },
  } } };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  assert.deepEqual(validateLockfile(root, "package.json", "package-lock.json"), []);
});

test("Markdown links reject missing files and root escape", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "README.md"), "[missing](docs/no.md) [escape](../secret.txt) [web](https://openai.com)\n");
  assert.deepEqual(validateMarkdownLinks(root), [
    "README.md: local link escapes product root: ../secret.txt",
    "README.md: missing local link: docs/no.md",
  ]);
});

test("Markdown links support balanced inline and reference-definition destinations", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "docs"));
  for (const name of ["a(b).md", "guide.md", "space file.md"])
    fs.writeFileSync(path.join(root, "docs", name), "# doc\n");
  fs.writeFileSync(path.join(root, "README.md"), [
    "[inline](docs/a(b).md?view=1#part)",
    "[encoded](docs%2Fguide.md?view=1#part)",
    "[guide]: docs/guide.md#intro",
    "[space]: <docs/space file.md> \"title\"",
    "[bad]: docs/no(1).md \"title\"",
  ].join("\n"));
  assert.deepEqual(validateMarkdownLinks(root), ["README.md: missing local link: docs/no(1).md"]);
});

test("Markdown links reject realpath escape through a filesystem link", (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-markdown-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "outside.md"), "outside");
  const linked = path.join(root, "docs-link");
  try {
    fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`filesystem links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  fs.writeFileSync(path.join(root, "README.md"), "[outside](docs-link/outside.md)\n");
  assert.deepEqual(validateMarkdownLinks(root), [
    "README.md: local link escapes product root through filesystem link: docs-link/outside.md",
  ]);
});

test("Markdown validation ignores code footnotes escaped links and ordinary markers", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "README.md"), [
    "```md",
    "[fenced](missing-fenced.md)",
    "```",
    "~~~md",
    "[tilde fenced](missing-tilde.md)",
    "~~~",
    "`[inline code](missing-inline.md)`",
    "[^note]: missing-footnote.md",
    "\\[escaped](missing-escaped.md)",
    "ordinary ](missing-ordinary.md)",
    "[real](LICENSE)",
    "[real-ref]: LICENSE#license",
  ].join("\n"));
  assert.deepEqual(validateMarkdownLinks(root), []);
});

test("Markdown marker attacks complete within a bounded child process", () => {
  const scriptUrl = new URL("../scripts/release-verify.js", import.meta.url).href;
  const source = [
    'import fs from "node:fs";',
    'import os from "node:os";',
    'import path from "node:path";',
    `const { validateMarkdownLinks } = await import(${JSON.stringify(scriptUrl)});`,
    'const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-md-markers-"));',
    'try {',
    '  fs.writeFileSync(path.join(root, "README.md"), "](".repeat(12000) + "[x](".repeat(12000));',
    '  if (validateMarkdownLinks(root).length !== 0) process.exitCode = 2;',
    '} finally { fs.rmSync(root, { recursive: true, force: true }); }',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.code ?? `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("PWA validator names a missing manifest icon", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "public", "manifest.webmanifest"), JSON.stringify({ name: "Codex Remote", short_name: "Codex Remote", start_url: ".", display: "standalone", theme_color: "#0b0d0c", icons: [{ src: "missing.png" }] }));
  fs.writeFileSync(path.join(root, "public", "sw.js"), "");
  assert.match(validatePwaShell(root).join("\n"), /public\/missing\.png/);
});

test("PWA icons cannot traverse or name a directory", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "public", "icons"));
  fs.writeFileSync(path.join(root, "public", "manifest.webmanifest"), JSON.stringify({
    name: "Codex Remote", short_name: "Codex Remote", start_url: ".", display: "standalone", theme_color: "#0b0d0c",
    icons: [{ src: "../LICENSE" }, { src: "%2e%2e/LICENSE" }, { src: "icons" }],
  }));
  fs.writeFileSync(path.join(root, "public", "sw.js"), "");
  assert.deepEqual(validatePwaShell(root).filter((line) => line.includes("manifest icon")), [
    "public/%2e%2e/LICENSE: manifest icon escapes public root",
    "public/../LICENSE: manifest icon escapes public root",
    "public/icons: manifest icon is not a regular file",
  ]);
});

test("PWA icons cannot escape public through a filesystem link", (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pwa-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "icon.png"), "png");
  const linked = path.join(root, "public", "linked");
  try {
    fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`filesystem links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  fs.writeFileSync(path.join(root, "public", "manifest.webmanifest"), JSON.stringify({
    name: "Codex Remote", short_name: "Codex Remote", start_url: ".", display: "standalone", theme_color: "#0b0d0c",
    icons: [{ src: "linked/icon.png" }],
  }));
  fs.writeFileSync(path.join(root, "public", "sw.js"), "");
  assert.match(validatePwaShell(root).join("\n"), /manifest icon.*public root/);
});

test("PWA validation rejects an entire public junction before reading outside files", (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-public-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "manifest.webmanifest"), JSON.stringify({ name: "Outside" }));
  fs.writeFileSync(path.join(outside, "sw.js"), "outside");
  fs.rmSync(path.join(root, "public"), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(root, "public"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`filesystem links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.deepEqual(validatePwaShell(root), ["public: PWA root is not a real directory inside product root"]);
});

test("PWA validation rejects a manifest symlink before reading its target", (t) => {
  const root = fixture(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-manifest-outside-"));
  const outside = path.join(outsideRoot, "outside.webmanifest");
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  fs.writeFileSync(outside, JSON.stringify({ name: "Outside", short_name: "Outside", start_url: ".", display: "standalone", theme_color: "#000" }));
  const manifest = path.join(root, "public", "manifest.webmanifest");
  try {
    fs.symlinkSync(outside, manifest, "file");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code) || process.platform !== "win32") throw error;
    fs.symlinkSync(outsideRoot, manifest, "junction");
  }
  assert.deepEqual(validatePwaShell(root), ["public/manifest.webmanifest: PWA manifest is not a regular file"]);
});

test("runtime validator rejects an explicit parent lookup", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "bad.js"), 'path.resolve(projectDir, "..", "ffmpeg.exe");');
  assert.deepEqual(validateRuntimeIndependence(root), ["src/bad.js: parent-directory runtime lookup"]);
});

test("missing and non-file PWA shell plus runtime sources return deterministic errors", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "public", "manifest.webmanifest"), JSON.stringify({
    name: "Codex Remote", short_name: "Codex Remote", start_url: ".", display: "standalone", theme_color: "#0b0d0c",
  }));
  assert.deepEqual(validatePwaShell(root), ["public/sw.js: PWA shell is missing"]);
  assert.deepEqual(validateRuntimeIndependence(root), ["src: runtime source directory is missing"]);
  fs.mkdirSync(path.join(root, "public", "sw.js"));
  fs.writeFileSync(path.join(root, "src"), "not a directory");
  assert.deepEqual(validatePwaShell(root), ["public/sw.js: PWA shell is not a regular file"]);
  assert.deepEqual(validateRuntimeIndependence(root), ["src: runtime source is not a directory"]);
});

test("verifyRelease collects independent errors when release inputs are incomplete", (t) => {
  const root = fixture(t);
  const findings = verifyRelease(root, { allowDirty: true });
  assert.ok(findings.includes("SECURITY.md: required release path is missing"));
  assert.ok(findings.includes("public/manifest.webmanifest: invalid JSON"));
  assert.ok(findings.includes("src: runtime source directory is missing"));
});

test("forbidden-file validator names config.json", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "config.json"), "{}");
  assert.deepEqual(validateForbiddenFiles(root).filter((line) => line.includes("config.json")), ["config.json: forbidden release file"]);
});

test("forbidden directories match any generic segment but only the Android build root", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "nested", "LoGs"), { recursive: true });
  fs.writeFileSync(path.join(root, "nested", "LoGs", "trace.txt"), "trace");
  fs.mkdirSync(path.join(root, "app-android", "android"), { recursive: true });
  fs.writeFileSync(path.join(root, "app-android", "android", "build.txt"), "build");
  fs.mkdirSync(path.join(root, "nested", "app-android", "android"), { recursive: true });
  fs.writeFileSync(path.join(root, "nested", "app-android", "android", "source.txt"), "source");
  const findings = validateForbiddenFiles(root);
  assert.ok(findings.includes("nested/LoGs: forbidden release directory"));
  assert.ok(findings.includes("app-android/android: forbidden release directory"));
  assert.equal(findings.some((line) => line.includes("nested/app-android/android")), false);
});

test("forbidden-file validator reports filesystem links without traversing them", (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  const linked = path.join(root, "linked");
  try {
    fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`filesystem links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.deepEqual(validateForbiddenFiles(root).filter((line) => line.includes("filesystem link")), [
    "linked: filesystem link is forbidden",
  ]);
});

test("history findings are redacted to commit path and rule", (t) => {
  const root = fixture(t);
  const fakeSecret = ["sk", "fixture-value-that-must-never-be-returned"].join("-");
  const findings = validateGitHistory(root, () => `__COMMIT__abc123\n+++ b/src/x.js\n+const key = "${fakeSecret}";\n`);
  assert.deepEqual(findings, ["abc123 src/x.js token"]);
  assert.equal(JSON.stringify(findings).includes(fakeSecret), false);
});

test("history findings redact a secret-bearing patch path", (t) => {
  const root = fixture(t);
  const fakeSecret = ["sk", "path-value-that-must-never-be-returned"].join("-");
  const findings = validateGitHistory(root, () => [
    "__COMMIT__abc123",
    `+++ b/src/${fakeSecret}.js`,
    `+const key = "${fakeSecret}";`,
  ].join("\n"));
  assert.deepEqual(findings, ["abc123 <redacted-path> token"]);
  assert.equal(JSON.stringify(findings).includes(fakeSecret), false);
});

test("history findings redact control bidi and abnormally long paths to one line", (t) => {
  const root = fixture(t);
  const generated = "c".repeat(32);
  const quotedPaths = [
    '"b/control\\ncr\\rtab\\tesc\\033.js"',
    `"b/c1\u0085-del\u007f.js"`,
    `"b/bidi-\u202e-name.js"`,
    `"b/${"x".repeat(2048)}.js"`,
  ];
  for (const quotedPath of quotedPaths) {
    const findings = validateGitHistory(root, () => [
      "__COMMIT__abc123",
      `+++ ${quotedPath}`,
      `+const key = "/?token=${generated}";`,
    ].join("\n"));
    assert.deepEqual(findings, ["abc123 <redacted-path> token"]);
    assert.doesNotMatch(findings[0], /[\r\n]/);
  }
});

test("history scanner detects generated 32-character URL tokens without flagging fixture labels", (t) => {
  const root = fixture(t);
  const generated = "a".repeat(32);
  const output = [
    "__COMMIT__abc123",
    "+++ b/src/server.js",
    `+const real = "/?token=${generated}";`,
    '+const fixture = "/?token=literal-phone-secret";',
  ].join("\n");
  const findings = validateGitHistory(root, () => output);
  assert.deepEqual(findings, ["abc123 src/server.js token"]);
  assert.equal(JSON.stringify(findings).includes(generated), false);
});

test("history scanner redacts Git failures that carry secret stdout", (t) => {
  const root = fixture(t);
  const fakeSecret = ["sk", "failure-output-must-never-be-returned"].join("-");
  const findings = validateGitHistory(root, () => {
    const error = new Error("git failed"); error.stdout = `+token=${fakeSecret}`; throw error;
  });
  assert.deepEqual(findings, ["git history unavailable redacted scan failed"]);
  assert.equal(JSON.stringify(findings).includes(fakeSecret), false);
});

test("history scanner resets patch paths and decodes deleted renamed and C-quoted files", (t) => {
  const root = fixture(t);
  const generated = "b".repeat(32);
  const output = [
    "__COMMIT__abc123",
    "diff --git a/deleted.js b/deleted.js",
    "--- a/deleted.js",
    "+++ /dev/null",
    `-const deleted = "/?token=${generated}";`,
    "diff --git a/old.js b/new.js",
    "--- a/old.js",
    "+++ b/new.js",
    `+const renamed = "/?token=${generated}";`,
    'diff --git "a/docs/\\344\\270\\255\\346\\226\\207 file.md" "b/docs/\\344\\270\\255\\346\\226\\207 file.md"',
    '+++ "b/docs/\\344\\270\\255\\346\\226\\207 file.md"',
    `+const quoted = "/?token=${generated}";`,
    "__COMMIT__def456",
    `+const beforeDiff = "/?token=${generated}";`,
    "diff --git",
    `+const malformed = "/?token=${generated}";`,
  ].join("\n");
  assert.deepEqual(validateGitHistory(root, () => output), [
    "abc123 deleted.js token",
    "abc123 docs/中文 file.md token",
    "abc123 new.js token",
    "def456 unknown token",
  ]);
  assert.equal(JSON.stringify(validateGitHistory(root, () => output)).includes(generated), false);
});

test("forbidden PNG validator accepts manifest and HTML icon links", (t) => {
  const root = fixture(t); const publicRoot = path.join(root, "public");
  fs.mkdirSync(path.join(publicRoot, "icons"), { recursive: true });
  for (const name of ["icon-16.png", "icon-180.png", "icon-192.png"])
    fs.writeFileSync(path.join(publicRoot, "icons", name), "png");
  fs.writeFileSync(path.join(publicRoot, "manifest.webmanifest"), JSON.stringify({ icons: [{ src: "icons/icon-192.png" }] }));
  fs.writeFileSync(path.join(publicRoot, "index.html"), '<link rel="icon" href="icons/icon-16.png"><link rel="apple-touch-icon" href="icons/icon-180.png">');
  assert.deepEqual(validateForbiddenFiles(root).filter((line) => line.includes("unreferenced PNG")), []);
});

test("forbidden PNG validator accepts only README-linked showcase images under docs/images", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "images", "showcase.png"), "png");
  fs.writeFileSync(path.join(root, "docs", "images", "showcase-html.png"), "png");
  fs.writeFileSync(path.join(root, "docs", "images", "unused.png"), "png");
  fs.writeFileSync(path.join(root, "public", "not-an-icon.png"), "png");
  fs.writeFileSync(path.join(root, "README.md"), [
    "![showcase](./docs/images/showcase.png?raw=1)",
    '<img src="./docs/images/showcase-html.png" alt="showcase">',
    "![outside](./public/not-an-icon.png)",
  ].join("\n"));
  assert.deepEqual(validateForbiddenFiles(root).filter((line) => line.includes("unreferenced PNG")), [
    "docs/images/unused.png: unreferenced PNG is forbidden",
    "public/not-an-icon.png: unreferenced PNG is forbidden",
  ]);
});

test("the actual product tree passes deterministic non-Git checks", () => {
  const realProductRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(verifyRelease(realProductRoot, { allowDirty: true }), []);
});

test("the actual repository history passes redacted secret rules", (t) => {
  const realProductRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const probe = spawnSync("git", ["-C", realProductRoot, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8", windowsHide: true,
  });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") {
    t.skip("git history is intentionally absent from an exported release archive");
    return;
  }
  assert.deepEqual(validateGitHistory(realProductRoot), []);
});

test("CLI validates its own product root from unrelated cwd", (t) => {
  const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-cwd-"));
  t.after(() => fs.rmSync(unrelated, { recursive: true, force: true }));
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/release-verify.js");
  const result = spawnSync(process.execPath, [script, "--allow-dirty"], { cwd: unrelated, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[release\] OK/);
});

test("CLI executes when invoked through a symlink or junction", (t) => {
  const realProductRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-link-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const linkedRoot = path.join(temporary, "linked-product");
  try {
    fs.symlinkSync(realProductRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`filesystem links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const script = path.join(linkedRoot, "scripts", "release-verify.js");
  const result = spawnSync(process.execPath, [script, "--allow-dirty"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[release\] OK/);
});

test("eval import with an unresolvable argv path has no process side effects", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-missing-entry-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const missing = path.join(temporary, "missing-entry.js");
  const scriptUrl = new URL("../scripts/release-verify.js", import.meta.url).href;
  const source = `process.argv[1] = ${JSON.stringify(missing)}; await import(${JSON.stringify(scriptUrl)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("stdin import has no process side effects", () => {
  const scriptUrl = new URL("../scripts/release-verify.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    input: `await import(${JSON.stringify(scriptUrl)});`, encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
