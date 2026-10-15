// Experiment memory: .agent-brain/experiments/EXP-NNNN.yaml (canonical, committed).
//
// Rules that make the record trustworthy:
//  - code state, config/data hashes, seeds and environment are captured by the tool, not typed by the agent;
//  - metrics are only ever read from a results file the run produced (path + hash recorded); there is no way to
//    type a metric value in;
//  - comparisons are computed (Welch's t-test over seeds) and refuse to call a difference an improvement when seeds
//    are too few or the runs used different data/splits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from './yaml.js';
import { assertNoSecrets } from './secrets.js';
import { gitState } from './project.js';
import { nowIso, withLock, writeFileAtomic } from './util.js';

export const EXP_SCHEMA = 1;
const ID_RE = /^EXP-\d{4,}$/;
const STATUSES = ['running', 'completed', 'failed', 'abandoned'];
const FULL_HASH_LIMIT = 256 * 1024 * 1024;
const PARTIAL_CHUNK = 8 * 1024 * 1024;
const METRIC_FILE_LIMIT = 50 * 1024 * 1024;

export function experimentsDir(store) {
  return store.p('experiments');
}

function relOrAbs(root, p) {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel.split(path.sep).join('/');
}

/** Hash a file (full up to 256 MB, otherwise size + first/last 8 MB) or a directory (sorted listing of names+sizes). */
export function fingerprint(absPath) {
  const st = fs.statSync(absPath);
  if (st.isDirectory()) {
    const entries = [];
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.isFile()) entries.push(`${r}:${fs.statSync(path.join(dir, e.name)).size}`);
        if (entries.length > 100000) return;
      }
    };
    walk(absPath, '');
    return { sha256: crypto.createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16), size: null, files: entries.length, hash_mode: 'listing' };
  }
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    if (st.size <= FULL_HASH_LIMIT) {
      const buf = Buffer.alloc(1024 * 1024);
      let n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
      return { sha256: h.digest('hex').slice(0, 16), size: st.size, hash_mode: 'full' };
    }
    const head = Buffer.alloc(PARTIAL_CHUNK);
    const tail = Buffer.alloc(PARTIAL_CHUNK);
    fs.readSync(fd, head, 0, PARTIAL_CHUNK, 0);
    fs.readSync(fd, tail, 0, PARTIAL_CHUNK, st.size - PARTIAL_CHUNK);
    h.update(String(st.size)).update(head).update(tail);
    return { sha256: h.digest('hex').slice(0, 16), size: st.size, hash_mode: 'partial' };
  } finally {
    fs.closeSync(fd);
  }
}

function probe(cmd, args, timeout = 8000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, env: { ...process.env, BRAIN_HOOK_ACTIVE: '1' } });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

