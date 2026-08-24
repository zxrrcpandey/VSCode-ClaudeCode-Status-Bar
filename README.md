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
  finishes), so a wait older than `claudePulse.waitingTimeoutSeconds` (default 180 s) is
  assumed answered. Set it to 0 to keep the yellow state until an event clears it.
- **"Needs input" stuck on while Claude is clearly working** — fixed in 0.10.1: subagent
  permission events no longer mark the *main* session as waiting, and a wait is now aged from
  when it started rather than from the last event of any kind (parallel agents kept refreshing
  it). If you still see it, run **Claude Pulse: Reset Session States**.
- **Indicator disappears in narrow windows** — VS Code hides status bar items from the
  middle of the bar when space runs out; the far edges survive. Claude Pulse therefore sits
  at the far-right edge by default (`claudePulse.priority: -900`). If another extension
  crowds it out, lower the priority further, or move it with `claudePulse.alignment`.
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
- `claudePulse.waitingTimeoutSeconds` — a "needs input" older than this shows as working
  again, since approving a permission fires no event (default 180; 0 disables)
- `claudePulse.provisionalWaitSeconds` — show *unconfirmed* permission requests as "needs
  input" after this many seconds (default 0 = never; see troubleshooting)
