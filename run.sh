#!/bin/sh
set -e

cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "         ghostclauf"
echo "========================================"
echo ""

# shellcheck source=scripts/node-env.sh
. ./scripts/node-env.sh

if ! node_is_supported; then
    echo "Node.js 22.22 or newer is required. Run ./setup.sh to install it."
    exit 1
fi

if [ ! -f ".env" ] || [ ! -f "config.yaml" ] || [ ! -d "node_modules" ]; then
    echo "Setup is incomplete. Run ./setup.sh first."
    exit 1
fi

echo "Building ghostclauf..."
if ! npm run build; then
    echo ""
    echo "Build failed - ghostclauf's compiled code is out of date or broken."
    echo "Fix the error above, then run ./run.sh again."
    exit 1
fi
echo ""

if [ ! -f "dist/index.js" ] || [ ! -f "dist/tools/checkTokens.js" ] || [ ! -f "dist/tools/configureAccounts.js" ]; then
    echo "Build failed - compiled files are missing."
    exit 1
fi

TOKEN_CHECK_FILE=$(mktemp "${TMPDIR:-/tmp}/ghostclauf-token-check.XXXXXX")
cleanup() {
    rm -f "$TOKEN_CHECK_FILE"
}
trap cleanup EXIT INT TERM

if ! node dist/tools/checkTokens.js >"$TOKEN_CHECK_FILE" 2>&1; then
    echo "Could not read your configuration:"
    echo ""
    cat "$TOKEN_CHECK_FILE"
    echo ""
    echo "Fix .env / config.yaml, then run ./run.sh again."
    exit 1
fi

if grep -q "^PLACEHOLDER LOGIN" "$TOKEN_CHECK_FILE" 2>/dev/null; then
    echo ""
    echo "config.yaml still has placeholder Twitch logins from config.example.yaml."
    echo "Enter the real ones now - this is saved to config.yaml so you won't be asked again."
    echo ""
    if ! node dist/tools/configureAccounts.js; then
        echo "Failed to configure accounts."
        exit 1
    fi
    if ! node dist/tools/checkTokens.js >"$TOKEN_CHECK_FILE" 2>&1; then
        echo "Could not read your configuration:"
        echo ""
        cat "$TOKEN_CHECK_FILE"
        echo ""
        echo "Fix .env / config.yaml, then run ./run.sh again."
        exit 1
    fi
fi

while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "MISSING BOT" ]; then
        echo ""
        echo "Bot account is not yet authorized. Opening OAuth flow..."
        if ! npm run auth -- --bot; then
            echo "Authorization failed."
            exit 1
        fi
    elif echo "$line" | grep -q "^MISSING BROADCASTER "; then
        BROADCASTER_LOGIN=$(echo "$line" | sed 's/^MISSING BROADCASTER //')
        echo ""
        echo "Broadcaster \"$BROADCASTER_LOGIN\" is not yet authorized. Opening OAuth flow..."
        if ! npm run auth -- --broadcaster "$BROADCASTER_LOGIN"; then
            echo "Authorization failed."
            exit 1
        fi
    fi
done < "$TOKEN_CHECK_FILE"

rm -f "$TOKEN_CHECK_FILE"
trap - EXIT INT TERM

echo "Starting ghostclauf. Press Ctrl+C to stop it."
echo ""
npm start
