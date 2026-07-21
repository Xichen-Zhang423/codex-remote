# Codex Remote

在手机上继续本机 Codex 任务。流式回复、工具活动、线程管理、图片输入、逐项批准、任务产出文件和 Windows 屏幕控制，都由电脑上的自托管服务提供。

> A self-hosted, mobile-first remote console for the local Codex CLI. Authentication stays on the PC; the phone connects through a token-protected PWA.

## 安全边界

本机官方 Codex CLI 始终负责登录与认证状态。Codex Remote 不会复制或上传认证文件，也不会把 Codex 凭据写入自己的配置。手机使用随机访问 token 连接，所以二维码、含 `?token=` 的网址和 `%LOCALAPPDATA%\CodexRemote\config.json` 都应视为密码等敏感信息。

只在自己的 Windows 会话、可信手机和可信网络中运行。Cloudflare 中转只保存当前隧道的基础 URL，不保存手机 token、Codex 登录信息、提示或聊天记录；真正的访问控制仍由电脑端 token 完成。

## 运行要求

- Windows 10/11
- Node.js 18 或更高版本（建议当前 LTS）
- 已在同一 Windows 用户下完成 Codex 登录
- 可选：`cloudflared.exe`，用于公网 Quick Tunnel
- 可选但强烈建议：`ffmpeg.exe`，用于稳定的全屏截图

Codex Remote 是 Windows 自托管工具。服务、App Server、工作区原件和认证状态都留在你的电脑上；只有你主动在手机查看或下载的内容才会传到该设备。

## 五分钟开始

在这个独立仓库的根目录打开 PowerShell：

```powershell
npx --yes --package @openai/codex@0.144.1 codex login
npx --yes --package @openai/codex@0.144.1 codex login status
.\start.bat
```

前两条命令使用项目锁定的官方 Codex 版本完成登录并确认状态。登录成功后，`start.bat` 会把仓库当作只读安装介质，根据内容哈希在 `%LOCALAPPDATA%\CodexRemote\runtime\<内容哈希>` 原子准备运行时，并把 npm 缓存放在 `%LOCALAPPDATA%\CodexRemote\npm-cache`。它不会在仓库中创建 `config.json` 或 `node_modules`。

首次启动会在 `%LOCALAPPDATA%\CodexRemote\config.json` 生成本机专用的随机 token。默认端口为 `8766`。二维码生成失败时服务仍会继续运行，本机面板会显示可复制的连接地址。

`ffmpeg.exe` 和 `cloudflared.exe` 只从独立仓库根目录或系统 `PATH` 查找，不会依赖父目录文件。

## 手机连接与添加到主屏幕

1. 手机与电脑在同一局域网时，扫描启动窗口或本机面板显示的局域网二维码。
2. Quick Tunnel 就绪后，也可以扫描 HTTPS 隧道二维码。
3. 页面保存连接后会从地址栏移除 token；仍不要转发二维码或原始链接。
4. Android Chrome 选择“安装应用”或“添加到主屏幕”。
5. iPhone / iPad 使用 Safari 分享菜单选择“添加到主屏幕”。iOS 当前只交付 PWA，不提供 Xcode 工程或系统安装包。
6. 首次发消息前确认工作目录；工具请求会显示批准面板。

## 任务产出与批准

每轮任务完成后，“本次产出”卡片显示检测到的新增或修改文件；历史产出抽屉可重新打开元数据。因为同一工作区可能有其他程序写入，界面只说明“任务期间检测到”，不会把所有变更断言为 Codex 独占创建。

确认的文件会复制到 `%LOCALAPPDATA%\CodexRemote\artifacts` 的不可变本机副本，原文件后来变化不会改写历史产出。默认限制为单文件 256 MiB、单轮 1 GiB、vault 2 GiB。栅格图片、纯文本和 PDF 可安全内联预览；其他格式只下载。预览和下载使用 60 秒短时票据，不在 URL 中携带长期控制 token。

默认逐项批准命令、文件修改、网络、额外权限和用户输入。一次批准只处理当前请求。“会话自动批准”只存在于当前后端进程，并且只覆盖后端明确判定为合格的低风险请求；关闭服务或重启后一定恢复为关闭状态。

## 局域网、公网隧道与中转

默认会尝试启动 Cloudflare Quick Tunnel；隧道域名可能随重启变化。将可信的 `cloudflared.exe` 放在仓库根目录，或确保 `cloudflared` 位于系统 `PATH`。只使用局域网时：

```powershell
$env:NO_TUNNEL="1"
.\start.bat
```

需要固定手机入口时，可部署 [Cloudflare Worker 中转](./docs/远程连接与中转.md)。中转不是代理，也不是凭据保险箱；手机仍直接连接当前隧道。

## 屏幕查看与触控

把可信来源的 Windows 版 `ffmpeg.exe` 放在仓库根目录后重启服务。服务优先使用 `ffmpeg` 的 `gdigrab`，失败时才使用 PowerShell 截图后备。DPI 感知脚本负责把手机坐标换算为物理像素，并逐次执行点击、文本、组合键和手势。

屏幕抓取和输入模拟可能与游戏反作弊系统冲突。不要尝试规避检测，只在可信设备与网络中启用。

## 停止与移除

日常停止可在启动窗口按 `Ctrl+C`，或双击 [停止遥控.bat](./停止遥控.bat)。停止脚本按本启动器与用户运行时的绝对命令行定位服务，不会按进程名结束所有 Node 或 Codex 应用。

