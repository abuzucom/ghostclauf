#!/bin/sh
set -e

# Navigate to script directory
cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "       ghostclauf one-click setup"
echo "========================================"
echo ""

if [ ! -f "package.json" ] || [ ! -f "package-lock.json" ] || [ ! -f ".env.example" ] || [ ! -f "config.example.yaml" ] || [ ! -f "scripts/node-env.sh" ]; then
    echo "This script must be run from the ghostclauf project folder."
    exit 1
fi

# shellcheck source=scripts/node-env.sh
. ./scripts/node-env.sh

if ! ensure_node; then
    echo "Could not install Node.js automatically. Install Node.js 22.22 or newer from https://nodejs.org/ and run ./setup.sh again."
    exit 1
fi
echo "Using Node.js $(node --version)."

if [ ! -f ".env" ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
fi

if [ ! -r ".env" ]; then
    echo ".env is not readable. Fix its permissions and run ./setup.sh again."
    exit 1
fi

if [ ! -f "config.yaml" ]; then
    echo "Creating config.yaml from config.example.yaml..."
    cp config.example.yaml config.yaml
fi

# Ensure data directory exists with restricted permissions (0700)
mkdir -p data
if ! chmod 700 data; then
    echo "Warning: could not restrict data/ to mode 700. It holds OAuth tokens, so run 'chmod 700 data' yourself."
fi

echo "Installing Node.js dependencies..."
npm install

echo "Building ghostclauf..."
npm run build

NEEDS_CONFIG=0
if grep -q "your-app-client-id" .env || grep -q "your-app-client-secret" .env; then
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
