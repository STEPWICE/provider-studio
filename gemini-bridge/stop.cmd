@echo off
setlocal
echo Stopping Gemini Web Bridge...

rem Kill only our own bridge. A bare "kill whatever listens on the port" once
rem took down an unrelated app that happened to own that port.
rem Keep this file ASCII-only: cmd.exe re-reads a batch file by byte offset, so
rem "chcp 65001" plus UTF-8 text above a command desynchronises the parser and
rem splits commands into garbage fragments.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pids = Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique;" ^
  "$killed = 0;" ^
  "foreach ($p in $pids) {" ^
  "  $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p) -ErrorAction SilentlyContinue;" ^
  "  if ($proc -and $proc.CommandLine -and $proc.CommandLine -like '*gemini-bridge*') {" ^
  "    Write-Host ('Stopping PID ' + $p + ' (' + $proc.Name + ')');" ^
  "    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; $killed++" ^
  "  } elseif ($proc) {" ^
  "    Write-Host ('Port 8010 is owned by another process ' + $proc.Name + ' (PID ' + $p + ') - leaving it alone.')" ^
  "  }" ^
  "};" ^
  "if ($killed -eq 0) { Write-Host 'Bridge is not running.' }" ^
  "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*gemini-bridge*start.cmd*' } | ForEach-Object { Write-Host ('Removing stale launcher PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

endlocal