// Capability & consent broker.
//
// Sources of truth (see docs/security-model.md for the enforcement boundary):
//   local/policy/consent.json  hash-chained log of decisions. Grants require a human approval token (src/human.js).
//   local/requests.json        agent-writable: consent *requests* (no effect) and *restrictions* (deny/revoke only).
//   local/capabilities.json    agent-writable observations ("available", "error", …). Observations never authorize.
//
// Decisions are advisory unless a host adapter enforces them (Claude Code PreToolUse). Availability is not consent,
// a connection is not action approval, and an integrity failure blocks every protected capability (fail closed).
import crypto from 'node:crypto';
import os from 'node:os';
import { assertNoSecrets } from './secrets.js';
import { isHumanApproval } from './human.js';
import { appendPolicy, capabilitiesFile, loadPolicy, loadRequests, migrateV1, updateRequests } from './policy.js';
import { nowIso, readJsonIfExists, withLock, writeJsonAtomic } from './util.js';
import path from 'node:path';

export const OBSERVED_STATES = ['not_needed', 'missing', 'host_setup_pending', 'connected_unverified', 'available', 'expired', 'error'];
export const CAP_STATES = OBSERVED_STATES; // backwards-compatible export
export const ACCESS = ['read', 'write', 'privileged'];
export const SCOPES = ['once', 'session', 'project'];
const ACCESS_RANK = { read: 1, write: 2, privileged: 3 };

function checkNote(note) {
  if (note === undefined || note === null) return;
  if (typeof note !== 'string' || note.length > 500) throw new Error('note/evidence must be a string of at most 500 characters');
  assertNoSecrets(note, 'consent note');
}

function validTarget(target) {
  if (typeof target !== 'string' || !/^(action:)?[a-z0-9][a-z0-9.-]{0,63}$/.test(target)) throw new Error(`invalid consent target ${JSON.stringify(target)}`);
}

/**
 * Effective consent state. Shape: { integrity: {ok, error}, grants: [...decisions], capabilities: {id: observation}, requests, restrictionsError }
 * `grants` holds every decision (granted/denied/revoked) from the verified policy log plus restrictions; `used` marks consumed once-grants.
 */
export function loadState(store, { home = os.homedir() } = {}) {
  migrateV1(store);
  const policy = loadPolicy(store, { home });
  const req = loadRequests(store);
  const consumed = new Set(policy.entries.filter((e) => e.decision === 'consumed').map((e) => e.grant_id));
  const grants = policy.entries
    .filter((e) => e.decision !== 'consumed')
    .map((e) => ({ id: `G${e.seq}`, target: e.target, decision: e.decision, access: e.access ?? 'read', scope: e.scope ?? 'project', session: e.session ?? null, expires_at: e.expires_at ?? null, note: e.note ?? null, at: e.ts, actor: e.actor, via: e.via ?? null, request_id: e.request_id ?? null, used: consumed.has(`G${e.seq}`) }));
  for (const r of req.restrictions) {
    if (r && (r.decision === 'denied' || r.decision === 'revoked') && typeof r.target === 'string') grants.push({ id: r.id, target: r.target, decision: r.decision, access: 'privileged', scope: 'project', session: null, expires_at: null, note: r.note ?? null, at: r.at ?? '', actor: r.actor ?? 'unverified', via: null, used: false });
  }
  grants.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const capabilities = readJsonIfExists(capabilitiesFile(store))?.capabilities ?? {};
  // An unreadable requests file could hide restrictions, so it also fails closed.
  const integrity = !policy.ok ? { ok: false, error: policy.error } : req.error ? { ok: false, error: req.error } : { ok: true, error: null };
  return { schema_version: 2, integrity, grants, capabilities, requests: req.requests, requestsError: req.error };
}

/** Record an *observation* about a capability (e.g. a real tool call succeeded). Never authorizes anything. */
export function recordCapability(store, capId, state, { evidence, access = [], by = 'agent', now = new Date() } = {}) {
  if (!OBSERVED_STATES.includes(state)) throw new Error(`unknown capability state "${state}" (observations: ${OBSERVED_STATES.join(', ')}). Consent decisions use \`brain consent\`.`);
  checkNote(evidence);
  const levels = [].concat(access).filter(Boolean);
  for (const a of levels) if (!ACCESS.includes(a)) throw new Error(`unknown access level "${a}"`);
  if (state === 'available' && !evidence) throw new Error('marking a capability "available" requires --evidence describing the real check (e.g. "WebSearch call returned results at 14:02")');
  if (state === 'available' && levels.length === 0) throw new Error('marking a capability "available" requires the verified access level(s), e.g. --access read');
  return withLock(path.join(store.localDir(), 'capabilities.lock'), () => {
    const doc = readJsonIfExists(capabilitiesFile(store)) ?? { capabilities: {} };
    const prev = doc.capabilities[capId]?.state ?? 'missing';
    doc.capabilities[capId] = { state, access: levels, evidence: evidence ?? null, by, at: nowIso(now) };
    assertNoSecrets(JSON.stringify(doc), 'capability observations');
    writeJsonAtomic(capabilitiesFile(store), doc);
    return { capId, from: prev, to: state };
  });
}

