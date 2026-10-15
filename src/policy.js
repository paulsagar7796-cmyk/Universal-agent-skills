// Tamper-evident consent policy log: .agent-brain/local/policy/consent.json
//
// Each entry carries the SHA-256 of the previous entry, so edits, insertions, reordering and (via the mirrored head)
// truncation are detected. Grants must carry a human-approval record. A broken log is treated as "integrity failure"
// and protected operations fail closed.
//
// Limits: the hash is unkeyed and the files are owned by the same OS user as the agent, so a determined process can
// rewrite the whole chain and both heads consistently. This detects naive edits, accidental corruption and partial
// tampering; preventing deliberate rewrites needs an OS sandbox that denies the agent write access to these paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoSecrets } from './secrets.js';
import { nowIso, readJsonIfExists, sha256, withLock, writeJsonAtomic } from './util.js';

export const POLICY_SCHEMA = 2;
const GENESIS = 'GENESIS';
const DECISIONS = ['granted', 'denied', 'revoked', 'consumed'];

export function policyDir(store) {
  return path.join(store.localDir(), 'policy');
}
export function policyFile(store) {
  return path.join(policyDir(store), 'consent.json');
}
function headFile(store) {
  return path.join(policyDir(store), 'head.json');
}
/** Mirror of the chain head outside the project (detects truncation even if the project copy is rewritten). */
export function mirrorHeadFile(store, home = os.homedir()) {
  return path.join(home, '.agent-skills-brain', 'policy-heads', `${store.project.id}.json`);
}

function canonical(entry) {
  const { hash, ...rest } = entry;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export function entryHash(prev, entry) {
  return sha256(`${prev}\n${canonical({ ...entry, prev })}`);
}

/** Verify a parsed policy document. Returns { ok, error, entries }. */
export function verifyPolicy(doc, { heads = [] } = {}) {
  if (doc === null) {
    const claimed = heads.filter(Boolean).find((h) => h.count > 0);
    if (claimed) return { ok: false, error: `policy log is missing but a head records ${claimed.count} entr${claimed.count === 1 ? 'y' : 'ies'} (deleted?)`, entries: [] };
    return { ok: true, error: null, entries: [] };
  }
  if (!doc || typeof doc !== 'object' || doc.schema_version !== POLICY_SCHEMA || !Array.isArray(doc.entries)) return { ok: false, error: 'policy log has an unknown or malformed structure', entries: [] };
  let prev = GENESIS;
  for (let i = 0; i < doc.entries.length; i++) {
    const e = doc.entries[i];
    if (!e || typeof e !== 'object') return { ok: false, error: `entry ${i} is not an object`, entries: [] };
    if (e.seq !== i + 1) return { ok: false, error: `entry ${i} has seq ${e.seq}, expected ${i + 1} (inserted, removed or reordered)`, entries: [] };
    if (e.prev !== prev) return { ok: false, error: `entry ${e.seq} does not link to the previous entry`, entries: [] };
    if (e.hash !== entryHash(prev, e)) return { ok: false, error: `entry ${e.seq} was modified after it was written (hash mismatch)`, entries: [] };
    if (!DECISIONS.includes(e.decision)) return { ok: false, error: `entry ${e.seq} has unknown decision "${e.decision}"`, entries: [] };
    if (e.decision === 'granted' && (e.actor !== 'human' || e.via !== 'tty-challenge')) return { ok: false, error: `entry ${e.seq} is a grant without a human approval record`, entries: [] };
    prev = e.hash;
  }
  for (const h of heads.filter(Boolean)) {
    if (h.count > doc.entries.length) return { ok: false, error: `policy log has ${doc.entries.length} entries but a head records ${h.count} (truncated)`, entries: [] };
    if (h.count > 0 && doc.entries[h.count - 1]?.hash !== h.hash) return { ok: false, error: `policy head mismatch at entry ${h.count}`, entries: [] };
  }
  return { ok: true, error: null, entries: doc.entries };
}

function readJsonStrict(file) {
  if (!fs.existsSync(file)) return { exists: false, value: null };
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { exists: true, value: undefined, error: e.message };
  }
}

export function loadPolicy(store, { home = os.homedir() } = {}) {
  const f = readJsonStrict(policyFile(store));
  if (f.value === undefined) return { ok: false, error: `policy log is not valid JSON (${f.error})`, entries: [] };
  const heads = [readJsonStrict(headFile(store)), readJsonStrict(mirrorHeadFile(store, home))].map((h) => (h.value === undefined ? { count: Number.MAX_SAFE_INTEGER, hash: 'unreadable' } : h.value));
  return verifyPolicy(f.exists ? f.value : null, { heads });
}

