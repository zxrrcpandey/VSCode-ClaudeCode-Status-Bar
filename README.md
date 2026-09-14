# Claude Pulse

A tiny VS Code status bar indicator that always tells you what Claude Code is doing:

| State | Looks like | When |
|---|---|---|
| Idle | `✳ Claude` | A session is open, nothing running |
| Working | `⟳ Claude · working 0:42` | You sent a prompt / Claude is using tools (live timer) |
| Task progress | `⟳ Claude · 3/7 ▰▰▰▱▱▱▱` | Claude is following its own checklist (real progress) |
| Needs input | `🔔 Claude · needs input` (yellow) | A permission prompt or question is waiting on you |
| Done | `✓ Claude · done 2:14` | Claude finished; shows total time, fades to idle |
| Error | `⚠ Claude · error` (red) | Response died (API error / connection lost); fades to idle |

**100% local, zero cost.** The hooks run a small local Node script; the extension watches a
state file. No API calls, no tokens, no network.

## macOS menu bar app

The same indicator, outside the editor: a native menu bar app (`macos/`) that reads the very
same state files, so it shows **every** Claude Code session on the Mac — including ones in
other windows, other editors, or a plain terminal.

### Install on any Mac

Download **`ClaudePulse-<version>.dmg`** from the
[releases page](https://github.com/zxrrcpandey/VSCode-ClaudeCode-Status-Bar/releases), drag
Claude Pulse into Applications, open it, and choose **Set Up** when it offers to connect to
Claude Code. That is the whole install:

- **No Node.js, Xcode or repo needed.** The app carries `pulse-hook`, a small runner built on
  JavaScriptCore (part of every Mac) that executes the very same hook, installer and
  usage-scanner scripts the VS Code extension runs under Node. Setup copies it to
  `~/.claude/claude-pulse/`, so the hooks keep working if the app is moved.
- **The VS Code extension is included** — setup offers it when VS Code is installed, and the
  menu has *Install VS Code Extension…*.
- **macOS 13 or later, Apple Silicon or Intel** (universal binaries).
- **A one-time "Open Anyway".** The build is ad-hoc signed, not notarized by Apple, so macOS
  blocks the first open: on macOS 15+ open *System Settings → Privacy & Security* and click
  *Open Anyway*; on 13–14 Control-click the app and choose *Open*. Or in Terminal:
  `xattr -dr com.apple.quarantine /Applications/ClaudePulse.app`.
- Scripted installs: `/Applications/ClaudePulse.app/Contents/MacOS/ClaudePulse --setup-hooks`
  (or `--remove-hooks`).

Build it yourself with `cd macos && ./make-dmg.sh` (the disk image), or
`./build.sh --install` for this Mac only.

- Menu bar: `⣾ 4:46 · 3⚙` while working (spinner, elapsed, running agents), `3/7 ▰▰▰▱▱▱▱`
  when Claude is following a checklist, an orange `🔔 needs input` when you are actually
  needed, `✓ 2:14` on completion, `⚠ error` when a response dies. `×N` means several
  sessions are busy.
- Drop-down: every session with its project, state, current tool and checklist, each running
  subagent (task, type, elapsed, tools), and token usage for today and the last 7 days.
  Click a session to open its folder.
- **Notifies you** when a session needs input — the point of a menu bar app is that you can
  be looking somewhere else. Toggle it in the menu, along with *Open at Login*.
- Native Swift, no Xcode project and no dependencies: `build.sh` compiles a universal
  binary with `swiftc` and assembles the `.app`. Same waiting-state rules as the extension
  (see `scripts/test-waiting.js`).

### Desktop Buddy — the character on your actual screen

What VS Code could not do: enable **Desktop Buddy** in the menu and the character leaves the
panel and roams your real desktop, above every other app. The screen edges are its world —
it walks along the bottom, climbs the sides, hangs from the top, and reacts to Claude exactly
as it does in the editor (pacing while working, flailing when you are needed, speech bubbles
when you click it).

- **One panel per screen**, and every minute or two the buddy **crosses** to the other one:
  it heads for the edge facing it and carries on from the opposite edge of the next screen
  at the same height — a bee flies off the right of one display and in from the left of the
  next. macOS defaults to *Displays have separate Spaces*, under which a single window
  cannot span two displays — it is pinned to one and clipped there, so a spanning window
  makes the buddy vanish on the other screen. Panels are rebuilt when a monitor is plugged
  in, unplugged or rearranged. Tune the hop with
  `defaults write com.warroom.claude-pulse buddyMigrateSeconds -float 30`.
- **Flyers use the whole height** of wherever they live — the bee, dragon and ghost roam
  from the floor to just under the top of the screen.
- **Size is a page zoom**, not a CSS zoom on the sprite: in WebKit, CSS `zoom` also scales
  the element's *position*, which sent a 1.6× bee off the right of the screen and left
  hearts, flowers and speech bubbles far from it. With page zoom everything scales together.
- **Clicks pass straight through** to whatever is underneath — the page reports where the
  character is and only that small rectangle is clickable, so the buddy can never swallow a
  click meant for another app.
- **Reach for it and it stops.** The character notices the cursor coming within ~130px and
  holds still so you can actually click it — it walks and climbs far too briskly to hit
  otherwise. Tune with `defaults write com.warroom.claude-pulse buddyNoticeRadius -float 200`.
- Menu: pick any of the nine characters or your own image, and a size (Small → Huge).
- It is the *same* `buddy.html` the VS Code panel uses — hosted in a transparent
  non-activating panel — so the art, animation and dialogue live in one place.

## Subagents

When Claude spawns subagents (the Agent tool, workflows, parallel reviewers), the indicator
shows **how many are running** — `⟳ Claude · working 4:46 · 3 agents` — and the tooltip /
session picker list each one with its **task description, type, elapsed time, tool count,
current tool**, and its own checklist progress if it keeps one. The data comes from hooks:
the `Agent` tool call carries the task description, and every tool event from inside a
subagent carries its `agent_id`. Parallel agents write state concurrently, so the hook uses
a lock file around each update. Set `touch ~/.claude/claude-pulse/debug` to log raw hook
payloads to `~/.claude/claude-pulse/events.log` when investigating.

## Token usage

Pulse also reports **exact token usage by model**, computed locally from Claude Code's own
transcript files (`~/.claude/projects/**/*.jsonl`) — still no API calls:

- The status bar appends the session's output tokens while Claude works (`· 84k`;
  disable via `claudePulse.showTokens`).
