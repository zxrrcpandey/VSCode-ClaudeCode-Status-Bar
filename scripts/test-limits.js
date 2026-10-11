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
  // Averaged over the main-conversation turns, not taken from the newest one:
  // output weighs five times a cached read, so the same conversation at the
  // same size reads as 97% after "yes, that's right" and 43% after a long
  // patch. One turn cannot support a sentence about every turn.
  const cost = (inp, cw, cr, out) => out * 5 + inp + cw * 1.25 + cr * 0.1;
  const wantShare = (50000 + 196000) * 0.1
    / (cost(2, 1000, 50000, 500) + cost(2, 4000, 196000, 1000));
  ok('  …context share is averaged over the recent turns',
    Math.abs(s.turn.contextShare - wantShare) < 1e-9,
    s.turn.contextShare.toFixed(4) + ' (want ' + wantShare.toFixed(4) + ')');
  check('  …and reports how many turns that was', s.turn.turns, 2);
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

/* A history file the calibration can learn from: an earlier anchor, the spend
 * between it and the cached reading, and a record of having been watching the
 * whole time. `priors` stands in for the earlier pairs a real machine collects
 * over days — the median needs three before anything is claimed. */
function seedHistory(home, { from, seen, buckets, anchors, factors, gapAt, v }) {
  fs.writeFileSync(path.join(home, '.claude', 'claude-pulse', 'limits-history.json'), JSON.stringify({
    v: v || 3, from, seen, buckets, files: {}, factors: factors || {}, anchors, gapAt,
  }));
}

/* One minute's spend, in the per-model shape the ledger keeps. */
function bucket(units, cls) {
  const b = { a: units };
  b[cls || 'opus'] = units;
  return b;
}

{
  // Calibration: readings of the same window plus the spend between them teach
  // the scanner what one percent costs. Seeded directly, because it needs a
  // history that predates the interval.
  const home = newHome();
  const now = Date.now();
  const t0 = now - 60 * MIN, t1 = now - 10 * MIN;
  const resets = { session: now + 3600000, weekly: now + 3 * 86400000 };
  writeConfig(home, LIMITS_UTIL(5, 18, resets), t1);
  const buckets = {};
  // 100000 units spent between the two readings, 20000 more since.
  for (let i = 0; i < 10; i++) buckets[Math.floor((t0 + (i + 1) * 4 * MIN) / MIN)] = bucket(10000);
  for (let i = 0; i < 2; i++) buckets[Math.floor((t1 + (i + 1) * MIN) / MIN)] = bucket(10000);
  // weekly went 10% -> 18% over 100000 units. Only 88% of this account's week
  // is Claude Code, which is all this ledger can see, so the step it may claim
  // is 8 × 0.88 — and one percent of the week therefore costs ~14200 units.
  const factor = (8 * 0.88) / 100000;
  seedHistory(home, {
    from: t0 - MIN, seen: now - MIN, buckets,
    factors: { weekly: [{ f: factor, tier: 'default_claude_max_20x', t: t0 - 2 * MIN },
                        { f: factor, tier: 'default_claude_max_20x', t: t0 - MIN }] },
    anchors: [{ t: t0, w: { session: { p: 2, r: resets.session }, weekly: { p: 10, r: resets.weekly } } }],
  });
  const r = scan(home);
  const weekly = r.windows.find((w) => w.key === 'weekly');
  ok('readings + the spend between them calibrate the window', weekly.burn.calibrated === true);
  check('  …on three samples, not one', weekly.burn.calibrationSamples, 3);
  // 20000 units since the reading is a further 1.41%.
  ok('  …and the cached percent is carried forward to now',
    Math.abs(weekly.burn.live - (18 + 20000 * factor)) < 0.05,
    weekly.burn.live && weekly.burn.live.toFixed(2) + '%');
  ok('  …a per-hour rate comes out of it', weekly.burn.perHour > 0, weekly.burn.perHour);
  ok('  …and a projected exhaustion time', weekly.burn.exhaustAt > now, new Date(weekly.burn.exhaustAt).toISOString());
  ok('  …JSON carries no Infinity (it would serialise as null)',
    JSON.stringify(r).indexOf('Infinity') === -1);
}

