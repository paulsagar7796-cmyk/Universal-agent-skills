// Orchestration: workspaces → provider → observations → grading → results on disk. Provider-agnostic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { materialise } from './workspace.js';
import { diffSnapshots, globalChecks, snapshot } from './checks.js';
import { gradeCase, validateJudge } from './grade.js';
import { sanitiseTranscript, transcriptCorpus } from './transcript.js';
import { ProviderError } from './errors.js';
import { REPO_ROOT } from '../catalog.js';
import { readJsonIfExists, writeJsonAtomic } from '../util.js';
import { renderReport, summarise } from './report.js';

export const RESULTS_DIR = path.join(REPO_ROOT, 'evals', 'results');

export function newRunId(providerId, now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${providerId}-${crypto.randomBytes(2).toString('hex')}`;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => (timer = setTimeout(() => rej(new ProviderError(`timed out after ${ms} ms`, { transient: true, kind: 'timeout' })), ms)))]).finally(() => clearTimeout(timer));
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function skipReason(c, provider, opts) {
  if (provider.live && c.requires.some((r) => r.startsWith('web.')) && !opts.allowWeb) return `requires ${c.requires.join(', ')}; re-run with --allow-web to include it`;
  return null;
}

/** Run one case end to end. Never throws: provider failures become status "error". */
export async function runCase(c, { provider, opts, runId, judgeProvider = null }) {
  const started = Date.now();
  const base = { run_id: runId, case_id: c.id, skill: c.skill, kind: c.kind, routing: c.routing, workspace: c.workspace, fixture_note: c.fixtureNote, prompt: c.prompt };
  const skip = skipReason(c, provider, opts);
  if (skip) return { ...base, status: 'skipped', skip_reason: skip, criteria: c.criteria.map((x) => ({ ...x, verdict: 'ungraded', method: 'skipped' })), checks: [], violations: [], attempts: 0, duration_ms: 0 };
  let ws;
  try {
    ws = materialise(c, { skills: opts.skills ?? 'all', parent: opts.workspaceParent ?? null });
  } catch (e) {
    return { ...base, status: 'error', failure_category: 'workspace-error', error: String(e.message ?? e).slice(0, 300), criteria: [], checks: [], violations: [], attempts: 0, duration_ms: Date.now() - started };
  }
  try {
    const before = snapshot(ws.dir);
    let transcript = null;
    let attempt = 0;
    let lastError = null;
    const maxAttempts = 1 + (opts.retries ?? 1);
    while (attempt < maxAttempts) {
      attempt++;
      try {
        transcript = await withTimeout(provider.run(c, ws, { ...opts, runId }), opts.timeoutMs ?? 240000);
        break;
      } catch (e) {
        lastError = e;
        if (!(e instanceof ProviderError && e.transient)) break;
      }
    }
    if (!transcript) {
      return { ...base, status: 'error', failure_category: lastError?.kind ?? 'provider-error', error: String(lastError?.message ?? lastError).slice(0, 300), criteria: [], checks: [], violations: [], attempts: attempt, retries_used: attempt - 1, duration_ms: Date.now() - started };
    }
    transcript.workspace_root = ws.dir;
    const diff = diffSnapshots(before, snapshot(ws.dir));
    const violations = globalChecks({ transcript, diff, canary: ws.canary, deny: c.environment.deny });
    const clean = sanitiseTranscript(transcript, { workspace: ws.dir, home: os.homedir(), canary: ws.canary });
    let judge = {};
    let judgeNote = null;
    if (judgeProvider) {
      const pre = gradeCase(c, { transcript, diff, workspace: ws.dir, violations });
      const open = pre.criteria.filter((x) => x.verdict === 'ungraded');
      if (open.length) {
        try {
          const verdicts = await judgeProvider.judge({ caseId: c.id, prompt: c.prompt, criteria: open, transcriptText: transcriptCorpus(clean) }, opts);
          judge = validateJudge(verdicts, clean, open);
        } catch (e) {
          judgeNote = `judge failed: ${String(e.message ?? e).slice(0, 200)}`;
        }
      }
    }
    const graded = gradeCase(c, { transcript, diff, workspace: ws.dir, violations, judge });
    return {
      ...base,
      ...graded,
      judge_note: judgeNote,
      side_effects: { created: diff.created, modified: diff.modified, deleted: diff.deleted },
      attempts: attempt,
      retries_used: attempt - 1,
      duration_ms: Date.now() - started,
      provider: clean.provider,
      model: clean.model,
      host_version: clean.host_version,
      usage: clean.usage,
      skills_loaded: clean.skills_loaded,
      transcript: { final_text: clean.final_text, events: clean.events.slice(0, 200), available_skills: clean.available_skills },
    };
  } finally {
    if (!opts.keepWorkspaces) ws.cleanup();
  }
}

/** Run a set of cases and write results under outDir/<runId>/. */
export async function runEvaluation({ provider, cases, opts = {}, outDir = RESULTS_DIR, judgeProvider = null, parentRun = null, onCase = null }) {
  const runId = opts.runId ?? newRunId(provider.id);
  const dir = path.join(outDir, runId);
  fs.mkdirSync(path.join(dir, 'cases'), { recursive: true });
  const pkg = readJsonIfExists(path.join(REPO_ROOT, 'package.json')) ?? {};
  const meta = {
    run_id: runId,
    started_at: new Date().toISOString(),
    parent_run: parentRun,
    provider: { id: provider.id, live: provider.live, ...provider.describe(opts) },
    judge: judgeProvider ? judgeProvider.id : null,
    harness: { package: pkg.name, version: pkg.version, node: process.versions.node, platform: `${process.platform}-${process.arch}` },
    options: { concurrency: opts.concurrency ?? 2, timeout_ms: opts.timeoutMs ?? 240000, retries: opts.retries ?? 1, model: opts.model ?? null, budget_usd: opts.budgetUsd ?? null, allow_web: Boolean(opts.allowWeb), skills: opts.skills ?? 'all' },
    case_ids: cases.map((c) => c.id),
  };
  writeJsonAtomic(path.join(dir, 'run.json'), meta);
  const results = await pool(cases, opts.concurrency ?? 2, async (c) => {
    const r = await runCase(c, { provider, opts, runId, judgeProvider });
    writeJsonAtomic(path.join(dir, 'cases', `${c.id}.json`), r);
    onCase?.(r);
    return r;
  });
  meta.finished_at = new Date().toISOString();
  meta.summary = summarise(results, meta);
  writeJsonAtomic(path.join(dir, 'run.json'), meta);
  fs.writeFileSync(path.join(dir, 'report.md'), renderReport(meta, results));
  return { runId, dir, meta, results };
}

export function loadRun(runId, outDir = RESULTS_DIR) {
  const dir = path.join(outDir, runId);
  const meta = readJsonIfExists(path.join(dir, 'run.json'));
  if (!meta) throw new Error(`no saved run ${runId} under ${outDir}`);
  const cdir = path.join(dir, 'cases');
  const results = fs.existsSync(cdir) ? fs.readdirSync(cdir).filter((f) => f.endsWith('.json')).sort().map((f) => readJsonIfExists(path.join(cdir, f))) : [];
  return { dir, meta, results };
}

export function listRuns(outDir = RESULTS_DIR) {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((d) => fs.existsSync(path.join(outDir, d, 'run.json')))
    .sort()
    .map((d) => readJsonIfExists(path.join(outDir, d, 'run.json')));
}

/** Apply human grades (grading.yaml in the run dir) to ungraded criteria and recompute statuses. */
export function applyHumanGrades(results, grades) {
  return results.map((r) => {
    if (!r || r.status === 'error' || r.status === 'skipped') return r;
    const mine = (grades ?? []).filter((g) => g.case === r.case_id && ['pass', 'fail'].includes(g.verdict));
    if (!mine.length) return r;
    const criteria = r.criteria.map((cr) => {
      const g = mine.find((x) => x.criterion === cr.id);
      return g && cr.verdict === 'ungraded' ? { ...cr, verdict: g.verdict, method: 'human', evidence: g.note || 'human grade' } : cr;
    });
    let status = r.status;
    let failure_category = r.failure_category;
    if (!(r.violations ?? []).length) {
      if (criteria.some((x) => x.verdict === 'fail')) {
        status = 'fail';
        failure_category = criteria.find((x) => x.verdict === 'fail').list === 'must_not' ? 'forbidden-behaviour' : 'missing-required-behaviour';
      } else if (criteria.length && criteria.every((x) => x.verdict === 'pass')) status = 'pass';
    }
    return { ...r, criteria, status, failure_category };
  });
}
