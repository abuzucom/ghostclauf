@echo off
setlocal EnableExtensions EnableDelayedExpansion

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
if not exist "node_modules" goto :missing_setup

echo Building ghostclauf...
call npm run build
if errorlevel 1 goto :build_failed
echo.

if not exist "dist\index.js" goto :build_failed
if not exist "dist\tools\checkTokens.js" goto :build_failed
if not exist "dist\tools\configureAccounts.js" goto :build_failed

set "TOKEN_CHECK_FILE=%TEMP%\ghostclauf-token-check-%RANDOM%.txt"
node dist\tools\checkTokens.js >"%TOKEN_CHECK_FILE%" 2>&1
if errorlevel 1 goto :bad_config

findstr /B /C:"PLACEHOLDER LOGIN" "%TOKEN_CHECK_FILE%" >nul
if not errorlevel 1 (
    echo.
    echo config.yaml still has placeholder Twitch logins from config.example.yaml.
    echo Enter the real ones now - this is saved to config.yaml so you won't be asked again.
    echo.
    node dist\tools\configureAccounts.js
    if errorlevel 1 (
        del "%TOKEN_CHECK_FILE%" >nul 2>&1
        goto :failed
    )
    node dist\tools\checkTokens.js >"%TOKEN_CHECK_FILE%" 2>&1
    if errorlevel 1 goto :bad_config
)

for /f "usebackq delims=" %%L in ("%TOKEN_CHECK_FILE%") do call :authorize_if_missing "%%L"
del "%TOKEN_CHECK_FILE%" >nul 2>&1

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

:authorize_if_missing
set "LINE=%~1"
if "%LINE%"=="" exit /b 0
if "!LINE!"=="MISSING BOT" (
    echo.
    echo Bot account is not yet authorized. Opening OAuth flow...
    call npm run auth -- --bot
    if errorlevel 1 (
        del "!TOKEN_CHECK_FILE!" >nul 2>&1
        goto :failed
    )
    exit /b 0
)
echo !LINE!| findstr /B /C:"MISSING BROADCASTER " >nul
if not errorlevel 1 (
    set "BROADCASTER_LOGIN=!LINE:MISSING BROADCASTER =!"
    echo.
    echo Broadcaster "!BROADCASTER_LOGIN!" is not yet authorized. Opening OAuth flow...
    call npm run auth -- --broadcaster "!BROADCASTER_LOGIN!"
    if errorlevel 1 (
        del "!TOKEN_CHECK_FILE!" >nul 2>&1
        goto :failed
    )
)
exit /b 0

:missing_setup
echo Setup is incomplete. Double-click setup.bat first.
echo.
pause
exit /b 1

:build_failed
echo.
echo Build failed - ghostclauf's compiled code is out of date or broken.
echo Fix the error above, then double-click run.bat again.
pause
exit /b 1

:bad_config
echo Could not read your configuration:
echo.
type "%TOKEN_CHECK_FILE%"
del "%TOKEN_CHECK_FILE%" >nul 2>&1
echo.
echo Fix .env / config.yaml, then double-click run.bat again.
pause
exit /b 1

:old_node
echo Node.js 20 or newer is required. Upgrade Node.js from https://nodejs.org/ and run setup.bat again.
echo.
pause
exit /b 1

:failed
echo.
echo Authorization failed. Fix the message above and double-click run.bat again.
pause
exit /b 1
