// Claude Code CLI provider (`claude -p … --output-format stream-json --verbose`), format verified on 2.1.300.
//
// Isolation per case: fresh fixture workspace; skills copied into <ws>/.claude/skills (without their evals/);
// --setting-sources project (your user settings and hooks are not loaded); --strict-mcp-config (no MCP servers);
// --no-session-persistence; OS sandbox for Bash with no unsandboxed escape; WebSearch/WebFetch denied unless the run
// explicitly allows web access; --max-budget-usd caps spend per invocation. User-level skills directories may still
// be visible to the agent (Claude Code has no flag to exclude them without --bare, which refuses OAuth logins); the
// run report lists the skills the host made available.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseClaudeStream } from '../transcript.js';
import { ProviderError } from '../errors.js';

export function findClaudeBinary(explicit = null, env = process.env) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const onPath = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8', env }).stdout.trim();
  if (onPath) return onPath;
  const ext = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const dirs = fs.readdirSync(ext).filter((d) => d.startsWith('anthropic.claude-code-')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const d of dirs.reverse()) {
      const bin = path.join(ext, d, 'resources', 'native-binary', 'claude');
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    /* no extensions directory */
  }
  return null;
}

export function claudeVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
  return (r.stdout ?? '').trim().split(/\s/)[0] || null;
}

function settingsFor(c, opts) {
  const deny = new Set(c.environment.deny.flatMap((cap) => ({ 'web.search': ['WebSearch'], 'web.fetch': ['WebFetch'] })[cap] ?? []));
  if (!opts.allowWeb) {
    deny.add('WebSearch');
    deny.add('WebFetch');
  }
  return { sandbox: { enabled: true, allowUnsandboxedCommands: false }, permissions: { deny: [...deny] } };
}

export function buildArgs(c, opts) {
  return ['-p', c.prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--model', opts.model ?? 'haiku', '--permission-mode', 'acceptEdits', '--max-budget-usd', String(opts.budgetUsd ?? 0.5), '--settings', JSON.stringify(settingsFor(c, opts))];
}

function runProcess(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d.toString().slice(0, 4000)));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e.message), timedOut });
    });
  });
}

export const claudeCodeProvider = {
  id: 'claude-code',
  live: true,
  capabilities: { reportsSkillLoading: true, sandboxedShell: true, costReported: true },
  describe(opts = {}) {
    const bin = findClaudeBinary(opts.claudeBin);
    return { name: 'Claude Code CLI', binary: bin, version: bin ? claudeVersion(bin) : null, model: opts.model ?? 'haiku', notes: ['Uses your Claude Code login; usage counts against your account.', 'Bash runs inside the Claude Code OS sandbox (no network, writes limited to the workspace).', opts.allowWeb ? 'WebSearch/WebFetch ALLOWED for this run (queries leave your machine).' : 'WebSearch/WebFetch denied.'] };
  },
  plan(cases, opts = {}) {
    const judge = opts.judge === 'claude-code' ? cases.reduce((n, c) => n + (c.criteria.length > 0 ? 1 : 0), 0) : 0;
    return { invocations: cases.length + judge, agentInvocations: cases.length, judgeInvocations: judge, perInvocationBudgetUsd: opts.budgetUsd ?? 0.5, notes: ['Each invocation sends the case prompt, the synthetic fixture workspace contents the agent chooses to read, and the skill files to Anthropic via Claude Code.', 'No files from your own repositories are copied into eval workspaces.'] };
  },
  async run(c, ws, opts = {}) {
    const bin = findClaudeBinary(opts.claudeBin);
    if (!bin) throw new ProviderError('Claude Code CLI not found (pass --claude-bin)', { transient: false, kind: 'unavailable' });
    const env = { ...process.env, PATH: `${path.join(ws.dir, '.eval-bin')}:${process.env.PATH}` };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'BRAIN_HOOK_ACTIVE']) delete env[k];
    const r = await runProcess(bin, buildArgs(c, opts), { cwd: ws.dir, env, timeoutMs: opts.timeoutMs ?? 240000 });
    const t = parseClaudeStream(r.stdout);
    if (r.timedOut) throw new ProviderError(`timed out after ${opts.timeoutMs ?? 240000} ms`, { transient: true, kind: 'timeout' });
    if (!t.final_text && r.code !== 0) {
      const transient = /rate.?limit|overloaded|529|ECONNRESET|ETIMEDOUT|temporarily/i.test(r.stderr + r.stdout);
      throw new ProviderError(`claude exited ${r.code}: ${r.stderr.slice(0, 300)}`, { transient, kind: transient ? 'transient' : 'provider-error' });
    }
    return t;
  },
  async judge(req, opts = {}) {
    const bin = findClaudeBinary(opts.claudeBin);
    if (!bin) throw new ProviderError('Claude Code CLI not found', { kind: 'unavailable' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-judge-'));
    const prompt = [
      'You are grading an AI agent transcript against explicit criteria. You have no tools.',
      'Rules: judge only what the transcript shows. A statement by the agent that it did something (e.g. "tests pass") is NOT evidence that it happened unless a matching tool call/result is in the transcript.',
      'For each criterion return verdict "pass", "fail" or "unclear", and evidence: 1-3 EXACT quotes copied from the transcript (at least 8 characters each). Use "unclear" if you cannot quote evidence.',
      'Return ONLY a JSON array: [{"criterion": "<id>", "verdict": "...", "evidence": ["..."]}]',
      '',
      `Task given to the agent:\n${req.prompt}`,
      '',
      `Criteria:\n${req.criteria.map((x) => `- ${x.id} (${x.list === 'must' ? 'MUST' : 'MUST NOT'}): ${x.text}`).join('\n')}`,
      '',
      `Transcript (redacted, truncated):\n${req.transcriptText.slice(0, 14000)}`,
    ].join('\n');
    const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--tools', '', '--model', opts.judgeModel ?? opts.model ?? 'haiku', '--max-budget-usd', String(opts.budgetUsd ?? 0.5)];
    const env = { ...process.env };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
    const r = await runProcess(bin, args, { cwd: dir, env, timeoutMs: opts.timeoutMs ?? 120000 });
    fs.rmSync(dir, { recursive: true, force: true });
    let text = '';
    try {
      text = JSON.parse(r.stdout).result ?? '';
    } catch {
      throw new ProviderError(`judge output unparseable (exit ${r.code})`, { transient: r.timedOut });
    }
    const m = String(text).match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      return JSON.parse(m[0]);
    } catch {
      return [];
    }
  },
};
