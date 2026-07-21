# Codex Remote：HarmonyOS NEXT 壳应用

HarmonyOS NEXT 不能直接安装 Android APK。这个目录提供一个最小 ArkTS `Web` 壳，把 `public/` 中的 Codex Remote 界面打进 HAP；编译、签名和安装仍由 DevEco Studio 完成。

## 1. 新建工程

在 DevEco Studio 选择 **Create Project → Application → Empty Ability**，填写：

- Project name：`CodexRemote`
- Bundle name：`com.codex.remote`
- Model：Stage
- SDK：选择手机支持的当前版本

等待首次 Sync 完成。HAP 必须在 DevEco Studio 中使用你自己的华为开发者配置手工签名；本项目不会附带证书或密钥。

## 2. 放入页面代码和权限

用本目录的 [Index.ets](./Index.ets) 覆盖工程中的：

```text
entry/src/main/ets/pages/Index.ets
```

把 [module-permissions.json5](./module-permissions.json5) 里的 `requestPermissions` 合并到工程 `entry/src/main/module.json5` 的 `module` 对象。`INTERNET` 必须保留；仅在需要 App 内扫码时保留 `CAMERA`，并在资源文件中加入：

```json
{ "name": "codex_remote_camera_reason", "value": "扫码连接 Codex Remote 需要使用摄像头" }
```

`Index.ets` 只对本地 `resource://rawfile/` 页面授予 `TYPE_VIDEO_CAPTURE`，其他来源或资源一律拒绝。ArkWeb 壳继续限制外部导航，并且只允许受信任本地页面请求相机。如果你的 SDK 对 `onPermissionRequest` 的类型检查有差异，而且不需要 App 内扫码，可以删除该回调，同时去掉相机权限。

## 3. 复制网页资源

在这个目录打开 PowerShell，运行：

```powershell
.\copy-web-to-rawfile.ps1 -Project "D:\DevEcoProjects\CodexRemote"
```

脚本通过 `codex-remote-managed-files.json` 记录自己复制的文件；再次运行时只替换这些受管文件，不会删除 `rawfile` 中属于工程的其他资源。每次更新网页后都要重新运行。

将 `app-harmony/resources/base/element/string.json` 与 `app-harmony/resources/base/media/app_icon.png` 复制到 DevEco 模块的对应资源目录。它们只包含产品名和图标。签名证书、私钥、密码和生成工程只能留在你的本地安全环境中。

### 任务产出预览资源

每次更新 `public/` 后必须重新运行 `copy-web-to-rawfile.ps1`。同步结果必须同时包含 `artifact-ui.js`、`vendor/pdfjs/pdf.min.mjs` 和 `vendor/pdfjs/pdf.worker.min.mjs`；缺少 worker 时 PDF 预览不可发布。
现有 `resource://` 导航约束和相机来源限制保持不变。

## 4. 可选：预置免扫码连接

默认占位符不会写入连接信息，首次打开可在 App 内扫码。若要固定到自己的中转服务，修改 `Index.ets` 顶部三个常量：

- `ORIGIN`：格式为 `https://host`，只含协议和主机，不含 token、查询或路径；中转启用时可保留无效占位主机。
- `TOKEN`：电脑端 `%LOCALAPPDATA%\CodexRemote\config.json` 中的访问 token。
- `RZ`：公开读取地址，例如 `https://your-worker.example.workers.dev/current?deviceId=YOUR_DEVICE_ID`。

它们只会注入本地 `resource://` 页面并写入 `localStorage` 的 `codex-remote.backend.v1`，结构为 `{ origin, token, rz }`；壳会阻止顶层页面导航到外部地址。请勿提交填过真实值的 `Index.ets`；若误提交，应立即更换 token 和中转发布密钥。

## 5. 签名并安装

1. 在 **File → Project Structure → Signing Configs** 手工选择自己的签名配置；需要时可让 DevEco 执行自动签名。
2. 手机打开开发者模式和 USB 调试，连接电脑。
3. 选择设备并点击 **Run**。
4. 需要安装包时，使用 **Build → Build Hap(s)/APP(s)**。

## 故障排查

| 现象 | 处理 |
|---|---|
| 白屏 | 确认 `rawfile/index.html` 存在，重新复制资源并 Clean/Rebuild。 |
| 一直离线 | 先确认电脑端服务在线；检查 token 与 `RZ` 是否完整；也可清除 App 数据后重新扫码。 |
| 页面更新未出现 | 重新运行复制脚本，然后重新编译安装。 |
| 无法扫码 | 检查 CAMERA 权限和资源字符串，或在浏览器/PWA 中扫码后手动填写后端地址。 |
| 混合内容被拦截 | 局域网 HTTP/WS 需要 `.mixedMode(MixedMode.All)`；壳仍限制顶层导航和权限来源，公网连接优先使用 HTTPS/WSS。 |

HarmonyOS 4 及更早、仍有 Android 兼容层的设备可以直接尝试 Android APK；HarmonyOS NEXT 使用本壳应用。
