@echo off
chcp 65001 >nul
echo Проверка статуса Gemini Web Bridge:
echo ----------------------------------------------------
curl -s http://127.0.0.1:8010/health
echo.
echo ----------------------------------------------------
pause
