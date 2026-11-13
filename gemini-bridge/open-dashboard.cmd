@echo off
cd /d "%~dp0"
rem ASCII-only on purpose: chcp 65001 plus UTF-8 text desynchronises the cmd parser.

curl.exe -s --noproxy "*" --connect-timeout 1 http://127.0.0.1:8010/health >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Starting Gemini Web Bridge in the background...
    wscript.exe "%~dp0start-hidden.vbs"
    timeout /t 2 /nobreak >nul
)

start "" "http://127.0.0.1:8010/dashboard"
exit /b 0