import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const OWNER = 'agent-skills-brain';
export const BRAIN_DIR_NAME = '.agent-brain';

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readText(p, maxBytes = 1024 * 1024) {
  const st = fs.statSync(p);
  if (st.size > maxBytes) throw new Error(`${p} is larger than ${maxBytes} bytes`);
  return fs.readFileSync(p, 'utf8');
}

export function readTextIfExists(p, maxBytes) {
  try {
    return readText(p, maxBytes);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function readJsonIfExists(p) {
  const t = readTextIfExists(p);
  return t === null ? null : JSON.parse(t);
}

/** Write a file atomically (temp file + rename) so readers never see partial content. */
export function writeFileAtomic(p, content, { mode } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, p);
}

export function writeJsonAtomic(p, value) {
  writeFileAtomic(p, JSON.stringify(value, null, 2) + '\n');
}

/** Resolve `rel` under `root`; throws if the result escapes root (path traversal guard). */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) throw new Error(`invalid path: ${JSON.stringify(rel)}`);
  const abs = path.resolve(root, rel);
  const relBack = path.relative(root, abs);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) throw new Error(`path escapes project root: ${rel}`);
  return abs;
}

/** Simple cross-process lock using an exclusive lock file. Stale locks (older than staleMs) are broken. */
export function withLock(lockPath, fn, { timeoutMs = 3000, staleMs = 15000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid} ${nowIso()}\n`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`could not acquire lock ${lockPath} (another brain process is writing)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

/** Run git read-only with a short timeout. Returns stdout (trimmed) or null on any failure. */
export function git(cwd, args, { timeoutMs = 3000 } = {}) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', BRAIN_HOOK_ACTIVE: '1' },
      maxBuffer: 4 * 1024 * 1024,
    }).trimEnd();
  } catch {
    return null;
  }
}

export function slugify(s, max = 48) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'untitled'
  );
}

export function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Minimal line diff (LCS) for showing planned config changes. */
export function lineDiff(before, after, { context = 3 } = {}) {
  const a = before === null || before === undefined ? [] : before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return `(file too large to diff: ${n} → ${m} lines)`;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  const keep = new Set();
  ops.forEach(([t], idx) => {
    if (t !== ' ') for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep.add(k);
  });
  const out = [];
  let last = -1;
  ops.forEach(([t, l], idx) => {
    if (!keep.has(idx)) return;
    if (last !== -1 && idx !== last + 1) out.push('  …');
    out.push(`${t} ${l}`);
    last = idx;
  });
  return out.length ? out.join('\n') : '  (no changes)';
}
