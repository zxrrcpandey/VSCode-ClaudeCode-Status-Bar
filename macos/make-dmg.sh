#!/bin/bash
# Builds ClaudePulse-<version>.dmg — the installer for other Macs.
#
# Drag Claude Pulse into Applications, open it, and it offers to connect itself
# to Claude Code. Runs on macOS 13+, Apple Silicon or Intel, with or without
# Node.js. The VS Code extension is inside the app and offered during setup.
set -euo pipefail

cd "$(dirname "$0")"
./build.sh
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' build/ClaudePulse.app/Contents/Info.plist)"
STAGE="build/dmg"
OUT="../ClaudePulse-$VERSION.dmg"

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R build/ClaudePulse.app "$STAGE/"
ln -s /Applications "$STAGE/Applications"

cat > "$STAGE/Read Me First.txt" <<TXT
Claude Pulse $VERSION
==================================

A menu bar indicator for Claude Code: what it is doing, its subagents and
their progress, token usage, and an optional desktop buddy. Everything stays
on your Mac.


INSTALL

1. Drag "ClaudePulse" onto the Applications folder.

2. Open ClaudePulse from Applications.

   This build is not notarized by Apple, so the first time macOS will say it
   cannot verify the developer. To allow it (once):

   - macOS 15 or later: try to open it, click Done, then open
     System Settings > Privacy & Security, scroll down and click
     "Open Anyway" next to ClaudePulse, and confirm.

   - macOS 13 or 14: Control-click ClaudePulse in Applications,
     choose Open, then click Open again.

   Or, in Terminal:
     xattr -dr com.apple.quarantine /Applications/ClaudePulse.app

3. When asked "Connect Claude Pulse to Claude Code?", choose Set Up.
   Your ~/.claude/settings.json is backed up first. If VS Code is installed
   you will also be offered the Claude Pulse VS Code extension.

4. Start a new Claude Code session - it appears in the menu bar.


REQUIREMENTS

macOS 13 Ventura or later - Apple Silicon or Intel - Claude Code.
Node.js is NOT required.


REMOVE

Menu bar icon > "Remove Claude Code Hooks...", then quit Claude Pulse and
move it to the Trash.
TXT

rm -f "$OUT"
hdiutil create -volname "Claude Pulse $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "built $(cd .. && pwd)/ClaudePulse-$VERSION.dmg"
