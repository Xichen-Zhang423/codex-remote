import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".npm-cache", ".git", "android"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

test("project lockfiles are valid and match their package manifests", () => {
  for (const directory of [".", "app-android"]) {
    const manifest = JSON.parse(read(path.join(directory, "package.json")));
    const lock = JSON.parse(read(path.join(directory, "package-lock.json")));
    assert.ok(lock.lockfileVersion >= 1, `${directory} lockfileVersion`);
    assert.equal(lock.name, manifest.name, `${directory} package name`);
    assert.deepEqual(lock.packages?.[""]?.dependencies ?? {}, manifest.dependencies ?? {});
    assert.deepEqual(lock.packages?.[""]?.devDependencies ?? {}, manifest.devDependencies ?? {});
  }
});

test("package scripts compose strict release verification with all existing checks", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.equal(scripts["release:verify"], "node scripts/release-verify.js");
  assert.match(scripts.check, /node --check scripts\/release-verify\.js/);
  assert.equal(scripts.verify, "npm run check && npm test && npm run release:verify -- --allow-dirty");
});

test("PDF.js is an exact development-only source for committed Apache-2.0 assets", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.devDependencies?.["pdfjs-dist"], "4.8.69");
  assert.equal(manifest.dependencies?.["pdfjs-dist"], undefined);
  assert.match(manifest.scripts.check, /node --check scripts\/sync-web-vendor\.mjs/);

  const notice = read("THIRD_PARTY_NOTICES.md");
  assert.match(notice, /## Mozilla PDF\.js 4\.8\.69/);
  assert.match(notice, /License: Apache License 2\.0/);
  assert.match(notice, /https:\/\/github\.com\/mozilla\/pdf\.js\/tree\/v4\.8\.69/);
  for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs", "LICENSE"]) {
    assert.match(notice, new RegExp(file.replaceAll(".", "\\.")));
  }

  const bootstrap = read("scripts/bootstrap.js");
  assert.match(bootstrap, /const args = \[command, "--omit=dev", "--no-audit", "--no-fund"\]/);
  assert.match(bootstrap, /runNpm\(useCi \? "ci" : "install"/);
});

test("brand rasterization is pinned as a build-only dependency", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.devDependencies?.["@resvg/resvg-js"], "2.6.2");
  assert.equal(manifest.dependencies?.["@resvg/resvg-js"], undefined);
  assert.match(manifest.scripts.check, /node --check scripts\/generate-brand-assets\.mjs/);

  const notice = read("THIRD_PARTY_NOTICES.md");
  assert.match(notice, /## @resvg\/resvg-js 2\.6\.2/);
  assert.match(notice, /License: MPL-2\.0/);
  assert.match(notice, /https:\/\/github\.com\/thx\/resvg-js/);
  const androidPatch = read("app-android/scripts/patch-android.mjs");
  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"])
    assert.ok(androidPatch.includes(density), density);
  assert.match(androidPatch, /ic_launcher_round\.png/);
  assert.match(androidPatch, /mipmap-anydpi-v26/);

  const harmonyGuide = read("app-harmony/使用教程-鸿蒙NEXT.md");
  assert.match(harmonyGuide, /resources\/base\/element\/string\.json/);
  assert.match(harmonyGuide, /resources\/base\/media\/app_icon\.png/);
});