/**
 * Append one entry. Grants require a human approval token (checked by the caller via isHumanApproval and recorded
 * here as actor/via). Refuses to append to a log that fails verification.
 */
export function appendPolicy(store, entry, { home = os.homedir(), now = new Date() } = {}) {
  fs.mkdirSync(policyDir(store), { recursive: true });
  return withLock(path.join(policyDir(store), 'policy.lock'), () => {
    const cur = loadPolicy(store, { home });
    if (!cur.ok) throw new Error(`policy log integrity failure: ${cur.error}. Inspect it with \`brain consent status\`; restore it from a backup or re-initialise it deliberately.`);
    const prev = cur.entries.at(-1)?.hash ?? GENESIS;
    const e = { seq: cur.entries.length + 1, ts: nowIso(now), ...entry, prev };
    e.hash = entryHash(prev, e);
    const doc = { schema_version: POLICY_SCHEMA, note: 'Hash-chained consent log. Do not edit by hand: any change breaks verification and protected operations fail closed.', entries: [...cur.entries, e] };
    assertNoSecrets(JSON.stringify(doc), 'consent policy');
    writeJsonAtomic(policyFile(store), doc);
    const head = { count: doc.entries.length, hash: e.hash, at: e.ts };
    writeJsonAtomic(headFile(store), head);
    try {
      fs.mkdirSync(path.dirname(mirrorHeadFile(store, home)), { recursive: true });
      writeJsonAtomic(mirrorHeadFile(store, home), head);
    } catch {
      /* mirror is best-effort (e.g. sandboxed home); the in-project head still exists */
    }
    return e;
  });
}

/** Agent-writable side file: consent requests (no effect) and restrictions (deny/revoke; can only reduce privilege). */
export function requestsFile(store) {
  return path.join(store.localDir(), 'requests.json');
}

export function loadRequests(store) {
  const r = readJsonStrict(requestsFile(store));
  if (r.value === undefined) return { requests: [], restrictions: [], error: `requests.json is not valid JSON (${r.error})` };
  const v = r.value ?? {};
  return { requests: Array.isArray(v.requests) ? v.requests : [], restrictions: Array.isArray(v.restrictions) ? v.restrictions : [], error: null };
}

export function updateRequests(store, mutate) {
  fs.mkdirSync(store.localDir(), { recursive: true });
  return withLock(path.join(store.localDir(), 'requests.lock'), () => {
    const cur = loadRequests(store);
    const doc = { requests: cur.requests, restrictions: cur.restrictions };
    const result = mutate(doc);
    assertNoSecrets(JSON.stringify(doc), 'consent requests');
    writeJsonAtomic(requestsFile(store), doc);
    return result;
  });
}

export function capabilitiesFile(store) {
  return path.join(store.localDir(), 'capabilities.json');
}

/** One-time migration of the v1 consent.json: keep only privilege-reducing decisions and observations. */
export function migrateV1(store) {
  const old = path.join(store.localDir(), 'consent.json');
  if (!fs.existsSync(old)) return null;
  let v1;
  try {
    v1 = JSON.parse(fs.readFileSync(old, 'utf8'));
  } catch {
    v1 = null;
  }
  const report = { restrictions: 0, droppedGrants: 0, observations: 0 };
  if (v1) {
    updateRequests(store, (doc) => {
      for (const g of v1.grants ?? []) {
        if (g.decision === 'denied' || g.decision === 'revoked') {
          doc.restrictions.push({ id: `X-migrated-${g.id}`, target: g.target, decision: g.decision, at: g.at, actor: 'migrated-v1', note: 'migrated from unverified v1 consent.json' });
          report.restrictions++;
        } else report.droppedGrants++;
      }
    });
    const obs = {};
    for (const [id, c] of Object.entries(v1.capabilities ?? {})) {
      if (['available', 'connected_unverified', 'host_setup_pending', 'error', 'expired', 'missing'].includes(c.state)) {
        obs[id] = c;
        report.observations++;
      }
    }
    if (Object.keys(obs).length) writeJsonAtomic(capabilitiesFile(store), { capabilities: { ...(readJsonIfExists(capabilitiesFile(store))?.capabilities ?? {}), ...obs } });
  }
  fs.renameSync(old, path.join(store.localDir(), `consent.v1.migrated-${Date.now()}.json`));
  return report;
}
