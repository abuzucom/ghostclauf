@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title ghostclauf

echo.
echo ========================================
echo          ghostclauf
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :missing_setup

where npm >nul 2>&1
if errorlevel 1 goto :missing_setup

node -e "process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto :old_node

if not exist ".env" goto :missing_setup
if not exist "config.yaml" goto :missing_setup
if not exist "dist\index.js" goto :missing_setup
if not exist "node_modules" goto :missing_setup

echo Starting ghostclauf. Press Ctrl+C to stop it.
echo.
call npm start
set "EXIT_CODE=%errorlevel%"
if "%EXIT_CODE%"=="0" goto :stopped

echo.
echo ghostclauf stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

:stopped
echo.
echo ghostclauf stopped.
pause
exit /b 0

:missing_setup
echo Setup is incomplete. Double-click setup.bat first.
echo.
pause
exit /b 1

:old_node
echo Node.js 20 or newer is required. Upgrade Node.js from https://nodejs.org/ and run setup.bat again.
echo.
pause
exit /b 1
