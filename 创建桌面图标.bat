@echo off
setlocal
chcp 65001 >nul
title Create Codex Remote desktop shortcut
set "CODEX_REMOTE_START=%~dp0start.bat"
set "CODEX_REMOTE_WORKDIR=%~dp0"

powershell -NoProfile -NonInteractive -Command "$desktop=[Environment]::GetFolderPath('Desktop'); $shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut((Join-Path $desktop 'Codex Remote.lnk')); $shortcut.TargetPath=[IO.Path]::GetFullPath($env:CODEX_REMOTE_START); $shortcut.WorkingDirectory=[IO.Path]::GetFullPath($env:CODEX_REMOTE_WORKDIR); $shortcut.IconLocation=$env:SystemRoot+'\System32\shell32.dll,25'; $shortcut.WindowStyle=7; $shortcut.Description='Codex Remote'; $shortcut.Save()"

echo [OK] The Codex Remote desktop shortcut was created or updated.
pause
