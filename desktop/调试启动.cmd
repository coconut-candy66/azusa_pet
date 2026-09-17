@echo off
setlocal
title 桌宠 - 调试模式
cd /d "%~dp0"

rem ============================================================
rem  调试模式启动 —— 会保留黑框窗口，实时滚动日志
rem
rem  和「启动桌宠.cmd」的区别：
rem    1. 自动打开开发者工具（也可以用 F12 随时开关）
rem    2. 下方实时显示日志，不用去翻文件
rem    3. 开启了 Electron 自身的日志输出
rem
rem  关掉这个黑框【不会】关掉桌宠。要关桌宠请右键点它。
rem
rem  ★ 本文件必须保存为【ANSI/GBK 编码 + CRLF 换行】，
rem    否则 cmd.exe 解析失败，表现就是「双击后一闪就没了」。
rem ============================================================

set "HERE=%~dp0"
set "APP=%HERE%..\deskpet-demo"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"
set "LOG=%HERE%logs\desktop.log"

if not exist "%ELECTRON%" (
  echo.
  echo   [错误] 找不到 Electron 本体：
  echo     %ELECTRON%
  echo.
  echo   请打开命令行进入 deskpet-demo 目录执行一次 npm install。
  echo.
  pause
  exit /b 1
)

if not exist "%HERE%config.js" (
  echo.
  echo   [错误] 找不到参数文件：%HERE%config.js
  echo.
  pause
  exit /b 1
)

rem 先把日志文件准备好，这样下面的实时输出能立刻开始
if not exist "%HERE%logs" mkdir "%HERE%logs" >nul 2>nul
if not exist "%LOG%" type nul > "%LOG%"

set "DESKPET_CONFIG=%HERE%config.js"
set "ELECTRON_ENABLE_LOGGING=1"

echo.
echo   正在以【调试模式】启动桌宠……
echo     - 会自动打开开发者工具，按 F12 可随时开关
echo     - Ctrl+R 重载页面，只重跑渲染层
echo     - 改 config.js 保存后，应用会自动重启
echo     - 关闭本窗口不会关掉桌宠，要关桌宠请右键点它
echo.
echo   ---------- 日志实时输出 ----------
echo.

start "" "%ELECTRON%" --deskpet-devtools "%APP%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[System.Text.Encoding]::GetEncoding(936); Get-Content -LiteralPath '%LOG%' -Wait -Encoding UTF8"
