#!/bin/sh
set -e

cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "   ghostclauf public-site preparation"
echo "========================================"
echo ""

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Setup is incomplete. Run ./setup.sh first."
    exit 1
fi

if ! node -e "process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)" >/dev/null 2>&1; then
    echo "Node.js 20 or newer is required. Upgrade Node.js, then run ./publish-site.sh again."
    exit 1
fi

if [ ! -f "config.yaml" ] || [ ! -d "node_modules" ] || [ ! -f "site/index.html" ]; then
    echo "Setup is incomplete. Run ./setup.sh first."
    exit 1
fi

PYTHON=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PYTHON="$candidate"
        break
    fi
done
if [ -z "$PYTHON" ]; then
    echo "Python 3 is required to validate the public-site artifact. Install it, then run ./publish-site.sh again."
    exit 1
fi

echo "Exporting the public snapshot..."
npm run export:public

echo "Linting the public site..."
npm run lint:site

echo "Checking the public artifact boundary..."
"$PYTHON" scripts/check_public_site.py

echo ""
echo "Public snapshot is ready for review. Commit the reviewed site/ changes to publish them."