/** Agent-usable: ask for consent. Has no effect on permissions until a person approves it. */
export function requestConsent(store, target, { access = 'read', scope = 'project', reason = null, skill = null, session = null, expiresAt = null, now = new Date() } = {}) {
  validTarget(target);
  if (!ACCESS.includes(access)) throw new Error(`access must be one of ${ACCESS.join('/')}`);
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join('/')}`);
  checkNote(reason);
  return updateRequests(store, (doc) => {
    const existing = doc.requests.find((r) => r.status === 'pending' && r.target === target && r.access === access && r.scope === scope);
    if (existing) return existing;
    const r = { id: `R-${crypto.randomBytes(4).toString('hex')}`, target, access, scope, session, expires_at: expiresAt, reason, skill, status: 'pending', at: nowIso(now) };
    doc.requests.push(r);
    return r;
  });
}

/** Agent-usable: drop a pending request (no privilege change). */
export function rejectRequest(store, requestId, { now = new Date() } = {}) {
  return updateRequests(store, (doc) => {
    const r = doc.requests.find((x) => x.id === requestId && x.status === 'pending');
    if (!r) throw new Error(`no pending consent request ${requestId}`);
    r.status = 'rejected';
    r.resolved_at = nowIso(now);
    return r;
  });
}

/**
 * Privilege-reducing decisions (deny / revoke) can be recorded by anyone and take effect immediately.
 * Written to the policy log when possible; if it is not writable (e.g. sandboxed agent), to the restrictions list.
 */
export function recordRestriction(store, target, decision, { note = null, actor = 'unverified', home = os.homedir(), now = new Date() } = {}) {
  validTarget(target);
  if (decision !== 'denied' && decision !== 'revoked') throw new Error('restrictions are "denied" or "revoked"');
  checkNote(note);
  try {
    const e = appendPolicy(store, { target, decision, access: 'privileged', scope: 'project', note, actor }, { home, now });
    return { id: `G${e.seq}`, target, decision, store: 'policy' };
  } catch (err) {
    const id = `X-${crypto.randomBytes(4).toString('hex')}`;
    updateRequests(store, (doc) => {
      doc.restrictions.push({ id, target, decision, at: nowIso(now), actor, note, reason_not_in_policy: String(err.code ?? err.message).slice(0, 200) });
    });
    return { id, target, decision, store: 'restrictions' };
  }
}

/**
 * Human-only: record a grant. `approval` must be a token minted by confirmHuman() in this process.
 * Approving a pending request uses that request's target/access/scope exactly.
 */
export function recordHumanGrant(store, target, { approval, access = 'read', scope = 'project', session = null, expiresAt = null, note = null, requestId = null, home = os.homedir(), now = new Date() } = {}) {
  if (!isHumanApproval(approval)) throw new Error('a consent grant requires a human approval obtained in an interactive terminal (brain consent approve <request-id>)');
  validTarget(target);
  if (!ACCESS.includes(access)) throw new Error(`access must be one of ${ACCESS.join('/')}`);
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join('/')}`);
  if (scope === 'session' && !session) throw new Error('session-scoped consent needs a session id');
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new Error('expiry must be an ISO date/time');
  checkNote(note);
  const e = appendPolicy(store, { target, decision: 'granted', access, scope, session, expires_at: expiresAt, note, actor: 'human', via: approval.via, request_id: requestId }, { home, now });
  if (requestId) {
    updateRequests(store, (doc) => {
      const r = doc.requests.find((x) => x.id === requestId);
      if (r) Object.assign(r, { status: 'approved', resolved_at: nowIso(now), grant: `G${e.seq}` });
    });
  }
  return { id: `G${e.seq}`, target, decision: 'granted', access, scope, expires_at: expiresAt };
}

/** Human decision to deny (recorded as human in the policy log; same effect as a restriction). */
export function recordHumanDenial(store, target, { approval, note = null, home = os.homedir(), now = new Date() } = {}) {
  if (!isHumanApproval(approval)) throw new Error('human denial requires an approval token');
  validTarget(target);
  const e = appendPolicy(store, { target, decision: 'denied', access: 'privileged', scope: 'project', note, actor: 'human', via: approval.via }, { home, now });
  return { id: `G${e.seq}`, target, decision: 'denied' };
}

