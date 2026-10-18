@echo off
title JMeter Report to PDF
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies - first run only, this downloads a headless Chrome, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  npm install failed. If the Chrome download is blocked by a proxy, run:
    echo     set PUPPETEER_SKIP_DOWNLOAD=1 ^&^& npm install
    echo  The tool will then use your installed Chrome or Edge automatically.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=4000
start "" http://localhost:%PORT%
node server.js
pause
