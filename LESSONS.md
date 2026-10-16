# Lessons

Everything that went wrong while building Claude Pulse, why it went wrong, and what the code
does about it now — from the first status bar item to 0.18.1.

The README's [Troubleshooting](README.md#troubleshooting) covers some of the same ground by
symptom, for someone *using* Pulse. This file is for someone *changing* it. There are two ways
in:

- **By subject** — the sections below. Each entry is something that was assumed, turned out
  to be false, and cost a bug or a wrong number.
- **By version** — the [bug log](#bug-log) at the end: every bug, its cause, its fix, and how
  it was found.

Most of these were caught by a test or a review before a release. The bug log says which ones
reached a user.

**Contents**

1. [Claude Code's hooks](#claude-codes-hooks)
2. [Transcripts, token counts and settings](#transcripts-token-counts-and-settings)
3. [Usage limits and the cached reading](#usage-limits-and-the-cached-reading)
4. [Running Claude Code in the background](#running-claude-code-in-the-background)
5. [VS Code](#vs-code)
6. [macOS and AppKit](#macos-and-appkit)
7. [The buddy's animation](#the-buddys-animation)
8. [Numbers people act on](#numbers-people-act-on)
9. [Shared files and things that run at once](#shared-files-and-things-that-run-at-once)
10. [Testing and verifying](#testing-and-verifying)
11. [Tools that fail on macOS](#tools-that-fail-on-macos)
12. [Bug log](#bug-log)
13. [Known gaps](#known-gaps)

**Adding to it.** One entry per lesson: the rule in bold, then what happened and what the code
does now. Put the bug in the log as well. Write down only what was measured or seen.

## Claude Code's hooks

- **`PermissionRequest` does not mean you are needed.** It fires for auto-approved calls too
  — thirteen in 45 seconds in `acceptEdits` mode, twelve of fourteen from subagents. Only a
  confirming signal counts: the `Notification` about six seconds after an unanswered dialog,
  an agent asking for input, an elicitation dialog, or a question tool. Treating the first as
  the second pinned the indicator on "needs input".
- **A subagent's events are not the session's.** Every tool event from inside a subagent
  carries `agent_id`. The hook used to mark the *main* session as waiting for each of them.
  They now update that agent's record and nothing else.
- **Nothing fires when you approve a permission.** The next event is the tool finishing, so a
  permission wait has to be aged out. Questions and agent prompts are never aged out: they
  always end with an event, so timing them out could only ever be wrong.
- **Age a wait from its own clock.** The timeout was keyed on `updated_at`, which every event
  refreshes, so with parallel agents running the yellow state could never expire.
- **A fix can carry the opposite bug.** The first repair made a confirming signal inherit the
  start time of the stale provisional wait it replaced, so a genuine dialog opening during a
  long command was born expired and showed as "working". Waits now carry `confirmed_at`, and
  each confirmation re-arms the timeout. `scripts/test-waiting.js` exists because of this: run
  it after any change to those rules.
- **`provisionalWaitSeconds` must default to 0.** A long auto-approved command holds an
  unconfirmed wait for its whole duration, which is exactly the bug above.
- **Old hook, new extension.** A state file with no `waiting_confirmed` key comes from an
  older hook and is treated as confirmed, so a half-upgraded install degrades instead of
  hiding every prompt. To stop the skew arising, the `.vsix` ships `hooks/hook.js` and the
  extension refreshes the installed copy when it differs.
- **A hook's `cwd` follows the shell.** After a `cd` the session reports a different folder
  and stopped matching its window. A session now records every folder it has reported (up to
  eight, the first one kept) and a window matches against all of them.
- **The first folder on record is not a safe project name.** It is lost when the state file
  is recreated, and a project once showed up as `macos`. The name is whichever recorded folder
  matches the transcript's own.
- **Hooks are read when a session starts.** A session already running does not report until
  it is restarted, and new event types are the same: `SubagentStart` and `SubagentStop` never
  fired in a session that was already open.
- **What subagent events do carry.** The `Agent` tool's `PreToolUse` has the task description
  and type; its result names the real agent id, which is what tells parallel agents of the
  same type apart.
- **`SessionStart` with source `compact` is not a new session** and must not reset its state.
- **A response that dies ends in `StopFailure`.** And because any closing event can be missed,
  nothing is trusted to stay true: a session with no events for 60 minutes is dropped, a state
  file untouched for four hours is deleted, and *Reset Session States* clears the lot.
- **There is no percent-complete.** The only real progress Claude Code exposes is its own
  checklist, so that is the only progress bar shown.
- **Capture real events before theorising.** The stuck wait was found by logging 45 seconds
  of actual hook payloads (`touch ~/.claude/claude-pulse/debug` writes them to `events.log`),
  not by reading about what the events mean.

## Transcripts, token counts and settings

- **Message ids repeat.** Token counts are de-duplicated by message id.
- **Offsets are bytes, not characters.** The incremental scanner advanced by string index,
  which undercounts multi-byte UTF-8 and re-read lines it had already counted. Offsets are
  byte-accurate, and the cache file was renamed so an older extension cannot thrash it.
- **A transcript mixes the conversation with its subagents.** Records marked `isSidechain`
  belong to a subagent; counting one made a chat look 900k tokens large.
- **Straight after a compaction, report what it kept** (8k), not what it dropped (238k).
- **The cache lifetime is in the transcript, so read it.** It was an hour on the account this
  was built on and can be five minutes. With five minutes, a reminder timed fifteen minutes
  ahead would have fired after every single reply.
- **One unreadable file must not end the scan.** A transcript from a session run under `sudo`,
  a restored backup, a file deleted between the stat and the open: each threw out of the
  reader and killed the whole scan — silently, since every consumer treats no output as a blip
  and keeps the last reading. It now counts as "no new bytes", and a run of failures is
  reported.
- **An incremental reader can wedge.** One line longer than the read buffer left the offset
  where it was for ever. It skips forward.
- **`~/.claude/settings.json` is not yours.** Claude Code rewrites it while sessions run —
  permission approvals append to it, and it has been seen removing a key by itself. Every
  script here reads it, changes only its own keys, backs the file up (the newest five are
  kept) and writes it back. An existing status line of the user's is never replaced.
- **Read the setting; do not search the file.** Whether the status line was installed used to
  be decided by looking for a path in 391 KB of `settings.json`.
- **Auto-compact has three sources and one silent failure.** A model's own entry beats the
  top-level setting, an environment variable beats both, and a value outside 100k–1M is
  ignored without a word. So the script moves a looser per-model entry out of the way and
  remembers it, leaves a stricter one alone, and refuses when the environment variable is set.
- **Key order is not part of the data.** A restored per-model entry came back in a different
  order and failed a test that compared text.
- **Uninstalling removes everything it added** — hooks, the status line, the login agent —
  **and says what it leaves.** `autoCompactWindow` stays, because it is Claude Code's own
  setting and works without Pulse.
- **Do not hardcode `node`** in anything a Mac without Node will run. The status line command
  did, in a project that exists to avoid needing it.

## Usage limits and the cached reading

- **Measure before building.** The request behind this work was "I keep hitting the weekly
  limit". The transcripts record every refusal, and none of them was the weekly window. What
  they did show was where the usage went: carrying long conversations, not producing output.
- **An absence is worth re-checking.** 0.2.0 concluded that the plan percentages were not
  stored locally. By 0.15.0 they were being read from `~/.claude.json`. Whether Claude Code
  began writing them in between or they were missed the first time is not known.
- **The cached reading is history, not a meter.** Claude Code refreshes it on a sampled
  schedule (`policy_limits_poll` was `0.01`), and it has been found 17, 35 and 48 hours old.
- **A window can roll over under a reading.** At 17 hours old, a 5-hour window's percentage
  described a window that had ended three times over. Pulse rolls the window forward and
  withholds the figure.
- **A weekly window does not roll over within the week,** so that test passed a two-day-old
  "8%" into a banner while the real figure was 24%. A reading older than a tenth of its window
  is now withheld whatever the window.
- **A percentage needs its denominator in the label.** "Claude Code 88%" printed under
  "weekly limit 8%" reads as 88% of the limit. It is a share of usage: *where this week's
  usage went*. The same list on `claude.ai` is just as easy to misread.
- **A refusal names its window.** The transcript's 429 record says which limit ran out and
  when it frees up; running out of the 5-hour window is not running out for the week. And a
  refusal the session has visibly recovered from is no longer asserted for hours while it
  suppresses every other warning.
- **A figure carried forward says so.** It wears a `~` and names the reading it came from, and
  the badge is never a bare number.
- **When behaviour changes, the claims change with it.** The README said Pulse makes no
  network request. Once it started asking Claude Code for a fresh reading, that sentence had
  to go, and the one request is now described where the claim used to be.

## Running Claude Code in the background

The usage check runs `claude -p /usage`, which Claude Code answers without a model call.

- **`claude -p` behaves like you opening Claude Code unless told otherwise.** A plain run
  fired the user's own `SessionStart` and `SessionEnd` hooks. The check passes
  `--setting-sources project`, `--settings '{"disableAllHooks":true}'`, `--strict-mcp-config`
  and `--no-session-persistence`, and starts in an empty temporary folder.
- **`--bare` looks like the tidy way to get all of that and is no use.** It skips the
  keychain, so there is no login.
- **Close stdin.** Left open, Claude Code waits three seconds for input that is not coming.
- **Even then it leaves something behind** — an empty project folder under
  `~/.claude/projects`, named after the folder it ran in. Pulse removes it, and only when it
  is empty.
- **The `claude` on the PATH can be the oldest one on the machine.** Here it was 2.1.69,
  which answers *Unknown skill: usage* and exits 0, beside 2.1.296 inside the VS Code
  extension, which works. So success is judged by whether the reading moved, not by the exit
  status.
- **Compare versions as numbers.** As text, 2.1.69 sorts above 2.1.296.
- **Claude Code can refuse to start inside Claude Code.** 2.1.69 did, and an app or editor
  launched from a Claude Code terminal inherits the variable that triggers it, so Pulse clears
  `CLAUDECODE` from the environment it hands over.
- **Do not poll.** A check is due only when the reading is over twenty minutes old *and*
  tokens have been spent since. An account nobody is using is left alone, an API-key install
  is never asked, and a check that goes unanswered is retried after two hours, not at the next
  minute's scan.

## VS Code

- **One item per window is not one session for all windows.** 0.1.0 showed the most urgent
  session anywhere in every window. Each window now shows the sessions in its own workspace.
- **The status bar drops items from the middle first** when a window is narrow. The far edges
  survive, so the item sits at the far right with priority −900.
- **There is no floating overlay.** A character cannot walk over the editor; it lives in its
  own panel view, which is what `vscode-pets` does too.
- **`vsce` needs Node 20.** `scripts/build-vsix.js` writes the manifests and zips the package
  itself, so packaging works on Node 18 and no longer depends on a build folder in a temp
  directory that had a habit of disappearing.
- **A window keeps the build it loaded.** Installing an update changes nothing in a window
  until it is reloaded. An old build in one window and a new menu bar app once each rewrote
  the shared usage history in their own format and wiped the other's.
- **Text from a session is untrusted in a webview.** After the first review: session text is
  HTML-escaped before it reaches a speech bubble, the user's name is sanitised, template
  substitution is safe against `$`, a disposed view is never posted to, and a custom image
  that fails to load falls back to the built-in character.
- **Movement is per second, not per frame,** or the character's speed depends on the display.
- **The suites do not load the extension.** An undefined variable in the usage quick pick was
  only found by loading `extension.js` under a stubbed `vscode` module and running its
  commands. That check is done by hand; see [Known gaps](#known-gaps).

## macOS and AppKit

### Windows, clicks and screens

- **A transparent window swallows every click** unless it ignores mouse events outright.
  Returning `nil` from a hit test only makes the click land nowhere. The buddy's panel ignores
  the mouse by default and stops ignoring it only while the cursor is inside the character's
  rectangle, which it learns by polling the cursor position — no permission needed.
- **A window cannot span two displays** while *Displays have separate Spaces* is on, which is
  the default: it is pinned to one and clipped. One panel per screen, rebuilt when a display
  is added, removed or rearranged.
- **`NSScreen.main` is whichever screen has focus,** not a fixed one. Never assume it.
- **An accessory app is never the active app,** so the first click on its window is spent
  activating it unless the view accepts the first mouse click, and a borderless panel cannot
  become key unless it says it can.
- **A target that moves cannot be clicked.** A trace caught the character climbing 25 px
  between samples; the cursor was never over it. It now stops when the cursor comes near.
- **`fittingSize` is zero for a view laid out by frames.** The first usage banner was a 0×0
  window: created, on screen, invisible.
- **Two candidates in one pass means two banners.** Marking one as shown let the very next
  evaluation put up the next, 356 ms later. A banner is only raised when none is on screen.
- **Remove an observer before adding it again.** The screen-change handler was registered
  once per reload and ran that many times.
- **A window that can move has to look movable, and stay where it was put.** The banner had
  `isMovableByWindowBackground` from the start, and a synthetic drag moved it fine, but it
  was still reported as blocking the view: nothing on the card said it could move, and the
  next banner came back at the top centre anyway. The card now has a grab bar, and each
  screen remembers where its card was left.
- **Drag it yourself when it has to stay on one screen.** A drag the window server does for
  `isMovableByWindowBackground` is not held to one screen, and nothing reports when it has
  ended. One card per screen needs both. The card's view now takes the mouse-down and
  follows the mouse with `nextEvent(matching:)` until it is let go, clamped to its own
  screen. Its `hitTest` returns the card for everything except a button, so the title and
  text work as handles too.

### Menus

- **Never rebuild a menu that is open.** Refreshing the dropdown four times a second
  destroyed the submenu under the cursor before any click could register. It is built once
  when it opens; after that only the text of existing rows changes, and rows are tied to what
  they show by identity (an agent's id), not by position.

### Login items and processes

- **`launchctl bootout` does not unload a job, it kills it.** Started at login by its own
  LaunchAgent, the app terminated itself when *Open at Login* was switched off, one line
  before deleting the plist: the icon vanished and the agent was back at the next login. The
  plist goes first, and the app never boots out its own job. It knows the job is its own
  because launchd sets `XPC_SERVICE_NAME` to the job's label.
- **Process ids wrap,** so "the older copy has the lower pid" stops being true on a Mac that
  has been up a while. The single-instance guard takes a lock instead.
- **One login mechanism, not two.** `SMAppService` where macOS allows it, a LaunchAgent where
  it does not — both at once gives two icons in the menu bar.
- **An ad-hoc rebuild changes the signature and can silently drop the login item.** The app
  registers itself again after an update.
- **A GUI app inherits no shell `PATH`.** Whatever it launches — Node, `claude` — it has to
  look for in the places it could be.
- **`open` fails with −600 while the previous copy is still exiting.** `build.sh --install`
  waits for it to go.

### Web views

- **A web view's content process can be killed under memory pressure,** leaving a window that
  is up and blank. The buddy reloads when that happens, and a watchdog reloads it if the page
  stops reporting its position for five seconds. Warnings are plain AppKit so there is no web
  process to lose.
- **In WebKit, CSS `zoom` scales an element's position as well as its size.** A 1.6× bee was
  drawn at 1.6 times its own coordinates, off the right of the screen, with its hearts and
  flowers left behind. Page zoom scales everything together.
- **Inline a custom image as a `data:` URI** and the page keeps its strict content security
  policy and needs no file access.
- **A web view that is not on screen does not animate.** WebKit pauses
  `requestAnimationFrame` and CSS transitions in an offscreen window, so a tool that renders
  poses to images steps the page's loop itself and turns transitions off.
- **A filter region measured from the shape collapses on a straight line.** The default
  `objectBoundingBox` region is zero wide for a vertical stroke, so the bee's antenna stems
  vanished, and it clipped every glow to a square. The shared shadow filter uses a fixed
  region in user space.
- **`children`, not `childNodes`.** The runs of whitespace between elements are nodes too; each one
  became a layer the size of the whole drawing and made the click area that size.

### Packaging and building

- **No Developer ID means no notarization,** so every Mac needs a one-time *Open Anyway*. The
  disk image carries a Read Me that says so first.
- **A file copied out of a quarantined app is quarantined too.** The hook runner is copied to
  `~/.claude/claude-pulse/` (so hooks survive the app being moved) with the quarantine flag
  stripped, or macOS will not run it from a hook.
- **An emulated runtime has to fail like the real one.** The JavaScriptCore runner gives its
  errors a Node-style `.code`, because the hook's lock loop branches on `EEXIST`.
- **Draw an icon at each size.** Downscaling one bitmap loses the small sizes; rendered
  natively at 16 px it still reads as a striped bee.
- **A Swift extension cannot hold a stored property.** The app delegate is split across files
  as extensions, so new state goes in the class in `ClaudePulse.swift`.
- **With `swiftly` installed, plain `swiftc` is the wrong compiler.** See
  [Tools that fail on macOS](#tools-that-fail-on-macos).

## The buddy's animation

- **Standing still reads as broken.** The character stood still whenever Claude was idle and
  was reported as "not roaming". Every state now moves, with rests.
- **Regular movement reads as a machine.** Walking edge to edge looked like ping-pong. Short
  hops mixed with long walks, a different pace each time and the odd change of mind do not.
- **Every activity needs a way out.** A scheduler that was not run again after a rest froze
  the character for ever. Later, a leftover flip or drop at ground level had no exit and froze
  it at a screen edge; the hand-off between screens now resets the whole motion state.
- **Anything derived from the stage size is recomputed when the stage changes.** After a
  resize the character was climbing thin air. Walls are re-pinned every frame and targets
  re-clamped.
- **Constants from a small stage do not survive a large one.** Flyers were capped at 170 px
  of altitude, a limit from the VS Code panel, and stayed in the bottom strip of a desktop.
- **Fading out on a timer reads as disappearing.** Moving between screens is now a crossing:
  the character heads for the facing edge and continues from the opposite edge of the next
  screen at the same height. It only starts when already near the edge, the hand-off happens
  once, and the screens are checked again after its asynchronous step.
- **Decide the outcome before animating it.** A ceiling leap rolls success first; a miss is
  only counted after an actual launch, and the urgent "needs input" bounce cannot hijack a
  crouch.
- **Art has a front.** The snail was drawn facing backwards and travelled tail first.
- **Upside down is already mirrored.** `rotate(180deg)` turns a drawing round left to right
  as well as upside down. Mirroring it again by the way it was going, which is right on the
  floor, walked every climber backwards along the ceiling. A climb now keeps the mirror it
  started with and turns one way round the box: a quarter turn up the wall, a half on the
  ceiling, three quarters down the far wall. Easing towards −90° and then 180° had also spun
  it three quarters of a turn the long way at a corner.
- **Ease everything that moves it, not only the turn.** A hanging character is raised so its
  paws touch the ceiling, and that raise went in one frame when it pulled up or let go: a
  jump of 46–54 px. It is eased now, like the turn. At the foot of a wall it stands up before
  walking on, because turning round while still tilted flipped it sideways.
- **Detail is paid for every frame unless it is painted once.** The 0.18.0 drawings, with
  gradients, fur and shadows, roughly tripled the GPU process's CPU while the whole drawing
  was redrawn with each limb's new angle. Every moving part is now its own small layer,
  cropped to its own bounds and turned by CSS `rotate` about its pivot, so the compositor
  moves a picture it already has. A CSS drop shadow on those layers was applied again every
  frame; the same shadow as an SVG filter inside the layer is painted with it once.
- **Look at every pose, not one.** A drawing that is right standing can be wrong mid-wave:
  a raised arm covered the face, the cat's pointing paw stuck out like a plank, leg tops
  showed as rectangles in front of the body, and the dragon's spade sat behind its wing.
  Each was found in a contact sheet of fourteen poses — standing, walking, asleep, done,
  error, waiting, pointing, hanging, on a wall and the ceiling, waving, talking, held and
  facing left.
- **Measure from the art.** Hanging from the ceiling used a fixed lift and overshot in a
  short panel. Each character now says where its raised hands are (`reach`) and the lift
  is worked out from that.
- **The click area and the box are different things.** Only the drawn parts take clicks
  now, so the panel passes clicks through the empty corners. The whole box is still what
  is used to tell when the character has reached a screen edge.
- **The character list lives in three places** — `CHARS` in `buddy.html`, the list and picker
  in `extension.js`, the enum in `package.json` — and they have to change together.
- **Something you can drag has to stay where it is put.** The character roamed everywhere,
  and nothing could move it off what it covered. Now it can be picked up, and once let go it
  parks until `parkUntil`. `scheduleNext()` and the flyers' rest both wait that out. The
  host's hover pause used to set a 700 ms pause outright. It now only extends a pause, or the
  first time the cursor came near it would have cut a ten-minute stay short. Screen crossings
  wait too, and their long-wait fallback counts from the end of the stay. Otherwise the
  character would set off for the edge the moment the stay ran out.
- **A drag cannot leave the window it started in.** Each screen has its own panel, so the
  page keeps the carried character inside its own stage. If the pointer is over the other
  screen on release, the host carries the character across, keeping the same grip.
- **Keep a dragged thing's window taking the mouse.** The panel is click-through except
  where the page last said the character was, and that report comes every 100 ms, so a quick
  drag outruns it. While carried, the panel stays clickable until the drop, or until the
  button is seen up.

## Numbers people act on

- **Do not learn from one sample.** The first calibration had three ways to learn a cost per
  percent several times too large — an interval it had not read all of, a step with too little
  local spend to explain it, a per-model window divided by the whole account's spend — and
  then asserted it. It now needs three clean pairs.
- **Clamping hides a wrong answer.** A factor that projects past what is possible is dropped,
  not capped at 200% and called calibrated.
- **The server's percentage covers the whole account; the local ledger sees only Claude
  Code.** A weekly step is discounted by the share the server itself reports.
- **Keep history as long as the gap you measure across.** The ledger kept three hours;
  readings arrived seventeen hours apart. It keeps twenty-six.
- **One reply is not a trend.** A single short reply put the context share at 97%. It is
  averaged over the recent turns.
- **A warning that cries wolf gets switched off.** 80% with a refill twenty minutes away is
  not news. Interrupt only when the pace would empty the window before it refills, or when
  nearly out outright.
- **A silence switch silences everything.** *Quiet for 4 Hours* did not reach per-model
  windows.
- **Advice has a deadline.** "Compact before 3:42 PM" is taken down when the time passes,
  because after it compacting has to load the conversation first and is no longer the advice.
- **A reminder needs someone to read it.** The idle-chat reminder only fires with a key or
  the mouse touched in the last four minutes. For the person who has already left, the answer
  is a setting that acts by itself.
- **Say only what was measured.** "An hour on most plans" became "an hour on the account this
  was built on", and "12.5 times dearer" became a range once the two cache-write prices were
  looked up.

## Shared files and things that run at once

- **Parallel agents mean parallel hook processes.** Each update to a state file is a read,
  a change and a write, so the hook takes a lock file around it. Counts stay exact under
  twelve concurrent writers.
- **Write only what changed.** The history file, 204 KB, was being rewritten every minute by
  every running copy. It is smaller now and written only when something in it changed.
- **Two builds, one file, two formats.** See [VS Code](#vs-code): a file format change needs
  either a new file name or every writer updated together.
- **Do not drop a caller because you are busy.** A manual *Check Usage Now* arriving during a
  scan would have had its result thrown away. Callers queue, to a limit.
- **Everything wakes at once.** VS Code restores its windows together and they scan in step,
  so whoever asks Claude Code for a reading writes a stamp first and the others, on reading
  it, stand back. The extension stands back for the macOS app in the same way.

## Testing and verifying

- **A test builds its own world.** `scripts/test-waiting.js` trusted its caller to hand it a
  throwaway `HOME`. Run plainly it emptied the real state folder and left nine fake sessions
  in the menu bar as "agent needs you ×5". Every suite now creates and deletes its own.
- **Two runtimes, one answer.** The same scripts run under Node in VS Code and under
  JavaScriptCore in the app, which provides only the parts of `fs`, `path` and `os` they use.
  Every suite is run through both, and they must agree.
- **Test how a program was started, not how you meant to start it.** The usage check is
  tested against a stand-in `claude` that records the binary, folder, arguments, environment
  and stdin it was given, and only moves the reading when started the way the real one needs.
- **The single-instance lock lives in the real home folder,** so a test copy given a fake
  `HOME` stands down while the installed app is running. Quit that first.
- **A dying app writes its preferences back.** Clearing a `defaults` key and then quitting
  the app restores the key. Quit, then clear.
- **A failing new test may be the test.** One asserted a sample count that is only filled in
  once three samples exist; another used less spend than the calibration's own minimum.
- **Look for the window, not at the screen.** Asking the window server which windows exist
  and how large they are (`CGWindowListCopyWindowInfo`) found the 0×0 banner in a minute; a
  screenshot only showed nothing.
- **Prove a click with a click.** The buddy fix was verified by warping the cursor onto the
  character and posting a real click, and the menu fix by driving the real menu through
  System Events.
- **A synthetic click needs a click count.** A `CGEvent` posted without setting
  `mouseEventClickState` did not always become a click in the page: one bee test run failed
  its click check. Set to 1, as a real mouse sets it, the click registered first time in
  every later run.
- **Test the host in a bundle of its own.** `DesktopBuddy.swift` and `buddy.html` built into
  a throwaway app with a different bundle identifier keep their settings in a separate
  `defaults` domain, so the test cannot change the real character or size. The window
  objects are in reach: the test reads the panel's hot rectangle and runs JavaScript in the
  page. The installed app still has to be quit first, both for the lock and so that its
  own character cannot catch the test's clicks.
- **Measure the GPU process as well as the page.** Most of what the buddy costs is in
  WebKit's GPU process, not the web content process. Ask the web view for both
  (`_webProcessIdentifier`, `_gpuProcessIdentifier`); adding up every `WebKit.GPU`
  process on the machine counts other apps too.
- **Read a pipe before waiting for the process.** A tool that called `waitUntilExit` on
  `ps` before reading its output hung for good once the output filled the pipe.
- **Track the thing, not the edge of what it covers.** The drag test took the middle of the
  click area as the character's position and reported a parked red panda as moved 13 pt.
  It had only turned to look round, and its click area is not symmetrical. The test reads
  the position from the page.
- **A still frame cannot show which way something is going.** The fourteen-pose sheet had
  the ceiling in it and was looked at, and upside down a character facing backwards looks
  just as right. What found it was a test that steps the page's own loop through whole
  climbs and checks, every frame, where the head points on screen against where the
  character actually moved. On 0.18.0 that failed every climb.
- **A gap between two manual steps looks like staleness.** A reading that seemed 39 minutes
  old "right after refreshing" was the time between the two commands. Check the file's own
  timestamp.
- **Review after building, every time — and know what it costs.** An adversarial review
  found real faults in every feature it was pointed at: eight before 0.1.0, thirteen in the
  stuck-wait fix, nine in the multi-character rewrite, seven in the screen-crossing work,
  thirty-six in the limit guard. On the machine this was built on, two such multi-agent
  reviews in one session were also 38% of that week's usage.

## Tools that fail on macOS

Each of these stopped a build or a test at least once.

| What fails | Why | What works |
|---|---|---|
| `swiftc` → `unknown argument: '-target-arch-variant'` | `swiftly`'s toolchain is first on the PATH and older than the SDK | `xcrun swiftc -sdk "$(xcrun --show-sdk-path)"` |
| Apple's `swiftc` by full path → `unable to load standard library` | `swiftly`'s shims hijack SDK discovery | the same, with `-sdk` given |
| `swiftc` on a single file with `@main` | top-level code is assumed | `-parse-as-library` |
| `vsce package` | needs Node 20 | `node scripts/build-vsix.js` |
| `timeout 45 cmd` | not part of macOS | `cmd & pid=$!; ( sleep 45; kill $pid ) &` |
| `pgrep -c` | not supported | `pgrep -x Name \| wc -l` |
| `defaults read … \| grep 'does not exist'` | the message is worded differently | test the exit status |
| `rm -f name*.png` with nothing to match | zsh stops with `no matches found` | check first, or use `find` |
| `import Quartz` in the system `python3` | not installed | a short Swift script |
| `qlmanage` thumbnailing a `.app` | hung for five minutes | `NSWorkspace.icon(forFile:)` |
| `screencapture`, `open` with the Mac locked | the screen is locked; `open` returns −600 | unlock, or start the binary directly |
| `open` straight after quitting the same app | −600 while the old copy exits | wait for the process to go |
| `claude` started from a Claude Code terminal | refuses to nest | `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude …` |
| `claude -p /usage` with the `claude` on the PATH | 2.1.69: *Unknown skill: usage* | the copy inside the VS Code extension |

## Bug log

*Found* is how it came to light: **reported** by someone using it, **in use** on the machine it
was built on, by a **review** or a **test** before release, or by the **build** failing. Bugs
found by review or test did not reach a release.

| Version | What was seen | Cause | Fix | Found |
|---|---|---|---|---|
| 0.1.1 | The same session in every VS Code window | The item showed the most urgent session anywhere | Each window shows its own workspace's sessions | reported |
| 0.1.3 | Indicator gone after narrowing the window | VS Code drops items from the middle of the bar | Far-right edge, priority −900 | reported |
| 0.1.4 | Indicator gone after answering a prompt | Hook `cwd` follows the shell's `cd` | Every reported folder is recorded; dim idle item instead of hiding | reported |
| 0.4.0 | Buddy "not roaming" | It stood still while Claude was idle | Every state moves | reported |
| 0.4.1 | Buddy only went left and right | Uniform edge-to-edge targets | Mixed hops, walks and pace | reported |
| 0.5.0 | Buddy could freeze for ever | Scheduler not run again after a rest | Rest expiry reschedules | review |
| 0.6.0 | Buddy climbing thin air after a resize | Wall position not updated when the panel resized | Re-pinned every frame | review |
| 0.7.0 | A leap could count as missed without leaving the ground | Miss recorded before the launch | Counted after launch | review |
| 0.8.0 | Snail travelled tail first | Art drawn facing backwards | Flipped | review |
| 0.10.0 | Agent counts could drift with parallel agents | Concurrent read-change-write of one state file | Lock file around each update | test |
| 0.10.1 | Stuck on "needs input" while Claude worked | `PermissionRequest` fires for auto-approved and subagent calls, and refreshed the timeout's clock | Only confirmed signals count; waits age from their own start | reported |
| 0.10.2 | A real prompt showed as "working" | Confirmation inherited a stale start time | `confirmed_at`; timeout from the last confirmation | review |
| 0.10.2 | A new extension with an old hook would hide prompts | State files without the new key | Treated as confirmed; the vsix updates the hook | review |
| 0.12.1 | Desktop buddy blocked clicks to every app | A transparent window takes clicks unless it ignores the mouse | Click-through except over the character | reported |
| 0.12.1 | Desktop buddy vanished, window blank | Web content process killed | Reload, and a 5 s watchdog | reported |
| 0.12.2 | Buddy vanished on the second screen | A window cannot span displays with separate Spaces | One panel per screen | reported |
| 0.12.3 | Could not click the character | It moved away; the click was spent activating the window | Stops near the cursor; accepts first mouse | reported |
| 0.13.0 | Menu items would not click | Menu rebuilt four times a second while open | Built once; text updated in place | reported |
| 0.13.0 | Bee stayed in the bottom strip | 170 px altitude cap from the panel | Full height | reported |
| 0.13.0 | Hearts far from the bee; bee off-screen when enlarged | CSS `zoom` scales position | Page zoom | reported |
| 0.13.0 | Buddy "disappeared" between screens | Timed fade-out | Crossing at the edge | reported |
| 0.13.0 | Buddy frozen at a screen edge | Leftover flip or drop state with no exit | Hand-off resets the motion state | review |
| 0.13.0 | Screen-change handler ran many times | Observer added on every reload | Removed first | review |
| 0.14.0 | Scanner could re-read counted lines | Offset advanced by characters, not bytes | Byte offsets; new cache file | test |
| 0.14.0 | Build failed after a Command Line Tools update | `swiftly` toolchain on the PATH | `xcrun swiftc -sdk` | build |
| 0.15.0 | Usage banner never appeared | 0×0 window from `fittingSize` | Frame size | test |
| 0.15.0 | A project showed as `macos` | First recorded folder overwritten | Name from the transcript's folder | in use |
| 0.15.0 | A chat reported a subagent's 900k as its own | Sidechain record counted | Filtered | test |
| 0.15.0 | Reader stuck on one very long line | Offset never advanced | Skips forward | review |
| 0.15.0 | False alarm on the 5-hour window | Reading 17 h old; the window had rolled over | Rolled forward and withheld | in use |
| 0.15.0 | Banner said 8% of the week; it was far more | A weekly window never rolls over, so age went unchecked | Withheld past a tenth of the window | reported |
| 0.15.0 | Pace several times too high | Calibration from partial or unrelated spend | Three clean pairs; outliers dropped | review |
| 0.15.0 | Nothing learnt between readings | Ledger kept 3 h; readings came 17 h apart | 26 h | review |
| 0.15.0 | Icon vanished when *Open at Login* was switched off | `launchctl bootout` kills the job | Plist deleted first; never boots out itself | review |
| 0.15.0 | The wrong copy could quit | Single-instance check compared pids, which wrap | A lock | review |
| 0.15.0 | Scan died without a word | One unreadable transcript | Counted as no new bytes | review |
| 0.15.0 | Context share jumped to 97% | Taken from one turn | Averaged | review |
| 0.15.0 | Just-compacted chat showed its old size | Pre-compaction count | What the compaction kept | in use |
| 0.15.0 | Two banners a third of a second apart | Next pass raised the next candidate | Only when none is on screen | in use |
| 0.15.0 | History rewritten every minute | No change tracking | Written on change | review |
| 0.15.0 | A refusal asserted for hours after recovery | Never cleared | Cleared when the session recovers | review |
| 0.15.0 | "Claude Code 88%" read as limit used | Bare percentage | *where this week's usage went* | review |
| 0.15.0 | `open` −600 during install | Old copy still exiting | Waits for it | build |
| 0.16.0 | Reminder would fire after every reply | Five-minute cache: deadline inside the lead time | Only when the lifetime is twice the lead | review |
| 0.16.0 | Usage quick pick threw | Undefined variable | Fixed | test |
| 0.16.0 | Fake "p" sessions, "agent needs you ×5" | Test suite run against the real `HOME` | Suite makes its own | reported |
| 0.16.0 | Usage line two days old (8%, really 24%) | Claude Code's sampled refresh | Pulse asks for a reading itself | reported |
| 0.16.0 | The user's own hooks ran during the check | A plain `claude -p` loads user settings | Hooks and user settings switched off | test |
| 0.16.0 | Empty folder left in `~/.claude/projects` | Claude Code makes one per start folder | Removed when empty | in use |
| 0.16.0 | A manual check's result could be lost | Refresh returned early when busy | Callers queue | review |
| 0.16.0 | Every window would ask at once | Windows scan in step | A stamp, re-read before asking | review |
| 0.16.0 | Usage history wiped back and forth | Old extension build and new app, two formats | Matching builds; reload windows | in use |
| 0.16.1 | Banner blocked the view | Draggable, but nothing showed it, and each banner started at the top centre again | Grab bar; each screen remembers its spot; kept on its own screen; double-click resets | reported |
| 0.17.0 | Desktop character blocked the view | It roamed everywhere and could not be moved | Drag it anywhere, other screen too; it stays put ten minutes | reported |
| 0.18.0 | Characters did not look real | Flat shapes, one colour each | Redrawn with shading, fur or scales, and eyes that blink | reported |
| 0.18.0 | New drawings tripled the GPU process's CPU | The whole drawing redrawn each frame | Each moving part its own layer; shadow painted once | test |
| 0.18.0 | Bee's antenna stems missing; glows cut square | Filter region measured from a zero-width shape | Fixed region in user space | test |
| 0.18.0 | Click area the size of the whole box | Whitespace nodes became layers | Only elements become layers | test |
| 0.18.0 | Raised arm hid the face; dragon's spade hidden | Parts checked in one pose only | Arm angles eased above the shoulder; tail redrawn | test |
| 0.18.1 | Characters walked backwards on the ceiling | Upside down is already mirrored; it was mirrored again by direction | Mirror kept from the start of the climb | reported |
| 0.18.1 | Spun the long way at a ceiling corner; flipped sideways getting down | Turn targets of −90° then 180°; mirror changed mid-tilt | One way round the box; stands up before walking on | test |
| 0.18.1 | Dropped half its height when leaving a hang | The hang's raise removed in one frame | Eased | test |

## Known gaps

- The two menu rows added in 0.16.0, *Keep the usage figures up to date* and *Check Usage
  Now*, have had the code beneath them tested but have not been exercised by a click.
- The 0.18.0 drawings were checked in the macOS app and in rendered poses. In the VS Code
  panel they run from the same `buddy.html` but have not been looked at there by hand.
- Hanging from the ceiling, the red panda, robot, cat and pup hold their raised hands or paws
  lower than the top of their head, so the ceiling cuts the head off while they hang. Fixing
  it needs a hanging pose drawn for each.
- Nothing in `scripts/` loads `extension.js`. It is checked by hand under a stubbed `vscode`
  module before a release.
- The usage check depends on how Claude Code 2.1.296 answers `/usage` without a terminal. A
  later version may answer differently; `ClaudePulse --check-usage` shows what it said.