/** Mark a once-grant as used (privilege-reducing; anyone may record it). */
export function consumeGrant(store, grantId, { home = os.homedir(), now = new Date() } = {}) {
  appendPolicy(store, { target: 'consumption', decision: 'consumed', grant_id: grantId, actor: 'controller' }, { home, now });
  return true;
}

/**
 * Backwards-compatible entry point. Grants require `approval`; deny/revoke become restrictions.
 */
export function recordConsent(store, target, decision, opts = {}) {
  if (decision === 'granted') return recordHumanGrant(store, target, opts);
  if (decision === 'denied' || decision === 'revoked') return recordRestriction(store, target, decision, opts);
  throw new Error('decision must be granted, denied or revoked');
}

function isActive(g, { session, now }) {
  const t = nowIso(now);
  if (g.scope === 'session' && g.session !== session) return false;
  if (g.expires_at && g.expires_at <= t) return false;
  if (g.scope === 'once' && g.used) return false;
  return true;
}

/** Latest active decision for a target (denials and revocations from any source; grants only from humans). */
export function activeDecision(state, target, { session = null, now = new Date() } = {}) {
  const relevant = state.grants.filter((g) => g.target === target && isActive(g, { session, now }) && (g.decision !== 'granted' || (g.actor === 'human' && g.via === 'tty-challenge')));
  return relevant.at(-1) ?? null;
}

function setupText(registry, capId) {
  const providers = registry?.capabilities?.[capId]?.providers ?? [];
  const links = providers.filter((p) => p.official_setup_url).map((p) => `${p.id}: ${p.official_setup_url}`);
  return { providers: providers.map((p) => p.id), links };
}

/**
 * Decide what to do about one declared capability.
 * decision: proceed | verify | ask-consent | ask-scope | wait | fallback | blocked
 */
export function evaluateCapability(decl, importance, state, registry, { session = null, now = new Date(), skill = null } = {}) {
  const capId = decl.id;
  const need = decl.access ?? 'read';
  const obs = state.capabilities?.[capId];
  const status = obs?.state ?? 'missing';
  const d = activeDecision(state, capId, { session, now });
  const { providers, links } = setupText(registry, capId);
  const base = { capability: capId, importance, access: need, status, consent: d ? d.decision : 'none', purpose: decl.purpose ?? null, fallback: decl.fallback ?? null, providers, setup_links: links };
  const fallbackOrBlock = (why) =>
    importance === 'optional' || decl.fallback
      ? { ...base, decision: 'fallback', message: `${why} Continue with the fallback: ${decl.fallback ?? 'skip this optional step'}. Do not ask again unless the user raises it.` }
      : { ...base, decision: 'blocked', message: `${why} This capability is required and has no fallback; stop and explain the blocker.` };
  const requestCmd = `brain consent request ${capId} --access ${need}${skill ? ` --skill ${skill}` : ''} --reason "<why>"`;

  if (state.integrity && !state.integrity.ok) return fallbackOrBlock(`The consent policy failed its integrity check (${state.integrity.error}); every protected capability is blocked until a person repairs it.`);
  if (d && (d.decision === 'denied' || d.decision === 'revoked')) return fallbackOrBlock(`The user ${d.decision} ${capId}.`);
  if (!d) {
    const avail = status === 'available' ? ' It is verified available, but availability is not permission.' : '';
    return {
      ...base,
      decision: 'ask-consent',
      message:
        `${skill ?? 'This task'} ${importance === 'required' ? 'needs' : 'can use'} ${capId} (${need} access) to ${decl.purpose ?? 'complete the workflow'}, and the user has not approved it.${avail} ` +
        `Explain why to the user, record the request with \`${requestCmd}\`, and ask them to approve it themselves in their own terminal (\`brain consent approve <request-id>\`). ` +
        `If the integration is not connected, they connect it through the host's own flow${links.length ? ` (${links.join('; ')})` : ' (no verified official setup link on file)'}. ` +
        `Meanwhile continue with: ${decl.fallback ?? (importance === 'required' ? 'nothing — the task cannot be completed faithfully without it' : 'skipping this optional step')}. Never ask for credentials in chat.`,
    };
  }
  if (ACCESS_RANK[d.access] < ACCESS_RANK[need]) {
    return { ...base, decision: 'ask-scope', message: `The user approved ${capId} for ${d.access} access only, but ${skill ?? 'this task'} needs ${need}. Request exactly ${need} (\`${requestCmd}\`) or continue within ${d.access} access.` };
  }
  if (status === 'available') {
    const verified = Math.max(0, ...(obs.access ?? []).map((a) => ACCESS_RANK[a] ?? 0));
    if (verified >= ACCESS_RANK[need]) return { ...base, decision: 'proceed', message: `${capId}: approved by the user (${d.access}, ${d.scope}) and verified available (${obs.evidence}).` };
  }
  if (status === 'host_setup_pending') return { ...base, decision: 'wait', message: `The user approved ${capId}; waiting for them to finish connecting it in the host.` };
  if (status === 'error' || status === 'expired') return { ...base, decision: 'verify', message: `${capId} is approved but last reported "${status}". Ask the user to reconnect it through the host's flow, then re-check.` };
  return { ...base, decision: 'verify', message: `${capId} is approved (${d.access}) but not yet confirmed working. Make one harmless ${need === 'read' ? 'read' : 'read-only'} call to confirm, then record it with \`brain capabilities record ${capId} available --access ${need} --evidence "..."\`.` };
}

