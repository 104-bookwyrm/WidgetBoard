@echo off
setlocal
cd /d "%~dp0src-tauri"
set "TAURI_CONFIG={"identifier":"app.widgetboard.devtest"}"
cargo build
if errorlevel 1 (
  echo Build failed. Check the output above.
  pause
  exit /b 1
)
start "" "%~dp0src-tauri\target\debug\widgetboard.exe" --tutorial-debug