/** Read-only environment probe (versions and GPU names). Skipped with probeEnv=false. */
export function captureEnvironment({ python = 'python3', probeEnv = true } = {}) {
  const env = { platform: `${os.platform()}-${os.arch()}`, cpus: os.cpus().length, memory_gb: Math.round(os.totalmem() / 1e9) };
  if (!probeEnv) return { ...env, probed: false };
  const py = probe(python, ['-c', 'import sys,platform;print(platform.python_version())'], 5000);
  if (py) env.python = py;
  const libs = probe(python, ['-c', 'import importlib.util as u,json\nout={}\nfor m in ["torch","tensorflow","jax","sklearn","numpy","pandas"]:\n    if u.find_spec(m):\n        try:\n            mod=__import__(m); out[m]=getattr(mod,"__version__","?")\n        except Exception as e: out[m]="import-error"\ntry:\n    import torch; out["cuda"]=torch.version.cuda; out["cuda_available"]=torch.cuda.is_available()\nexcept Exception: pass\nprint(json.dumps(out))'], 20000);
  if (libs) {
    try {
      Object.assign(env, { libraries: JSON.parse(libs) });
    } catch {
      /* ignore */
    }
  }
  const gpu = probe('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], 5000);
  if (gpu) env.gpus = gpu.split('\n').map((l) => l.trim()).filter(Boolean);
  env.probed = true;
  return env;
}

export function listExperiments(store) {
  const dir = experimentsDir(store);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^EXP-\d{4,}\.yaml$/.test(f))
    .sort()
    .map((f) => {
      try {
        return parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (e) {
        return { id: f.replace(/\.yaml$/, ''), error: e.message };
      }
    });
}

export function getExperiment(store, id) {
  if (!ID_RE.test(String(id))) throw new Error(`experiment ids look like EXP-0001 (got ${JSON.stringify(id)})`);
  const f = path.join(experimentsDir(store), `${id}.yaml`);
  if (!fs.existsSync(f)) throw new Error(`no experiment ${id}`);
  return parse(fs.readFileSync(f, 'utf8'));
}

function save(store, exp) {
  const text = stringify(exp, { header: `Experiment record. Written by \`brain exp\`; metrics come only from result files (see runs[].source).` });
  assertNoSecrets(text, `experiment ${exp.id}`);
  writeFileAtomic(path.join(experimentsDir(store), `${exp.id}.yaml`), text);
}

function update(store, id, fn) {
  fs.mkdirSync(experimentsDir(store), { recursive: true });
  return withLock(path.join(store.localDir(), 'experiments.lock'), () => {
    const exp = getExperiment(store, id);
    const r = fn(exp);
    save(store, exp);
    return r ?? exp;
  });
}

function fileRef(root, p, extra = {}) {
  const abs = path.resolve(root, p);
  if (!fs.existsSync(abs)) throw new Error(`${p} does not exist`);
  return { path: relOrAbs(root, p), ...fingerprint(abs), ...extra };
}

/** Start a run: capture code, config, data, seeds and environment. */
export function startExperiment(store, project, input, { now = new Date(), env = null } = {}) {
  if (!input.title || !String(input.title).trim()) throw new Error('--title is required');
  if (input.baseline && !ID_RE.test(input.baseline)) throw new Error('--baseline must be an experiment id like EXP-0003');
  const seeds = (input.seeds ?? []).map((s) => {
    if (!/^-?\d+$/.test(String(s))) throw new Error(`seed must be an integer (got ${s})`);
    return Number(s);
  });
  fs.mkdirSync(experimentsDir(store), { recursive: true });
  return withLock(path.join(store.localDir(), 'experiments.lock'), () => {
    const existing = listExperiments(store);
    if (input.baseline && !existing.some((e) => e.id === input.baseline)) throw new Error(`baseline ${input.baseline} does not exist`);
    const max = Math.max(0, ...existing.map((e) => Number(String(e.id).replace(/\D/g, '')) || 0));
    const id = `EXP-${String(max + 1).padStart(4, '0')}`;
    const g = project.isRepo ? gitState(project.root, { maxFiles: 20 }) : null;
    const exp = {
      schema_version: EXP_SCHEMA,
      id,
      title: String(input.title).trim(),
      question: input.question ?? null,
      hypothesis: input.hypothesis ?? null,
      baseline: input.baseline ?? null,
      status: 'running',
      started_at: nowIso(now),
      code: g ? { commit: g.head, branch: g.branch, uncommitted_changes: g.changedCount, changed_files: g.changed.map((c) => c.path).slice(0, 20) } : null,
      config: (input.configs ?? []).map((c) => fileRef(project.root, c)),
      // --data train=data/train.parquet  (role prefix optional; default role "data")
      data: (input.data ?? []).map((d) => {
        const m = String(d).match(/^([a-z][a-z0-9_-]{0,20})=(.+)$/i);
        return fileRef(project.root, m ? m[2] : d, { role: m ? m[1].toLowerCase() : 'data' });
      }),
      split: input.split ?? null,
      seeds,
      environment: env ?? captureEnvironment({ python: input.python ?? 'python3', probeEnv: input.probeEnv !== false }),
      runs: [],
      comparisons: [],
      conclusion: null,
    };
    save(store, exp);
    return exp;
  });
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
  }
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"', i++);
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Read numeric metrics from a results file. Returns { metrics, locator }. */
export function readMetrics(absPath, { select = null, row = null } = {}) {
  const st = fs.statSync(absPath);
  if (st.size > METRIC_FILE_LIMIT) throw new Error(`metrics file is larger than ${METRIC_FILE_LIMIT / 1e6} MB`);
  const text = fs.readFileSync(absPath, 'utf8');
  const ext = path.extname(absPath).toLowerCase();
  let metrics;
  let locator;
  if (ext === '.json') {
    metrics = flatten(JSON.parse(text));
    locator = 'json (flattened numeric keys)';
  } else if (ext === '.jsonl' || ext === '.ndjson') {
    const lines = text.split('\n').filter((l) => l.trim());
    if (!lines.length) throw new Error('metrics file has no lines');
    const idx = row ? Number(row) - 1 : lines.length - 1;
    if (!lines[idx]) throw new Error(`no line ${row}`);
    metrics = flatten(JSON.parse(lines[idx]));
    locator = `line ${idx + 1} of ${lines.length}`;
  } else if (ext === '.csv' || ext === '.tsv') {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const split = ext === '.tsv' ? (l) => l.split('\t').map((s) => s.trim()) : parseCsvLine;
    const header = split(lines[0] ?? '');
    const idx = row ? Number(row) : lines.length - 1;
    if (idx < 1 || !lines[idx]) throw new Error(`no data row ${row ?? ''}`);
    const vals = split(lines[idx]);
    metrics = {};
    header.forEach((h, i) => {
      const n = Number(vals[i]);
      if (h && vals[i] !== '' && Number.isFinite(n)) metrics[h] = n;
    });
    locator = `row ${idx} of ${lines.length - 1}`;
  } else throw new Error(`unsupported metrics file type ${ext || '(none)'}: use .json, .jsonl or .csv/.tsv (export TensorBoard/W&B summaries to one of these)`);
  if (select) {
    const want = select;
    const missing = want.filter((k) => !(k in metrics));
    if (missing.length) throw new Error(`metric(s) not found in ${path.basename(absPath)}: ${missing.join(', ')} (available: ${Object.keys(metrics).slice(0, 20).join(', ')})`);
    metrics = Object.fromEntries(want.map((k) => [k, metrics[k]]));
    locator += `; keys ${want.join(', ')}`;
  } else {
    const keys = Object.keys(metrics).slice(0, 30);
    metrics = Object.fromEntries(keys.map((k) => [k, metrics[k]]));
  }
  if (!Object.keys(metrics).length) throw new Error('no numeric metrics found');
  return { metrics, locator };
}

/** Log one run's metrics from a results file. There is deliberately no way to type values directly. */
export function logMetrics(store, project, id, { from, select = null, row = null, seed = null }, { now = new Date() } = {}) {
  if (!from) throw new Error('--from <results file> is required: metrics are only read from files the run produced');
  const abs = path.resolve(project.root, from);
  if (!fs.existsSync(abs)) throw new Error(`${from} does not exist`);
  const { metrics, locator } = readMetrics(abs, { select, row });
  if (seed !== null && !/^-?\d+$/.test(String(seed))) throw new Error('--seed must be an integer');
  return update(store, id, (exp) => {
    if (exp.status !== 'running') throw new Error(`${id} is ${exp.status}; metrics can only be logged while it is running`);
    const fp = fingerprint(abs);
    if (exp.runs.some((r) => r.source.sha256 === fp.sha256 && r.source.locator === locator)) throw new Error('these exact results were already logged for this experiment');
    exp.runs.push({ seed: seed === null ? null : Number(seed), metrics, source: { path: relOrAbs(project.root, from), sha256: fp.sha256, locator }, logged_at: nowIso(now) });
    if (seed !== null && !exp.seeds.includes(Number(seed))) exp.seeds.push(Number(seed));
  });
}

export function finishExperiment(store, id, { status, conclusion = null }, { now = new Date() } = {}) {
  if (!STATUSES.includes(status) || status === 'running') throw new Error('--status must be completed, failed or abandoned');
  return update(store, id, (exp) => {
    if (exp.status !== 'running') throw new Error(`${id} is already ${exp.status}`);
    if (status === 'completed' && !exp.runs.length) throw new Error(`${id} has no logged metrics; log results with \`brain exp log\` or finish it as failed/abandoned`);
    exp.status = status;
    exp.finished_at = nowIso(now);
    exp.conclusion = conclusion;
  });
}

// --- statistics ------------------------------------------------------------------------------------------------------

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sampleVar(xs) {
  const m = mean(xs);
  return xs.length > 1 ? xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) : 0;
}