{
  // One pair is not a median. The step is the difference of two whole numbers,
  // so a reported 2 means anywhere in [1.5, 2.5) — one sample can be 25% out
  // before the ledger has contributed any error of its own.
  const home = newHome();
  const now = Date.now();
  const t0 = now - 60 * MIN, t1 = now - 10 * MIN;
  const resets = { session: now + 3600000, weekly: now + 3 * 86400000 };
  writeConfig(home, LIMITS_UTIL(5, 18, resets), t1);
  const buckets = {};
  for (let i = 0; i < 10; i++) buckets[Math.floor((t0 + (i + 1) * 4 * MIN) / MIN)] = bucket(10000);
  seedHistory(home, {
    from: t0 - MIN, seen: now - MIN, buckets,
    anchors: [{ t: t0, w: { weekly: { p: 10, r: resets.weekly } } }],
  });
  const weekly = scan(home).windows.find((w) => w.key === 'weekly');
  check('one pair alone claims nothing', weekly.burn.calibrated, false);
  check('  …and no live figure with it', weekly.burn.live, null);
}

{
  // The server's percentage covers the whole account; this ledger only sees
  // Claude Code. An afternoon in claude.ai moves the percentage with almost no
  // local spend to divide by, and the resulting factor was thousands of times
  // too large — then asserted at 200% with a full-screen banner.
  const home = newHome();
  const now = Date.now();
  const t0 = now - 60 * MIN, t1 = now - 10 * MIN;
  const resets = { session: now + 3600000, weekly: now + 3 * 86400000 };
  writeConfig(home, LIMITS_UTIL(5, 18, resets), t1);
  const buckets = {};
  // One trivial local turn in the whole interval: 2000 units.
  buckets[Math.floor((t0 + 5 * MIN) / MIN)] = bucket(2000);
  for (let i = 0; i < 5; i++) buckets[Math.floor((t1 + (i + 1) * MIN) / MIN)] = bucket(400000);
  seedHistory(home, {
    from: t0 - MIN, seen: now - MIN, buckets,
    anchors: [{ t: t0, w: { weekly: { p: 10, r: resets.weekly } } }],
  });
  const weekly = scan(home).windows.find((w) => w.key === 'weekly');
  check('a step with almost no local spend behind it is not a measurement', weekly.burn.calibrated, false);
  check('  …so no figure is carried forward from it', weekly.burn.live, null);
  const hist = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'claude-pulse', 'limits-history.json'), 'utf8'));
  check('  …and nothing is remembered to poison the median later',
    (hist.factors.weekly || []).length, 0);
}

{
  // Bytes were skipped during the interval, so the ledger holds part of the
  // spend and dividing by it would learn a factor several times too large.
  // Being closed is not itself a gap — records carry timestamps, so catching
  // up fills the minutes in — but skipping bytes is, and it is recorded.
  const home = newHome();
  const now = Date.now();
  const t0 = now - 60 * MIN, t1 = now - 10 * MIN;
  const resets = { session: now + 3600000, weekly: now + 3 * 86400000 };
  writeConfig(home, LIMITS_UTIL(5, 18, resets), t1);
  const buckets = {};
  for (let i = 0; i < 10; i++) buckets[Math.floor((t0 + (i + 1) * 4 * MIN) / MIN)] = bucket(10000);
  const factor = (8 * 0.88) / 100000;
  seedHistory(home, {
    from: t0 - MIN, seen: now - MIN, buckets,
    gapAt: t0 + 5 * MIN,                       // bytes skipped inside the interval
    factors: { weekly: [{ f: factor, t: t0 - 2 * MIN }, { f: factor, t: t0 - MIN }] },
    anchors: [{ t: t0, w: { weekly: { p: 10, r: resets.weekly } } }],
  });
  scan(home);
  const hist = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'claude-pulse', 'limits-history.json'), 'utf8'));
  check('an interval with skipped bytes teaches nothing', hist.factors.weekly.length, 2);
}

