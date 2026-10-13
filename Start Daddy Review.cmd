@echo off
rem Starts Daddy Review in this window and opens it in your browser.
rem Close this window to stop it. Use "Install Daddy Review.cmd" to run it in the background instead.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(+process.versions.node.split('.')[0] < 18 ? 1 : 0)"
if errorlevel 1 goto nonode
title Daddy Review
node server\index.js %*
exit /b %errorlevel%

:nonode
echo.
echo   Daddy Review needs Node.js 18 or newer (free, one-time install).
echo.
echo   Easiest:  open PowerShell and run   winget install OpenJS.NodeJS.LTS
echo   Or download it from https://nodejs.org  -  then double-click this file again.
echo.
start "" https://nodejs.org/en/download
pause
exit /b 1
