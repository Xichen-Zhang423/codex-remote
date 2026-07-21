@echo off
setlocal
chcp 65001 >nul
title Codex Remote

where node >nul 2>&1
if not "%ERRORLEVEL%"=="0" goto :node_missing

set "NODE_MAJOR="
for /f "delims=" %%V in ('node -p "Number(process.versions.node.split('.')[0])" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto :node_missing
if %NODE_MAJOR% LSS 18 goto :node_old

where npm >nul 2>&1
if not "%ERRORLEVEL%"=="0" goto :npm_missing

node "%~dp0scripts\bootstrap.js" "%~dp0."
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Codex Remote exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%

:node_missing
echo [ERROR] Node.js was not found. Install Node.js 18 or newer:
echo https://nodejs.org/
pause
exit /b 1

:node_old
echo [ERROR] Node.js %NODE_MAJOR% is too old. Codex Remote requires Node.js 18 or newer.
echo Install a current version from https://nodejs.org/ and try again.
pause
exit /b 1

:npm_missing
echo [ERROR] npm was not found. Reinstall Node.js 18 or newer with npm.
pause
exit /b 1
