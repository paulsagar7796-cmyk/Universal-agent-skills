import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo } from './helpers.js';
import { resolveProject } from '../src/project.js';
import { BrainStore } from '../src/store.js';
import { authorizeAction, blockedCapabilities, capabilityForTool, consumeGrant, deniedCapabilities, evaluateSkill, loadState, recordCapability, recordHumanGrant, recordRestriction, requestConsent } from '../src/broker.js';
import { confirmHuman } from '../src/human.js';
import { loadCapabilityRegistry } from '../src/catalog.js';

const registry = loadCapabilityRegistry();
const webResearch = { id: 'web-research', capabilities: { required: [{ id: 'web.search', access: 'read', purpose: 'find sources', fallback: 'offline answer labelled not current' }], optional: [{ id: 'web.fetch', access: 'read', purpose: 'read pages', fallback: 'snippets only' }] }, approvals: [{ action: 'publish', always_confirm: true }] };
const strict = { id: 'strict', capabilities: { required: [{ id: 'github.write', access: 'write', purpose: 'open PRs' }] } };

/** Simulated person at a terminal: reads the displayed code and types it back (library-level; the CLI uses /dev/tty). */
export function human() {
  let shown = '';
  return confirmHuman({ title: 'test approval', env: {}, io: { write: (s) => (shown += s), readLine: () => shown.match(/Type ([A-Z0-9]{6})/)[1], close() {} } });
}

function store() {
  const s = new BrainStore(resolveProject(makeRepo({ 'a.txt': 'a' })));
  s.scaffold();
  return s;
}

test('no consent yet: ask-consent with request command, verified setup links and the fallback', () => {
  const s = store();
  const r = evaluateSkill(webResearch, loadState(s), registry);
  const ws = r.items.find((i) => i.capability === 'web.search');
  assert.equal(ws.decision, 'ask-consent');
  assert.match(ws.message, /brain consent request web\.search --access read --skill web-research/);
  assert.match(ws.message, /their own terminal/);
  assert.match(ws.message, /https:\/\/code\.claude\.com\/docs\/en\/tools-reference/);
  assert.match(ws.message, /offline answer labelled not current/);
  assert.equal(r.ready, false);
});

test('availability is not permission: a recorded "available" observation without a human grant still asks', () => {
  const s = store();
  recordCapability(s, 'web.search', 'available', { access: ['read'], evidence: 'WebSearch returned results' });
  const it = evaluateSkill(webResearch, loadState(s), registry).items[0];
  assert.equal(it.decision, 'ask-consent');
  assert.match(it.message, /availability is not permission/);
});

test('human grant → verify; grant + verified observation → proceed', () => {
  const s = store();
  recordHumanGrant(s, 'web.search', { approval: human(), access: 'read' });
  assert.equal(evaluateSkill(webResearch, loadState(s), registry).items[0].decision, 'verify');
  assert.throws(() => recordCapability(s, 'web.search', 'available', { access: ['read'] }), /requires --evidence/);
  recordCapability(s, 'web.search', 'available', { access: ['read'], evidence: 'WebSearch returned results' });
  assert.equal(evaluateSkill(webResearch, loadState(s), registry).items[0].decision, 'proceed');
});

test('denials: required-with-fallback falls back, required-without-fallback blocks; no re-asking', () => {
  const s = store();
  recordRestriction(s, 'web.search', 'denied');
  const r = evaluateSkill(webResearch, loadState(s), registry);
  assert.equal(r.items[0].decision, 'fallback');
  assert.match(r.items[0].message, /Do not ask again/);
  recordRestriction(s, 'github.write', 'denied');
  assert.equal(evaluateSkill(strict, loadState(s), registry).blocked, true);
  assert.deepEqual(deniedCapabilities(loadState(s)).sort(), ['github.write', 'web.search']);
});

test('read grant does not satisfy write (scope mismatch); a later human grant for write does', () => {
  const s = store();
  recordHumanGrant(s, 'github.write', { approval: human(), access: 'read' });
  assert.equal(evaluateSkill(strict, loadState(s), registry).items[0].decision, 'ask-scope');
  recordHumanGrant(s, 'github.write', { approval: human(), access: 'write' });
  assert.equal(evaluateSkill(strict, loadState(s), registry).items[0].decision, 'verify');
});

