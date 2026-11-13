@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: Проверяем, запущен ли сервер моста на порту 8010
curl.exe -s --connect-timeout 1 http://127.0.0.1:8010/health >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Запуск Gemini Web Bridge в фоновом режиме...
    wscript.exe "%~dp0start-hidden.vbs"
    timeout /t 2 /nobreak >nul
)

:: Открываем дашборд лимитов в браузере по умолчанию
start "" "http://127.0.0.1:8010/dashboard"
exit /b 0
