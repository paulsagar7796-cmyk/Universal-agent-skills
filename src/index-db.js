// Disposable local search index. Canonical data lives in Markdown/YAML; this file can be deleted at any time and is
// rebuilt from those files. If node:sqlite is unavailable (or BRAIN_DISABLE_SQLITE=1) a file-scan fallback is used.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse } from './yaml.js';
import { markdownSections } from './store.js';
import { readTextIfExists, nowIso } from './util.js';

export const INDEX_SCHEMA_VERSION = 1;
const MIGRATIONS = {
  1: [
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, kind UNINDEXED, ref UNINDEXED, title, body, tokenize='porter unicode61')",
    'CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, status TEXT NOT NULL, key TEXT, category TEXT, claim TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, session TEXT, data TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS events_ts ON events(ts)',
  ],
};

let DatabaseSync = null;
let sqliteLoadError = null;
function sqlite() {
  if (process.env.BRAIN_DISABLE_SQLITE === '1') {
    sqliteLoadError = 'disabled by BRAIN_DISABLE_SQLITE=1';
    return null;
  }
  if (DatabaseSync || sqliteLoadError) return DatabaseSync;
  let Db;
  try {
    ({ DatabaseSync: Db } = createRequire(import.meta.url)('node:sqlite'));
  } catch (e) {
    sqliteLoadError = `node:sqlite unavailable (${e.code ?? e.message}); requires Node >= 22.13`;
    return null;
  }
  // Some Node builds bundle SQLite without FTS5 (observed: Node 22.13.0). Treat that like "no SQLite".
  try {
    const probe = new Db(':memory:');
    probe.exec('CREATE VIRTUAL TABLE fts_probe USING fts5(a)');
    probe.close();
    DatabaseSync = Db;
  } catch {
    sqliteLoadError = `node:sqlite in Node ${process.versions.node} lacks FTS5; using file-scan search`;
  }
  return DatabaseSync;
}

export function sqliteStatus() {
  sqlite();
  return DatabaseSync ? { available: true } : { available: false, reason: sqliteLoadError };
}