/** Evaluate every capability a skill manifest declares, plus the approvals it requires. */
export function evaluateSkill(manifest, state, registry, opts = {}) {
  const caps = manifest?.capabilities ?? {};
  const items = [
    ...(caps.required ?? []).map((d) => evaluateCapability(d, 'required', state, registry, { ...opts, skill: manifest.id })),
    ...(caps.optional ?? []).map((d) => evaluateCapability(d, 'optional', state, registry, { ...opts, skill: manifest.id })),
  ];
  const ready = items.every((i) => i.importance === 'optional' || i.decision === 'proceed' || i.decision === 'fallback');
  const blocked = items.some((i) => i.decision === 'blocked');
  return { skill: manifest?.id, ready: ready && !blocked, blocked, integrity: state.integrity ?? { ok: true }, items, approvals: manifest?.approvals ?? [] };
}

/**
 * Decide whether a specific high-impact action may run now. A connected capability never implies approval.
 * Returns { decision: allow | ask | deny, reason, grant }
 */
export function authorizeAction(state, action, { alwaysConfirm = false, session = null, now = new Date() } = {}) {
  if (state.integrity && !state.integrity.ok) return { decision: 'deny', reason: `consent policy integrity failure (${state.integrity.error}); protected actions fail closed`, grant: null };
  const g = activeDecision(state, `action:${action}`, { session, now });
  if (g && (g.decision === 'denied' || g.decision === 'revoked')) return { decision: 'deny', reason: `the user ${g.decision} "${action}" (${g.at})`, grant: g };
  if (g?.decision === 'granted') {
    if (alwaysConfirm && g.scope !== 'once') return { decision: 'ask', reason: `"${action}" is marked always-confirm; standing approvals do not apply — ask for this specific instance`, grant: null };
    return { decision: 'allow', reason: `approved by the user in a terminal (${g.scope}${g.expires_at ? `, until ${g.expires_at}` : ''})`, grant: g };
  }
  return { decision: 'ask', reason: `"${action}" needs the user's explicit approval (brain consent request action:${action}, then the user runs brain consent approve); a connected service does not authorize it`, grant: null };
}

/** Capabilities the user explicitly denied or revoked. */
export function deniedCapabilities(state, { session = null, now = new Date() } = {}) {
  const ids = new Set(state.grants.filter((g) => !g.target.startsWith('action:')).map((g) => g.target));
  return [...ids].filter((id) => ['denied', 'revoked'].includes(activeDecision(state, id, { session, now })?.decision));
}

/**
 * Capabilities a host adapter should block now.
 *   denylist (default): explicitly denied/revoked.  allowlist: everything without an active human grant.
 *   Integrity failure: every capability in the registry (fail closed).
 */
export function blockedCapabilities(state, registry, { mode = 'denylist', session = null, now = new Date() } = {}) {
  const all = Object.keys(registry?.capabilities ?? {});
  if (state.integrity && !state.integrity.ok) return { ids: all, reason: `consent policy integrity failure: ${state.integrity.error}` };
  if (mode === 'allowlist') return { ids: all.filter((id) => activeDecision(state, id, { session, now })?.decision !== 'granted'), reason: 'allowlist mode: no active approval' };
  return { ids: deniedCapabilities(state, { session, now }), reason: 'denied or revoked by the user' };
}

// Used when the registry itself cannot be loaded: conservative patterns so enforcement fails closed, not open.
export const FALLBACK_TOOL_PATTERNS = [
  { capId: 'web.search', access: 'read', re: /^WebSearch$/ },
  { capId: 'web.fetch', access: 'read', re: /^WebFetch$/ },
  { capId: 'mcp.*', access: 'write', re: /^mcp__/ },
];

/** Map a host tool name to the capability (and access level) it exercises, using the registry patterns. */
export function capabilityForTool(registry, toolName, host = 'claude-code') {
  if (host !== 'claude-code') return null;
  for (const [capId, def] of Object.entries(registry?.capabilities ?? {})) {
    for (const [access, patterns] of Object.entries(def.claude_code_tools ?? {})) {
      for (const p of patterns) if (new RegExp(p).test(toolName)) return { capId, access };
    }
  }
  return null;
}
