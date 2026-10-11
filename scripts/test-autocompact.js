#!/usr/bin/env node
/*
 * Regression suite for set-autocompact.js — the script that edits Claude
 * Code's own auto-compact setting.
 *
 * It writes to ~/.claude/settings.json, which also holds a user's hooks,
 * permissions and environment, so the thing most worth proving is what it
 * leaves alone. Everything runs against a throwaway HOME.
 *
 *   node scripts/test-autocompact.js
 *
 * Set PULSE_LIMITS_BIN to the app's pulse-hook binary to run the same suite
 * through JavaScriptCore, the runtime the macOS app uses:
 *
 *   PULSE_LIMITS_BIN=/Applications/ClaudePulse.app/Contents/MacOS/pulse-hook \
 *     node scripts/test-autocompact.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const SCRIPT = path.join(__dirname, 'set-autocompact.js');
const SCAN = path.join(__dirname, '..', 'limits-scan.js');
const RUNNER = process.env.PULSE_LIMITS_BIN || '';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + '  → ' + JSON.stringify(got) +
    (ok ? '' : '   (expected ' + JSON.stringify(want) + ')'));
  ok ? pass++ : fail++;
}
function ok(name, cond, detail) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '  → ' + detail : ''));
  cond ? pass++ : fail++;
}

function newHome(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-autocompact-'));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2) + '\n');
  }
  return home;
}

function exec(script, home, args) {
  const [exe, argv] = RUNNER ? [RUNNER, ['run', script].concat(args || [])] : [process.execPath, [script].concat(args || [])];
  const r = cp.spawnSync(exe, argv, { env: Object.assign({}, process.env, { HOME: home }), encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const run = (home, args) => exec(SCRIPT, home, args);

/* Same settings, whatever order the keys came back in: an entry that was
 * taken out and put back lands at the end of its object, which changes
 * nothing Claude Code reads. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const key of Object.keys(v).sort()) out[key] = canon(v[key]);
  return out;
}

const file = (home) => path.join(home, '.claude', 'settings.json');
const raw = (home) => fs.readFileSync(file(home), 'utf8');
const read = (home) => JSON.parse(raw(home));
const backups = (home) => fs.readdirSync(path.join(home, '.claude'))
  .filter((n) => n.indexOf('settings.json.claude-pulse-backup-') === 0);

console.log('\nset-autocompact.js' + (RUNNER ? '  (JavaScriptCore)' : '') + '\n');

{
  // A Mac where Claude Code has never written a settings file.
  const home = newHome();
  const r = run(home);
  check('with no settings.json at all, one is created', [r.code, read(home)], [0, { autoCompactWindow: 250000 }]);
  check('  …and there was nothing to back up', backups(home).length, 0);
}

{
  const before = {
    env: { FOO: 'bar' },
    permissions: { allow: ['Bash(ls:*)'], deny: [] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
    effortLevel: 'xhigh',
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } },
  };
  const home = newHome(before);
  const r = run(home);
  check('the setting is added', [r.code, read(home).autoCompactWindow], [0, 250000]);
  const after = read(home);
  delete after.autoCompactWindow;
  check('  …and everything else in settings.json is exactly as it was', after, before);
  check('  …with one backup taken first', backups(home).length, 1);
  check('  …holding the file as it was', JSON.parse(fs.readFileSync(path.join(home, '.claude', backups(home)[0]), 'utf8')), before);

  const again = run(home);
  ok('  …asking for what is already there changes nothing', again.code === 0 && again.out.indexOf('Already set') >= 0,
    again.out.trim().split('\n')[0]);
  check('  …and leaves no second backup behind', backups(home).length, 1);

  const off = run(home, ['--remove']);
  check('--remove puts the file back exactly', [off.code, read(home)], [0, before]);
  const twice = run(home, ['--remove']);
  check('  …and removing nothing is reported as nothing, not as success', twice.code, 3);
}

{
  // /autocompact inside Claude Code saves per model, and a model's own entry
  // beats the top-level one. Left alone, "auto" or a larger number would
  // quietly exempt that model from what was just asked for.
  const before = {
    modelSettings: {
      'claude-opus-5-5': { effortLevel: 'xhigh', autoCompactWindow: 'auto' },
      'claude-opus-5': { autoCompactWindow: 800000 },
      'claude-fable-5-1': { autoCompactWindow: 150000 },
    },
  };
  const home = newHome(before);
  const r = run(home);
  const s = read(home);
  check('a model left on auto is brought in line', s.modelSettings['claude-opus-5-5'], { effortLevel: 'xhigh' });
  ok('  …one set to compact later is too, and its empty entry goes with it', !('claude-opus-5' in s.modelSettings));
  check('  …one set to compact EARLIER is somebody\'s choice and stays',
    s.modelSettings['claude-fable-5-1'], { autoCompactWindow: 150000 });
  ok('  …and the user is told which were changed',
    r.out.indexOf('claude-opus-5-5 had its own setting (auto)') >= 0 && r.out.indexOf('claude-opus-5 had its own setting (800k tokens)') >= 0);

  // Changing size later must not forget what was there before the first run.
  check('choosing a different size afterwards', [run(home, ['--tokens', '400000']).code, read(home).autoCompactWindow], [0, 400000]);
  const off = run(home, ['--remove']);
  check('--remove gives every model back the setting it had', [off.code, canon(read(home))], [0, canon(before)]);
  ok('  …and forgets what it was remembering', !fs.existsSync(path.join(home, '.claude', 'claude-pulse', 'autocompact.json')));
}

{
  // The user picks a size for one model in Claude Code after Pulse set its own.
  const home = newHome({ modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 'auto' } } });
  run(home);
  const s = read(home);
  s.modelSettings = { 'claude-opus-5-5': { autoCompactWindow: 200000 } };
  fs.writeFileSync(file(home), JSON.stringify(s));
  run(home, ['--remove']);
  check('--remove does not overwrite a per-model choice made since',
    read(home), { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 200000 } } });
}

{
  // Claude Code uses the variable instead of the setting. Writing the setting
  // anyway and reporting success would be a switch that does nothing.
  const before = { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' } };
  const home = newHome(before);
  const text = raw(home);
  const r = run(home);
  check('an environment override is refused, with its own exit code', r.code, 2);
  ok('  …naming the variable', r.out.indexOf('CLAUDE_CODE_AUTO_COMPACT_WINDOW') >= 0);
  check('  …and the file is byte-for-byte untouched', raw(home), text);
  check('  …with no backup littered', backups(home).length, 0);
}

{
  const home = newHome('{ "permissions": { "allow": [ ');
  const text = raw(home);
  const r = run(home);
  check('a settings.json that is not valid JSON is refused', r.code, 1);
  check('  …and left exactly as it was', raw(home), text);
}

{
  const home = newHome({});
  const got = ['50000', '2000000', '250000.5', 'lots', ''].map((v) => run(home, ['--tokens', v]).code);
  check('a size Claude Code would silently ignore is refused', got, [1, 1, 1, 1, 1]);
  check('  …with nothing written', read(home), {});
}

{
  const home = newHome({ autoCompactEnabled: false });
  ok('auto-compact switched off in Claude Code is pointed out', run(home).out.indexOf('switched off') >= 0);
}

{
  // Each change keeps a whole copy of settings.json. Only the newest few.
  const home = newHome({});
  for (let i = 0; i < 4; i++) { run(home, ['--tokens', '250000']); run(home, ['--remove']); }
  ok('backups are pruned to the newest five', backups(home).length <= 5, backups(home).length + ' kept');
}

{
  // The other half of Pulse reads the setting back through limits-scan.js.
  const home = newHome({ modelSettings: { 'claude-fable-5-1': { autoCompactWindow: 150000 } } });
  run(home, ['--tokens', '400000']);
  const seen = JSON.parse(exec(SCAN, home).out).autoCompact;
  check('the scanner reports what the script set', seen,
    { window: 400000, models: { 'claude-fable-5-1': 150000 }, env: null, off: false });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
