@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

set CHROME=
if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" set "CHROME=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
    echo [ERROR] Google Chrome не найден. Установите Chrome или задайте путь вручную.
    pause
    exit /b 1
)

echo ========================================================
echo    Вход в Google для Gemini Web Bridge
echo ========================================================
echo.
echo Сейчас откроется отдельное окно Chrome с профилем моста.
echo Войдите в свой аккаунт Google один раз.
echo.
echo Копировать куки и открывать F12 НЕ нужно - мост заберёт
echo сессию сам и будет продлевать её автоматически.
echo.
echo Это окно можно закрыть после входа.
echo.

start "" "%CHROME%" --remote-debugging-port=9223 --user-data-dir="%~dp0.chrome-profile" --no-first-run --no-default-browser-check "https://gemini.google.com/app"

echo Ожидание входа в аккаунт...
:wait_login
timeout /t 5 /nobreak >nul
curl.exe -s -m 10 -X POST http://127.0.0.1:8010/auth/refresh > "%TEMP%\bridge_auth.json" 2>nul
findstr /c:"\"ok\":true" "%TEMP%\bridge_auth.json" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   ещё не вошли - ждём...
    goto wait_login
)

echo.
echo [SUCCESS] Сессия Google получена. Мост авторизован.
del "%TEMP%\bridge_auth.json" >nul 2>&1
timeout /t 3 >nul
endlocal
exit /b 0