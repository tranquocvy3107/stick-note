@echo off
rem Run the server in the foreground and print its log (use this to see errors).
rem Open http://127.0.0.1:4747/ in a browser. Closing this window stops the server.
rem This is a debug build: it reads the web interface from the "public" folder, so editing it needs no rebuild.
setlocal
cd /d "%~dp0"
cargo run --locked -- --serve
pause
