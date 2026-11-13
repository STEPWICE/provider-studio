@echo off
chcp 65001 >nul
cd /d "%~dp0gemini-bridge"
call "%~dp0gemini-bridge\open-dashboard.cmd"
exit /b 0
