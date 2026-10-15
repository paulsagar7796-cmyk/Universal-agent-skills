#!/usr/bin/env node
// Behavioural evaluation harness CLI. See docs/evaluation-guide.md.
//   node scripts/eval.js list   [--skill a,b] [--case id,…] [--kind k] [--json]
//   node scripts/eval.js run    --provider mock|claude-code [filters] [--concurrency 2] [--timeout 240] [--retries 1]
//                               [--model haiku] [--budget 0.5] [--allow-web] [--judge none|claude-code|mock]
//                               [--skills all|case] [--keep-workspaces] [--dry-run] [--yes]
//   node scripts/eval.js rerun  <run-id> [--all]          re-run failed/error cases (default) or all, same provider
//   node scripts/eval.js report <run-id> [--json]          rebuild the report from saved results (no model calls)
//   node scripts/eval.js grade  <run-id>                   write a human grading sheet for ungraded criteria
//   node scripts/eval.js gate   <run-id> [--json]          advisory release gate per skill (never edits skills)
//   node scripts/eval.js runs                              list saved runs
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { coverage, loadCases } from '../src/eval/cases.js';
import { getProvider } from '../src/eval/providers/index.js';
import { applyHumanGrades, listRuns, loadRun, RESULTS_DIR, runEvaluation } from '../src/eval/runner.js';
import { releaseGate, renderReport, summarise } from '../src/eval/report.js';
import { parse, stringify } from '../src/yaml.js';

function args(argv) {
  const pos = [];
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) f[k] = v;
    else if (['json', 'allow-web', 'keep-workspaces', 'dry-run', 'yes', 'all'].includes(k)) f[k] = true;
    else f[k] = argv[++i];
  }
  return { pos, f };
}

const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : null);
const out = (s = '') => process.stdout.write(s + '\n');

function selectCases(f) {
  const { cases, problems } = loadCases({ skills: list(f.skill), ids: list(f.case), kinds: list(f.kind) });
  return { cases, problems };
}