{
  // A factor is percentage-points-per-unit, so it scales with the size of the
  // plan's budget. Upgrading is exactly what someone who keeps hitting the
  // limit does, and every sample learned on the old tier is then wrong by the
  // ratio of the two budgets.
  const home = newHome();
  const now = Date.now();
  const resets = { session: now + 3600000, weekly: now + 3 * 86400000 };
  writeConfig(home, LIMITS_UTIL(5, 40, resets), now - MIN);
  seedHistory(home, {
    from: now - 120 * MIN, seen: now - MIN, buckets: {},
    factors: { weekly: [
      { f: 0.001, tier: 'default_claude_pro', t: now - 60 * MIN },
      { f: 0.001, tier: 'default_claude_pro', t: now - 50 * MIN },
      { f: 0.001, tier: 'default_claude_pro', t: now - 40 * MIN },
    ] },
    anchors: [{ t: now - MIN, w: { weekly: { p: 40, r: resets.weekly } } }],
  });
  const weekly = scan(home).windows.find((w) => w.key === 'weekly');
  check('samples from another plan tier are not used', weekly.burn.calibrated, false);
}

{
  // A factor that projects past any possible percentage is wrong, whatever
  // produced it. The old code clamped to 200 and reported it as calibrated,
  // which the UI rendered as the most severe warning it has.
  const home = newHome();
  const now = Date.now();
  const t1 = now - 10 * MIN;
  const resets = { session: now + 3600000, weekly: now + 3 * 86400000 };
  writeConfig(home, LIMITS_UTIL(5, 40, resets), t1);
  const buckets = {};
  for (let i = 0; i < 5; i++) buckets[Math.floor((t1 + (i + 1) * MIN) / MIN)] = bucket(1000000);
  seedHistory(home, {
    from: now - 120 * MIN, seen: now - MIN, buckets,
    factors: { weekly: [
      { f: 0.001, tier: 'default_claude_max_20x', t: now - 60 * MIN },
      { f: 0.001, tier: 'default_claude_max_20x', t: now - 50 * MIN },
      { f: 0.001, tier: 'default_claude_max_20x', t: now - 40 * MIN },
    ] },
    anchors: [{ t: t1, w: { weekly: { p: 40, r: resets.weekly } } }],
  });
  const weekly = scan(home).windows.find((w) => w.key === 'weekly');
  check('an impossible projection is withheld rather than shown as 200%', weekly.burn.live, null);
  check('  …and flagged as what it is', weekly.burn.implausible, true);
  check('  …and not dressed up as calibrated', weekly.burn.calibrated, false);
  const hist = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'claude-pulse', 'limits-history.json'), 'utf8'));
  ok('  …and the factor behind it is thrown away so it can relearn',
    !hist.factors.weekly, JSON.stringify(hist.factors));
}

{
  // A per-model window only moves when that model is used, so dividing its
  // step by the whole account's spend learns a factor many times too small —
  // and that window is capped at half the week, so it is the one that blocks
  // first and the one that would never have warned.
  const home = newHome();
  const now = Date.now();
  const t0 = now - 60 * MIN, t1 = now - 10 * MIN;
  const resets = { session: now + 3600000, weekly: now + 3 * 86400000 };
  const util = LIMITS_UTIL(5, 18, resets);
  util.limits[2].percent = 12;                 // the Fable slice moved too
  writeConfig(home, util, t1);
  const buckets = {};
  // Three parts Sonnet to one part Fable.
  for (let i = 0; i < 9; i++) buckets[Math.floor((t0 + (i + 1) * 4 * MIN) / MIN)] = bucket(20000, 'sonnet');
  buckets[Math.floor((t0 + 40 * MIN) / MIN)] = bucket(60000, 'fable');
  seedHistory(home, {
    from: t0 - MIN, seen: now - MIN, buckets,
    anchors: [{ t: t0, w: { weekly_fable: { p: 4, r: resets.weekly } } }],
  });
  const hist = () => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'claude-pulse', 'limits-history.json'), 'utf8'));
  scan(home);
  const f = (hist().factors.weekly_fable || [])[0];
  // 8 points of Fable movement against the 60000 Fable units, not the 240000
  // the account spent in total. (Weekly windows are scaled by the 88% of the
  // week this ledger can see.)
  ok('a per-model window is calibrated against that model\'s own spend',
    f && Math.abs(f.f - (8 * 0.88) / 60000) < 1e-12, f && f.f);
}

