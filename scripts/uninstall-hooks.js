#!/usr/bin/env node
/*
 * Removes Claude Pulse hook commands from ~/.claude/settings.json and deletes
 * ~/.claude/claude-pulse/. Backs up settings.json first. Only this project's
 * commands are removed — user hooks sharing a group are preserved.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const PULSE_DIR = path.join(HOME, '.claude', 'claude-pulse');
const MARKER = path.join('claude-pulse', 'hook.js');

function isPulseCommand(h) {
  return h && typeof h.command === 'string' && h.command.includes(MARKER);
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
    writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    console.log('Removed Claude Pulse hooks from ' + SETTINGS + ' (backup: ' + backup + ')');
  }
  fs.rmSync(PULSE_DIR, { recursive: true, force: true });
  console.log('Removed ' + PULSE_DIR);
  console.log('To remove the extension: delete the warroom.claude-pulse folder in ~/.vscode/extensions/');
}

main();
