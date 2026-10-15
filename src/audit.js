import fs from 'node:fs';
import { freshness } from './facts.js';
import { findSecrets } from './secrets.js';
import { listProposals } from './proposals.js';
import { readTextIfExists, today } from './util.js';

/** Health report for a project brain: errors must be fixed; warnings need attention; info is advisory. */
export function audit(store, project, { now = new Date() } = {}) {
  const errors = [];
  const warnings = [];
  const info = [];
  const date = today(now);
  if (!store.exists()) return { errors: ['no .agent-brain directory (run `brain init`)'], warnings, info };

  const { doc, errors: factErrors } = store.loadFacts();
  errors.push(...factErrors.map((e) => `facts.yaml: ${e}`));
  const facts = doc.facts ?? [];
  const counts = {};
  for (const f of facts) counts[f.status] = (counts[f.status] ?? 0) + 1;
  info.push(`facts: ${facts.length} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);

  for (const f of facts) {
    if (!f?.id) continue;
    const fr = freshness(f, project.root, date);
    if (fr.state === 'changed' || fr.state === 'missing') warnings.push(`${f.id} evidence ${fr.state}: ${fr.reasons.join('; ')} — re-check and run \`brain verify ${f.id} --confirm\` or deprecate it`);
    else if (fr.state === 'expired') warnings.push(`${f.id} expired: ${fr.reasons.join('; ')}`);
    else if (fr.state === 'unchecked') info.push(`${f.id} has no hashable file evidence (freshness cannot be checked automatically)`);
    if (f.status === 'disputed') warnings.push(`${f.id} is disputed (conflicts with ${(f.conflicts_with ?? []).join(', ') || '?'}) — resolve with the owner`);
    if (f.status === 'assumption' && !f.test_by) warnings.push(`${f.id} assumption has no test_by (how would we find out?)`);
  }

  for (const d of store.listDecisions()) {
    if (d.error) errors.push(`decisions/${d.file}: ${d.error}`);
    if (!['proposed', 'accepted', 'superseded', 'rejected', 'deprecated'].includes(d.status)) warnings.push(`decisions/${d.file}: unusual status "${d.status}"`);
  }

  for (const rel of store.canonicalFiles()) {
    const text = readTextIfExists(store.p(rel), 4 * 1024 * 1024);
    const hits = findSecrets(text);
    if (hits.length) errors.push(`${rel}: possible credential (${hits.join(', ')}) — remove it and rotate the secret if it was real`);
  }
  for (const rel of fs.existsSync(store.p('evidence')) ? fs.readdirSync(store.p('evidence')) : []) {
    const st = fs.statSync(store.p('evidence', rel));
    if (st.isFile() && st.size > 200 * 1024) warnings.push(`evidence/${rel} is ${Math.round(st.size / 1024)} KB — keep evidence small (trim logs)`);
  }

  const gi = readTextIfExists(store.p('.gitignore')) ?? '';
  if (!/^local\/?$/m.test(gi)) warnings.push('.agent-brain/.gitignore does not ignore local/ — runtime state (index, trace, consent) could be committed');

  const pending = listProposals(store);
  if (pending.length) info.push(`${pending.length} pending memory proposal(s) — review with \`brain proposals\``);
  const unknown = facts.filter((f) => f.status === 'unknown').length;
  if (unknown) info.push(`${unknown} open question(s)`);
  return { errors, warnings, info };
}
