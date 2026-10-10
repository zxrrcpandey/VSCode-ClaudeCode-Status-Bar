const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const STATE_DIR = path.join(os.homedir(), '.claude', 'claude-pulse', 'state');

// Busy states older than this are considered dead sessions (crashed Claude, etc.)
const WORKING_STALE_MS = 60 * 60 * 1000;
const WAITING_STALE_MS = 4 * 60 * 60 * 1000;

let item = null;
let sessions = [];
let pollTimer = null;
let tickTimer = null;
let usageData = null;
let usagePoll = null;
let usageBusy = false;
let limitsData = null;
let limitsPoll = null;
let limitsBusy = false;
let buddy = null;
let lastBuddyData = null;
let gitName = '';
const CHARACTERS = ['critter', 'robot', 'cat', 'pup', 'turtle', 'snail', 'bee', 'dragon', 'ghost'];

// The buddy addresses the user by name: claudePulse.buddyName wins, otherwise
// the first name from git config user.name. Sanitized — it lands in webview HTML.
function buddyName() {
  const cfg = vscode.workspace.getConfiguration('claudePulse').get('buddyName');
  const raw = (typeof cfg === 'string' && cfg.trim()) ? cfg : gitName;
  return String(raw).replace(/[^\p{L}\p{N} .'-]/gu, '').trim().split(/\s+/)[0] || '';
}

// The extension reads fields the hook writes, so the two must not drift. If
// hooks are installed and the deployed script differs from the bundled one,
// refresh it in place (settings.json already points at this path).
function syncInstalledHook() {
  try {
    const dest = path.join(os.homedir(), '.claude', 'claude-pulse', 'hook.js');
    if (!fs.existsSync(dest)) return;   // hooks not installed — nothing to sync
    const src = path.join(__dirname, 'hooks', 'hook.js');
    if (!fs.existsSync(src)) return;
    const want = fs.readFileSync(src, 'utf8');
    if (fs.readFileSync(dest, 'utf8') === want) return;
    const tmp = dest + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, want);
    fs.renameSync(tmp, dest);
  } catch { /* best effort — never block activation */ }
}

function detectGitName() {
  cp.execFile('git', ['config', '--get', 'user.name'], { timeout: 5000 }, (err, stdout) => {
    if (err || !stdout) return;
    gitName = stdout.trim();
    if (gitName && buddy) buddy.reload();
  });
}

// The roaming character lives in a webview view (VS Code has no free-floating
// overlay surface). It receives the same state the status bar renders.
class BuddyProvider {
  resolveWebviewView(view) {
    this.view = view;
    this.build();
    view.webview.onDidReceiveMessage((m) => {
      if (m && m.type === 'hello' && lastBuddyData) this.post(lastBuddyData);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible && lastBuddyData) this.post(lastBuddyData);
    });
    // Hiding the view via the context menu DISPOSES it (a fresh one arrives
    // through resolveWebviewView when re-enabled) — drop our reference so
    // build()/reload() never touch a disposed webview, which throws.
    view.onDidDispose(() => {
      if (this.view === view) this.view = null;
    });
  }
  build() {
    const view = this.view;
    if (!view) return;
    // The user's own character image (any PNG/GIF/WebP/SVG); falls back to
    // the built-in critter when unset or missing.
    let imgPath = vscode.workspace.getConfiguration('claudePulse').get('buddyImage');
    if (typeof imgPath !== 'string' || !imgPath.trim()) imgPath = null;
    if (imgPath && !fs.existsSync(imgPath)) imgPath = null;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: imgPath ? [vscode.Uri.file(path.dirname(imgPath))] : [],
    };
    let html = '';
    try { html = fs.readFileSync(path.join(__dirname, 'buddy.html'), 'utf8'); } catch { return; }
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const charRaw = vscode.workspace.getConfiguration('claudePulse').get('buddyCharacter');
    const character = CHARACTERS.includes(charRaw) ? charRaw : 'critter';
    // It's the user's buddy, not Claude's — title the view after them.
    try { view.title = buddyName() ? buddyName() + '’s Buddy' : 'Buddy'; } catch { /* disposed */ }
    try {
      const imgUri = imgPath ? view.webview.asWebviewUri(vscode.Uri.file(imgPath)).toString() : '';
      // Function replacers: a `$` in a path would otherwise trigger
      // String.replace's special replacement patterns.
      const name = buddyName();
      view.webview.html = html
        .replace(/{{nonce}}/g, () => nonce)
        .replace(/{{csp}}/g, () => view.webview.cspSource)
        .replace(/{{img}}/g, () => imgUri)
        .replace(/{{char}}/g, () => character)
        .replace(/{{name}}/g, () => name);
    } catch { /* view disposed between check and assignment */ }
  }
  reload() { this.build(); if (lastBuddyData) this.post(lastBuddyData); }
  post(data) {
    if (this.view && this.view.visible) {
      try { this.view.webview.postMessage(data); } catch { /* view disposed */ }
    }
  }
}

