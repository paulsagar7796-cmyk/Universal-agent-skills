// Phase 3: notebook/research awareness, experiment memory, research skills' helper scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, brain, read, REPO, tmpDir } from './helpers.js';
import { analyseNotebook } from '../src/research-scan.js';
import { resolveProject } from '../src/project.js';
import { BrainStore } from '../src/store.js';
import { initBrain } from '../src/init.js';
import { auditExperiments, compareExperiments, fingerprint, finishExperiment, getExperiment, logMetrics, readMetrics, recordComparison, startExperiment, tTestPValue, welch } from '../src/experiments.js';
import { runCheck } from '../src/eval/checks.js';
import { buildContext } from '../src/context.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const nb = (cells) => JSON.stringify({ cells, metadata: { kernelspec: { name: 'python3' } }, nbformat: 4, nbformat_minor: 5 });
const code = (n, src, outputs = []) => ({ cell_type: 'code', execution_count: n, source: src, outputs, metadata: {} });

test('notebook analysis: execution order, unexecuted cells, seeds, absolute paths, imports, reads; outputs never read', () => {
  const a = analyseNotebook(nb([code(3, ['import torch\n', "x = pd.read_csv('data/train.csv')\n"], [{ output_type: 'stream', text: 'SECRET-OUTPUT' }]), code(1, ["m = torch.load('/Users/x/m.pt')\n"]), code(null, ['print(1)'])]));
  assert.equal(a.outOfOrder, true);
  assert.equal(a.partiallyExecuted, true);
  assert.equal(a.seed, false);
  assert.equal(a.absPaths, 1);
  assert.deepEqual(a.imports, ['torch']);
  assert.deepEqual(a.reads, ['/Users/x/m.pt', 'data/train.csv']);
  assert.ok(!JSON.stringify(a).includes('SECRET-OUTPUT'));
  const b = analyseNotebook(nb([code(1, ['import numpy as np\n', 'np.random.seed(0)\n']), code(2, ['print(2)'])]));
  assert.equal(b.outOfOrder, false);
  assert.equal(b.seed, true);
  assert.equal(analyseNotebook('not json'), null);
});

function mlRepo(extra = {}) {
  return makeRepo({
    'requirements.txt': 'torch==2.5.1\nscikit-learn>=1.4\nwandb\n',
    'notebooks/train.ipynb': nb([code(2, ['import torch\n']), code(1, ['torch.manual_seed(0)\n'], [{ output_type: 'stream', text: 'OUTPUT-SHOULD-NOT-APPEAR' }])]),
    'data/train.csv': 'id,x,label\n1,0.1,0\n',
    'models/best.pt': 'binary-ish',
    'Snakefile': 'rule all:\n  input: "x"\n',
    'config/config.yaml': 'reference: GRCh38.fa\nknown_sites: dbsnp_hg19.vcf\n',
    'data.dvc': 'outs:\n- path: data\n',
    ...extra,
  });
}

test('init on a research project records notebooks, risks, ML stack, data census, workflows and genome-build conflicts', () => {
  const dir = mlRepo();
  const project = resolveProject(dir);
  const store = new BrainStore(project);
  const s = initBrain(store, project);
  for (const t of ['notebooks', 'ml', 'data', 'bioinformatics']) assert.ok(s.notes.types.includes(t), t);
  const facts = store.loadFacts().doc.facts;
  const claim = (re) => facts.find((f) => re.test(f.claim));
  assert.ok(claim(/Notebook notebooks\/train\.ipynb: 2 code cell/));
  assert.ok(claim(/Reproducibility risks in notebooks\/train\.ipynb: cells were executed out of order/));
  assert.ok(claim(/PyTorch ==2\.5\.1/));
  assert.ok(claim(/Data\/model files by kind: .*table 1.*model 1/));
  assert.ok(claim(/DVC tracks data/));
  assert.ok(claim(/Snakemake workflow/));
  const conflict = facts.find((f) => f.key === 'genome.build');
  assert.equal(conflict.status, 'disputed');
  assert.match(conflict.claim, /GRCh38\/hg38 and GRCh37\/hg19/);
  assert.ok(facts.some((f) => f.status === 'unknown' && /research question/.test(f.claim)));
  for (const rel of store.canonicalFiles()) assert.ok(!read(store.p(rel)).includes('OUTPUT-SHOULD-NOT-APPEAR'), rel);
  assert.ok(!read(store.p('facts.yaml')).includes('binary-ish'), 'data contents are never read');
});

