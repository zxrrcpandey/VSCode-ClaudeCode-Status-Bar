const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'claude-pulse', 'state');

// Busy states older than this are considered dead sessions (crashed Claude, etc.)
const WORKING_STALE_MS = 60 * 60 * 1000;
const WAITING_STALE_MS = 4 * 60 * 60 * 1000;

let item = null;
let sessions = [];
let pollTimer = null;
let tickTimer = null;

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// A session belongs to this window when its cwd is inside one of the
// workspace folders (or a workspace folder is inside the session's cwd,
// for windows opened on a subfolder of the repo Claude runs in).
function sessionMatchesWorkspace(s) {
  if (!s.cwd) return false;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return false;
  const cwd = path.resolve(s.cwd);
  return folders.some((f) => {
    const wf = path.resolve(f.uri.fsPath);
    return cwd === wf || cwd.startsWith(wf + path.sep) || wf.startsWith(cwd + path.sep);
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
    item.hide();
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
  tip.appendMarkdown('\n_Click to view sessions / focus terminal_');
  item.tooltip = tip;
  item.show();
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
      picks.push({ label: '$(trash) Reset all session states', description: 'clear stuck indicators', reset: true });
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Claude Code sessions' });
      if (chosen && chosen.reset) {
        await vscode.commands.executeCommand('claudePulse.resetSessions');
      } else if (chosen) {
        try {
          await vscode.commands.executeCommand('workbench.action.terminal.focus');
        } catch { /* no terminal open — nothing to focus */ }
      }
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

  refresh();
}

function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
}

module.exports = { activate, deactivate };
