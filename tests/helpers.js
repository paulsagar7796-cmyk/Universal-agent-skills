import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRAIN_JS = path.join(REPO, 'bin', 'brain.js');

export function tmpDir(prefix = 'asb-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Create a git repository with the given files ({ relPath: content }) and one commit. */
export function makeRepo(files = {}, { commit = true } = {}) {
  const dir = tmpDir('asb-repo-');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  g('init', '-q', '-b', 'main');
  if (commit && Object.keys(files).length) {
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
  }
  return dir;
}

/** Run the CLI as a child process. */
export function brain(args, { cwd, env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [BRAIN_JS, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, BRAIN_HOOK_ACTIVE: '', ...env }, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Deliver a hook payload exactly as a host would: run the command string through /bin/sh with JSON on stdin. */
export function runHookCommand(command, payload, { env = {} } = {}) {
  const r = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, BRAIN_HOOK_ACTIVE: '', ...env }, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export function hook(event, payload, opts = {}) {
  return runHookCommand(`"${process.execPath}" "${BRAIN_JS}" hook claude-code ${event}`, payload, opts);
}

export function read(p) {
  return fs.readFileSync(p, 'utf8');
}

export const NODE_FIXTURE = {
  'package.json': JSON.stringify({ name: 'fixture-app', private: true, scripts: { test: 'vitest run', build: 'vite build' }, dependencies: { react: '^18.3.1' }, devDependencies: { vitest: '^2.1.0' } }, null, 2),
  'package-lock.json': '{}',
  'README.md': '# Fixture App\n\nA small demo application used to test the project brain initializer end to end.\n',
  'src/index.js': 'export const x = 1;\n',
  '.github/workflows/ci.yml': 'name: ci\non: push\njobs: {}\n',
};