/** Split canonical brain files into searchable documents. Shared by the SQLite index and the fallback scanner. */
export function extractDocs(store) {
  const docs = [];
  for (const rel of store.canonicalFiles()) {
    const text = readTextIfExists(store.p(rel), 2 * 1024 * 1024);
    if (text === null) continue;
    if (rel === 'facts.yaml') {
      let doc;
      try {
        doc = parse(text);
      } catch {
        docs.push({ path: rel, kind: 'file', ref: rel, title: rel, body: text });
        continue;
      }
      for (const f of doc?.facts ?? []) {
        const evidence = (f.evidence ?? []).map((e) => e.path ?? e.command ?? e.url ?? e.note).join(' ');
        docs.push({ path: rel, kind: 'fact', ref: f.id, title: `${f.id} [${f.status}] ${f.claim}`, body: [f.claim, f.key, f.category, f.question, f.test_by, f.confidence_note, evidence].filter(Boolean).join('\n') });
      }
      continue;
    }
    if (rel.endsWith('.md')) {
      const kind = rel.startsWith('decisions/ADR-') ? 'decision' : rel.startsWith('handoffs/') ? 'handoff' : rel.startsWith('plans/') ? 'plan' : 'markdown';
      for (const [heading, body] of Object.entries(markdownSections(text))) {
        if (!body) continue;
        const title = heading === '_preamble' ? (text.match(/^#\s+(.+)$/m)?.[1] ?? rel) : heading;
        docs.push({ path: rel, kind, ref: heading === '_preamble' ? rel : `${rel}#${heading}`, title, body });
      }
      continue;
    }
    docs.push({ path: rel, kind: 'file', ref: rel, title: rel, body: text });
  }
  return docs;
}

function tokens(q) {
  return [...new Set((String(q).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1))].slice(0, 12);
}

/** File-scan search used when SQLite is unavailable. Same result shape as Index.search. */
export function fallbackSearch(store, query, limit = 10) {
  const toks = tokens(query);
  if (!toks.length) return [];
  const scored = extractDocs(store).map((d) => {
    const title = d.title.toLowerCase();
    const body = d.body.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of toks) {
      const n = body.split(t).length - 1 + 2 * (title.split(t).length - 1);
      if (n) matched++;
      score += n;
    }
    return { ...d, score, matched };
  });
  const all = scored.filter((d) => d.matched === toks.length);
  const pool = all.length ? all : scored.filter((d) => d.matched > 0);
  return pool
    .sort((a, b) => b.matched - a.matched || b.score - a.score)
    .slice(0, limit)
    .map((d) => ({ path: d.path, kind: d.kind, ref: d.ref, title: d.title, snippet: snippetOf(d.body, toks) }));
}

function snippetOf(body, toks) {
  const lower = body.toLowerCase();
  const at = Math.max(0, Math.min(...toks.map((t) => lower.indexOf(t)).filter((i) => i >= 0)));
  const s = body.slice(Math.max(0, at - 60), at + 120).replace(/\s+/g, ' ').trim();
  return (at > 60 ? '…' : '') + s;
}

export class Index {
  constructor(db, file) {
    this.db = db;
    this.file = file;
  }

  migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    let v = row ? Number(row.value) : 0;
    if (v > INDEX_SCHEMA_VERSION) return false; // written by a newer controller: caller rebuilds
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (let next = v + 1; next <= INDEX_SCHEMA_VERSION; next++) for (const sql of MIGRATIONS[next]) this.db.exec(sql);
      this.setMeta('schema_version', String(INDEX_SCHEMA_VERSION));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return true;
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  /** Rebuild every derived table from canonical files in one transaction. */
  rebuild(store, { events = [] } = {}) {
    const docs = extractDocs(store);
    const { doc } = store.loadFacts();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM docs; DELETE FROM facts;');
      const ins = this.db.prepare('INSERT INTO docs(path, kind, ref, title, body) VALUES(?, ?, ?, ?, ?)');
      for (const d of docs) ins.run(d.path, d.kind, d.ref, d.title, d.body);
      const insF = this.db.prepare('INSERT OR REPLACE INTO facts(id, status, key, category, claim) VALUES(?, ?, ?, ?, ?)');
      for (const f of doc.facts ?? []) if (f?.id && f.claim && f.status) insF.run(f.id, f.status, f.key ?? null, f.category ?? null, f.claim);
      const insE = this.db.prepare('INSERT OR IGNORE INTO events(event_id, ts, type, session, data) VALUES(?, ?, ?, ?, ?)');
      for (const e of events) if (e.event_id) insE.run(e.event_id, e.ts ?? nowIso(), e.type ?? 'unknown', e.session ?? null, JSON.stringify(e.data ?? {}));
      this.setMeta('source_fingerprint', store.sourceFingerprint());
      this.setMeta('project_id', store.project.id);
      this.setMeta('built_at', nowIso());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { docs: docs.length, facts: (doc.facts ?? []).length };
  }

  search(query, limit = 10) {
    const toks = tokens(query);
    if (!toks.length) return [];
    const q = (op) => toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(` ${op} `);
    const stmt = this.db.prepare("SELECT path, kind, ref, title, snippet(docs, 4, '[', ']', '…', 16) AS snippet FROM docs WHERE docs MATCH ? ORDER BY bm25(docs, 0, 0, 0, 2.0, 1.0) LIMIT ?");
    let rows = stmt.all(q('AND'), limit);
    if (!rows.length && toks.length > 1) rows = stmt.all(q('OR'), limit);
    return rows.map((r) => ({ ...r }));
  }

  /** Insert an event; returns false when the event_id was already recorded (idempotent retries). */
  recordEvent(e) {
    const r = this.db.prepare('INSERT OR IGNORE INTO events(event_id, ts, type, session, data) VALUES(?, ?, ?, ?, ?)').run(e.event_id, e.ts, e.type, e.session ?? null, JSON.stringify(e.data ?? {}));
    return r.changes > 0;
  }

  counts() {
    return {
      docs: this.db.prepare('SELECT count(*) AS n FROM docs').get().n,
      facts: this.db.prepare('SELECT count(*) AS n FROM facts').get().n,
      events: this.db.prepare('SELECT count(*) AS n FROM events').get().n,
    };
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

function openDb(file) {
  const Db = sqlite();
  const db = new Db(file);
  db.exec('PRAGMA busy_timeout = 2000');
  db.exec('PRAGMA journal_mode = WAL');
  const check = db.prepare('PRAGMA quick_check').get();
  if (Object.values(check)[0] !== 'ok') {
    db.close();
    throw new Error('quick_check failed');
  }
  return db;
}

/**
 * Open (and if needed create, migrate, recover, or rebuild) the project index.
 * Returns { index: Index|null, status, reason } — status: ok | rebuilt | recovered | unavailable.
 */
export function openIndex(store, { readEventsFn } = {}) {
  if (!sqlite()) return { index: null, status: 'unavailable', reason: sqliteLoadError };
  const file = path.join(store.localDir(), 'index.sqlite');
  fs.mkdirSync(store.localDir(), { recursive: true });
  let status = 'ok';
  let reason = null;
  let index;
  try {
    index = new Index(openDb(file), file);
    if (!index.migrate()) throw new Error('index written by a newer schema version');
  } catch (e) {
    index?.close();
    reason = `index unreadable (${e.message}); moved aside and rebuilt from canonical files`;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, `${file}.corrupt-${Date.now()}${suffix}`);
    }
    index = new Index(openDb(file), file);
    index.migrate();
    status = 'recovered';
  }
  const fp = store.sourceFingerprint();
  const stale = index.getMeta('source_fingerprint') !== fp || index.getMeta('project_id') !== store.project.id;
  if (stale || status === 'recovered') {
    if (index.getMeta('project_id') && index.getMeta('project_id') !== store.project.id) reason = 'index belonged to a different project identity; rebuilt';
    index.rebuild(store, { events: readEventsFn ? readEventsFn() : [] });
    if (status === 'ok') status = 'rebuilt';
  }
  return { index, status, reason };
}
