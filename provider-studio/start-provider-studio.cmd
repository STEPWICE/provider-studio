@echo off
title Provider Studio
cd /d "%~dp0"
echo Starting Provider Studio on http://localhost:5173
node server.mjs
pause
