#!/bin/bash
# Builds ClaudePulse.app — a native menu bar app, no Xcode project, no
# dependencies. Requires only the Command Line Tools (swiftc).
#
#   ./build.sh            → macos/build/ClaudePulse.app
#   ./build.sh --install  → also copies it to /Applications and launches it
set -euo pipefail

cd "$(dirname "$0")"
VERSION="$(node -p "require('../package.json').version" 2>/dev/null || echo 0.1.0)"
APP="build/ClaudePulse.app"
MIN_MACOS=13.0

rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Universal binary when the SDK can produce one, otherwise native arch only.
compile() { swiftc -O -parse-as-library -target "$1-apple-macos$MIN_MACOS" -o "$2" ClaudePulse.swift; }
if compile arm64 build/pulse-arm64 2>/dev/null && compile x86_64 build/pulse-x86_64 2>/dev/null; then
  lipo -create build/pulse-arm64 build/pulse-x86_64 -output "$APP/Contents/MacOS/ClaudePulse"
  echo "built universal (arm64 + x86_64)"
else
  compile "$(uname -m)" "$APP/Contents/MacOS/ClaudePulse"
  echo "built $(uname -m) only"
fi
rm -f build/pulse-arm64 build/pulse-x86_64

# Token usage reuses the same scanner the VS Code extension runs.
cp ../usage-scan.js "$APP/Contents/Resources/usage-scan.js"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude Pulse</string>
  <key>CFBundleDisplayName</key><string>Claude Pulse</string>
  <key>CFBundleIdentifier</key><string>com.warroom.claude-pulse</string>
  <key>CFBundleExecutable</key><string>ClaudePulse</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT</string>
</dict>
</plist>
PLIST

# Ad-hoc signature: keeps Gatekeeper and the notification centre happy for a
# locally built app. (A distributed build would use a Developer ID instead.)
codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1 || echo "note: ad-hoc signing skipped"

echo "built $APP (version $VERSION)"

if [ "${1:-}" = "--install" ]; then
  pkill -x ClaudePulse 2>/dev/null || true
  rm -rf /Applications/ClaudePulse.app
  cp -R "$APP" /Applications/ClaudePulse.app
  open /Applications/ClaudePulse.app
  echo "installed to /Applications and launched — look at your menu bar"
fi
