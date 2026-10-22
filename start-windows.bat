@echo off
title University Activity Tracker
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Download the LTS version from https://nodejs.org , install it, then run this file again.
  pause
  exit /b 1
)
node server.js
pause