/* What the character should know about usage: the one step worth mentioning,
 * so it comments rather than chatters. Same shape the macOS app sends. */
function buddyUsage() {
  if (!limitsData || !limitsData.available) return null;
  const cfg = limitSettings();
  if (!cfg.show) return null;
  if (limitsData.blocked) {
    const b = limitsData.blocked;
    return { kind: 'blocked', tier: 3, until: b.resetsAt ? untilText(b.resetsAt) : '' };
  }
  const worst = limitWorst();
  if (worst && worst.tier >= 2 && worst.w) {
    return {
      kind: worst.w.key === 'session' ? 'session' : 'weekly',
      tier: worst.tier,
      pct: windowShown(worst.w),
      until: worst.w.resetsAt ? untilText(worst.w.resetsAt) : '',
    };
  }
  const big = Object.keys(limitsData.sessions || {})
    .map((k) => limitsData.sessions[k])
    .filter((x) => x.ctx >= cfg.contextWarn && x.turn && x.turn.contextShare >= 0.55)
    .sort((a, b) => b.ctx - a.ctx)[0];
  if (big) return { kind: 'compact', tier: 2, ctx: fmtTok(big.ctx) };
  // No kind, so the character says nothing — it only colours an idle remark.
  const weekly = (limitsData.windows || []).find((w) => w.key === 'weekly');
  return weekly && !(weekly.burn && weekly.burn.trusted === false)
    ? { calm: true, pct: windowShown(weekly) } : null;
}

function postBuddy(s, st, now) {
  const sessTok = usageData && s.session_id && usageData.bySession[s.session_id]
    ? usageRows(usageData.bySession[s.session_id]).reduce((a, r) => a + r.out, 0) : 0;
  const todayTok = usageData
    ? usageRows(sumDays(usageData.byDay, 1)).reduce((a, r) => a + r.out, 0) : 0;
  lastBuddyData = {
    state: st,
    reason: s.reason || null,
    project: s.cwd ? path.basename(s.cwd) : null,
    tool: s.tool || null,
    todos: s.todos || null,
    elapsedMs: s.started_at ? now - s.started_at : 0,
    totalMs: s.started_at && s.ended_at ? s.ended_at - s.started_at : 0,
    tokensSession: sessTok,
    tokensToday: todayTok,
    usage: buddyUsage(),
    agents: runningAgents(s, now).slice(0, 8).map((a) => ({
      type: a.type, desc: a.desc, tools: a.tools || 0, elapsedMs: now - (a.started_at || now),
    })),
  };
  if (buddy) buddy.post(lastBuddyData);
}

// How much of the plan is left. limits-scan.js reads the usage Claude Code
// already caches in ~/.claude.json and dead-reckons it forward from the
// transcripts; the macOS app runs the very same script. Child process, like
// the usage scan, so a slow disk can never stall the editor.
function refreshLimits() {
  if (limitsBusy) return;
  limitsBusy = true;
  cp.execFile(process.execPath, [path.join(__dirname, 'limits-scan.js')], {
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
  }, (err, stdout) => {
    limitsBusy = false;
    if (err || !stdout) return;
    try { limitsData = JSON.parse(stdout); render(); } catch { /* keep last data */ }
  });
}

// The same thresholds the macOS app uses, so both halves of Claude Pulse
// agree about when a number is worth worrying about.
function limitSettings() {
  const cfg = vscode.workspace.getConfiguration('claudePulse');
  const n = (key, fallback, min, max) => {
    const v = cfg.get(key);
    return typeof v === 'number' && v >= min && v <= max ? v : fallback;
  };
  const weeklyWarn = n('limitWarnWeekly', 75, 1, 100);
  const sessionWarn = n('limitWarnSession', 88, 1, 100);
  return {
    show: cfg.get('showLimits') !== false,
    contextWarn: n('contextWarnTokens', 300000, 20000, Number.MAX_SAFE_INTEGER),
    weekly: { watch: Math.max(1, weeklyWarn - 25), warn: weeklyWarn, critical: Math.min(100, weeklyWarn + 15) },
    session: { watch: Math.max(1, sessionWarn - 18), warn: sessionWarn, critical: Math.min(100, sessionWarn + 8) },
  };
}

function windowShown(w) {
  const live = w.burn && typeof w.burn.live === 'number' ? w.burn.live : w.percent;
  return Math.round(live);
}

/* Mirrors LimitPolicy.tier() in macos/Limits.swift: a high percentage only
 * counts as a warning when this pace would actually empty the window before
 * it refills — otherwise the indicator cries wolf and gets ignored. */
