@echo off
chcp 65001 >nul
setlocal
echo Остановка локального сервиса Gemini Web Bridge...

rem Kill only our own bridge. A bare "kill whatever listens on the port" once
rem took down an unrelated app that happened to own that port.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = (Get-Location).Path;" ^
  "$pids = Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique;" ^
  "$killed = 0;" ^
  "foreach ($p in $pids) {" ^
  "  $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue;" ^
  "  if ($proc -and $proc.CommandLine -and $proc.CommandLine -like '*gemini-bridge*') {" ^
  "    Write-Host ('Завершение процесса PID ' + $p + ' (' + $proc.Name + ')');" ^
  "    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; $killed++" ^
  "  } elseif ($proc) {" ^
  "    Write-Host ('Порт 8010 занят посторонним процессом ' + $proc.Name + ' (PID ' + $p + ') - не трогаем.')" ^
  "  }" ^
  "};" ^
  "if ($killed -eq 0) { Write-Host 'Мост не запущен.' }"

echo Готово.
timeout /t 2 >nul
endlocal