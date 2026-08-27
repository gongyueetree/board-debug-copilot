@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-recamera-service.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed. Please review the error above.
  pause
)
