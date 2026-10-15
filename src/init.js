// Evidence-first project initializer. Reads known manifest/config files and read-only git state; runs no project
// commands (no installs, builds, tests or scripts). Every generated fact carries a file locator and content hash.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from './yaml.js';
import { fileEvidence, nextFactId } from './facts.js';
import { replaceGenerated } from './store.js';
import { git, today, truncate, writeFileAtomic } from './util.js';

const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'coverage', '.agent-brain', '.idea', '.vscode', '.dart_tool', 'Pods', '.gradle', '.terraform']);
const SENSITIVE = /(^\.env($|\.)|\.pem$|\.key$|^id_[a-z0-9]+$|credentials|secret|\.npmrc$|\.pypirc$|\.netrc$|\.p12$|\.keystore$)/i;
const MAX_READ = 512 * 1024;

const JS_FRAMEWORKS = {
  react: 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', '@angular/core': 'Angular',
  express: 'Express', fastify: 'Fastify', '@nestjs/core': 'NestJS', koa: 'Koa', hono: 'Hono', electron: 'Electron', 'react-native': 'React Native',
  vite: 'Vite', vitest: 'Vitest', jest: 'Jest', mocha: 'Mocha', '@playwright/test': 'Playwright', cypress: 'Cypress', typescript: 'TypeScript',
  prisma: 'Prisma', '@prisma/client': 'Prisma', 'drizzle-orm': 'Drizzle ORM', mongoose: 'Mongoose', pg: 'node-postgres', '@supabase/supabase-js': 'Supabase client', tailwindcss: 'Tailwind CSS', eslint: 'ESLint',
};
const PY_FRAMEWORKS = { django: 'Django', fastapi: 'FastAPI', flask: 'Flask', pytest: 'pytest', pandas: 'pandas', numpy: 'NumPy', torch: 'PyTorch', tensorflow: 'TensorFlow', 'scikit-learn': 'scikit-learn', sqlalchemy: 'SQLAlchemy', pydantic: 'Pydantic', jupyter: 'Jupyter' };

function safeRead(root, rel) {
  if (SENSITIVE.test(path.basename(rel))) return null;
  try {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_READ) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function topLevel(root) {
  const dirs = [];
  const files = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === '.agent-brain') continue;
    if (ent.isDirectory()) dirs.push(ent.name);
    else if (ent.isFile()) files.push(ent.name);
  }
  return { dirs: dirs.sort(), files: files.sort() };
}

/** Count files by extension (bounded walk, ignoring dependency/build dirs). */
function census(root, { maxFiles = 20000, maxDepth = 6 } = {}) {
  const ext = {};
  let total = 0;
  const manifests = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || total >= maxFiles) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (total >= maxFiles) return;
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name) && !ent.name.startsWith('.')) walk(path.join(dir, ent.name), depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      total++;
      const e = path.extname(ent.name).toLowerCase() || ent.name;
      ext[e] = (ext[e] ?? 0) + 1;
      if (depth > 0 && depth <= 3 && ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pubspec.yaml'].includes(ent.name)) manifests.push(path.relative(root, path.join(dir, ent.name)).split(path.sep).join('/'));
    }
  };
  walk(root, 0);
  return { ext, total, capped: total >= maxFiles, nestedManifests: manifests.sort() };
}

/** Very small TOML key reader for well-known keys (e.g. [project] name). Returns null when not found. */
function tomlValue(text, table, key) {
  let inTable = table === null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    const h = t.match(/^\[([^\]]+)\]$/);
    if (h) {
      inTable = h[1].trim() === table;
      continue;
    }
    if (!inTable) continue;
    const m = t.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*"([^"]*)"`));
    if (m) return m[1];
  }
  return null;
}

/**
 * Scan the project and return detected facts (without ids) plus a summary.
 * Each item: { key, category, claim, status, evidence: [file evidence], expires_after_days? }
 */