{
  // One unreadable transcript used to throw out of readLines, through
  // updateLedger, and out of the process — in both runtimes. Every consumer
  // treats no output as a transient blip, so the gauge froze at its last
  // reading with nothing anywhere to say why.
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(62, 41, { session: now + 3600000, weekly: now + 86400000 }), now - MIN);
  writeSession(home, 'aaaaaaaa-0000-0000-0000-00000000000a', '/Users/x/fine', [
    assistant(now - MIN, usage(2, 1000, 150000, 500)),
  ]);
  const locked = path.join(home, '.claude', 'projects', encode('/Users/x/locked'));
  fs.mkdirSync(locked, { recursive: true });
  const lockedFile = path.join(locked, 'bbbbbbbb-0000-0000-0000-00000000000b.jsonl');
  fs.writeFileSync(lockedFile, JSON.stringify(assistant(now - MIN, usage(2, 10, 10, 10))) + '\n');
  fs.chmodSync(lockedFile, 0o000);
  let line = null, threw = null;
  try { line = scan(home, ['--statusline']); } catch (e) { threw = e; }
  fs.chmodSync(lockedFile, 0o644);             // so the temp dir can be cleaned
  ok('a transcript that cannot be opened does not kill the scan', !threw,
    threw ? String(threw.message).split('\n')[0] : JSON.stringify(line));
  ok('  …and the figures still come out', line && line.indexOf('wk 41%') >= 0, JSON.stringify(line));
}

{
  // A successful turn after a rejection is proof the session recovered. Only
  // the clock cleared it before, so a rejection with no resetsAt stood for
  // ever — and a blocked report suppresses every other warning there is.
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(50, 20, { session: now + 3600000, weekly: now + 86400000 }), now - MIN);
  writeSession(home, 'aaaaaaaa-0000-0000-0000-00000000000c', '/Users/x/recovered', [
    assistant(now - 10 * MIN, usage(2, 100, 1000, 10)),
    { type: 'assistant', timestamp: new Date(now - 5 * MIN).toISOString(),
      error: 'rate_limit', apiErrorStatus: 429,
      quotaLimits: { status: 'rejected', rateLimitType: 'five_hour',
                     resetsAt: Math.floor((now + 3600000) / 1000), overageStatus: 'rejected' },
      message: { id: 'msg_rejected', model: 'claude-opus-5-5', usage: usage(0, 0, 0, 0) } },
    // Switched model, or credits kicked in: it kept working.
    assistant(now - MIN, usage(2, 500, 120000, 300)),
  ]);
  const r = scan(home);
  check('a rejection the session visibly recovered from is not reported', r.blocked, null);
  ok('  …and the statusline is not stuck on "limit reached"',
    scan(home, ['--statusline']).indexOf('limit reached') === -1, JSON.stringify(scan(home, ['--statusline'])));
}

{
  // A rejection that never said when it frees up cannot stand indefinitely:
  // the longest window it could name is the 5-hour one.
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(50, 20, { session: now + 3600000, weekly: now + 86400000 }), now - MIN);
  writeSession(home, 'aaaaaaaa-0000-0000-0000-00000000000d', '/Users/x/openended', [
    { type: 'assistant', timestamp: new Date(now - 6 * 3600000).toISOString(),
      quotaLimits: { status: 'rejected', rateLimitType: 'five_hour' },
      message: { id: 'msg_noreset', model: 'claude-opus-5-5', usage: usage(0, 0, 0, 0) } },
  ]);
  check('a rejection with no reset time expires after the longest window it could mean',
    scan(home).blocked, null);
}

