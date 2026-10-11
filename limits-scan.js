#!/usr/bin/env node
/*
 * Claude Pulse limit scanner — how much of your Claude plan is left, how fast
 * you are spending it, and what to do about it. Entirely local: it reads files
 * Claude Code has already written. No API calls, no cost.
 *
 * Two sources, because neither is enough on its own:
 *
 *  1. ~/.claude.json → "cachedUsageUtilization" is the only authoritative
 *     answer to "what percent of my weekly limit is gone" on this machine.
 *     Claude Code asks the server and caches it here. But it is a cache, not a
 *     meter: it has been observed 17 hours out of date while sessions were
 *     burning tokens hard — by which point a 5-hour window has rolled over
 *     three times and the percentage describes a window that no longer exists.
 *     Trusting it alone would report 60% to someone who is actually at 95%.
 *     We only ever read it.
 *
 *  2. ~/.claude/projects/**\/*.jsonl — the transcripts, which are written as
 *     it happens. Summing their token usage into per-minute buckets gives a
 *     live spend rate. Pairing two cached readings with the tokens spent
 *     between them teaches us what one percent of the limit costs, so the
 *     cached percentage can be carried forward to now.
 *
 * That is the whole idea: an authoritative anchor plus local dead reckoning.
 * Until there are enough anchors to learn from, the scanner says so rather
 * than inventing a number — and it refuses to learn from an interval it did
 * not watch all of, or one whose step it cannot account for locally.
 *
 * It also measures each live session's context size, because a conversation
 * re-reads itself on every single turn and that is where the money actually
 * goes: on this machine, 1.70 billion cache-read tokens against 7.3 million
 * output tokens over seven days.
 *
 * Runs under Node (the VS Code extension) or the macOS app's JavaScriptCore
 * runner, which has fs/path/os but no Buffer and no relative require — hence
 * one self-contained file.
 *
 *   node limits-scan.js               prints JSON
 *   node limits-scan.js --statusline  prints one line, for Claude Code's statusLine
 *   require('./limits-scan.js')       { scan }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CONFIG = path.join(HOME, '.claude.json');
const STATE_DIR = path.join(HOME, '.claude', 'claude-pulse', 'state');
const PROJECTS = path.join(HOME, '.claude', 'projects');
const HISTORY = path.join(HOME, '.claude', 'claude-pulse', 'limits-history.json');

// A cached reading older than this is reported as stale. Claude Code refreshes
// it on its own slow schedule, so this is normal, not an error.
const STALE_MS = 20 * 60 * 1000;
// Past this fraction of a window's own length, a reading is history rather
// than status, and must not be shown as the current figure.
//
// Not a hypothetical margin. Claude Code decides when to refresh this cache by
// a sampled feature flag — `tengu_agile_glade.policy_limits_poll` was 0.01 on
// the machine this was written on — so readings 35 hours old are ordinary. A
// 35-hour-old weekly reading of 8% sat in a banner while the account's own
// usage page told a different story, and in a tenth of a 5-hour window a heavy
// session can move it twenty points. Either the local ledger can carry the
// reading forward, or the honest answer is that we do not know.
const TRUST_FRACTION = 0.1;
// Transcripts touched this recently are tracked. It has to cover the longest
// gap between two cached readings — which has been seen at 17 hours — or a
// session that went quiet in between would be dropped, re-primed near its end
// on return, and its spend in that interval silently lost. Walking the tree
// costs the same either way; this only changes how many offsets we remember.
const LEDGER_WINDOW_MS = 26 * 60 * 60 * 1000;
// Never read more than this from one file in one pass: after the app has been
// closed for a day there can be a lot of catching up to do, and the rate only
// needs recent minutes.
const LEDGER_MAX_READ = 8 * 1024 * 1024;
// First time a file is seen, start this far back so there is a usable rate
// within a minute or two instead of after the next hour.
const LEDGER_PRIME = 2 * 1024 * 1024;
const BUCKET_MS = 60 * 1000;
const BUCKETS_KEEP_MS = 26 * 60 * 60 * 1000;
// Repeated lines for one turn are written consecutively, so within a pass the
// ring only has to span one turn; across passes it only has to span the chunk
// boundary. A short ring keeps the history file small, and it is rewritten
// every time anything is spent.
const IDS_PER_FILE = 24;
// Message ids are long and random; their tail identifies them just as well.
const ID_KEY_LEN = 16;
// Enough of a session's tail to hold its last few records.
const TAIL_BYTES = 256 * 1024;
// How many turns the context share should average over before it is described
// as what every reply costs, and how far back to look for them when a tail of
// giant tool results holds fewer.
const MIN_SHARE_TURNS = 3;
const SHARE_TAIL_BYTES = 2 * 1024 * 1024;
// The spend rate, measured over the most recent completed stretch. Short
// enough to react, long enough not to swing on a single big turn.
const RATE_WINDOW_MS = 30 * 60 * 1000;
const MIN_RATE_SPAN_MS = 5 * 60 * 1000;
// A calibration pair needs a percentage step big enough to survive the fact
// that the server reports whole numbers.
const MIN_CAL_STEP = 2;
const MAX_FACTORS = 24;
// How often the "we were here" marker is persisted while nothing at all is
// being spent. It only has to be accurate to within hours, and rewriting the
// history file on every idle pass is what the change flag exists to avoid.
const HEARTBEAT_MS = 30 * 60 * 1000;
// A pair also needs enough local spend to plausibly explain its step. The
// server's percentage covers the whole account; this ledger only sees Claude
// Code. A trivial local turn next to a three-point move means the move came
// from somewhere invisible here — claude.ai, Cowork, or another machine.
const MIN_CAL_UNITS = 50000;
// Below this many pairs there is no median to take, so nothing is claimed.
// Samples still accumulate; only the confidence waits.
const MIN_CAL_SAMPLES = 3;
// Once there is a median worth comparing against, a sample this far from it is
// an artefact rather than a measurement.
const FACTOR_OUTLIER = 3;
// A factor is percentage-points-per-unit, so it is inversely proportional to
// the size of the plan's budget: changing tier invalidates every sample, and
// upgrading is exactly what someone who keeps hitting the limit does.
const FACTOR_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// A projection past this is not a warning, it is a broken factor. Say nothing
// rather than claim the week is gone, and throw the factor away.
const IMPLAUSIBLE_PERCENT = 150;

// Relative price per token. Output is the expensive part and a cached read is
// a tenth of a fresh input token. These are ratios, not prices.
const W_OUT = 5, W_IN = 1, W_CACHE_WRITE = 1.25, W_CACHE_READ = 0.1;

// Roughly what a model costs relative to Sonnet. Approximate on purpose: the
// calibration below divides any constant error straight back out, and the
// model catalog on disk carries no prices. Fable is flagged in Claude Code's
// own catalog as drawing down usage much faster than Opus.
// The third element names the class a per-model window is calibrated against:
// a window capped to one model only moves when that model is used, so dividing
// its step by the whole account's spend would learn a factor many times too
// small and the window that blocks first would be the one that never warns.
const MODEL_WEIGHT = [
  [/fable/, 3, 'fable'],
  [/opus/, 1.7, 'opus'],
  [/sonnet/, 1, 'sonnet'],
  [/haiku/, 0.33, 'haiku'],
];
// Every bucket totals this key as well as the per-model one.
const ALL = 'a';

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function ms(v) {
  // The 429 record writes seconds; everything else writes ISO or milliseconds.
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

function modelWeight(model) {
  const m = String(model || '').toLowerCase();
  for (const [re, w] of MODEL_WEIGHT) if (re.test(m)) return w;
  return 1;
}

/* Which per-model total this turn also counts towards. */
function modelClass(model) {
  const m = String(model || '').toLowerCase();
  for (const [re, , cls] of MODEL_WEIGHT) if (re.test(m)) return cls;
  return 'other';
}

