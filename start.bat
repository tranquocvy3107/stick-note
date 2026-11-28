@echo off
rem Stick Note (source checkout) - double-click this file to open the app.
rem It builds the program the first time (needs Rust: https://rustup.rs), starts the server hidden if it is not
rem running yet, then opens the app window. Closing the window lets the server quit by itself after about 5 minutes.
rem Installed copies use their own shortcut instead; this file is for people running from the source.
rem The notes are kept in the "data" folder of this checkout (set STICK_NOTE_DATA to use another one).
setlocal
cd /d "%~dp0"
where cargo >nul 2>nul
if errorlevel 1 (
  echo Rust was not found. Install it from https://rustup.rs and run start.bat again.
  pause
  exit /b 1
)
cargo run --release --locked --quiet -- --open
if errorlevel 1 pause
