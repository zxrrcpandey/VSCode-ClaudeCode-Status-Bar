#!/bin/bash
# Regenerates macos/AppIcon.icns (and icon/preview.png) from icon/make-icon.swift.
# The .icns is committed, so a normal build does not need to run this.
set -euo pipefail
cd "$(dirname "$0")"
WORK="$(mktemp -d)"
xcrun swiftc -sdk "$(xcrun --show-sdk-path)" -O icon/make-icon.swift -o "$WORK/make-icon"
"$WORK/make-icon" "$WORK/AppIcon.iconset" icon/preview.png
iconutil -c icns "$WORK/AppIcon.iconset" -o AppIcon.icns
rm -rf "$WORK"
echo "wrote macos/AppIcon.icns and macos/icon/preview.png"