export function scanProject(project, { now = new Date() } = {}) {
  const root = project.root;
  const date = today(now);
  const found = [];
  const notes = { commandsNotRun: [], unknowns: [], types: new Set(), readme: null, license: null, layout: null };
  const ev = (rel, locator) => fileEvidence(root, rel, locator, date);
  const add = (key, category, claim, rel, locator, extra = {}) => found.push({ key, category, claim, status: 'observed', evidence: [ev(rel, locator)], ...extra });

  const { dirs, files } = topLevel(root);
  const has = (f) => files.includes(f);
  notes.layout = { dirs, files };

  if (project.isRepo) {
    const top = git(root, ['rev-parse', '--show-toplevel']);
    if (top) found.push({ key: 'repo.vcs', category: 'repository', claim: 'The project is a git repository.', status: 'verified', evidence: [{ kind: 'command', command: 'git rev-parse --show-toplevel', exit_code: 0, checked_at: date }] });
  }

  // README
  const readmeName = files.find((f) => /^readme(\.md|\.markdown|\.rst|\.txt)?$/i.test(f));
  if (readmeName) {
    const text = safeRead(root, readmeName) ?? '';
    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const para = text
      .replace(/^#.*$/gm, '')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('[!') && !p.startsWith('<') && !p.startsWith('![') && !p.startsWith('```') && p.length > 30);
    notes.readme = { file: readmeName, title: title ?? null, summary: para ? truncate(para.replace(/\s+/g, ' '), 400) : null };
    add('docs.readme', 'documentation', `A README exists (${readmeName})${title ? ` titled "${truncate(title, 80)}"` : ''}.`, readmeName, title ? 'first heading' : undefined);
  } else notes.unknowns.push({ key: 'docs.readme', question: 'There is no README; what is this project for and how is it run?' });

  // Agent instructions
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules']) {
    if (has(f)) add(`instructions.${f.toLowerCase()}`, 'instructions', `Agent instruction file ${f} exists; read it before changing code.`, f);
  }

  // License
  const licenseName = files.find((f) => /^(licen[sc]e|copying)(\.md|\.txt)?$/i.test(f));
  if (licenseName) {
    const head = (safeRead(root, licenseName) ?? '').slice(0, 400);
    const kind = /MIT License/i.test(head) ? 'MIT' : /Apache License/i.test(head) ? 'Apache-2.0' : /GNU GENERAL PUBLIC LICENSE/i.test(head) ? 'GPL' : /Mozilla Public License/i.test(head) ? 'MPL-2.0' : /BSD/i.test(head) ? 'BSD' : null;
    notes.license = kind;
    add('license', 'legal', kind ? `The repository license file (${licenseName}) appears to be ${kind} (header text match).` : `A license file exists (${licenseName}); type not recognised automatically.`, licenseName, 'header');
  }

  // Node / JavaScript
  if (has('package.json')) {
    notes.types.add('javascript/node');
    let pkg = null;
    try {
      pkg = JSON.parse(safeRead(root, 'package.json') ?? 'null');
    } catch {
      found.push({ key: 'node.package_json', category: 'stack', claim: 'package.json exists but is not valid JSON.', status: 'observed', evidence: [ev('package.json')] });
    }
    if (pkg) {
      add('node.package', 'stack', `Node.js package${pkg.name ? ` "${pkg.name}"` : ''} is defined in package.json${pkg.private ? ' (private)' : ''}.`, 'package.json', 'name');
      if (pkg.type === 'module') add('node.module_type', 'stack', 'package.json sets "type": "module" (ES modules).', 'package.json', 'type');
      if (pkg.engines?.node) add('node.engines', 'runtime', `package.json requires Node ${pkg.engines.node}.`, 'package.json', 'engines.node');
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const fw = Object.entries(JS_FRAMEWORKS).filter(([d]) => deps[d]).map(([d, label]) => `${label} (${d}@${deps[d]})`);
      if (fw.length) add('node.frameworks', 'stack', `Declared JS dependencies include: ${fw.join(', ')}.`, 'package.json', 'dependencies/devDependencies');
      if (pkg.workspaces) add('node.workspaces', 'structure', 'package.json declares workspaces (monorepo).', 'package.json', 'workspaces');
      for (const s of ['test', 'build', 'lint', 'typecheck', 'dev', 'start']) {
        if (pkg.scripts?.[s]) {
          add(`command.${s}`, 'commands', `package.json declares a "${s}" script: \`${truncate(pkg.scripts[s], 120)}\` (not run during init).`, 'package.json', `scripts.${s}`);
          if (['test', 'build', 'lint', 'typecheck'].includes(s)) notes.commandsNotRun.push(`npm run ${s}`);
        }
      }
      if (!pkg.scripts?.test) notes.unknowns.push({ key: 'command.test', question: 'No "test" script in package.json; how are tests run (if any)?' });
      for (const k of ['main', 'module', 'bin']) if (pkg[k]) add(`entry.${k}`, 'structure', `package.json "${k}" entry point: ${typeof pkg[k] === 'string' ? pkg[k] : Object.values(pkg[k]).join(', ')}.`, 'package.json', k);
    }
    const lock = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'Yarn'], ['package-lock.json', 'npm'], ['bun.lockb', 'Bun'], ['bun.lock', 'Bun']].filter(([f]) => has(f));
    if (lock.length === 1) add('tooling.package_manager', 'tooling', `The lockfile indicates ${lock[0][1]} is the package manager.`, lock[0][0]);
    else if (lock.length > 1) found.push({ key: 'tooling.package_manager', category: 'tooling', claim: `Multiple lockfiles are present (${lock.map((l) => l[0]).join(', ')}); the intended package manager is ambiguous.`, status: 'disputed', evidence: lock.map(([f]) => ev(f)) });
    else notes.unknowns.push({ key: 'tooling.package_manager', question: 'No JS lockfile found; which package manager and versions are intended?' });
    if (has('tsconfig.json')) add('stack.typescript_config', 'stack', 'tsconfig.json is present (TypeScript compiler configuration).', 'tsconfig.json');
  }

  // Python
  if (has('pyproject.toml')) {
    notes.types.add('python');
    const t = safeRead(root, 'pyproject.toml') ?? '';
    const name = tomlValue(t, 'project', 'name') ?? tomlValue(t, 'tool.poetry', 'name');
    add('python.project', 'stack', `Python project${name ? ` "${name}"` : ''} is configured in pyproject.toml.`, 'pyproject.toml', name ? '[project] name' : undefined);
    const rp = tomlValue(t, 'project', 'requires-python');
    if (rp) add('python.requires', 'runtime', `pyproject.toml requires Python ${rp}.`, 'pyproject.toml', '[project] requires-python');
    const fw = Object.entries(PY_FRAMEWORKS).filter(([d]) => new RegExp(`["'\\s]${d.replace('-', '[-_]')}([<>=~!\\[\\s"']|$)`, 'im').test(t)).map(([, l]) => l);
    if (fw.length) add('python.frameworks', 'stack', `pyproject.toml mentions: ${fw.join(', ')}.`, 'pyproject.toml', 'dependency lists (text match)');
    if (/\[tool\.pytest/.test(t)) add('command.pytest', 'commands', 'pytest is configured in pyproject.toml (not run during init).', 'pyproject.toml', '[tool.pytest...]');
    for (const [f, label] of [['uv.lock', 'uv'], ['poetry.lock', 'Poetry'], ['Pipfile.lock', 'Pipenv']]) if (has(f)) add('tooling.python_env', 'tooling', `${f} indicates ${label} manages Python dependencies.`, f);
  }
  if (has('requirements.txt')) {
    notes.types.add('python');
    const t = safeRead(root, 'requirements.txt') ?? '';
    const fw = Object.entries(PY_FRAMEWORKS).filter(([d]) => new RegExp(`^${d}([<>=~!\\[\\s]|$)`, 'im').test(t)).map(([, l]) => l);
    add('python.requirements', 'stack', `requirements.txt lists ${t.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length} requirement line(s)${fw.length ? `, including ${fw.join(', ')}` : ''}.`, 'requirements.txt');
  }

  // Other ecosystems
  const simple = [
    ['Cargo.toml', 'rust', (t) => `Rust crate${tomlValue(t, 'package', 'name') ? ` "${tomlValue(t, 'package', 'name')}"` : ''} is defined in Cargo.toml.`],
    ['go.mod', 'go', (t) => `Go module ${t.match(/^module\s+(\S+)/m)?.[1] ?? '(name not found)'} is defined in go.mod.`],
    ['pom.xml', 'java', () => 'Maven build (pom.xml) is present.'],
    ['build.gradle', 'java/kotlin', () => 'Gradle build (build.gradle) is present.'],
    ['build.gradle.kts', 'java/kotlin', () => 'Gradle Kotlin DSL build (build.gradle.kts) is present.'],
    ['Gemfile', 'ruby', () => 'Ruby dependencies are declared in a Gemfile.'],
    ['composer.json', 'php', () => 'PHP dependencies are declared in composer.json.'],
    ['Package.swift', 'swift', () => 'Swift package manifest (Package.swift) is present.'],
    ['CMakeLists.txt', 'c/c++', () => 'CMake build (CMakeLists.txt) is present.'],
    ['Makefile', null, (t) => {
      const targets = [...t.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)].map((m) => m[1]).filter((x) => !x.startsWith('.')).slice(0, 12);
      return `A Makefile defines targets: ${targets.join(', ') || '(none parsed)'} (not run during init).`;
    }],
  ];
  for (const [f, type, claim] of simple) {
    if (!has(f)) continue;
    if (type) notes.types.add(type);
    add(`build.${f.toLowerCase()}`, type ? 'stack' : 'commands', claim(safeRead(root, f) ?? ''), f);
  }
  if (has('pubspec.yaml')) {
    notes.types.add('dart/flutter');
    let spec = null;
    try {
      spec = parse(safeRead(root, 'pubspec.yaml') ?? '');
    } catch {
      /* outside our YAML subset: still record presence */
    }
    const flutter = Boolean(spec?.dependencies?.flutter) || /^\s+flutter:\s*$/m.test(safeRead(root, 'pubspec.yaml') ?? '');
    add('dart.pubspec', 'stack', `Dart${flutter ? '/Flutter' : ''} package${spec?.name ? ` "${spec.name}"` : ''} is defined in pubspec.yaml.`, 'pubspec.yaml', 'name');
  }

  // Containers and infrastructure
  if (has('Dockerfile')) {
    const t = safeRead(root, 'Dockerfile') ?? '';
    const from = [...t.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]);
    add('container.dockerfile', 'deployment', `A Dockerfile builds from ${from.join(', ') || '(no FROM found)'}.`, 'Dockerfile', 'FROM');
  }
  const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find(has);
  if (compose) {
    const t = safeRead(root, compose) ?? '';
    const images = [...t.matchAll(/^\s+image:\s*["']?([^\s"']+)/gm)].map((m) => m[1]).slice(0, 10);
    add('container.compose', 'deployment', `${compose} defines services${images.length ? ` using images ${images.join(', ')}` : ''}.`, compose, 'services');
  }
  for (const d of ['terraform', 'infra', 'k8s', 'kubernetes', 'helm', 'deploy']) if (dirs.includes(d)) found.push({ key: `infra.${d}`, category: 'deployment', claim: `A top-level "${d}/" directory exists (infrastructure/deployment material likely; contents not analysed).`, status: 'observed', evidence: [{ kind: 'command', command: `directory read of ${d}/ by brain init (fs.readdir)`, exit_code: 0, checked_at: date }] });

  // CI
  const wfDir = path.join(root, '.github', 'workflows');
  if (fs.existsSync(wfDir)) {
    const wfs = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort();
    if (wfs.length) found.push({ key: 'ci.github_actions', category: 'ci', claim: `GitHub Actions workflows exist: ${wfs.join(', ')}.`, status: 'observed', evidence: wfs.slice(0, 5).map((f) => ev(`.github/workflows/${f}`)) });
  }
  if (has('.gitlab-ci.yml')) add('ci.gitlab', 'ci', 'GitLab CI is configured (.gitlab-ci.yml).', '.gitlab-ci.yml');
  if (!fs.existsSync(wfDir) && !has('.gitlab-ci.yml')) notes.unknowns.push({ key: 'ci', question: 'No CI configuration was found in the repository; is CI run elsewhere, or not at all?' });

  // Census → project type hints
  const c = census(root);
  const top = Object.entries(c.ext).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (c.ext['.ipynb']) notes.types.add('notebooks');
  if ((c.ext['.csv'] ?? 0) + (c.ext['.parquet'] ?? 0) > 5) notes.types.add('data');
  if (c.nestedManifests.length) found.push({ key: 'structure.nested_manifests', category: 'structure', claim: `Nested package manifests found (possible monorepo or sub-projects): ${c.nestedManifests.slice(0, 8).join(', ')}${c.nestedManifests.length > 8 ? ', …' : ''}.`, status: 'observed', evidence: c.nestedManifests.slice(0, 3).map((f) => ev(f)) });
  if (!notes.types.size) notes.types.add(c.total === 0 ? 'empty' : 'unclassified');

  notes.unknowns.push({ key: 'product.goal', question: notes.readme?.summary ? 'Is the README description an accurate statement of the product goal and target users?' : 'What is the product goal, who are the users, and what does "done" mean?' });
  notes.unknowns.push({ key: 'deployment.target', question: 'Where and how is this deployed or released (environments, approvals)?' });
  if (notes.commandsNotRun.length) notes.unknowns.push({ key: 'verification.baseline', question: `Do the declared checks pass on a clean checkout? Not run during init: ${notes.commandsNotRun.join(', ')}.` });

  notes.census = { totalFiles: c.total, capped: c.capped, topExtensions: top };
  return { found, notes: { ...notes, types: [...notes.types] } };
}

function layoutMarkdown(notes) {
  const { dirs, files } = notes.layout;
  const ext = notes.census.topExtensions.map(([e, n]) => `${e} ×${n}`).join(', ');
  return [
    '### Top-level layout (observed by `brain init`)',
    '',
    `- Directories: ${dirs.length ? dirs.map((d) => `\`${d}/\``).join(', ') : '_none_'}`,
    `- Files: ${files.length ? files.slice(0, 30).map((f) => `\`${f}\``).join(', ') : '_none_'}${files.length > 30 ? ', …' : ''}`,
    `- File census: ${notes.census.totalFiles}${notes.census.capped ? '+' : ''} files; most common: ${ext || '_n/a_'}`,
    `- Project type hints: ${notes.types.join(', ')}`,
    '',
    'Component responsibilities and data flow are **not** inferred automatically. Add them with evidence (file + symbol).',
  ].join('\n');
}

/**
 * Create or refresh the brain. Never overwrites human-written text: only fills template files that are missing,
 * appends new facts, and rewrites generated sections.
 * On refresh, a re-detected fact with the same key and same claim gets fresh evidence; a changed claim supersedes
 * the old one (repository files outrank old memory for current repository behaviour).
 */
export function initBrain(store, project, { now = new Date() } = {}) {
  const created = store.scaffold();
  const { found, notes } = scanProject(project, { now });
  const date = today(now);
  const summary = { created, added: [], refreshed: [], superseded: [], questions: [], notes };
  store.updateFacts((doc) => {
    doc.facts = doc.facts ?? [];
    const active = () => doc.facts.filter((f) => f.status !== 'deprecated');
    for (const item of found) {
      const existing = active().find((f) => f.key === item.key && f.source === 'init');
      if (existing && existing.claim === item.claim) {
        existing.evidence = item.evidence;
        existing.last_verified = date;
        if (existing.status !== 'disputed' || item.status === 'disputed') existing.status = item.status;
        summary.refreshed.push(existing.id);
        continue;
      }
      const id = nextFactId(doc.facts);
      const fact = { id, claim: item.claim, status: item.status, key: item.key, category: item.category, evidence: item.evidence, last_verified: date, expires_after_days: 180, source: 'init', created_at: date };
      if (existing) {
        existing.status = 'deprecated';
        existing.superseded_by = id;
        existing.confidence_note = `Re-scan on ${date} observed a different value.`;
        fact.supersedes = existing.id;
        summary.superseded.push(existing.id);
      }
      doc.facts.push(fact);
      summary.added.push(id);
    }
    for (const u of notes.unknowns) {
      if (active().some((f) => f.key === u.key && f.status === 'unknown')) continue;
      if (active().some((f) => f.key === u.key && ['verified', 'observed'].includes(f.status) && u.key !== 'product.goal')) continue;
      const id = nextFactId(doc.facts);
      doc.facts.push({ id, claim: `Unknown: ${u.question}`, status: 'unknown', key: u.key, category: 'open-question', question: u.question, source: 'init', created_at: date });
      summary.questions.push(id);
    }
  });

  const arch = store.read('architecture.md') ?? '# Architecture\n';
  writeFileAtomic(store.p('architecture.md'), replaceGenerated(arch, 'init-layout', layoutMarkdown(notes)));
  if (notes.readme?.summary) {
    const proj = store.read('project.md') ?? '# Project\n';
    writeFileAtomic(store.p('project.md'), replaceGenerated(proj, 'readme-summary', `## README description (observed, unconfirmed)\n\n> ${notes.readme.summary}\n\nSource: \`${notes.readme.file}\`. Confirm with the owner before treating this as the project goal.`));
  }
  store.regenerateViews();
  return summary;
}