// Regularised incomplete beta via continued fraction (Numerical Recipes betacf), for the t distribution CDF.
function lnGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-sided p-value for Student's t with df degrees of freedom. */
export function tTestPValue(t, df) {
  return betai(df / 2, 0.5, df / (df + t * t));
}

/** Welch's t-test. Returns { t, df, p } (p two-sided). */
export function welch(a, b) {
  const va = sampleVar(a) / a.length;
  const vb = sampleVar(b) / b.length;
  const se = Math.sqrt(va + vb);
  if (se === 0) return { t: mean(b) === mean(a) ? 0 : Infinity, df: a.length + b.length - 2, p: mean(b) === mean(a) ? 1 : 0 };
  const t = (mean(b) - mean(a)) / se;
  const df = (va + vb) ** 2 / ((va ** 2) / (a.length - 1) + (vb ** 2) / (b.length - 1));
  return { t, df, p: tTestPValue(Math.abs(t), df) };
}

const round = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

/**
 * Compare candidate B against baseline A on one metric. Verdicts:
 *   not-comparable | insufficient-seeds | improved | worse | no-clear-difference
 */
export function compareExperiments(a, b, metric, { higherIsBetter = true, alpha = 0.05, minSeeds = 3, baselineMetric = null } = {}) {
  const values = (e, m) => e.runs.map((r) => r.metrics?.[m]).filter((v) => typeof v === 'number');
  const va = values(a, baselineMetric ?? metric);
  const vb = values(b, metric);
  const warnings = [];
  const dataKey = (e) => (e.data ?? []).map((d) => `${d.role}:${d.sha256}`).sort().join('|');
  if (!va.length || !vb.length) return { verdict: 'not-comparable', reasons: [`metric "${!va.length ? baselineMetric ?? metric : metric}" missing in ${!va.length ? a.id : b.id} (if the same metric has a different name there, pass --baseline-metric)`], metric };
  if (baselineMetric && baselineMetric !== metric) warnings.push(`comparing ${a.id}.${baselineMetric} with ${b.id}.${metric}: make sure they measure the same thing on the same split`);
  const reasons = [];
  if (dataKey(a) !== dataKey(b)) reasons.push(`different data fingerprints (${a.id}: ${dataKey(a) || 'none recorded'}; ${b.id}: ${dataKey(b) || 'none recorded'})`);
  if ((a.split ?? null) !== (b.split ?? null)) reasons.push(`different splits (${a.split ?? 'unrecorded'} vs ${b.split ?? 'unrecorded'})`);
  if (!(a.data ?? []).length || !(b.data ?? []).length) warnings.push('no data fingerprint recorded for at least one run; data equality cannot be checked');
  if (a.baseline !== null && b.baseline === null && a.id !== b.baseline) warnings.push(`${b.id} does not name ${a.id} as its baseline`);
  const summary = { [a.id]: { n: va.length, mean: round(mean(va)), sd: round(Math.sqrt(sampleVar(va))) }, [b.id]: { n: vb.length, mean: round(mean(vb)), sd: round(Math.sqrt(sampleVar(vb))) } };
  const diff = mean(vb) - mean(va);
  const rel = mean(va) !== 0 ? (diff / Math.abs(mean(va))) * 100 : null;
  const base = { metric, higher_is_better: higherIsBetter, summary, difference: round(diff), relative_change_pct: rel === null ? null : round(rel, 2), warnings };
  if (reasons.length) return { ...base, verdict: 'not-comparable', reasons };
  if (va.length < minSeeds || vb.length < minSeeds) return { ...base, verdict: 'insufficient-seeds', reasons: [`need at least ${minSeeds} runs (seeds) per experiment to judge a difference; have ${va.length} and ${vb.length}`] };
  const w = welch(va, vb);
  const better = higherIsBetter ? diff > 0 : diff < 0;
  const verdict = w.p < alpha ? (better ? 'improved' : 'worse') : 'no-clear-difference';
  return { ...base, verdict, test: { name: 'Welch two-sided t-test', t: round(w.t), df: round(w.df, 2), p: round(w.p, 5), alpha }, reasons: verdict === 'no-clear-difference' ? [`p = ${round(w.p, 4)} ≥ ${alpha}: the difference is within run-to-run variation`] : [], caveats: ['A t-test over a handful of seeds has low power; report effect size and spread, and correct for multiple comparisons when testing many variants.'] };
}