test("Windows launchers start and stop only this absolute Codex Remote process tree", () => {
  const start = read("start.bat");
  assert.match(start, /scripts\\bootstrap\.js/i);
  assert.doesNotMatch(start, /npm_config_cache=%~dp0\.npm-cache/i);
  assert.match(start, /process\.versions\.node/);
  assert.doesNotMatch(start, /npm\s+(?:ci|install)|node_modules|config\.json/i);

  const bootstrap = read("scripts/bootstrap.js");
  assert.match(bootstrap, /LOCALAPPDATA[\s\S]{0,160}CodexRemote/i);
  assert.match(bootstrap, /createHash/);
  assert.match(bootstrap, /\.staging-/);
  assert.match(bootstrap, /\.lock-/);
  assert.match(bootstrap, /\.ready/);
  assert.match(bootstrap, /npm[\s\S]{0,500}\bci\b/i);
  assert.match(bootstrap, /CODEX_REMOTE_CONFIG/);
  assert.match(bootstrap, /CODEX_REMOTE_SOURCE_DIR/);
  assert.doesNotMatch(bootstrap, /path\.dirname\(prepared\.sourceDir\)/);
  assert.match(bootstrap, /PATH:\s*\[prepared\.sourceDir,\s*env\.PATH\s*\|\|\s*["']{2}["']?\]/);
  for (const runtimeFile of ["src/windows-remote.js", "src/tunnel.js"]) {
    assert.doesNotMatch(read(runtimeFile), /path\.resolve\([^\n]*["']\.\.["']/);
  }
  assert.match(JSON.parse(read("package.json")).scripts.check, /node --check scripts\/bootstrap\.js/);

  const stop = read("停止遥控.bat");
  assert.match(stop, /scripts\\bootstrap\.js/i);
  assert.match(stop, /CodexRemote\\runtime/i);
  assert.match(stop, /%~dp0server\.js/i);
  assert.match(stop, /Name=''node\.exe''/i);
  assert.match(stop, /ParentProcessId/i);
  assert.match(stop, /CreationDate/i);
  assert.match(stop, /CreationTicks/i);
  assert.match(stop, /currentParent/i);
  assert.match(stop, /ProcessId=.*candidate\.ProcessId/i);
  assert.match(stop, /currentTicks.*candidate\.CreationTicks/i);
  assert.match(stop, /\[regex\]::IsMatch/);
  assert.match(stop, /\$optionalQuote=.*\$q[\s\S]*\$pattern=\$node\+\$optionalQuote[\s\S]*\+\$optionalQuote\+/);
  assert.doesNotMatch(stop, /taskkill|\/IM\s+node|cloudflared\.exe/i);

  const setup = read("设置开机自启.bat");
  const cancel = read("取消开机自启.bat");
  assert.match(setup, /CodexRemote\.lnk/);
  assert.match(setup, /%~dp0start\.bat/i);
  assert.match(cancel, /CodexRemote\.lnk/);
  assert.doesNotMatch(setup + cancel, new RegExp(["Cla", "udeRemote"].join(""), "i"));

  for (const name of [
    "start.bat", "停止遥控.bat", "设置开机自启.bat", "取消开机自启.bat", "创建桌面图标.bat",
  ]) {
    const bytes = fs.readFileSync(path.join(root, name));
    assert.equal([...bytes].some((byte) => byte > 0x7f), false, `${name} must stay ASCII-safe`);
  }
});

test("Android wrapper and workflow use the release identities", () => {
  const pkg = JSON.parse(read("app-android/package.json"));
  const capacitor = JSON.parse(read("app-android/capacitor.config.json"));
  assert.equal(pkg.name, "codex-phone-remote");
  assert.equal(pkg.dependencies["@capacitor/android"], "8.4.1");
  assert.equal(pkg.dependencies["@capacitor/core"], "8.4.1");
  assert.equal(pkg.devDependencies["@capacitor/cli"], "8.4.1");
  assert.equal(capacitor.appId, "com.codex.remote");
  assert.equal(capacitor.appName, "Codex Remote");
  assert.equal(capacitor.webDir, "../public");
  const workflow = read(".github/workflows/build-apk.yml");
  assert.match(workflow, /name:\s*codex-remote-apk/);
  assert.match(workflow, /Install wrapper dependencies[\s\S]{0,160}run:\s*npm ci/);
  assert.match(workflow, /node-version:\s*["']22["']/);
  assert.equal(JSON.parse(read("app-android/package-lock.json")).name, pkg.name);

  const harmony = read("app-harmony/Index.ets");
  assert.match(harmony, /codex-remote\.backend\.v1/);
  assert.match(harmony, /origin:.*token:.*rz:/s);
  assert.doesNotMatch(harmony, /localStorage\.backend/);
  assert.match(harmony, /scriptRules:\s*\[\s*['"]resource:\/\/['"]\s*\]/);
  assert.doesNotMatch(harmony, /scriptRules:\s*\[\s*['"]\*['"]\s*\]/);
  assert.match(harmony, /\.onLoadIntercept/);
  assert.match(harmony, /TYPE_VIDEO_CAPTURE/);
  assert.match(harmony, /getOrigin\(\)/);
  assert.match(harmony, /request\.deny\(\)/);
  const token = harmony.match(/const\s+TOKEN\s*:\s*string\s*=\s*['"]([^'"]+)['"]/)?.[1];
  assert.equal(token, "PASTE_YOUR_TOKEN_HERE");

  const copyScript = read("app-harmony/copy-web-to-rawfile.ps1");
  assert.match(copyScript, /codex-remote-managed-files\.json/);
  assert.doesNotMatch(copyScript, /Remove-Item\s+-Recurse/i);
});

test("mobile wrappers include artifact controller and nested PDF runtime", () => {
  const capacitor = JSON.parse(read("app-android/capacitor.config.json"));
  assert.equal(capacitor.webDir, "../public");
  assert.match(read("app-android/.gitignore"), /^android\/?$/m);
  assert.match(read(".github/workflows/build-apk.yml"), /npx cap sync android/);

  const harmony = read("app-harmony/copy-web-to-rawfile.ps1");
  assert.match(harmony, /Get-ChildItem[\s\S]*-Recurse/);
  assert.match(harmony, /Test-Path/);
  for (const required of ["artifact-ui.js", "vendor/pdfjs/pdf.min.mjs", "vendor/pdfjs/pdf.worker.min.mjs"]) {
    assert.ok(harmony.includes(required), required);
  }
});

test("Harmony copier transfers the complete artifact preview runtime", {
  skip: process.platform !== "win32",
}, (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cr-harmony-copy-"));
  const project = path.join(temporary, "DevEcoProject");
  fs.mkdirSync(project, { recursive: true });
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const script = path.join(root, "app-harmony", "copy-web-to-rawfile.ps1");
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  const result = spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script, "-Project", project,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const destination = path.join(project, "entry", "src", "main", "resources", "rawfile");
  const required = ["artifact-ui.js", "vendor/pdfjs/pdf.min.mjs", "vendor/pdfjs/pdf.worker.min.mjs"];
  for (const relative of required) {
    const segments = relative.split("/");
    assert.deepEqual(
      fs.readFileSync(path.join(destination, ...segments)),
      fs.readFileSync(path.join(root, "public", ...segments)),
    );
  }
  const manifestText = fs.readFileSync(
    path.join(destination, "codex-remote-managed-files.json"),
    "utf8",
  ).replace(/^\uFEFF/, "");
  const managed = JSON.parse(manifestText).map((relative) => relative.replace(/\\/g, "/"));
  for (const relative of required) assert.ok(managed.includes(relative), relative);
});

test("packaging and docs contain no legacy identity or embedded credential", () => {
  const legacyBrand = ["Cla", "ude"].join("");
  const legacyVendor = ["Anth", "ropic"].join("");
  const forbiddenIdentity = new RegExp(
    `\\b${legacyBrand}\\b|${legacyVendor}|${legacyBrand.toLowerCase()}-agent-sdk|${legacyBrand.toLowerCase()}-(?:opus|sonnet|haiku)`,
    "i",
  );
  const embeddedSecret = /sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|"token"\s*:\s*"[A-Fa-f0-9]{24,}"/;
  const personalPath = /[A-Z]:\\Users\\张熙晨/i;
  const offenders = [];
  for (const file of walk(root)) {
    if (/\.(?:exe|apk|hap|jpg|jpeg|png)$/i.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (forbiddenIdentity.test(text) || embeddedSecret.test(text) || personalPath.test(text)) {
      offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("Chinese-first documentation covers setup, safety, and mobile builds", () => {
  const readme = read("README.md");
  for (const phrase of [
    "Node.js 18", "codex login", "二维码", "Cloudflare", "ffmpeg",
    "会话自动批准", "重启", "反作弊", "Android", "HarmonyOS NEXT", "故障排查",
  ]) assert.match(readme, new RegExp(phrase, "i"));
  assert.match(read("docs/使用教程.md"), /首次启动/);
  assert.doesNotMatch(read("docs/使用教程.md"), /短期使用的连接地址/);
  assert.match(read("app-harmony/使用教程-鸿蒙NEXT.md"), /com\.codex\.remote/);
});
