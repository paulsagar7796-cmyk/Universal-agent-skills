import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, NODE_FIXTURE, brain, read, tmpDir } from './helpers.js';
import { resolveProject } from '../src/project.js';
import { BrainStore } from '../src/store.js';
import { initBrain } from '../src/init.js';
import { freshness, validateFact, parseEvidenceSpec } from '../src/facts.js';
import { proposeFact, applyProposal, listProposals, proposeDecision } from '../src/proposals.js';
import { writeHandoff } from '../src/handoff.js';
import { audit } from '../src/audit.js';
import { buildContext } from '../src/context.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { findSecrets } from '../src/secrets.js';

const cfg = structuredClone(DEFAULT_CONFIG);
const fakeGithubToken = () => 'ghp_' + 'A1b2C3d4'.repeat(5);

function setup(files = NODE_FIXTURE) {
  const dir = makeRepo(files);
  const project = resolveProject(dir);
  const store = new BrainStore(project);
  const summary = initBrain(store, project);
  return { dir, project, store, summary };
}

test('init records only evidence-backed observations and lists commands it did not run', () => {
  const { store, summary } = setup({ ...NODE_FIXTURE, '.env': 'SECRET_TOKEN=do-not-read-me\n' });
  const { doc, errors } = store.loadFacts();
  assert.deepEqual(errors, []);
  for (const f of doc.facts.filter((x) => ['observed', 'verified'].includes(x.status))) assert.ok(f.evidence.length > 0, `${f.id} has evidence`);
  const fileEv = doc.facts.flatMap((f) => f.evidence ?? []).filter((e) => e.kind === 'file');
  assert.ok(fileEv.every((e) => e.sha256 && e.path && !e.path.startsWith('/')));
  assert.ok(doc.facts.some((f) => f.key === 'command.test' && /not run/.test(f.claim)));
  assert.deepEqual(summary.notes.commandsNotRun, ['npm run test', 'npm run build']);
  assert.ok(doc.facts.some((f) => f.status === 'unknown' && f.key === 'product.goal'), 'goal stays unknown');
  for (const rel of store.canonicalFiles()) assert.ok(!read(store.p(rel)).includes('do-not-read-me'), `.env content leaked into ${rel}`);
  assert.match(read(store.p('project.md')), /README description \(observed, unconfirmed\)/);
});

test('init is idempotent and supersedes facts whose source changed', () => {
  const { dir, project, store } = setup();
  const before = store.loadFacts().doc.facts.length;
  const again = initBrain(store, project);
  assert.equal(again.added.length, 0);
  assert.equal(store.loadFacts().doc.facts.length, before);
  const pkg = JSON.parse(read(path.join(dir, 'package.json')));
  pkg.scripts.test = 'node --test';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const old = store.loadFacts().doc.facts.find((f) => f.key === 'command.test');
  assert.equal(freshness(old, dir).state, 'changed');
  const r = initBrain(store, project);
  assert.ok(r.superseded.includes(old.id));
  const after = store.loadFacts().doc.facts;
  assert.equal(after.find((f) => f.id === old.id).status, 'deprecated');
  assert.match(after.find((f) => f.key === 'command.test' && f.status === 'observed').claim, /node --test/);
});

test('init handles empty, python and ambiguous-lockfile projects without inventing facts', () => {
  const empty = setup({});
  assert.ok(empty.summary.notes.types.includes('empty'));
  assert.ok(!empty.store.loadFacts().doc.facts.some((f) => f.category === 'stack'));
  const py = setup({ 'pyproject.toml': '[project]\nname = "svc"\nrequires-python = ">=3.11"\ndependencies = ["fastapi>=0.110", "pytest"]\n[tool.pytest.ini_options]\n', 'uv.lock': '' });
  const pf = py.store.loadFacts().doc.facts;
  assert.ok(pf.some((f) => f.key === 'python.requires' && f.claim.includes('>=3.11')));
  assert.ok(pf.some((f) => f.key === 'python.frameworks' && /FastAPI/.test(f.claim)));
  const amb = setup({ 'package.json': '{"name":"x"}', 'yarn.lock': '', 'package-lock.json': '{}' });
  assert.equal(amb.store.loadFacts().doc.facts.find((f) => f.key === 'tooling.package_manager').status, 'disputed');
});

