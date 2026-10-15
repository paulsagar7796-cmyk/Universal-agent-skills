// Memory write path: capture → classify → attach evidence → propose (small diff) → validate → approve → apply.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse, stringify } from './yaml.js';
import { STATUSES, nextFactId, parseEvidenceSpec, validateFact } from './facts.js';
import { assertNoSecrets } from './secrets.js';
import { nowIso, slugify, today, writeFileAtomic } from './util.js';

function proposalsDir(store) {
  return path.join(store.localDir(), 'proposals');
}

export function listProposals(store) {
  const dir = proposalsDir(store);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^P-.*\.yaml$/.test(f))
    .sort()
    .map((f) => {
      try {
        return { ...parse(fs.readFileSync(path.join(dir, f), 'utf8')), file: f };
      } catch (e) {
        return { id: f.replace(/\.yaml$/, ''), error: e.message, file: f };
      }
    });
}

export function getProposal(store, id) {
  return listProposals(store).find((p) => p.id === id) ?? null;
}

function normClaim(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Create a fact proposal. Evidence specs are checked against the live project (files must exist; hashes recorded).
 * Returns { proposal, applied } — applied is set when auto-accept policy allowed it.
 */
export function proposeFact(store, input, { config, now = new Date() } = {}) {
  const date = today(now);
  const status = input.status ?? 'observed';
  if (!STATUSES.includes(status) || status === 'deprecated') throw new Error(`status must be one of ${STATUSES.filter((s) => s !== 'deprecated').join(', ')}`);
  const evidence = (input.evidence ?? []).map((spec) => (typeof spec === 'string' ? parseEvidenceSpec(spec, store.root, date) : spec));
  const fact = {
    id: 'FACT-9999',
    claim: String(input.claim ?? '').trim(),
    status,
    key: input.key || undefined,
    category: input.category || undefined,
    evidence,
    last_verified: evidence.length && (status === 'verified' || status === 'observed') ? date : undefined,
    expires_after_days: input.expiresAfterDays ? Number(input.expiresAfterDays) : undefined,
    question: input.question || undefined,
    test_by: input.testBy || undefined,
    confidence_note: input.note || undefined,
    source: input.source ?? 'agent',
    created_at: date,
  };
  for (const k of Object.keys(fact)) if (fact[k] === undefined) delete fact[k];
  const errs = validateFact(fact);
  if (errs.length) throw new Error(`invalid fact:\n  - ${errs.join('\n  - ')}`);
  assertNoSecrets(JSON.stringify(fact), 'memory proposal');

  const { doc } = store.loadFacts();
  const active = (doc.facts ?? []).filter((f) => f.status !== 'deprecated');
  const dup = active.find((f) => normClaim(f.claim) === normClaim(fact.claim));
  if (dup) throw new Error(`already recorded as ${dup.id} [${dup.status}]. To refresh its evidence use \`brain verify ${dup.id} --confirm --evidence ...\`.`);
  // Same key: an evidence-backed fact *answers* open questions/assumptions (they are closed on approval);
  // it *conflicts* with other evidence-backed or disputed facts. Unknown/assumption proposals only conflict with evidence.
  const sameKey = fact.key ? active.filter((f) => f.key === fact.key) : [];
  const evidenced = status === 'verified' || status === 'observed';
  const answers = evidenced ? sameKey.filter((f) => f.status === 'unknown' || f.status === 'assumption').map((f) => f.id) : [];
  const conflicts = sameKey.filter((f) => ['verified', 'observed', 'disputed'].includes(f.status)).map((f) => f.id);
  if (input.supersedes && !active.some((f) => f.id === input.supersedes)) throw new Error(`--supersedes ${input.supersedes}: no active fact with that id`);

  const checkable = evidence.some((e) => e.kind === 'file' || (e.kind === 'command' && e.exit_code === 0));
  const highImpactCategory = ['decision', 'requirement', 'security', 'product'].includes(fact.category);
  const risk = (status === 'observed' || status === 'verified') && checkable && conflicts.length === 0 && !input.supersedes && !highImpactCategory ? 'low' : 'review';
  const reasons = [];
  if (conflicts.length) reasons.push(`same key "${fact.key}" as ${conflicts.join(', ')} — will be marked disputed unless you approve with --supersede`);
  if (!checkable) reasons.push('no file or passing-command evidence');
  if (highImpactCategory) reasons.push(`category "${fact.category}" needs human review`);
  if (input.supersedes) reasons.push(`supersedes ${input.supersedes}`);
  if (answers.length) reasons.push(`answers ${answers.join(', ')} (closed on approval)`);
  if (status === 'assumption' || status === 'unknown' || status === 'disputed') reasons.push(`status ${status}`);

  const proposal = {
    id: `P-${date.replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`,
    type: 'fact',
    created_at: nowIso(now),
    risk,
    reasons,
    conflicts,
    answers,
    supersedes: input.supersedes ?? null,
    fact: { ...fact, id: null },
  };
  writeFileAtomic(path.join(proposalsDir(store), `${proposal.id}.yaml`), stringify(proposal));
  if (risk === 'low' && config?.memory?.auto_accept_low_risk) return { proposal, applied: applyProposal(store, proposal.id, { now, auto: true }) };
  return { proposal, applied: null };
}

/** Propose a decision record (ADR). Applying writes decisions/ADR-NNNN-<slug>.md. */
export function proposeDecision(store, input, { now = new Date() } = {}) {
  for (const k of ['title', 'decision']) if (!input[k] || !String(input[k]).trim()) throw new Error(`--${k} is required`);
  const status = input.status ?? 'accepted';
  if (!['proposed', 'accepted'].includes(status)) throw new Error('--status must be proposed or accepted');
  const d = {
    title: String(input.title).trim(),
    status,
    context: input.context ?? '',
    decision: String(input.decision).trim(),
    alternatives: input.alternatives ?? [],
    consequences: input.consequences ?? '',
    revisit_when: input.revisitWhen ?? '',
    evidence: (input.evidence ?? []).map((spec) => (typeof spec === 'string' ? parseEvidenceSpec(spec, store.root, today(now)) : spec)),
  };
  assertNoSecrets(JSON.stringify(d), 'decision proposal');
  const proposal = { id: `P-${today(now).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`, type: 'decision', created_at: nowIso(now), risk: 'review', reasons: ['decisions are always reviewed by a human'], decision: d };
  writeFileAtomic(path.join(proposalsDir(store), `${proposal.id}.yaml`), stringify(proposal));
  return { proposal };
}

function archive(store, proposal, outcome, extra = {}) {
  const dir = proposalsDir(store);
  const done = path.join(dir, outcome);
  fs.mkdirSync(done, { recursive: true });
  const { file, ...rest } = proposal;
  writeFileAtomic(path.join(done, `${proposal.id}.yaml`), stringify({ ...rest, outcome, resolved_at: nowIso(), ...extra }));
  fs.rmSync(path.join(dir, file ?? `${proposal.id}.yaml`), { force: true });
}

function renderAdr(id, d, date) {
  const alts = (d.alternatives ?? []).length ? d.alternatives.map((a) => `- ${a}`).join('\n') : '_None recorded._';
  const ev = (d.evidence ?? []).length ? d.evidence.map((e) => `- ${e.kind}: ${e.path ?? e.command ?? e.url ?? e.note}${e.locator ? `#${e.locator}` : ''} (${e.checked_at})`).join('\n') : '_None recorded._';
  const fm = stringify({ id, title: d.title, status: d.status, date });
  return `---\n${fm}---\n\n# ${id}: ${d.title}\n\n## Context\n\n${d.context || '_Not recorded._'}\n\n## Decision\n\n${d.decision}\n\n## Alternatives considered\n\n${alts}\n\n## Consequences\n\n${d.consequences || '_Not recorded._'}\n\n## Revisit when\n\n${d.revisit_when || '_Not specified._'}\n\n## Evidence\n\n${ev}\n`;
}

/**
 * Apply a pending proposal. For facts with conflicts: default marks both sides disputed; resolution "supersede"
 * deprecates the conflicting facts in favour of the new one.
 */
export function applyProposal(store, id, { resolution = null, now = new Date(), auto = false } = {}) {
  const p = getProposal(store, id);
  if (!p) throw new Error(`no pending proposal ${id}`);
  if (p.error) throw new Error(`proposal ${id} is unreadable: ${p.error}`);
  if (p.type === 'decision') {
    const adrId = store.nextDecisionId();
    const file = `${adrId}-${slugify(p.decision.title)}.md`;
    const text = renderAdr(adrId, p.decision, today(now));
    assertNoSecrets(text, 'decision record');
    writeFileAtomic(store.p('decisions', file), text);
    store.regenerateViews();
    archive(store, p, 'applied', { result: adrId });
    return { type: 'decision', id: adrId, file: `decisions/${file}` };
  }
  const result = store.updateFacts((doc) => {
    doc.facts = doc.facts ?? [];
    const newId = nextFactId(doc.facts);
    const fact = { ...p.fact, id: newId };
    const targets = [...new Set([...(p.conflicts ?? []), ...(p.supersedes ? [p.supersedes] : [])])];
    const supersede = resolution === 'supersede' || (p.supersedes && resolution !== 'dispute');
    for (const tid of targets) {
      const old = doc.facts.find((f) => f.id === tid);
      if (!old || old.status === 'deprecated') continue;
      if (supersede) {
        old.status = 'deprecated';
        old.superseded_by = newId;
        old.confidence_note = old.confidence_note ?? `Superseded by ${newId} on ${today(now)}.`;
        fact.supersedes = fact.supersedes ?? tid;
      } else {
        old.status = 'disputed';
        old.conflicts_with = [...new Set([...(old.conflicts_with ?? []), newId])];
        fact.status = 'disputed';
        fact.conflicts_with = [...new Set([...(fact.conflicts_with ?? []), tid])];
      }
    }
    const answered = [];
    for (const qid of p.answers ?? []) {
      const q = doc.facts.find((f) => f.id === qid);
      if (!q || q.status === 'deprecated') continue;
      q.status = 'deprecated';
      q.superseded_by = newId;
      q.confidence_note = `Answered by ${newId} on ${today(now)}.`;
      fact.supersedes = fact.supersedes ?? qid;
      answered.push(qid);
    }
    doc.facts.push(fact);
    return { type: 'fact', id: newId, status: fact.status, superseded: supersede ? targets : [], disputed: supersede ? [] : targets, answered };
  });
  archive(store, p, 'applied', { result: result.id, auto });
  return result;
}

export function rejectProposal(store, id, reason = '') {
  const p = getProposal(store, id);
  if (!p) throw new Error(`no pending proposal ${id}`);
  archive(store, p, 'rejected', { reason });
  return { id, rejected: true };
}

/** Re-verify an existing fact with fresh evidence (does not change the claim). */
export function confirmFact(store, id, evidenceSpecs, { now = new Date(), status = null } = {}) {
  if (!evidenceSpecs.length) throw new Error('re-verification needs at least one --evidence');
  const date = today(now);
  const evidence = evidenceSpecs.map((s) => parseEvidenceSpec(s, store.root, date));
  return store.updateFacts((doc) => {
    const f = (doc.facts ?? []).find((x) => x.id === id);
    if (!f) throw new Error(`no fact ${id}`);
    if (f.status === 'deprecated') throw new Error(`${id} is deprecated; propose a new fact instead`);
    f.evidence = evidence;
    f.last_verified = date;
    if (status) {
      if (!['verified', 'observed'].includes(status)) throw new Error('--status for confirm must be verified or observed');
      f.status = status;
    }
    return { id, last_verified: date, status: f.status };
  });
}

/** Mark a fact deprecated (explicit human/agent action with a reason). */
export function deprecateFact(store, id, reason) {
  if (!reason) throw new Error('a reason is required to deprecate a fact');
  assertNoSecrets(reason, 'deprecation reason');
  return store.updateFacts((doc) => {
    const f = (doc.facts ?? []).find((x) => x.id === id);
    if (!f) throw new Error(`no fact ${id}`);
    f.status = 'deprecated';
    f.confidence_note = reason;
    return { id, status: 'deprecated' };
  });
}
