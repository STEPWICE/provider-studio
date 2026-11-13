@echo off
rem ASCII-only on purpose: chcp 65001 plus UTF-8 text desynchronises the cmd parser.
echo Gemini Web Bridge status:
echo ----------------------------------------------------
curl -s --noproxy "*" http://127.0.0.1:8010/health
echo.
echo ----------------------------------------------------
pause