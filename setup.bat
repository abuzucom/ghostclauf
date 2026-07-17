@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title ghostclauf setup

echo.
echo ========================================
echo        ghostclauf one-click setup
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :missing_node

where npm >nul 2>&1
if errorlevel 1 goto :missing_npm

node -e "process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto :old_node

if not exist "package.json" goto :missing_project
if not exist "package-lock.json" goto :missing_project
if not exist ".env.example" goto :missing_project
if not exist "config.example.yaml" goto :missing_project

if not exist ".env" (
    echo Creating .env from .env.example...
    copy /Y ".env.example" ".env" >nul
    if errorlevel 1 goto :failed
)

if not exist "config.yaml" (
    echo Creating config.yaml from config.example.yaml...
    copy /Y "config.example.yaml" "config.yaml" >nul
    if errorlevel 1 goto :failed
)

echo Installing Node.js dependencies...
call npm install
if errorlevel 1 goto :failed

echo Building ghostclauf...
call npm run build
if errorlevel 1 goto :failed

findstr /C:"your-app-client-id" ".env" >nul 2>&1
if not errorlevel 1 set "NEEDS_CONFIG=1"
findstr /C:"your-app-client-secret" ".env" >nul 2>&1
if not errorlevel 1 set "NEEDS_CONFIG=1"
findstr /C:"your_streamer_login" "config.yaml" >nul 2>&1
if not errorlevel 1 set "NEEDS_CONFIG=1"
findstr /C:"your_first_streamer_login" "config.yaml" >nul 2>&1
if not errorlevel 1 set "NEEDS_CONFIG=1"
findstr /C:"your_second_streamer_login" "config.yaml" >nul 2>&1
if not errorlevel 1 set "NEEDS_CONFIG=1"
findstr /C:"your_bot_login" "config.yaml" >nul 2>&1
if not errorlevel 1 set "NEEDS_CONFIG=1"

if defined NEEDS_CONFIG (
    echo.
    echo Setup is almost complete.
    echo Edit .env and config.yaml with your Twitch application and account details.
    echo Run setup.bat again after saving them to start bot authorization.
    goto :complete
)

echo.
choice /C YN /N /M "Start OAuth setup for the bot and both broadcasters now? [Y/N] "
if errorlevel 2 goto :complete

echo.
echo Authorize the bot account first.
call npm run auth -- --bot
if errorlevel 1 goto :failed

echo.
set "BROADCASTER_ONE_LOGIN="
set /P "BROADCASTER_ONE_LOGIN=Enter the first configured broadcaster login: "
if not defined BROADCASTER_ONE_LOGIN goto :missing_broadcaster_login
call npm run auth -- --broadcaster "%BROADCASTER_ONE_LOGIN%"
if errorlevel 1 goto :failed

echo.
set "BROADCASTER_TWO_LOGIN="
set /P "BROADCASTER_TWO_LOGIN=Enter the second configured broadcaster login: "
if not defined BROADCASTER_TWO_LOGIN goto :missing_broadcaster_login
call npm run auth -- --broadcaster "%BROADCASTER_TWO_LOGIN%"
if errorlevel 1 goto :failed

:complete
echo.
echo Setup complete. Double-click run.bat to start ghostclauf.
echo.
pause
exit /b 0

:missing_node
echo Node.js 20 or newer is required. Install it from https://nodejs.org/ and run setup.bat again.
goto :failed

:missing_npm
echo npm was not found. Reinstall Node.js from https://nodejs.org/ and run setup.bat again.
goto :failed

:old_node
echo Node.js 20 or newer is required. Upgrade Node.js from https://nodejs.org/ and run setup.bat again.
goto :failed

:missing_project
echo This file must be in the ghostclauf project folder.
goto :failed

:missing_broadcaster_login
echo Both configured broadcaster logins are required for OAuth setup.
goto :failed

:failed
echo.
echo Setup failed. Fix the message above and run setup.bat again.
echo.
pause
exit /b 1