/* The class a window's own spend lives in, or ALL for a whole-account one. */
function classFor(win) {
  return win.model ? modelClass(win.model) : ALL;
}

/* What one assistant turn cost, in units proportional to money. */
function turnUnits(usage, model) {
  return modelWeight(model) * (
    num(usage.output_tokens) * W_OUT +
    num(usage.input_tokens) * W_IN +
    num(usage.cache_creation_input_tokens) * W_CACHE_WRITE +
    num(usage.cache_read_input_tokens) * W_CACHE_READ);
}

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------- the windows

/* One limit window as Pulse sees it. `key` is stable so history and settings
 * can refer to it; `percent` is 0-100 and may exceed 100 once blocked. */
function windowsFrom(util) {
  const out = [];
  const seen = {};
  const add = (key, label, percent, resetsAt, extra) => {
    if (seen[key] || typeof percent !== 'number') return;
    seen[key] = true;
    out.push(Object.assign({
      key,
      label,
      percent: Math.max(0, Math.round(percent)),
      resetsAt: resetsAt || 0,
    }, extra || {}));
  };

  // Modern shape first: limits[] lists every window the account has, including
  // per-model ones, and carries the server's own severity.
  const limits = Array.isArray(util.limits) ? util.limits : [];
  for (let i = 0; i < limits.length; i++) {
    const l = limits[i] || {};
    const model = l.scope && l.scope.model && l.scope.model.display_name;
    let key, label;
    if (l.kind === 'session' || l.group === 'session') { key = 'session'; label = '5-hour limit'; }
    else if (l.kind === 'weekly_all') { key = 'weekly'; label = 'weekly limit'; }
    else if (model) { key = 'weekly_' + String(model).toLowerCase().replace(/[^a-z0-9]+/g, ''); label = 'weekly ' + model; }
    else if (l.group === 'weekly') { key = 'weekly'; label = 'weekly limit'; }
    else continue;
    const share = (util.weekly_scoped_shares || []).find((s) => s && s.limit_index === i);
    add(key, label, l.percent, ms(l.resets_at), {
      // Advisory only. Every value seen on real accounts so far is "normal",
      // so the thresholds below drive the warnings, not this.
      severity: typeof l.severity === 'string' ? l.severity : null,
      model: model || null,
      // A per-model window is capped at a slice of the weekly budget, so its
      // percentage is of that slice, not of the whole week.
      sharePercent: share ? num(share.allowance_percent_of_weekly) || null : null,
    });
  }

  // Older Claude Code versions wrote only these. Same numbers, fewer windows.
  add('session', '5-hour limit', util.five_hour && util.five_hour.utilization,
      util.five_hour && ms(util.five_hour.resets_at), {});
  add('weekly', 'weekly limit', util.seven_day && util.seven_day.utilization,
      util.seven_day && ms(util.seven_day.resets_at), {});
  for (const [k, label] of [['seven_day_opus', 'weekly Opus'], ['seven_day_sonnet', 'weekly Sonnet']]) {
    const w = util[k];
    if (w && typeof w.utilization === 'number') {
      add('weekly_' + k.replace('seven_day_', ''), label, w.utilization, ms(w.resets_at), {});
    }
  }

  const rank = { session: 0, weekly: 1 };
  const order = (k) => (rank[k] === undefined ? 2 : rank[k]);
  out.sort((a, b) => order(a.key) - order(b.key));
  return out;
}

