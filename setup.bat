@echo off
setlocal EnableExtensions EnableDelayedExpansion

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

if defined NEEDS_CONFIG (
    echo.
    echo Setup is almost complete.
    echo Edit .env with your Twitch application's Client ID and Client Secret
    echo ^(register one at https://dev.twitch.tv/console/apps^).
    echo Run setup.bat again after saving it.
    goto :complete
)

:complete
echo.
echo Setup complete. Double-click run.bat to start ghostclauf.
echo The first time it runs, run.bat will ask for your bot and broadcaster
echo Twitch logins, save them to config.yaml, and walk you through
echo authorizing each account. After that, it just starts the bot.
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

:failed
echo.
echo Setup failed. Fix the message above and run setup.bat again.
echo.
pause
exit /b 1
