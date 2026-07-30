#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Dispatcher Status Bar.app"
BUILD_DIR="$ROOT/build"
APP_DIR="$BUILD_DIR/$APP_NAME"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
cp "$ROOT/Info.plist" "$CONTENTS_DIR/Info.plist"

/usr/bin/swiftc \
  -framework AppKit \
  -framework WebKit \
  "$ROOT/Sources/DispatcherStatusBar.swift" \
  -o "$MACOS_DIR/DispatcherStatusBar"

echo "$APP_DIR"
