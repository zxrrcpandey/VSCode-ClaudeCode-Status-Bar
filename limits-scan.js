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
 *     meter: it has been observed unchanged for 45 minutes while two sessions
 *     were burning tokens hard. Trusting it alone would report 60% to someone
 *     who is actually at 95%. We only ever read it.
 *
 *  2. ~/.claude/projects/**\/*.jsonl — the transcripts, which are written as
 *     it happens. Summing their token usage into per-minute buckets gives a
 *     live spend rate. Pairing two cached readings with the tokens spent
 *     between them teaches us what one percent of the limit costs, so the
 *     cached percentage can be carried forward to now.
 *
 * That is the whole idea: an authoritative anchor plus local dead reckoning.
 * Until there are two anchors to learn from, the scanner says so rather than
 * inventing a number.
 *
 * It also measures each live session's context size, because a conversation
 * re-reads itself on every single turn and that is where the money actually
 * goes: on this machine, 1.18 billion cache-read tokens against 5.4 million
 * output tokens over two days.
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
// The spend rate, measured over the most recent completed stretch. Short
// enough to react, long enough not to swing on a single big turn.
const RATE_WINDOW_MS = 30 * 60 * 1000;
const MIN_RATE_SPAN_MS = 5 * 60 * 1000;
// A calibration pair needs a percentage step big enough to survive the fact
// that the server reports whole numbers.
const MIN_CAL_STEP = 2;
const MAX_FACTORS = 24;

// Relative price per token. Output is the expensive part and a cached read is
// a tenth of a fresh input token. These are ratios, not prices.
const W_OUT = 5, W_IN = 1, W_CACHE_WRITE = 1.25, W_CACHE_READ = 0.1;

// Roughly what a model costs relative to Sonnet. Approximate on purpose: the
// calibration below divides any constant error straight back out, and the
// model catalog on disk carries no prices. Fable is flagged in Claude Code's
// own catalog as drawing down usage much faster than Opus.
const MODEL_WEIGHT = [
  [/fable/, 3],
  [/opus/, 1.7],
  [/sonnet/, 1],
  [/haiku/, 0.33],
];

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
 * provides this natively; both forms return whole lines only. */
