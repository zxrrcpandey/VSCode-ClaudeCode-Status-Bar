#!/usr/bin/env node
/*
 * Claude Pulse hook — runs locally on Claude Code lifecycle events.
 * Reads the event JSON from stdin, writes a tiny per-session state file to
 * ~/.claude/claude-pulse/state/<session_id>.json.
 *
 * No network, no API calls, no tokens. Always exits 0 so it can never block
 * or slow down Claude itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

// Serialize read-modify-write across concurrent hook processes (parallel
// subagents fire events simultaneously). Lock = exclusive-create file; stale
// locks (>2s, a crashed hook) are broken; worst case we proceed unlocked
// after 300ms so Claude is never held up.
function withLock(lockPath, fn) {
  const deadline = Date.now() + 300;
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(lockPath, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(lockPath).mtimeMs > 2000) { fs.unlinkSync(lockPath); continue; } } catch { /* gone */ }
      if (Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
    }
  }
  try { fn(); } finally {
    if (fd !== null) { try { fs.closeSync(fd); fs.unlinkSync(lockPath); } catch { /* already gone */ } }
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const event = input.hook_event_name;
  const sid = input.session_id;
  if (!event || !sid) return;

  const base = path.join(os.homedir(), '.claude', 'claude-pulse');
  // Opt-in raw event log for debugging: `touch ~/.claude/claude-pulse/debug`.
  try {
    if (fs.existsSync(path.join(base, 'debug'))) {
      fs.appendFileSync(path.join(base, 'events.log'), JSON.stringify(input) + '\n');
    }
  } catch { /* never block Claude */ }

  const dir = path.join(base, 'state');
  const file = path.join(dir, sid + '.json');

  if (event === 'SessionEnd') {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

  withLock(file + '.lock', () => update(input, event, sid, file));
}

function update(input, event, sid, file) {
  const prev = readState(file);
  const now = Date.now();
  const s = {
    session_id: sid,
    cwd: input.cwd || prev.cwd || null,
    // Every directory this session has reported. The shell's cwd follows `cd`,
    // so the latest value can wander outside the project — the indicator
    // matches a window against ALL of these, keeping the session attached to
    // the workspace it started in.
    cwds: Array.isArray(prev.cwds) ? prev.cwds : (prev.cwd ? [prev.cwd] : []),
    state: prev.state || 'idle',
    reason: null,
    tool: prev.tool || null,
    todos: prev.todos || null,
    started_at: prev.started_at || null,
    ended_at: prev.ended_at || null,
    waiting_since: null,
    // true only for waits confirmed to need the user (an unanswered dialog,
    // a question tool). A bare PermissionRequest is NOT confirmation — it
    // fires for auto-approved calls too.
    waiting_confirmed: null,
    // Subagents: keyed by the spawning Agent tool_use_id (or by agent_id when
    // no spawn was seen, e.g. workflow agents). Each: {desc, type, state,
    // agent_id, started_at, last_seen, ended_at, tools, tool, todos}.
    agents: (prev.agents && typeof prev.agents === 'object') ? prev.agents : {},
    updated_at: now,
  };

  const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
  const AGENT_TOOLS = new Set(['Agent', 'Task']);
  const keepWaitingSince = () =>
    prev.state === 'waiting' && prev.waiting_since ? prev.waiting_since : now;
  const touched = new Set(); // agent keys this event updated (wins in the merge below)

  // Activity from inside a subagent (tool events carry agent_id/agent_type):
  // bind it to the spawn record, or create one if the spawn wasn't seen.
  function touchAgent(id, type) {
    let key = Object.keys(s.agents).find((k) => s.agents[k].agent_id === id);
    if (!key) {
      const cands = Object.keys(s.agents).filter((k) =>
        !s.agents[k].agent_id && s.agents[k].state === 'running' && (!type || s.agents[k].type === type));
      cands.sort((a, b) => (s.agents[a].started_at || 0) - (s.agents[b].started_at || 0));
      key = cands[0];
      if (key) s.agents[key].agent_id = id;
    }
    if (!key) {
      key = id;
      s.agents[key] = { desc: null, type: type || 'agent', state: 'running', agent_id: id, started_at: now, tools: 0, tool: null };
    }
    const a = s.agents[key];
    a.last_seen = now;
    touched.add(key);
    return a;
  }
  function finishAgent(key, agentId) {
    const a = s.agents[key];
    if (!a) return;
    if (agentId && a.agent_id !== agentId) {
      // The Agent tool's result names the real agent id. Parallel agents of
      // the same type may have been bound in the wrong order at spawn —
      // swap the activity stats into the record that truly owns them.
      const holder = Object.keys(s.agents).find((k) => k !== key && s.agents[k].agent_id === agentId);
      if (holder) {
        const h = s.agents[holder];
        for (const f of ['agent_id', 'tools', 'tool', 'todos', 'last_seen']) {
          const tmp = a[f]; a[f] = h[f]; h[f] = tmp;
        }
        touched.add(holder);
      }
      a.agent_id = agentId;
    }
    a.state = 'done'; a.ended_at = now; a.last_seen = now;
    touched.add(key);
  }
  function pruneAgents() {
    const keys = Object.keys(s.agents);
    for (const k of keys) {
      const a = s.agents[k];
      const seen = a.last_seen || a.started_at || 0;
      if ((a.state === 'done' && now - (a.ended_at || seen) > 90000) || now - seen > 15 * 60000) delete s.agents[k];
    }
    const left = Object.keys(s.agents).sort((a, b) => (s.agents[a].started_at || 0) - (s.agents[b].started_at || 0));
    while (left.length > 40) delete s.agents[left.shift()];
  }

  // Events from inside a subagent only update that agent's record — never the
  // main session's tool/todos (a subagent's TodoWrite is not your checklist).
  const fromAgent = !!(input.agent_id || input.agentId);
  const AGENT_ROUTED = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
  // A subagent asking for permission is not you being asked — in acceptEdits
  // mode agents fire PermissionRequest constantly for auto-approved calls.
  // Route these to the agent's liveness only. The one exception is handled
  // below: Notification(agent_needs_input) genuinely needs the user.
  if (fromAgent && AGENT_ROUTED.has(event)) {
    const a = touchAgent(input.agent_id || input.agentId, input.agent_type || input.agentType);
    if (event === 'PreToolUse') { a.tools = (a.tools || 0) + 1; a.tool = input.tool_name || a.tool; }
    if (event === 'PostToolUse' && input.tool_name === 'TodoWrite') {
      const todos = input.tool_input && input.tool_input.todos;
      if (Array.isArray(todos) && todos.length) {
        a.todos = { done: todos.filter((t) => t && t.status === 'completed').length, total: todos.length };
      }
    }
    if (s.state === 'idle' || s.state === 'done') s.state = 'working';
    if (!s.started_at) s.started_at = now;
    // fall through to the shared write path below
  } else switch (event) {
    case 'SubagentStart': {
      const id = input.agent_id || input.agentId;
      if (!id) return;
      const a = touchAgent(id, input.agent_type || input.agentType);
      if (!a.desc && (input.description || input.task)) a.desc = String(input.description || input.task).slice(0, 80);
      break;
    }
    case 'SubagentStop': {
      const id = input.agent_id || input.agentId;
      const key = Object.keys(s.agents).find((k) => s.agents[k].agent_id === id) || (id && s.agents[id] ? id : null);
      if (key) finishAgent(key);
      break;
    }
    case 'SessionStart':
      // Auto-compaction fires SessionStart(source:"compact") mid-turn — keep state.
      if (input.source === 'compact') break;
      s.state = 'idle';
      s.tool = null;
      s.todos = null;
      s.started_at = null;
      s.ended_at = null;
      s.cwds = input.cwd ? [input.cwd] : [];
      s.agents = {};
      break;

    case 'UserPromptSubmit':
      s.state = 'working';
      s.started_at = now;
      s.ended_at = null;
      s.tool = null;
      s.todos = null;
      pruneAgents();
      break;

    case 'PreToolUse':
      if (QUESTION_TOOLS.has(input.tool_name)) {
        s.state = 'waiting';
        s.reason = 'question';
        s.waiting_confirmed = true;   // a question always needs you
        s.waiting_since = keepWaitingSince();
      } else {
        s.state = 'working';
        s.tool = input.tool_name || s.tool;
      }
      if (AGENT_TOOLS.has(input.tool_name) && input.tool_use_id) {
        // A subagent is being spawned — this is where its task description lives.
        const ti = input.tool_input || {};
        s.agents[input.tool_use_id] = {
          desc: String(ti.description || (ti.prompt ? String(ti.prompt).slice(0, 80) : '') || 'agent').slice(0, 80),
          type: ti.subagent_type || 'agent',
          state: 'running', agent_id: null, started_at: now, last_seen: now, tools: 0, tool: null,
        };
        touched.add(input.tool_use_id);
      }
      if (!s.started_at) s.started_at = now;
      break;

    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      s.state = 'working';
      s.tool = input.tool_name || s.tool;
      if (!s.started_at) s.started_at = now;
      if (AGENT_TOOLS.has(input.tool_name) && input.tool_use_id && s.agents[input.tool_use_id]) {
        finishAgent(input.tool_use_id, input.tool_response && input.tool_response.agentId);
      }
      if (input.tool_name === 'TodoWrite') {
        const todos = input.tool_input && input.tool_input.todos;
        if (Array.isArray(todos) && todos.length > 0) {
          const done = todos.filter((t) => t && t.status === 'completed').length;
          const cur = todos.find((t) => t && t.status === 'in_progress');
          s.todos = {
            done,
            total: todos.length,
            active: cur ? (cur.activeForm || cur.content || null) : null,
          };
        }
      }
      break;

    case 'PermissionRequest':
      // Provisional only: this fires for auto-approved calls too (observed
      // firing many times per minute in acceptEdits mode). The confirmation
      // that a dialog is really sitting unanswered is Notification below.
      s.state = 'waiting';
      s.reason = 'permission';
      s.tool = input.tool_name || s.tool;
      s.waiting_confirmed = prev.state === 'waiting' ? (prev.waiting_confirmed || false) : false;
      s.waiting_since = keepWaitingSince();
      break;

    case 'Notification': {
      const t = input.notification_type;
      if (t === 'permission_prompt') {
        // Fires ~6s after a dialog is still unanswered: you really are needed.
        s.state = 'waiting';
        s.reason = 'permission';
        s.waiting_confirmed = true;
        s.waiting_since = keepWaitingSince();
      } else if (t === 'agent_needs_input' || t === 'elicitation_dialog' || t === 'elicitation_url_dialog') {
        s.state = 'waiting';
        s.reason = t === 'agent_needs_input' ? 'agent' : 'question';
        s.waiting_confirmed = true;
        s.waiting_since = keepWaitingSince();
      } else if (t === 'idle_prompt') {
        s.state = 'idle';
      } else {
        return; // other notification types don't change the indicator
      }
      break;
    }

    case 'Stop':
      s.state = 'done';
      s.ended_at = now;
      s.tool = null;
      // Agents that went quiet before the turn ended are finished; background
      // agents that are still active keep running.
      for (const k of Object.keys(s.agents)) {
        const a = s.agents[k];
        if (a.state === 'running' && now - (a.last_seen || a.started_at || 0) > 30000) finishAgent(k);
      }
      break;

    case 'StopFailure':
      // Response died (API error, connection lost) — not a clean finish.
      s.state = 'error';
      s.ended_at = now;
      s.tool = null;
      break;

    default:
      return; // unknown event — leave state untouched
  }

  // Keep the age and confirmation of a wait across unrelated events — losing
  // them made "needs input" un-ageable and therefore permanent.
  if (s.state === 'waiting') {
    if (!s.waiting_since) s.waiting_since = prev.waiting_since || now;
    if (s.reason == null) s.reason = prev.reason || 'permission';
    if (s.waiting_confirmed == null) s.waiting_confirmed = prev.waiting_confirmed || false;
  } else {
    s.waiting_since = null;
    s.waiting_confirmed = false;
  }

  pruneAgents();
  if (input.cwd && !s.cwds.includes(input.cwd)) s.cwds.push(input.cwd);
  // Cap the list but always keep the first entry — it anchors the session to
  // the workspace it started in.
  if (s.cwds.length > 8) s.cwds = [s.cwds[0]].concat(s.cwds.slice(-7));

  // Concurrent hooks can interleave (parallel tool calls): re-read and keep
  // fields a racing writer set that this event doesn't own.
  const latest = readState(file);
  if (latest.updated_at && latest.updated_at !== prev.updated_at) {
    if (event !== 'UserPromptSubmit') {
      if (input.tool_name !== 'TodoWrite' && latest.todos) s.todos = latest.todos;
      if (latest.started_at) s.started_at = latest.started_at;
    }
    if (Array.isArray(latest.cwds)) {
      s.cwds = Array.from(new Set(latest.cwds.concat(s.cwds)));
      if (s.cwds.length > 8) s.cwds = [s.cwds[0]].concat(s.cwds.slice(-7));
    }
    // Parallel agents write concurrently: keep every agent record a racing
    // writer added/updated, except the ones this event owns.
    if (latest.agents && typeof latest.agents === 'object') {
      for (const k of Object.keys(latest.agents)) {
        if (touched.has(k)) continue;
        const ours = s.agents[k], theirs = latest.agents[k];
        if (!ours || (theirs.last_seen || 0) >= (ours.last_seen || 0)) s.agents[k] = theirs;
      }
    }
  }

  // Atomic write: temp file + rename, so the watcher never reads half a file.
  const tmp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

try { main(); } catch { /* never block Claude */ }
process.exit(0);