test('expired and revoked grants stop counting; observations reject consent-only states', () => {
  const s = store();
  recordHumanGrant(s, 'web.search', { approval: human(), expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(evaluateSkill(webResearch, loadState(s), registry).items[0].decision, 'ask-consent', 'expired grant ignored');
  recordHumanGrant(s, 'web.search', { approval: human() });
  recordRestriction(s, 'web.search', 'revoked');
  const it = evaluateSkill(webResearch, loadState(s), registry).items[0];
  assert.equal(it.decision, 'fallback');
  assert.match(it.message, /revoked/);
  assert.throws(() => recordCapability(s, 'web.fetch', 'user_approved'), /unknown capability state/);
});

test('connection never authorizes a high-impact action; always-confirm ignores standing grants; once grants are consumed', () => {
  const s = store();
  recordHumanGrant(s, 'github.write', { approval: human(), access: 'write' });
  recordCapability(s, 'github.write', 'available', { access: ['write'], evidence: 'created draft PR in sandbox repo' });
  assert.equal(authorizeAction(loadState(s), 'merge-pull-request').decision, 'ask');
  recordHumanGrant(s, 'action:publish', { approval: human(), access: 'privileged' });
  assert.equal(authorizeAction(loadState(s), 'publish').decision, 'allow');
  assert.equal(authorizeAction(loadState(s), 'publish', { alwaysConfirm: true }).decision, 'ask');
  recordHumanGrant(s, 'action:deploy', { approval: human(), scope: 'once', access: 'privileged' });
  const a = authorizeAction(loadState(s), 'deploy', { alwaysConfirm: true });
  assert.equal(a.decision, 'allow');
  consumeGrant(s, a.grant.id);
  assert.equal(authorizeAction(loadState(s), 'deploy').decision, 'ask');
  recordRestriction(s, 'action:send-external-message', 'denied');
  assert.equal(authorizeAction(loadState(s), 'send-external-message').decision, 'deny');
});

test('session-scoped grants do not leak into other sessions', () => {
  const s = store();
  recordHumanGrant(s, 'action:publish', { approval: human(), scope: 'session', session: 'sess-A', access: 'privileged' });
  assert.equal(authorizeAction(loadState(s), 'publish', { session: 'sess-A' }).decision, 'allow');
  assert.equal(authorizeAction(loadState(s), 'publish', { session: 'sess-B' }).decision, 'ask');
});

test('requests change nothing; allowlist mode blocks everything not granted', () => {
  const s = store();
  const r = requestConsent(s, 'web.search', { access: 'read', reason: 'research task' });
  assert.match(r.id, /^R-/);
  assert.equal(requestConsent(s, 'web.search', { access: 'read' }).id, r.id, 'duplicate pending request is reused');
  const st = loadState(s);
  assert.equal(evaluateSkill(webResearch, st, registry).items[0].decision, 'ask-consent');
  assert.deepEqual(blockedCapabilities(st, registry, { mode: 'denylist' }).ids, []);
  assert.deepEqual(blockedCapabilities(st, registry, { mode: 'allowlist' }).ids.sort(), Object.keys(registry.capabilities).sort());
  recordHumanGrant(s, 'web.search', { approval: human() });
  assert.ok(!blockedCapabilities(loadState(s), registry, { mode: 'allowlist' }).ids.includes('web.search'));
});

test('credentials are rejected in notes, reasons and evidence', () => {
  const s = store();
  const tok = 'ghp_' + 'Q1w2E3r4'.repeat(5);
  assert.throws(() => recordHumanGrant(s, 'web.search', { approval: human(), note: `token ${tok}` }), /credential/);
  assert.throws(() => requestConsent(s, 'web.search', { reason: `use ${tok}` }), /credential/);
  assert.throws(() => recordCapability(s, 'web.search', 'available', { access: ['read'], evidence: 'Bearer ' + 'x'.repeat(30) }), /credential/);
});

test('host tool names map to capabilities for enforcement', () => {
  assert.deepEqual(capabilityForTool(registry, 'WebSearch'), { capId: 'web.search', access: 'read' });
  assert.deepEqual(capabilityForTool(registry, 'mcp__github__create_pull_request'), { capId: 'github.write', access: 'write' });
  assert.deepEqual(capabilityForTool(registry, 'mcp__github__get_file_contents'), { capId: 'github.read', access: 'read' });
  assert.equal(capabilityForTool(registry, 'Bash'), null);
});
