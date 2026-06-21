Set-Location -LiteralPath $PSScriptRoot
$log = Join-Path $PSScriptRoot "server.log"
$err = Join-Path $PSScriptRoot "server.err.log"
Write-Host "正在启动 A股量化分析网页..."
Write-Host ""
Write-Host "如果浏览器没有自动打开，请手动访问:"
Write-Host "http://127.0.0.1:5000"
Write-Host ""
Write-Host "服务窗口保持打开时，网页才能访问；不要关闭这个窗口。"
Write-Host ""
Write-Host "日志文件:"
Write-Host $log
Write-Host $err
Write-Host ""
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 4
    Start-Process "http://127.0.0.1:5000"
} | Out-Null
& ".\.venv\Scripts\python.exe" ".\ai_stock_selector.py" 1>> $log 2>> $err
Write-Host ""
Write-Host "服务已停止。如果不是你主动关闭，请把日志文件发给我看。"
Read-Host "按回车关闭"