/* Windows reset on a fixed cycle, so a reset time that has already passed
 * tells us exactly where the current window began and when it will end — even
 * though the percentage that came with it belongs to a window that is gone. */
function periodFor(key) {
  if (key === 'session') return 5 * 60 * 60 * 1000;
  return key.indexOf('weekly') === 0 ? 7 * 24 * 60 * 60 * 1000 : 0;
}

function rollForward(windows, now) {
  for (const w of windows) {
    const period = periodFor(w.key);
    w.windowStartedAt = w.resetsAt && period ? w.resetsAt - period : 0;
    if (!w.resetsAt || !period || w.resetsAt > now) continue;
    const n = Math.max(1, Math.ceil((now - w.resetsAt) / period));
    w.expired = true;
    w.cachedResetsAt = w.resetsAt;
    w.resetsAt += n * period;
    w.windowStartedAt = w.resetsAt - period;
  }
}

// -------------------------------------------------------------- reading files

/* Complete lines from a byte range. The macOS runner has no Buffer, so it
 * provides this natively; both forms return whole lines only.
 *
 * A file that cannot be opened degrades to "no new bytes", exactly as a failed
 * read already did. It is not a hypothetical: one session run under sudo, a
 * restored backup, or a transcript deleted between the statSync in walk() and
 * the open here is enough, and an escaping throw would take the whole scan
 * with it — silently, because every caller treats no output as a transient
 * blip and keeps showing the last reading it had. */
function readLines(file, offset, len) {
  if (len <= 0) return { text: '', consumed: 0 };
  try {
    if (typeof __pulseReadLines === 'function') {
      const r = __pulseReadLines(file, offset, len) || {};
      return { text: r.text || '', consumed: num(r.consumed) };
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, offset);
      if (n <= 0) return { text: '', consumed: 0 };
      const end = buf.lastIndexOf(10, n - 1);
      if (end < 0) return { text: '', consumed: 0 };
      return { text: buf.toString('utf8', 0, end), consumed: end + 1 };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', consumed: 0 };
  }
}

function walk(dir, out, cutoff) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, cutoff);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs >= cutoff) out.push({ file: full, size: st.size });
    }
  }
  return out;
}

// ----------------------------------------------------------------- the ledger

/* Per-minute spend, accumulated incrementally so each pass only reads what has
 * been appended since the last one. Subagent and workflow transcripts are
 * included: their tokens come out of the same budget.
 *
 * Transcripts write one line per content block and repeat the same usage on
 * each, so entries are keyed by message id — exactly as usage-scan.js does —
 * or a multi-block turn would be counted several times and the calibration
 * below would come out badly wrong. */
