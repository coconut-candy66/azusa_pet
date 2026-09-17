@echo off
setlocal
title 桌宠 - 兼容模式
cd /d "%~dp0"

rem ============================================================
rem  兼容模式启动 —— 强制使用软件渲染，不依赖显卡
rem
rem  什么时候需要它：
rem    双击「启动桌宠.cmd」之后什么都没发生，或者
rem    logs\desktop.log 里出现这样的字样：
rem      FATAL:gpu_data_manager_impl_private.cc GPU process is not usable
rem    这说明电脑的显卡驱动没能让 Electron 的 GPU 进程起来。
rem
rem  代价：
rem    画面改由 CPU 计算。会慢一些、也更费电，
rem    所以只在正常模式起不来的时候用。
rem
rem  ★ 本文件必须保存为【ANSI/GBK 编码 + CRLF 换行】，
rem    否则 cmd.exe 解析失败，表现就是「双击后一闪就没了」。
rem ============================================================

set "HERE=%~dp0"
set "APP=%HERE%..\deskpet-demo"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"

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

set "DESKPET_CONFIG=%HERE%config.js"

echo.
echo   正在以【兼容模式】启动桌宠，软件渲染……
echo.

start "" "%ELECTRON%" --use-gl=swiftshader --enable-unsafe-swiftshader --no-sandbox "%APP%"

rem ------------------------------------------------------------
rem  存活检查：连软件渲染都起不来，那就只剩「看日志」这条路了。
rem ------------------------------------------------------------
timeout /t 3 /nobreak >nul 2>nul
tasklist /nh /fi "imagename eq electron.exe" 2>nul | find /i "electron.exe" >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ============================================================
  echo    [启动失败] 兼容模式也没能把桌宠拉起来
  echo   ============================================================
  echo.
  echo   请双击「调试启动.cmd」，它会把详细的报错留在窗口里。
  echo   然后把窗口里的内容发给我，我来定位。
  echo.
  pause
  exit /b 1
)

exit /b 0
