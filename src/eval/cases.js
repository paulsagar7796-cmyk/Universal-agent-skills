// Loads the behavioural evaluation cases from skills/*/evals/cases.yaml (the existing schema) plus optional
// harness fields: workspace, requires, environment, checks. Nothing here invents pass criteria: every
// expect.must / expect.must_not item becomes a criterion; checks only *link* to criteria.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../yaml.js';
import { loadSkills, REPO_ROOT } from '../catalog.js';
import { readTextIfExists } from '../util.js';

export const EVAL_CONFIG_FILE = path.join(REPO_ROOT, 'evals', 'config.yaml');
export const WORKSPACES_DIR = path.join(REPO_ROOT, 'evals', 'workspaces');

export const CHECK_TYPES = {
  response_matches: ['pattern'],
  response_not_matches: ['pattern'],
  tool_called: ['tool'],
  tool_not_called: ['tool'],
  command_ran: ['pattern'],
  command_not_ran: ['pattern'],
  file_changed: ['path'],
  file_unchanged: ['path'],
  no_file_changes: [],
  skill_loaded: ['skill'],
  brain_proposal_created: [],
  brain_fact_matches: ['pattern'],
  tool_order: ['before', 'after'],
  file_matches: ['path', 'pattern'],
  skill_created: [],
};

export function loadEvalConfig() {
  const text = readTextIfExists(EVAL_CONFIG_FILE);
  const cfg = text ? parse(text) : {};
  return { workspace_defaults: cfg?.workspace_defaults ?? {}, brain_workspaces: cfg?.brain_skills ?? [] };
}

function criterionRef(ref) {
  const m = String(ref ?? '').match(/^(must|must_not)\[(\d+)\]$/);
  return m ? { list: m[1], index: Number(m[2]) } : null;
}

/** Normalise one case; returns { case, problems } (problems are reported, never silently fixed). */
export function normaliseCase(raw, skill, cfg = loadEvalConfig()) {
  const problems = [];
  const must = Array.isArray(raw?.expect?.must) ? raw.expect.must : [];
  const mustNot = Array.isArray(raw?.expect?.must_not) ? raw.expect.must_not : [];
  const criteria = [...must.map((text, i) => ({ id: `must[${i}]`, list: 'must', text })), ...mustNot.map((text, i) => ({ id: `must_not[${i}]`, list: 'must_not', text }))];
  const checks = [];
  for (const [i, c] of (raw?.checks ?? []).entries()) {
    if (!c || !CHECK_TYPES[c.type]) {
      problems.push(`checks[${i}]: unknown check type ${JSON.stringify(c?.type)}`);
      continue;
    }
    for (const field of CHECK_TYPES[c.type]) if (c[field] === undefined) problems.push(`checks[${i}] (${c.type}): missing "${field}"`);
    if (c.criterion !== undefined) {
      const ref = criterionRef(c.criterion);
      if (!ref || !criteria.some((x) => x.id === c.criterion)) problems.push(`checks[${i}]: criterion ${JSON.stringify(c.criterion)} does not match an expect item`);
    }
    for (const k of ['pattern', 'tool', 'path']) {
      if (typeof c[k] === 'string') {
        try {
          new RegExp(c[k]);
        } catch (e) {
          problems.push(`checks[${i}]: invalid regex in ${k}: ${e.message}`);
        }
      }
    }
    checks.push({ ...c, index: i });
  }
  const explicitWs = typeof raw?.workspace === 'string' ? raw.workspace : null;
  const workspace = explicitWs ?? cfg.workspace_defaults[skill.name] ?? 'empty';
  if (!fs.existsSync(path.join(WORKSPACES_DIR, workspace))) problems.push(`workspace "${workspace}" does not exist under evals/workspaces/`);
  const fixtureNote = raw?.fixture && !explicitWs ? 'fixture is described in prose only; the default workspace may not reproduce it' : null;
  return {
    case: {
      id: raw?.id,
      skill: skill.name,
      kind: raw?.kind,
      routing: raw?.routing === true,
      prompt: raw?.prompt,
      fixture: raw?.fixture ?? null,
      fixtureNote,
      workspace,
      brain: cfg.brain_workspaces.includes(skill.name) || raw?.brain === true,
      requires: Array.isArray(raw?.requires) ? raw.requires : [],
      environment: { deny: Array.isArray(raw?.environment?.deny) ? raw.environment.deny : [] },
      criteria,
      checks,
    },
    problems,
  };
}

/** All cases, optionally filtered. Returns { cases, problems } where problems are per-case schema issues. */
export function loadCases({ skills = null, ids = null, kinds = null } = {}) {
  const cfg = loadEvalConfig();
  const cases = [];
  const problems = [];
  for (const s of loadSkills()) {
    if (skills && !skills.includes(s.name)) continue;
    for (const raw of s.evals?.cases ?? []) {
      if (ids && !ids.includes(raw.id)) continue;
      if (kinds && !kinds.includes(raw.kind)) continue;
      const { case: c, problems: p } = normaliseCase(raw, s, cfg);
      cases.push(c);
      for (const x of p) problems.push(`${c.id}: ${x}`);
    }
  }
  if (ids) for (const id of ids) if (!cases.some((c) => c.id === id)) problems.push(`${id}: no such case`);
  return { cases, problems };
}

/** Coverage of criteria by structured checks (each criterion counts once). */
export function coverage(cases) {
  let criteria = 0;
  let structured = 0;
  for (const c of cases) {
    criteria += c.criteria.length;
    const linked = new Set(c.checks.filter((k) => k.criterion).map((k) => k.criterion));
    structured += c.criteria.filter((x) => linked.has(x.id)).length;
  }
  return { cases: cases.length, criteria, structured, unstructured: criteria - structured };
}
