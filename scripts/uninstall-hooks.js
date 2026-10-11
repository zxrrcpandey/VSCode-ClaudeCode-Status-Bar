#!/usr/bin/env node
/*
 * Removes Claude Pulse hook commands from ~/.claude/settings.json and deletes
 * ~/.claude/claude-pulse/. Backs up settings.json first. Only this project's
 * commands are removed — user hooks sharing a group are preserved.
 *
 * Runs under Node from the repo, or under the macOS app's JavaScriptCore runner.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const PULSE_DIR = path.join(HOME, '.claude', 'claude-pulse');
const AGENT = path.join(HOME, 'Library', 'LaunchAgents', 'com.warroom.claude-pulse.plist');
// Both flavours: `node ".../claude-pulse/hook.js"` and the native runner.
const MARKERS = [path.join('claude-pulse', 'hook.js'), path.join('claude-pulse', 'pulse-hook')];
const STATUSLINE_MARKER = path.join('claude-pulse', 'limits-scan.js');

function isPulseCommand(h) {
  return h && typeof h.command === 'string' && MARKERS.some((m) => h.command.includes(m));
}

/* The status line runs `~/.claude/claude-pulse/pulse-hook run …limits-scan.js`,
 * and this script deletes that whole directory. Leaving the setting behind
 * means Claude Code spawns a missing executable on every prompt render — exit
 * 127, a blank status line, and nothing naming Claude Pulse as the cause. */
function isPulseStatusLine(sl) {
  if (!sl || typeof sl.command !== 'string') return false;
  return sl.command.includes(STATUSLINE_MARKER)
    || (sl.command.includes('claude-pulse') && sl.command.includes('--statusline'));
}

function withoutPulse(entries) {
  return entries
    .map((e) => {
      if (!e || !Array.isArray(e.hooks)) return e;
      return { ...e, hooks: e.hooks.filter((h) => !isPulseCommand(h)) };
    })
    .filter((e) => !(e && Array.isArray(e.hooks) && e.hooks.length === 0));
}

function writeFileAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function main() {
  if (fs.existsSync(SETTINGS)) {
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    } catch (e) {
      console.error('ERROR: ' + SETTINGS + ' is not valid JSON — not touching it.');
      process.exit(1);
    }
    const backup = SETTINGS + '.claude-pulse-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(SETTINGS, backup);
    if (settings.hooks && typeof settings.hooks === 'object') {
      for (const event of Object.keys(settings.hooks)) {
        if (!Array.isArray(settings.hooks[event])) continue;
        settings.hooks[event] = withoutPulse(settings.hooks[event]);
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    if (isPulseStatusLine(settings.statusLine)) {
      delete settings.statusLine;
      console.log('Removed the Claude Pulse status line from ' + SETTINGS);
    }
    writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    console.log('Removed Claude Pulse hooks from ' + SETTINGS + ' (backup: ' + backup + ')');
    // Unlike the status line, this does not depend on anything being deleted
    // below: it is Claude Code's own setting and goes on working. Say that it
    // is still there rather than leave it to be discovered.
    if (settings.autoCompactWindow !== undefined) {
      console.log('Left autoCompactWindow (' + settings.autoCompactWindow + ') in place — it is Claude Code\'s own '
        + 'setting and works without Claude Pulse. Delete that line from ' + SETTINGS + ' to undo it.');
    }
  }
  fs.rmSync(PULSE_DIR, { recursive: true, force: true });
  console.log('Removed ' + PULSE_DIR);
  // The app removes this itself when it can, but dragging it to the Trash is
  // the expected way to uninstall a DMG app — and a LaunchAgent left in the
  // user's own home folder would have launchd chasing a deleted executable at
  // every login for ever. Unlinking only: this also runs under JavaScriptCore,
  // which has no child_process.
  if (fs.existsSync(AGENT)) {
    try {
      fs.unlinkSync(AGENT);
      console.log('Removed the start-at-login agent ' + AGENT);
    } catch (e) {
      console.log('Could not remove ' + AGENT + ' — delete it by hand to stop it starting at login.');
    }
  }
  console.log('To remove the extension: delete the warroom.claude-pulse folder in ~/.vscode/extensions/');
}

main();
