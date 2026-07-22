# GitHub 发布与 Git 备份

Codex Remote 应当作为独立的 `codex-remote` 仓库发布。不要把它推送到其他项目的远端，也不要把两个产品的源码混在一个仓库中。

本项目准备了三层可恢复交付：

1. 当前独立 Git 仓库：日常开发和提交历史；
2. GitHub 远端：异地 Git 备份和公开项目页面；
3. Git Bundle：不依赖 GitHub 的本地完整历史备份。

## 第一次发布到 GitHub

### 1. 创建空仓库

在 GitHub 网页右上角选择 **New repository**：

- Repository name 填写 `codex-remote`；
- 根据需要选择 Public 或 Private；
- 不要勾选自动生成 README、`.gitignore` 或 License；
- 创建完成后先不要复制旧项目的远端地址。

### 2. 确认当前目录和分支

在独立 Codex Remote 仓库根目录运行：

```powershell
git status -sb
git branch --show-current
git log -1 --oneline
```

预期当前分支为 `main`，工作树没有未提交文件。

### 3. 绑定新的独立远端

把变量改成实际 GitHub 用户名：

```powershell
$owner = "你的GitHub用户名"
git remote add origin "https://github.com/$owner/codex-remote.git"
git remote -v
```

检查输出中的每一个 fetch 和 push 地址；它们必须指向你刚创建的 `codex-remote`。若地址不正确，立即停止，不要继续 push；应先运行 `git remote remove origin`，再添加正确地址。

如果已经存在正确的 `origin`，不要重复添加，可以使用：

```powershell
git remote set-url origin "https://github.com/$owner/codex-remote.git"
git remote -v
```

### 4. 首次 push

```powershell
git push -u origin main
```

本机即使没有安装 `gh`，Git for Windows 自带的 Git Credential Manager 也可能自动打开浏览器，请在浏览器中登录准备发布该仓库的 GitHub 账号。认证成功后再次确认网页地址和仓库名为 `codex-remote`。

### 5. GitHub 网页检查

首次 push 后检查：

- README 首页能显示三张产品截图；
- Actions 中出现 Windows 验证和 Android Debug APK 构建工作流；
- LICENSE 显示为 MIT；
- 仓库中没有 `config.json`、二维码、日志、`node_modules`、APK、EXE 或签名文件；
- Settings → Security 中启用 Private vulnerability reporting，再公开仓库。

## 以后如何保存修改

在提交前先查看范围：

```powershell
git status --short
git diff --check
npm run verify
npm run release:verify
```

确认修改都属于 Codex Remote 后再提交：

```powershell
git add README.md docs scripts test
git diff --cached --check
git commit -m "docs: update Codex Remote"
git push
```

不要习惯性提交 `git add -A`；先看清文件列表可以避免把本地运行数据或无关文件带入历史。

## 创建本地完整 Git Bundle

Git Bundle 是一个可由 Git 直接验证和克隆的单文件备份，包含已经提交的分支与历史。它不同于 ZIP：ZIP 适合分发源码，Bundle 适合恢复仓库和提交记录。

双击仓库根目录的 `创建Git备份.bat`，或运行：

```powershell
.\scripts\create-git-backup.ps1
```

脚本会：

1. 确认这是独立 Codex Remote 仓库根目录；
2. 拒绝包含未提交修改的工作树；
3. 运行严格发布检查；
4. 在仓库旁边的 `CodexRemote-backups` 目录创建带时间戳的 `.bundle`；
5. 执行 `git bundle verify`；
6. 打印准确的恢复命令。

脚本不会执行 `git add`、`git commit` 或 `git push`，不会改变远端，也不会保存 GitHub 凭据。

手工复核某个备份（保持当前目录为任意现有 Git 仓库，例如本独立仓库根目录）：

```powershell
git -C . bundle verify "..\CodexRemote-backups\codex-remote-YYYYMMDD-HHMMSS.bundle"
```

## 从 Bundle 恢复

不要在原仓库上覆盖恢复。选择一个新目录运行：

```powershell
git clone "..\CodexRemote-backups\codex-remote-YYYYMMDD-HHMMSS.bundle" CodexRemote-restored
cd CodexRemote-restored
git status -sb
git log --oneline --decorate -10
npm ci --no-audit --no-fund
npm run verify
```

确认恢复仓库无误后，可以重新绑定独立的 GitHub 远端：

```powershell
$owner = "你的GitHub用户名"
git remote remove origin
git remote add origin "https://github.com/$owner/codex-remote.git"
git remote -v
```

Bundle 只包含已经提交的历史。因此备份脚本遇到脏工作树会拒绝运行，避免制造“备份成功但漏掉未提交工作”的假象。

## 发布前最后检查

```powershell
npm ci --no-audit --no-fund
npm run verify
npm run release:verify
npm run release:copy
npm run release:verify -- --history
```

完整人工验收项见 [发布检查清单](./发布检查清单.md)。实体手机扫码、触摸、第二设备重连和真实网络环境仍需要发布者亲自验证，自动化测试不能代替真机操作。
