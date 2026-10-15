// Skill validator: Agent Skills spec rules (checked 2026-10-15) + this repository's manifest/eval policy.
import fs from 'node:fs';
import path from 'node:path';
import { loadCapabilityRegistry, loadSkills, SKILLS_DIR } from './catalog.js';

const FM_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const MATURITY = ['draft', 'community', 'reviewed', 'verified', 'deprecated'];
const RISK = ['low', 'medium', 'high'];
const ORIGINS = ['first-party', 'imported', 'adapted'];
const INTENTS = ['build', 'debug', 'test', 'research', 'business', 'docs', 'review', 'plan', 'brain', 'skills', 'ml', 'data', 'science'];
const LOCAL_PERMS = ['filesystem.read', 'filesystem.write', 'shell.read-only', 'shell.exec', 'git.read', 'git.write'];
const CASE_KINDS = ['typical', 'edge', 'ambiguous', 'unsupported-claim', 'untrusted-input'];
const MAX_SKILL_MD_BYTES = 50 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;

/** Agent Skills name rule: 1–64 chars, [a-z0-9-], no leading/trailing hyphen, no "--". */
export function checkName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) return 'name must be 1-64 characters';
  if (!/^[a-z0-9-]+$/.test(name)) return 'name may only contain lowercase letters, digits and hyphens';
  if (name.startsWith('-') || name.endsWith('-')) return 'name must not start or end with a hyphen';
  if (name.includes('--')) return 'name must not contain consecutive hyphens';
  return null;
}

function localLinks(markdown) {
  const links = [];
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '');
  while ((m = re.exec(withoutCode))) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    links.push(target.split('#')[0]);
  }
  return links;
}

function walkFiles(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walkFiles(dir, r));
    else out.push(r);
  }
  return out;
}

