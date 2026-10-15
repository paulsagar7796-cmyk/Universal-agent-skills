#!/usr/bin/env node
// Offline evaluations that need no model:
//  1. Routing: every case marked `routing: true` must select its skill within the router's top results;
//     shared negative cases must not select the listed skills.
//  2. Inventory: counts behaviour cases per kind. Behaviour cases need an agent harness and are NOT run here.
// Writes evals/reports/routing-latest.json.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../src/yaml.js';
import { loadRuntimeCatalog, loadSkills, REPO_ROOT } from '../src/catalog.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { route } from '../src/router.js';

const catalog = loadRuntimeCatalog();
const opts = { maxSkills: DEFAULT_CONFIG.routing.max_skills, minScore: DEFAULT_CONFIG.routing.min_score };
const results = [];
for (const s of loadSkills()) {
  for (const c of s.evals?.cases ?? []) {
    if (c.routing !== true) continue;
    const r = route(c.prompt, catalog, opts);
    const ids = r.selected.map((x) => x.id);
    results.push({ case: c.id, expected: s.name, got: ids, pass: ids.includes(s.name), rank: ids.indexOf(s.name) + 1 || null });
  }
}
const sharedFile = path.join(REPO_ROOT, 'evals', 'shared-cases', 'routing.yaml');
const shared = fs.existsSync(sharedFile) ? parse(fs.readFileSync(sharedFile, 'utf8')).cases ?? [] : [];
for (const c of shared) {
  const ids = route(c.prompt, catalog, opts).selected.map((x) => x.id);
  let pass = true;
  if (c.expect_none) pass = ids.length === 0;
  if (c.expect_not) pass = pass && !c.expect_not.some((x) => ids.includes(x));
  if (c.expect_top) pass = pass && ids[0] === c.expect_top;
  results.push({ case: c.id, expected: c.expect_none ? '(none)' : c.expect_top ? `top=${c.expect_top}` : `not ${c.expect_not.join(',')}`, got: ids, pass });
}

const failures = results.filter((r) => !r.pass);
const top1 = results.filter((r) => r.rank === 1).length;
const positives = results.filter((r) => r.rank !== undefined).length;
for (const f of failures) console.log(`FAIL ${f.case}: expected ${f.expected}, got [${f.got.join(', ')}]`);

const inventory = {};
for (const s of loadSkills()) for (const c of s.evals?.cases ?? []) inventory[c.kind] = (inventory[c.kind] ?? 0) + 1;
const totalCases = Object.values(inventory).reduce((a, b) => a + b, 0);

const report = {
  generated_by: 'scripts/run-evals.js',
  node: process.versions.node,
  router: { max_skills: opts.maxSkills, min_score: opts.minScore },
  routing: { cases: results.length, passed: results.length - failures.length, failed: failures.length, top1_for_positive_cases: `${top1}/${positives}` },
  behaviour_cases: { written: totalCases, by_kind: inventory, run: 0, note: 'Behaviour cases require an agent harness and human/LLM grading; not run by this script.' },
  failures,
};
fs.mkdirSync(path.join(REPO_ROOT, 'evals', 'reports'), { recursive: true });
fs.writeFileSync(path.join(REPO_ROOT, 'evals', 'reports', 'routing-latest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`routing: ${report.routing.passed}/${results.length} passed (top-1 on positive cases: ${report.routing.top1_for_positive_cases}). behaviour cases written: ${totalCases}, run: 0.`);
process.exit(failures.length ? 1 : 0);