- Hover the item for a breakdown: this session, today, and the last 7 days, per model
  (input, output, cache).
- **Claude Pulse: Token Usage Report** (command palette, or click the item) opens the full
  report across all projects.
- The scan runs in a background process every 30 s with an incremental byte-offset cache,
  so it reads only newly appended transcript lines. Repeated message ids are deduplicated.
- Plan limit *remaining* (the 5-hour / weekly percentages) is not stored on disk by Claude
  Code — run `/usage` inside Claude Code for that.

## Buddy — a character that reacts to Claude

**View → Open View… → "Buddy"** (or run *Claude Pulse: Open Buddy*) adds a panel tab with a
little character that mirrors Claude's state: paces while Claude works, hops and rings when
Claude needs you, sleeps when idle, celebrates on done, goes dizzy on errors. **Click it and
it talks back** — real status, task progress, and token counts in speech bubbles.

Nine built-in characters with different bodies and personalities: 🐹 Critter, 🤖 Robot,
🐱 Cat (bipeds — climb walls, leap for the ceiling), 🐶 Pup and 🐢 Turtle (four legs; the
turtle is small and very slow), 🐌 Snail (tiny, slowest, slowly crawls walls and ceiling),
🐝 Bee (tiny, buzzing wings, zips around the whole panel), 🐉 Dragon (big, slow wingbeats,
glides everywhere), 👻 Ghost (floats). Each has its own ceiling-leap success rate.

**Use your own character:** run *Claude Pulse: Choose Buddy Character* and pick any image —
PNG, JPG, WebP, SVG, or an animated GIF (`claudePulse.buddyImage` holds the path). The
built-in critter is the fallback. VS Code has no floating-overlay surface, so the character
lives in its own panel (the same approach vscode-pets uses) — it cannot walk over the editor.

## How it works

1. Hook entries in `~/.claude/settings.json` run `~/.claude/claude-pulse/hook.js` on Claude Code
   lifecycle events (prompt submitted, tool use, permission request, stop, session end).
2. The script writes `~/.claude/claude-pulse/state/<session_id>.json` — current state, tool,
   todo progress, timestamps. One file per session, so multiple sessions work.
3. The extension watches that folder and renders the status bar item. Each VS Code window
   only shows sessions running inside its own workspace folders (set
   `claudePulse.allProjects: true` for a global view). Any session waiting on you takes
   priority. Click the item to list sessions / focus the terminal.

## Install

```sh
# Run the waiting-state regression suite (uses a throwaway HOME):
#   HOME=$(mktemp -d) node scripts/test-waiting.js

# 1. Wire up the hooks (backs up settings.json first; idempotent)
node scripts/install-hooks.js

# 2. Install the extension (pick one)
#    a) folder copy:
mkdir -p ~/.vscode/extensions/warroom.claude-pulse-0.1.0
cp package.json extension.js ~/.vscode/extensions/warroom.claude-pulse-0.1.0/
#    b) or build a .vsix (no vsce needed, works on Node 18):
#       node scripts/build-vsix.js && code --install-extension claude-pulse-*.vsix

# 3. Fully restart VS Code, then start a NEW Claude Code session
```

Hooks are read when a session starts — sessions already running won't report until restarted.

## Uninstall

```sh
node scripts/uninstall-hooks.js
rm -rf ~/.vscode/extensions/warroom.claude-pulse-0.1.0
```

Backups of `settings.json` are left next to it as `settings.json.claude-pulse-backup-*`.

## Troubleshooting

