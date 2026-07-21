import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("README is a standalone first-run journey", () => {
  const readme = read("README.md");
  const ordered = [
    "安全边界", "运行要求", "codex login status", "start.bat", "手机连接", "添加到主屏幕",
    "任务产出", "批准", "局域网", "屏幕", "停止", "Android", "HarmonyOS NEXT",
    "iPhone / iPad", "故障排查", "隐私", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "发布检查清单",
  ];
  let cursor = -1;
  for (const phrase of ordered) {
    const next = readme.indexOf(phrase, cursor + 1);
    assert.ok(next > cursor, `README order: ${phrase}`);
    cursor = next;
  }

  assert.match(readme, /npx --yes --package @openai\/codex@0\.144\.1 codex login\s/);
  assert.match(readme, /npx --yes --package @openai\/codex@0\.144\.1 codex login status/);
  assert.match(readme, /%LOCALAPPDATA%\\CodexRemote\\runtime[\s\S]*%LOCALAPPDATA%\\CodexRemote\\npm-cache/);
  assert.match(readme, /二维码[\s\S]*失败[\s\S]*继续运行[\s\S]*复制/);
  assert.match(readme, /删除[\s\S]*%LOCALAPPDATA%\\CodexRemote[\s\S]*不要删除[\s\S]*工作区[\s\S]*%USERPROFILE%\\\.codex/);
  assert.match(readme, /私下报告漏洞：\[SECURITY\.md\]\(\.\/SECURITY\.md\)/);
  assert.doesNotMatch(readme, /隐私报告[^\n]*SECURITY\.md/);
  assert.doesNotMatch(readme, /\.\.\/|example\.com|OWNER\/REPO|npm publish|原生 iOS|Electron|MSIX|已签名商店包/i);
  assert.equal(readme.includes("\uFFFD"), false);
});

test("README states the security approval artifact and platform boundaries", () => {
  const readme = read("README.md");
  assert.match(readme, /官方 Codex CLI[\s\S]*登录[\s\S]*不会[\s\S]*(?:复制|上传)[\s\S]*认证/);
  assert.match(readme, /二维码[\s\S]*\?token=[\s\S]*config\.json[\s\S]*(?:密码|敏感)/);
  assert.match(readme, /本次产出[\s\S]*不可变[\s\S]*256 MiB[\s\S]*60 秒/);
  assert.match(readme, /逐项批准[\s\S]*会话自动批准[\s\S]*重启[\s\S]*关闭/);
  assert.match(readme, /Android[\s\S]*Debug APK[\s\S]*HarmonyOS NEXT[\s\S]*手工签名[\s\S]*iPhone \/ iPad[\s\S]*Safari/);
});

test("platform and connection guides retain their exact delivery boundaries", () => {
  const mobile = read("docs/移动端构建.md");
  const android = read("app-android/README.md");
  const harmony = read("app-harmony/使用教程-鸿蒙NEXT.md");
  const remote = read("docs/远程连接与中转.md");

  assert.match(mobile, /Debug APK[\s\S]*GitHub Actions/);
  assert.match(mobile, /artifact-ui\.js[\s\S]*pdf\.min\.mjs[\s\S]*pdf\.worker\.min\.mjs/);
  assert.match(mobile, /iPhone \/ iPad[\s\S]*Safari[\s\S]*添加到主屏幕/);
  assert.match(android, /Debug[\s\S]*(?:不适合|不是)[\s\S]*商店/);
  assert.match(harmony, /DevEco[\s\S]*手工签名/);
  assert.match(harmony, /resource:\/\/[\s\S]*外部导航[\s\S]*相机/);
  assert.doesNotMatch(harmony, /提交.*(?:证书|私钥)/);
  assert.match(remote, /只(?:保存|包含)[\s\S]*基础 URL[\s\S]*不(?:保存|发布)[\s\S]*token[\s\S]*(?:Codex 登录|提示|聊天)/);
});

test("usage guide covers binary resolution QR fallback and artifact recovery", () => {
  const guide = read("docs/使用教程.md");
  assert.match(guide, /找不到[\s\S]*ffmpeg[\s\S]*cloudflared[\s\S]*仓库根目录[\s\S]*PATH[\s\S]*不会搜索父目录/);
  assert.match(guide, /二维码[\s\S]*失败[\s\S]*复制[\s\S]*连接地址[\s\S]*不会停止服务/);
  assert.match(guide, /看不到[\s\S]*任务文件[\s\S]*本次产出[\s\S]*重新连接[\s\S]*恢复/);
});

test("mobile guide runs Capacitor from the Android wrapper and restores the repository cwd", () => {
  const mobile = read("docs/移动端构建.md");
  const ordered = [
    "Push-Location app-android",
    "try {",
    "npm ci --no-audit --no-fund",
    "Test-Path android",
    "npx cap add android",
    "npx cap sync android",
    "finally {",
    "Pop-Location",
  ];
  let cursor = -1;
  for (const phrase of ordered) {
    const next = mobile.indexOf(phrase, cursor + 1);
    assert.ok(next > cursor, `Android command order: ${phrase}`);
    cursor = next;
  }
  assert.doesNotMatch(mobile, /Android 构建前运行 `npx cap sync android`/);
});

test("release checklist separates automated gates from unchecked manual acceptance", () => {
  const checklist = read("docs/发布检查清单.md");
  for (const command of [
    "npm ci --no-audit --no-fund",
    "npm run verify",
    "npm run release:verify",
    "npm run release:copy",
    "npm run release:verify -- --history",
  ]) {
    assert.equal(checklist.split(/\r?\n/).filter((line) => line.trim() === command).length, 1, command);
  }
  assert.match(checklist, /\[release\] OK/);
  assert.doesNotMatch(checklist, /^\s*- \[[xX]\]/m);
  assert.match(checklist, /人工验收[\s\S]*App Server[\s\S]*TXT[\s\S]*PNG[\s\S]*PDF[\s\S]*HTML[\s\S]*ZIP/);
  assert.match(checklist, /不在本次发布范围[\s\S]*签名商店包[\s\S]*原生 iOS[\s\S]*Electron[\s\S]*MSIX[\s\S]*npm 发布[\s\S]*自动创建 GitHub 仓库/);
  assert.equal(checklist.includes("\uFFFD"), false);
});
