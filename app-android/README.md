# Android 壳

这个目录使用 Capacitor 8，把仓库根目录 `public/` 中的同一套 Codex Remote 网页打进 APK。日常构建建议使用仓库中的 GitHub Actions 工作流，不需要在本机安装 Android Studio。本机构建需要 Node.js 22 或更高版本。

仓库当前只交付 Debug APK，用于自有设备测试。它不是应用商店签名包，也不适合直接上架；仓库不包含 release keystore、密码或正式签名配置。

本地已有 Android SDK 时，也可以执行：

```powershell
cd app-android
npm ci
npx cap add android
npx cap sync android
node scripts/patch-android.mjs
cd android
.\gradlew.bat assembleDebug
```

Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。每次根目录 `public/` 更新后都要重新运行 `npx cap sync android`，并确认 `artifact-ui.js`、PDF.js 主模块、PDF worker 与图标均进入最终 assets。