/** Compute and record a comparison on the candidate's record. */
export function recordComparison(store, baselineId, candidateId, metric, opts = {}) {
  const a = getExperiment(store, baselineId);
  const res = compareExperiments(a, getExperiment(store, candidateId), metric, opts);
  update(store, candidateId, (exp) => {
    exp.comparisons = [...(exp.comparisons ?? []).filter((c) => !(c.against === baselineId && c.metric === metric)), { against: baselineId, metric, verdict: res.verdict, difference: res.difference ?? null, p: res.test?.p ?? null, at: nowIso(opts.now ?? new Date()) }];
  });
  return res;
}

const CLAIM_RE = /\b(improv\w*|better|outperform\w*|beats?|gains?|state[- ]of[- ]the[- ]art|sota|significant(ly)?)\b/i;

/** Audit experiment records for honesty and hygiene problems. */
export function auditExperiments(store, now = new Date(), root = store.root) {
  const warnings = [];
  for (const e of listExperiments(store)) {
    if (e.error) {
      warnings.push(`experiments/${e.id}.yaml: unreadable (${e.error})`);
      continue;
    }
    if (e.status === 'running' && Date.parse(e.started_at) < now.getTime() - 7 * 86_400_000) warnings.push(`${e.id} has been "running" for more than 7 days — finish it as completed, failed or abandoned`);
    if (e.status === 'completed' && !(e.runs ?? []).length) warnings.push(`${e.id} is completed but has no logged metrics`);
    if (e.conclusion && CLAIM_RE.test(e.conclusion) && !(e.comparisons ?? []).some((c) => c.verdict === 'improved')) warnings.push(`${e.id} conclusion claims an improvement ("${e.conclusion.slice(0, 80)}") but no recorded comparison found one — run \`brain exp compare\` or reword it`);
    if ((e.seeds ?? []).length <= 1 && e.status === 'completed') warnings.push(`${e.id} used ${(e.seeds ?? []).length || 'no recorded'} seed(s); results may not be stable`);
    for (const [i, r] of (e.runs ?? []).entries()) {
      const abs = path.resolve(root, r.source?.path ?? '');
      if (!r.source?.path || !fs.existsSync(abs)) {
        warnings.push(`${e.id} run ${i + 1}: results file ${r.source?.path ?? '?'} is missing, so its metrics cannot be re-verified`);
        continue;
      }
      if (fingerprint(abs).sha256 !== r.source.sha256) {
        warnings.push(`${e.id} run ${i + 1}: ${r.source.path} changed after it was logged`);
        continue;
      }
      try {
        const keys = Object.keys(r.metrics ?? {});
        const rowMatch = String(r.source.locator).match(/^(?:row|line) (\d+)/);
        const again = readMetrics(abs, { select: keys, row: rowMatch ? Number(rowMatch[1]) : null }).metrics;
        const bad = keys.filter((k) => again[k] !== r.metrics[k]);
        if (bad.length) warnings.push(`${e.id} run ${i + 1}: recorded ${bad.join(', ')} do not match ${r.source.path} (record edited by hand?)`);
      } catch (err) {
        warnings.push(`${e.id} run ${i + 1}: cannot re-read ${r.source.path} (${err.message})`);
      }
    }
    if (e.code?.uncommitted_changes) warnings.push(`${e.id} started with ${e.code.uncommitted_changes} uncommitted change(s); the exact code is not reproducible from git`);
  }
  return warnings;
}
