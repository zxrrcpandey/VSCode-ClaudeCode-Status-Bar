#!/usr/bin/env node
/* Regression tests for the waiting-state semantics: drives the real
 * hooks/hook.js and mirrors extension.js effectiveState() exactly.
 * Run against a throwaway HOME so your real state files are untouched:
 *   HOME=$(mktemp -d) node scripts/test-waiting.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = path.join(__dirname, '..');
const HOME = process.env.HOME;
const DIR = path.join(HOME, '.claude', 'claude-pulse', 'state');
const TIMEOUT_MS = 45000;          // package.json default
const PROVISIONAL_MS = Infinity;   // provisionalWaitSeconds: 0 (default)

// --- mirror of extension.js effectiveState (waiting branch) ---
function effectiveState(s, now) {
  if (s.state === 'done' && now - (s.ended_at || s.updated_at || 0) > 15000) return 'idle';
  if (s.state === 'waiting') {
    const confirmed = ('waiting_confirmed' in s) ? !!s.waiting_confirmed : true;
    const age = now - (s.waiting_since || s.updated_at || 0);
    if (!confirmed && age < PROVISIONAL_MS) return 'working';
    if (s.reason !== 'question' && s.reason !== 'agent') {
      const confAge = now - (s.confirmed_at || s.waiting_since || s.updated_at || 0);
      if (confAge > TIMEOUT_MS) return 'working';
    }
    return 'waiting';
  }
  return s.state;
}

// PULSE_HOOK_BIN=<path to pulse-hook> runs the same scenarios through the macOS
// app's JavaScriptCore runner instead of Node, to prove the two agree.
const HOOK_BIN = process.env.PULSE_HOOK_BIN;
const fire = (sid, o) => cp.execFileSync(HOOK_BIN || 'node',
  HOOK_BIN ? ['run', path.join(REPO, 'hooks/hook.js')] : [path.join(REPO, 'hooks/hook.js')],
  { input: JSON.stringify(Object.assign({ session_id: sid, cwd: '/tmp/p' }, o)) });
const read = (sid) => JSON.parse(fs.readFileSync(path.join(DIR, sid + '.json'), 'utf8'));
const write = (sid, s) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, sid + '.json'), JSON.stringify(s)); };
const age = (sid, ms) => { const s = read(sid); for (const k of ['waiting_since', 'confirmed_at', 'started_at', 'updated_at']) if (s[k]) s[k] -= ms; write(sid, s); };

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + '  → ' + got + (ok ? '' : '  (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

fs.rmSync(DIR, { recursive: true, force: true });

// 1. The reported bug: subagent permission flood must never show yellow.
{
  const sid = 't1';
  fire(sid, { hook_event_name: 'UserPromptSubmit' });
  for (let i = 0; i < 20; i++) {
    fire(sid, { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'ag' + (i % 4), agent_type: 'workflow-subagent' });
    fire(sid, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', agent_id: 'ag' + (i % 4), agent_type: 'workflow-subagent' });
  }
  check('subagent permission flood stays quiet', effectiveState(read(sid), Date.now()), 'working');
}

// 2. Auto-approved main request during a long command: quiet, even after minutes.
{
  const sid = 't2';
  fire(sid, { hook_event_name: 'UserPromptSubmit' });
  fire(sid, { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  fire(sid, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  check('auto-approved request is quiet immediately', effectiveState(read(sid), Date.now()), 'working');
  age(sid, 300000);
  check('auto-approved request still quiet after 5 min', effectiveState(read(sid), Date.now()), 'working');
}

// 3. CRITICAL: a real dialog confirmed while a stale provisional wait stands.
{
  const sid = 't3';
  fire(sid, { hook_event_name: 'UserPromptSubmit' });
  fire(sid, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  age(sid, 300000);                                   // long command has been running 5 min
  fire(sid, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  check('dialog confirmed after stale provisional shows', effectiveState(read(sid), Date.now()), 'waiting');
  const s = read(sid);
  check('  …and its start time is preserved (real age)', s.waiting_since < s.confirmed_at - 200000, true);
}

// 4. Repeat notification re-arms an expired confirmed wait.
{
  const sid = 't4';
  fire(sid, { hook_event_name: 'UserPromptSubmit' });
  fire(sid, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  age(sid, 60000);
  check('confirmed permission ages out (approval fires no event)', effectiveState(read(sid), Date.now()), 'working');
  fire(sid, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  check('  …repeat notification re-arms it', effectiveState(read(sid), Date.now()), 'waiting');
}

// 5. Questions and agent prompts are never aged out.
{
  const sid = 't5';
  fire(sid, { hook_event_name: 'UserPromptSubmit' });
  fire(sid, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' });
  age(sid, 600000);
  check('question wait survives 10 min', effectiveState(read(sid), Date.now()), 'waiting');
  fire(sid, { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
  check('  …and clears when answered', effectiveState(read(sid), Date.now()), 'working');

  const sid2 = 't5b';
  fire(sid2, { hook_event_name: 'UserPromptSubmit' });
  fire(sid2, { hook_event_name: 'Notification', notification_type: 'agent_needs_input' });
  age(sid2, 600000);
  check('agent prompt survives 10 min', effectiveState(read(sid2), Date.now()), 'waiting');
  check('  …and is labelled as an agent wait', read(sid2).reason, 'agent');
}

// 6. Legacy state file from a pre-0.10.1 hook: degrade, do not hide.
{
  const now = Date.now();
  const legacy = { session_id: 't6', cwd: '/tmp/p', cwds: ['/tmp/p'], state: 'waiting', reason: 'permission',
    tool: 'Bash', waiting_since: now - 5000, updated_at: now - 5000, started_at: now - 9000 };
  write('t6', legacy);
  check('legacy file (no waiting_confirmed) still shows', effectiveState(read('t6'), Date.now()), 'waiting');
}

// 7. A real dialog survives a concurrent subagent flood.
{
  const sid = 't7';
  fire(sid, { hook_event_name: 'UserPromptSubmit' });
  fire(sid, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  for (let i = 0; i < 15; i++) fire(sid, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', agent_id: 'agZ', agent_type: 'workflow-subagent' });
  check('real dialog survives subagent flood', effectiveState(read(sid), Date.now()), 'waiting');
  fire(sid, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  check('  …and clears once the tool actually runs', effectiveState(read(sid), Date.now()), 'working');
}

// 8. Denial clears the wait.
{
  const sid = 't8';
  fire(sid, { hook_event_name: 'UserPromptSubmit' });
  fire(sid, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  fire(sid, { hook_event_name: 'PermissionDenied', tool_name: 'Bash' });
  check('denial clears the wait', effectiveState(read(sid), Date.now()), 'working');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
