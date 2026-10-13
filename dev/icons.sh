#!/usr/bin/env bash
# Rewrites the tracked app icons in src-tauri/icons from src-tauri/app-icon.svg.
# Usage: pnpm icons
set -euo pipefail

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pnpm tauri icon src-tauri/app-icon.svg -o "$tmp"
for f in 32x32.png 128x128.png 128x128@2x.png icon.icns icon.ico icon.png; do
	cp "$tmp/$f" src-tauri/icons/
done