- **Shows idle "✳ Claude" but a session is running** — check
  `ls ~/.claude/claude-pulse/state/` for `*.json` files; if none appear, hooks aren't firing
  (run `/hooks` inside Claude Code to verify they loaded). Sessions are matched to a window
  by every directory they have reported, so a session whose shell `cd`s elsewhere stays
  attached to the workspace it started in.
- **"Needs input" never shows** — only *confirmed* prompts turn the indicator yellow: an
  unanswered dialog (Claude Code's `Notification` at ~6 s), a question (`AskUserQuestion`,
  `ExitPlanMode`), or an agent asking for input. A bare `PermissionRequest` is deliberately
  ignored, because Claude Code fires it for **auto-approved** calls too — in `acceptEdits`
  mode that is many times per minute, which used to pin the item yellow permanently. If your
  setup never fires the confirming `Notification`, set `claudePulse.provisionalWaitSeconds`
  to e.g. `8` to show unconfirmed permission requests after that many seconds.
- **"Needs input" flips back to working while the dialog is still open** — Claude Code fires
  no event at the moment you approve a permission (the next one comes only when the tool
  finishes), so a wait older than `claudePulse.waitingTimeoutSeconds` (default 45 s) is
  assumed answered — measured from the last confirmation, and re-armed if Claude Code repeats
  it. Questions (`AskUserQuestion`, `ExitPlanMode`) and agent prompts are never aged out. Set
  it to 0 to keep the yellow state until an event clears it.
- **"Needs input" stuck on while Claude is clearly working** — fixed in 0.10.1: subagent
  permission events no longer mark the *main* session as waiting, and a wait is now aged from
  when it started rather than from the last event of any kind (parallel agents kept refreshing
  it). If you still see it, run **Claude Pulse: Reset Session States**.
- **Indicator disappears in narrow windows** — VS Code hides status bar items from the
  middle of the bar when space runs out; the far edges survive. Claude Pulse therefore sits
  at the far-right edge by default (`claudePulse.priority: -900`). If another extension
  crowds it out, lower the priority further, or move it with `claudePulse.alignment`.
- **Clicking items in the menu bar dropdown does nothing (e.g. picking a character)** — fixed
  in 0.13.0. The dropdown was being torn down and rebuilt four times a second while open to
  keep its timers live, which destroyed the *Buddy Character* submenu (and whatever item was
  under the cursor) before a click could register. It is now built once when opened and only
  the text of existing rows (timers, agents, token counts) is refreshed in place.
- **The desktop buddy hangs motionless at a screen edge after switching screens** — fixed in
  0.13.0: the hand-off now goes through `enterAt()` inside `buddy.html`, which resets the
  whole motion state, and crossings only start once the character is already near the facing
  edge (walkers dash for it), so there is no long march ending in a mid-screen jump.
- **I cannot click the desktop buddy** — fixed in 0.12.3, and it had two causes: the
  character moved out from under the cursor before the click landed (it now stops when your
  cursor comes near), and macOS was spending the click activating the window instead of
  delivering it, because Claude Pulse is an accessory app that is never the active app — the
  view now accepts that first click. `defaults write com.warroom.claude-pulse buddyDebug  -bool true` traces hover and clicks to ~/.claude/claude-pulse/buddy-debug.log.
- **The desktop buddy blocks my clicks** — fixed in 0.12.1. A window only lets clicks reach
  the app underneath when it ignores mouse events outright; returning nil from a hit test is
  not enough. The panel is now click-through by default and becomes clickable only while the
  cursor is over the character.
- **The desktop buddy vanishes on my second screen** — fixed in 0.12.2. With *Displays have
  separate Spaces* on (the macOS default) a window cannot span displays, so the old
  single wide window only ever rendered on one of them. Each screen now has its own panel.
- **The desktop buddy vanished** — fixed in 0.12.1: the web content process can be killed
  under memory pressure, leaving the window up but empty. The buddy now reloads itself when
  that happens, and a watchdog revives it if the page stops reporting its position for 5 s.
- **Stale ghost sessions** — busy sessions with no events for a long time are dropped
  automatically (60 min working; anything untouched for 4 h is deleted). To force-clear a
  stuck indicator, run **Claude Pulse: Reset Session States** from the command palette (or
  click the item → "Reset all session states").

## Settings

- `claudePulse.allProjects` — show sessions from every project in every window (default off:
  each window shows only its own workspace's sessions)
- `claudePulse.alignment` / `claudePulse.priority` — where the indicator sits (default:
  right side, far edge, so narrow windows don't hide it)
- `claudePulse.doneDisplaySeconds` — how long the ✓ stays before fading to idle (default 15)
- `claudePulse.showElapsed` — show the live timer while working (default on)
- `claudePulse.waitingTimeoutSeconds` — a confirmed *permission* prompt reverts to working
  this long after the last confirmation, since approving fires no event (default 45; repeat
  notifications re-arm it; questions and agent prompts are never aged out; 0 disables)
- `claudePulse.provisionalWaitSeconds` — show *unconfirmed* permission requests as "needs
  input" after this many seconds (default 0 = never; see troubleshooting)
