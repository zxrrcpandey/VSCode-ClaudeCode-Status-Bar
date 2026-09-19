#!/bin/bash
# Builds ClaudePulse.app — a native menu bar app, no Xcode project, no
# dependencies. Requires only the Command Line Tools (swiftc).
#
#   ./build.sh            → macos/build/ClaudePulse.app
#   ./build.sh --install  → also copies it to /Applications and launches it
#   ./make-dmg.sh         → a drag-to-install disk image for other Macs
set -euo pipefail

cd "$(dirname "$0")"
VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' ../package.json | head -1)"
VERSION="${VERSION:-0.1.0}"
APP="build/ClaudePulse.app"
MIN_MACOS=13.0
# Apple's compiler, run through xcrun and pointed at Apple's SDK explicitly.
# Another Swift toolchain on PATH (swiftly, a swift.org download) breaks the
# build two ways: its own swiftc can lag a Command Line Tools update ("unknown
# argument: -target-arch-variant" from the new SDK's interfaces), and its shims
# for clang & co. hijack SDK discovery even for Apple's swiftc ("unable to load
# standard library", duplicate SwiftBridging module). xcrun + -sdk avoids both.
SWIFT=(xcrun swiftc)
SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"
if [ -n "$SDK" ]; then SWIFT+=(-sdk "$SDK"); fi

rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Universal (arm64 + x86_64) when the SDK can produce it, so one download runs
# on Apple Silicon and Intel Macs alike.
universal() {   # universal <output> <sources...>
  local out="$1"; shift
  if "${SWIFT[@]}" -O -parse-as-library -target "arm64-apple-macos$MIN_MACOS" -o "$out.arm64" "$@" 2>/dev/null &&
     "${SWIFT[@]}" -O -parse-as-library -target "x86_64-apple-macos$MIN_MACOS" -o "$out.x86_64" "$@" 2>/dev/null; then
    lipo -create "$out.arm64" "$out.x86_64" -output "$out"
    rm -f "$out.arm64" "$out.x86_64"
    echo "built $(basename "$out"): universal (arm64 + x86_64)"
  else
    rm -f "$out.arm64" "$out.x86_64"
    "${SWIFT[@]}" -O -parse-as-library -target "$(uname -m)-apple-macos$MIN_MACOS" -o "$out" "$@"
    echo "built $(basename "$out"): $(uname -m) only"
  fi
}

universal "$APP/Contents/MacOS/ClaudePulse" ClaudePulse.swift DesktopBuddy.swift Setup.swift
# pulse-hook runs the hook, installers and usage scanner on JavaScriptCore, so
# the Mac this is installed on does not need Node.js.
universal "$APP/Contents/MacOS/pulse-hook" PulseHook.swift

R="$APP/Contents/Resources"
# The same scripts and character page the VS Code extension uses.
cp ../usage-scan.js ../buddy.html ../hooks/hook.js ../scripts/install-hooks.js ../scripts/uninstall-hooks.js "$R/"
# The VS Code extension rides along, so one download sets up both.
VSIX="../claude-pulse-$VERSION.vsix"
if [ ! -f "$VSIX" ] && command -v node >/dev/null 2>&1; then (cd .. && node scripts/build-vsix.js >/dev/null); fi
if [ -f "$VSIX" ]; then cp "$VSIX" "$R/"; else echo "note: $VSIX not found — VS Code extension not bundled"; fi
# The bee app icon (regenerate with ./make-icon.sh).
if [ -f AppIcon.icns ]; then cp AppIcon.icns "$R/AppIcon.icns"; fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude Pulse</string>
  <key>CFBundleDisplayName</key><string>Claude Pulse</string>
  <key>CFBundleIdentifier</key><string>com.warroom.claude-pulse</string>
  <key>CFBundleExecutable</key><string>ClaudePulse</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT</string>
</dict>
</plist>
PLIST

# Ad-hoc signatures (nested helper first, then the bundle). A notarized build
# would use a Developer ID instead; without one, other Macs need a one-time
# "Open Anyway" — see make-dmg.sh.
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/pulse-hook" >/dev/null 2>&1 || true
codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1 || echo "note: ad-hoc signing skipped"

echo "built $APP (version $VERSION)"

if [ "${1:-}" = "--install" ]; then
  pkill -x ClaudePulse 2>/dev/null || true
  rm -rf /Applications/ClaudePulse.app
  cp -R "$APP" /Applications/ClaudePulse.app
  open /Applications/ClaudePulse.app
  echo "installed to /Applications and launched — look at your menu bar"
fi