function limitTier(w, cfg) {
  // An aged-out reading describes a window that has already rolled over, so
  // it gets no say — a stale 95% would be a false alarm.
  if (w.burn && w.burn.trusted === false) return 0;
  const t = w.key.indexOf('weekly') === 0 ? cfg.weekly : cfg.session;
  const pct = windowShown(w);
  const calibrated = !!(w.burn && w.burn.calibrated);
  const beats = !!(w.burn && w.burn.beatsReset);
  if (pct >= t.critical) return 3;
  if (calibrated) {
    if (beats) {
      if (pct >= t.warn) return 3;
      if (pct >= t.watch || pct >= 30) return 2;
      return 1;
    }
    return pct >= t.watch ? 1 : 0;
  }
  if (pct >= t.warn) return 2;
  return pct >= t.watch ? 1 : 0;
}

/* The worst window, and how bad. Returns null when there is nothing to say. */
function limitWorst() {
  if (!limitsData || !limitsData.available) return null;
  const cfg = limitSettings();
  if (!cfg.show) return null;
  if (limitsData.blocked) return { tier: 4, blocked: limitsData.blocked, w: null };
  let best = null;
  for (const w of limitsData.windows || []) {
    const tier = limitTier(w, cfg);
    // Ties go to the window closest to running out, so the badge names the
    // one that will actually bite.
    if (!best || tier > best.tier || (tier === best.tier && tier > 0 && windowShown(w) > windowShown(best.w))) {
      best = { tier, w };
    }
  }
  return best && best.tier > 0 ? best : null;
}

function spanText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 86400) return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.max(1, Math.floor(s / 60)) + 'm';
}
function untilText(msAt) { return spanText(msAt - Date.now()); }
function agoText(ms) { return spanText(ms); }

// Token usage comes from Claude Code's own transcript files — exact and
// local. The scan runs in a child process so it can never block the UI.
function refreshUsage() {
  if (usageBusy) return;
  usageBusy = true;
  cp.execFile(process.execPath, [path.join(__dirname, 'usage-scan.js')], {
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  }, (err, stdout) => {
    usageBusy = false;
    if (err || !stdout) return;
    try { usageData = JSON.parse(stdout); render(); } catch { /* keep last data */ }
  });
}

function fmtTok(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

function shortModel(m) {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function usageRows(agg) {
  return Object.keys(agg || {})
    .map((m) => Object.assign({ model: m }, agg[m]))
    .filter((r) => r.model !== '<synthetic>' && (r.out || r.inp || r.cw))
    .sort((a, b) => b.out - a.out);
}

function sumDays(byDay, days) {
  const out = {};
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    const day = byDay && byDay[key];
    if (!day) continue;
    for (const m of Object.keys(day)) {
      const t = out[m] || (out[m] = { out: 0, inp: 0, cw: 0, cr: 0 });
      t.out += day[m].out; t.inp += day[m].inp; t.cw += day[m].cw; t.cr += day[m].cr;
    }
  }
  return out;
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// A session belongs to this window when its cwd is inside one of the
// workspace folders (or a workspace folder is inside the session's cwd,
// for windows opened on a subfolder of the repo Claude runs in).
function sessionMatchesWorkspace(s) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return false;
  // The latest cwd follows the session's shell (`cd` moves it), so match
  // against every directory the session has ever reported.
  const cwds = Array.isArray(s.cwds) && s.cwds.length ? s.cwds : (s.cwd ? [s.cwd] : []);
  return cwds.some((c) => {
    const cwd = path.resolve(c);
    return folders.some((f) => {
      const wf = path.resolve(f.uri.fsPath);
      return cwd === wf || cwd.startsWith(wf + path.sep) || wf.startsWith(cwd + path.sep);
    });
  });
}

function readSessions() {
  let files;
  try {
    files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const f of files) {
    const full = path.join(STATE_DIR, f);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue; // partially written or corrupt — skip, keep last render
    }
    if (!data || !data.state) continue;
    const age = now - (data.updated_at || 0);
    if (age > WAITING_STALE_MS) {
      // Dead session (crashed window, killed process) — clean up our own file.
      // A live session recreates it on its next event.
      try { fs.unlinkSync(full); } catch { /* raced with a writer — fine */ }
      continue;
    }
    if (data.state === 'working' && age > WORKING_STALE_MS) continue;
    out.push(data);
  }
  if (vscode.workspace.getConfiguration('claudePulse').get('allProjects') === true) return out;
  return out.filter(sessionMatchesWorkspace);
}

function getTimings() {
  const cfg = vscode.workspace.getConfiguration('claudePulse');
  const doneRaw = cfg.get('doneDisplaySeconds');
  const waitRaw = cfg.get('waitingTimeoutSeconds');
  const provRaw = cfg.get('provisionalWaitSeconds');
  return {
    doneFadeMs: (typeof doneRaw === 'number' && doneRaw >= 0 ? doneRaw : 15) * 1000,
    // <= 0 disables the downgrade (waiting shows until an event clears it)
    waitTimeoutMs: typeof waitRaw === 'number' && waitRaw > 0 ? waitRaw * 1000 : Infinity,
    // Unconfirmed permission waits: 0 = never show them (default). Claude Code
    // fires PermissionRequest for auto-approved calls too, so only a confirmed
    // signal is trustworthy; raise this if your setup never fires Notification.
    provisionalMs: typeof provRaw === 'number' && provRaw > 0 ? provRaw * 1000 : Infinity,
    showElapsed: cfg.get('showElapsed') !== false,
    showTokens: cfg.get('showTokens') !== false,
  };
}

