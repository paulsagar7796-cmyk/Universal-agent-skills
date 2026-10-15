import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeRepo, NODE_FIXTURE, brain, hook, read, tmpDir } from './helpers.js';
import { planSetup, applySetup, planUninstall, applyUninstall, smokeTest, mergeClaudeSettings, hookCommand, verifyControllerFiles, OWNER_MARK } from '../src/setup.js';

const USER_SETTINGS = {
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
    PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }],
  },
};

function env() {
  const home = tmpDir('asb-home-');
  const dir = makeRepo(NODE_FIXTURE);
  return { home, dir, settings: path.join(dir, '.claude', 'settings.local.json') };
}

const owned = (s) => Object.values(s.hooks ?? {}).flat().flatMap((g) => g.hooks).filter((h) => h.command.includes(OWNER_MARK));

test('planning writes nothing (dry run)', () => {
  const { home, dir, settings } = env();
  const plan = planSetup({ cwd: dir, home });
  assert.ok(plan.changes.length >= 2);
  assert.ok(!fs.existsSync(settings));
  assert.ok(!fs.existsSync(path.join(dir, '.agent-brain')));
  assert.equal(fs.readdirSync(home).length, 0);
});

test('project setup preserves unrelated settings, is idempotent, smoke-tests, and uninstalls only owned entries', () => {
  const { home, dir, settings } = env();
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(USER_SETTINGS, null, 2));
  const plan = planSetup({ cwd: dir, home });
  const res = applySetup(plan);
  const settingsBackup = res.backups.find((b) => b.path === settings);
  assert.ok(settingsBackup, 'existing settings were backed up');
  assert.deepEqual(JSON.parse(read(settingsBackup.backup)), USER_SETTINGS);
  assert.ok(res.backups.some((b) => b.path.endsWith(path.join('info', 'exclude'))), 'pre-existing .git/info/exclude backed up too');
  const s = JSON.parse(read(settings));
  assert.deepEqual(s.permissions, USER_SETTINGS.permissions);
  assert.ok(s.hooks.SessionStart.some((g) => g.hooks[0].command === 'echo user-hook'));
  assert.deepEqual(s.hooks.PostToolUse, USER_SETTINGS.hooks.PostToolUse);
  assert.equal(owned(s).length, 7, 'SessionStart, UserPromptSubmit, Stop, PreCompact, SessionEnd + 2 PreToolUse groups');
  const pre = s.hooks.PreToolUse.filter((g) => g.hooks[0].command.includes(OWNER_MARK));
  assert.deepEqual(pre.map((g) => g.matcher), ['WebSearch|WebFetch|mcp__github__.*', 'Bash|Edit|Write|NotebookEdit|MultiEdit']);
  assert.equal(pre[0].hooks[0].onFailure, 'block', 'capability enforcement fails closed in the host');
  assert.equal(pre[1].hooks[0].onFailure, undefined, 'the shell/edit guard does not paralyse the agent if the controller breaks');
  assert.ok(fs.existsSync(path.join(dir, '.agent-brain', 'facts.yaml')), 'brain initialised');
  const excl = read(path.join(dir, '.git', 'info', 'exclude'));
  assert.match(excl, /\.claude\/settings\.local\.json/);
  execFileSync('git', ['check-ignore', '-q', '.claude/settings.local.json'], { cwd: dir });

  const st = smokeTest(plan);
  assert.equal(st.ok, true, JSON.stringify(st));

  const again = planSetup({ cwd: dir, home });
  assert.equal(again.noop, true, 'second run is a no-op');

  const un = planUninstall({ cwd: dir, home });
  applyUninstall(un);
  const after = JSON.parse(read(settings));
  assert.deepEqual(after, USER_SETTINGS, 'exactly the original user settings remain');
  assert.doesNotMatch(read(path.join(dir, '.git', 'info', 'exclude')), /agent-skills-brain/);
  assert.ok(fs.existsSync(path.join(dir, '.agent-brain')), 'brain data is kept');
  assert.ok(!fs.existsSync(path.join(dir, '.agent-brain', 'local', 'install.json')));
});

test('settings file created by setup is deleted on uninstall', () => {
  const { home, dir, settings } = env();
  applySetup(planSetup({ cwd: dir, home }));
  assert.ok(fs.existsSync(settings));
  applyUninstall(planUninstall({ cwd: dir, home }));
  assert.ok(!fs.existsSync(settings));
});

