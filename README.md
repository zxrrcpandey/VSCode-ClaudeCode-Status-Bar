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
#    b) or package a .vsix:  npx @vscode/vsce package  → code --install-extension *.vsix

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

- **Nothing shows up** — the item hides when there are no live sessions. Start a Claude Code
  session and send a prompt. Also check `ls ~/.claude/claude-pulse/state/` for `*.json` files;
  if none appear, hooks aren't firing (run `/hooks` inside Claude Code to verify they loaded).
- **"Needs input" never shows (extension panel)** — there are open Claude Code bugs where the
  `Notification` hook doesn't fire in the VS Code panel. Claude Pulse also listens to
  `PermissionRequest` as a fallback, which covers permission prompts.
- **"Needs input" flips back to working while the dialog is still open** — Claude Code fires
  no event at the moment you approve a permission (the next event is only when the tool
  finishes), so Claude Pulse assumes an un-refreshed waiting state older than
  `claudePulse.waitingTimeoutSeconds` (default 25 s) means you already approved. If you often
  leave permission dialogs open for a long time, raise the setting, or set it to 0 to always
  keep the yellow state until an event clears it.
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
- `claudePulse.waitingTimeoutSeconds` — un-refreshed "needs input" older than this shows as
  working again, since approving a permission fires no event (default 25; 0 disables)
