@echo off
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0webhook-start.ps1"
pause
