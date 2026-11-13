@echo off
chcp 65001 >nul
echo Добавление Gemini Web Bridge в автозагрузку Windows...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut(\"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\GeminiWebBridge.lnk\"); $Shortcut.TargetPath = 'wscript.exe'; $Shortcut.Arguments = '\"%~dp0start-hidden.vbs\"'; $Shortcut.WorkingDirectory = '%~dp0'; $Shortcut.Description = 'Auto-start Gemini Web Bridge'; $Shortcut.Save()"
echo [✓] Мост успешно добавлен в автозагрузку!
echo Теперь при включении ПК мост будет запускаться в фоне и автоматически прогревать модели.
timeout /t 3 >nul