function effectiveState(s, t, now) {
  if ((s.state === 'done' || s.state === 'error') &&
      now - (s.ended_at || s.updated_at || 0) > t.doneFadeMs) return 'idle';
  if (s.state === 'waiting') {
    // A state file with no waiting_confirmed key came from a hook older than
    // 0.10.1: no information, not "unconfirmed". Treat it the pre-0.10.1 way
    // so a half-upgraded install degrades instead of hiding every prompt.
    const confirmed = ('waiting_confirmed' in s) ? !!s.waiting_confirmed : true;
    // Age the wait from when it STARTED. Using updated_at let unrelated
    // traffic (parallel subagents) refresh it forever, pinning the item
    // yellow. A bare PermissionRequest is not proof you are needed — it fires
    // for auto-approved calls — so unconfirmed waits stay quiet unless
    // provisionalWaitSeconds says otherwise.
    const age = now - (s.waiting_since || s.updated_at || 0);
    if (!confirmed && age < t.provisionalMs) return 'working';
    // The timeout exists only because approving a permission fires no event.
    // Measure it from the confirmation (a dialog opening mid-command inherits
    // that command's old start time), and never apply it to questions or
    // agent prompts — those always end with an event that clears them.
    if (s.reason !== 'question' && s.reason !== 'agent') {
      const confAge = now - (s.confirmed_at || s.waiting_since || s.updated_at || 0);
      if (confAge > t.waitTimeoutMs) return 'working';
    }
    return 'waiting';
  }
  return s.state;
}

function pick(list, t, now) {
  const rank = { waiting: 0, working: 1, error: 2, done: 3, idle: 4 };
  let best = null;
  for (const s of list) {
    const st = effectiveState(s, t, now);
    if (!best) { best = { s, st }; continue; }
    if (rank[st] < rank[best.st] ||
        (rank[st] === rank[best.st] && (s.updated_at || 0) > (best.s.updated_at || 0))) {
      best = { s, st };
    }
  }
  return best;
}

// Subagents currently running for a session (activity within the last 15 min).
function runningAgents(s, now) {
  const list = Object.values((s && s.agents) || {});
  return list
    .filter((a) => a && a.state === 'running' && now - (a.last_seen || a.started_at || 0) < 15 * 60 * 1000)
    .sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
}
function recentDoneAgents(s, now) {
  return Object.values((s && s.agents) || {})
    .filter((a) => a && a.state === 'done' && now - (a.ended_at || 0) < 60 * 1000);
}
function agentLabel(a) {
  const d = a.desc ? a.desc : '(' + a.type + ' task)';
  return d.length > 48 ? d.slice(0, 47) + '…' : d;
}