test('fact validation enforces evidence and statuses', () => {
  assert.ok(validateFact({ id: 'FACT-0001', claim: 'Uses Postgres', status: 'observed', evidence: [] }).some((e) => /require at least one evidence/.test(e)));
  assert.deepEqual(validateFact({ id: 'FACT-0001', claim: 'Maybe Redis', status: 'assumption', test_by: 'check compose' }), []);
  assert.ok(validateFact({ id: 'X', claim: 'c', status: 'nope' }).length >= 2);
  const root = tmpDir();
  assert.throws(() => parseEvidenceSpec('file:../outside.txt', root), /escapes/);
  assert.throws(() => parseEvidenceSpec('file:missing.txt', root), /does not exist/);
  assert.deepEqual(parseEvidenceSpec('cmd:0:npm test', root, '2026-01-01'), { kind: 'command', command: 'npm test', exit_code: 0, checked_at: '2026-01-01' });
});

test('freshness reports missing and expired evidence', () => {
  const { dir, store } = setup();
  const f = store.loadFacts().doc.facts.find((x) => x.key === 'docs.readme');
  fs.rmSync(path.join(dir, 'README.md'));
  assert.equal(freshness(f, dir).state, 'missing');
  const g = { id: 'FACT-0100', claim: 'x', status: 'verified', evidence: [{ kind: 'url', url: 'https://example.invalid', checked_at: '2020-01-01' }], last_verified: '2020-01-01', expires_after_days: 30 };
  assert.equal(freshness(g, dir, '2026-10-15').state, 'expired');
});

test('memory proposals: low-risk apply, conflicts become disputed or superseded, duplicates and secrets rejected', () => {
  const { store } = setup();
  const a = proposeFact(store, { claim: 'The primary database is PostgreSQL 16.', key: 'db.primary', evidence: ['file:package.json'] }, { config: cfg });
  assert.equal(a.proposal.risk, 'low');
  assert.equal(a.applied, null, 'auto-accept is off by default');
  const fa = applyProposal(store, a.proposal.id);
  const b = proposeFact(store, { claim: 'The primary database is SQLite.', key: 'db.primary', evidence: ['file:src/index.js'] }, { config: cfg });
  assert.equal(b.proposal.risk, 'review');
  assert.deepEqual(b.proposal.conflicts, [fa.id]);
  const fb = applyProposal(store, b.proposal.id);
  const facts = store.loadFacts().doc.facts;
  assert.equal(facts.find((f) => f.id === fa.id).status, 'disputed');
  assert.equal(facts.find((f) => f.id === fb.id).status, 'disputed');
  const c = proposeFact(store, { claim: 'The primary database is MySQL.', key: 'db.primary', evidence: ['file:package.json'] }, { config: cfg });
  const fc = applyProposal(store, c.proposal.id, { resolution: 'supersede' });
  const after = store.loadFacts().doc.facts;
  assert.equal(after.find((f) => f.id === fa.id).status, 'deprecated');
  assert.equal(after.find((f) => f.id === fa.id).superseded_by, fc.id);
  assert.throws(() => proposeFact(store, { claim: 'The primary database is MySQL.', evidence: ['file:package.json'] }, { config: cfg }), /already recorded/);
  assert.throws(() => proposeFact(store, { claim: `token ${fakeGithubToken()}`, status: 'assumption' }, { config: cfg }), /credential/);
  assert.throws(() => proposeFact(store, { claim: 'unsupported', status: 'verified' }, { config: cfg }), /evidence/);
  assert.match(read(store.p('open-questions.md')), /Disputed claims/);
});

test('an evidence-backed fact answers a same-key open question instead of disputing it', () => {
  const { store } = setup();
  const q = store.loadFacts().doc.facts.find((f) => f.key === 'verification.baseline' && f.status === 'unknown');
  assert.ok(q, 'init recorded the verification question');
  const { proposal } = proposeFact(store, { claim: 'npm test passes on a clean checkout (12 tests).', status: 'verified', key: 'verification.baseline', evidence: ['cmd:0:npm test'] }, { config: cfg });
  assert.deepEqual(proposal.conflicts, []);
  assert.deepEqual(proposal.answers, [q.id]);
  const r = applyProposal(store, proposal.id);
  const facts = store.loadFacts().doc.facts;
  assert.equal(facts.find((f) => f.id === r.id).status, 'verified');
  assert.equal(facts.find((f) => f.id === q.id).status, 'deprecated');
  assert.equal(facts.find((f) => f.id === q.id).superseded_by, r.id);
  assert.deepEqual(r.answered, [q.id]);
});

