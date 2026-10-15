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

**Local, and zero cost.** The hooks run a small local Node script; the extension watches a
state file. No API calls, no tokens. Pulse itself never touches the network — the one
exception is [keeping the usage reading fresh](#keeping-the-reading-fresh), where it has your
own Claude Code run `/usage`, and that can be switched off.

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
  subagent (task, type, elapsed, tools), how much of your plan is left and how fast it is
  going, and token usage for today and the last 7 days. Click a session to open its folder.
- **Notifies you** when a session needs input — the point of a menu bar app is that you can
  be looking somewhere else — and warns you before a usage limit stops you.
- **Starts with your Mac.** It offers this the first time it is set up, and the menu's
  *Open at Login* turns it on or off afterwards. It registers properly in System Settings ›
  General › Login Items; if macOS refuses that for an unsigned build, it falls back to a
  LaunchAgent in your own home folder. Only ever one of the two, so you never get two icons.
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
- **In the way? Pick it up.** Drag the character anywhere, including onto the other screen,
  and it stays there for ten minutes before it roams again. A flyer hovers where you let go;
  a walker let go in mid-air drops to the floor first. It does not cross to the other screen
  while it is staying put. A click without a drag still makes it talk. Change the stay with
  `defaults write com.warroom.claude-pulse buddyStaySeconds -float 1800`.
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
## Usage limits — knowing before you run out

Claude Code asks the server how much of your plan is left and caches the answer in
`~/.claude.json` (`cachedUsageUtilization`). Pulse reads that cache — it never writes to it —
so it can show the real percentages: the 5-hour window, the week, and any per-model window,
each with the time it refills.

**That cache is not a live meter, and this is the single most important thing to know about
it.** Claude Code decides when to refresh it on a sampled schedule — the feature flag
`tengu_agile_glade.policy_limits_poll` was `0.01` on the machine this was built on — so
readings **35 hours old** are ordinary, not exceptional. A reading that old can be flatly
wrong: one said the week was 8% used, and `claude.ai/settings/usage` disagreed with its own
breakdown at the same moment.

So Pulse does not show a figure it cannot stand behind:

- If the window has **rolled over** since the reading, the percentage describes a window that
  no longer exists. Pulse rolls the window forward to the current one and withholds it.
- If the reading is simply **too old** — more than a tenth of the window's own length, so 30
  minutes for the 5-hour window and about 17 hours for the week — it is history, not status.
  Pulse says *"last checked 35h ago — run `/usage` in Claude Code to refresh"* instead of
  printing the number. Running `/usage` is what fetches a fresh one.
- Otherwise it shows the number, and says which kind of number it is.

### Keeping the reading fresh

Withholding a stale number is honest, but it is not much of a warning system. So Pulse also
gets a new one. Once the reading is more than twenty minutes old **and** tokens have been
spent since it was taken, it runs `claude -p /usage` in the background, which makes Claude
Code fetch the figures exactly as typing `/usage` does. Claude Code answers that command by
itself: nothing is sent to a model, and it costs no tokens. On the machine this was built on
the cached reading had said 8% of the week for two days; the first check said 24%.

This is the one thing Pulse does that reaches the network, and it is your own Claude Code
doing the reaching, with your own login. What it is careful about:

- **It does not behave like you opening Claude Code.** No transcript is kept, no MCP servers
  are started and none of your hooks run, and it is started in an empty temporary folder so
  there is no project to pick settings or instructions up from.
- **An account nobody is using is not polled.** With nothing spent since the last reading
  there is nothing new to ask about. API-key installs, which have no plan limits, are never
  asked.
- **A check that goes unanswered is not repeated every minute.** Signed out, offline, or a
  Claude Code too old to answer without a terminal (2.1.69 replies *Unknown skill: usage*):
  Pulse waits two hours, and the menu says the last check went unanswered.
- **It asks the newest Claude Code it can find** — usually the one inside the VS Code
  extension, which is far ahead of a `claude` on the PATH that was installed once and
  forgotten.

*Usage Warnings › Keep the usage figures up to date* switches it off, and *Check Usage Now*
does it on demand; in VS Code those are `claudePulse.keepUsageFresh` and **Claude Pulse: Check
Usage Now**. Where the macOS app is running it does the checking and the extension stands
back, so the two never both ask. From a terminal: `ClaudePulse --check-usage`.

To stretch a good reading further, Pulse keeps a small local ledger of what the transcripts
say you have spent, per minute, and pairs two cached readings with the tokens spent between
them to learn what one percent costs. From then on it carries the figure forward and can say
*"about 4.2% an hour, so it runs out around 6:20 pm — and it does not refill until 9 pm."*
A carried-forward figure is always marked with a `~` and names the reading it came from.

It is deliberately slow to claim that. A pair is only used when the ledger covers every byte
written during the interval, when there was enough local spend to account for the step, and
when the step came from the same plan tier; a per-model window is measured against that
model's own spend. Three such pairs are needed before any of it is shown, because a median of
one is not a median. Until then you get the cached number labelled *last checked*, or nothing
at all — never a guess wearing the clothes of a measurement.

- **The menu bar / status bar** carries a small badge once a window is worth watching
  (`wk 62%`), amber then red as it gets worse. It stays visible when no session is running —
  that is exactly the moment before you start the next one.
- **A large banner on every screen** when it actually matters. It only interrupts when this
  pace would empty the window *before* it refills, or when you are nearly out outright: 80%
  with a reset twenty minutes away is not worth a warning, and crying wolf is how a warning
  gets switched off. Snooze it, or turn it off under *Usage Warnings*. If it covers something
  you need, drag it anywhere on its screen (by any part except a button); that screen's next
  banner comes up in the same place. Double-click it to send it back to the top.
- **Being blocked** is reported from the transcript's own 429 record, which names the window
  that ran out and when it frees up. Hitting the 5-hour window is not the same as running out
  for the week, and the message says so.
- **A /compact nudge** when a conversation has grown expensive — see below.
- ***Show Usage in Claude Code*** (menu, or the matching command in VS Code) adds a status
  line under the Claude Code prompt: `5h 62% · wk 41% · ctx 420k — /compact`. It is terminal
  chrome, not conversation, so it costs no tokens, and it is where you are actually looking
  when you run out. `~/.claude/settings.json` is backed up first, and an existing status line
  of your own is never replaced.

### Why a long conversation is the expensive part

Everything in a conversation is re-read on every single turn. Measured on one real machine
over seven days: 1.70 **billion** cache-read tokens against 7.3 million of output — 88% of
the spend was carrying context, not producing work. The median turn re-read 374k tokens, and
sessions rode to ~977k before auto-compact caught them.

So Pulse measures each live session's context from the transcript, works out how much of a
turn goes on re-reading it, and says so once it passes `contextWarnTokens` (300k by default)
with more than half of each reply going on context. `/compact` keeps a summary and drops the
rest; the next replies cost a fraction. Two other levers show up in the same place: the model
(Opus costs multiples of Sonnet for the same tokens) and the effort level (Claude Code's own
catalog warns that Max "can consume 3.5× or more usage than Medium").

### Making Claude Code compact by itself

A nudge only works if you act on it. Claude Code already compacts automatically — but only
when the model's window is full, and on a 1M-context model that means about a million tokens:
ask it (`claude -p /autocompact`) and it answers *"1m tokens (default for this model)"*. On the
machine this was measured on, the one automatic compaction in a week fired at 966k.

Claude Code has a setting that moves that point, `autoCompactWindow`, and
***Compact Chats Automatically*** in the menu (or *Claude Pulse: Compact Conversations
Automatically* in VS Code) sets it for you:

- **At 250k — recommended.** Replaying a real week of transcripts with it, the main
  conversations cost 46% less for the same work, and the whole week 26% less. It compacts about
  twice as often, so Claude forgets detail sooner and may re-read a file now and then.
- **At 400k** — compacts less often, saves less (37% and 20% on the same week).
- **Claude Code's default** — puts it back.

It is Claude Code's own setting, so nothing of Pulse's runs when it fires and it keeps working
with the app closed. Whatever is in force is the row that carries the tick, including a size
you chose yourself with `/autocompact` inside Claude Code. Three things Claude Code does with
it, checked against 2.1.296, that the script takes care of:

- A model's own entry beats the top-level setting, and that is where `/autocompact` saves. One
  left at `auto`, or at a larger number, would quietly exempt that model — so those are taken
  out, and remembered so that going back to the default restores them. An entry that compacts
  *earlier* is left alone.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` beats everything. With that set in `settings.json`, the
  menu says so instead of offering a switch that would do nothing.
- A value outside 100k–1M is silently ignored by Claude Code, so it is refused here.

`~/.claude/settings.json` is backed up first. Conversations already open pick the change up
when they are next started. For scripted installs: `ClaudePulse --autocompact 250000`, or
`--autocompact default`; without the app, `node scripts/set-autocompact.js [--tokens N | --remove]`.

### Before an idle chat gets expensive

Claude keeps a conversation ready to be re-read cheaply for a while after each reply — an hour
on a plan; the transcript records which, so Pulse reads it rather than assuming. Come back
after that and your next message has to write the whole conversation into the cache again
instead of re-reading it. A cached read is priced at a tenth of an input token and a cache
write at 1.25 to 2 times one, so that single message costs well over ten times what the one
before it did. Measured over the same week, 29 returns to a conversation left for more than
an hour cost **11% of the week** between them, each one as much as eleven ordinary replies —
and that is counting the write at the lower price.

The only cheap moment to avoid it is before you leave, so that is when Pulse speaks. About
fifteen minutes before a large, idle conversation goes cold, a banner says *"Stepping away?
Compact before 3:42 PM"* — with the size, what the reload will cost next to that chat's recent
replies, and a button that copies `/compact`. It is deliberately narrow:

- Only when the next move is yours: the turn has finished, or Claude is waiting on an answer
  (then the advice is to answer in time). A session still working is left alone.
- Only with someone at the Mac — or looking at that VS Code window — because nobody else can
  act on it. It is taken down the moment the deadline passes or the chat is picked up again,
  rather than left there contradicting the screen.
- Once per pause, never for the five-minute cache, and not for a chat you have said *Not this
  chat* about.

After a conversation has gone cold the advice changes, because compacting it would have to
load it first. The menu and the tooltip then say so — *"gone cold at 3:42 PM — the next
message reloads all of it. Done with it? Start a new chat."*

## Buddy — a character that reacts to Claude

**View → Open View… → "Buddy"** (or run *Claude Pulse: Open Buddy*) adds a panel tab with a
little character that mirrors Claude's state: paces while Claude works, hops and rings when
Claude needs you, sleeps when idle, celebrates on done, goes dizzy on errors. **Click it and
it talks back** — real status, task progress, and token counts in speech bubbles.

Nine built-in characters with different bodies and personalities, each drawn with shading,
fur or scales, and eyes that blink, close for a nap and squeeze shut on an error:
🐾 Red panda (the default, `critter` in settings) and 🤖 Robot (two legs — climb walls, leap
for the ceiling), 🐱 Cat, 🐶 Pup and 🐢 Tortoise (four legs; the tortoise is small and very
slow), 🐌 Snail (tiny, slowest, slowly crawls walls and ceiling), 🐝 Bee (a honeybee, zips
around the whole panel), 🐉 Dragon (big, slow wingbeats, glides everywhere), 👻 Ghost
(floats). Each has its own ceiling-leap success rate.

**Use your own character:** run *Claude Pulse: Choose Buddy Character* and pick any image —
PNG, JPG, WebP, SVG, or an animated GIF (`claudePulse.buddyImage` holds the path). The
built-in red panda is the fallback. VS Code has no floating-overlay surface, so the character
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
# Run the regression suites (each builds its own throwaway HOME):
#   node scripts/test-waiting.js                       # the waiting-state rules
#   node scripts/test-limits.js                        # the usage-limit maths
#   node scripts/test-autocompact.js                   # what the auto-compact script leaves alone
# …and the same two suites through the runtime the macOS app uses:
#   PULSE_LIMITS_BIN=/Applications/ClaudePulse.app/Contents/MacOS/pulse-hook \
#     node scripts/test-limits.js
#   PULSE_LIMITS_BIN=/Applications/ClaudePulse.app/Contents/MacOS/pulse-hook \
#     node scripts/test-autocompact.js

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

That removes the hooks, the Claude Code status line if you added one, `~/.claude/claude-pulse/`
and the start-at-login agent. The macOS app's *Remove Claude Code Hooks…* does the same and
also clears its login item, so dragging `ClaudePulse.app` to the Trash afterwards leaves
nothing behind. If you only ever used the app and deleted it without that step, the one file
worth removing by hand is `~/Library/LaunchAgents/com.warroom.claude-pulse.plist`.

Backups of `settings.json` are left next to it as `settings.json.claude-pulse-backup-*`
(the newest five are kept; older ones are pruned).

One thing is left in place on purpose: an auto-compact size you chose. `autoCompactWindow` is
Claude Code's own setting and works without Claude Pulse, so uninstalling does not undo it.
Choose *Claude Code's Default* first if you want it gone, or delete that line from
`~/.claude/settings.json`.

## Troubleshooting

What each symptom turned out to be. The reasoning behind the fixes, and every bug by version,
is in [LESSONS.md](LESSONS.md).

### The indicator

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
- **Stale ghost sessions** — busy sessions with no events for a long time are dropped
  automatically (60 min working; anything untouched for 4 h is deleted). To force-clear a
  stuck indicator, run **Claude Pulse: Reset Session States** from the command palette (or
  click the item → "Reset all session states").
- **Sessions named "p" that you never started, some stuck on "needs input"** — left behind by
  `scripts/test-waiting.js` run without a throwaway `HOME`. It used to rely on being given
  one, which is easy to forget; run plainly it emptied the real state folder and wrote its
  nine test sessions there. *Reset Session States* clears them. Since 0.16.0 the suite makes
  its own `HOME` and deletes it, so it cannot touch yours.
- **After installing an update, VS Code behaves like the old version** — every window keeps
  the extension build it loaded until that window is reloaded (*Developer: Reload Window*).
  This matters more than it sounds: an old build in a VS Code window and a new menu bar app
  once each rewrote the shared usage history in their own format, wiping the other's, so the
  pace Pulse had learnt kept being thrown away. Reload every window after an update.

### Usage figures and warnings

- **The usage line says "last checked 2d ago", or there is no percentage at all** — that is
  the age of Claude Code's own saved reading, not Pulse failing to read it. Claude Code
  refreshes it rarely, and since 0.15.0 Pulse will not print a figure that old. Since 0.16.0
  it asks for a new one itself ([Keeping the reading fresh](#keeping-the-reading-fresh)). If
  the line still does not move, *Usage Warnings › Check Usage Now*, or
  `ClaudePulse --check-usage` in a terminal, tells you what Claude Code answered.
- **"Claude Code did not answer the last check", or *Unknown skill: usage*** — the Claude
  Code that Pulse found cannot answer `/usage` without a terminal: 2.1.69 replies *Unknown
  skill: usage*, 2.1.296 answers properly. Update Claude Code, or install its VS Code
  extension — Pulse uses the newest copy on the machine, and the one inside the extension
  usually is. Being signed out or offline looks the same. Pulse tries again after two hours,
  not every minute.
- **Pulse and `claude.ai/settings/usage` disagree** — two different things get mistaken for
  one. The list under *This week's usage by product* is how your usage **divides up** and
  adds to 100%: "Claude Code 96%" means 96% of what you used went through Claude Code, not
  that 96% of the limit is gone. Pulse prints that list as *where this week's usage went*
  for exactly that reason. The limit itself is the bar above it. If those two differ, look
  at the age of the reading: a figure with a `~` has been carried forward from the reading
  it names.
- **The menu shows a high percentage but no banner ever came** — intended. The banner only
  interrupts when the current pace would empty the window before it refills, or when you are
  nearly out outright; a reading too old to trust raises nothing at all; and *Quiet for
  4 Hours* silences everything. *Usage Warnings › Show Me What It Looks Like* puts one up so
  you can see it works.
- **"Stepping away?" never shows** — it needs all of these at once: a chat of 200k tokens
  or more (`awayWarnTokens`), the next move being yours, the one-hour cache (with the
  five-minute one the deadline has passed before anyone could act), and somebody actually
  there — a key or the mouse touched in the last four minutes on the Mac, or that VS Code
  window in focus. Walk away first and there is nobody to tell, which is the case
  [automatic compacting](#making-claude-code-compact-by-itself) exists for. *Show Me the
  Idle-Chat Reminder* previews it.
- **Compact Chats Automatically seems to do nothing** — ask Claude Code what is in force:
  `claude -p /autocompact` answers with the size and where it came from, e.g. *250k tokens
  (from settings)*. If that is not the size you chose, something else is winning: an
  environment variable (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which Pulse reports instead of
  offering a switch), or a stricter size you gave that model with `/autocompact`. A chat
  that was already open picks the new size up when it is next started.
- **A banner covers what I am working on** — drag it out of the way; it stays on the screen
  it is on, and the next one on that screen appears where you left this one. Each screen
  remembers its own place. Double-click a banner to put it back at the top. Since 0.16.1;
  before that it could be dragged, but nothing showed it, and every banner started at the top.

### The macOS app and its desktop buddy

- **The desktop buddy keeps covering what I am working on** — drag it somewhere else, or onto
  the other screen (since 0.17.0). It stays where you put it for ten minutes
  (`buddyStaySeconds`). For less of it all the time, pick a smaller size under *Buddy Size*,
  or switch *Desktop Buddy* off.
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
- `claudePulse.showLimits` — show how much of your plan is left (default on)
- `claudePulse.limitWarnWeekly` / `claudePulse.limitWarnSession` — the percentages that turn
  the indicator amber (defaults 75 and 88)
- `claudePulse.contextWarnTokens` — flag a conversation once it carries this much context
  (default 300000)
- `claudePulse.buddyUsageRemarks` — let the desktop character mention a limit out loud
  (default on). Separate from `showLimits`, so you can keep the quiet badge without the
  commentary.
- `claudePulse.awayReminder` — say so about fifteen minutes before a large, idle conversation
  stops being cheap to come back to (default on)
- `claudePulse.awayWarnTokens` — how large it has to be for that (default 200000)
- `claudePulse.keepUsageFresh` — have Claude Code fetch a new usage reading once the one it
  holds has aged out (default on; costs no tokens)

The macOS app reads the same things from its own domain, so `defaults write` tunes it
without a restart:

```bash
defaults write com.warroom.claude-pulse limitWarnWeekly -int 60
defaults write com.warroom.claude-pulse contextWarnTokens -int 250000
defaults write com.warroom.claude-pulse limitAlerts -bool false   # no banners
defaults write com.warroom.claude-pulse contextNudge -bool false  # no /compact nudge
defaults write com.warroom.claude-pulse awayNudge -bool false     # no idle-chat reminder
defaults write com.warroom.claude-pulse awayWarnTokens -int 150000
defaults write com.warroom.claude-pulse usageAutoCheck -bool false  # never ask Claude Code for a reading
```

## Lessons

Everything that went wrong while building this, what caused it and what fixed it — every bug
by version, and what Claude Code, VS Code and macOS turned out to do that nobody would guess —
is in [LESSONS.md](LESSONS.md).
