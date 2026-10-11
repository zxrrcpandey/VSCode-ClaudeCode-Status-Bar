#!/usr/bin/env node
/*
 * Makes Claude Code compact a conversation by itself, earlier than it would.
 *
 * Claude Code already compacts automatically — but only once the model's whole
 * window is full, which on a 1M-context model means about 966k tokens. By then
 * every reply has been re-reading most of a million tokens for a long time.
 * Its own `autoCompactWindow` setting moves that point; this sets it, so the
 * thing Pulse keeps asking for happens without anyone remembering to do it.
 *
 * Replayed over a real week of transcripts on the machine this was written on,
 * a 250k window made the main conversations 46% cheaper for the same work, at
 * the price of compacting about twice as often.
 *
 *   node scripts/set-autocompact.js                  compact at 250k
 *   node scripts/set-autocompact.js --tokens 400000  …or somewhere else
 *   node scripts/set-autocompact.js --remove         back to Claude Code's default
 *
 * What Claude Code does with the setting, checked against 2.1.296 with
 * `claude -p /autocompact`:
 *   - a model's own entry in modelSettings beats the top-level value, and that
 *     is where /autocompact saves — so an entry left at "auto", or at a larger
 *     number, would quietly exempt that model. Those are taken out, and
 *     remembered so --remove can put them back. Smaller ones are left alone:
 *     compacting earlier than asked is somebody's deliberate choice.
 *   - CLAUDE_CODE_AUTO_COMPACT_WINDOW beats everything, so with that in place
 *     this would change nothing and says so instead.
 *
 * Like the other installers: backs settings.json up first, writes atomically.
 * Runs under Node or the macOS app's JavaScriptCore runner.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CONFIG = path.join(HOME, '.claude.json');
const PULSE_DIR = path.join(HOME, '.claude', 'claude-pulse');
// Which per-model entries were taken out, so they can be put back.
const MEMO = path.join(PULSE_DIR, 'autocompact.json');
const DEFAULT_TOKENS = 250000;
// Claude Code's own bounds. Outside them it ignores the value without a word.
const MIN = 100000, MAX = 1000000;

function writeFileAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function k(n) { return n >= 1e6 ? (n / 1e6) + 'M' : Math.round(n / 1000) + 'k'; }

function valid(v) { return typeof v === 'number' && v % 1 === 0 && v >= MIN && v <= MAX; }

function main() {
  const argv = process.argv.slice(2);
  const remove = argv.indexOf('--remove') >= 0;

  let tokens = DEFAULT_TOKENS;
  const at = argv.indexOf('--tokens');
  if (at >= 0) {
    tokens = Number(argv[at + 1]);
    if (!valid(tokens)) {
      console.error('ERROR: --tokens needs a whole number from ' + MIN + ' to ' + MAX
        + ' — Claude Code ignores anything else.');
      process.exit(1);
    }
  }

  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    } catch (e) {
      console.error('ERROR: ' + SETTINGS + ' is not valid JSON — not touching it.');
      console.error(String(e.message || e));
      process.exit(1);
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    console.error('ERROR: ' + SETTINGS + ' does not hold a settings object — not touching it.');
    process.exit(1);
  }

  const memo = readJSON(MEMO);
  const remembered = memo && memo.models && typeof memo.models === 'object' ? memo.models : {};
  const per = settings.modelSettings && typeof settings.modelSettings === 'object'
    && !Array.isArray(settings.modelSettings) ? settings.modelSettings : null;

  if (remove) {
    const had = settings.autoCompactWindow !== undefined;
    // Only what is still absent: a model given a value since then has been
    // decided again, by someone, more recently than this file knows. And only
    // into a modelSettings this understands — anything else is left as found.
    const back = per || settings.modelSettings === undefined
      ? Object.keys(remembered).filter((name) => !(per && per[name] && per[name].autoCompactWindow !== undefined))
      : [];
    // Nothing to do is not a success. Reporting one would have the caller say
    // "back to Claude Code's default" after changing nothing.
    if (!had && back.length === 0) {
      console.error('ERROR: no auto-compact window is set in ' + SETTINGS + '.');
      process.exit(3);
    }
    backup();
    delete settings.autoCompactWindow;
    if (back.length) {
      if (!per) settings.modelSettings = {};
      for (const name of back) {
        const entry = settings.modelSettings[name];
        settings.modelSettings[name] = Object.assign({}, entry && typeof entry === 'object' ? entry : {},
          { autoCompactWindow: remembered[name] });
      }
    }
    writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    try { fs.unlinkSync(MEMO); } catch { /* there was nothing remembered */ }
    console.log('Claude Code decides when to compact again — on most models, once the context is full.');
    for (const name of back) {
      console.log('Put back ' + name + ': ' + describe(remembered[name]) + '.');
    }
    return;
  }

  // Set where it cannot work: say that, rather than write a setting that the
  // environment silently overrides and then report it as done.
  const env = settings.env && typeof settings.env === 'object' ? settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW : undefined;
  if (env !== undefined && env !== null && String(env) !== '') {
    console.error('ERROR: CLAUDE_CODE_AUTO_COMPACT_WINDOW is set to ' + String(env) + ' in the env section of '
      + SETTINGS + ', and Claude Code uses that instead of this setting. Change or remove it there.');
    process.exit(2);
  }

  // Entries that would exempt their model from what is being asked for.
  const loose = [];
  for (const name of Object.keys(per || {})) {
    const v = per[name] && typeof per[name] === 'object' ? per[name].autoCompactWindow : undefined;
    if (v === 'auto' || (typeof v === 'number' && v > tokens)) loose.push(name);
  }

  if (settings.autoCompactWindow === tokens && loose.length === 0) {
    console.log('Already set: Claude Code compacts a conversation by itself at ' + k(tokens) + ' tokens.');
    note(settings);
    return;
  }

  backup();
  settings.autoCompactWindow = tokens;
  for (const name of loose) {
    // The newest value wins: this script never writes one of these, so an
    // entry that has reappeared since the last run is a fresh choice made in
    // Claude Code, and that is the one to give back.
    remembered[name] = per[name].autoCompactWindow;
    delete per[name].autoCompactWindow;
    if (Object.keys(per[name]).length === 0) delete per[name];
  }
  if (loose.length && Object.keys(per).length === 0) delete settings.modelSettings;
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

  // After the settings, so a failed write leaves nothing claiming otherwise.
  // Losing this costs the undo of a per-model entry, never the setting.
  try {
    if (Object.keys(remembered).length) {
      fs.mkdirSync(PULSE_DIR, { recursive: true });
      writeFileAtomic(MEMO, JSON.stringify({ v: 1, models: remembered }));
    }
  } catch { /* best effort */ }

  console.log('Claude Code will now compact a conversation by itself at ' + k(tokens) + ' tokens.');
  for (const name of loose) {
    console.log(name + ' had its own setting (' + describe(remembered[name]) + '); it follows this one now.');
  }
  console.log('Conversations already open pick it up when they are next started.');
  note(settings);
}

function describe(v) {
  return v === 'auto' ? 'auto' : typeof v === 'number' ? k(v) + ' tokens' : String(v);
}

/* The window is only acted on while auto-compact itself is on. It can be
 * switched off in /config, which lands in either file. */
function note(settings) {
  const cfg = readJSON(CONFIG);
  if (settings.autoCompactEnabled === false || (cfg && cfg.autoCompactEnabled === false)) {
    console.log('Note: auto-compact is switched off in Claude Code — turn it on in /config, '
      + 'or this has nothing to act on.');
  }
}

/* Only ever immediately before settings.json is actually rewritten, so a no-op
 * or a refusal never leaves another whole copy of the file behind. */
function backup() {
  if (!fs.existsSync(SETTINGS)) return;
  const backupFile = SETTINGS + '.claude-pulse-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(SETTINGS, backupFile);
  console.log('Backed up settings to ' + backupFile);
  prune();
}

/* Keep the newest few: these are whole copies of settings.json. */
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
