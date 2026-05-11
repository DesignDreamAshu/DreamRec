@echo off
setlocal

if "%~1"=="" (
  echo Usage: convert-to-mp4.bat ^<input.webm^> [small^|balanced^|high^|4k] [output.mp4]
  exit /b 1
)

set "INPUT=%~1"
set "PRESET=%~2"
set "OUTPUT=%~3"

if "%PRESET%"=="" set "PRESET=balanced"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convert-to-mp4.ps1" -InputFile "%INPUT%" -Preset "%PRESET%" -OutputFile "%OUTPUT%"
exit /b %errorlevel%
