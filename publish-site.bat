@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title ghostclauf public-site preparation

echo.
echo ========================================
echo    ghostclauf public-site preparation
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :missing_setup
where npm >nul 2>&1
if errorlevel 1 goto :missing_setup

node -e "process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto :old_node

if not exist "config.yaml" goto :missing_setup
if not exist "node_modules" goto :missing_setup
if not exist "site\index.html" goto :missing_setup

where py >nul 2>&1
if not errorlevel 1 (
    set "PYTHON=py -3"
) else (
    where python >nul 2>&1
    if errorlevel 1 goto :missing_python
    set "PYTHON=python"
)

echo Exporting the public snapshot...
call npm run export:public
if errorlevel 1 goto :failed

echo Linting the public site...
call npm run lint:site
if errorlevel 1 goto :failed

echo Checking the public artifact boundary...
%PYTHON% scripts\check_public_site.py
if errorlevel 1 goto :failed

echo.
echo Public snapshot is ready for review. Commit the reviewed site/ changes to publish them.
echo.
pause
exit /b 0

:missing_setup
echo Setup is incomplete. Double-click setup.bat first.
goto :failed

:missing_python
echo Python 3 is required to validate the public-site artifact. Install it, then run publish-site.bat again.
goto :failed

:old_node
echo Node.js 20 or newer is required. Upgrade Node.js, then run publish-site.bat again.
goto :failed

:failed
echo.
echo Public-site preparation failed. Fix the message above and run publish-site.bat again.
echo.
pause
exit /b 1