test('global scope writes only to the (temporary) HOME and is reversible', () => {
  const { home, dir } = env();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
  const plan = planSetup({ cwd: dir, home, scope: 'global', enforceDenials: false });
  applySetup(plan);
  const g = JSON.parse(read(path.join(home, '.claude', 'settings.json')));
  assert.equal(g.model, 'opus');
  assert.equal(owned(g).length, 5, 'no PreToolUse when enforcement is off');
  assert.ok(fs.existsSync(path.join(home, '.agent-skills-brain', 'install.json')));
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'project untouched');
  applyUninstall(planUninstall({ cwd: dir, home, scope: 'global' }));
  assert.deepEqual(JSON.parse(read(path.join(home, '.claude', 'settings.json'))), { model: 'opus' });
});

test('invalid JSON settings are never overwritten', () => {
  const { home, dir, settings } = env();
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{ "permissions": { oops');
  assert.throws(() => planSetup({ cwd: dir, home }), /not valid JSON/);
  assert.equal(read(settings), '{ "permissions": { oops');
});

test('changes made after the plan was shown abort the apply', () => {
  const { home, dir, settings } = env();
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{}');
  const plan = planSetup({ cwd: dir, home });
  fs.writeFileSync(settings, '{"changed": true}');
  assert.throws(() => applySetup(plan), /changed after the plan/);
  assert.equal(read(settings), '{"changed": true}');
});

test('AGENTS.md fallback block is added to existing files and removed cleanly', () => {
  const { home, dir } = env();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Team rules\n\nUse pnpm.\n');
  applySetup(planSetup({ cwd: dir, home, agents: ['agents-md'] }));
  const t = read(path.join(dir, 'AGENTS.md'));
  assert.match(t, /^# Team rules\n\nUse pnpm\.\n\n<!-- agent-skills-brain:begin/);
  assert.ok(!t.includes(home) && !t.includes('/bin/brain.js'), 'no machine-specific paths in a committed file');
  applyUninstall(planUninstall({ cwd: dir, home }));
  assert.equal(read(path.join(dir, 'AGENTS.md')), '# Team rules\n\nUse pnpm.\n');
});

test('mergeClaudeSettings replaces owned groups in place', () => {
  const ctrl = { node: '/usr/bin/node', brainJs: '/opt/asb/bin/brain.js' };
  const once = mergeClaudeSettings(USER_SETTINGS, ctrl);
  const twice = mergeClaudeSettings(once, ctrl);
  assert.deepEqual(twice, once);
  const moved = mergeClaudeSettings(once, { node: '/usr/bin/node', brainJs: '/new/path/brain.js' });
  assert.equal(owned(moved).length, 7);
  assert.ok(owned(moved).every((h) => h.command.includes('/new/path/brain.js')));
  assert.throws(() => mergeClaudeSettings({}, { node: '/usr/bin/node', brainJs: '/tmp/a"b/brain.js' }), /unsafe/);
});

test('CLI: non-interactive setup without --yes needs consent and changes nothing; --yes applies; re-run is a no-op', () => {
  const { home, dir, settings } = env();
  const e = { HOME: home };
  const dry = brain(['setup', '--agent', 'claude-code', '--dry-run'], { cwd: dir, env: e });
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Dry run: no changes were made/);
  const noConsent = brain(['setup', '--agent', 'claude-code'], { cwd: dir, env: e, input: '' });
  assert.equal(noConsent.code, 3);
  assert.ok(!fs.existsSync(settings));
  assert.ok(!fs.existsSync(path.join(dir, '.agent-brain')));
  const yes = brain(['setup', '--agent', 'claude-code', '--yes'], { cwd: dir, env: e });
  assert.equal(yes.code, 0, yes.out + yes.err);
  assert.match(yes.out, /hook smoke test \.+ passed/);
  assert.match(yes.out, /delivery by the host \.+ not verified by setup/);
  const again = brain(['setup', '--agent', 'claude-code', '--yes'], { cwd: dir, env: e });
  assert.match(again.out, /Already configured/);
  const doc = brain(['doctor'], { cwd: dir, env: e });
  assert.match(doc.out, /7 owned Claude Code hook\(s\) in .* match the expected configuration/);
  assert.match(doc.out, /controller files match the state approved at setup/);
  const un = brain(['uninstall', '--yes'], { cwd: dir, env: e });
  assert.equal(un.code, 0);
  assert.ok(!fs.existsSync(settings));
});

test('plain CLI commands never create agent configuration', () => {
  const { home, dir } = env();
  const e = { HOME: home };
  brain(['init'], { cwd: dir, env: e });
  for (const args of [['status'], ['context'], ['doctor'], ['search', 'react'], ['capabilities'], ['route', 'implement a feature']]) brain(args, { cwd: dir, env: e });
  assert.ok(!fs.existsSync(path.join(dir, '.claude')));
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));
});

