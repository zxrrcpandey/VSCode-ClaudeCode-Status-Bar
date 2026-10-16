<p align="center">
  <img src="https://raw.githubusercontent.com/zxrrcpandey/VSCode-ClaudeCode-Status-Bar/main/media/icon.png" width="96" alt="">
</p>

<h1 align="center">Claude Pulse</h1>

<p align="center">
  Know what Claude Code is doing, and how much of your plan is left, without going to look.
</p>

<p align="center">
  <a href="https://github.com/zxrrcpandey/VSCode-ClaudeCode-Status-Bar/releases"><img src="https://img.shields.io/github/v/release/zxrrcpandey/VSCode-ClaudeCode-Status-Bar" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-black?logo=apple" alt="macOS 13 or later">
  <img src="https://img.shields.io/badge/VS%20Code-1.74%2B-007ACC?logo=visualstudiocode" alt="VS Code 1.74 or later">
  <img src="https://img.shields.io/badge/dependencies-none-brightgreen" alt="No dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/zxrrcpandey/VSCode-ClaudeCode-Status-Bar" alt="MIT licence"></a>
</p>

Claude Pulse watches every Claude Code session on your machine and shows its state where you
already look: the **VS Code status bar** and the **macOS menu bar**. It also counts your tokens,
reads how much of your 5-hour and weekly limits is left, warns you before you run out, and
gives you a small **animated character** that reacts to Claude — in a VS Code panel, or walking,
climbing and flying across your real desktop on every monitor.

It runs on Claude Code's own hooks and files. No API calls, no tokens, no account of its own.

<p align="center">
  <img src="https://raw.githubusercontent.com/zxrrcpandey/VSCode-ClaudeCode-Status-Bar/main/docs/images/characters.png" alt="The nine built-in characters: red panda, robot, cat, pup, tortoise, snail, bee, dragon and ghost">
</p>

**Contents**

