import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseFrontmatter } from './yaml.js';
import { readTextIfExists } from './util.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = path.join(REPO_ROOT, 'skills');
export const CATALOG_FILE = path.join(REPO_ROOT, 'catalog', 'skills.json');
export const CAPABILITY_REGISTRY_FILE = path.join(REPO_ROOT, 'integrations', 'capabilities.yaml');

/** Find skill directories: skills/<category>/<name>/SKILL.md (and skills/<name>/SKILL.md for flat layouts). */
export function findSkillDirs(skillsDir = SKILLS_DIR) {
  const out = [];
  if (!fs.existsSync(skillsDir)) return out;
  for (const a of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!a.isDirectory() || a.name.startsWith('.')) continue;
    const aPath = path.join(skillsDir, a.name);
    if (fs.existsSync(path.join(aPath, 'SKILL.md'))) {
      out.push({ dir: aPath, category: null });
      continue;
    }
    for (const b of fs.readdirSync(aPath, { withFileTypes: true })) {
      if (b.isDirectory() && fs.existsSync(path.join(aPath, b.name, 'SKILL.md'))) out.push({ dir: path.join(aPath, b.name), category: a.name });
    }
  }
  return out.sort((x, y) => x.dir.localeCompare(y.dir));
}

/** Load one skill directory: frontmatter, body, manifest and eval cases (parse errors are collected, not thrown). */
export function loadSkill(dir, category = null) {
  const errors = [];
  const skillText = readTextIfExists(path.join(dir, 'SKILL.md'));
  const fm = parseFrontmatter(skillText ?? '');
  if (fm.error) errors.push(`SKILL.md: ${fm.error}`);
  let manifest = null;
  const mText = readTextIfExists(path.join(dir, 'manifest.yaml'));
  if (mText !== null) {
    try {
      manifest = parse(mText);
    } catch (e) {
      errors.push(`manifest.yaml: ${e.message}`);
    }
  }
  let evals = null;
  const eText = readTextIfExists(path.join(dir, 'evals', 'cases.yaml'));
  if (eText !== null) {
    try {
      evals = parse(eText);
    } catch (e) {
      errors.push(`evals/cases.yaml: ${e.message}`);
    }
  }
  return {
    name: fm.data?.name ?? path.basename(dir),
    folder: path.basename(dir),
    dir,
    relDir: path.relative(REPO_ROOT, dir).split(path.sep).join('/'),
    category,
    frontmatter: fm.data,
    body: fm.body,
    bodyStartLine: fm.bodyStartLine ?? 1,
    skillText,
    manifest,
    evals,
    errors,
  };
}

export function loadSkills(skillsDir = SKILLS_DIR) {
  return findSkillDirs(skillsDir).map(({ dir, category }) => loadSkill(dir, category));
}

export function loadCapabilityRegistry(file = CAPABILITY_REGISTRY_FILE) {
  const text = readTextIfExists(file);
  if (text === null) return { schema_version: 1, capabilities: {}, privileged_actions: [] };
  return parse(text);
}

/** Runtime catalog: prefer the generated catalog/skills.json (fast), fall back to scanning skill folders. */
export function loadRuntimeCatalog() {
  const text = readTextIfExists(CATALOG_FILE);
  if (text !== null) {
    try {
      const c = JSON.parse(text);
      if (Array.isArray(c.skills)) return c.skills.map((s) => ({ ...s, absPath: path.join(REPO_ROOT, s.path) }));
    } catch {
      /* fall through to scan */
    }
  }
  return loadSkills().map((s) => ({
    id: s.name,
    description: s.frontmatter?.description ?? '',
    category: s.category,
    path: `${s.relDir}/SKILL.md`,
    absPath: path.join(s.dir, 'SKILL.md'),
    routing: s.manifest?.routing ?? {},
    capabilities: s.manifest?.capabilities ?? {},
    approvals: s.manifest?.approvals ?? [],
    risk: s.manifest?.risk ?? 'unknown',
  }));
}
