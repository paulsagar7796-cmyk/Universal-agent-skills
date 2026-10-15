import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeRepo, NODE_FIXTURE, BRAIN_JS, REPO } from './helpers.js';
import { resolveProject } from '../src/project.js';
import { BrainStore } from '../src/store.js';
import { initBrain } from '../src/init.js';
import { openIndex, fallbackSearch, sqliteStatus } from '../src/index-db.js';
import { appendEvent, makeEvent, readEvents, pruneEvents } from '../src/events.js';
import { proposeFact, listProposals } from '../src/proposals.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function fresh() {
  const dir = makeRepo(NODE_FIXTURE);
  const project = resolveProject(dir);
  const store = new BrainStore(project);
  initBrain(store, project);
  return { dir, project, store };
}

const ids = (rows) => rows.map((r) => r.ref).sort();
const sq = sqliteStatus();
const needsSqlite = sq.available ? {} : { skip: `SQLite/FTS5 not available in this Node build: ${sq.reason}` };

test('index is rebuilt from canonical files after deletion with identical results', needsSqlite, () => {
  const { store } = fresh();
  let o = openIndex(store);
  const before = o.index.search('vitest');
  assert.ok(before.length > 0);
  o.index.close();
  const file = path.join(store.localDir(), 'index.sqlite');
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  o = openIndex(store);
  assert.equal(o.status, 'rebuilt');
  assert.deepEqual(ids(o.index.search('vitest')), ids(before));
  o.index.close();
});

test('corrupt index is moved aside and recovered', needsSqlite, () => {
  const { store } = fresh();
  openIndex(store).index.close();
  const file = path.join(store.localDir(), 'index.sqlite');
  for (const s of ['-wal', '-shm']) fs.rmSync(file + s, { force: true });
  fs.writeFileSync(file, 'this is not a sqlite database'.repeat(100));
  const o = openIndex(store);
  assert.equal(o.status, 'recovered');
  assert.ok(o.index.search('react').length > 0);
  assert.ok(fs.readdirSync(store.localDir()).some((f) => f.startsWith('index.sqlite.corrupt-')));
  o.index.close();
});

test('index copied from another project is rebuilt (project isolation)', needsSqlite, () => {
  const a = fresh();
  const b = fresh();
  openIndex(a.store).index.close();
  openIndex(b.store).index.close();
  fs.copyFileSync(path.join(a.store.localDir(), 'index.sqlite'), path.join(b.store.localDir(), 'index.sqlite'));
  for (const s of ['-wal', '-shm']) fs.rmSync(path.join(b.store.localDir(), 'index.sqlite') + s, { force: true });
  const o = openIndex(b.store);
  assert.equal(o.status, 'rebuilt');
  assert.match(o.reason ?? '', /different project/);
  o.index.close();
});

test('canonical edits make the index stale and trigger a rebuild', needsSqlite, () => {
  const { store } = fresh();
  openIndex(store).index.close();
  fs.appendFileSync(store.p('architecture.md'), '\n## Payments\n\nStripe webhooks are verified in src/pay.ts#verify.\n');
  const o = openIndex(store);
  assert.equal(o.status, 'rebuilt');
  assert.ok(o.index.search('stripe webhooks').length > 0);
  o.index.close();
});

test('file-scan fallback matches SQLite on simple queries', needsSqlite, () => {
  const { store } = fresh();
  const o = openIndex(store);
  for (const q of ['vitest', 'github actions', 'package manager']) {
    const sql = o.index.search(q).map((r) => r.ref);
    const fb = fallbackSearch(store, q).map((r) => r.ref);
    assert.ok(sql.length > 0, q);
    assert.ok(fb.includes(sql[0]), `fallback should contain top SQLite hit for "${q}"`);
  }
  o.index.close();
});

test('without SQLite (BRAIN_DISABLE_SQLITE) the CLI uses file-scan search', async () => {
  const { dir } = fresh();
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [BRAIN_JS, 'search', 'vitest'], { cwd: dir, encoding: 'utf8', env: { ...process.env, BRAIN_DISABLE_SQLITE: '1' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /file scan/);
  assert.match(r.stdout, /FACT-/);
});

test('events are idempotent by event_id with and without the index, and never store secrets', () => {
  const { store } = fresh();
  const e = makeEvent('checkpoint', { a: 1 }, { eventId: 'fixed-id' });
  const o = openIndex(store);
  assert.equal(appendEvent(store, e, { index: o.index }), true);
  assert.equal(appendEvent(store, e, { index: o.index }), false);
  o.index?.close();
  const e2 = makeEvent('checkpoint', { b: 2 }, { eventId: 'fixed-id-2' });
  assert.equal(appendEvent(store, e2), true);
  assert.equal(appendEvent(store, e2), false);
  const leak = makeEvent('route', { note: 'ghp_' + 'Z9y8X7w6'.repeat(5) });
  assert.equal(leak.data.redacted, true);
  assert.equal(readEvents(store).filter((x) => x.event_id.startsWith('fixed-id')).length, 2);
});

test('event retention prunes old entries', () => {
  const { store } = fresh();
  appendEvent(store, makeEvent('x', {}, { ts: '2020-01-01T00:00:00.000Z', eventId: 'old' }));
  appendEvent(store, makeEvent('x', {}, { eventId: 'new' }));
  const removed = pruneEvents(store, { days: 30, maxLines: 1000 });
  assert.equal(removed, 1);
  assert.deepEqual(readEvents(store).map((e) => e.event_id), ['new']);
});

test('concurrent approvals from separate processes never lose a write', async () => {
  const { dir, store } = fresh();
  const n = 6;
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
  const props = [];
  for (let i = 0; i < n; i++) props.push(proposeFact(store, { claim: `File f${i}.txt holds the value ${i}.`, evidence: [`file:f${i}.txt`] }, { config: DEFAULT_CONFIG }).proposal.id);
  const before = store.loadFacts().doc.facts.length;
  await Promise.all(
    props.map(
      (id) =>
        new Promise((resolve, reject) => {
          // Separate processes calling the library directly (the CLI `approve` needs a person at a terminal).
          const code = `import { resolveProject } from '${path.join(REPO, 'src/project.js')}'; import { BrainStore } from '${path.join(REPO, 'src/store.js')}'; import { applyProposal } from '${path.join(REPO, 'src/proposals.js')}'; applyProposal(new BrainStore(resolveProject(process.cwd())), '${id}');`;
          const c = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, stdio: 'ignore' });
          c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`approve ${id} exited ${code}`))));
        }),
    ),
  );
  const facts = store.loadFacts().doc.facts;
  assert.equal(facts.length, before + n);
  assert.equal(new Set(facts.map((f) => f.id)).size, facts.length, 'ids are unique');
  assert.equal(listProposals(store).length, 0);
});
