#!/usr/bin/env bash
# Packaging: builds both store zips from the single source tree.
#   Firefox = repo root as-is (manifest.json has browser_specific_settings).
#   Chrome  = same files, but manifest WITHOUT browser_specific_settings.
# There is only ONE manifest.json (Firefox); the Chrome one is generated here
# into a temp dir and never committed. likes-calendar.js and icons/ stay identical.
#
# Usage: ./build.sh   ->   dist/firefox.zip  and  dist/chrome.zip
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(node -e "process.stdout.write(require('./manifest.json').version)")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rm -rf dist && mkdir -p dist

# --- Firefox: root as-is ---
zip -qr -X dist/firefox.zip manifest.json likes-calendar.js icons

# --- Chrome: manifest without browser_specific_settings ---
mkdir -p "$TMP/chrome/icons"
node -e "const m=require('./manifest.json'); delete m.browser_specific_settings; \
  require('fs').writeFileSync('$TMP/chrome/manifest.json', JSON.stringify(m,null,2)+'\n');"
cp likes-calendar.js "$TMP/chrome/"
cp icons/*.png "$TMP/chrome/icons/"
( cd "$TMP/chrome" && zip -qr -X - manifest.json likes-calendar.js icons ) > dist/chrome.zip

echo "Built v$VERSION -> dist/firefox.zip , dist/chrome.zip"
