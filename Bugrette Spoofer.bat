@echo off
setlocal
title Bugrette Spoofer

REM Always run from the folder this .bat lives in.
cd /d "%~dp0"

echo ============================================
echo   Bugrette Spoofer - launcher
echo ============================================
echo.

REM Make sure Node.js / npm is available.
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm was not found on this PC.
  echo Install Node.js 18+ from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

REM Install dependencies the first time (or if node_modules is missing).
if not exist "node_modules" (
  echo First run detected - installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo Starting the app... keep this window open to keep the bot online 24/7.
echo Close this window (or press Ctrl+C) to stop the bot.
echo.

REM Build (fast) and launch the Electron app.
call npm run start

echo.
echo App closed.
pause
endlocal
