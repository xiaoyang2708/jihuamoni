@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 跟 启动.bat 一样，只是打开网址时带上 ?demo=1，今日页顶上会多出体验工具条。
REM 想看没有工具条的正式版，用 启动.bat。

echo.
echo   正在启动备考节奏（体验模式）...
echo.
start "" "http://localhost:5173/?demo=1"
node server.js
pause
