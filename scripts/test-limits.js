#!/usr/bin/env node
/*
 * Regression suite for limits-scan.js — the usage/limit maths.
 *
 * Everything runs against a throwaway HOME built from scratch, so it never
 * reads or writes the real ~/.claude. Run it the same way as the waiting-state
 * suite:
 *
 *   HOME=$(mktemp -d) node scripts/test-limits.js
 *
 * (It makes its own temporary HOME anyway; the env var just makes that
 * obvious at the call site.)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const SCAN = path.join(__dirname, '..', 'limits-scan.js');
const MIN = 60 * 1000;

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

// ------------------------------------------------------------------ fixtures

function newHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-limits-'));
  fs.mkdirSync(path.join(home, '.claude', 'claude-pulse', 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}

function writeConfig(home, utilization, fetchedAtMs) {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x', emailAddress: 'nobody@example.com' },
    cachedUsageUtilization: { fetchedAtMs, accountUuid: 'uuid-should-not-leak', utilization },
  }));
}

function encode(cwd) { return cwd.replace(/[^A-Za-z0-9]/g, '-'); }

function writeSession(home, sid, cwd, lines, state) {
  const dir = path.join(home, '.claude', 'projects', encode(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(home, '.claude', 'claude-pulse', 'state', sid + '.json'), JSON.stringify({
    session_id: sid, state: state || 'working', cwd, cwds: [cwd], updated_at: Date.now(),
  }));
}

function assistant(at, usage, extra) {
  return Object.assign({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: Object.assign({ id: 'msg_' + at, model: 'claude-opus-5-5' }, { usage }),
  }, extra || {});
}

function usage(inp, cw, cr, out) {
  return {
    input_tokens: inp, cache_creation_input_tokens: cw,
    cache_read_input_tokens: cr, output_tokens: out,
  };
}

/* Normally Node. Set PULSE_LIMITS_BIN to the app's pulse-hook binary to run
 * the very same suite through JavaScriptCore instead — the runtime the macOS
 * app uses — and prove both agree:
 *
 *   PULSE_LIMITS_BIN=/Applications/ClaudePulse.app/Contents/MacOS/pulse-hook \
 *     node scripts/test-limits.js
 */
const RUNNER = process.env.PULSE_LIMITS_BIN || '';

function scan(home, args) {
  const extra = args || [];
  const [exe, argv] = RUNNER
    ? [RUNNER, ['run', SCAN].concat(extra)]
    : [process.execPath, [SCAN].concat(extra)];
  const out = cp.execFileSync(exe, argv, {
    env: Object.assign({}, process.env, { HOME: home }),
    maxBuffer: 32 * 1024 * 1024,
  }).toString();
  return extra.indexOf('--statusline') >= 0 ? out : JSON.parse(out);
}

const LIMITS_UTIL = (sessionPct, weeklyPct, resets) => ({
  limits: [
    { kind: 'session', group: 'session', percent: sessionPct, severity: 'normal', resets_at: new Date(resets.session).toISOString(), scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: weeklyPct, severity: 'normal', resets_at: new Date(resets.weekly).toISOString(), scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 1, severity: 'normal', resets_at: new Date(resets.weekly).toISOString(), scope: { model: { id: null, display_name: 'Fable' } }, is_active: false },
  ],
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }],
  seven_day_breakdown: {
    as_of: new Date().toISOString(),
    window_started_at: new Date(Date.now() - 4 * 86400000).toISOString(),
    rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 88 }, { key: 'chat', display_name: 'Chats', percent: 12 }],
  },
  extra_usage: { is_enabled: false, utilization: 0, disabled_reason: 'out_of_credits' },
});

// --------------------------------------------------------------------- tests

console.log('\nlimits-scan.js\n');

{
  const home = newHome();
  const r = scan(home);
  check('no Claude usage cache at all → not available', r.available, false);
  check('  …and no windows invented', r.windows.length, 0);
  check('  …statusline stays empty', scan(home, ['--statusline']), '');
}

