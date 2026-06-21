@echo off
echo 正在停止 A股量化分析网页服务...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { $_.Path -like '*MACD分析*.venv*python.exe' } | Stop-Process -Force"
echo 已停止。
pause
