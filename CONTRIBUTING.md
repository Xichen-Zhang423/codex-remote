# Contributing

Codex Remote targets Windows 10/11. Use Node.js 22 for development; Node.js 18 is the minimum supported runtime.

```powershell
npm ci --no-audit --no-fund
npm run verify
```

Write a failing Node test before changing behavior. Keep `@openai/codex` on an exact version and run the real App Server smoke test for protocol upgrades. Save source, JSON, YAML, Markdown, batch, and PowerShell files as UTF-8; batch files covered by the launcher contract remain ASCII-safe.

For UI changes, attach redacted screenshots at 360, 390, 430, and 1440 px and verify keyboard focus, reduced motion, and 44 px targets. Update user documentation and `CHANGELOG.md` for visible behavior.

Never commit tokens, QR codes, `config.json`, logs, screenshots containing private data, `.env` files, executables, APK/HAP outputs, generated Android projects, signing keys, certificates, or developer credentials.
