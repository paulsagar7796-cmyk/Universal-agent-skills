// Capability & consent broker.
//
// Honest scope: the broker is bookkeeping plus decision logic. It cannot see the host's tool list from a hook and
// cannot install or authorize integrations. The host's own permission prompts and OAuth flows remain the enforcement
// and authorization boundary. The broker (1) tells the agent what a skill needs and how to ask the user, (2) records
// what the user decided and what a real check observed, (3) never lets a connection imply action approval, and
// (4) optionally blocks explicitly denied capabilities through a host hook (Claude Code PreToolUse).
import path from 'node:path';
import { assertNoSecrets } from './secrets.js';
import { nowIso, readJsonIfExists, withLock, writeJsonAtomic } from './util.js';

export const CAP_STATES = ['not_needed', 'missing', 'consent_requested', 'user_denied', 'user_approved', 'host_setup_pending', 'connected_unverified', 'available', 'revoked', 'expired', 'error'];
export const ACCESS = ['read', 'write', 'privileged'];
const ACCESS_RANK = { read: 1, write: 2, privileged: 3 };

// Allowed transitions. Any state may move to error/revoked/expired; `available` requires evidence of a real check.
const TRANSITIONS = {
  not_needed: ['missing', 'connected_unverified', 'available'],
  missing: ['consent_requested', 'user_denied', 'user_approved', 'connected_unverified', 'available', 'host_setup_pending'],
  consent_requested: ['user_denied', 'user_approved'],
  user_denied: ['consent_requested', 'user_approved'],
  user_approved: ['host_setup_pending', 'connected_unverified', 'available', 'user_denied'],
  host_setup_pending: ['connected_unverified', 'available', 'user_denied', 'missing'],
  connected_unverified: ['available', 'missing', 'user_denied'],
  available: ['connected_unverified', 'missing', 'user_denied'],
  revoked: ['consent_requested', 'user_approved', 'user_denied', 'missing'],
  expired: ['consent_requested', 'user_approved', 'connected_unverified', 'available', 'missing'],
  error: ['missing', 'connected_unverified', 'available', 'user_denied'],
};

export function stateFile(store) {
  return path.join(store.localDir(), 'consent.json');
}

export function loadState(store) {
  const s = readJsonIfExists(stateFile(store)) ?? {};
  return { schema_version: 1, capabilities: s.capabilities ?? {}, grants: s.grants ?? [], history: s.history ?? [] };
}

function saveState(store, mutate) {
  return withLock(path.join(store.localDir(), 'consent.lock'), () => {
    const state = loadState(store);
    const result = mutate(state);
    state.history = state.history.slice(-500);
    const text = JSON.stringify(state);
    assertNoSecrets(text, 'consent/capability state');
    writeJsonAtomic(stateFile(store), state);
    return result;
  });
}

function checkNote(note) {
  if (note === undefined || note === null) return;
  if (typeof note !== 'string' || note.length > 500) throw new Error('note/evidence must be a string of at most 500 characters');
  assertNoSecrets(note, 'consent note');
}

/** Record an observed capability state (e.g. after the agent actually called the tool, or the host reported an auth error). */
export function recordCapability(store, capId, state, { evidence, access = [], by = 'agent', now = new Date() } = {}) {
  if (!CAP_STATES.includes(state)) throw new Error(`unknown capability state "${state}" (one of ${CAP_STATES.join(', ')})`);
  checkNote(evidence);
  const levels = [].concat(access).filter(Boolean);
  for (const a of levels) if (!ACCESS.includes(a)) throw new Error(`unknown access level "${a}"`);
  if (state === 'available' && !evidence) throw new Error('marking a capability "available" requires --evidence describing the real check (e.g. "WebSearch call returned results at 14:02")');
  if (state === 'available' && levels.length === 0) throw new Error('marking a capability "available" requires the verified access level(s), e.g. --access read');
  return saveState(store, (st) => {
    const prev = st.capabilities[capId]?.state ?? 'missing';
    const universal = ['error', 'revoked', 'expired'];
    if (prev !== state && !universal.includes(state) && !(TRANSITIONS[prev] ?? []).includes(state)) {
      throw new Error(`invalid capability transition ${prev} → ${state} for ${capId}`);
    }
    st.capabilities[capId] = { state, access: levels, evidence: evidence ?? null, by, at: nowIso(now) };
    st.history.push({ type: 'capability', capId, from: prev, to: state, by, at: nowIso(now) });
    return { capId, from: prev, to: state };
  });
}

