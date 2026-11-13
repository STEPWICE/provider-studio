@echo off
rem ASCII-only on purpose: chcp 65001 plus UTF-8 text desynchronises the cmd parser.
rem Quotes inside PowerShell are built from [char]34 so cmd never sees escaped
rem double quotes, which it re-parses and turns into garbage commands.
echo Adding Gemini Web Bridge to Windows startup...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$q = [char]34;" ^
  "$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\GeminiWebBridge.lnk';" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk);" ^
  "$s.TargetPath = 'wscript.exe';" ^
  "$s.Arguments = $q + '%~dp0start-hidden.vbs' + $q;" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.Description = 'Auto-start Gemini Web Bridge';" ^
  "$s.Save();" ^
  "Write-Host ('Created: ' + $lnk)"
pause