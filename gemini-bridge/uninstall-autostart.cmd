@echo off
chcp 65001 >nul
echo Удаление Gemini Web Bridge из автозагрузки Windows...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -Path \"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\GeminiWebBridge.lnk\" -ErrorAction SilentlyContinue"
echo [✓] Мост удален из автозагрузки Windows.
timeout /t 3 >nul
