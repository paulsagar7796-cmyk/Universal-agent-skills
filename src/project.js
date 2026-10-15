import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRAIN_DIR_NAME, git, isDir, sha256 } from './util.js';
import { redactUrl } from './secrets.js';

/** Normalize a git remote so https/ssh forms of the same repository compare equal. Credentials are stripped. */
export function normalizeRemote(url) {
  if (!url) return null;
  let u = redactUrl(url.trim());
  const scp = u.match(/^[\w.-]+@([^:/]+):(.+)$/);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  u = u.replace(/:\d+\//, '/').replace(/\.git$/, '').replace(/\/+$/, '');
  return u.toLowerCase();
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Resolve the project for a working directory.
 * Root = git top-level when inside a repository, else the nearest ancestor containing .agent-brain, else cwd.
 */
export function resolveProject(startDir = process.cwd(), { withGitState = true } = {}) {
  const cwd = realpath(startDir);
  let root = null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const isRepo = Boolean(top);
  if (top) root = realpath(top);
  if (!root) {
    const home = realpath(os.homedir());
    let dir = cwd;
    for (;;) {
      if (isDir(path.join(dir, BRAIN_DIR_NAME))) {
        root = dir;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir || dir === home) break;
      dir = parent;
    }
  }
  if (!root) root = cwd;
  const remote = isRepo ? normalizeRemote(git(root, ['config', '--get', 'remote.origin.url'])) : null;
  const id = sha256(`${root}\n${remote ?? ''}`).slice(0, 16);
  const project = {
    root,
    brainDir: path.join(root, BRAIN_DIR_NAME),
    id,
    remote,
    isRepo,
    hasBrain: isDir(path.join(root, BRAIN_DIR_NAME)),
    isUnsafeRoot: root === realpath(os.homedir()) || root === path.parse(root).root,
  };
  if (withGitState) project.git = isRepo ? gitState(root) : null;
  return project;
}

/** Cheap, read-only snapshot of git state. Never includes file contents. */
export function gitState(root, { maxFiles = 50 } = {}) {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? git(root, ['symbolic-ref', '--short', 'HEAD']); // second form works before the first commit
  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  const porcelain = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']) ?? '';
  const lines = porcelain.split('\n').filter(Boolean);
  return {
    branch: branch ?? null,
    head: head ?? null,
    changedCount: lines.length,
    changed: lines.slice(0, maxFiles).map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) })),
    truncated: lines.length > maxFiles,
    fingerprint: sha256(`${head}\n${porcelain}`).slice(0, 16),
  };
}