// ------------------------------------------------------------------------------------------------- experiment memory

function expProject() {
  const dir = makeRepo({ 'configs/a.yaml': 'lr: 0.1\n', 'data/train.csv': 'x,y\n1,2\n', 'data/train_v2.csv': 'x,y\n9,9\n', 'README.md': '# x\n' });
  const project = resolveProject(dir);
  const store = new BrainStore(project);
  store.scaffold();
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  return { dir, project, store, w };
}
const env = { platform: 'test', probed: false };

test('experiment start captures code state, config/data fingerprints, split and seeds', () => {
  const { project, store } = expProject();
  const e = startExperiment(store, project, { title: 'baseline', configs: ['configs/a.yaml'], data: ['train=data/train.csv'], split: 'random-80-20-seed42', seeds: ['1', '2', '3'] }, { env });
  assert.equal(e.id, 'EXP-0001');
  assert.equal(e.status, 'running');
  assert.match(e.code.commit, /^[0-9a-f]+$/);
  assert.equal(e.config[0].path, 'configs/a.yaml');
  assert.equal(e.data[0].role, 'train');
  assert.equal(e.data[0].hash_mode, 'full');
  assert.deepEqual(e.seeds, [1, 2, 3]);
  assert.throws(() => startExperiment(store, project, { title: 'x', baseline: 'EXP-0999' }, { env }), /does not exist/);
  assert.throws(() => startExperiment(store, project, { title: 'x', seeds: ['one'] }, { env }), /integer/);
  assert.equal(fingerprint(path.join(project.root, 'data')).hash_mode, 'listing');
});

test('metrics only come from result files (json, jsonl, csv); duplicates, missing keys and typed values are rejected', () => {
  const { project, store, w } = expProject();
  startExperiment(store, project, { title: 'b' }, { env });
  w('runs/s1.json', JSON.stringify({ val: { acc: 0.8, loss: 0.3 }, note: 'x' }));
  w('runs/s2.jsonl', '{"acc": 0.5}\n{"acc": 0.81}\n');
  w('runs/s3.csv', 'epoch,val.acc\n1,0.5\n10,0.79\n');
  logMetrics(store, project, 'EXP-0001', { from: 'runs/s1.json', select: ['val.acc'], seed: 1 });
  assert.deepEqual(readMetrics(path.join(project.root, 'runs/s2.jsonl')).metrics, { acc: 0.81 });
  assert.deepEqual(readMetrics(path.join(project.root, 'runs/s3.csv'), { select: ['val.acc'] }).metrics, { 'val.acc': 0.79 });
  assert.throws(() => logMetrics(store, project, 'EXP-0001', { from: 'runs/s1.json', select: ['val.acc'], seed: 1 }), /already logged/);
  assert.throws(() => logMetrics(store, project, 'EXP-0001', { from: 'runs/s1.json', select: ['val.f1'] }), /not found/);
  assert.throws(() => logMetrics(store, project, 'EXP-0001', { from: null }), /only read from files/);
  const e = getExperiment(store, 'EXP-0001');
  assert.equal(e.runs[0].source.path, 'runs/s1.json');
  assert.match(e.runs[0].source.sha256, /^[0-9a-f]{16}$/);
  assert.throws(() => finishExperiment(store, 'EXP-0001', { status: 'running' }), /--status/);
  finishExperiment(store, 'EXP-0001', { status: 'completed' });
  assert.throws(() => logMetrics(store, project, 'EXP-0001', { from: 'runs/s2.jsonl' }), /is completed/);
  startExperiment(store, project, { title: 'empty' }, { env });
  assert.throws(() => finishExperiment(store, 'EXP-0002', { status: 'completed' }), /no logged metrics/);
  const cli = brain(['exp', 'log', 'EXP-0002', '--value', '0.99'], { cwd: project.root });
  assert.equal(cli.code, 1);
  assert.match(cli.err, /only read from files/);
});

test('Welch t-test p-values match reference values', () => {
  assert.ok(Math.abs(tTestPValue(2, 10) - 0.0734) < 1e-3);
  assert.ok(Math.abs(tTestPValue(2.228, 10) - 0.05) < 1e-3);
  assert.ok(Math.abs(tTestPValue(1, 1) - 0.5) < 1e-6);
  const w = welch([0.8, 0.81, 0.79], [0.85, 0.86, 0.84]);
  assert.ok(Math.abs(w.p - 0.0036) < 2e-4);
  assert.ok(Math.abs(w.df - 4) < 1e-9);
});