/** Validate one loaded skill. Returns { errors: string[], warnings: string[] }. */
export function validateSkill(skill, { registry = loadCapabilityRegistry(), allNames = new Set() } = {}) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(`${skill.relDir}: ${m}`);
  const W = (m) => warnings.push(`${skill.relDir}: ${m}`);
  errors.push(...skill.errors.map((e) => `${skill.relDir}: ${e}`));
  const fm = skill.frontmatter;
  if (fm) {
    for (const k of Object.keys(fm)) if (!FM_KEYS.has(k)) E(`frontmatter field "${k}" is not defined by the Agent Skills spec (put extra data under metadata or in manifest.yaml)`);
    const nameErr = checkName(fm.name);
    if (nameErr) E(nameErr);
    if (fm.name !== skill.folder) E(`name "${fm.name}" must match the folder name "${skill.folder}"`);
    if (typeof fm.description !== 'string' || fm.description.trim().length === 0) E('description is required');
    else {
      if (fm.description.length > 1024) E(`description is ${fm.description.length} characters (max 1024)`);
      if (!/\buse (when|for|before|whenever)\b/i.test(fm.description)) W('description should say when to use the skill ("Use when …")');
    }
    if (fm.compatibility !== undefined && (typeof fm.compatibility !== 'string' || fm.compatibility.length < 1 || fm.compatibility.length > 500)) E('compatibility must be a 1-500 character string');
    if (fm['allowed-tools'] !== undefined && typeof fm['allowed-tools'] !== 'string') E('allowed-tools must be a space-separated string');
    if (typeof fm.license !== 'string' || !fm.license.trim()) E('license is required by this repository policy');
    const md = fm.metadata;
    if (md === undefined || md === null || typeof md !== 'object' || Array.isArray(md)) E('metadata mapping is required by this repository policy (version, category, maturity, risk)');
    else {
      for (const [k, v] of Object.entries(md)) if (typeof v !== 'string') E(`metadata.${k} must be a string (spec: string→string map); quote it`);
      if (!/^\d+\.\d+\.\d+$/.test(String(md.version ?? ''))) E('metadata.version must be a semantic version string like "0.1.0"');
      if (skill.category && md.category !== skill.category) E(`metadata.category "${md.category}" must match the category folder "${skill.category}"`);
      if (!MATURITY.includes(md.maturity)) E(`metadata.maturity must be one of ${MATURITY.join('/')}`);
      if (!RISK.includes(md.risk)) E(`metadata.risk must be one of ${RISK.join('/')}`);
    }
  }
  const text = skill.skillText ?? '';
  if (Buffer.byteLength(text) > MAX_SKILL_MD_BYTES) E(`SKILL.md is larger than ${MAX_SKILL_MD_BYTES / 1024} KB`);
  const bodyLines = (skill.body ?? '').split('\n').length;
  if (bodyLines > 500) E(`SKILL.md body has ${bodyLines} lines (spec recommends < 500; move detail to references/)`);
  if ((skill.body ?? '').length / 4 > 5000) W(`SKILL.md body is roughly ${Math.round(skill.body.length / 4)} tokens (spec recommends < 5000)`);

  // Local references must exist inside the skill and stay one level deep.
  const files = walkFiles(skill.dir);
  for (const f of files) {
    const st = fs.statSync(path.join(skill.dir, f));
    if (st.size > MAX_FILE_BYTES) E(`${f} is larger than 1 MB`);
    if (!f.endsWith('.md')) continue;
    for (const link of localLinks(fs.readFileSync(path.join(skill.dir, f), 'utf8'))) {
      const target = path.normalize(path.join(path.dirname(path.join(skill.dir, f)), link));
      if (!target.startsWith(skill.dir + path.sep) && target !== skill.dir) E(`${f} links outside the skill folder: ${link}`);
      else if (!fs.existsSync(target)) E(`${f} has a broken link: ${link}`);
      if (f === 'SKILL.md' && link.split('/').filter(Boolean).length > 2) W(`SKILL.md reference ${link} is more than one level deep`);
    }
  }

  // manifest.yaml
  const m = skill.manifest;
  if (!m) E('manifest.yaml is required (provenance, routing, capabilities)');
  else {
    if (m.schema_version !== 1) E('manifest.yaml schema_version must be 1');
    if (m.id !== fm?.name) E(`manifest id "${m.id}" must equal the skill name`);
    if (!m.owner) E('manifest owner is required');
    for (const k of ['version', 'maturity', 'risk', 'category']) if (m[k] !== undefined) E(`manifest must not duplicate frontmatter metadata.${k}`);
    const p = m.provenance ?? {};
    if (!ORIGINS.includes(p.origin)) E(`provenance.origin must be one of ${ORIGINS.join('/')}`);
    if (!Array.isArray(p.authors) || !p.authors.length) E('provenance.authors is required');
    if (p.origin !== 'first-party') for (const k of ['url', 'revision', 'license', 'reviewed_at']) if (!p.upstream?.[k]) E(`provenance.upstream.${k} is required for ${p.origin} skills`);
    const r = m.routing ?? {};
    if (!Array.isArray(r.triggers) || !r.triggers.length) E('routing.triggers must list phrases that should select this skill');
    else for (const t of r.triggers) if (typeof t !== 'string' || !t.trim()) E(`routing trigger ${JSON.stringify(t)} must be a non-empty string`);
    for (const i of r.intents ?? []) if (!INTENTS.includes(i)) E(`unknown routing intent "${i}" (known: ${INTENTS.join(', ')})`);
    for (const pw of r.pairs_with ?? []) if (allNames.size && !allNames.has(pw)) E(`routing.pairs_with references unknown skill "${pw}"`);
    for (const lp of m.local_permissions ?? []) if (!LOCAL_PERMS.includes(lp)) E(`unknown local permission "${lp}" (known: ${LOCAL_PERMS.join(', ')})`);
    const caps = m.capabilities ?? {};
    for (const imp of ['required', 'optional']) {
      for (const c of caps[imp] ?? []) {
        const def = registry.capabilities?.[c.id];
        if (!def) {
          E(`capability "${c.id}" is not in integrations/capabilities.yaml`);
          continue;
        }
        if (!def.access_levels.includes(c.access)) E(`capability ${c.id} access "${c.access}" not allowed (registry: ${def.access_levels.join('/')})`);
        if (!c.purpose) E(`capability ${c.id} needs a purpose`);
        for (const k of Object.keys(c)) if (!['id', 'access', 'purpose', 'fallback'].includes(k)) E(`capability ${c.id} has unsupported field "${k}" (a manifest can declare needs, never grant itself consent)`);
        if (!c.fallback) (imp === 'optional' ? E : W)(`capability ${c.id} has no fallback`);
      }
    }
    for (const a of m.approvals ?? []) if (!(registry.privileged_actions ?? []).includes(a.action)) E(`approval action "${a.action}" is not a registered privileged action`);
    for (const ex of m.security?.scan_exceptions ?? []) if (!ex.rule || !ex.file || !ex.reason) E('each security.scan_exceptions entry needs rule, file and reason');
  }

  // evals/cases.yaml
  const ev = skill.evals;
  if (!ev) E('evals/cases.yaml is required');
  else {
    if (ev.skill !== fm?.name) E(`evals skill "${ev.skill}" must equal the skill name`);
    const cases = Array.isArray(ev.cases) ? ev.cases : [];
    if (cases.length < 3) E('at least 3 eval cases are required');
    const kinds = new Set(cases.map((c) => c.kind));
    for (const c of cases) {
      if (!CASE_KINDS.includes(c.kind)) E(`case ${c.id}: kind must be one of ${CASE_KINDS.join('/')}`);
      if (!c.id || !c.prompt) E(`case ${c.id ?? '?'}: id and prompt are required`);
      if (!Array.isArray(c.expect?.must) || !c.expect.must.length) E(`case ${c.id}: expect.must needs at least one observable behaviour`);
    }
    if (!kinds.has('typical')) E('evals need at least one typical case');
    if (!kinds.has('edge') && !kinds.has('ambiguous')) E('evals need at least one edge or ambiguous case');
    if (!kinds.has('unsupported-claim') && !kinds.has('untrusted-input')) E('evals need at least one unsupported-claim or untrusted-input case');
    if (!cases.some((c) => c.routing === true)) W('no routing cases (routing: true) — the router cannot be regression-tested for this skill');
  }
  return { errors, warnings };
}

export function validateAll(skillsDir = SKILLS_DIR) {
  const skills = loadSkills(skillsDir);
  const registry = loadCapabilityRegistry();
  const names = new Set();
  const errors = [];
  const warnings = [];
  for (const s of skills) {
    if (names.has(s.name)) errors.push(`${s.relDir}: duplicate skill name "${s.name}"`);
    names.add(s.name);
  }
  const caseIds = new Map();
  for (const s of skills) {
    const r = validateSkill(s, { registry, allNames: names });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    for (const c of s.evals?.cases ?? []) {
      if (caseIds.has(c.id)) errors.push(`${s.relDir}: eval case id "${c.id}" also used in ${caseIds.get(c.id)}`);
      caseIds.set(c.id, s.relDir);
    }
  }
  return { skills, errors, warnings };
}
