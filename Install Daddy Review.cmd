@echo off
rem Runs Daddy Review in the background, starts it with Windows and opens it.
rem Then click "Install app" in the browser to get it in your Start menu and taskbar.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(+process.versions.node.split('.')[0] < 18 ? 1 : 0)"
if errorlevel 1 goto nonode
node server\index.js --install
echo   This window closes by itself.
timeout /t 12 >nul
exit /b 0

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