{
  // A reading can be far too old to describe a window that has NOT rolled
  // over. Claude Code refreshes this cache on a sampled schedule — the flag
  // was at 1% on the machine this was written on — so a 35-hour-old weekly
  // reading is ordinary, and showing its percentage as the current figure put
  // a number from two days earlier in a banner.
  const home = newHome();
  const now = Date.now();
  const fetched = now - 35 * 3600000;
  writeConfig(home, LIMITS_UTIL(1, 8, {
    session: fetched + 4 * 3600000,          // rolled over since
    weekly: now + 1.5 * 86400000,            // still the same week
  }), fetched);
  const r = scan(home);
  const week = r.windows.find((w) => w.key === 'weekly');
  check('a 35-hour-old weekly reading is not the current figure', week.burn.trusted, false);
  check('  …and is marked as out of date rather than rolled over', week.burn.outdated, true);
  check('  …no number is shown for it', week.burn.live, null);
  check('  …and the status line says what to do instead',
    scan(home, ['--statusline']), 'usage unknown — run /usage');
}

{
  // The same reading inside the window's useful life is fine.
  const home = newHome();
  const now = Date.now();
  writeConfig(home, LIMITS_UTIL(30, 40, { session: now + 3600000, weekly: now + 5 * 86400000 }), now - 5 * MIN);
  const r = scan(home);
  check('a reading minutes old is still the current figure',
    r.windows.filter((w) => w.burn.trusted).map((w) => w.key), ['session', 'weekly', 'weekly_fable']);
  check('  …and the status line shows it', scan(home, ['--statusline']), '5h 30% · wk 40%');
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

// ------------------------------------------- when a conversation goes cold

/* A usage record as newer Claude Code versions write it, saying which cache
 * lifetime the turn's write asked for. */
function cached(u, long, short) {
  return Object.assign({}, u, {
    cache_creation: { ephemeral_1h_input_tokens: long, ephemeral_5m_input_tokens: short },
  });
}

function setState(home, sid, fields) {
  const file = path.join(home, '.claude', 'claude-pulse', 'state', sid + '.json');
  fs.writeFileSync(file, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(file, 'utf8')), fields)));
}

function writeSettings(home, value) {
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    typeof value === 'string' ? value : JSON.stringify(value));
}

const FRESH = (now) => LIMITS_UTIL(5, 5, { session: now + 3600000, weekly: now + 86400000 });

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, FRESH(now), now - MIN);
  const sid = 'aaaaaaaa-0000-0000-0000-00000000000a';
  const last = now - 50 * MIN;
  writeSession(home, sid, '/Users/x/idle', [
    assistant(now - 58 * MIN, cached(usage(2, 2000, 396000, 800), 2000, 0)),
    assistant(now - 54 * MIN, cached(usage(2, 2000, 398000, 800), 2000, 0)),
    assistant(last, cached(usage(2, 2000, 400000, 800), 2000, 0)),
    // A subagent still running re-reads its own context. It does nothing to
    // keep this conversation warm, so it must not move the deadline.
    assistant(now - 5 * MIN, cached(usage(2, 500, 30000, 100), 500, 0), { isSidechain: true }),
  ], 'done');
  const s = scan(home).sessions[sid];
  check('an idle conversation goes cold an hour after its newest reply', s.cacheExpiresAt, last + 60 * MIN);
  check('  …measured from the main conversation, not a subagent still running', s.at, last);
  check('  …and the session is known to be finished', [s.state, s.waitingConfirmed], ['done', false]);
  // What a cold return costs: the whole context written back at 1.25, next to
  // the average of the recent replies that re-read it at 0.1.
  const cost = (inp, cw, cr, out) => out * 5 + inp + cw * 1.25 + cr * 0.1;
  const typical = (cost(2, 2000, 396000, 800) + cost(2, 2000, 398000, 800) + cost(2, 2000, 400000, 800)) / 3;
  const want = (402002 * 1.25) / typical;
  ok('  …a reload is priced against the recent replies', Math.abs(s.reloadTimes - want) < 1e-9,
    s.reloadTimes.toFixed(2) + '× an ordinary reply');
}

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, FRESH(now), now - MIN);
  const sid = 'aaaaaaaa-0000-0000-0000-00000000000b';
  writeSession(home, sid, '/Users/x/short', [
    assistant(now - 2 * MIN, cached(usage(2, 2000, 300000, 800), 0, 2000)),
  ], 'done');
  const s = scan(home).sessions[sid];
  check('the short cache is read from the transcript, not assumed to be an hour',
    s.cacheExpiresAt - s.at, 5 * MIN);
  check('  …and one reply is not enough to price a reload', s.reloadTimes, null);
}