/**
 * Record a user decision.
 *   target: a capability id (connection/data access) or `action:<name>` (a specific high-impact action)
 *   decision: granted | denied | revoked
 *   scope: once | session | project      expiresAt: optional ISO time
 */
export function recordConsent(store, target, decision, { access = 'read', scope = 'project', session = null, expiresAt = null, note = null, now = new Date() } = {}) {
  if (!['granted', 'denied', 'revoked'].includes(decision)) throw new Error('decision must be granted, denied or revoked');
  if (!ACCESS.includes(access)) throw new Error(`access must be one of ${ACCESS.join('/')}`);
  if (!['once', 'session', 'project'].includes(scope)) throw new Error('scope must be once, session or project');
  if (scope === 'session' && !session) throw new Error('session-scoped consent needs a session id');
  checkNote(note);
  return saveState(store, (st) => {
    const grant = { id: `G${st.grants.length + 1}-${Date.now().toString(36)}`, target, decision, access, scope, session, expires_at: expiresAt, note, at: nowIso(now), used: false };
    st.grants.push(grant);
    st.history.push({ type: 'consent', target, decision, access, scope, at: grant.at });
    if (!target.startsWith('action:')) {
      const cur = st.capabilities[target]?.state ?? 'missing';
      if (decision === 'denied') st.capabilities[target] = { ...(st.capabilities[target] ?? {}), state: 'user_denied', at: grant.at, by: 'user' };
      else if (decision === 'revoked') st.capabilities[target] = { ...(st.capabilities[target] ?? {}), state: 'revoked', at: grant.at, by: 'user' };
      else if (decision === 'granted' && ['missing', 'consent_requested', 'user_denied', 'revoked', 'expired'].includes(cur)) st.capabilities[target] = { ...(st.capabilities[target] ?? {}), state: 'user_approved', at: grant.at, by: 'user' };
    }
    return grant;
  });
}

function activeGrant(state, target, { session = null, now = new Date() } = {}) {
  const t = nowIso(now);
  const relevant = state.grants.filter((g) => g.target === target && !(g.scope === 'session' && g.session !== session) && !(g.expires_at && g.expires_at <= t) && !(g.scope === 'once' && g.used));
  return relevant.at(-1) ?? null; // latest decision wins
}

/** Mark a one-time grant as consumed. */
export function consumeGrant(store, grantId) {
  return saveState(store, (st) => {
    const g = st.grants.find((x) => x.id === grantId);
    if (g && g.scope === 'once') g.used = true;
    return Boolean(g);
  });
}

function setupText(registry, capId) {
  const providers = registry?.capabilities?.[capId]?.providers ?? [];
  const links = providers.filter((p) => p.official_setup_url).map((p) => `${p.id}: ${p.official_setup_url}`);
  return { providers: providers.map((p) => p.id), links };
}

/**
 * Decide what to do about one declared capability.
 * decision: proceed | verify | ask-connect | ask-scope | wait | fallback | blocked
 */