function updateLedger(hist, now) {
  let changed = false;
  if (!hist.buckets || typeof hist.buckets !== 'object') hist.buckets = {};
  if (!hist.files || typeof hist.files !== 'object') hist.files = {};
  const buckets = hist.buckets;
  const stats = {};                       // file -> newest records seen this pass
  const keep = {};
  const cutoff = now - LEDGER_WINDOW_MS;
  // When we started watching. Calibration may only use intervals that began
  // after this, because before it there are no buckets to total up.
  if (!num(hist.from)) hist.from = now;

  // Whether this pass had to skip over spend it will never count. `hist.from`
  // cannot answer that: it only says the history file is older than the
  // interval, not that every byte written during the interval was read.
  //
  // Being closed for a while is not itself a gap — the records carry their own
  // timestamps, so catching up on a file fills in the minutes it was away for.
  // What loses spend is skipping bytes, which the flags below catch exactly.
  // The one thing they cannot see is a session that was written and then went
  // quiet for longer than we keep offsets, so it never comes back in walk().
  const prevSeen = num(hist.seen);
  let gap = !prevSeen || now - prevSeen > LEDGER_WINDOW_MS;

  // A turn's units land in the whole-account total and in its model's own.
  const credit = (minute, cls, units) => {
    let b = buckets[minute];
    if (!b || typeof b !== 'object') b = buckets[minute] = {};
    b[ALL] = num(b[ALL]) + units;
    b[cls] = num(b[cls]) + units;
  };

  for (const { file, size } of walk(PROJECTS, [], cutoff)) {
    let rec = hist.files[file];
    if (!rec || typeof rec.off !== 'number') {
      // New file: start near the end. The past is already reflected in the
      // server's percentage; what we need from here on is the rate. Anything
      // skipped to get there is spend no bucket will ever hold.
      rec = { off: Math.max(0, size - LEDGER_PRIME), ids: {}, idQ: [] };
      if (rec.off > 0) gap = true;
    }
    // Truncated, rotated or replaced.
    if (size < rec.off) { rec = { off: Math.max(0, size - LEDGER_PRIME), ids: {}, idQ: [] }; gap = true; }
    // Far behind: skip forward rather than reading hundreds of megabytes.
    if (size - rec.off > LEDGER_MAX_READ) { rec.off = size - LEDGER_MAX_READ; gap = true; }
    if (!rec.ids) { rec.ids = {}; rec.idQ = []; }

    if (size > rec.off) {
      const chunk = readLines(file, rec.off, size - rec.off);
      if (chunk.consumed > 0) {
        for (const line of chunk.text.split('\n')) {
          if (!line || line.indexOf('"usage"') === -1) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          if (!j || j.type !== 'assistant') continue;
          const m = j.message;
          if (!m || !m.usage) continue;
          const at = ms(j.timestamp);
          if (!at) continue;
          const units = turnUnits(m.usage, m.model);
          if (!(units > 0)) continue;
          const cls = modelClass(m.model);
          const id = typeof m.id === 'string' ? m.id.slice(-ID_KEY_LEN) : null;
          const minute = Math.floor(at / BUCKET_MS);
          if (id && rec.ids[id]) {
            // Same turn seen again. Keep the larger figure, and credit it to
            // the bucket it was first counted in so history stays stable.
            const prev = rec.ids[id];
            if (units > prev.u) {
              credit(prev.m, prev.c || cls, units - prev.u);
              prev.u = units;
              changed = true;
            }
          } else {
            credit(minute, cls, units);
            changed = true;
            if (id) {
              rec.ids[id] = { m: minute, u: units, c: cls };
              rec.idQ.push(id);
              if (rec.idQ.length > IDS_PER_FILE) delete rec.ids[rec.idQ.shift()];
            }
          }
          // The newest record in this file, for context size and effort.
          // Subagent turns are counted above — they cost the same budget — but
          // their context is their own, so they must never be mistaken for the
          // conversation's size.
          if (j.isSidechain !== true) {
            const cur = stats[file];
            if (!cur || at >= cur.at) {
              stats[file] = { at, model: m.model || null, usage: m.usage, effort: j.effort || null };
            }
          }
        }
        rec.off += chunk.consumed;
        changed = true;
      } else if (size - rec.off >= LEDGER_MAX_READ) {
        changed = true;
        gap = true;
        // No newline anywhere in a full window means one line longer than the
        // window — a huge tool result on a single line will do it. The offset
        // could never advance past it, so this file would be re-read forever.
        // Skip the rest of it: a gap in the rate beats a permanent stall.
        rec.off = size;
      }
    }
    rec.size = size;
    keep[file] = rec;
  }
  // A file whose mtime left the window takes its offset with it. If it still
  // had unread bytes, those are spend nothing counted.
  for (const f of Object.keys(hist.files)) {
    if (keep[f]) continue;
    changed = true;
    const old = hist.files[f];
    if (old && num(old.off) < num(old.size)) gap = true;
  }
  hist.files = keep;

  const oldest = Math.floor((now - BUCKETS_KEEP_MS) / BUCKET_MS);
  for (const k of Object.keys(buckets)) if (Number(k) < oldest) { delete buckets[k]; changed = true; }

  // The end of the most recent gap. Calibration refuses any interval that
  // began before it; once a newer anchor lands, this stops blocking by itself.
  if (gap && now > num(hist.gapAt)) { hist.gapAt = now; changed = true; }
  if (now - prevSeen > HEARTBEAT_MS) changed = true;
  hist.seen = now;
  return { stats, changed };
}

/* Units spent in (from, to], for one model class or for the whole account. */
function unitsBetween(buckets, from, to, cls) {
  const key = cls || ALL;
  let total = 0;
  const a = Math.floor(from / BUCKET_MS), b = Math.floor(to / BUCKET_MS);
  for (const k of Object.keys(buckets)) {
    const m = Number(k);
    if (m > a && m <= b) {
      const v = buckets[k];
      total += typeof v === 'object' && v ? num(v[key]) : 0;
    }
  }
  return total;
}

// ------------------------------------------------------------ the calibration

/* Samples still usable: learned on this plan tier, and recent enough. A
 * factor is percentage-points-per-unit, so it scales with the plan's budget —
 * an upgrade makes every earlier sample wrong by the ratio of the two. */
function usableFactors(list, plan, now) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (!s || !(num(s.f) > 0)) continue;
    if (plan && s.tier && s.tier !== plan) continue;
    if (num(s.t) && now - num(s.t) > FACTOR_MAX_AGE_MS) continue;
    out.push(num(s.f));
  }
  return out;
}

/* What one percent of a window costs, learned by pairing two cached readings
 * with the tokens spent between them. Several pairs, median, so one odd
 * interval cannot skew it — which is only true once there are several, so
 * nothing is claimed below MIN_CAL_SAMPLES.
 *
 * A pair is only usable if this ledger can actually account for the step it
 * describes. Three ways it cannot, each of which would teach a factor several
 * times too large and then assert it with a full-screen banner:
 *
 *   - bytes were skipped during the interval (hist.gapAt),
 *   - the step came from a surface with no local transcript at all — claude.ai
 *     and Cowork are 12% of this account's week, and they arrive in bursts,
 *   - there was barely any local spend to divide by. */