test('auto-accept applies only low-risk proposals when enabled', () => {
  const { store } = setup();
  const on = { ...cfg, memory: { auto_accept_low_risk: true } };
  const low = proposeFact(store, { claim: 'CI runs on GitHub Actions only.', evidence: ['file:.github/workflows/ci.yml'] }, { config: on });
  assert.ok(low.applied?.id);
  const risky = proposeFact(store, { claim: 'Checkout must support SCA.', category: 'requirement', evidence: ['user:PM on 2026-10-15'] }, { config: on });
  assert.equal(risky.applied, null);
  assert.equal(listProposals(store).length, 1);
});

test('decisions are proposed then written as ADRs with an index', () => {
  const { store } = setup();
  const { proposal } = proposeDecision(store, { title: 'Use Postgres', decision: 'Adopt PostgreSQL 16', alternatives: ['SQLite', 'MySQL'], consequences: 'Needs a managed instance' });
  const r = applyProposal(store, proposal.id);
  assert.equal(r.id, 'ADR-0001');
  assert.match(read(store.p(r.file)), /## Alternatives considered\n\n- SQLite/);
  assert.match(read(store.p('decisions/index.md')), /ADR-0001.*Use Postgres.*accepted/);
});

test('handoff captures checks honestly and git state automatically', () => {
  const { dir, project, store } = setup();
  fs.writeFileSync(path.join(dir, 'src/new.js'), 'export {}\n');
  const r = writeHandoff(store, resolveProject(dir), { task: 'Add new module', done: ['created src/new.js'], checks: ['npm test=not-run: deps missing', 'npm run lint=passed'], next: ['wire it up'] });
  const text = read(store.p(r.file));
  assert.match(text, /`npm test` — \*\*not-run\*\* \(deps missing\)/);
  assert.match(text, /src\/new\.js/);
  assert.throws(() => writeHandoff(store, project, { task: 'x', checks: ['npm test=green'] }), /passed\|failed/);
  assert.match(read(store.p('status.md')), /Last handoff/);
});

test('audit flags secrets written by hand and stale evidence', () => {
  const { dir, project, store } = setup();
  fs.appendFileSync(store.p('architecture.md'), `\nToken: ${fakeGithubToken()}\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Changed\n');
  const r = audit(store, project);
  assert.ok(r.errors.some((e) => /architecture\.md: possible credential/.test(e)));
  assert.ok(r.warnings.some((w) => /evidence changed/.test(w)));
});

test('context packet respects the budget and names omitted sections', () => {
  const { project, store } = setup();
  const full = buildContext({ store, project: resolveProject(project.root), config: cfg, cli: 'brain' });
  assert.ok(full.text.length <= cfg.context.max_chars);
  assert.match(full.text, /Key facts/);
  const tiny = buildContext({ store, project: resolveProject(project.root), config: { ...cfg, context: { ...cfg.context, max_chars: 900 } }, cli: 'brain' });
  assert.ok(tiny.text.length <= 1400, `tiny context ${tiny.text.length}`);
  assert.ok(tiny.omitted.length > 0);
  assert.match(tiny.text, /Omitted for the 900-char budget/);
});

test('secret detector catches common formats and ignores placeholders', () => {
  assert.deepEqual(findSecrets('password: ${DB_PASSWORD}'), []);
  assert.deepEqual(findSecrets('api_key=<YOUR_KEY>'), []);
  assert.ok(findSecrets(fakeGithubToken()).includes('github-token'));
  assert.ok(findSecrets('AKIA' + 'ABCDEFGHIJKLMNOP').includes('aws-access-key-id'));
  assert.ok(findSecrets('https://user:' + 'hunter2hunter2@example.invalid').includes('url-credentials'));
  assert.ok(findSecrets('-----BEGIN RSA ' + 'PRIVATE KEY-----').includes('private-key'));
});

test('CLI refuses to initialise a home directory', () => {
  const home = tmpDir();
  const r = brain(['init'], { cwd: home, env: { HOME: home } });
  assert.equal(r.code, 1);
  assert.match(r.err, /home directory/);
  assert.ok(!fs.existsSync(path.join(home, '.agent-brain')));
});
