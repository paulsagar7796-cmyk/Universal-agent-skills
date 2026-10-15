#!/usr/bin/env node
// Static scanner for Agent Skill folders. Zero dependencies; reads files only (never executes them).
// Usage: node scan.mjs <skill-dir> [<skill-dir> ...] [--json]
// Findings are signals for human review, not proof that a skill is safe or malicious.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  { id: 'remote-script-exec', severity: 'high', re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|iex|pwsh)\b/i, why: 'downloads code and pipes it straight into an interpreter' },
  { id: 'encoded-exec', severity: 'high', re: /base64\s+(-d|--decode|-D)\b[^\n]*\|\s*(sh|bash|zsh|python3?|node)\b|\beval\s*\(\s*(atob|Buffer\.from)\s*\(|exec\s*\(\s*(base64\.b64decode|compile\s*\()/i, why: 'decodes and executes hidden code' },
  { id: 'destructive-delete', severity: 'high', re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*("|')?(\/|~\/?|\$HOME\/?|\*|\.\.?\/?)("|')?(\s|$)/, why: 'recursive delete of a root, home, wildcard or parent path' },
  { id: 'credential-access', severity: 'medium', re: /(~|\$HOME|%USERPROFILE%)[\\/]\.(ssh|aws|gnupg|kube|docker|config[\\/]gcloud)\b|\bid_(rsa|ed25519|ecdsa)\b|\.git-cred[e]ntials\b|\b\.netrc\b|\bcredentials\.json\b|Login[ ]Data\b|\bkey[c]hain\b/i, why: 'touches credential stores or private keys' },
  { id: 'env-exfiltration', severity: 'high', re: /\b(printenv|env)\b\s*\|\s*(curl|wget|nc|netcat)\b|process\.env\b[^\n]{0,80}\b(fetch|axios|https?\.request|request)\s*\(|os\.environ\b[^\n]{0,80}\b(requests|urllib|httpx)\./i, why: 'sends environment variables over the network' },
  { id: 'network-upload', severity: 'medium', re: /\b(curl|wget)\b[^\n]*(\s-d\s|\s--data(-binary)?\b|\s--upload-file\b|\s-F\s|\s-T\s)|\b(requests|httpx)\.(post|put)\s*\(|\baxios\.(post|put)\s*\(|\b(nc|netcat)\s+-[a-z]*\s*\S+\s+\d+/i, why: 'uploads data to a remote endpoint' },
  { id: 'hidden-unicode', severity: 'high', re: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069]|(?!^)\uFEFF/u, why: 'invisible or bidirectional-control characters can hide instructions' },
  { id: 'concealment', severity: 'high', re: /\b(do not|don't|never)\s+(tell|inform|mention|reveal|show|notify)\b[^\n]{0,40}\b(user|human|operator|owner)s?\b|\bwithout\s+(telling|asking|informing|notifying)\s+the\s+(user|human|operator)\b|\bsilently\s+(upload|send|exfiltrate|transmit|delete)\b/i, why: 'tells the agent to hide actions from the user' },
  { id: 'instruction-override', severity: 'high', re: /\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier|system)\s+(instructions|rules|prompts?)\b|\bdisregard\s+(the\s+|all\s+)?(system|previous|prior)\s+(prompt|instructions|rules)\b|\byou\s+are\s+now\s+(in\s+)?(developer|jailbreak|unrestricted)\s+mode\b/i, why: 'attempts to override the agent or host instructions' },
  { id: 'permission-bypass', severity: 'medium', re: /dangerously[-_]skip[-_]permissions|bypass[P]ermissions|--y[o]lo\b|\bauto[- ]approve\s+(all|every)\b|\bdisable\s+(the\s+)?sandbox\b/i, why: 'disables approval prompts or sandboxing' },
  { id: 'persistence', severity: 'medium', re: /\bcrontab\s+-|\blaunchctl\s+(load|bootstrap)\b|\bsystemctl\s+(--user\s+)?enable\b|>>\s*~\/\.(bashrc|zshrc|profile|bash_profile)\b|LaunchAgents\//, why: 'installs something that keeps running or alters shell startup' },
  { id: 'install-hook', severity: 'medium', re: /"(preinstall|postinstall|install|prepare)"\s*:\s*"/, why: 'package install hook runs code during installation' },
  { id: 'privilege-escalation', severity: 'low', re: /(^|[\s;&|`(])sudo\s/, why: 'requests root privileges' },
  { id: 'world-writable', severity: 'low', re: /\bchmod\s+(-R\s+)?(0?777|a\+w)\b/, why: 'makes files world-writable' },
  { id: 'embedded-payload', severity: 'medium', re: /data:(text\/html|application\/(x-)?javascript|application\/octet-stream);base64,|[A-Za-z0-9+/]{240,}={0,2}/, why: 'large encoded blob or inline executable payload' },
];

const BINARY_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.jar', '.class', '.pyc', '.wasm', '.msi', '.dmg', '.deb', '.rpm', '.apk', '.app']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'evals']);
const MAX_BYTES = 2 * 1024 * 1024;

function walk(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) out.push({ rel: r, symlink: true });
    else if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) out.push(...walk(dir, r));
    } else if (ent.isFile()) out.push({ rel: r });
  }
  return out;
}

/** Scan one skill directory. exceptions: [{rule, file, reason}] suppress (but still report) matching findings. */
export function scanSkill(dir, { exceptions = [] } = {}) {
  const findings = [];
  const add = (f) => {
    const ex = exceptions.find((e) => e.rule === f.rule && (e.file === f.file || e.file === '*'));
    findings.push(ex ? { ...f, excepted: ex.reason } : f);
  };
  for (const { rel, symlink } of walk(dir)) {
    if (symlink) {
      add({ rule: 'symlink', severity: 'medium', file: rel, line: 0, excerpt: '(symbolic link)', why: 'symlinks can point outside the skill folder' });
      continue;
    }
    const abs = path.join(dir, rel);
    const st = fs.statSync(abs);
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) {
      add({ rule: 'binary-file', severity: 'medium', file: rel, line: 0, excerpt: `(${st.size} bytes)`, why: 'compiled binaries cannot be reviewed as text' });
      continue;
    }
    if (st.size > MAX_BYTES) {
      add({ rule: 'oversized-file', severity: 'low', file: rel, line: 0, excerpt: `(${st.size} bytes)`, why: 'large file not scanned' });
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) {
      add({ rule: 'binary-file', severity: 'medium', file: rel, line: 0, excerpt: '(contains NUL bytes)', why: 'binary content cannot be reviewed as text' });
      continue;
    }
    if (st.mode & 0o111 && !rel.startsWith('scripts/')) add({ rule: 'unexpected-executable', severity: 'low', file: rel, line: 0, excerpt: '(executable bit set)', why: 'executable outside scripts/' });
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      for (const r of RULES) {
        if (r.id === 'install-hook' && path.basename(rel) !== 'package.json') continue;
        if (r.re.test(line)) add({ rule: r.id, severity: r.severity, file: rel, line: i + 1, excerpt: line.trim().slice(0, 160), why: r.why });
      }
    });
  }
  return findings;
}

export function summarize(findings) {
  const open = findings.filter((f) => !f.excepted);
  return { high: open.filter((f) => f.severity === 'high').length, medium: open.filter((f) => f.severity === 'medium').length, low: open.filter((f) => f.severity === 'low').length, excepted: findings.length - open.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const dirs = args.filter((a) => a !== '--json');
  if (!dirs.length) {
    process.stderr.write('usage: node scan.mjs <skill-dir> [...] [--json]\n');
    process.exit(2);
  }
  let worst = 0;
  const report = dirs.map((d) => {
    const findings = scanSkill(d);
    const s = summarize(findings);
    worst = Math.max(worst, s.high ? 2 : s.medium ? 1 : 0);
    return { dir: d, summary: s, findings };
  });
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else
    for (const r of report) {
      process.stdout.write(`${r.dir}: high ${r.summary.high}, medium ${r.summary.medium}, low ${r.summary.low}\n`);
      for (const f of r.findings) process.stdout.write(`  [${f.severity}] ${f.rule} ${f.file}:${f.line} — ${f.why}\n      ${f.excerpt}\n`);
    }
  process.stdout.write('Static signals only: a clean result does not prove a skill is safe.\n');
  process.exit(worst === 2 ? 1 : 0);
}