{
  const home = newHome();
  const now = Date.now();
  const resets = { session: now + 2 * 3600000, weekly: now + 3 * 86400000 };
  writeConfig(home, LIMITS_UTIL(42, 61, resets), now - 5 * MIN);
  const r = scan(home);
  check('modern limits[] → three windows', r.windows.map((w) => w.key), ['session', 'weekly', 'weekly_fable']);
  check('  …percentages read straight through', r.windows.map((w) => w.percent), [42, 61, 1]);
  check('  …per-model window carries its share', r.windows[2].sharePercent, 50);
  check('  …plan is reported', r.plan, 'default_claude_max_20x');
  check('  …fresh reading is not stale', r.stale, false);
  check('  …surface breakdown survives', r.breakdown.map((b) => b.percent), [88, 12]);
  ok('  …accountUuid never leaves the config file', JSON.stringify(r).indexOf('uuid-should-not-leak') === -1);
  ok('  …nor does the account email', JSON.stringify(r).indexOf('nobody@example.com') === -1);
}

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, {
    five_hour: { utilization: 20, resets_at: new Date(now + 3600000).toISOString() },
    seven_day: { utilization: 55, resets_at: new Date(now + 86400000).toISOString() },
  }, now - MIN);
  const r = scan(home);
  check('older Claude Code (no limits[]) still works', r.windows.map((w) => w.key), ['session', 'weekly']);
  check('  …with the right numbers', r.windows.map((w) => w.percent), [20, 55]);
}

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(10, 10, { session: now + 3600000, weekly: now + 86400000 }), now - 90 * MIN);
  const r = scan(home);
  check('a reading older than 20 minutes is flagged stale', r.stale, true);
  ok('  …and its age is reported', r.ageMs > 80 * MIN, Math.round(r.ageMs / MIN) + 'm');
}

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(5, 5, { session: now + 3600000, weekly: now + 86400000 }), now - MIN);
  writeSession(home, 'aaaaaaaa-0000-0000-0000-000000000001', '/Users/x/My Project', [
    assistant(now - 3 * MIN, usage(2, 1000, 50000, 500)),
    // The newest main-conversation turn is the one that counts.
    assistant(now - 1 * MIN, usage(2, 4000, 196000, 1000)),
    // A subagent's traffic has its own context and must not be mistaken for it.
    assistant(now - 30 * 1000, usage(2, 100, 900000, 50), { isSidechain: true }),
  ]);
  const r = scan(home);
  const s = r.sessions['aaaaaaaa-0000-0000-0000-000000000001'];
  ok('live context = input + cache write + cache read of the newest main turn', !!s && s.ctx === 200002, s && s.ctx);
  check('  …sidechain traffic excluded', s.ctx > 900000, false);
  check('  …project name comes from the transcript folder, not the latest cwd', s.project, 'My Project');
  ok('  …context share is the cache-read fraction of the turn',
    Math.abs(s.turn.contextShare - (196000 * 0.1) / (196000 * 0.1 + 4000 * 1.25 + 2 + 1000 * 5)) < 1e-9,
    s.turn.contextShare.toFixed(4));
  ok('  …statusline mentions the big context', scan(home, ['--statusline']).indexOf('ctx 200k') >= 0,
    JSON.stringify(scan(home, ['--statusline'])));
}

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(5, 5, { session: now + 3600000, weekly: now + 86400000 }), now - MIN);
  writeSession(home, 'aaaaaaaa-0000-0000-0000-000000000002', '/Users/x/proj', [
    assistant(now - 10 * MIN, usage(2, 1000, 500000, 500)),
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
      timestamp: new Date(now - 5 * MIN).toISOString(),
      compactMetadata: { trigger: 'manual', preTokens: 501502, postTokens: 9000 } },
    assistant(now - 4 * MIN, usage(2, 500, 9000, 300)),
  ]);
  const s = scan(home).sessions['aaaaaaaa-0000-0000-0000-000000000002'];
  ok('a /compact is detected', s.compactedAt > 0 && s.compactTrigger === 'manual', s.compactTrigger);
  check('  …with the size it dropped from', s.preTokens, 501502);
  check('  …and context now reflects the smaller conversation', s.ctx, 9502);
}

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(99, 20, { session: now + 1800000, weekly: now + 86400000 }), now - MIN);
  writeSession(home, 'aaaaaaaa-0000-0000-0000-000000000003', '/Users/x/blocked', [
    assistant(now - 2 * MIN, usage(2, 100, 1000, 10)),
    { type: 'assistant', timestamp: new Date(now - MIN).toISOString(),
      message: { id: 'msg_block', model: 'claude-opus-5-5' },
      error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
      quotaLimits: { status: 'rejected', resetsAt: Math.floor((now + 1800000) / 1000),
        rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' } },
  ]);
  const r = scan(home);
  ok('a real 429 is reported as blocked', !!r.blocked && r.blocked.kind === 'five_hour', r.blocked && r.blocked.kind);
  ok('  …with the reset read as unix seconds, not milliseconds',
    r.blocked && Math.abs(r.blocked.resetsAt - (now + 1800000)) < 1000, r.blocked && r.blocked.resetsAt);
  ok('  …and the statusline says so', scan(home, ['--statusline']).indexOf('limit reached') >= 0);
}

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(5, 5, { session: now + 3600000, weekly: now + 86400000 }), now - MIN);
  writeSession(home, 'aaaaaaaa-0000-0000-0000-000000000004', '/Users/x/old', [
    assistant(now - 2 * MIN, usage(2, 100, 1000, 10)),
    { type: 'assistant', timestamp: new Date(now - 3 * 3600000).toISOString(),
      message: { id: 'msg_old_block', model: 'claude-opus-5-5' },
      quotaLimits: { status: 'rejected', resetsAt: Math.floor((now - 3600000) / 1000), rateLimitType: 'five_hour' } },
  ]);
  check('a 429 whose window has already reset is history, not news', scan(home).blocked, null);
}

