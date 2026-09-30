#!/usr/bin/env bash
# Update the Pi Remote extension (and bridge) on this computer.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> pulling latest"
git pull --ff-only

echo "==> installing dependencies"
npm install --omit=dev
(cd bridge && npm install --omit=dev)

DEST="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
echo "==> installing extension -> $DEST/pi-remote"
mkdir -p "$DEST"
rm -rf "$DEST/pi-remote"
cp -R extension/pi-remote "$DEST/pi-remote"
cp package.json "$DEST/pi-remote/package.json.remote" 2>/dev/null || true

echo
echo "Done. Now:"
echo "  1. restart the bridge:   (cd bridge && npm run dev)"
echo "  2. run /reload in pi (or start a new pi session) to load the extension."
