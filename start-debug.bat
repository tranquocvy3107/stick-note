@echo off
rem Chay server o che do thuong va in log ra man hinh (dung khi can xem loi).
rem Mo http://127.0.0.1:4747/ tren trinh duyet. Dong cua so nay la tat server.
setlocal
cd /d "%~dp0"
node server.js
pause
