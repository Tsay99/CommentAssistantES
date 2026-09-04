@echo off
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0webhook-stop.ps1"
pause
