@echo off
setlocal
title Provider Studio
cd /d "%~dp0"

set "NODE_DIR="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_DIR=%%~dpI"
if not defined NODE_DIR if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs\"
if not defined NODE_DIR if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles(x86)%\nodejs\"
if not defined NODE_DIR if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_DIR=%LocalAppData%\Programs\nodejs\"
if not defined NODE_DIR if exist "%LocalAppData%\fnm\node-versions" for /d %%D in ("%LocalAppData%\fnm\node-versions\*") do if exist "%%D\installation\node.exe" set "NODE_DIR=%%D\installation\"
if not defined NODE_DIR if exist "%AppData%\nvm" for /f "delims=" %%V in ('dir /b /o-n "%AppData%\nvm\v*" 2^>nul') do if exist "%AppData%\nvm\%%V\node.exe" if not defined NODE_DIR set "NODE_DIR=%AppData%\nvm\%%V\"

if not defined NODE_DIR (
  echo Node.js was not found.
  echo Install it from https://nodejs.org/ or run dist\provider-studio.exe instead.
  pause
  exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"
echo Starting Provider Studio on http://localhost:5173
node server.mjs
if errorlevel 1 echo Provider Studio exited with an error.
pause