{
  // Older Claude Code versions wrote no breakdown. An assumed hour would put a
  // clock time on screen that nothing supports.
  const home = newHome();
  const now = Date.now();
  writeConfig(home, FRESH(now), now - MIN);
  const sid = 'aaaaaaaa-0000-0000-0000-00000000000c';
  writeSession(home, sid, '/Users/x/old-cc', [
    assistant(now - 50 * MIN, usage(2, 2000, 400000, 800)),
  ], 'done');
  const s = scan(home).sessions[sid];
  check('no lifetime recorded → no deadline claimed', [s.cacheTtlMs, s.cacheExpiresAt], [0, 0]);
}

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, FRESH(now), now - MIN);
  const sid = 'aaaaaaaa-0000-0000-0000-00000000000d';
  const last = now - 20 * MIN;
  writeSession(home, sid, '/Users/x/quiet-turn', [
    assistant(now - 25 * MIN, cached(usage(2, 2000, 300000, 800), 2000, 0)),
    // Nothing new to cache on this one, so it says nothing about the lifetime
    // — but it was still a request, and the clock restarts with it.
    assistant(last, cached(usage(2, 0, 302000, 40), 0, 0)),
  ], 'done');
  const s = scan(home).sessions[sid];
  check('a reply that wrote nothing keeps the lifetime and restarts the clock',
    s.cacheExpiresAt, last + 60 * MIN);
}

{
  // Just compacted: the conversation the clock was running for is gone.
  const home = newHome();
  const now = Date.now();
  writeConfig(home, FRESH(now), now - MIN);
  const sid = 'aaaaaaaa-0000-0000-0000-00000000000e';
  writeSession(home, sid, '/Users/x/compacted', [
    assistant(now - 50 * MIN, cached(usage(2, 2000, 400000, 800), 2000, 0)),
    { type: 'system', subtype: 'compact_boundary', timestamp: new Date(now - 49 * MIN).toISOString(),
      compactMetadata: { trigger: 'manual', preTokens: 402002, postTokens: 9000 } },
  ], 'done');
  const s = scan(home).sessions[sid];
  check('a conversation compacted since its last reply has no deadline to warn about',
    [s.ctx, s.cacheExpiresAt], [9000, 0]);
}

{
  const home = newHome();
  const now = Date.now();
  writeConfig(home, FRESH(now), now - MIN);
  const asked = 'aaaaaaaa-0000-0000-0000-00000000000f';
  const auto = 'aaaaaaaa-0000-0000-0000-000000000010';
  const turn = [assistant(now - 50 * MIN, cached(usage(2, 2000, 400000, 800), 2000, 0))];
  writeSession(home, asked, '/Users/x/asked', turn, 'waiting');
  setState(home, asked, { reason: 'question', waiting_confirmed: true });
  writeSession(home, auto, '/Users/x/auto', turn, 'waiting');
  setState(home, auto, { reason: 'permission', waiting_confirmed: false });
  const r = scan(home);
  check('a prompt a person really has to answer is told apart', r.sessions[asked].waitingConfirmed, true);
  check('  …from a permission request Claude Code approves by itself', r.sessions[auto].waitingConfirmed, false);
}

// --------------------------------------- Claude Code's own auto-compact point

{
  const home = newHome();
  check('no settings.json → Claude Code decides, and that is what is reported',
    scan(home).autoCompact, { window: null, models: {}, env: null, off: false });
}

{
  const home = newHome();
  writeSettings(home, {
    autoCompactWindow: 250000,
    modelSettings: {
      'claude-opus-5-5': { effortLevel: 'xhigh', autoCompactWindow: 'auto' },
      'claude-fable-5-1': { autoCompactWindow: 150000 },
      'claude-opus-5': { effortLevel: 'xhigh' },
      'claude-sonnet-5-5': { autoCompactWindow: 5 },
    },
  });
  const a = scan(home).autoCompact;
  check('a top-level auto-compact window is read', a.window, 250000);
  check('  …with the models that have an entry of their own, which beats it',
    a.models, { 'claude-opus-5-5': 'auto', 'claude-fable-5-1': 150000 });
}

