@echo off
rem Stick Note - bam dup file nay de mo app.
rem Neu server chua chay thi tu bat (chay an), roi mo cua so app rieng.
rem Dong cua so app la server tu tat sau khoang 5 phut.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Khong tim thay Node.js. Hay cai Node.js tu https://nodejs.org roi chay lai start.bat.
  pause
  exit /b 1
)
node server.js --open
if errorlevel 1 pause