async function confirmLive(provider, cases, opts, f) {
  const plan = provider.plan(cases, opts);
  const d = provider.describe(opts);
  out(`Live evaluation plan — provider ${provider.id} (${d.name}${d.version ? ` ${d.version}` : ''}${d.binary ? ` at ${d.binary}` : ''})`);
  out(`  cases: ${cases.length}; model invocations: ${plan.invocations}${plan.judgeInvocations ? ` (${plan.agentInvocations} agent + ${plan.judgeInvocations} judge)` : ''}; model: ${opts.model ?? 'haiku'}`);
  out(`  spend cap: $${plan.perInvocationBudgetUsd} per invocation (--max-budget-usd) → at most $${(plan.perInvocationBudgetUsd * plan.invocations).toFixed(2)} in total; actual cost is reported per case when the provider returns it`);
  out(`  concurrency ${opts.concurrency}, timeout ${opts.timeoutMs / 1000}s, retries ${opts.retries}`);
  for (const n of [...(d.notes ?? []), ...(plan.notes ?? [])]) out(`  - ${n}`);
  if (f['dry-run']) {
    out('Dry run: nothing was executed.');
    return false;
  }
  if (f.yes) return true;
  if (!process.stdin.isTTY) {
    out('Consent required: re-run with --yes after reviewing this plan (or --dry-run to preview only).');
    process.exitCode = 3;
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('Run it? [y/N] ')).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

async function doRun(cases, f, { parentRun = null, providerId = null } = {}) {
  const provider = getProvider(providerId ?? f.provider ?? 'mock');
  const opts = {
    concurrency: Math.max(1, Math.min(8, Number(f.concurrency ?? 2))),
    timeoutMs: Math.max(5, Number(f.timeout ?? 240)) * 1000,
    retries: Math.max(0, Math.min(3, Number(f.retries ?? 1))),
    model: f.model ?? (provider.live ? 'haiku' : null),
    budgetUsd: Number(f.budget ?? 0.5),
    allowWeb: Boolean(f['allow-web']),
    skills: f.skills ?? 'all',
    keepWorkspaces: Boolean(f['keep-workspaces']),
    claudeBin: f['claude-bin'] ?? null,
    judge: f.judge ?? 'none',
  };
  if (!cases.length) {
    out('No cases selected.');
    return 1;
  }
  if (provider.live && !(await confirmLive(provider, cases, opts, f))) return process.exitCode ?? 0;
  const judgeProvider = opts.judge === 'none' ? null : getProvider(opts.judge);
  if (judgeProvider && !judgeProvider.judge) throw new Error(`provider ${judgeProvider.id} cannot judge`);
  let done = 0;
  const { runId, dir, meta } = await runEvaluation({
    provider,
    cases,
    opts,
    judgeProvider,
    parentRun,
    outDir: f.out ?? RESULTS_DIR,
    onCase: (r) => {
      done++;
      process.stderr.write(`[${done}/${cases.length}] ${r.case_id}: ${r.status}${r.failure_category ? ` (${r.failure_category})` : ''}\n`);
    },
  });
  const s = meta.summary;
  out(`Run ${runId}: ${Object.entries(s.totals).map(([k, v]) => `${k} ${v}`).join(', ')}${s.cost_usd !== null ? `; cost $${s.cost_usd}` : ''}`);
  out(`Results: ${dir}/ (run.json, cases/*.json, report.md)`);
  if (!provider.live) out('Mock provider: these statuses test the harness, not skill quality.');
  return s.totals.error ? 1 : 0;
}

async function main(argv) {
  const { pos, f } = args(argv);
  const cmd = pos[0];
  if (cmd === 'list') {
    const { cases, problems } = selectCases(f);
    const cov = coverage(cases);
    if (f.json) {
      out(JSON.stringify({ coverage: cov, problems, cases: cases.map((c) => ({ id: c.id, skill: c.skill, kind: c.kind, routing: c.routing, workspace: c.workspace, requires: c.requires, criteria: c.criteria.length, structured_checks: c.checks.length, fixture_note: c.fixtureNote })) }, null, 2));
      return problems.length ? 1 : 0;
    }
    for (const c of cases) out(`${c.id.padEnd(26)} ${c.skill.padEnd(32)} ${c.kind.padEnd(18)} ws=${c.workspace.padEnd(16)} criteria=${c.criteria.length} checks=${c.checks.length}${c.requires.length ? ` requires=${c.requires.join(',')}` : ''}`);
    out(`\n${cov.cases} case(s); ${cov.criteria} criteria, ${cov.structured} with structured checks, ${cov.unstructured} needing human/judge grading.`);
    for (const p of problems) out(`problem: ${p}`);
    return problems.length ? 1 : 0;
  }
  if (cmd === 'run') {
    const { cases, problems } = selectCases(f);
    if (problems.length) {
      for (const p of problems) out(`problem: ${p}`);
      return 1;
    }
    return doRun(cases, f);
  }
  if (cmd === 'rerun') {
    const { meta, results } = loadRun(pos[1], f.out ?? RESULTS_DIR);
    const ids = results.filter((r) => f.all || r.status === 'fail' || r.status === 'error').map((r) => r.case_id);
    if (!ids.length) {
      out('Nothing to re-run (no failed or errored cases).');
      return 0;
    }
    const { cases } = loadCases({ ids });
    const o = meta.options ?? {};
    const saved = { concurrency: o.concurrency, timeout: o.timeout_ms ? o.timeout_ms / 1000 : undefined, retries: o.retries, model: o.model ?? undefined, budget: o.budget_usd, 'allow-web': Boolean(o.allow_web), skills: o.skills, judge: meta.judge ?? 'none' };
    return doRun(cases, { ...Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined && v !== null)), ...f }, { parentRun: meta.run_id, providerId: meta.provider.id });
  }
  if (cmd === 'report' || cmd === 'gate' || cmd === 'grade') {
    const runId = pos[1];
    if (!runId) throw new Error(`usage: node scripts/eval.js ${cmd} <run-id>`);
    const { dir, meta } = loadRun(runId, f.out ?? RESULTS_DIR);
    let { results } = loadRun(runId, f.out ?? RESULTS_DIR);
    const gradingFile = path.join(dir, 'grading.yaml');
    if (cmd === 'grade') {
      const items = [];
      for (const r of results) for (const cr of r.criteria ?? []) if (cr.verdict === 'ungraded' && r.status !== 'skipped' && r.status !== 'error') items.push({ case: r.case_id, criterion: cr.id, expectation: `${cr.list === 'must' ? 'MUST' : 'MUST NOT'}: ${cr.text}`, observed_final_response: String(r.transcript?.final_text ?? '').slice(0, 600), verdict: '', note: '' });
      if (fs.existsSync(gradingFile) && !f.yes) throw new Error(`${gradingFile} exists; pass --yes to overwrite`);
      fs.writeFileSync(gradingFile, stringify({ instructions: 'Set verdict to pass or fail for each item from the saved transcript (cases/<id>.json). Leave blank if undecidable. Then run: node scripts/eval.js report <run-id>', run_id: runId, items }));
      out(`Wrote ${items.length} item(s) to ${gradingFile}`);
      return 0;
    }
    if (fs.existsSync(gradingFile)) results = applyHumanGrades(results, parse(fs.readFileSync(gradingFile, 'utf8'))?.items ?? []);
    if (cmd === 'gate') {
      const g = releaseGate(results);
      if (f.json) out(JSON.stringify(g, null, 2));
      else for (const [skill, v] of Object.entries(g).sort()) out(`${skill}: ${v.eligible_for_review ? 'ELIGIBLE FOR HUMAN REVIEW (not promoted)' : 'not eligible'} — ${v.evidence.graded}/${v.evidence.cases} graded, pass rate ${v.evidence.pass_rate}${v.reasons.length ? `; ${v.reasons.join('; ')}` : ''}`);
      return 0;
    }
    const m = { ...meta, summary: summarise(results, meta) };
    if (f.json) out(JSON.stringify(m.summary, null, 2));
    else {
      const md = renderReport(m, results);
      fs.writeFileSync(path.join(dir, 'report.md'), md);
      out(md);
    }
    return 0;
  }
  if (cmd === 'runs') {
    for (const r of listRuns(f.out ?? RESULTS_DIR)) out(`${r.run_id}  ${r.provider?.id}  ${r.summary ? Object.entries(r.summary.totals).map(([k, v]) => `${k}=${v}`).join(' ') : '(incomplete)'}`);
    return 0;
  }
  out(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(1, 12).map((l) => l.slice(3)).join('\n'));
  return cmd ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = process.exitCode ?? code),
  (e) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = 1;
  },
);
