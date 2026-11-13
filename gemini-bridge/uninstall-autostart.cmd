@echo off
rem ASCII-only on purpose: chcp 65001 plus UTF-8 text desynchronises the cmd parser.
echo Removing Gemini Web Bridge from Windows startup...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\GeminiWebBridge.lnk';" ^
  "if (Test-Path $lnk) { Remove-Item -Path $lnk -Force; Write-Host ('Removed: ' + $lnk) }" ^
  "else { Write-Host 'Autostart entry was not present.' }"
pause