{
  // Claude Code ignores these without a word, so they are not "set".
  const home = newHome();
  const got = [50000, '250000', 250000.5, 2000000, null].map((v) => {
    writeSettings(home, { autoCompactWindow: v });
    return scan(home).autoCompact.window;
  });
  check('a window Claude Code would ignore is not reported as set', got, [null, null, null, null, null]);
}

{
  const home = newHome();
  writeSettings(home, { autoCompactWindow: 250000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' } });
  check('the environment variable that overrides the setting is reported', scan(home).autoCompact.env, '400000');
}

{
  const home = newHome();
  writeSettings(home, { autoCompactWindow: 250000, autoCompactEnabled: false });
  check('auto-compact switched off in settings.json is reported', scan(home).autoCompact.off, true);
  writeSettings(home, { autoCompactWindow: 250000 });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ autoCompactEnabled: false }));
  check('  …and when it is switched off in ~/.claude.json instead', scan(home).autoCompact.off, true);
}

{
  const home = newHome();
  writeSettings(home, '{ this is not json');
  check('a settings.json that cannot be parsed is not fatal',
    scan(home).autoCompact, { window: null, models: {}, env: null, off: false });
}

// When to have Claude Code fetch a new reading. The app and the extension act
// on `check.due` by running `claude -p /usage`, so a wrong answer here is
// either a figure left two days stale or a process started every minute.
{
  const now = Date.now();
  const HOUR = 60 * MIN;
  const spend = (home, at) => writeSession(home, 'chk', '/tmp/chk', [assistant(at, usage(10, 0, 50000, 2000))], 'done');
  const asked = (home, value) => fs.writeFileSync(path.join(home, '.claude', 'claude-pulse', 'usage-ask.json'),
    typeof value === 'string' ? value : JSON.stringify({ at: value }));
  const answer = (home) => { const c = scan(home).check; return [c.due, c.failed]; };

  let home = newHome();
  writeConfig(home, FRESH(now), now - 5 * MIN);
  spend(home, now - 2 * MIN);
  check('a reading five minutes old is not asked for again', scan(home).check.due, false);

  home = newHome();
  writeConfig(home, FRESH(now), now - 25 * MIN);
  spend(home, now - 10 * MIN);
  check('aged out, with tokens spent since → ask Claude Code for a new one', scan(home).check.due, true);
  asked(home, now - 25 * MIN - 5000);
  check('  …an ask that was answered does not hold the next one back', answer(home), [true, false]);
  asked(home, now + 3 * 24 * HOUR);
  check('  …nor does a stamp from the future, which is a changed clock', scan(home).check.due, true);
  asked(home, '{ not json');
  check('  …nor one that cannot be read', scan(home).check.due, true);

  home = newHome();
  writeConfig(home, FRESH(now), now - 25 * MIN);
  spend(home, now - 40 * MIN);
  check('aged out, but nothing spent since → an idle account is not polled', scan(home).check.due, false);

  home = newHome();
  writeConfig(home, FRESH(now), now - 4 * HOUR);
  spend(home, now - 10 * MIN);
  asked(home, Date.now() - 10 * 1000);
  check('asked ten seconds ago → not again, and not yet called a failure', answer(home), [false, false]);
  asked(home, now - 30 * MIN);
  check('asked half an hour ago and the reading never moved → failed, no retry yet', answer(home), [false, true]);
  asked(home, now - 3 * HOUR);
  check('  …and tried again once two hours have gone by', answer(home), [true, true]);

  home = newHome();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3 }));
  spend(home, now - 10 * MIN);
  check('an API-key install has no plan usage to fetch, and is never asked', scan(home).check.due, false);

  home = newHome();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'nobody@example.com' } }));
  check('signed in, never read, nothing spent → nothing to ask about yet', scan(home).check.due, false);
  spend(home, now - 10 * MIN);
  check('  …and once something is spent, the first reading is asked for', scan(home).check.due, true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
