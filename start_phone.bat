@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 手機版野球拳伺服器啟動中… 關閉這個視窗就會結束。
python server.py 8443 --https
pause