function runExp(ctx, title, values, { data = 'train=data/train.csv', split = 's42', baseline = null, metric = 'acc' } = {}) {
  const e = startExperiment(ctx.store, ctx.project, { title, data: [data], split, baseline }, { env });
  values.forEach((v, i) => {
    ctx.w(`runs/${e.id}-${i}.json`, JSON.stringify({ [metric]: v }));
    logMetrics(ctx.store, ctx.project, e.id, { from: `runs/${e.id}-${i}.json`, seed: i + 1 });
  });
  finishExperiment(ctx.store, e.id, { status: 'completed' });
  return e.id;
}

test('honest comparisons: improved, no clear difference, insufficient seeds, not comparable', () => {
  const c = expProject();
  const base = runExp(c, 'base', [0.8, 0.81, 0.79]);
  const better = runExp(c, 'better', [0.85, 0.86, 0.84], { baseline: base });
  const noise = runExp(c, 'noise', [0.79, 0.82, 0.8], { baseline: base });
  const single = runExp(c, 'single', [0.9], { baseline: base });
  const otherData = runExp(c, 'other data', [0.9, 0.91, 0.92], { data: 'train=data/train_v2.csv', baseline: base });
  const otherSplit = runExp(c, 'other split', [0.9, 0.91, 0.92], { split: 's7', baseline: base });
  const g = (id) => getExperiment(c.store, id);
  assert.equal(compareExperiments(g(base), g(better), 'acc').verdict, 'improved');
  assert.equal(compareExperiments(g(base), g(better), 'acc', { higherIsBetter: false }).verdict, 'worse');
  assert.equal(compareExperiments(g(base), g(noise), 'acc').verdict, 'no-clear-difference');
  assert.equal(compareExperiments(g(base), g(single), 'acc').verdict, 'insufficient-seeds');
  assert.match(compareExperiments(g(base), g(otherData), 'acc').reasons[0], /different data fingerprints/);
  assert.match(compareExperiments(g(base), g(otherSplit), 'acc').reasons[0], /different splits/);
  assert.equal(compareExperiments(g(base), g(better), 'f1').verdict, 'not-comparable');
  recordComparison(c.store, base, better, 'acc');
  assert.equal(g(better).comparisons[0].verdict, 'improved');
});

