@echo off
rem Run the server in the foreground and print its log (use this to see errors).
rem Open http://127.0.0.1:4747/ in a browser. Closing this window stops the server.
setlocal
cd /d "%~dp0"
node server.js
pause