{
  // One turn, written as several content-block lines sharing a message id —
  // exactly how transcripts record a multi-block reply. Counting it more than
  // once would wreck the calibration below.
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(5, 5, { session: now + 3600000, weekly: now + 86400000 }), now - MIN);
  const u = usage(2, 1000, 100000, 2000);
  const dup = { type: 'assistant', timestamp: new Date(now - 2 * MIN).toISOString(),
    message: { id: 'msg_same', model: 'claude-opus-5-5', usage: u } };
  writeSession(home, 'aaaaaaaa-0000-0000-0000-000000000005', '/Users/x/dedup', [dup, dup, dup]);
  const spent = scan(home).spend.lastHourUnits;
  const one = 1.7 * (2000 * 5 + 2 + 1000 * 1.25 + 100000 * 0.1);
  ok('a repeated message id is counted once, not three times',
    Math.abs(spent - one) < 1, Math.round(spent) + ' vs ' + Math.round(one) + ' for one turn');
}

{
  // Calibration: two readings of the same window plus the spend between them
  // teach the scanner what one percent costs. Seeded directly, because it
  // needs a history that predates the interval.
  const home = newHome();
  const now = Date.now();
  const t0 = now - 60 * MIN, t1 = now - 10 * MIN;
  const resets = { session: now + 3600000, weekly: now + 3 * 86400000 };
  writeConfig(home, LIMITS_UTIL(5, 18, resets), t1);
  const buckets = {};
  // 100000 units spent between the two readings, 20000 more since.
  for (let i = 0; i < 10; i++) buckets[Math.floor((t0 + (i + 1) * 4 * MIN) / MIN)] = 10000;
  for (let i = 0; i < 2; i++) buckets[Math.floor((t1 + (i + 1) * MIN) / MIN)] = 10000;
  fs.writeFileSync(path.join(home, '.claude', 'claude-pulse', 'limits-history.json'), JSON.stringify({
    v: 2, from: t0 - MIN, buckets, files: {}, factors: {},
    anchors: [{ t: t0, w: { session: { p: 2, r: resets.session }, weekly: { p: 10, r: resets.weekly } } }],
  }));
  const r = scan(home);
  const weekly = r.windows.find((w) => w.key === 'weekly');
  ok('two readings + the spend between them calibrate the window', weekly.burn.calibrated === true);
  // weekly went 10% -> 18% over 100000 units, so 1% costs 12500 units.
  // 20000 units since the reading is a further 1.6%.
  ok('  …and the cached percent is carried forward to now',
    Math.abs(weekly.burn.live - 19.6) < 0.2, weekly.burn.live && weekly.burn.live.toFixed(2) + '%');
  ok('  …a per-hour rate comes out of it', weekly.burn.perHour > 0, weekly.burn.perHour);
  ok('  …and a projected exhaustion time', weekly.burn.exhaustAt > now, new Date(weekly.burn.exhaustAt).toISOString());
  ok('  …JSON carries no Infinity (it would serialise as null)',
    JSON.stringify(r).indexOf('Infinity') === -1);
}

{
  // Nothing learnt yet: say so rather than inventing a live figure.
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(30, 40, { session: now + 3600000, weekly: now + 86400000 }), now - MIN);
  const weekly = scan(home).windows.find((w) => w.key === 'weekly');
  check('with one reading only, no live estimate is claimed', weekly.burn.calibrated, false);
  check('  …and no number is made up', weekly.burn.live, null);
  check('  …the statusline falls back to the cached percent', scan(home, ['--statusline']), '5h 30% · wk 40%');
}

{
  // ~/.claude.json has been seen 13 hours out of date. By then a 5-hour window
  // has rolled over twice and its percentage describes a window that is gone.
  const home = newHome();
  const now = Date.now();
  const fetched = now - 13 * 3600000;
  writeConfig(home, LIMITS_UTIL(95, 40, {
    session: fetched + 2 * 3600000,      // already past
    weekly: now + 2 * 86400000,          // still current
  }), fetched);
  const r = scan(home);
  const sess = r.windows.find((w) => w.key === 'session');
  const week = r.windows.find((w) => w.key === 'weekly');
  check('a window that has rolled over is marked expired', sess.burn.expired, true);
  check('  …and its stale 95% is not trusted', sess.burn.trusted, false);
  ok('  …its next reset is rolled forward into the future', sess.resetsAt > now,
    new Date(sess.resetsAt).toISOString());
  ok('  …by a whole number of 5-hour periods',
    (sess.resetsAt - sess.cachedResetsAt) % (5 * 3600000) === 0,
    (sess.resetsAt - sess.cachedResetsAt) / 3600000 + 'h');
  check('  …a window still inside its period is untouched', week.burn.expired, false);
  check('  …and is still trusted', week.burn.trusted, true);
  check('  …the statusline drops the rolled-over window, keeps the good one',
    scan(home, ['--statusline']), 'wk 40%');
}

{
  // The history file must survive being garbage.
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(7, 7, { session: now + 3600000, weekly: now + 86400000 }), now - MIN);
  fs.writeFileSync(path.join(home, '.claude', 'claude-pulse', 'limits-history.json'), '{not json at all');
  const r = scan(home);
  check('a corrupt history file is replaced, not fatal', r.windows.length, 3);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
