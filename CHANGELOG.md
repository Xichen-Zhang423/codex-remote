# Changelog

## Unreleased

### Added
- Added an auto-opening Windows desktop console with a public-first QR and an on-demand LAN connection under connection options.

### Changed
- Documented that `NO_PANEL=1/true/on/yes` disables only the automatic panel window while the service continues, and that `NO_TUNNEL=1` provides LAN-only access.
- The local HTTP service, desktop panel, and tunnel now start before the Codex App Server finishes initializing in the background.
- Application snapshots now reuse a shared dependency cache, avoiding another large npm install after code-only updates.

### Fixed
- Hardened Codex App Server startup with an initialize-specific timeout, one clean retry after confirmed process shutdown, and bounded redacted diagnostics for transient stalls.

## 0.1.0 - 2026-07-15

### Added
- Local Codex App Server threads, streaming events, approvals, images, and recovery.
- Token-protected PWA with LAN, Cloudflare tunnel, artifacts, screen view, and Windows input control.
- Debug-only Android Capacitor workflow and a reproducible HarmonyOS NEXT shell guide.

### Security
- User-local runtime and configuration, session-only auto approval, redacted diagnostics, and private vulnerability reporting.

### Known limitations
- No signed store package, native iOS app, hosted multi-user backend, Electron, or MSIX package.
