@echo off
rem Stick Note (source checkout) - double-click this file to open the app.
rem If the server is not running yet it is started (hidden), then the app window opens.
rem Closing the app window lets the server quit by itself after about 5 minutes.
rem Installed copies use their own shortcut instead; this file is for people running from the source.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and run start.bat again.
  pause
  exit /b 1
)
node server.js --open
if errorlevel 1 pause
