@echo off
chcp 65001 >nul
title Gemini Web OpenAI Bridge
cd /d "%~dp0"

echo ========================================================
echo       Gemini Web to OpenAI Bridge (Google AI Pro)
echo ========================================================
echo.

if not exist .venv (
    echo [1/3] Создание виртуального окружения Python...
    uv venv .venv
)

echo [2/3] Проверка и установка зависимостей...
uv pip install -r requirements.txt --python .venv\Scripts\python.exe

echo [3/3] Запуск локального сервера моста...
echo Эндпоинт для Cline / Roo Code / OpenCode: http://127.0.0.1:8010/v1
echo.
.venv\Scripts\python.exe server.py
pause
