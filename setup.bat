@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
title ghostclauf setup

echo.
echo ========================================
echo        ghostclauf one-click setup
echo ========================================
echo.

call :check_node
if not errorlevel 1 goto :node_ready

rem A Node.js installed after this window opened is in Program Files but not on
rem PATH. Try it before running winget, and never put it ahead of a supported
rem Node.js found earlier on PATH.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :check_node
if not errorlevel 1 goto :node_ready

echo Node.js 22.22 or newer is required. Installing the latest Node.js LTS with winget...
where winget >nul 2>&1
if errorlevel 1 goto :no_winget

rem Upgrade an existing (outdated) Node.js; install only when none is present.
where node >nul 2>&1
if errorlevel 1 goto :winget_install
winget upgrade --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
if not errorlevel 1 goto :winget_done
rem winget cannot upgrade a Node.js it did not install; install the LTS alongside it.
echo winget could not upgrade the existing Node.js. Installing the latest Node.js LTS instead...

:winget_install
winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
if errorlevel 1 echo winget could not install Node.js ^(exit code %errorlevel%^).

:winget_done
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"

call :check_node
if errorlevel 1 goto :old_node

:node_ready
for /f "delims=" %%v in ('node --version') do echo Using Node.js %%v.

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

rem Exit 0 when node and npm exist and node is 22.22.0 or newer.
:check_node
where node >nul 2>&1
if errorlevel 1 exit /b 1
where npm >nul 2>&1
if errorlevel 1 exit /b 1
node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 22) ? 0 : 1)" >nul 2>&1
exit /b %errorlevel%

:no_winget
echo winget was not found. Install Node.js 22.22 or newer from https://nodejs.org/ and run setup.bat again.
goto :failed

:old_node
echo Node.js 22.22 or newer is still not available. Install it from https://nodejs.org/, reopen this window, and run setup.bat again.
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
