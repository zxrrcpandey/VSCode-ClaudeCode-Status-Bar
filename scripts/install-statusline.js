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

  if (fs.existsSync(SETTINGS)) {
    const backup = SETTINGS + '.claude-pulse-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(SETTINGS, backup);
    console.log('Backed up settings to ' + backup);
  }

  if (remove) {
    if (!current) { console.log('No Claude Pulse status line to remove.'); return; }
    delete settings.statusLine;
    writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    console.log('Status line removed. Restart Claude Code to see the change.');
    return;
  }

  // A stable copy, so the status line keeps working if the app or repo moves.
  fs.mkdirSync(PULSE_DIR, { recursive: true });
  writeFileAtomic(DEST, fs.readFileSync(SRC, 'utf8'));

  settings.statusLine = {
    type: 'command',
    command: process.env.PULSE_STATUSLINE_COMMAND || ('node "' + DEST + '" --statusline'),
    padding: 0,
  };
  writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log('Status line added to ' + SETTINGS + '.');
  console.log('Restart Claude Code and your usage appears under the prompt.');
}

main();
