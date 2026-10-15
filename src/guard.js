// PreToolUse guard for Claude Code: stops the agent's own tools from changing consent policy, approving its own
// proposals, or editing protected configuration.
//
// File tools (Edit, Write, NotebookEdit): exact path checks after resolving symlinks — reliable for those tools.
// Bash: pattern checks on the command text — a heuristic. Obfuscated commands (variables, encodings, scripts written
// first and run later) can evade it. The OS sandbox (`brain setup --harden`) is the control that does not depend on
// command text; see docs/security-model.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './catalog.js';

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    // resolve the nearest existing parent so symlinked parents are still canonicalised
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(real(parent), path.basename(p));
  }
}

/** Paths the agent's tools must not modify. */
export function protectedPaths(projectRoot, { home = os.homedir() } = {}) {
  const root = real(projectRoot);
  const list = [
    { path: path.join(root, '.agent-brain', 'local', 'policy'), dir: true, why: 'consent policy log' },
    { path: path.join(root, '.agent-brain', 'local', 'requests.json'), why: 'consent requests/restrictions (use brain consent request|deny)' },
    { path: path.join(root, '.agent-brain', 'local', 'install.json'), why: 'install record' },
    { path: path.join(root, '.agent-brain', 'local', 'proposals'), dir: true, why: 'pending memory proposals (use brain remember/reject)' },
    { path: path.join(root, '.agent-brain', 'config.yaml'), why: 'brain policy configuration (auto-accept, enforcement mode)' },
    { path: path.join(root, '.claude', 'settings.json'), why: 'agent settings' },
    { path: path.join(root, '.claude', 'settings.local.json'), why: 'agent settings (hooks)' },
    { path: path.join(real(home), '.claude', 'settings.json'), why: 'user agent settings' },
    { path: path.join(real(home), '.agent-skills-brain'), dir: true, why: 'controller state (policy heads, backups)' },
  ];
  // Controller code and capability registry — unless the agent is working on the controller repository itself.
  if (real(REPO_ROOT) !== root) {
    for (const rel of ['bin', 'src', 'integrations', 'catalog']) list.push({ path: path.join(real(REPO_ROOT), rel), dir: true, why: 'brain controller code / capability registry' });
  }
  return list;
}

export function protectedMatch(filePath, projectRoot, opts = {}) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const abs = real(path.resolve(projectRoot, filePath));
  for (const p of protectedPaths(projectRoot, opts)) {
    const target = p.path;
    if (abs === target || (p.dir && abs.startsWith(target + path.sep))) return p;
  }
  return null;
}

const CLI = String.raw`(?:\bbrain\b|brain\.js|universal-agent-skills|agent-skills-brain)`;
const BASH_RULES = [
  { id: 'self-approval', re: new RegExp(`${CLI}["']?\\s+(?:--project[= ]\\S+\\s+)?(?:consent\\s+(?:grant|approve)\\b|approve\\b)`, 'i'), why: 'approvals and grants must be made by the user in their own terminal' },
  { id: 'terminal-emulation', re: new RegExp(`\\b(?:script|expect|unbuffer|socat|ptyprocess|pexpect|node-pty|pty\\.spawn|openpty)\\b[\\s\\S]*${CLI}|${CLI}[\\s\\S]*\\b(?:script|expect|unbuffer|pexpect)\\b`, 'i'), why: 'driving the brain CLI through a terminal emulator looks like an attempt to bypass the human approval challenge' },
  { id: 'policy-write', re: /\.agent-brain\/local\/(?:policy|requests\.json|install\.json|proposals)|\.agent-brain\/config\.yaml|\.claude\/settings(?:\.local)?\.json|\.agent-skills-brain\//, why: 'commands that touch consent policy, settings or controller state are blocked; read them with `brain consent status` or `brain status`' },
];
// Commands that only read a protected path are allowed.
const READ_ONLY = /^\s*(?:cat|head|tail|less|more|wc|jq|ls|stat|file|grep|rg|diff|shasum|sha256sum|git\s+(?:diff|log|show|status))\b[^;&|>]*$/;

/** Decide whether a tool call must be blocked. Returns { block: boolean, rule, why }. */
export function checkToolCall(toolName, toolInput, projectRoot, opts = {}) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(toolName)) {
    const target = input.file_path ?? input.notebook_path ?? input.path;
    const hit = protectedMatch(target, projectRoot, opts);
    if (hit) return { block: true, rule: 'protected-path', why: `${toolName} on ${hit.why} (${path.relative(projectRoot, hit.path) || hit.path}) is not allowed for the agent` };
    return { block: false };
  }
  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '');
    for (const r of BASH_RULES) {
      if (!r.re.test(cmd)) continue;
      if (r.id === 'policy-write' && READ_ONLY.test(cmd)) continue;
      return { block: true, rule: r.id, why: r.why };
    }
  }
  return { block: false };
}

export const GUARDED_TOOLS = 'Bash|Edit|Write|NotebookEdit|MultiEdit';