运行带反作弊系统的游戏前，还应双击 [取消开机自启.bat](./取消开机自启.bat)，然后重启电脑一次。

移除 Codex Remote 时，先停止服务，再删除本仓库和 `%LOCALAPPDATA%\CodexRemote`。不要删除你的工作区、`%USERPROFILE%\.codex` 或 Codex 登录数据。若只想清理历史产出，停止服务后删除 `%LOCALAPPDATA%\CodexRemote\artifacts` 即可。

## 移动端交付

- **Android**：GitHub Actions 中的 `Build Codex Remote APK` 生成自用 Debug APK。它不是已完成发布签名的商店产物；详见 [移动端构建](./docs/移动端构建.md) 和 [Android 壳说明](./app-android/README.md)。
- **HarmonyOS NEXT**：在 DevEco Studio 新建工程，同步 ArkTS 壳与 Web 资源，再用自己的证书手工签名。仓库不包含证书；详见 [HarmonyOS NEXT 教程](./app-harmony/使用教程-鸿蒙NEXT.md)。
- **iPhone / iPad**：通过 HTTPS 在 Safari 打开页面并选择“添加到主屏幕”。本项目不创建 Xcode 工程。

三种平台使用同一套只读产出协议。每次更新 `public/` 后都必须重新同步 Android 与 HarmonyOS 资源，尤其不能遗漏本地 PDF worker。

## 配置

首次启动后会在 `%LOCALAPPDATA%\CodexRemote\config.json` 生成 `port`、`token`、`cwd`、模型、推理强度和可选中转配置。该文件位于仓库之外，包含敏感值，不要提交、截图或分享。访问 token 会持续有效，直到你修改或删除配置使其轮换。

可用环境变量只覆盖当前进程：`CODEX_REMOTE_PORT`、`CODEX_REMOTE_TOKEN`、`CODEX_CWD`、`CODEX_MODEL`、`CODEX_EFFORT`、`CODEX_REMOTE_RENDEZVOUS_URL`、`CODEX_REMOTE_RENDEZVOUS_SECRET` 和 `CODEX_REMOTE_DEVICE_ID`。覆盖值不会写回配置文件。

## Windows 便捷脚本

- [start.bat](./start.bat)：检查环境，通过用户本地内容哈希运行时安装依赖并启动。
- [创建桌面图标.bat](./创建桌面图标.bat)：创建当前用户桌面快捷方式。
- [设置开机自启.bat](./设置开机自启.bat)：创建独立的 `CodexRemote.lnk`。
- [取消开机自启.bat](./取消开机自启.bat)：只删除上述快捷方式。
- [停止遥控.bat](./停止遥控.bat)：停止本启动器拥有的服务进程树。

## 项目结构

```text
codex-remote/
├─ server.js                 组合入口与安全关闭
├─ src/                      App Server、批准、线程、隧道和 Windows 封装
├─ public/                   手机 PWA 与桌面控制页
├─ scripts/                  用户运行时引导、截图、输入和发布验证
├─ cloudflare-worker/        可选中转 Worker
├─ app-android/              Capacitor 包装
├─ app-harmony/              HarmonyOS NEXT ArkTS 壳
├─ .github/workflows/        Windows 验证与 Debug APK 构建
└─ test/                     单元、协议、集成和文档合同
```

## 故障排查

| 现象 | 处理 |
|---|---|
| `Node.js` 未找到或版本过低 | 安装 Node.js 18+，重开终端后运行 `node --version`。 |
| Codex 显示未登录 | 在同一 Windows 用户下重新运行上面的固定版本登录命令和 `codex login status`。 |
| 依赖安装失败 | 检查网络、代理和系统盘空间；缓存与日志位于 `%LOCALAPPDATA%\CodexRemote\npm-cache`。无需管理员权限，也不要手工给仓库写入 `node_modules`。 |
| 手机打不开局域网地址 | 确认同一 Wi-Fi、Windows 防火墙允许 Node、端口 `8766` 未被占用。 |
| 二维码没有显示 | 服务仍会启动；从本机面板复制连接地址。 |
| 隧道一直离线 | 检查 `cloudflared` 与网络；设置 `NO_TUNNEL=1` 可先验证局域网。隧道失败不影响局域网。 |
| 手机上看不到任务文件 | 打开当前任务的“本次产出”或历史产出抽屉；重新连接后元数据会恢复。 |
| 截图黑屏、裁切或点击偏移 | 安装可信 `ffmpeg.exe` 并重启服务；不要通过降低显示缩放掩盖问题。 |
| PWA 仍是旧界面 | 完全关闭页面后重开；必要时在浏览器站点设置中清除该站点缓存。 |
| 批准卡片没有消失 | 刷新当前回合；重启会拒绝未完成请求并关闭会话自动批准。 |
| 游戏启动后闪退 | 按“停止与移除”中的游戏前步骤操作，不要尝试绕过反作弊。 |

完整操作流程见 [使用教程](./docs/使用教程.md)。

## 参与、隐私与发布

- 贡献要求：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 私下报告漏洞：[SECURITY.md](./SECURITY.md)
- MIT 许可证：[LICENSE](./LICENSE)
- 版本变化：[CHANGELOG.md](./CHANGELOG.md)
- 第三方许可：[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
- 发布者验收：[发布检查清单](./docs/发布检查清单.md)

开发者在可写工作副本中运行：

```powershell
npm ci --no-audit --no-fund
npm run verify
npm run release:verify
```

运行时配置、依赖、截图、日志和移动端构建产物都不应进入版本库。
