@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   正在启动备考节奏...
echo.
start "" http://localhost:5173
node server.js
pause
