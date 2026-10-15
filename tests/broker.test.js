import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from './helpers.js';
import { resolveProject } from '../src/project.js';
import { BrainStore } from '../src/store.js';
import { authorizeAction, capabilityForTool, consumeGrant, deniedCapabilities, evaluateSkill, loadState, recordCapability, recordConsent } from '../src/broker.js';
import { loadCapabilityRegistry } from '../src/catalog.js';

const registry = loadCapabilityRegistry();
const webResearch = { id: 'web-research', capabilities: { required: [{ id: 'web.search', access: 'read', purpose: 'find sources', fallback: 'offline answer labelled not current' }], optional: [{ id: 'web.fetch', access: 'read', purpose: 'read pages', fallback: 'snippets only' }] }, approvals: [{ action: 'publish', always_confirm: true }] };
const strict = { id: 'strict', capabilities: { required: [{ id: 'github.write', access: 'write', purpose: 'open PRs' }] } };

function store() {
  const s = new BrainStore(resolveProject(makeRepo({ 'a.txt': 'a' })));
  s.scaffold();
  return s;
}

test('missing capability asks to connect, with verified setup links and the fallback', () => {
  const s = store();
  const r = evaluateSkill(webResearch, loadState(s), registry);
  const ws = r.items.find((i) => i.capability === 'web.search');
  assert.equal(ws.decision, 'ask-connect');
  assert.match(ws.message, /https:\/\/code\.claude\.com\/docs\/en\/tools-reference/);
  assert.match(ws.message, /offline answer labelled not current/);
  assert.match(ws.message, /never ask for credentials/);
  assert.equal(r.ready, false);
});

test('denial blocks required capabilities without fallback and falls back otherwise; no re-asking', () => {
  const s = store();
  recordConsent(s, 'web.search', 'denied');
  const r = evaluateSkill(webResearch, loadState(s), registry);
  assert.equal(r.items.find((i) => i.capability === 'web.search').decision, 'fallback');
  assert.match(r.items[0].message, /Do not ask again/);
  recordConsent(s, 'github.write', 'denied', { access: 'write' });
  const st = evaluateSkill(strict, loadState(s), registry);
  assert.equal(st.blocked, true);
  assert.deepEqual(deniedCapabilities(loadState(s)).sort(), ['github.write', 'web.search']);
});

test('approval leads to verify; only a recorded real check makes it available', () => {
  const s = store();
  recordConsent(s, 'web.search', 'granted', { access: 'read' });
  assert.equal(evaluateSkill(webResearch, loadState(s), registry).items[0].decision, 'verify');
  assert.throws(() => recordCapability(s, 'web.search', 'available', { access: ['read'] }), /requires --evidence/);
  assert.throws(() => recordCapability(s, 'web.search', 'available', { evidence: 'ok' }), /access level/);
  recordCapability(s, 'web.search', 'available', { access: ['read'], evidence: 'WebSearch returned results' });
  const r = evaluateSkill(webResearch, loadState(s), registry);
  assert.equal(r.items[0].decision, 'proceed');
});

test('read access does not satisfy a write requirement (scope mismatch)', () => {
  const s = store();
  recordConsent(s, 'github.write', 'granted', { access: 'read' });
  assert.equal(evaluateSkill(strict, loadState(s), registry).items[0].decision, 'ask-scope');
  recordCapability(s, 'github.write', 'available', { access: ['read'], evidence: 'listed PRs' });
  assert.equal(evaluateSkill(strict, loadState(s), registry).items[0].decision, 'ask-scope');
});

test('expired and revoked access ask again; invalid transitions are rejected', () => {
  const s = store();
  recordConsent(s, 'web.search', 'granted', { expiresAt: '2020-01-01T00:00:00.000Z' });
  recordCapability(s, 'web.search', 'expired');
  const r = evaluateSkill(webResearch, loadState(s), registry);
  assert.equal(r.items[0].decision, 'ask-connect');
  assert.match(r.items[0].message, /expired/);
  recordConsent(s, 'web.search', 'revoked');
  assert.match(evaluateSkill(webResearch, loadState(s), registry).items[0].message, /revoked/);
  recordCapability(s, 'web.fetch', 'connected_unverified');
  assert.throws(() => recordCapability(s, 'web.fetch', 'consent_requested'), /invalid capability transition connected_unverified → consent_requested/);
  assert.throws(() => recordCapability(s, 'web.fetch', 'nonsense'), /unknown capability state/);
});

test('connection never authorizes a high-impact action; always-confirm ignores standing approval; once grants are consumed', () => {
  const s = store();
  recordConsent(s, 'github.write', 'granted', { access: 'write' });
  recordCapability(s, 'github.write', 'available', { access: ['write'], evidence: 'created draft PR in sandbox repo' });
  assert.equal(authorizeAction(loadState(s), 'merge-pull-request').decision, 'ask');
  recordConsent(s, 'action:publish', 'granted', { scope: 'project', access: 'privileged' });
  assert.equal(authorizeAction(loadState(s), 'publish').decision, 'allow');
  assert.equal(authorizeAction(loadState(s), 'publish', { alwaysConfirm: true }).decision, 'ask');
  const once = recordConsent(s, 'action:deploy', 'granted', { scope: 'once', access: 'privileged' });
  assert.equal(authorizeAction(loadState(s), 'deploy', { alwaysConfirm: true }).decision, 'allow');
  consumeGrant(s, once.id);
  assert.equal(authorizeAction(loadState(s), 'deploy').decision, 'ask');
  recordConsent(s, 'action:send-external-message', 'denied', { access: 'privileged' });
  assert.equal(authorizeAction(loadState(s), 'send-external-message').decision, 'deny');
});

test('session-scoped grants do not leak into other sessions', () => {
  const s = store();
  recordConsent(s, 'action:publish', 'granted', { scope: 'session', session: 'sess-A', access: 'privileged' });
  assert.equal(authorizeAction(loadState(s), 'publish', { session: 'sess-A' }).decision, 'allow');
  assert.equal(authorizeAction(loadState(s), 'publish', { session: 'sess-B' }).decision, 'ask');
});

test('credentials are rejected in consent notes and evidence', () => {
  const s = store();
  assert.throws(() => recordConsent(s, 'web.search', 'granted', { note: 'token ghp_' + 'Q1w2E3r4'.repeat(5) }), /credential/);
  assert.throws(() => recordCapability(s, 'web.search', 'available', { access: ['read'], evidence: 'Bearer ' + 'x'.repeat(30) }), /credential/);
});

test('host tool names map to capabilities for enforcement', () => {
  assert.deepEqual(capabilityForTool(registry, 'WebSearch'), { capId: 'web.search', access: 'read' });
  assert.deepEqual(capabilityForTool(registry, 'mcp__github__create_pull_request'), { capId: 'github.write', access: 'write' });
  assert.deepEqual(capabilityForTool(registry, 'mcp__github__get_file_contents'), { capId: 'github.read', access: 'read' });
  assert.equal(capabilityForTool(registry, 'Bash'), null);
});