- [What it does](#what-it-does)
- [Install](#install)
- [The status indicator](#the-status-indicator) · [Subagents](#subagents)
- [The macOS menu bar app](#the-macos-menu-bar-app)
- [Token usage](#token-usage)
- [Usage limits — knowing before you run out](#usage-limits--knowing-before-you-run-out)
- [The buddy](#the-buddy) · [Desktop Buddy](#desktop-buddy--the-character-on-your-actual-screen)
- [Multiple monitors](#multiple-monitors)
- [How it works](#how-it-works) · [Tech stack](#tech-stack) · [Project layout](#project-layout)
- [Building and testing](#building-and-testing)
- [Settings and commands](#settings-and-commands)
- [Privacy](#privacy) · [Uninstall](#uninstall) · [Troubleshooting](#troubleshooting)
- [Lessons](#lessons) · [Licence](#licence)

## What it does

- **Every session's state at a glance** — working with a live timer, progress through
  Claude's own task list, needs your input, done, or failed. Each VS Code window shows the
  sessions in its own folders; the menu bar shows every session on the Mac, including ones
  in a plain terminal. → [The status indicator](#the-status-indicator)
- **Subagents** — how many are running, and for each one its task, type, elapsed time and
  current tool. → [Subagents](#subagents)
- **A notification when Claude needs you** (macOS app), so you can be looking somewhere
  else. → [The macOS menu bar app](#the-macos-menu-bar-app)
- **Exact token usage per model** — this session, today and the last 7 days, computed from
  Claude Code's own transcripts. → [Token usage](#token-usage)
- **Your plan limits before you hit them** — the 5-hour and weekly windows, the pace you are
  using them at, when they refill, and a warning on every screen only when this pace would run
  you out first. → [Usage limits](#usage-limits--knowing-before-you-run-out)
- **Cheaper conversations** — a `/compact` nudge when a chat has grown expensive, a one-click
  switch for Claude Code's own auto-compact point, and a reminder before an idle chat goes
  cold. → [Why a long conversation is the expensive part](#why-a-long-conversation-is-the-expensive-part)
- **A buddy** — nine hand-drawn animated characters, or your own image, that pace while
  Claude works, ring when you are needed and celebrate when it is done. Click one and it
  tells you the status. → [The buddy](#the-buddy)
- **On your real desktop, across every monitor** (macOS app) — the buddy can leave VS Code
  and roam all your screens above every app, crossing from one display to the next; clicks
  pass straight through it. → [Multiple monitors](#multiple-monitors)
- **Local** — hooks write small files; the extension and the app read them. The one thing
  that reaches the network is your own Claude Code fetching a usage reading, and that can be
  switched off. → [Privacy](#privacy)

## Install

### On a Mac — the app, with the VS Code extension included

1. Download **`ClaudePulse-<version>.dmg`** from the
   [releases page](https://github.com/zxrrcpandey/VSCode-ClaudeCode-Status-Bar/releases).
2. Drag **Claude Pulse** into Applications and open it.
3. Choose **Set Up** when it offers to connect to Claude Code. It also offers the VS Code
   extension when VS Code is installed, and to start with your Mac.
4. Start a **new** Claude Code session. Hooks are read when a session starts, so sessions
   already running will not report until they are restarted.

That is the whole install:

- **No Node.js, Xcode or repo needed.** The app carries `pulse-hook`, a small runner built on
  JavaScriptCore (part of every Mac) that executes the very same hook, installer and
  usage-scanner scripts the VS Code extension runs under Node. Setup copies it to
  `~/.claude/claude-pulse/`, so the hooks keep working if the app is moved.
- **macOS 13 or later, Apple Silicon or Intel** (universal binaries).
- **A one-time "Open Anyway".** The build is ad-hoc signed, not notarized by Apple, so macOS
  blocks the first open: on macOS 15+ open *System Settings → Privacy & Security* and click
  *Open Anyway*; on 13–14 Control-click the app and choose *Open*. Or in Terminal:
  `xattr -dr com.apple.quarantine /Applications/ClaudePulse.app`.
- The menu has *Install VS Code Extension…* if you skipped it at setup.
- Scripted installs: `/Applications/ClaudePulse.app/Contents/MacOS/ClaudePulse --setup-hooks`
  (or `--remove-hooks`).

### VS Code only

The extension shows what the hooks write, so the hooks come first. Without the Mac app they
run under Node.js.

```sh
git clone https://github.com/zxrrcpandey/VSCode-ClaudeCode-Status-Bar.git
cd VSCode-ClaudeCode-Status-Bar
node scripts/install-hooks.js     # wires the hooks into ~/.claude/settings.json; backs it up first; safe to re-run
```

Then install `claude-pulse-<version>.vsix` from the
[releases page](https://github.com/zxrrcpandey/VSCode-ClaudeCode-Status-Bar/releases):

```sh
code --install-extension claude-pulse-<version>.vsix
```

Reload every VS Code window (*Developer: Reload Window*) and start a new Claude Code session.
From then on the extension keeps the installed hook in step with its own copy whenever it
starts, so an update to the extension updates the hook too.

### From source

```sh
node scripts/build-vsix.js                     # writes claude-pulse-<version>.vsix (no vsce; works on Node 18)
cd macos && ./make-dmg.sh                      # builds the app, the vsix and ClaudePulse-<version>.dmg
cd macos && ./build.sh --install               # or build the app and install it on this Mac only
```

See [Building and testing](#building-and-testing) for what each step needs.

## The status indicator

| State | Looks like | When |
|---|---|---|
| Idle | `✳ Claude` | A session is open, nothing running |
| Working | `⟳ Claude · working 0:42` | You sent a prompt / Claude is using tools (live timer) |
| Task progress | `⟳ Claude · 3/7 ▰▰▰▱▱▱▱` | Claude is following its own checklist (real progress) |
| Needs input | `🔔 Claude · needs input` (yellow) | A permission prompt or question is waiting on you |
| Done | `✓ Claude · done 2:14` | Claude finished; shows total time, fades to idle |
| Error | `⚠ Claude · error` (red) | Response died (API error / connection lost); fades to idle |

- **Each VS Code window shows its own sessions** — the ones running inside its workspace
  folders — so two windows on two projects never show each other's work. Set
  `claudePulse.allProjects: true` for a global view. A session is matched by every folder it
  has reported, so one whose shell `cd`s elsewhere stays attached to the window it started in.
- **Any session waiting on you takes priority**, and several busy sessions show as `×N`.
- **Hover** for a breakdown: every session in the window with its state, task progress and
  current tool, its running subagents, then token counts and plan limits. **Click** to list
  the sessions and focus a terminal, or reset a stuck state.
- **It sits at the far-right edge** of the status bar by default, because VS Code hides
  items from the middle of the bar first when a window is narrow.
- **"Needs input" means needed.** Claude Code fires `PermissionRequest` for auto-approved
  calls too, so only confirmed prompts turn it yellow: an unanswered dialog, a question
  (`AskUserQuestion`, `ExitPlanMode`), or an agent asking for input. See
  [Troubleshooting](#the-indicator) for the timing rules.

### Subagents

When Claude spawns subagents (the Agent tool, workflows, parallel reviewers), the indicator
shows **how many are running** — `⟳ Claude · working 4:46 · 3 agents` — and the tooltip /
session picker list each one with its **task description, type, elapsed time, tool count,
current tool**, and its own checklist progress if it keeps one. The data comes from hooks:
the `Agent` tool call carries the task description, and every tool event from inside a
subagent carries its `agent_id`. Parallel agents write state concurrently, so the hook uses
a lock file around each update. Set `touch ~/.claude/claude-pulse/debug` to log raw hook
payloads to `~/.claude/claude-pulse/events.log` when investigating.

## The macOS menu bar app

The same indicator, outside the editor: a native menu bar app (`macos/`) that reads the very
same state files, so it shows **every** Claude Code session on the Mac — including ones in
other windows, other editors, or a plain terminal.

- **Menu bar:** `⣾ 4:46 · 3⚙` while working (spinner, elapsed, running agents), `3/7 ▰▰▰▱▱▱▱`
  when Claude is following a checklist, an orange `🔔 needs input` when you are actually
  needed, `✓ 2:14` on completion, `⚠ error` when a response dies. `×N` means several
  sessions are busy.
- **Drop-down:** every session with its project, state, current tool and checklist, each
  running subagent (task, type, elapsed, tools), how much of your plan is left and how fast it
  is going, and token usage for today and the last 7 days. Click a session to open its folder.
- **Notifies you** when a session needs input — the point of a menu bar app is that you can
  be looking somewhere else — and warns you before a usage limit stops you.
- **Starts with your Mac.** It offers this the first time it is set up, and the menu's
  *Open at Login* turns it on or off afterwards. It registers properly in System Settings ›
  General › Login Items; if macOS refuses that for an unsigned build, it falls back to a
  LaunchAgent in your own home folder. Only ever one of the two, so you never get two icons.
- **The menu** also holds *Desktop Buddy*, *Buddy Character*, *Buddy Size*, *Usage Warnings*
  (with *Check Usage Now* and previews of each warning), *Compact Chats Automatically*, *Show
  Usage in Claude Code*, *Reset Session States*, and setting up or removing the hooks.
- Native Swift, no Xcode project and no dependencies: `build.sh` compiles a universal
  binary with `swiftc` and assembles the `.app`. Same waiting-state rules as the extension
  (see `scripts/test-waiting.js`).

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

### Pace, and how far it can be trusted

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

### Where the warnings show

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

## The buddy

**View → Open View… → "Buddy"** (or run *Claude Pulse: Open Buddy*) adds a panel tab with a
little character that mirrors Claude's state: paces while Claude works, hops and rings when
Claude needs you, sleeps when idle, celebrates on done, goes dizzy on errors. **Click it and
it talks back** — real status, task progress, and token counts in speech bubbles, calling you
by the first name in your git config (or `claudePulse.buddyName`).

Nine built-in characters with different bodies and personalities, each drawn with shading,
fur or scales, and eyes that blink, close for a nap and squeeze shut on an error:
🐾 Red panda (the default, `critter` in settings) and 🤖 Robot (two legs), 🐱 Cat, 🐶 Pup and
🐢 Tortoise (four legs; the tortoise is small and very slow), 🐌 Snail (tiny and slowest),
🐝 Bee (a honeybee, zips around the whole panel), 🐉 Dragon (big, slow wingbeats, glides
everywhere), 👻 Ghost (floats).

<p align="center">
  <img src="https://raw.githubusercontent.com/zxrrcpandey/VSCode-ClaudeCode-Status-Bar/main/docs/images/panel.png" width="620" alt="Five characters drawn into one panel at different moments: a pup walking on the floor, a red panda climbing the right wall, a robot walking upside down along the ceiling, a cat hanging from the ceiling by all four paws, and a bee flying">
</p>

The panel is the character's whole world. The red panda, robot, cat, pup and snail climb the
walls and cross the ceiling upside down, head first. The five with legs also leap for the
ceiling, each with its own success rate. One that catches it turns over and hangs upside down
for two to five seconds, swinging a little: the red panda and robot by their feet, the cat,
pup and tortoise by all four paws. Then it crawls off along the ceiling, or lets go, rolls
over and lands on its feet. The tortoise cannot climb, so it always lets go. Flyers use the
whole height. (The picture above is several moments drawn into one panel; only one character
is on screen at a time.)

**Use your own character:** run *Claude Pulse: Choose Buddy Character* and pick any image —
PNG, JPG, WebP, SVG, or an animated GIF (`claudePulse.buddyImage` holds the path). The
built-in red panda is the fallback. VS Code has no floating-overlay surface, so the character
lives in its own panel (the same approach vscode-pets uses) — it cannot walk over the editor.
For that, there is the Desktop Buddy.

### Desktop Buddy — the character on your actual screen

What VS Code could not do: enable **Desktop Buddy** in the macOS app's menu and the character
leaves the panel and roams your real desktop, above every other app. The screen edges are its
world — it walks along the bottom, climbs the sides, crosses the top upside down or hangs from
it, and reacts to Claude exactly as it does in the editor (pacing while working, flailing when
you are needed, speech bubbles when you click it).

- **Clicks pass straight through** to whatever is underneath — the page reports where the
  character is and only that small rectangle is clickable, so the buddy can never swallow a
  click meant for another app. It never takes focus from the app you are typing in.
- **Reach for it and it stops.** The character notices the cursor coming within ~130px and
  holds still so you can actually click it — it walks and climbs far too briskly to hit
  otherwise. Tune with `defaults write com.warroom.claude-pulse buddyNoticeRadius -float 200`.
- **In the way? Pick it up.** Drag the character anywhere, including onto another screen,
  and it stays there for ten minutes before it roams again. A flyer hovers where you let go;
  a walker let go in mid-air drops to the floor first. It does not cross to another screen
  while it is staying put. A click without a drag still makes it talk. Change the stay with
  `defaults write com.warroom.claude-pulse buddyStaySeconds -float 1800`.
- **Flyers use the whole height** of wherever they live — the bee, dragon and ghost roam
  from the floor to just under the top of the screen.
- **Size is a page zoom**, not a CSS zoom on the sprite: in WebKit, CSS `zoom` also scales
  the element's *position*, which sent a 1.6× bee off the right of the screen and left
  hearts, flowers and speech bubbles far from it. With page zoom everything scales together.
  *Buddy Size* offers Small, Normal, Large and Huge (0.7×, 1×, 1.6×, 2.4×).
- **It recovers by itself.** If macOS kills the page's web process under memory pressure the
  buddy reloads, and a watchdog revives it if the page stops reporting its position for 5 s.
- Menu: pick any of the nine characters or your own image, and a size.
- It is the *same* `buddy.html` the VS Code panel uses — hosted in a transparent
  non-activating panel — so the art, animation and dialogue live in one place.

## Multiple monitors

Claude Pulse was built and used on a Mac with two displays side by side, and everything that
draws on the desktop is made for more than one screen.

- **One buddy panel per screen.** macOS defaults to *Displays have separate Spaces*, under
  which a single window cannot span two displays — it is pinned to one and clipped there, so a
  spanning window makes the buddy vanish on the other screen. Each screen gets its own
  transparent panel instead, sized to that screen's visible area, so the menu bar and the Dock
  are its ceiling and floor.
- **The buddy travels between them.** Every 45 to 150 seconds it decides to move on. It
  waits until it happens to be near the edge that faces the next screen (within 360 px, or
  three minutes have passed), dashes or flies off it, and carries on from the opposite edge of
  the next screen at the same height — a bee flies off the right of one display and in from
  the left of the next. Fix the interval with
  `defaults write com.warroom.claude-pulse buddyMigrateSeconds -float 30`.
- **Side by side or stacked.** Side by side, it leaves by the edge facing the other display.
  Stacked one above the other there is no facing edge, so it leaves by the nearer side and
  comes in on the same side, a short hop rather than a diagonal one. With three or more
  screens it visits them in turn.
- **Drag it to another screen.** A drag cannot leave the panel it started in, so when you
  let go over another display the app carries the character across to the pointer, keeping
  the same grip. Let go over the menu bar or past an edge and it still lands on screen.
- **Plug in, unplug, rearrange.** The panels are rebuilt whenever a display is added,
  removed or moved, so each one always matches exactly one screen.
- **Every Space, and beside full-screen apps.** The panels are set to appear on every Space
  and to be allowed in the Space of a full-screen app.
- **Only the screen with the character takes a click**, and only over the character; every
  other panel lets the mouse straight through.
- **Warnings go on every screen**, since you may be looking at either. Each banner can be
  dragged anywhere on its own screen, each display remembers where its banner was left, and
  the next one on that display comes up in the same place. Double-click sends it back to the
  top. Banners are rebuilt too when the displays change.
- **VS Code windows on any screen** each show their own workspace's sessions.

## How it works

```
Claude Code ──12 hook events──▶ hook.js ──▶ ~/.claude/claude-pulse/state/<session>.json ──┐
Claude Code transcripts (~/.claude/projects/**/*.jsonl) ──▶ usage-scan.js  (tokens) ──────┤
Claude Code's cached usage (~/.claude.json) ──────────▶ limits-scan.js (limits, pace) ────┤
                                                                                          │
              ┌─────────────────────────────────────┬─────────────────────────────────────┘
              ▼                                     ▼
  ┌────────────────────────┐            ┌────────────────────────────────┐
  │ VS Code extension      │            │ macOS menu bar app             │
  │ status bar · tooltip   │            │ menu · notifications           │
  │ commands               │            │ banners on every screen        │
  │ Buddy panel            │            │ Desktop Buddy on every screen  │
  └────────────────────────┘            └────────────────────────────────┘
                       both host the same buddy.html
```

1. Hook entries in `~/.claude/settings.json` run `~/.claude/claude-pulse/hook.js` on Claude
   Code's lifecycle events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
   `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`,
   `SubagentStart`, `SubagentStop` and `SessionEnd`. Under the Mac app the command is
   `pulse-hook` instead of `node`; the script is the same.
2. The script writes `~/.claude/claude-pulse/state/<session_id>.json` — current state, tool,
   todo progress, subagents, timestamps. One file per session, so multiple sessions work, and
   a lock file around each update, because parallel agents run hooks at the same moment.
3. The extension watches that folder and renders the status bar item; the macOS app reads the
   same files. Neither needs the other.
4. Token usage and plan limits come from separate scans run in a background process —
   `usage-scan.js` over the transcripts, `limits-scan.js` over the cached usage reading and a
   small per-minute ledger in `~/.claude/claude-pulse/limits-history.json`. The extension and
   the app run the same two scripts, so they always agree.
5. The buddy is one web page, `buddy.html`. VS Code hosts it in a webview panel; the macOS app
   hosts it in a `WKWebView` per screen and gives it the same small messaging API. Both send it
   the same state payload.

## Tech stack

| Part | Built with |
|---|---|
| VS Code extension | Plain JavaScript, VS Code API 1.74+, **no npm dependencies**. A status bar item, a `WebviewView` panel for the buddy, and a file-system watcher on the state folder. The scans run in a child process on VS Code's own runtime (`ELECTRON_RUN_AS_NODE`), so the editor does not wait on them and needs no Node.js of its own. |
| Hooks | `hooks/hook.js`, a Node-style script Claude Code runs on 12 lifecycle events. Writes one JSON file per session, atomically, under a lock file. |
| macOS app | **Swift** with AppKit, no Xcode project and no dependencies. `NSStatusItem` for the menu bar, `UserNotifications`, `ServiceManagement` (`SMAppService`) with a LaunchAgent fallback for starting at login, **WebKit** (`WKWebView` in non-activating `NSPanel`s) for the desktop buddy, and plain AppKit for the warning banners, so a killed web process can never blank a warning. |
| `pulse-hook` | A small runner on **JavaScriptCore**, which ships with every Mac. It provides the slice of Node's `fs`, `path`, `os`, `process` and `console` the scripts use, so the very same hook, installer and scanner scripts run on a Mac with no Node.js. |
| Buddy | One self-contained `buddy.html`: nine hand-drawn **SVG** characters animated with `requestAnimationFrame` and CSS transforms. Each moving part is its own composited layer, so the GPU moves pictures painted once rather than redrawing the drawing every frame. A strict content security policy with a per-load nonce; custom images are inlined as `data:` URIs. |
| Build | `build.sh` compiles with `xcrun swiftc` for arm64 and x86_64 and joins them with `lipo` into a universal binary, then signs ad hoc. `make-dmg.sh` packs the disk image with `hdiutil`. `build-vsix.js` writes the extension manifest and zips the package itself, so it needs no `vsce` and runs on Node 18. `make-icon.swift` draws the app icon natively at each size. |
| Tests | Node scripts, each building a throwaway `HOME` so it cannot touch your real setup, run under Node and again under `pulse-hook` so both runtimes give the same answers. |

## Project layout

```
extension.js            the VS Code extension: status bar, tooltip, commands, Buddy panel
buddy.html              the buddy: art, animation, dialogue (shared by VS Code and the Mac app)
hooks/hook.js           what Claude Code runs on each event; writes the per-session state
usage-scan.js           token usage from the transcripts, incremental by byte offset
limits-scan.js          plan limits, pace and the ledger; also the Claude Code status line
scripts/
  install-hooks.js      wires the hooks into ~/.claude/settings.json (backed up first)
  uninstall-hooks.js    removes everything Pulse added
  install-statusline.js "Show Usage in Claude Code"
  set-autocompact.js    Claude Code's autoCompactWindow, without exempting a model by accident
  build-vsix.js         packages the extension without vsce
  test-waiting.js       the waiting-state rules
  test-limits.js        the usage-limit maths
  test-autocompact.js   what the auto-compact script leaves alone
macos/
  ClaudePulse.swift     the menu bar app
  DesktopBuddy.swift    one transparent panel per screen, hosting buddy.html
  AlertBanner.swift     the warning card, one per screen
  LimitAlerts.swift     when to warn, and what to say
  Limits.swift          runs limits-scan.js; the warning thresholds
  LoginItem.swift       SMAppService, with a LaunchAgent fallback
  PulseHook.swift       pulse-hook, the JavaScriptCore runner
  Setup.swift           first-run setup
  build.sh, make-dmg.sh, icon/
LESSONS.md              every bug, its cause and its fix, by subject and by version
```

## Building and testing

Building needs only Apple's Command Line Tools (for `swiftc`, `lipo` and `hdiutil`) and
Node.js 18 or later for the extension package and the tests.

```sh
node scripts/build-vsix.js          # → claude-pulse-<version>.vsix
cd macos && ./build.sh              # → macos/build/ClaudePulse.app (universal)
cd macos && ./build.sh --install    # the same, installed to /Applications and started
cd macos && ./make-dmg.sh           # the app, the vsix and ClaudePulse-<version>.dmg
```

With [swiftly](https://www.swift.org/install/) installed, plain `swiftc` is the wrong
compiler; `build.sh` already calls `xcrun swiftc` with the SDK for that reason.

The regression suites each build their own throwaway `HOME`, so they are safe to run on a
machine with Pulse installed:

```sh
node scripts/test-waiting.js        # the waiting-state rules
node scripts/test-limits.js         # the usage-limit maths
node scripts/test-autocompact.js    # what the auto-compact script leaves alone

# …and the same suites through the runtime the macOS app uses:
PULSE_HOOK_BIN=/Applications/ClaudePulse.app/Contents/MacOS/pulse-hook node scripts/test-waiting.js
PULSE_LIMITS_BIN=/Applications/ClaudePulse.app/Contents/MacOS/pulse-hook node scripts/test-limits.js
PULSE_LIMITS_BIN=/Applications/ClaudePulse.app/Contents/MacOS/pulse-hook node scripts/test-autocompact.js
```

The two runtimes must agree. The app's single-instance lock lives in the real home folder, so
quit an installed copy before testing a fresh build.

## Settings and commands

### VS Code settings

| Setting | Default | What it does |
|---|---|---|
| `claudePulse.allProjects` | off | Show sessions from every project in every window, not just the window's own folders |
| `claudePulse.alignment` / `claudePulse.priority` | right / −900 | Where the indicator sits; the default far-right edge survives narrow windows |
| `claudePulse.doneDisplaySeconds` | 15 | How long the ✓ stays before fading to idle |
| `claudePulse.showElapsed` | on | The live timer while working |
| `claudePulse.showTokens` | on | The session's output tokens while Claude works |
| `claudePulse.waitingTimeoutSeconds` | 45 | A confirmed *permission* prompt reverts to working this long after the last confirmation, since approving fires no event; questions and agent prompts are never aged out; 0 disables |
| `claudePulse.provisionalWaitSeconds` | 0 (never) | Show *unconfirmed* permission requests as "needs input" after this many seconds |
| `claudePulse.showLimits` | on | How much of your plan is left |
| `claudePulse.limitWarnWeekly` / `claudePulse.limitWarnSession` | 75 / 88 | The percentages that turn the indicator amber |
| `claudePulse.contextWarnTokens` | 300000 | Flag a conversation once it carries this much context |
| `claudePulse.awayReminder` | on | Say so about fifteen minutes before a large, idle conversation stops being cheap to come back to |
| `claudePulse.awayWarnTokens` | 200000 | How large it has to be for that |
| `claudePulse.keepUsageFresh` | on | Have Claude Code fetch a new usage reading once the one it holds has aged out; costs no tokens |
| `claudePulse.buddyCharacter` | `critter` | `critter` (red panda), `robot`, `cat`, `pup`, `turtle` (tortoise), `snail`, `bee`, `dragon`, `ghost` |
| `claudePulse.buddyImage` | empty | Path to your own image (PNG, JPG, WebP, SVG, animated GIF) |
| `claudePulse.buddyName` | from git | The name the buddy calls you |
| `claudePulse.buddyUsageRemarks` | on | Let the character mention a limit out loud; separate from `showLimits`, so you can keep the quiet badge without the commentary |

### VS Code commands

| Command | What it does |
|---|---|
| Claude Pulse: Open Buddy | Opens the Buddy panel |
| Claude Pulse: Choose Buddy Character | Picks a built-in character or your own image |
| Claude Pulse: Show Claude Sessions | Lists the sessions; focus a terminal or reset |
| Claude Pulse: Reset Session States | Clears stuck states |
| Claude Pulse: Token Usage Report | The full report across all projects |
| Claude Pulse: Show Usage Inside Claude Code | Adds the status line under the Claude Code prompt |
| Claude Pulse: Compact Conversations Automatically | Sets Claude Code's auto-compact point |
| Claude Pulse: Check Usage Now | Asks Claude Code for a fresh usage reading |

### macOS app

Most of these are in the menu. All of them, including the same thresholds as the extension,
are read from the app's own domain and set with
`defaults write com.warroom.claude-pulse <key> …`:

| Key | Default | What it does |
|---|---|---|
| `limitWatchWeekly` / `limitWatchSession` | 50 / 70 | Percent at which the badge appears |
| `limitWarnWeekly` / `limitWarnSession` | 75 / 88 | Percent at which it turns amber |
| `limitCriticalWeekly` / `limitCriticalSession` | 90 / 96 | Percent at which it turns red |
| `contextWarnTokens` | 300000 | When a conversation counts as expensive |
| `awayWarnTokens` | 200000 | How large an idle chat has to be for the reminder |
| `limitAlerts` | true | `false`: no banners |
| `contextNudge` | true | `false`: no `/compact` nudge |
| `awayNudge` | true | `false`: no idle-chat reminder |
| `usageAutoCheck` | true | `false`: never ask Claude Code for a reading |
| `notifyOnInput` | true | Notify when a session needs input |
| `doneFadeSeconds` | 15 | How long ✓ stays |
| `waitTimeoutSeconds` / `provisionalWaitSeconds` | 45 / 0 | As `waitingTimeoutSeconds` and `provisionalWaitSeconds` in VS Code |
| `buddyStaySeconds` | 600 | How long the desktop buddy stays where you put it |
| `buddyNoticeRadius` | 130 | How close the cursor gets before it stops to be clicked |
| `buddyMigrateSeconds` | 45–150, random | Time between screen crossings |
| `buddyName` | from git | The name it calls you |
| `buddyDebug` | false | Trace hover and clicks to `~/.claude/claude-pulse/buddy-debug.log` |

```bash
defaults write com.warroom.claude-pulse limitWarnWeekly -int 60
defaults write com.warroom.claude-pulse limitAlerts -bool false     # no banners
defaults write com.warroom.claude-pulse buddyMigrateSeconds -float 30
```

From a terminal: `ClaudePulse --setup-hooks`, `--remove-hooks`, `--check-usage`,
`--autocompact 250000` or `--autocompact default`.

## Privacy

- **What it reads:** Claude Code's hook events, its transcripts under `~/.claude/projects/`,
  its cached usage in `~/.claude.json`, and `~/.claude/settings.json`.
- **What it writes:** its own folder, `~/.claude/claude-pulse/`. It changes
  `~/.claude/settings.json` only to add or remove its hooks, the optional status line and the
  optional auto-compact size, and backs the file up first every time. It never writes to
  `~/.claude.json` or to a transcript.
- **What reaches the network:** nothing of Pulse's own — no API calls, no telemetry, no tokens.
  The one exception is [keeping the usage reading fresh](#keeping-the-reading-fresh), where it
  has your own Claude Code run `/usage`, and that can be switched off.

## Uninstall

```sh
node scripts/uninstall-hooks.js
code --uninstall-extension warroom.claude-pulse
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
  view now accepts that first click.
  `defaults write com.warroom.claude-pulse buddyDebug -bool true` traces hover and clicks to
  `~/.claude/claude-pulse/buddy-debug.log`.
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

### How the buddy moves

The buddy in the VS Code panel and the one on the desktop run the same page, so these apply to
both. A VS Code window keeps the build it loaded until it is reloaded (see
[The indicator](#the-indicator)).

- **It walks backwards along the ceiling** — fixed in 0.18.1. Turning a drawing upside down
  also turns it round left to right, and the code then mirrored it again by the way it was
  walking, as it does on the floor. Every climber crossed the ceiling backwards. A climb now
  keeps the way the character faced when it started.
- **It spins round the long way at a top corner, or flips sideways at the foot of a wall** —
  fixed in 0.18.1. The turn eased towards a quarter turn one way up the wall and then a half
  turn the other way on the ceiling, so it spun three quarters of a turn at the corner. At the
  bottom it turned round while still tilted up to 65°. It now turns one way round the whole
  box, and stands up before it walks on.
- **It drops 46–54 px in one frame as it leaves a hang** — fixed in 0.18.1. Hanging raised it
  until its paws touched the ceiling, and the raise was taken away in one frame when it pulled
  up or let go. 0.18.1 eased it; 0.18.2 hangs a different way and has no raise.
- **The top of its head disappears into the ceiling while it hangs** — fixed in 0.18.2. It
  hung by its raised hands or paws, which on these drawings are lower than the top of the
  head, so the ceiling cut 6.5–24.3 px off the drawing. It now hangs upside down by its feet,
  or by all four paws.
- **Its speech bubble covers it on the ceiling** — fixed in 0.18.2. The bubble now goes below
  the character when there is no room above, with its pointer turned up. It is still placed
  once, when it is said, so it stays put while the character moves on.

## Lessons

Everything that went wrong while building this, what caused it and what fixed it — every bug
by version, and what Claude Code, VS Code and macOS turned out to do that nobody would guess —
is in [LESSONS.md](LESSONS.md).

## Licence

[MIT](LICENSE).
