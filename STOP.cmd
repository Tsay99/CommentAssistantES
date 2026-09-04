@echo off
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0disable-service.ps1"
pause
