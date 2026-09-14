#!/usr/bin/env node
/*
 * Installs Claude Pulse hooks into ~/.claude/settings.json.
 * - Backs up settings.json first (settings.json.claude-pulse-backup-<timestamp>)
 * - Copies hooks/hook.js to ~/.claude/claude-pulse/hook.js (stable path)
 * - Idempotent: removes previous claude-pulse commands (only those) before adding
 * - Atomic writes: never leaves settings.json half-written
 *
 * Runs under Node from the repo, or under the macOS app's JavaScriptCore runner
 * (pulse-hook), which sets:
 *   PULSE_HOOK_COMMAND  the command to register (the native runner, no Node)
 *   PULSE_HOOK_SRC      where hook.js lives inside the app bundle
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const PULSE_DIR = path.join(HOME, '.claude', 'claude-pulse');
const HOOK_DEST = path.join(PULSE_DIR, 'hook.js');
const HOOK_SRC = process.env.PULSE_HOOK_SRC || path.join(__dirname, '..', 'hooks', 'hook.js');
// Matches only this project's installed hook commands — the Node flavour and
// the native runner — not arbitrary mentions. Either replaces the other.
const MARKERS = [path.join('claude-pulse', 'hook.js'), path.join('claude-pulse', 'pulse-hook')];

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'SessionEnd',
];

function isPulseCommand(h) {
  return h && typeof h.command === 'string' && MARKERS.some((m) => h.command.includes(m));
}

// Remove only our commands from a list of entry groups; keep everything else,
// including user commands that share a group with ours. Drop groups that end
// up with an empty hooks array.
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
  // 1. Read + parse existing settings. Abort on parse failure — never clobber.
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
    // 2. Backup.
    const backup = SETTINGS + '.claude-pulse-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(SETTINGS, backup);
    console.log('Backed up settings to ' + backup);
  }

  // 3. Install the hook script at a stable path (atomically — a live session's
  //    hook may execute it at any moment during a reinstall).
  fs.mkdirSync(path.join(PULSE_DIR, 'state'), { recursive: true });
  writeFileAtomic(HOOK_DEST, fs.readFileSync(HOOK_SRC, 'utf8'));
  console.log('Installed hook script at ' + HOOK_DEST);

  // 4. Merge hook entries.
  const cmd = process.env.PULSE_HOOK_COMMAND || ('node "' + HOOK_DEST + '"');
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  for (const event of EVENTS) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const kept = withoutPulse(existing);
    kept.push({ hooks: [{ type: 'command', command: cmd, timeout: 10 }] });
    settings.hooks[event] = kept;
  }

  writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log('Hooks added to ' + SETTINGS + ' for: ' + EVENTS.join(', '));
  console.log('Done. New Claude Code sessions will report their state.');
}

main();
