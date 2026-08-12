import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("README is a standalone GitHub introduction and first-run journey", () => {
  const readme = read("README.md");
  const ordered = [
    "手机遥控 Codex", "English", "核心能力", "界面预览", "五分钟开始", "运行要求",
    "codex login status", "start.bat", "手机连接", "添加到主屏幕", "任务产出", "逐项批准",
    "局域网", "屏幕查看", "安全边界", "停止与移除", "Android", "iPhone / iPad",
    "HarmonyOS NEXT", "配置", "项目结构", "故障排查", "GitHub 发布与备份", "开源与贡献",
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
  assert.match(readme, /二维码[\s\S]*渲染失败[\s\S]*继续运行[\s\S]*复制/);
  assert.match(readme, /删除[\s\S]*%LOCALAPPDATA%\\CodexRemote[\s\S]*不要删除[\s\S]*工作区[\s\S]*%USERPROFILE%\\\.codex/);
  assert.match(readme, /iPhone \/ iPad[\s\S]*不(?:创建|提供)[\s\S]*(?:Xcode|原生 iOS)/);
  assert.match(readme, /私下报告安全问题[\s\S]*\[SECURITY\.md\]\(\.\/SECURITY\.md\)/);
  assert.doesNotMatch(readme, /\.\.\/|example\.com|OWNER\/REPO|npm publish|Electron|MSIX|已签名商店包/i);
  assert.equal(readme.includes("\uFFFD"), false);
});

test("README and usage guide describe the public-first desktop console", () => {
  const readme = read("README.md");
  const guide = read("docs/使用教程.md");

  for (const [name, document] of [["README", readme], ["usage guide", guide]]) {
    for (const phrase of [
      "启动后自动打开桌面控制台",
      "默认公网",
      "显示局域网连接",
      "NO_PANEL=1/true/on/yes",
      "服务继续运行",
    ]) assert.ok(document.includes(phrase), `${name}: ${phrase}`);
    assert.match(document, /公网隧道[\s\S]{0,100}(?:就绪|ready)[\s\S]{0,100}(?:主二维码|公网二维码)/i);
    assert.match(document, /NO_TUNNEL[\s\S]{0,100}(?:仅|只)[\s\S]{0,30}局域网/);
    assert.match(document, /关闭[\s\S]{0,30}桌面控制台[\s\S]{0,40}(?:不会|不等于)[\s\S]{0,20}停止服务/);
    assert.match(document, /(?:移除|删除)[\s\S]{0,30}NO_PANEL[\s\S]{0,40}重启[\s\S]{0,40}自动打开/);
    assert.doesNotMatch(document, /终端二维码|第一、第二二维码|第一个二维码|第二个二维码|启动窗口[^\n。]*二维码/);
    assert.doesNotMatch(document, /手(?:工|动)打开[^\n。]*(?:panel|面板)[^\n。]*(?:URL|地址)/i);
  }

  assert.match(readme, /alt="[^"]*公网优先[^"]*局域网[^"]*按需[^"]*"/);
  assert.match(readme, /自动化[^\n]*(?:mock|固定场景)[^\n]*不包含真实[^\n]*(?:token|秘密)/i);
});

test("startup docs promise an immediate control surface and reusable dependency cache", () => {
  const readme = read("README.md");
  const guide = read("docs/使用教程.md");

  for (const [name, document] of [["README", readme], ["usage guide", guide]]) {
    assert.match(
      document,
      /桌面控制台[^\n。]{0,80}(?:先|立即)[^\n。]{0,80}(?:Codex App Server|Codex 引擎)[^\n。]{0,80}后台初始化/,
      `${name}: control surface must not wait for Codex initialization`,
    );
    assert.match(document, /共享依赖缓存/, `${name}: shared dependency cache`);
    assert.match(
      document,
      /(?:只|仅)[^\n。]{0,20}(?:更新|修改)[^\n。]{0,40}(?:程序|应用)代码[^\n。]{0,120}(?:不会|无需|不再)[^\n。]{0,30}(?:npm|重新安装)/i,
      `${name}: code-only upgrades must not reinstall dependencies`,
    );
  }

  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /background[^\n]*Codex App Server|Codex App Server[^\n]*background/i);
  assert.match(changelog, /shared dependency cache/i);

  const checklist = read("docs/发布检查清单.md");
  assert.match(readme, /npm run benchmark:startup/);
  assert.match(guide, /npm run benchmark:startup/);
  assert.match(checklist, /npm run benchmark:startup/);
  assert.match(guide, /临时目录[\s\S]{0,80}(?:不会|不)[\s\S]{0,30}(?:真实 token|真实遥控服务|工作区)/);
});

test("README states security approval artifact and platform boundaries", () => {
  const readme = read("README.md");
  assert.match(readme, /官方 Codex CLI[\s\S]*登录[\s\S]*不复制[\s\S]*认证/);
  assert.match(readme, /二维码[\s\S]*原始连接链接[\s\S]*config\.json[\s\S]*敏感/);
  assert.match(readme, /本次产出[\s\S]*不可变[\s\S]*256 MiB[\s\S]*60 秒/);
  assert.match(readme, /逐项批准[\s\S]*会话自动批准[\s\S]*重启[\s\S]*关闭/);
  assert.match(readme, /Android[\s\S]*Debug APK[\s\S]*iPhone \/ iPad[\s\S]*Safari[\s\S]*HarmonyOS NEXT[\s\S]*手工签名/);
});

test("GitHub guide covers independent first push bundle verification and recovery", () => {
  const readme = read("README.md");
  const guide = read("docs/GitHub发布与备份.md");
  const batch = read("创建Git备份.bat");
  const backup = read("scripts/create-git-backup.ps1");
  const legacyRepository = ["cla", "ude-remote"].join("");
  assert.match(readme, /独立[\s\S]*codex-remote[\s\S]*GitHub 发布与备份/);
  assert.match(guide, /创建空仓库[\s\S]*git remote add origin[\s\S]*git push -u origin main/);
  assert.match(guide, /Git Credential Manager[\s\S]*浏览器/);
  assert.match(guide, /git(?: -C \.)? bundle verify[\s\S]*git clone[^\n]*\.bundle/);
  assert.match(guide, /脏工作树|未提交修改/);
  assert.match(batch, /scripts\\create-git-backup\.ps1/i);
  assert.match(backup, /\[git-backup\] OK/);
  assert.doesNotMatch(`${readme}\n${guide}`, new RegExp(`Xichen-Zhang423/${legacyRepository}|https://github\\.com/[^\\s]+/${legacyRepository}`, "i"));
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

test("remote connection guide uses the public-first desktop console", () => {
  const remote = read("docs/远程连接与中转.md");
  assert.match(remote, /启动后自动打开桌面控制台/);
  assert.match(remote, /默认公网[\s\S]{0,100}公网隧道[\s\S]{0,50}(?:ready|就绪)[\s\S]{0,80}公网二维码/i);
  assert.match(remote, /连接选项[\s\S]{0,80}显示局域网连接[\s\S]{0,80}(?:按需|局域网二维码)/);
  assert.doesNotMatch(remote, /终端二维码|等待终端[^\n。]*隧道基础 URL|扫描终端[^\n。]*二维码/);
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
    "npm run benchmark:startup",
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
