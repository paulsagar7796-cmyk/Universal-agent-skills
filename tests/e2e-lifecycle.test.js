// End-to-end: explicit setup → host-style hook deliveries (using the exact commands written to settings) →
// routing + capability consent → memory update → checkpoint → explain-last-run → isolation → uninstall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, NODE_FIXTURE, brain, read, runHookCommand, tmpDir } from './helpers.js';

function configuredCommands(settingsFile) {
  const s = JSON.parse(read(settingsFile));
  const cmd = {};
  for (const [ev, groups] of Object.entries(s.hooks)) for (const g of groups) for (const h of g.hooks) if (h.command.includes('--owner=agent-skills-brain')) cmd[ev] = h.command;
  return cmd;
}

test('full lifecycle across two isolated projects', () => {
  const home = tmpDir('asb-e2e-home-');
  const env = { HOME: home };
  const a = makeRepo(NODE_FIXTURE);
  const b = makeRepo({ 'pyproject.toml': '[project]\nname = "other"\n' });

  // 1. Clone/download executes nothing: no brain, no config yet.
  assert.ok(!fs.existsSync(path.join(a, '.agent-brain')) && !fs.existsSync(path.join(a, '.claude')));

  // 2. Explicit, consented setup in project A.
  const setup = brain(['setup', '--agent', 'claude-code', '--yes'], { cwd: a, env });
  assert.equal(setup.code, 0, setup.out + setup.err);
  const cmd = configuredCommands(path.join(a, '.claude', 'settings.local.json'));
  assert.deepEqual(Object.keys(cmd).sort(), ['PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  const sess = { session_id: 'e2e-session', transcript_path: '/dev/null', cwd: a, permission_mode: 'default' };

  // 3. Session start: compact context injected automatically.
  const start = runHookCommand(cmd.SessionStart, { ...sess, hook_event_name: 'SessionStart', source: 'startup' }, { env });
  assert.equal(start.code, 0);
  assert.match(JSON.parse(start.out).hookSpecificOutput.additionalContext, /package\.json declares a "test" script/);

  // 4. A plain request is routed to skills; a missing capability produces a truthful ask.
  const ask = runHookCommand(cmd.UserPromptSubmit, { ...sess, hook_event_name: 'UserPromptSubmit', prompt: 'Research the latest competitors for this app and summarise their pricing for ZEPHYRQUILL' }, { env });
  const askCtx = JSON.parse(ask.out).hookSpecificOutput.additionalContext;
  assert.match(askCtx, /web-research/);
  assert.match(askCtx, /web\.search: ask-connect/);

  // 5. User declines search → recorded; next request gets the fallback instead of another ask; tool is blocked.
  assert.equal(brain(['consent', 'deny', 'web.search'], { cwd: a, env }).code, 0);
  const again = JSON.parse(runHookCommand(cmd.UserPromptSubmit, { ...sess, prompt: 'Research the latest competitors for this app and summarise their pricing for ZEPHYRQUILL' }, { env }).out).hookSpecificOutput.additionalContext;
  assert.match(again, /web\.search: fallback/);
  assert.doesNotMatch(again, /web\.search: ask-connect/);
  const blocked = runHookCommand(cmd.PreToolUse, { ...sess, hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'competitors' } }, { env });
  assert.equal(blocked.code, 2);

  // 6. A build request routes to engineering skills; the agent records evidence-backed memory.
  const build = JSON.parse(runHookCommand(cmd.UserPromptSubmit, { ...sess, prompt: 'Implement a new endpoint that lists saved addresses for ZEPHYRQUILL' }, { env }).out).hookSpecificOutput.additionalContext;
  assert.match(build, /software-engineer/);
  assert.match(build, /verification-before-completion/);
  const rem = brain(['remember', '--claim', 'The app entry point is src/index.js.', '--key', 'entry.app', '--evidence', 'file:src/index.js'], { cwd: a, env });
  assert.equal(rem.code, 0, rem.err);
  const pid = rem.out.match(/P-\d{8}-[0-9a-f]+/)[0];
  assert.equal(brain(['approve', pid], { cwd: a, env }).code, 0);
  assert.equal(brain(['handoff', '--task', 'Saved addresses endpoint', '--check', 'npm test=not-run: deps not installed', '--next', 'install deps and run tests'], { cwd: a, env }).code, 0);

  // 7. Checkpoints at Stop / PreCompact / SessionEnd; the next session sees the handoff.
  fs.writeFileSync(path.join(a, 'src', 'addresses.js'), 'export const list = () => [];\n');
  for (const [ev, extra] of [['Stop', {}], ['PreCompact', { trigger: 'auto', custom_instructions: null }], ['SessionEnd', { reason: 'prompt_input_exit' }]]) assert.equal(runHookCommand(cmd[ev], { ...sess, hook_event_name: ev, ...extra }, { env }).code, 0, ev);
  const next = JSON.parse(runHookCommand(cmd.SessionStart, { ...sess, session_id: 'next-session', source: 'resume' }, { env }).out).hookSpecificOutput.additionalContext;
  assert.match(next, /Latest handoff/);
  assert.match(next, /not-run/);
  assert.match(next, /FACT-\d+ \[observed\] The app entry point is src\/index\.js/);
  assert.match(next, /web\.search: do not use or re-request/);

  // 8. The trace explains the run without prompt text.
  const explain = brain(['explain-last-run'], { cwd: a, env });
  assert.match(explain.out, /context injected/);
  const trace = read(path.join(a, '.agent-brain', 'local', 'events.jsonl'));
  // Only catalog trigger words that matched are recorded (for "why this skill"); free prompt text never is.
  assert.doesNotMatch(trace, /ZEPHYRQUILL|summarise their pricing|lists saved addresses/i);
  assert.match(trace, /"type":"enforcement"/);

  // 9. Isolation: project B has no brain → hooks are idle there; A's memory never appears.
  const bStart = runHookCommand(cmd.SessionStart, { ...sess, cwd: b }, { env });
  assert.equal(bStart.out, '');
  assert.equal(brain(['init'], { cwd: b, env }).code, 0);
  const bCtx = JSON.parse(runHookCommand(cmd.SessionStart, { ...sess, cwd: b }, { env }).out).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(bCtx, /src\/index\.js|fixture-app|web\.search/);
  assert.notEqual(bCtx.match(/id ([0-9a-f]{16})/)[1], next.match(/id ([0-9a-f]{16})/)[1]);

  // 10. Uninstall removes only owned config; brain data stays.
  assert.equal(brain(['uninstall', '--yes'], { cwd: a, env }).code, 0);
  assert.ok(!fs.existsSync(path.join(a, '.claude', 'settings.local.json')));
  assert.ok(fs.existsSync(path.join(a, '.agent-brain', 'facts.yaml')));
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'global config never touched');
});