function calibrate(hist, windows, fetchedAt, now, plan, ccShare) {
  let changed = false;
  if (!Array.isArray(hist.anchors)) { hist.anchors = []; changed = true; }
  if (!hist.factors || typeof hist.factors !== 'object') { hist.factors = {}; changed = true; }

  if (fetchedAt && !hist.anchors.some((a) => a.t === fetchedAt)) {
    changed = true;
    const w = {};
    for (const win of windows) w[win.key] = { p: win.percent, r: win.resetsAt };
    const prev = hist.anchors[hist.anchors.length - 1];
    hist.anchors.push({ t: fetchedAt, w });
    hist.anchors.sort((a, b) => a.t - b.t);
    if (hist.anchors.length > 60) hist.anchors.splice(0, hist.anchors.length - 60);

    // Learn from the step we just saw, if we read every byte written during it.
    const watched = prev && prev.t < fetchedAt && num(hist.from) && prev.t >= hist.from;
    if (watched && !(num(hist.gapAt) > prev.t)) {
      for (const win of windows) {
        const before = prev.w && prev.w[win.key];
        if (!before || typeof before.p !== 'number') continue;
        // Same window generation only: across a reset the percentage falls.
        if (win.resetsAt && before.r && before.r !== win.resetsAt) continue;
        let step = win.percent - before.p;
        if (step < MIN_CAL_STEP) continue;
        // A weekly step covers the whole account; the ledger sees only Claude
        // Code. The server's own breakdown says how much of the week that is.
        if (ccShare > 0 && win.key.indexOf('weekly') === 0) step *= ccShare;
        // A per-model window only moves when that model is used, so it is
        // calibrated against that model's own spend.
        const units = unitsBetween(hist.buckets, prev.t, fetchedAt, classFor(win));
        if (units < MIN_CAL_UNITS) continue;
        const f = step / units;
        const list = Array.isArray(hist.factors[win.key]) ? hist.factors[win.key] : [];
        // Once there is a median to compare against, keep the sample honest.
        const known = usableFactors(list, plan, now);
        if (known.length >= MIN_CAL_SAMPLES) {
          const mid = median(known);
          if (mid > 0 && (f > mid * FACTOR_OUTLIER || f < mid / FACTOR_OUTLIER)) continue;
        }
        list.push({ f, tier: plan || null, t: fetchedAt });
        if (list.length > MAX_FACTORS) list.splice(0, list.length - MAX_FACTORS);
        hist.factors[win.key] = list;
      }
    }
  }

  const out = {};
  for (const win of windows) {
    const usable = usableFactors(hist.factors[win.key], plan, now);
    const f = usable.length >= MIN_CAL_SAMPLES ? median(usable) : 0;
    if (f > 0) out[win.key] = { factor: f, samples: usable.length };
  }
  return { cal: out, changed: changed };
}

// -------------------------------------------------------------- the live view

/* The cached percentage carried forward to now, plus the rate that got it
 * there. Everything here is null when there is nothing to base it on — a
 * confidently wrong gauge is worse than an honest "not yet". */
function project(win, cal, buckets, fetchedAt, now, watchingSince) {
  const c = cal[win.key];
  const cls = classFor(win);
  // Measure over the rate window, or over however long we have been watching
  // if that is shorter — otherwise a scanner started two minutes ago divides
  // two minutes of spend by half an hour and reports a reassuring zero.
  const span = Math.max(MIN_RATE_SPAN_MS, Math.min(RATE_WINDOW_MS, now - watchingSince));
  const unitsPerHour = unitsBetween(buckets, now - span, now, cls) / (span / 3600000);

  const res = {
    unitsPerHour,
    percent: win.percent,
    // The cached reading describes a window that has since rolled over, so its
    // percentage is not merely old, it is about a window that no longer
    // exists. ~/.claude.json has been seen 13 hours out of date — several 5-hour
    // windows ago. Repeating "95%" then would be a false alarm, which is
    // exactly how a warning loses its credibility.
    expired: !!win.expired,
    // Old enough that it no longer describes this window, even though the
    // window itself has not rolled over.
    outdated: false,
    // Is there any number here worth showing at all?
    trusted: !win.expired,
    live: null,
    perHour: null,
    exhaustAt: null,
    headroomHours: null,
    beatsReset: false,
    calibrated: !!c,
    calibrationSamples: c ? c.samples : 0,
    // Set when the factor produces a figure that cannot be true. Nothing is
    // shown from it, and scan() throws the factor away so it can relearn.
    implausible: false,
  };

  const period = periodFor(win.key);
  if (!win.expired && (!fetchedAt || (period > 0 && now - fetchedAt > period * TRUST_FRACTION))) {
    res.outdated = true;
    // Only the ledger can rescue this, by carrying the reading forward below.
    res.trusted = false;
  }
  if (!c) return res;

  // After a rollover the window restarted at zero, so measure from the reset
  // rather than from the stale reading — but only if we were already watching
  // then, or we would miss spend and report a comfortable lie.
  const from = win.expired ? win.windowStartedAt : fetchedAt;
  const base = win.expired ? 0 : win.percent;
  if (win.expired && !(from && watchingSince <= from)) return res;

  const since = from ? unitsBetween(buckets, from, now, cls) : 0;
  // Never let dead reckoning walk the number backwards: the anchor is a floor.
  const raw = base + Math.max(0, since * c.factor);
  // A figure this far past the limit is not news, it is a wrong factor. The
  // old clamp turned it into a confident "200%", which the UI then rendered as
  // the most severe warning it has — the loudest possible way to be wrong.
  if (raw > IMPLAUSIBLE_PERCENT) {
    res.implausible = true;
    res.calibrated = false;
    return res;
  }
  // Past 100 the projection says nothing useful, but the anchor is never
  // walked back: an account already over its limit on credits stays over.
  res.live = Math.max(base, Math.min(100, raw));
  res.trusted = true;
  res.perHour = unitsPerHour * c.factor;

  if (res.perHour > 0.05) {
    const left = Math.max(0, 100 - res.live);
    const hours = left / res.perHour;
    res.exhaustAt = now + hours * 3600000;
    if (win.resetsAt > now) {
      res.headroomHours = hours - (win.resetsAt - now) / 3600000;
      // The question that actually matters: does it run out before it refills?
      res.beatsReset = res.headroomHours < 0;
    }
  } else if (win.resetsAt > now) {
    // Nothing being spent: the window will certainly outlast the rate.
    res.headroomHours = null;
    res.idle = true;
  }
  return res;
}

