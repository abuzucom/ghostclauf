#!/bin/sh
set -e

# Navigate to script directory
cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "       ghostclauf one-click setup"
echo "========================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 20 or newer is required. Install it from https://nodejs.org/ and run ./setup.sh again."
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "npm was not found. Reinstall Node.js from https://nodejs.org/ and run ./setup.sh again."
    exit 1
fi

if ! node -e "process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)" >/dev/null 2>&1; then
    echo "Node.js 20 or newer is required. Upgrade Node.js from https://nodejs.org/ and run ./setup.sh again."
    exit 1
fi

if [ ! -f "package.json" ] || [ ! -f "package-lock.json" ] || [ ! -f ".env.example" ] || [ ! -f "config.example.yaml" ]; then
    echo "This script must be run from the ghostclauf project folder."
    exit 1
fi

if [ ! -f ".env" ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
fi

if [ ! -f "config.yaml" ]; then
    echo "Creating config.yaml from config.example.yaml..."
    cp config.example.yaml config.yaml
fi

# Ensure data directory exists with restricted permissions (0700)
mkdir -p data
chmod 700 data 2>/dev/null || true

echo "Installing Node.js dependencies..."
npm install

echo "Building ghostclauf..."
npm run build

NEEDS_CONFIG=0
if grep -q "your-app-client-id" .env 2>/dev/null || grep -q "your-app-client-secret" .env 2>/dev/null; then
    NEEDS_CONFIG=1
fi

if [ "$NEEDS_CONFIG" -eq 1 ]; then
    echo ""
    echo "Setup is almost complete."
    echo "Edit .env with your Twitch application's Client ID and Client Secret"
    echo "(register one at https://dev.twitch.tv/console/apps)."
    echo "Run ./setup.sh again after saving it."
    exit 0
fi

echo ""
echo "Setup complete. Run ./run.sh to start ghostclauf."
echo "The first time it runs, ./run.sh will ask for your bot and broadcaster"
echo "Twitch logins, save them to config.yaml, and walk you through"
echo "authorizing each account. After that, it just starts the bot."
echo ""
