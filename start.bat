@echo off
setlocal
chcp 65001 >nul
title Codex Remote

where node >nul 2>&1
if not "%ERRORLEVEL%"=="0" goto :node_missing

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
