import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeRepo, NODE_FIXTURE, BRAIN_JS, brain, hook, read, runHookCommand, tmpDir } from './helpers.js';

function project() {
  const dir = makeRepo(NODE_FIXTURE);
  assert.equal(brain(['init'], { cwd: dir }).code, 0);
  return dir;
}

const base = (dir, extra = {}) => ({ session_id: 'sess-1', transcript_path: '/dev/null', cwd: dir, permission_mode: 'default', ...extra });

test('SessionStart returns Claude Code hookSpecificOutput context within the 10,000-char cap', () => {
  const dir = project();
  const r = hook('session-start', base(dir, { hook_event_name: 'SessionStart', source: 'startup' }));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /# Project brain/);
  assert.match(ctx, /Key facts/);
  assert.ok(ctx.length < 10000);
});

test('hooks are silent no-ops in folders without a brain', () => {
  const dir = makeRepo({ 'a.txt': 'a' });
  for (const ev of ['session-start', 'user-prompt-submit', 'stop', 'session-end', 'pre-tool-use']) {
    const r = hook(ev, base(dir, { prompt: 'implement a feature please', tool_name: 'WebSearch' }));
    assert.equal(r.code, 0, ev);
    assert.equal(r.out, '', ev);
  }
  assert.ok(!fs.existsSync(path.join(dir, '.agent-brain')));
});

test('recursion guard: nested invocation does nothing', () => {
  const dir = project();
  const r = hook('session-start', base(dir), { env: { BRAIN_HOOK_ACTIVE: '1' } });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('UserPromptSubmit routes to skills and logs only a hash and length of the prompt', () => {
  const dir = project();
  const prompt = 'Research the main competitors for our invoicing tool and compare pricing - secret codename BLUEFALCON';
  const r = hook('user-prompt-submit', base(dir, { hook_event_name: 'UserPromptSubmit', prompt }));
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /web-research/);
  assert.match(ctx, /web\.search: ask-connect/);
  const log = read(path.join(dir, '.agent-brain', 'local', 'events.jsonl'));
  assert.ok(!log.includes('BLUEFALCON'), 'prompt text must not be stored');
  assert.match(log, /"prompt_chars":\d+/);
});

test('short or slash-command prompts are not routed', () => {
  const dir = project();
  assert.equal(hook('user-prompt-submit', base(dir, { prompt: 'thanks' })).out, '');
  assert.equal(hook('user-prompt-submit', base(dir, { prompt: '/compact keep the plan' })).out, '');
});

test('Stop checkpoints are deduplicated for identical git state and never block', () => {
  const dir = project();
  for (let i = 0; i < 3; i++) {
    const r = hook('stop', base(dir, { hook_event_name: 'Stop', stop_hook_active: i > 0, last_assistant_message: 'PRIVATE ASSISTANT TEXT' }));
    assert.equal(r.code, 0);
    assert.equal(r.out, '', 'stop hook must not emit a decision');
  }
  const log = read(path.join(dir, '.agent-brain', 'local', 'events.jsonl'));
  assert.equal(log.split('\n').filter((l) => l.includes('"checkpoint"')).length, 1);
  assert.ok(!log.includes('PRIVATE ASSISTANT TEXT'));
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
  hook('session-end', base(dir, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }));
  const cp = JSON.parse(read(path.join(dir, '.agent-brain', 'local', 'checkpoints', 'last.json')));
  assert.equal(cp.event, 'session-end');
  assert.equal(cp.reason, 'prompt_input_exit');
  assert.ok(cp.git.changed.some((c) => c.path === 'new.txt'));
});

test('PreToolUse blocks (exit 2) only capabilities the user explicitly denied', () => {
  const dir = project();
  assert.equal(hook('pre-tool-use', base(dir, { tool_name: 'WebSearch', tool_input: { query: 'x' } })).code, 0);
  assert.equal(brain(['consent', 'deny', 'web.search'], { cwd: dir }).code, 0);
  const blocked = hook('pre-tool-use', base(dir, { tool_name: 'WebSearch', tool_input: { query: 'x' } }));
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /user denied capability "web\.search"/);
  assert.equal(hook('pre-tool-use', base(dir, { tool_name: 'WebFetch' })).code, 0, 'other capabilities unaffected');
  assert.equal(hook('pre-tool-use', base(dir, { tool_name: 'Bash' })).code, 0);
  assert.equal(brain(['consent', 'grant', 'web.search'], { cwd: dir }).code, 0);
  assert.equal(hook('pre-tool-use', base(dir, { tool_name: 'WebSearch' })).code, 0, 're-granting lifts the block');
});

test('corrupt brain files degrade visibly instead of failing the session', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, '.agent-brain', 'facts.yaml'), 'facts: [unterminated\n');
  const r = hook('session-start', base(dir));
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /facts\.yaml problems|unavailable/);
});

test('hard deadline: a slow controller times out with a fallback note and exit 0', () => {
  const dir = project();
  const start = Date.now();
  const r = hook('session-start', base(dir), { env: { BRAIN_HOOK_BUDGET_MS: '300', BRAIN_TEST_HOOK_DELAY_MS: '5000' } });
  assert.ok(Date.now() - start < 3000, 'returned well before the simulated delay');
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /timed out/);
});

test('stdin that never closes is bounded by the read timeout', async () => {
  const dir = project();
  const start = Date.now();
  const child = spawn(process.execPath, [BRAIN_JS, 'hook', 'claude-code', 'stop'], { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, BRAIN_HOOK_ACTIVE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  // stdin is deliberately left open and never written to
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const elapsed = Date.now() - start;
  child.stdin.destroy();
  assert.equal(code, 0);
  assert.ok(elapsed < 4000, `hook exited after ${elapsed} ms with stdin still open`);
});

test('a missing controller fails non-blocking (exit code is not 2)', () => {
  const dir = project();
  const r = runHookCommand(`"${process.execPath}" "${path.join(tmpDir(), 'moved', 'brain.js')}" hook claude-code session-start`, base(dir));
  assert.notEqual(r.code, 0);
  assert.notEqual(r.code, 2, 'exit 2 would block events in Claude Code');
});

test('unknown agents and events are ignored safely', () => {
  const dir = project();
  const r1 = runHookCommand(`"${process.execPath}" "${BRAIN_JS}" hook codex session-start`, base(dir));
  assert.equal(r1.code, 0);
  assert.match(r1.err, /not implemented/);
  const r2 = hook('made-up-event', base(dir));
  assert.equal(r2.code, 0);
});
