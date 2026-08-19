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
let buddy = null;
let lastBuddyData = null;
let gitName = '';

// The buddy addresses the user by name: claudePulse.buddyName wins, otherwise
// the first name from git config user.name. Sanitized — it lands in webview HTML.
function buddyName() {
  const cfg = vscode.workspace.getConfiguration('claudePulse').get('buddyName');
  const raw = (typeof cfg === 'string' && cfg.trim()) ? cfg : gitName;
  return String(raw).replace(/[^\p{L}\p{N} .'-]/gu, '').trim().split(/\s+/)[0] || '';
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
    const character = ['critter', 'robot', 'cat', 'ghost'].includes(charRaw) ? charRaw : 'critter';
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
  };
  if (buddy) buddy.post(lastBuddyData);
}

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
  return {
    doneFadeMs: (typeof doneRaw === 'number' && doneRaw >= 0 ? doneRaw : 15) * 1000,
    // <= 0 disables the downgrade (waiting shows until an event clears it)
    waitTimeoutMs: typeof waitRaw === 'number' && waitRaw > 0 ? waitRaw * 1000 : Infinity,
    showElapsed: cfg.get('showElapsed') !== false,
    showTokens: cfg.get('showTokens') !== false,
  };
}

function effectiveState(s, t, now) {
  if ((s.state === 'done' || s.state === 'error') &&
      now - (s.ended_at || s.updated_at || 0) > t.doneFadeMs) return 'idle';
  // Claude Code fires no event when a permission is APPROVED — the next event is
  // PostToolUse when the tool finishes. The open dialog re-asserts 'waiting'
  // (Notification at ~6s), so a waiting-permission state that hasn't been
  // refreshed recently most likely means the tool is already running.
  if (s.state === 'waiting' && s.reason === 'permission' &&
      now - (s.updated_at || 0) > t.waitTimeoutMs) return 'working';
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

function taskBar(done, total) {
  if (total <= 12) return '▰'.repeat(done) + '▱'.repeat(total - done);
  const filled = Math.round((done / total) * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function render() {
  if (!item) return;
  const t = getTimings();
  const showElapsed = t.showElapsed;
  const now = Date.now();

  if (sessions.length === 0) {
    // Stay visible so the indicator never seems to vanish — a dim idle mark
    // simply means no Claude session belongs to this window right now.
    item.backgroundColor = undefined;
    item.color = undefined;
    item.text = '$(sparkle) Claude';
    item.tooltip = 'No Claude Code session in this workspace yet — start one and it will appear here.';
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
    item.text = '$(bell) Claude · ' + (s.reason === 'question' ? 'has a question' : 'needs input') + suffix;
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
    tip.appendMarkdown('\n_Plan limit remaining (5 h / weekly) is not stored locally — run `/usage` inside Claude Code._');
  }
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
      const picks = sessions.map((x) => {
        const e = effectiveState(x, t, now);
        return {
          label: icons[e] + ' ' + (x.cwd ? path.basename(x.cwd) : (x.session_id || '?').slice(0, 8)),
          description: e + (x.tool && e === 'working' ? ' · ' + x.tool : ''),
          detail: x.cwd || undefined,
        };
      });
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
        { label: '🐹 Critter', description: 'round and amber, the default', id: 'critter' },
        { label: '🤖 Robot', description: 'antenna, screen face', id: 'robot' },
        { label: '🐱 Cat', description: 'ears, tail, judgment', id: 'cat' },
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
      items.push({
        label: '$(info) 5-hour / weekly remaining',
        description: 'not stored locally — run /usage inside Claude Code',
      });
      await vscode.window.showQuickPick(items, {
        placeHolder: 'Claude token usage — exact, from local transcripts (no API calls)',
        matchOnDescription: true,
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
  detectGitName();
  // Token usage scan: once shortly after startup, then every 30s (incremental).
  setTimeout(refreshUsage, 1500);
  usagePoll = setInterval(refreshUsage, 30000);

  refresh();
}

function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
  if (usagePoll) clearInterval(usagePoll);
}

module.exports = { activate, deactivate };
