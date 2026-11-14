@echo off
cd /d "%~dp0"
setlocal

rem Keep this file ASCII-only: cmd.exe re-reads a batch file by byte offset, so
rem "chcp 65001" plus UTF-8 text above a command desynchronises the parser and
rem splits commands into garbage fragments.

set CHROME=
if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" set "CHROME=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
    echo [ERROR] Google Chrome not found. Install Chrome or set the path manually.
    pause
    exit /b 1
)

echo ========================================================
echo    Google sign-in for Gemini Web Bridge
echo ========================================================
echo.
echo A separate Chrome window with the bridge profile will open.
echo Sign in to your Google account once.
echo.
echo You do NOT need to copy cookies or open F12 - the bridge
echo picks up the session itself and keeps it alive.
echo.
echo You can close this window after signing in.
echo.

start "" "%CHROME%" --remote-debugging-port=9223 --user-data-dir="%~dp0.chrome-profile" --no-first-run --no-default-browser-check "https://gemini.google.com/app"

echo Waiting for sign-in...
:wait_login
timeout /t 5 /nobreak >nul
curl.exe -s -m 10 --noproxy "*" -X POST http://127.0.0.1:8010/auth/refresh > "%TEMP%\bridge_auth.json" 2>nul
rem Success means a full session, not just \"the CDP browser answers\":
rem /auth/refresh returns ok:true even for a guest session that can only use
rem flash-lite, and this loop used to stop right there without a real sign-in.
findstr /c:"\"degraded\":false" "%TEMP%\bridge_auth.json" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   not signed in yet - waiting...
    goto wait_login
)

echo.
echo [SUCCESS] Google session acquired. Bridge is authorized.
del "%TEMP%\bridge_auth.json" >nul 2>&1
timeout /t 3 >nul
endlocal
exit /b 0