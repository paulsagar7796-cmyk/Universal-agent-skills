// Summaries, human-readable reports and the (advisory) release gate.
const STATUSES = ['pass', 'fail', 'needs-grading', 'error', 'skipped'];

export function summarise(results, meta = {}) {
  const total = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const bySkill = {};
  const byKind = {};
  const methods = {};
  const violations = [];
  let cost = 0;
  let costKnown = false;
  for (const r of results) {
    if (!r) continue;
    total[r.status] = (total[r.status] ?? 0) + 1;
    for (const [map, key] of [[bySkill, r.skill], [byKind, r.kind]]) {
      map[key] ??= Object.fromEntries(STATUSES.map((s) => [s, 0]));
      map[key][r.status]++;
    }
    for (const cr of r.criteria ?? []) {
      methods[cr.method] ??= { pass: 0, fail: 0, ungraded: 0 };
      methods[cr.method][cr.verdict] = (methods[cr.method][cr.verdict] ?? 0) + 1;
    }
    for (const v of r.violations ?? []) violations.push({ case: r.case_id, ...v });
    if (typeof r.usage?.cost_usd === 'number') {
      cost += r.usage.cost_usd;
      costKnown = true;
    }
  }
  const executed = results.filter((r) => r && r.status !== 'skipped' && r.status !== 'error').length;
  return { cases: results.length, executed, totals: total, by_skill: bySkill, by_kind: byKind, criteria_by_method: methods, safety_violations: violations, cost_usd: costKnown ? Math.round(cost * 10000) / 10000 : null, provider: meta.provider?.id ?? null };
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');

export function renderReport(meta, results) {
  const s = meta.summary ?? summarise(results, meta);
  const L = [];
  L.push(`# Evaluation report — ${meta.run_id}`, '');
  L.push(`- Started: ${meta.started_at}${meta.finished_at ? ` · finished: ${meta.finished_at}` : ''}`);
  L.push(`- Provider: ${meta.provider?.name ?? meta.provider?.id}${meta.provider?.version ? ` ${meta.provider.version}` : ''}; model: ${meta.provider?.model ?? 'n/a'}; judge: ${meta.judge ?? 'none'}`);
  L.push(`- Harness: ${meta.harness?.package} ${meta.harness?.version}, Node ${meta.harness?.node}, ${meta.harness?.platform}`);
  L.push(`- Options: ${JSON.stringify(meta.options)}`);
  if (meta.parent_run) L.push(`- Re-run of: ${meta.parent_run}`);
  L.push('');
  if (!meta.provider?.live) L.push('> **Mock provider:** statuses below come from scripted transcripts. They test the harness (workspaces, checks, grading, reporting), **not** skill quality.', '');
  L.push('> A "pass" means every expectation of that case was graded pass by a structured check, a human, or a judge verdict with verified evidence quotes. It is not a security certification, and small samples say little about general skill quality.', '');
  L.push('## Totals', '');
  L.push('| Status | Cases |', '|---|---|');
  for (const st of STATUSES) L.push(`| ${st} | ${s.totals[st] ?? 0} |`);
  L.push(`| **total** | ${s.cases} (executed ${s.executed}) |`, '');
  if (s.cost_usd !== null) L.push(`Reported model cost: $${s.cost_usd}`, '');
  L.push('## How criteria were graded', '', '| Method | pass | fail | ungraded |', '|---|---|---|---|');
  for (const [m, v] of Object.entries(s.criteria_by_method)) L.push(`| ${m} | ${v.pass ?? 0} | ${v.fail ?? 0} | ${v.ungraded ?? 0} |`);
  L.push('');
  L.push('## By skill', '', '| Skill | pass | fail | needs-grading | error | skipped |', '|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(s.by_skill).sort()) L.push(`| ${k} | ${v.pass} | ${v.fail} | ${v['needs-grading']} | ${v.error} | ${v.skipped} |`);
  L.push('', '## By case kind', '', '| Kind | pass | fail | needs-grading | error | skipped |', '|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(s.by_kind).sort()) L.push(`| ${k} | ${v.pass} | ${v.fail} | ${v['needs-grading']} | ${v.error} | ${v.skipped} |`);
  L.push('', '## Safety violations', '');
  if (!s.safety_violations.length) L.push('_None observed._ (Only the checks listed in docs/evaluation-guide.md are applied.)');
  for (const v of s.safety_violations) L.push(`- **${v.case}** — ${v.id}: ${String(v.evidence).replace(/\n/g, ' ').slice(0, 200)}`);
  L.push('', '## Failures and errors', '');
  const bad = results.filter((r) => r && (r.status === 'fail' || r.status === 'error'));
  if (!bad.length) L.push('_None._');
  for (const r of bad) {
    L.push(`### ${r.case_id} (${r.skill}, ${r.kind}) — ${r.status}${r.failure_category ? ` · ${r.failure_category}` : ''}`);
    if (r.error) L.push(`- Error: ${r.error}`);
    for (const cr of (r.criteria ?? []).filter((x) => x.verdict === 'fail')) L.push(`- ${cr.list === 'must' ? 'MUST' : 'MUST NOT'}: ${cr.text}\n  - observed (${cr.method}): ${String(cr.evidence).slice(0, 300)}`);
    for (const v of r.violations ?? []) L.push(`- violation ${v.id}: ${String(v.evidence).slice(0, 200)}`);
    L.push(`- attempts: ${r.attempts ?? 0}, duration: ${r.duration_ms ?? 0} ms${r.fixture_note ? `, note: ${r.fixture_note}` : ''}`, '');
  }
  const skipped = results.filter((r) => r?.status === 'skipped');
  if (skipped.length) {
    L.push('## Skipped', '');
    for (const r of skipped) L.push(`- ${r.case_id}: ${r.skip_reason}`);
    L.push('');
  }
  const ng = results.filter((r) => r?.status === 'needs-grading');
  if (ng.length) L.push('## Needs grading', '', `${ng.length} case(s) have expectations without a structured check or verified grade. Run \`node scripts/eval.js grade ${meta.run_id}\` to create a grading sheet, fill it in, then \`node scripts/eval.js report ${meta.run_id}\`.`, '');
  L.push('## Known limitations', '');
  L.push('- Global safety checks see only tool calls and file changes inside the workspace; shell commands that write elsewhere are contained by the provider sandbox, not detected.');
  L.push('- Regex response checks can miss paraphrases; criteria without checks need human or judge grading.');
  L.push('- Workspaces are synthetic fixtures; cases whose fixture is described only in prose may not be faithfully reproduced (see per-case notes).');
  L.push('- Host-provided skills outside this repository may also be visible to the agent (see transcript.available_skills).');
  return L.join('\n') + '\n';
}

/**
 * Advisory promotion gate (proposed policy, docs/release-policy.md). Never edits manifests. Returns per skill
 * { eligible_for_review, reasons, evidence }.
 */
export function releaseGate(results, { minCases = 5, minPerKind = ['typical', 'edge|ambiguous', 'unsupported-claim|untrusted-input'] } = {}) {
  const bySkill = {};
  for (const r of results) if (r) (bySkill[r.skill] ??= []).push(r);
  const out = {};
  for (const [skill, rs] of Object.entries(bySkill)) {
    const reasons = [];
    const graded = rs.filter((r) => r.status === 'pass' || r.status === 'fail');
    if (rs.some((r) => (r.violations ?? []).length)) reasons.push('safety violation observed');
    if (rs.some((r) => r.status === 'fail')) reasons.push(`${rs.filter((r) => r.status === 'fail').length} failing case(s)`);
    if (rs.some((r) => r.status === 'error' || r.status === 'skipped' || r.status === 'needs-grading')) reasons.push(`${rs.filter((r) => !['pass', 'fail'].includes(r.status)).length} case(s) not fully graded (error/skipped/needs-grading)`);
    if (graded.length < minCases) reasons.push(`only ${graded.length} fully graded case(s); at least ${minCases} required`);
    for (const group of minPerKind) if (!graded.some((r) => group.split('|').includes(r.kind) && r.status === 'pass')) reasons.push(`no passing ${group} case`);
    out[skill] = { eligible_for_review: reasons.length === 0, reasons, evidence: { cases: rs.length, graded: graded.length, passed: graded.filter((r) => r.status === 'pass').length, pass_rate: pct(graded.filter((r) => r.status === 'pass').length, graded.length) } };
  }
  return out;
}
