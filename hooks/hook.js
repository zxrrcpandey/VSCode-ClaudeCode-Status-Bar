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

  const dir = path.join(os.homedir(), '.claude', 'claude-pulse', 'state');
  const file = path.join(dir, sid + '.json');

  if (event === 'SessionEnd') {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

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
    updated_at: now,
  };

  const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
  const keepWaitingSince = () =>
    prev.state === 'waiting' && prev.waiting_since ? prev.waiting_since : now;

  switch (event) {
    case 'SessionStart':
      // Auto-compaction fires SessionStart(source:"compact") mid-turn — keep state.
      if (input.source === 'compact') break;
      s.state = 'idle';
      s.tool = null;
      s.todos = null;
      s.started_at = null;
      s.ended_at = null;
      s.cwds = input.cwd ? [input.cwd] : [];
      break;

    case 'UserPromptSubmit':
      s.state = 'working';
      s.started_at = now;
      s.ended_at = null;
      s.tool = null;
      s.todos = null;
      break;

    case 'PreToolUse':
      if (QUESTION_TOOLS.has(input.tool_name)) {
        s.state = 'waiting';
        s.reason = 'question';
        s.waiting_since = keepWaitingSince();
      } else {
        s.state = 'working';
        s.tool = input.tool_name || s.tool;
      }
      if (!s.started_at) s.started_at = now;
      break;

    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      s.state = 'working';
      s.tool = input.tool_name || s.tool;
      if (!s.started_at) s.started_at = now;
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
      s.state = 'waiting';
      s.reason = 'permission';
      s.tool = input.tool_name || s.tool;
      s.waiting_since = keepWaitingSince();
      break;

    case 'Notification': {
      const t = input.notification_type;
      if (t === 'permission_prompt') {
        s.state = 'waiting';
        s.reason = 'permission';
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
