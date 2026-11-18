@echo off
rem Удобный вход в ещё один аккаунт Zen для пула ProviderStudio.
cd /d "%~dp0.."
node scripts\zen-login.mjs %*
pause