@echo off
rem Stops the background service and removes it from Windows startup.
setlocal
cd /d "%~dp0"
node server\index.js --uninstall
pause
