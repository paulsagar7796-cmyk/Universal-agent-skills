import fs from 'node:fs';
import { resolveInside, sha256, today } from './util.js';

export const STATUSES = ['verified', 'observed', 'assumption', 'unknown', 'disputed', 'deprecated'];
export const EVIDENCE_KINDS = ['file', 'command', 'url', 'user'];
export const FACT_SCHEMA_VERSION = 1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^FACT-\d{4,}$/;
export const KNOWN_FIELDS = new Set([
  'id', 'claim', 'status', 'key', 'category', 'evidence', 'last_verified', 'expires_after_days', 'confidence_note',
  'question', 'test_by', 'conflicts_with', 'supersedes', 'superseded_by', 'source', 'created_at',
]);

export function validateEvidence(ev, where) {
  const errs = [];
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return [`${where}: evidence must be a mapping`];
  if (!EVIDENCE_KINDS.includes(ev.kind)) errs.push(`${where}: evidence.kind must be one of ${EVIDENCE_KINDS.join('/')}`);
  if (!ev.checked_at || !DATE_RE.test(String(ev.checked_at))) errs.push(`${where}: evidence.checked_at must be YYYY-MM-DD`);
  if (ev.kind === 'file' && (typeof ev.path !== 'string' || !ev.path)) errs.push(`${where}: file evidence needs path`);
  if (ev.kind === 'file' && typeof ev.path === 'string' && (ev.path.startsWith('/') || ev.path.split(/[\\/]/).includes('..'))) errs.push(`${where}: file evidence path must be relative to the project root`);
  if (ev.kind === 'command' && (typeof ev.command !== 'string' || !Number.isInteger(ev.exit_code))) errs.push(`${where}: command evidence needs command and integer exit_code`);
  if (ev.kind === 'url' && !/^https?:\/\//.test(String(ev.url ?? ''))) errs.push(`${where}: url evidence needs an http(s) url`);
  if (ev.kind === 'user' && (typeof ev.note !== 'string' || !ev.note)) errs.push(`${where}: user evidence needs a note (who said what, when)`);
  return errs;
}

export function validateFact(f, idx = 0) {
  const where = f?.id ?? `facts[${idx}]`;
  const errs = [];
  if (!f || typeof f !== 'object' || Array.isArray(f)) return [`${where}: fact must be a mapping`];
  for (const k of Object.keys(f)) if (!KNOWN_FIELDS.has(k)) errs.push(`${where}: unknown field "${k}"`);
  if (!ID_RE.test(String(f.id ?? ''))) errs.push(`${where}: id must look like FACT-0001`);
  if (typeof f.claim !== 'string' || f.claim.trim().length < 3) errs.push(`${where}: claim is required`);
  if (!STATUSES.includes(f.status)) errs.push(`${where}: status must be one of ${STATUSES.join('/')}`);
  const ev = f.evidence ?? [];
  if (!Array.isArray(ev)) errs.push(`${where}: evidence must be a list`);
  else ev.forEach((e, i) => errs.push(...validateEvidence(e, `${where}.evidence[${i}]`)));
  if ((f.status === 'verified' || f.status === 'observed') && (!Array.isArray(ev) || ev.length === 0)) errs.push(`${where}: ${f.status} facts require at least one evidence item`);
  if (f.status === 'verified' && Array.isArray(ev) && ev.some((e) => e.kind === 'command' && e.exit_code !== 0) && !ev.some((e) => e.kind !== 'command' || e.exit_code === 0)) errs.push(`${where}: verified fact cannot rest only on failing commands`);
  if (f.last_verified !== undefined && f.last_verified !== null && !DATE_RE.test(String(f.last_verified))) errs.push(`${where}: last_verified must be YYYY-MM-DD`);
  if (f.expires_after_days !== undefined && (!Number.isInteger(f.expires_after_days) || f.expires_after_days < 1)) errs.push(`${where}: expires_after_days must be a positive integer`);
  if (f.status === 'deprecated' && !f.superseded_by && !f.confidence_note) errs.push(`${where}: deprecated facts need superseded_by or confidence_note explaining why`);
  for (const k of ['conflicts_with']) if (f[k] !== undefined && !Array.isArray(f[k])) errs.push(`${where}: ${k} must be a list of fact ids`);
  return errs;
}

export function validateFactsDoc(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['facts.yaml must be a mapping with schema_version and facts'];
  if (doc.schema_version !== FACT_SCHEMA_VERSION) errs.push(`facts.yaml schema_version must be ${FACT_SCHEMA_VERSION}`);
  if (!Array.isArray(doc.facts)) {
    errs.push('facts.yaml facts must be a list');
    return errs;
  }
  const seen = new Set();
  doc.facts.forEach((f, i) => {
    errs.push(...validateFact(f, i));
    if (f?.id) {
      if (seen.has(f.id)) errs.push(`${f.id}: duplicate id`);
      seen.add(f.id);
    }
  });
  for (const f of doc.facts) {
    for (const ref of [...(f.conflicts_with ?? []), f.superseded_by, f.supersedes].filter(Boolean)) {
      if (!seen.has(ref)) errs.push(`${f.id}: references unknown fact ${ref}`);
    }
  }
  return errs;
}

export function nextFactId(facts) {
  let max = 0;
  for (const f of facts) {
    const m = String(f.id ?? '').match(/^FACT-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `FACT-${String(max + 1).padStart(4, '0')}`;
}

export function fileEvidence(root, relPath, locator, date = today()) {
  const abs = resolveInside(root, relPath);
  const ev = { kind: 'file', path: relPath.split('\\').join('/'), checked_at: date, sha256: sha256(fs.readFileSync(abs)).slice(0, 16) };
  if (locator) ev.locator = locator;
  return ev;
}

/**
 * Parse a CLI evidence spec:
 *   file:<path>[#locator]   cmd:<exit_code>:<command>   url:<https://...>   user:<note>
 */
export function parseEvidenceSpec(spec, root, date = today()) {
  const m = String(spec).match(/^(file|cmd|url|user):(.*)$/s);
  if (!m) throw new Error(`evidence must start with file:, cmd:, url: or user: (got ${JSON.stringify(spec)})`);
  const [, kind, rest] = m;
  if (kind === 'file') {
    const [p, ...loc] = rest.split('#');
    try {
      return fileEvidence(root, p, loc.join('#') || undefined, date);
    } catch (e) {
      throw new Error(`file evidence ${p}: ${e.code === 'ENOENT' ? 'file does not exist in the project' : e.message}`);
    }
  }
  if (kind === 'cmd') {
    const cm = rest.match(/^(-?\d+):(.+)$/s);
    if (!cm) throw new Error('command evidence must be cmd:<exit_code>:<command>, e.g. cmd:0:npm test');
    return { kind: 'command', command: cm[2].trim(), exit_code: Number(cm[1]), checked_at: date };
  }
  if (kind === 'url') {
    if (!/^https?:\/\//.test(rest)) throw new Error('url evidence must be an http(s) URL');
    return { kind: 'url', url: rest.trim(), checked_at: date };
  }
  return { kind: 'user', note: rest.trim(), checked_at: date };
}

function daysBetween(a, b) {
  return Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * Compute freshness without writing anything.
 * fresh | changed (evidence file content differs) | missing (evidence file gone) | expired (past expiry) | unchecked (nothing hashable) | inactive (deprecated)
 */
export function freshness(fact, root, date = today()) {
  if (fact.status === 'deprecated') return { state: 'inactive', reasons: [] };
  const reasons = [];
  let state = 'fresh';
  let hashable = 0;
  for (const ev of fact.evidence ?? []) {
    if (ev.kind !== 'file' || !ev.sha256) continue;
    hashable++;
    let abs;
    try {
      abs = resolveInside(root, ev.path);
    } catch {
      state = 'missing';
      reasons.push(`${ev.path}: invalid path`);
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(abs);
    } catch {
      state = 'missing';
      reasons.push(`${ev.path} no longer exists`);
      continue;
    }
    if (sha256(content).slice(0, 16) !== ev.sha256) {
      if (state !== 'missing') state = 'changed';
      reasons.push(`${ev.path} changed since ${ev.checked_at}`);
    }
  }
  const last = fact.last_verified ?? fact.evidence?.map((e) => e.checked_at).sort().at(-1);
  if (state === 'fresh' && fact.expires_after_days && last && daysBetween(last, date) > fact.expires_after_days) {
    state = 'expired';
    reasons.push(`last verified ${last}, expiry ${fact.expires_after_days} days`);
  }
  if (state === 'fresh' && hashable === 0 && (fact.status === 'verified' || fact.status === 'observed')) state = 'unchecked';
  return { state, reasons };
}
