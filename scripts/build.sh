#!/bin/sh
# Packs the extension into dist/translate-tube-<version>.zip
set -e
VERSION=$(node -p "require('./manifest.json').version")
mkdir -p dist
OUT="dist/translate-tube-$VERSION.zip"
rm -f "$OUT"
zip -qr "$OUT" manifest.json src LICENSE README.md -x '*.DS_Store'
echo "$OUT"