test('audit catches unsupported improvement claims, hand-edited metrics, missing sources and stale running experiments', () => {
  const c = expProject();
  const base = runExp(c, 'base', [0.8, 0.81, 0.79]);
  const e = startExperiment(c.store, c.project, { title: 'claim', baseline: base, data: ['train=data/train.csv'], split: 's42' }, { env });
  for (let i = 0; i < 3; i++) {
    c.w(`runs/c${i}.json`, JSON.stringify({ acc: 0.8 + i * 0.001 }));
    logMetrics(c.store, c.project, e.id, { from: `runs/c${i}.json`, seed: i + 1 });
  }
  finishExperiment(c.store, e.id, { status: 'completed', conclusion: 'This clearly improves accuracy.' });
  let w = auditExperiments(c.store, new Date(), c.dir);
  assert.ok(w.some((x) => x.includes(`${e.id} conclusion claims an improvement`)));
  const f = path.join(c.store.p('experiments'), `${e.id}.yaml`);
  fs.writeFileSync(f, read(f).replace('acc: 0.801', 'acc: 0.951'));
  fs.rmSync(path.join(c.dir, 'runs/c2.json'));
  w = auditExperiments(c.store, new Date(), c.dir);
  assert.ok(w.some((x) => /do not match runs\/c1\.json/.test(x)), w.join('\n'));
  assert.ok(w.some((x) => /runs\/c2\.json is missing/.test(x)));
  startExperiment(c.store, c.project, { title: 'forgotten' }, { env });
  assert.ok(auditExperiments(c.store, new Date(Date.now() + 8 * 86_400_000), c.dir).some((x) => /running" for more than 7 days/.test(x)));
});

test('experiments appear in the session context and the search index; CLI round trip works', () => {
  const c = expProject();
  runExp(c, 'baseline resnet', [0.8, 0.81, 0.79]);
  const ctx = buildContext({ store: c.store, project: resolveProject(c.dir), config: structuredClone(DEFAULT_CONFIG), cli: 'brain' });
  assert.match(ctx.text, /## Experiments \(1; latest 1\)\n- EXP-0001 \[completed\] baseline resnet — acc 0\.8 \(n=3\)/);
  const s = brain(['search', 'resnet'], { cwd: c.dir });
  assert.match(s.out, /\[experiment\] EXP-0001/);
  assert.equal(brain(['exp', 'start', '--title', 'cli run', '--seed', '4', '--no-env-probe'], { cwd: c.dir }).code, 0);
  c.w('r.json', '{"acc": 0.7}');
  assert.equal(brain(['exp', 'log', 'EXP-0002', '--from', 'r.json', '--seed', '4'], { cwd: c.dir }).code, 0);
  assert.equal(brain(['exp', 'finish', 'EXP-0002', '--status', 'completed'], { cwd: c.dir }).code, 0);
  const cmp = brain(['exp', 'compare', 'EXP-0001', 'EXP-0002', '--metric', 'acc'], { cwd: c.dir });
  assert.match(cmp.out, /INSUFFICIENT-SEEDS|NOT-COMPARABLE/);
  assert.match(brain(['exp', 'list'], { cwd: c.dir }).out, /EXP-0002 \[completed\] cli run/);
});

test('eval check experiment_recorded counts runs logged through brain exp', () => {
  const c = expProject();
  runExp(c, 'a', [0.8, 0.81, 0.79]);
  const ctx = { transcript: { events: [] }, diff: { created: [], modified: [], deleted: [], all: [] }, workspace: c.dir };
  assert.equal(runCheck({ type: 'experiment_recorded', min_runs: 3 }, ctx).pass, true);
  assert.equal(runCheck({ type: 'experiment_recorded', min_runs: 3, min_experiments: 2 }, ctx).pass, false);
});

// --------------------------------------------------------------------------------------------------- helper scripts

const LEAK = path.join(REPO, 'skills', 'data', 'data-analysis', 'scripts', 'leakage_check.py');
const FMT = path.join(REPO, 'skills', 'science', 'bioinformatics-pipeline', 'scripts', 'check_formats.py');
const WS = path.join(REPO, 'evals', 'workspaces');

test('leakage_check.py finds duplicates, id overlap and target copies; clean data passes', { skip: !hasPython && 'python3 not available' }, () => {
  const r = spawnSync('python3', [LEAK, path.join(WS, 'data-leak/data/train.csv'), path.join(WS, 'data-leak/data/test.csv'), '--id', 'patient_id', '--target', 'label', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  const checks = JSON.parse(r.stdout).findings.map((f) => f.check);
  for (const c of ['duplicate-rows', 'id-overlap', 'target-copy']) assert.ok(checks.includes(c), c);
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'tr.csv'), 'id,x,y\n1,0.1,0\n2,0.7,1\n3,0.2,0\n4,0.9,1\n');
  fs.writeFileSync(path.join(d, 'te.csv'), 'id,x,y\n5,0.3,0\n6,0.8,1\n');
  const clean = spawnSync('python3', [LEAK, path.join(d, 'tr.csv'), path.join(d, 'te.csv'), '--id', 'id', '--target', 'y'], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /not proof of absence/);
});

test('check_formats.py flags FASTQ length mismatch, VCF build headers and mixed builds', { skip: !hasPython && 'python3 not available' }, () => {
  const r = spawnSync('python3', [FMT, path.join(WS, 'bio-pipeline/data/sample_R1.fastq'), path.join(WS, 'bio-pipeline/known/dbsnp_hg19_chr20.vcf'), '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  const fq = Object.entries(out).find(([k]) => k.endsWith('.fastq'))[1];
  assert.match(fq.errors[0], /record 2: sequence length 12 != quality length 10/);
  const vcf = Object.entries(out).find(([k]) => k.endsWith('.vcf'))[1];
  assert.deepEqual(vcf.reference_builds_in_header, ['hg19']);
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'mixed.vcf'), '##fileformat=VCFv4.2\n##reference=GRCh38\n##source=liftover from hg19\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n');
  const m = spawnSync('python3', [FMT, path.join(d, 'mixed.vcf')], { encoding: 'utf8' });
  assert.equal(m.status, 1);
  assert.match(m.stdout, /more than one build/);
});
