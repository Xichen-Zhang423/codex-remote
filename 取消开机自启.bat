@echo off
setlocal
chcp 65001 >nul
title Disable Codex Remote autostart
set "CODEX_REMOTE_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CodexRemote.lnk"

if exist "%CODEX_REMOTE_LINK%" del /f /q "%CODEX_REMOTE_LINK%"
if exist "%CODEX_REMOTE_LINK%" (
  echo [ERROR] The startup shortcut could not be removed. Check permissions.
) else (
  echo [OK] Codex Remote autostart is disabled.
)
pause
