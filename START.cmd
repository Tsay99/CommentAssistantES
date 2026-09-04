@echo off
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0enable-service.ps1"
pause
