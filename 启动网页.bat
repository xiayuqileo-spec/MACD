@echo off
cd /d "%~dp0"
set LOG=%~dp0server.log
set ERR=%~dp0server.err.log
echo 正在启动 A股量化分析网页...
echo.
echo 如果浏览器没有自动打开，请手动访问:
echo http://127.0.0.1:5000
echo.
echo 服务窗口保持打开时，网页才能访问；不要关闭这个窗口。
echo.
echo 日志文件:
echo %LOG%
echo %ERR%
echo.
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 5; Start-Process 'http://127.0.0.1:5000'"
".venv\Scripts\python.exe" "ai_stock_selector.py" 1>>"%LOG%" 2>>"%ERR%"
echo.
echo 服务已停止。如果不是你主动关闭，请把下面两个日志文件发给我看:
echo %LOG%
echo %ERR%
pause
