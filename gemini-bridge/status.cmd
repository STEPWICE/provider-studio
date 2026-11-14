@echo off
rem ASCII-only on purpose: chcp 65001 plus UTF-8 text desynchronises the cmd parser.
setlocal
set "LOG=%~dp0logs\bridge.log"

echo ====================================================
echo  Gemini Web Bridge status
echo ====================================================
curl -s --noproxy "*" -m 8 http://127.0.0.1:8010/health
echo.
echo ----------------------------------------------------
if exist "%LOG%" (
    echo Last 20 log lines:
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Path '%LOG%' -Tail 20"
) else (
    echo No log file yet: %LOG%
)
echo ----------------------------------------------------
pause
endlocal