test('package.json declares no install-time lifecycle scripts', () => {
  const pkg = JSON.parse(read(path.join(process.cwd(), 'package.json')));
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'preprepare', 'postprepare']) assert.equal(pkg.scripts?.[k], undefined, k);
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'zero runtime dependencies');
});

test('--harden adds sandbox denyWrite + Edit deny rules idempotently, keeps user choices, and uninstalls exactly what it added', () => {
  const { home, dir, settings } = env();
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ sandbox: { allowUnsandboxedCommands: true, filesystem: { denyWrite: ['~/secret'] } }, permissions: { deny: ['Read(./.env)'] } }, null, 2));
  const plan = planSetup({ cwd: dir, home, harden: true });
  assert.ok(plan.warnings.some((w) => /OS sandbox/.test(w)));
  applySetup(plan);
  const s = JSON.parse(read(settings));
  const policyDir = path.join(dir, '.agent-brain', 'local', 'policy');
  assert.ok(s.sandbox.filesystem.denyWrite.includes(policyDir));
  assert.ok(s.sandbox.filesystem.denyWrite.includes('~/secret'), 'user entry kept');
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, true, "an existing user choice is never overwritten");
  assert.ok(s.permissions.deny.includes(`Edit(/${policyDir}/**)`));
  assert.ok(s.permissions.deny.includes('Read(./.env)'));
  assert.equal(planSetup({ cwd: dir, home, harden: true }).noop, true, 'idempotent');
  applyUninstall(planUninstall({ cwd: dir, home }));
  assert.deepEqual(JSON.parse(read(settings)), { sandbox: { allowUnsandboxedCommands: true, filesystem: { denyWrite: ['~/secret'] } }, permissions: { deny: ['Read(./.env)'] } });
  assert.throws(() => planSetup({ cwd: dir, home, scope: 'global', harden: true }), /project scope only/);
});

test('hook command falls back to PATH node when the recorded node binary disappears', () => {
  const { home, dir } = env();
  const ctrl = { node: path.join(tmpDir(), 'gone', 'node'), brainJs: path.join(process.cwd(), 'bin', 'brain.js') };
  const cmd = hookCommand(ctrl, 'session-start');
  brain(['init'], { cwd: dir, env: { HOME: home } });
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify({ session_id: 's', cwd: dir, source: 'startup' }), encoding: 'utf8', env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Project brain/);
});

test('changed controller files are detected; repair re-records only after consent; registry drift fails closed', () => {
  const { home, dir } = env();
  applySetup(planSetup({ cwd: dir, home }));
  const m = JSON.parse(read(path.join(dir, '.agent-brain', 'local', 'install.json')));
  assert.equal(m.state, 'complete');
  assert.ok(m.controller.files['integrations/capabilities.yaml']);
  assert.equal(verifyControllerFiles(m.controller.files).ok, true);
  // Simulate tampering with the recorded state instead of the real repository files.
  m.controller.files['integrations/capabilities.yaml'] = 'f'.repeat(64);
  m.controller.files['src/old-removed.js'] = 'a'.repeat(64);
  fs.writeFileSync(path.join(dir, '.agent-brain', 'local', 'install.json'), JSON.stringify(m));
  const v = verifyControllerFiles(m.controller.files);
  assert.deepEqual([v.modified, v.missing], [['integrations/capabilities.yaml'], ['src/old-removed.js']]);
  const blocked = hook('pre-tool-use', { session_id: 's', cwd: dir, tool_name: 'WebSearch', tool_input: {} });
  assert.equal(blocked.code, 2, 'registry changed since setup → protected tools fail closed');
  assert.match(blocked.err, /registry changed since setup/);
  assert.equal(hook('pre-tool-use', { session_id: 's', cwd: dir, tool_name: 'Read', tool_input: {} }).code, 0);
  const doc = brain(['doctor'], { cwd: dir, env: { HOME: home } });
  assert.match(doc.out, /controller files changed since setup/);
  const repair = planSetup({ cwd: dir, home });
  assert.ok(repair.changes.some((c) => c.kind === 'record'), 're-recording is an explicit, consented change');
  applySetup(repair);
  assert.equal(hook('pre-tool-use', { session_id: 's', cwd: dir, tool_name: 'WebSearch', tool_input: {} }).code, 0);
});

test('an interrupted setup is visible to doctor', () => {
  const { home, dir } = env();
  applySetup(planSetup({ cwd: dir, home }));
  const f = path.join(dir, '.agent-brain', 'local', 'install.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(read(f)), state: 'applying' }));
  assert.match(brain(['doctor'], { cwd: dir, env: { HOME: home } }).out, /setup was interrupted/);
});
