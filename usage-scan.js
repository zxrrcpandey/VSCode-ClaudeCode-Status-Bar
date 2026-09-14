#!/usr/bin/env node
/*
 * Claude Pulse usage scanner — aggregates token usage from Claude Code
 * transcript files (~/.claude/projects/**\/*.jsonl), entirely locally.
 *
 * Prints JSON: { byDay: {date: {model: agg}}, bySession: {sid: {model: agg}} }
 * where agg = { out, inp, cw, cr }  (output, input, cache-write, cache-read).
 *
 * Incremental: keeps a byte-offset cache per file, so after the first pass
 * only newly appended lines are read. Deduplicates repeated message ids
 * (transcripts write one line per content block, repeating the same usage).
 *
 * Runs under Node (VS Code extension) or the macOS app's JavaScriptCore runner.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
// v2: offsets are counted in bytes. v1 advanced them by string index, which
// undercounts multi-byte UTF-8 (—, emoji) and re-read already-counted lines.
// A new file name, so an older extension writing v1 can't thrash the cache.
const CACHE = path.join(os.homedir(), '.claude', 'claude-pulse', 'usage-cache-v2.json');
const WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const MAX_IDS = 500;

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// The complete lines within [offset, offset+len) and how many BYTES they span.
function readCompleteLines(file, offset, len) {
  if (typeof __pulseReadLines === 'function') return __pulseReadLines(file, offset, len); // macOS runner
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
}

function localDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function bump(map, key, u, sign) {
  const t = map[key] || (map[key] = { out: 0, inp: 0, cw: 0, cr: 0 });
  t.out += sign * u.out; t.inp += sign * u.inp; t.cw += sign * u.cw; t.cr += sign * u.cr;
}

function applyUsage(rec, u, sign) {
  const day = rec.days[u.date] || (rec.days[u.date] = {});
  bump(day, u.model, u, sign);
  bump(rec.total, u.model, u, sign);
}

function parseFile(file, rec) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (rec && rec.size === st.size && rec.mtime === st.mtimeMs) return rec;
  if (!rec || st.size < rec.size) {
    rec = { size: 0, mtime: 0, offset: 0, days: {}, total: {}, ids: {}, idQ: [] };
  }
  const len = st.size - rec.offset;
  if (len > 0) {
    let chunk;
    try { chunk = readCompleteLines(file, rec.offset, len); } catch { return rec; }
    if (chunk.consumed > 0) {
      for (const line of chunk.text.split('\n')) {
        if (!line || line.indexOf('"assistant"') === -1) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const m = j && j.type === 'assistant' && j.message;
        if (!m || !m.usage || !j.timestamp) continue;
        const date = localDate(j.timestamp);
        if (!date) continue;
        const u = {
          date,
          model: m.model || 'unknown',
          out: m.usage.output_tokens || 0,
          inp: m.usage.input_tokens || 0,
          cw: m.usage.cache_creation_input_tokens || 0,
          cr: m.usage.cache_read_input_tokens || 0,
        };
        const id = m.id;
        if (id && rec.ids[id]) applyUsage(rec, rec.ids[id], -1); // replace duplicate
        applyUsage(rec, u, 1);
        if (id) {
          if (!rec.ids[id]) {
            rec.idQ.push(id);
            if (rec.idQ.length > MAX_IDS) delete rec.ids[rec.idQ.shift()];
          }
          rec.ids[id] = u;
        }
      }
      rec.offset += chunk.consumed;
    }
  }
  rec.size = st.size;
  rec.mtime = st.mtimeMs;
  return rec;
}

function main() {
  let cache = { files: {} };
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) || cache; } catch { /* first run */ }
  if (!cache.files) cache.files = {};

  const cutoff = Date.now() - WINDOW_MS;
  const keep = {};
  for (const file of walk(PROJECTS, [])) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < cutoff) continue; // old files can't contain recent lines
    const rec = parseFile(file, cache.files[file]);
    if (rec) keep[file] = rec;
  }
  cache.files = keep;

  const byDay = {};
  const bySession = {};
  for (const file of Object.keys(keep)) {
    const rec = keep[file];
    for (const date of Object.keys(rec.days)) {
      const day = byDay[date] || (byDay[date] = {});
      for (const model of Object.keys(rec.days[date])) bump(day, model, rec.days[date][model], 1);
    }
    const sidMatch = path.relative(PROJECTS, file).match(UUID_RE);
    if (sidMatch) {
      const sess = bySession[sidMatch[0]] || (bySession[sidMatch[0]] = {});
      for (const model of Object.keys(rec.total)) bump(sess, model, rec.total[model], 1);
    }
  }

  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    const tmp = CACHE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE);
  } catch { /* cache is an optimization only */ }

  process.stdout.write(JSON.stringify({ byDay, bySession, at: Date.now() }));
}

main();
