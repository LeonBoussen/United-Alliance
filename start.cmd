@echo off
setlocal
title United Alliance
cd /d "%~dp0"

rem Usage:  start.cmd              (asks)
rem         start.cmd server       (run the Overseer: real agents, console at http://localhost:8080)
rem         start.cmd mock         (demo console with mock data)
rem         start.cmd live [url]   (console only, connected to an Overseer elsewhere)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH. Install Node 22.5+ from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies - first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

set "MODE=%~1"
set "OVERSEER=%~2"
if /i "%MODE%"=="server" goto server
if /i "%MODE%"=="mock" goto mock
if /i "%MODE%"=="live" goto live

echo.
echo   United Alliance
echo   ---------------
echo   [1] Overseer server - real agents; console at http://localhost:8080
echo   [2] Demo            - console with mock data, no server
echo   [3] Console only    - connect to an Overseer running elsewhere
echo.
choice /c 123 /n /t 20 /d 1 /m "Choose 1, 2 or 3 (defaults to 1 in 20s): "
if errorlevel 3 goto ask_url
if errorlevel 2 goto mock
goto server

:server
echo.
echo Building the console...
set "VITE_MOCK=0"
set "VITE_OVERSEER_URL="
call npm run build -w @alliance/web >nul
if errorlevel 1 (
  echo Building the console failed. Run "npm run build -w @alliance/web" to see why.
  pause
  exit /b 1
)
if "%ALLIANCE_PORT%"=="" set "ALLIANCE_PORT=8080"
echo Starting the Overseer. Press Ctrl+C in this window to stop it.
echo If Windows Firewall asks, allow Node.js on private networks so harnesses on your LAN can connect.
echo.
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:%ALLIANCE_PORT%"
call npm run start -w @alliance/overseer
pause
exit /b

:ask_url
set "OVERSEER="
set /p "OVERSEER=Overseer URL [http://localhost:8080]: "

:live
if "%OVERSEER%"=="" set "OVERSEER=http://localhost:8080"
set "VITE_MOCK=0"
set "VITE_OVERSEER_URL=%OVERSEER%"
echo.
echo Starting the console against %OVERSEER% (no mock data)...
echo If no Overseer is running there, the console shows "offline" and keeps retrying.
goto run

:mock
set "VITE_MOCK=1"
set "VITE_OVERSEER_URL="
echo.
echo Starting the demo console with mock data...

:run
echo It will open at http://localhost:5173 - press Ctrl+C in this window to stop.
echo.
call npm run dev -w @alliance/web -- --open
pause
