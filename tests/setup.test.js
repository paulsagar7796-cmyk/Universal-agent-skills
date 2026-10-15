import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, NODE_FIXTURE, brain, read, tmpDir } from './helpers.js';
import { planSetup, applySetup, planUninstall, applyUninstall, smokeTest, mergeClaudeSettings, OWNER_MARK } from '../src/setup.js';

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
  assert.equal(owned(s).length, 6, 'SessionStart, UserPromptSubmit, Stop, PreCompact, SessionEnd, PreToolUse');
  assert.equal(s.hooks.PreToolUse.find((g) => g.hooks[0].command.includes(OWNER_MARK)).matcher, 'WebSearch|WebFetch|mcp__github__.*');
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
  assert.equal(owned(moved).length, 6);
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
  assert.match(doc.out, /6 owned Claude Code hook\(s\)/);
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