function taskBar(done, total) {
  if (total <= 12) return '▰'.repeat(done) + '▱'.repeat(total - done);
  const filled = Math.round((done / total) * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/* The plan-limit section of the tooltip. Says plainly when a figure is the
 * last cached reading rather than a live estimate — Claude Code refreshes
 * that cache on its own slow schedule, and an overstated number is worse
 * than an honest one. */
function limitTooltip(tip) {
  const cfg = limitSettings();
  if (!cfg.show) return tip;
  if (!limitsData || !limitsData.available) {
    tip.appendMarkdown('_Plan limits appear here once Claude Code has checked them._');
    return tip;
  }
  tip.appendMarkdown('**Plan limits**\n\n');
  if (limitsData.blocked) {
    const b = limitsData.blocked;
    const which = b.kind === 'five_hour' ? '5-hour' : b.kind === 'seven_day' ? 'weekly' : b.kind;
    tip.appendMarkdown('- $(error) **blocked** — the ' + which + ' limit is used up' +
      (b.resetsAt ? ', back in ' + untilText(b.resetsAt) : '') + '\n');
  }
  for (const w of limitsData.windows || []) {
    let line;
    if (w.burn && w.burn.trusted === false) {
      line = '- **' + w.label + '** — _waiting for a fresh reading_' +
        (w.resetsAt ? ' · refills in ' + untilText(w.resetsAt) : '');
    } else {
      line = '- **' + w.label + '** — ' + windowShown(w) + '%';
      if (w.sharePercent) line += ' of its ' + Math.round(w.sharePercent) + '% share';
      if (!(w.burn && w.burn.calibrated)) line += ' _(last checked)_';
      if (w.resetsAt) line += ' · refills in ' + untilText(w.resetsAt);
    }
    tip.appendMarkdown(line + '\n');
    const b = w.burn;
    if (b && b.calibrated && b.perHour > 0.05 && b.exhaustAt) {
      tip.appendMarkdown('  - ' + (b.beatsReset ? '$(warning) ' : '') + b.perHour.toFixed(1) +
        '%/h → empty in ' + untilText(b.exhaustAt) + '\n');
    }
  }
  const big = Object.keys(limitsData.sessions || {})
    .map((k) => limitsData.sessions[k])
    .filter((s) => s.ctx >= Math.min(120000, cfg.contextWarn))
    .sort((a, b) => b.ctx - a.ctx)[0];
  if (big) {
    tip.appendMarkdown('\n**' + big.project + '** carries ' + fmtTok(big.ctx) + ' of context — ' +
      Math.round((big.turn ? big.turn.contextShare : 0) * 100) + '% of every reply is re-reading it.' +
      (big.ctx >= cfg.contextWarn ? ' `/compact` makes the next ones much cheaper.' : '') + '\n');
  }
  if (limitsData.stale && limitsData.ageMs) {
    tip.appendMarkdown('\n_Claude Code last checked this ' + agoText(limitsData.ageMs) + ' ago._');
  }
  return tip;
}

function render() {
  if (!item) return;
  const t = getTimings();
  const showElapsed = t.showElapsed;
  const now = Date.now();

  // The usage badge rides along with whatever else the item is showing. It
  // must survive the idle state too: no session running is exactly the moment
  // before the next one starts and spends the rest of the window.
  const worst = limitWorst();
  let badge = '';
  if (worst) {
    if (worst.blocked) {
      badge = ' · $(error) ' + (worst.blocked.resetsAt ? untilText(worst.blocked.resetsAt) : 'limit');
    } else {
      const tag = worst.w.key === 'session' ? '5h' : worst.w.key === 'weekly' ? 'wk' : worst.w.label;
      badge = ' · ' + (worst.tier >= 2 ? '$(warning) ' : '') + tag + ' ' + windowShown(worst.w) + '%';
    }
  }

  if (sessions.length === 0) {
    // Stay visible so the indicator never seems to vanish — a dim idle mark
    // simply means no Claude session belongs to this window right now.
    item.backgroundColor = worst && worst.tier >= 3
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : worst && worst.tier >= 2 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    item.color = undefined;
    item.text = '$(sparkle) Claude' + badge;
    item.tooltip = limitTooltip(
      new vscode.MarkdownString('No Claude Code session in this workspace yet — start one and it will appear here.\n\n', true));
    item.show();
    postBuddy({}, 'idle', now);
    return;
  }

  const best = pick(sessions, t, now);
  const s = best.s;
  const st = best.st;
  const busyCount = sessions.filter((x) => {
    const e = effectiveState(x, t, now);
    return e === 'working' || e === 'waiting';
  }).length;
  const suffix = busyCount > 1 ? ' ×' + busyCount : '';

  item.backgroundColor = undefined;
  item.color = undefined;

  if (st === 'waiting') {
    const what = s.reason === 'question' ? 'has a question'
      : s.reason === 'agent' ? 'agent needs input' : 'needs input';
    item.text = '$(bell) Claude · ' + what + suffix;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (st === 'working') {
    const spin = '$(loading~spin) ';
    if (s.todos && s.todos.total > 0) {
      item.text = spin + 'Claude · ' + s.todos.done + '/' + s.todos.total +
        ' ' + taskBar(s.todos.done, s.todos.total) + suffix;
    } else if (showElapsed && s.started_at) {
      item.text = spin + 'Claude · working ' + fmt(now - s.started_at) + suffix;
    } else {
      item.text = spin + 'Claude · working' + suffix;
    }
    if (t.showTokens && usageData && s.session_id && usageData.bySession[s.session_id]) {
      const tot = usageRows(usageData.bySession[s.session_id]).reduce((a, r) => a + r.out, 0);
      if (tot) item.text += ' · ' + fmtTok(tot);
    }
    const nAgents = runningAgents(s, now).length;
    if (nAgents) item.text += ' · ' + nAgents + (nAgents === 1 ? ' agent' : ' agents');
  } else if (st === 'error') {
    item.text = '$(warning) Claude · error' + suffix;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (st === 'done') {
    const dur = s.started_at && s.ended_at ? ' ' + fmt(s.ended_at - s.started_at) : '';
    item.text = '$(check) Claude · done' + dur + suffix;
    item.color = new vscode.ThemeColor('charts.green');
  } else {
    item.text = '$(sparkle) Claude';
  }

  if (badge) {
    item.text += badge;
    // "Claude needs input" already owns the colour when it is showing — that
    // is the more urgent thing. Otherwise the limit tier gets to set it.
    if (!item.backgroundColor && worst.tier >= 3) {
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (!item.backgroundColor && worst.tier >= 2) {
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
  }

  const tip = new vscode.MarkdownString(undefined, true);
  tip.appendMarkdown('**Claude Code sessions**\n\n');
  for (const x of sessions) {
    const e = effectiveState(x, t, now);
    const name = x.cwd ? path.basename(x.cwd) : (x.session_id || '?').slice(0, 8);
    let line = '- **' + name + '** — ' + e;
    if (e === 'waiting' && x.waiting_since) {
      line += ' · ' + fmt(now - x.waiting_since);
    }
    if (e === 'working') {
      if (x.todos && x.todos.total > 0) {
        line += ' · ' + x.todos.done + '/' + x.todos.total +
          (x.todos.active ? ' · ' + x.todos.active : '');
      } else if (x.started_at) {
        line += ' · ' + fmt(now - x.started_at);
      }
      if (x.tool) line += ' · ' + x.tool;
    }
    tip.appendMarkdown(line + '\n');
    const agents = runningAgents(x, now);
    if (agents.length) {
      tip.appendMarkdown('  - **' + agents.length + (agents.length === 1 ? ' agent' : ' agents') + ' working**\n');
      for (const a of agents.slice(0, 8)) {
        let al = '    - `' + a.type + '` ' + agentLabel(a) + ' · ' + fmt(now - (a.started_at || now));
        if (a.todos && a.todos.total) al += ' · ' + a.todos.done + '/' + a.todos.total;
        else if (a.tools) al += ' · ' + a.tools + ' tool' + (a.tools === 1 ? '' : 's');
        if (a.tool) al += ' · ' + a.tool;
        tip.appendMarkdown(al + '\n');
      }
      if (agents.length > 8) tip.appendMarkdown('    - …and ' + (agents.length - 8) + ' more\n');
    }
    const finished = recentDoneAgents(x, now);
    if (finished.length) tip.appendMarkdown('  - ' + finished.length + ' agent' + (finished.length === 1 ? '' : 's') + ' just finished\n');
  }
  if (usageData) {
    tip.appendMarkdown('\n---\n');
    const su = s.session_id && usageData.bySession[s.session_id];
    if (su) {
      tip.appendMarkdown('**Tokens · this session**\n');
      for (const r of usageRows(su)) {
        tip.appendMarkdown('- `' + shortModel(r.model) + '` — ' + fmtTok(r.out) + ' out · ' +
          fmtTok(r.inp + r.cw) + ' in · ' + fmtTok(r.cr) + ' cache-read\n');
      }
    }
    const today = usageRows(sumDays(usageData.byDay, 1));
    if (today.length) {
      tip.appendMarkdown('\n**Today** — ' +
        today.map((r) => shortModel(r.model) + ' ' + fmtTok(r.out)).join(' · ') + ' out\n');
    }
    const week = usageRows(sumDays(usageData.byDay, 7));
    if (week.length) {
      const weekOut = week.reduce((a, r) => a + r.out, 0);
      tip.appendMarkdown('**Last 7 days** — ' + fmtTok(weekOut) + ' out (' +
        week.map((r) => shortModel(r.model)).join(', ') + ')\n');
    }
  }
  tip.appendMarkdown('\n---\n');
  limitTooltip(tip);
  tip.appendMarkdown('\n\n_Click for sessions & full usage report_');
  item.tooltip = tip;
  item.show();
  postBuddy(s, st, now);
}

function refresh() {
  sessions = readSessions();
  render();
}

// When the window is narrow, VS Code culls status bar items from the middle
// of the bar first — the far edges survive. Default to the far-right edge
// (very low priority) so the indicator stays visible in narrow windows.
function createItem() {
  if (item) item.dispose();
  const cfg = vscode.workspace.getConfiguration('claudePulse');
  const align = cfg.get('alignment') === 'left'
    ? vscode.StatusBarAlignment.Left
    : vscode.StatusBarAlignment.Right;
  const prRaw = cfg.get('priority');
  item = vscode.window.createStatusBarItem(align, typeof prRaw === 'number' ? prRaw : -900);
  item.name = 'Claude Pulse';
  item.command = 'claudePulse.showSessions';
  render();
}

function activate(context) {
  createItem();
  context.subscriptions.push({ dispose: () => { if (item) item.dispose(); } });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // Independent check — one settings write can affect several keys at once.
      if ((e.affectsConfiguration('claudePulse.buddyImage') ||
           e.affectsConfiguration('claudePulse.buddyCharacter') ||
           e.affectsConfiguration('claudePulse.buddyName')) && buddy) buddy.reload();
      if (e.affectsConfiguration('claudePulse.alignment') || e.affectsConfiguration('claudePulse.priority')) {
        createItem();
      } else if (e.affectsConfiguration('claudePulse')) {
        refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.showSessions', async () => {
      const t = getTimings();
      const now = Date.now();
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('Claude Pulse: no active Claude Code sessions.');
        return;
      }
      const icons = { waiting: '$(bell)', working: '$(loading~spin)', error: '$(warning)', done: '$(check)', idle: '$(sparkle)' };
      const picks = [];
      for (const x of sessions) {
        const e = effectiveState(x, t, now);
        const agents = runningAgents(x, now);
        picks.push({
          label: icons[e] + ' ' + (x.cwd ? path.basename(x.cwd) : (x.session_id || '?').slice(0, 8)),
          description: e + (x.tool && e === 'working' ? ' · ' + x.tool : '') +
            (agents.length ? ' · ' + agents.length + ' agent' + (agents.length === 1 ? '' : 's') : ''),
          detail: x.cwd || undefined,
        });
        for (const a of agents) {
          let d = fmt(now - (a.started_at || now));
          if (a.todos && a.todos.total) d += ' · ' + a.todos.done + '/' + a.todos.total + ' steps';
          else if (a.tools) d += ' · ' + a.tools + ' tool' + (a.tools === 1 ? '' : 's');
          if (a.tool) d += ' · now: ' + a.tool;
          picks.push({ label: '    $(hubot) ' + a.type + ' — ' + agentLabel(a), description: d });
        }
        for (const a of recentDoneAgents(x, now)) {
          picks.push({ label: '    $(check) ' + a.type + ' — ' + agentLabel(a), description: 'finished' });
        }
      }
      picks.push({ label: '$(graph) Token usage report', description: 'session · today · last 7 days, by model', usage: true });
      picks.push({ label: '$(trash) Reset all session states', description: 'clear stuck indicators', reset: true });
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Claude Code sessions' });
      if (chosen && chosen.usage) {
        await vscode.commands.executeCommand('claudePulse.usage');
      } else if (chosen && chosen.reset) {
        await vscode.commands.executeCommand('claudePulse.resetSessions');
      } else if (chosen) {
        try {
          await vscode.commands.executeCommand('workbench.action.terminal.focus');
        } catch { /* no terminal open — nothing to focus */ }
      }
    })
  );

  buddy = new BuddyProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudePulse.buddyView', buddy, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.openBuddy', () =>
      vscode.commands.executeCommand('claudePulse.buddyView.focus'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.chooseBuddy', async () => {
      const cfg = vscode.workspace.getConfiguration('claudePulse');
      const choice = await vscode.window.showQuickPick([
        { label: '🐹 Critter', description: 'round and amber, the default · climbs, leaps 55%', id: 'critter' },
        { label: '🤖 Robot', description: 'antenna, screen face · heavy, leaps 30%', id: 'robot' },
        { label: '🐱 Cat', description: 'ears, tail, judgment · agile, leaps 85%', id: 'cat' },
        { label: '🐶 Pup', description: 'four legs, floppy ears, fast · leaps 60%', id: 'pup' },
        { label: '🐢 Turtle', description: 'small, four legs, very slow · leaps 5% (bless it)', id: 'turtle' },
        { label: '🐌 Snail', description: 'tiny and slowest · slowly crawls walls and ceiling', id: 'snail' },
        { label: '🐝 Bee', description: 'tiny, fast, buzzing wings · flies everywhere', id: 'bee' },
        { label: '🐉 Dragon', description: 'big, slow wingbeats · glides the whole panel', id: 'dragon' },
        { label: '👻 Ghost', description: 'floats, never sleeps quietly', id: 'ghost' },
        { label: '🖼️ My own image…', description: 'PNG / JPG / WebP / SVG / animated GIF', id: 'image' },
      ], { placeHolder: 'Pick your buddy character' });
      if (!choice) return;
      if (choice.id === 'image') {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          title: 'Choose your buddy character image',
          filters: { Images: ['png', 'gif', 'webp', 'svg', 'jpg', 'jpeg'] },
        });
        if (!picked || !picked[0]) return;
        await cfg.update('buddyImage', picked[0].fsPath, vscode.ConfigurationTarget.Global);
      } else {
        await cfg.update('buddyCharacter', choice.id, vscode.ConfigurationTarget.Global);
        await cfg.update('buddyImage', '', vscode.ConfigurationTarget.Global);
      }
      if (buddy) buddy.reload();
      vscode.commands.executeCommand('claudePulse.buddyView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.usage', async () => {
      if (!usageData) {
        refreshUsage();
        vscode.window.showInformationMessage('Claude Pulse: scanning transcripts — try again in a few seconds.');
        return;
      }
      const items = [];
      const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
      const rowsFor = (agg) => usageRows(agg).map((r) => ({
        label: r.model,
        description: fmtTok(r.out) + ' out · ' + fmtTok(r.inp + r.cw) + ' in · ' + fmtTok(r.cr) + ' cache-read',
      }));
      for (const x of sessions) {
        const su = usageData.bySession[x.session_id];
        if (!su) continue;
        items.push(sep('Session · ' + (x.cwd ? path.basename(x.cwd) : (x.session_id || '?').slice(0, 8))));
        items.push(...rowsFor(su));
      }
      items.push(sep('Today (all projects)'));
      items.push(...rowsFor(sumDays(usageData.byDay, 1)));
      items.push(sep('Last 7 days (all projects)'));
      items.push(...rowsFor(sumDays(usageData.byDay, 7)));
      items.push(sep('Plan limits'));
      if (limitsData && limitsData.available) {
        if (limitsData.blocked) {
          items.push({
            label: '$(error) Blocked',
            description: limitsData.blocked.resetsAt
              ? 'back in ' + untilText(limitsData.blocked.resetsAt) : 'limit reached',
          });
        }
        for (const w of limitsData.windows || []) {
          const b = w.burn || {};
          let d = w.resetsAt ? 'refills in ' + untilText(w.resetsAt) : '';
          if (b.trusted === false) {
            items.push({ label: w.label + ' — waiting for a fresh reading', description: d });
            continue;
          }
          if (!b.calibrated) d += d ? ' · last checked' : 'last checked';
          else if (b.perHour > 0.05) d += ' · ' + b.perHour.toFixed(1) + '%/h' + (b.beatsReset ? ' ⚠ runs out first' : '');
          items.push({ label: w.label + ' — ' + windowShown(w) + '%', description: d });
        }
        for (const row of limitsData.breakdown || []) {
          if (row.percent > 0) items.push({ label: '    ' + row.label, description: row.percent + '% of the week' });
        }
        const sessionsByCtx = Object.keys(limitsData.sessions || {})
          .map((k) => limitsData.sessions[k]).filter((s) => s.ctx > 0).sort((a, b) => b.ctx - a.ctx);
        if (sessionsByCtx.length) items.push(sep('Conversation size (what each reply re-reads)'));
        for (const s of sessionsByCtx.slice(0, 5)) {
          items.push({
            label: s.project + ' — ' + fmtTok(s.ctx) + ' context',
            description: Math.round((s.turn ? s.turn.contextShare : 0) * 100) + '% of each reply' +
              (s.ctx >= limitSettings().contextWarn ? ' · worth running /compact' : ''),
          });
        }
      } else {
        items.push({ label: '$(info) Not available yet', description: 'Claude Code caches your usage as it runs' });
      }
      await vscode.window.showQuickPick(items, {
        placeHolder: 'Claude token usage — exact, from local transcripts (no API calls)',
        matchOnDescription: true,
      });
    })
  );

  // Usage under the Claude Code prompt. It is terminal chrome, not part of
  // the conversation, so it costs nothing — and it is where you are looking
  // when you run out.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.statusLine', async () => {
      const settings = path.join(os.homedir(), '.claude', 'settings.json');
      let installed = false;
      try { installed = fs.readFileSync(settings, 'utf8').includes('claude-pulse/limits-scan.js'); } catch { /* none yet */ }
      const verb = installed ? 'Remove' : 'Add';
      const ok = await vscode.window.showInformationMessage(
        installed
          ? 'Remove the Claude Pulse status line from Claude Code?'
          : 'Show your 5-hour and weekly usage under the Claude Code prompt? It costs no tokens, and ~/.claude/settings.json is backed up first.',
        { modal: true }, verb);
      if (ok !== verb) return;
      cp.execFile(process.execPath,
        [path.join(__dirname, 'scripts', 'install-statusline.js')].concat(installed ? ['--remove'] : []),
        { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), timeout: 20000 },
        (err, stdout, stderr) => {
          if (err) {
            vscode.window.showErrorMessage('Claude Pulse: ' + String(stderr || err.message).trim().split('\n').pop());
            return;
          }
          vscode.window.showInformationMessage(installed
            ? 'Claude Pulse: status line removed.'
            : 'Claude Pulse: status line added — restart Claude Code to see it.');
          void stdout;
        });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.resetSessions', () => {
      let files = [];
      try { files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')); } catch { /* dir gone */ }
      for (const f of files) {
        try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch { /* raced with a writer */ }
      }
      refresh();
      vscode.window.setStatusBarMessage('Claude Pulse: session states reset', 3000);
    })
  );

  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* rendered as no sessions */ }

  // Watch the state dir. Base must be a Uri for out-of-workspace paths.
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(STATE_DIR), '*.json')
    );
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
    context.subscriptions.push(watcher);
  } catch { /* polling below still covers us */ }

  // Polling fallback (atomic renames on macOS can slip past watchers) + staleness sweep.
  pollTimer = setInterval(refresh, 2000);
  // 1s tick so the elapsed timer counts smoothly.
  tickTimer = setInterval(render, 1000);
  syncInstalledHook();
  detectGitName();
  // Token usage scan: once shortly after startup, then every 30s (incremental).
  setTimeout(refreshUsage, 1500);
  usagePoll = setInterval(refreshUsage, 30000);
  // Plan limits move slowly, but the local spend ledger the scan maintains
  // wants regular passes to keep its burn rate honest.
  setTimeout(refreshLimits, 2500);
  limitsPoll = setInterval(refreshLimits, 60000);

  refresh();
}

function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
  if (usagePoll) clearInterval(usagePoll);
  if (limitsPoll) clearInterval(limitsPoll);
}

module.exports = { activate, deactivate };
