@echo off
title Gemini Web OpenAI Bridge
cd /d "%~dp0"

rem Keep this file ASCII-only: cmd.exe re-reads a batch file by byte offset, so
rem "chcp 65001" plus UTF-8 text above a command desynchronises the parser and
rem splits commands into garbage fragments.

echo ========================================================
echo       Gemini Web to OpenAI Bridge (Google AI Pro)
echo ========================================================
echo.

if not exist .venv (
    echo [1/3] Creating Python virtual environment...
    uv venv .venv
)

echo [2/3] Checking and installing dependencies...
uv pip install -r requirements.txt --python .venv\Scripts\python.exe

echo [3/3] Starting local bridge server...
echo Endpoint for Cline / Roo Code / OpenCode: http://127.0.0.1:8010/v1
echo.
rem Absolute path on purpose: stop.cmd identifies our process by looking for
rem "gemini-bridge" in its command line, and a bare "server.py" hides that.
.venv\Scripts\python.exe "%~dp0server.py"
pause