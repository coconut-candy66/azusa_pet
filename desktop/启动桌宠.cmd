@echo off
setlocal
title 桌宠
cd /d "%~dp0"

rem ============================================================
rem  桌宠启动器 —— 双击本文件即可运行
rem
rem  改动前请先读这四条：
rem
rem  1. 不需要安装 Node.js。
rem     这里直接调用 deskpet-demo 里已经下载好的 Electron 本体
rem     （node_modules/electron/dist/electron.exe），完全绕开 npm。
rem
rem  2. ★ 本文件必须保存为【ANSI/GBK 编码 + CRLF 换行】。
rem     不要改成 UTF-8，也不要用 LF 换行 —— 这两件事都会让 cmd.exe
rem     解析失败，表现就是「双击后黑框一闪就没了」。
rem     系统默认代码页是 936(GBK)，所以这里不写 chcp 命令。
rem
rem  3. 路径一律用 %~dp0（本文件所在目录）拼出来，不写死中文路径。
rem
rem  4. 参数全部集中在同目录的 config.js 里，改完保存自动生效。
rem ============================================================

set "HERE=%~dp0"
set "APP=%HERE%..\deskpet-demo"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo.
  echo   [错误] 找不到 Electron 本体：
  echo     %ELECTRON%
  echo.
  echo   解决办法：打开命令行，进入 deskpet-demo 目录，执行一次
  echo     npm install
  echo.
  echo   如果提示 npm 不存在，说明还没装 Node.js，
  echo   请到 https://nodejs.org/ 下载 LTS 版本安装。
  echo.
  pause
  exit /b 1
)

if not exist "%HERE%config.js" (
  echo.
  echo   [错误] 找不到参数文件：
  echo     %HERE%config.js
  echo.
  pause
  exit /b 1
)

rem 把参数文件的位置告诉应用。
rem 应用只在拿到这个变量时才会去读用户配置、并开启「改完自动重启」；
rem 没拿到就用内置默认值 —— 自动化测试走的就是那条路，
rem 这样「你改了参数」就不会把测试搞红。
set "DESKPET_CONFIG=%HERE%config.js"

rem 用 start 启动，让这个黑框窗口尽快消失，
rem 不留一个命令行窗口杵在桌面上。
rem 开头的 "" 是窗口标题占位，不能省略。
start "" "%ELECTRON%" "%APP%"

rem ------------------------------------------------------------
rem  存活检查：等 2 秒，看 Electron 进程还在不在。
rem
rem  为什么要有这一步：Electron 如果一启动就崩（最常见的是显卡驱动
rem  导致 GPU 进程起不来），它是往自己的 stderr 报错的，而那段输出
rem  随着黑框关闭一起没了 —— 用户看到的就是「一闪，什么都没发生」，
rem  完全无从下手。所以这里主动确认一次，起不来就把原因和下一步写清楚。
rem
rem  代价：启动成功时黑框也会多停留约 2 秒。这是为「失败时能看见」付的费。
rem ------------------------------------------------------------
timeout /t 2 /nobreak >nul 2>nul
tasklist /nh /fi "imagename eq electron.exe" 2>nul | find /i "electron.exe" >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ============================================================
  echo    [启动失败] 2 秒内没有检测到桌宠进程
  echo   ============================================================
  echo.
  echo   按顺序试这三步：
  echo.
  echo     1. 双击「兼容模式启动.cmd」
  echo        它强制用 CPU 画图，不依赖显卡。显卡不兼容时最有效。
  echo.
  echo     2. 双击「调试启动.cmd」
  echo        保留黑框并实时显示日志，能直接看到崩在哪一步。
  echo.
  echo     3. 打开 logs\desktop.log，看最后几行。
  echo.
  pause
  exit /b 1
)

exit /b 0