// ------------------------------------------------------- sessions & context

/* ~/.claude/projects/<cwd with every non-alphanumeric turned into "-">/<id>.jsonl.
 * A session's shell can cd elsewhere, so try every cwd the hook recorded and
 * fall back to looking the file up by name. */
function encodeCwd(c) { return String(c).replace(/[^A-Za-z0-9]/g, '-'); }

/* Returns {file, cwd}. The directory is named after the cwd the session
 * STARTED in and never changes, so whichever recorded cwd encodes to it is the
 * real project — the others are just wherever a shell command happened to run.
 * Without this the name shown is whatever directory was last touched. */
function transcriptFor(sid, cwds) {
  for (const c of cwds) {
    if (!c) continue;
    const p = path.join(PROJECTS, encodeCwd(c), sid + '.jsonl');
    try { if (fs.statSync(p).isFile()) return { file: p, cwd: c }; } catch { /* try the next one */ }
  }
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(PROJECTS, d, sid + '.jsonl');
    try {
      if (!fs.statSync(p).isFile()) continue;
    } catch { continue; }
    return { file: p, cwd: cwds.find((c) => c && encodeCwd(c) === d) || null, dir: d };
  }
  return null;
}

function applyUsage(out, usage, model, at, effort) {
  const inp = num(usage.input_tokens), cw = num(usage.cache_creation_input_tokens),
    cr = num(usage.cache_read_input_tokens), o = num(usage.output_tokens);
  // Everything the model was given: what the next turn will re-read.
  const ctx = inp + cw + cr;
  if (ctx <= 0) return;
  const cost = o * W_OUT + inp * W_IN + cw * W_CACHE_WRITE + cr * W_CACHE_READ;
  out.ctx = ctx;
  out.at = at;
  out.model = model;
  out.effort = effort;
  out.turn = { cost, contextShare: 0, turns: 0, out: o, in: inp + cw, cacheRead: cr };
}

/* How much of a reply goes on re-reading what was already said, totalled over
 * the recent turns rather than taken from the newest one.
 *
 * One turn is not a sound basis for a sentence about every turn: output
 * carries five times the weight of a cached read, so the same conversation at
 * the same size reads as 97% after "yes, that's right" and 43% after a long
 * patch. Totalling the turns measures the conversation instead of the reply. */
function addRecent(agg, usage) {
  const inp = num(usage.input_tokens), cw = num(usage.cache_creation_input_tokens),
    cr = num(usage.cache_read_input_tokens), o = num(usage.output_tokens);
  if (inp + cw + cr <= 0) return;
  agg.cost += o * W_OUT + inp * W_IN + cw * W_CACHE_WRITE + cr * W_CACHE_READ;
  agg.cacheRead += cr;
  agg.turns += 1;
}

/* The live context size, the last compaction, and any rejection. Only
 * main-conversation records count towards context: subagent traffic is marked
 * with isSidechain and carries its own separate context. */
function sessionStats(file, seed) {
  let r = statsOverTail(file, TAIL_BYTES, seed);
  // A tail made of a few enormous tool results can hold almost no turns, and
  // one turn cannot support a claim about every turn. Reach further back once.
  if (r.turn && r.turn.turns < MIN_SHARE_TURNS) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* keep what we have */ }
    if (size > TAIL_BYTES) {
      const wider = statsOverTail(file, SHARE_TAIL_BYTES, seed);
      if (wider.turn && wider.turn.turns > r.turn.turns) r = wider;
    }
  }
  return r;
}