export function evaluateCapability(decl, importance, state, registry, { session = null, now = new Date(), skill = null } = {}) {
  const capId = decl.id;
  const need = decl.access ?? 'read';
  const cap = state.capabilities[capId];
  const status = cap?.state ?? 'missing';
  const denial = activeGrant(state, capId, { session, now });
  const { providers, links } = setupText(registry, capId);
  const base = { capability: capId, importance, access: need, status, purpose: decl.purpose ?? null, fallback: decl.fallback ?? null, providers, setup_links: links };
  const fallbackOrBlock = (why) =>
    importance === 'optional' || decl.fallback
      ? { ...base, decision: 'fallback', message: `${why} Continue with the fallback: ${decl.fallback ?? 'skip this optional step'}. Do not ask again unless the user raises it.` }
      : { ...base, decision: 'blocked', message: `${why} This capability is required and has no fallback; stop and explain the blocker.` };

  if (status === 'user_denied' || denial?.decision === 'denied') return fallbackOrBlock(`The user denied ${capId}.`);
  if (status === 'available') {
    const granted = Math.max(0, ...(cap.access ?? []).map((a) => ACCESS_RANK[a] ?? 0));
    if (granted >= ACCESS_RANK[need]) return { ...base, decision: 'proceed', message: `${capId} was verified available (${cap.evidence}).` };
    return { ...base, decision: 'ask-scope', message: `${capId} is connected with ${cap.access.join('/') || 'unknown'} access but ${skill ?? 'this task'} needs ${need}. Ask the user for exactly ${need} access through the host's own flow, or continue read-only.` };
  }
  if (denial?.decision === 'granted' && ACCESS_RANK[denial.access] < ACCESS_RANK[need]) {
    return { ...base, decision: 'ask-scope', message: `The user approved ${capId} for ${denial.access} access only, but ${skill ?? 'this task'} needs ${need}. Ask for exactly ${need} access, or continue within ${denial.access} access.` };
  }
  if (status === 'connected_unverified' || status === 'user_approved') {
    return { ...base, decision: 'verify', message: `${capId} is ${status === 'user_approved' ? 'approved by the user but not yet confirmed working' : 'configured but unverified'}. Make one harmless ${need === 'read' ? 'read' : 'read-only'} call to confirm, then record the result with \`brain capabilities record ${capId} available --access ${need} --evidence "..."\`.` };
  }
  if (status === 'host_setup_pending') return { ...base, decision: 'wait', message: `Waiting for the user to finish setting up ${capId} in the host. Re-check when they say it is done.` };
  const reason = status === 'expired' ? 'Access to ' + capId + ' expired.' : status === 'revoked' ? 'Access to ' + capId + ' was revoked.' : status === 'error' ? capId + ' reported an error.' : `${capId} is not confirmed available in this agent.`;
  return {
    ...base,
    decision: 'ask-connect',
    message:
      `${reason} ${skill ?? 'This task'} ${importance === 'required' ? 'needs' : 'can use'} ${capId} (${need} access) to ${decl.purpose ?? 'complete the workflow'}. ` +
      `First check whether your own tools already provide it. If not, ask the user: connect it through the host's supported flow${links.length ? ` (${links.join('; ')})` : ' (no verified official setup link on file)'}, ` +
      `or continue with: ${decl.fallback ?? (importance === 'required' ? 'no fallback — the task cannot be completed faithfully' : 'skipping this optional step')}. ` +
      'Request only the access listed; never ask for credentials in chat.',
  };
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
  return { skill: manifest?.id, ready: ready && !blocked, blocked, items, approvals: manifest?.approvals ?? [] };
}

/**
 * Decide whether a specific high-impact action may run now. A connected capability never implies approval.
 * Returns { decision: allow | ask | deny, reason, grant }
 */
export function authorizeAction(state, action, { alwaysConfirm = false, session = null, now = new Date() } = {}) {
  const g = activeGrant(state, `action:${action}`, { session, now });
  if (g?.decision === 'denied') return { decision: 'deny', reason: `the user denied "${action}" (${g.at})`, grant: g };
  if (g?.decision === 'granted') {
    if (alwaysConfirm && g.scope !== 'once') return { decision: 'ask', reason: `"${action}" is marked always-confirm; standing approvals do not apply — ask for this specific instance`, grant: null };
    return { decision: 'allow', reason: `approved by the user (${g.scope}${g.expires_at ? `, until ${g.expires_at}` : ''})`, grant: g };
  }
  return { decision: 'ask', reason: `"${action}" needs explicit user approval before it runs; connection to a service does not authorize it`, grant: null };
}

/** Capabilities the user explicitly denied (used by context packets and the PreToolUse enforcement hook). */
export function deniedCapabilities(state, { session = null, now = new Date() } = {}) {
  return Object.entries(state.capabilities)
    .filter(([id, c]) => c.state === 'user_denied' || activeGrant(state, id, { session, now })?.decision === 'denied')
    .map(([id]) => id);
}

/** Map a host tool name to the capability (and access level) it exercises, using the registry patterns. */
export function capabilityForTool(registry, toolName, host = 'claude-code') {
  const key = host === 'claude-code' ? 'claude_code_tools' : null;
  if (!key) return null;
  for (const [capId, def] of Object.entries(registry?.capabilities ?? {})) {
    for (const [access, patterns] of Object.entries(def[key] ?? {})) {
      for (const p of patterns) if (new RegExp(p).test(toolName)) return { capId, access };
    }
  }
  return null;
}
