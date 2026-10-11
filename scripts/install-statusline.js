#!/usr/bin/env node
/*
 * Puts your usage on Claude Code's own status line.
 *
 * ~/.claude/settings.json supports a top-level "statusLine" command whose
 * output Claude Code renders under the prompt. It is chrome, not conversation:
 * it costs no tokens and makes no API call. That matters, because the moment
 * you need to know you are near a limit is while you are typing into Claude
 * Code — not while you happen to glance at the menu bar.
 *
 * Prints something like:
 *   5h 62% · wk 41% · ctx 420k — /compact
 *
 *   node scripts/install-statusline.js            install
 *   node scripts/install-statusline.js --remove   put back whatever was there
 *
 * Like the hook installer: backs settings.json up first, writes atomically,
 * and refuses to touch a status line it did not create.
 *
 * Runs under Node or the macOS app's JavaScriptCore runner, which sets:
 *   PULSE_STATUSLINE_COMMAND  the command to register (the native runner)
 *   PULSE_LIMITS_SRC          where limits-scan.js lives inside the app bundle
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const PULSE_DIR = path.join(HOME, '.claude', 'claude-pulse');
const DEST = path.join(PULSE_DIR, 'limits-scan.js');
const SRC = process.env.PULSE_LIMITS_SRC || path.join(__dirname, '..', 'limits-scan.js');
const MARKER = path.join('claude-pulse', 'limits-scan.js');

function isOurs(sl) {
  return !!sl && typeof sl.command === 'string'
    && (sl.command.includes(MARKER) || (sl.command.includes('claude-pulse') && sl.command.includes('--statusline')));
}

function writeFileAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function main() {
  const remove = process.argv.indexOf('--remove') >= 0;

  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    const raw = fs.readFileSync(SETTINGS, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      console.error('ERROR: ' + SETTINGS + ' is not valid JSON — not touching it.');
      console.error(String(e.message || e));
      process.exit(1);
    }
  }

  const current = settings.statusLine;
  // Somebody else's status line is theirs. Say so rather than replacing it.
  if (current && !isOurs(current)) {
    console.error('Claude Code already has a status line set up, and it is not this one:');
    console.error('  ' + JSON.stringify(current));
    console.error('Remove it from ' + SETTINGS + ' first if you want to use the Claude Pulse one.');
    process.exit(2);
  }

  if (remove) {
    // Nothing to do is not a success. Reporting one let the caller tell the
    // user "Claude Code's status line is back to how it was" after doing
    // nothing at all.
    if (!current) {
      console.error('ERROR: no Claude Pulse status line is set in ' + SETTINGS + '.');
      process.exit(3);
    }
    backup();
    delete settings.statusLine;
    writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    console.log('Status line removed. Restart Claude Code to see the change.');
    return;
  }

  // A stable copy, so the status line keeps working if the app or repo moves.
  // Read it before backing anything up: a missing source should fail before
  // the user's settings have been touched.
  const script = fs.readFileSync(SRC, 'utf8');
  fs.mkdirSync(PULSE_DIR, { recursive: true });
  writeFileAtomic(DEST, script);

  backup();
  settings.statusLine = {
    type: 'command',
    command: process.env.PULSE_STATUSLINE_COMMAND || defaultCommand(),
    padding: 0,
  };
  writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log('Status line added to ' + SETTINGS + '.');
  console.log('Restart Claude Code and your usage appears under the prompt.');
}

/* Claude Code runs this through a shell, so `node` has to be on PATH for it to
 * work — and this project exists partly because it cannot be assumed to be.
 * The extension launches its own scripts through Electron's own binary for
 * exactly that reason, and then wrote `node ...` into a file for someone else
 * to run. The native runner only has to exist on disk. */
function defaultCommand() {
  const runner = path.join(PULSE_DIR, 'pulse-hook');
  if (fs.existsSync(runner)) return '"' + runner + '" run "' + DEST + '" --statusline';
  return 'node "' + DEST + '" --statusline';
}

/* Only ever immediately before settings.json is actually rewritten. Taken any
 * earlier, every no-op and every crash left another full copy of a 391 KB file
 * that holds env values and apiKeyHelper, and nothing ever pruned them. */
function backup() {
  if (!fs.existsSync(SETTINGS)) return;
  const backupFile = SETTINGS + '.claude-pulse-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(SETTINGS, backupFile);
  console.log('Backed up settings to ' + backupFile);
  prune();
}

/* Keep the newest few. These are whole copies of settings.json and they were
 * accumulating for ever. */
function prune() {
  const dir = path.dirname(SETTINGS);
  const prefix = path.basename(SETTINGS) + '.claude-pulse-backup-';
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const mine = names.filter((n) => n.indexOf(prefix) === 0).sort();
  for (const n of mine.slice(0, Math.max(0, mine.length - 5))) {
    try { fs.unlinkSync(path.join(dir, n)); } catch { /* best effort */ }
  }
}

main();
