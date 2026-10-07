@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 野球拳 伺服器啟動中… 關閉這個視窗就會結束遊戲伺服器。
start "" cmd /c "timeout /t 1 >nul & start http://localhost:8765/"
python server.py 8765
