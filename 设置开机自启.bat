@echo off
setlocal
chcp 65001 >nul
title Enable Codex Remote autostart
set "CODEX_REMOTE_START=%~dp0start.bat"
set "CODEX_REMOTE_WORKDIR=%~dp0"
set "CODEX_REMOTE_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CodexRemote.lnk"

powershell -NoProfile -NonInteractive -Command "$shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut($env:CODEX_REMOTE_LINK); $shortcut.TargetPath=[IO.Path]::GetFullPath($env:CODEX_REMOTE_START); $shortcut.WorkingDirectory=[IO.Path]::GetFullPath($env:CODEX_REMOTE_WORKDIR); $shortcut.WindowStyle=7; $shortcut.Description='Codex Remote'; $shortcut.Save()"

if exist "%CODEX_REMOTE_LINK%" (
  echo [OK] Codex Remote will start after this Windows user signs in.
) else (
  echo [ERROR] The startup shortcut could not be created. Check permissions.
)
pause