function statsOverTail(file, bytes, seed) {
  const out = { ctx: 0, model: null, effort: null, at: 0, turn: null,
                compactedAt: 0, compactTrigger: null, preTokens: null, postTokens: null, blocked: null };
  const agg = { cost: 0, cacheRead: 0, turns: 0 };
  const seenIds = {};
  for (const line of tailOf(file, bytes)) {
    if (!line || line.charCodeAt(0) !== 123) continue;         // '{'
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || j.isSidechain === true) continue;

    if (j.type === 'system' && j.subtype === 'compact_boundary') {
      const t = ms(j.timestamp);
      if (t > out.compactedAt) {
        out.compactedAt = t;
        const meta = j.compactMetadata || {};
        out.compactTrigger = typeof meta.trigger === 'string' ? meta.trigger : null;
        out.preTokens = num(meta.preTokens) || null;
        out.postTokens = num(meta.postTokens) || null;
      }
      // Turns before a compaction were paying for a conversation that no
      // longer exists. Counting them would keep asking for a /compact that
      // has just happened.
      agg.cost = 0; agg.cacheRead = 0; agg.turns = 0;
      continue;
    }

    // A real account limit: Claude Code records the rejection it got back,
    // naming the window that ran out and when it frees up.
    const q = j.quotaLimits;
    if (q && q.status === 'rejected') {
      out.blocked = {
        kind: typeof q.rateLimitType === 'string' ? q.rateLimitType : 'unknown',
        resetsAt: ms(q.resetsAt),
        at: ms(j.timestamp),
        overage: typeof q.overageStatus === 'string' ? q.overageStatus : null,
        overageReason: typeof q.overageDisabledReason === 'string' ? q.overageDisabledReason : null,
      };
    }

    const m = j.type === 'assistant' && j.message;
    if (!m || !m.usage) continue;
    const at = ms(j.timestamp);
    if (at < out.at) continue;
    // One turn is written as several lines, each repeating the same usage.
    const id = typeof m.id === 'string' ? m.id.slice(-ID_KEY_LEN) : null;
    if (!id || !seenIds[id]) {
      if (id) seenIds[id] = true;
      addRecent(agg, m.usage);
    }
    applyUsage(out, m.usage, m.model || null, at, j.effort || null);
  }
  // The ledger already read this file's newest bytes this pass; prefer that
  // when it is fresher than anything in the tail.
  if (seed && seed.at >= out.at) applyUsage(out, seed.usage, seed.model, seed.at, seed.effort);
  // A compaction after the newest turn has already replaced the context, so
  // the size to report is what it kept, not what it dropped. Otherwise the
  // moment someone does as they were asked, Pulse asks again — this session
  // compacted 241k down to 8k and the newest turn still describes the 241k.
  if (out.compactedAt > out.at && num(out.postTokens) > 0) {
    out.ctx = out.postTokens;
    out.turn = null;                       // nothing measured since
  }
  if (out.turn) {
    out.turn.turns = agg.turns;
    out.turn.contextShare = agg.cost > 0 ? (agg.cacheRead * W_CACHE_READ) / agg.cost
      : (out.turn.cost > 0 ? (out.turn.cacheRead * W_CACHE_READ) / out.turn.cost : 0);
  }
  // A successful turn after a rejection is proof the session recovered. The
  // clock alone cannot establish that: a rejection with no resetsAt would
  // stand for ever, and a blocked report suppresses every other warning.
  if (out.blocked && out.at > out.blocked.at) out.blocked = null;
  return out;
}

function tailOf(file, bytes) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return []; }
  const start = Math.max(0, size - (bytes || TAIL_BYTES));
  const chunk = readLines(file, start, size - start);
  const lines = chunk.text.split('\n');
  if (start > 0) lines.shift();            // the first line is cut mid-way
  return lines;
}

function liveSessions(ledgerStats) {
  let files = [];
  try { files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')); } catch { return {}; }
  const out = {};
  for (const f of files) {
    const s = readJSON(path.join(STATE_DIR, f));
    if (!s || !s.state) continue;
    const sid = s.session_id || f.replace(/\.json$/, '');
    const cwds = (Array.isArray(s.cwds) && s.cwds.length ? s.cwds : [s.cwd]).filter(Boolean);
    const found = transcriptFor(sid, cwds);
    if (!found) continue;
    const file = found.file;
    const st = sessionStats(file, ledgerStats[file]);
    st.project = found.cwd ? path.basename(found.cwd)
      // Nothing matched: the folder name is the cwd with its punctuation
      // flattened, so the tail of it is the closest honest guess.
      : (found.dir ? found.dir.split('-').filter(Boolean).pop() : sid.slice(0, 8));
    st.state = s.state;
    st.updatedAt = num(s.updated_at);
    out[sid] = st;
  }
  return out;
}

// --------------------------------------------------------------- persistence

function saveHistory(hist) {
  try {
    fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
    const tmp = HISTORY + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(hist));
    fs.renameSync(tmp, HISTORY);
  } catch { /* the history is an optimisation: losing it costs a trend, not correctness */ }
}

// ------------------------------------------------------------------- the scan