function readLines(file, offset, len) {
  if (len <= 0) return { text: '', consumed: 0 };
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
  } catch {
    return { text: '', consumed: 0 };
  } finally {
    fs.closeSync(fd);
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

  for (const { file, size } of walk(PROJECTS, [], cutoff)) {
    let rec = hist.files[file];
    if (!rec || typeof rec.off !== 'number') {
      // New file: start near the end. The past is already reflected in the
      // server's percentage; what we need from here on is the rate.
      rec = { off: Math.max(0, size - LEDGER_PRIME), ids: {}, idQ: [] };
    }
    // Truncated, rotated or replaced.
    if (size < rec.off) rec = { off: Math.max(0, size - LEDGER_PRIME), ids: {}, idQ: [] };
    // Far behind: skip forward rather than reading hundreds of megabytes.
    if (size - rec.off > LEDGER_MAX_READ) rec.off = size - LEDGER_MAX_READ;
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
          const id = typeof m.id === 'string' ? m.id.slice(-ID_KEY_LEN) : null;
          const minute = Math.floor(at / BUCKET_MS);
          if (id && rec.ids[id]) {
            // Same turn seen again. Keep the larger figure, and credit it to
            // the bucket it was first counted in so history stays stable.
            const prev = rec.ids[id];
            if (units > prev.u) {
              buckets[prev.m] = num(buckets[prev.m]) + (units - prev.u);
              prev.u = units;
              changed = true;
            }
          } else {
            buckets[minute] = num(buckets[minute]) + units;
            changed = true;
            if (id) {
              rec.ids[id] = { m: minute, u: units };
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
  if (Object.keys(keep).length !== Object.keys(hist.files).length) changed = true;
  hist.files = keep;

  const oldest = Math.floor((now - BUCKETS_KEEP_MS) / BUCKET_MS);
  for (const k of Object.keys(buckets)) if (Number(k) < oldest) { delete buckets[k]; changed = true; }
  return { stats, changed };
}

/* Units spent in (from, to]. */
function unitsBetween(buckets, from, to) {
  let total = 0;
  const a = Math.floor(from / BUCKET_MS), b = Math.floor(to / BUCKET_MS);
  for (const k of Object.keys(buckets)) {
    const m = Number(k);
    if (m > a && m <= b) total += num(buckets[k]);
  }
  return total;
}

// ------------------------------------------------------------ the calibration

/* What one percent of a window costs, learned by pairing two cached readings
 * with the tokens spent between them. Several pairs, median, so one odd
 * interval cannot skew it. */
function calibrate(hist, windows, fetchedAt, now) {
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

    // Learn from the step we just saw, if we were watching for all of it.
    if (prev && prev.t < fetchedAt && num(hist.from) && prev.t >= hist.from) {
      const units = unitsBetween(hist.buckets, prev.t, fetchedAt);
      if (units > 0) {
        for (const win of windows) {
          const before = prev.w && prev.w[win.key];
          if (!before || typeof before.p !== 'number') continue;
          // Same window generation only: across a reset the percentage falls.
          if (win.resetsAt && before.r && before.r !== win.resetsAt) continue;
          const step = win.percent - before.p;
          if (step < MIN_CAL_STEP) continue;
          const list = Array.isArray(hist.factors[win.key]) ? hist.factors[win.key] : [];
          list.push(step / units);
          if (list.length > MAX_FACTORS) list.splice(0, list.length - MAX_FACTORS);
          hist.factors[win.key] = list;
        }
      }
    }
  }

  const out = {};
  for (const win of windows) {
    const list = hist.factors[win.key];
    const f = Array.isArray(list) && list.length ? median(list) : 0;
    if (f > 0) out[win.key] = { factor: f, samples: list.length };
  }
  return { cal: out, changed: changed };
}

// -------------------------------------------------------------- the live view

/* The cached percentage carried forward to now, plus the rate that got it
 * there. Everything here is null when there is nothing to base it on — a
 * confidently wrong gauge is worse than an honest "not yet". */
function project(win, cal, buckets, fetchedAt, now, watchingSince) {
  const c = cal[win.key];
  // Measure over the rate window, or over however long we have been watching
  // if that is shorter — otherwise a scanner started two minutes ago divides
  // two minutes of spend by half an hour and reports a reassuring zero.
  const span = Math.max(MIN_RATE_SPAN_MS, Math.min(RATE_WINDOW_MS, now - watchingSince));
  const unitsPerHour = unitsBetween(buckets, now - span, now) / (span / 3600000);

  const res = {
    unitsPerHour,
    percent: win.percent,
    // The cached reading describes a window that has since rolled over, so its
    // percentage is not merely old, it is about a window that no longer
    // exists. ~/.claude.json has been seen 13 hours out of date — several 5-hour
    // windows ago. Repeating "95%" then would be a false alarm, which is
    // exactly how a warning loses its credibility.
    expired: !!win.expired,
    // Is there any number here worth showing at all?
    trusted: !win.expired,
    live: null,
    perHour: null,
    exhaustAt: null,
    headroomHours: null,
    beatsReset: false,
    calibrated: !!c,
    calibrationSamples: c ? c.samples : 0,
  };
  if (!c) return res;

  // After a rollover the window restarted at zero, so measure from the reset
  // rather than from the stale reading — but only if we were already watching
  // then, or we would miss spend and report a comfortable lie.
  const from = win.expired ? win.windowStartedAt : fetchedAt;
  const base = win.expired ? 0 : win.percent;
  if (win.expired && !(from && watchingSince <= from)) return res;

  const since = from ? unitsBetween(buckets, from, now) : 0;
  // Never let dead reckoning walk the number backwards: the anchor is a floor.
  res.live = Math.min(200, base + Math.max(0, since * c.factor));
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
  out.turn = {
    cost,
    // How much of a turn goes on re-reading what was already said. Past
    // roughly half, compacting is the cheapest thing available.
    contextShare: cost > 0 ? (cr * W_CACHE_READ) / cost : 0,
    out: o, in: inp + cw, cacheRead: cr,
  };
}

/* The live context size, the last compaction, and any rejection. Only
 * main-conversation records count towards context: subagent traffic is marked
 * with isSidechain and carries its own separate context. */
function sessionStats(file, seed) {
  const out = { ctx: 0, model: null, effort: null, at: 0, turn: null,
                compactedAt: 0, compactTrigger: null, preTokens: null, postTokens: null, blocked: null };
  for (const line of tailOf(file)) {
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
    applyUsage(out, m.usage, m.model || null, at, j.effort || null);
  }
  // The ledger already read this file's newest bytes this pass; prefer that
  // when it is fresher than anything in the tail.
  if (seed && seed.at >= out.at) applyUsage(out, seed.usage, seed.model, seed.at, seed.effort);
  return out;
}

function tailOf(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return []; }
  const start = Math.max(0, size - TAIL_BYTES);
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

  let hist = readJSON(HISTORY);
  if (!hist || typeof hist !== 'object') hist = {};
  if (hist.v !== 2) hist = { v: 2, buckets: {}, files: {}, anchors: [], factors: {}, from: null };

  const ledger = updateLedger(hist, now);
  const ledgerStats = ledger.stats;
  const windows = util ? windowsFrom(util) : [];
  rollForward(windows, now);
  const calibration = calibrate(hist, windows, fetchedAt, now);
  const cal = calibration.cal;
  const watchingSince = num(hist.from) || now;
  for (const w of windows) w.burn = project(w, cal, hist.buckets, fetchedAt, now, watchingSince);
  // Several copies of this run on a timer — the menu bar app plus one per
  // VS Code window — so an unchanged pass must not rewrite the file.
  if (ledger.changed || calibration.changed) saveHistory(hist);

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

  const account = cfg.oauthAccount || {};
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
    plan: typeof account.organizationRateLimitTier === 'string' ? account.organizationRateLimitTier : null,
    windows,
    blocked,
    // Where the week went, by surface, from the server's own breakdown.
    breakdown: util && util.seven_day_breakdown && Array.isArray(util.seven_day_breakdown.rows)
      ? util.seven_day_breakdown.rows
        .filter((r) => r && typeof r.percent === 'number')
        .map((r) => ({ key: r.key, label: r.display_name || r.key, percent: r.percent }))
      : [],
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
    for (const w of r.windows) {
      if (w.key !== 'session' && w.key !== 'weekly') continue;
      // Nothing worth printing for a window whose reading has aged out.
      if (!w.burn || !w.burn.trusted) continue;
      const live = w.burn.live !== null ? Math.round(w.burn.live) : w.percent;
      const tag = w.key === 'session' ? '5h' : 'wk';
      bits.push((w.burn.beatsReset ? '⚠ ' : '') + tag + ' ' + live + '%');
    }
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
  module.exports = { scan, statusLine, windowsFrom, sessionStats, turnUnits, modelWeight };
}
if (!isNode || require.main === module) {
  const argv = (typeof process !== 'undefined' && process.argv) || [];
  const r = scan();
  process.stdout.write(argv.indexOf('--statusline') >= 0 ? statusLine(r) : JSON.stringify(r));
}