function scan() {
  const now = Date.now();
  const cfg = readJSON(CONFIG) || {};
  const cached = cfg.cachedUsageUtilization || null;
  const util = (cached && cached.utilization) || null;
  const fetchedAt = cached ? num(cached.fetchedAtMs) : 0;

  const account = cfg.oauthAccount || {};
  const plan = typeof account.organizationRateLimitTier === 'string' ? account.organizationRateLimitTier : null;

  // Where the week went, by surface, from the server's own breakdown. These
  // are shares of the week's usage and sum to 100 — not shares of the limit.
  const breakdown = util && util.seven_day_breakdown && Array.isArray(util.seven_day_breakdown.rows)
    ? util.seven_day_breakdown.rows
      .filter((r) => r && typeof r.percent === 'number')
      .map((r) => ({ key: r.key, label: r.display_name || r.key, percent: r.percent }))
    : [];
  // How much of the account's own spend this ledger can see at all.
  const ccRow = breakdown.find((r) => r.key === 'claude_code');
  const ccShare = ccRow && ccRow.percent > 0 ? ccRow.percent / 100 : 0;

  let hist = readJSON(HISTORY);
  if (!hist || typeof hist !== 'object') hist = {};
  // v3: buckets hold per-model totals and factors carry their plan tier, so a
  // v2 reader and a v3 reader must not share a file.
  if (hist.v !== 3) hist = { v: 3, buckets: {}, files: {}, anchors: [], factors: {}, from: null };

  const ledger = updateLedger(hist, now);
  const ledgerStats = ledger.stats;
  const windows = util ? windowsFrom(util) : [];
  rollForward(windows, now);
  const calibration = calibrate(hist, windows, fetchedAt, now, plan, ccShare);
  const cal = calibration.cal;
  const watchingSince = num(hist.from) || now;
  let dropped = false;
  for (const w of windows) {
    w.burn = project(w, cal, hist.buckets, fetchedAt, now, watchingSince);
    // The factor produced something that cannot be true, so it is wrong. Drop
    // it and start again rather than carry it for days inside a median.
    if (w.burn.implausible && hist.factors[w.key]) { delete hist.factors[w.key]; dropped = true; }
  }
  // Several copies of this run on a timer — the menu bar app plus one per
  // VS Code window — so an unchanged pass must not rewrite the file.
  if (ledger.changed || calibration.changed || dropped) saveHistory(hist);

  const sessions = liveSessions(ledgerStats);

  // A rejection seen in any live transcript, newest first. The one certain
  // signal: the request actually came back refused.
  let blocked = null;
  for (const sid of Object.keys(sessions)) {
    const b = sessions[sid].blocked;
    if (b && b.at > (blocked ? blocked.at : 0)) blocked = Object.assign({ session: sid }, b);
  }
  // Only while it still stands — once the window has reset it is history.
  if (blocked && blocked.resetsAt && blocked.resetsAt < now) blocked = null;
  // A rejection that never said when it frees up cannot stand indefinitely:
  // the longest window it could name is the 5-hour one.
  if (blocked && !blocked.resetsAt && now - blocked.at > 5 * 3600000) blocked = null;

  const extra = (util && util.extra_usage) || null;
  const spentLastHour = unitsBetween(hist.buckets, now - 3600000, now);

  return {
    at: now,
    fetchedAt,
    ageMs: fetchedAt ? now - fetchedAt : null,
    stale: !fetchedAt || now - fetchedAt > STALE_MS,
    // No usage cache at all: an older Claude Code, a logged-out install, or an
    // API-key user with no plan limits to report.
    available: !!util,
    plan,
    windows,
    blocked,
    breakdown,
    windowStartedAt: util && util.seven_day_breakdown ? ms(util.seven_day_breakdown.window_started_at) : 0,
    // Credits are the fallback when a limit hits; worth saying when there is
    // nothing to fall back on.
    credits: extra ? {
      enabled: extra.is_enabled === true,
      percent: num(extra.utilization),
      reason: typeof extra.disabled_reason === 'string' ? extra.disabled_reason : null,
    } : null,
    sessions,
    spend: { lastHourUnits: spentLastHour, watchingSince: num(hist.from) || now },
  };
}

// --------------------------------------------------- one line, for statusLine

/* Claude Code renders a statusLine command's stdout as chrome under the
 * prompt. It is not part of the conversation, so it costs nothing — and it is
 * where someone actually looking at Claude Code will see it. */
function statusLine(r) {
  if (!r.available) return '';
  const bits = [];
  if (r.blocked) {
    bits.push('⛔ limit reached');
  } else {
    let shown = 0;
    for (const w of r.windows) {
      if (w.key !== 'session' && w.key !== 'weekly') continue;
      // Nothing worth printing for a window whose reading has aged out.
      if (!w.burn || !w.burn.trusted) continue;
      shown++;
      const projected = w.burn.live !== null;
      const live = projected ? Math.round(w.burn.live) : w.percent;
      const tag = w.key === 'session' ? '5h' : 'wk';
      // "~" means carried forward from the last cached reading rather than
      // read from it, so nobody is surprised when /usage says something else.
      bits.push((w.burn.beatsReset ? '⚠ ' : '') + tag + ' ' + (projected ? '~' : '') + live + '%');
    }
    // Claude Code refreshes its own usage cache on a sampled schedule, which
    // can leave it a day or more behind. Saying so here is worth more than a
    // stale number, because the command that fixes it is typed right here.
    if (!shown) bits.push('usage unknown — run /usage');
  }
  const big = Object.keys(r.sessions)
    .map((k) => r.sessions[k])
    .filter((s) => s.ctx > 0)
    .sort((a, b) => b.ctx - a.ctx)[0];
  if (big && big.ctx >= 120000) {
    const k = big.ctx >= 1e6 ? (big.ctx / 1e6).toFixed(2) + 'M' : Math.round(big.ctx / 1000) + 'k';
    bits.push('ctx ' + k + (big.ctx >= 300000 ? ' — /compact' : ''));
  }
  return bits.join(' · ');
}

const isNode = typeof module !== 'undefined' && !!module.exports;
if (isNode) {
  module.exports = { scan, statusLine, windowsFrom, sessionStats, turnUnits, modelWeight, modelClass };
}
if (!isNode || require.main === module) {
  const argv = (typeof process !== 'undefined' && process.argv) || [];
  const r = scan();
  process.stdout.write(argv.indexOf('--statusline') >= 0 ? statusLine(r) : JSON.stringify(r));
}
