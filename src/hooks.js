// Lifecycle hook entrypoint (`brain hook <agent> <event>`). Design rules:
//  - bounded: hard deadline per event; stdin size cap
//  - recursion-safe: BRAIN_HOOK_ACTIVE=1 makes nested invocations no-ops
//  - never blocks the agent's normal flow (exit 0), except PreToolUse for a capability the user explicitly denied
//  - degrades visibly: on failure, SessionStart/UserPromptSubmit context says automatic memory is unavailable
//  - stores no prompts, assistant messages or transcripts (only hashes, lengths, ids, git state)
import path from 'node:path';
import { resolveProject, gitState } from './project.js';
import { BrainStore } from './store.js';
import { loadConfig } from './config.js';
import { buildContext, writeCheckpoint } from './context.js';
import { openIndex } from './index-db.js';
import { appendEvent, hashSession, makeEvent, pruneEvents, readEvents } from './events.js';
import { loadRuntimeCatalog, loadCapabilityRegistry, REPO_ROOT } from './catalog.js';
import { route } from './router.js';
import { capabilityForTool, deniedCapabilities, evaluateSkill, loadState } from './broker.js';
import { sha256, truncate } from './util.js';

export const HOOK_EVENTS = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  stop: 'Stop',
  'pre-compact': 'PreCompact',
  'session-end': 'SessionEnd',
  'pre-tool-use': 'PreToolUse',
};
export const SUPPORTED_AGENTS = ['claude-code'];
export const BUDGET_MS = { 'session-start': 4000, 'user-prompt-submit': 2500, stop: 2500, 'pre-compact': 2500, 'session-end': 1000, 'pre-tool-use': 1500 };
const MAX_STDIN = 1024 * 1024;

export function cliInvocation() {
  return `"${process.execPath}" "${path.join(REPO_ROOT, 'bin', 'brain.js')}"`;
}

function contextOutput(eventName, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
}

function checkpoint(store, project, event, payload, session, index) {
  const g = project.isRepo ? gitState(project.root, { maxFiles: 25 }) : null;
  const reason = payload.reason ?? payload.trigger ?? null;
  const cp = { at: new Date().toISOString(), event, reason, session, git: g ? { branch: g.branch, head: g.head, changedCount: g.changedCount, changed: g.changed, truncated: g.truncated } : null };
  const eventId = sha256(`checkpoint\n${session}\n${event}\n${g?.fingerprint ?? 'nogit'}`).slice(0, 24);
  const fresh = appendEvent(store, makeEvent('checkpoint', { event, reason, branch: g?.branch ?? null, head: g?.head ?? null, changed: g?.changedCount ?? 0 }, { session, agent: 'claude-code', eventId }), { index });
  if (fresh) writeCheckpoint(store, cp);
  return { duplicate: !fresh };
}

/**
 * Handle one hook delivery. Pure with respect to stdout/stderr: returns what to print.
 * @returns {{ exitCode: number, stdout?: string, stderr?: string }}
 */
export function handleHook(agent, event, payload, { env = process.env } = {}) {
  if (env.BRAIN_HOOK_ACTIVE === '1') return { exitCode: 0 };
  if (!SUPPORTED_AGENTS.includes(agent)) return { exitCode: 0, stderr: `brain: hook adapter "${agent}" is not implemented; ignoring.` };
  const eventName = HOOK_EVENTS[event];
  if (!eventName) return { exitCode: 0, stderr: `brain: unknown hook event "${event}"; ignoring.` };
  const p = payload && typeof payload === 'object' ? payload : {};
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : env.CLAUDE_PROJECT_DIR || process.cwd();
  const session = hashSession(p.session_id);
  let store = null;
  let index = null;
  try {
    const project = resolveProject(cwd, { withGitState: event === 'session-start' });
    if (!project.hasBrain) return { exitCode: 0 };
    store = new BrainStore(project);
    const { config } = loadConfig(store.dir);

    if (event === 'pre-tool-use') {
      const tool = String(p.tool_name ?? '');
      const registry = loadCapabilityRegistry();
      const hit = capabilityForTool(registry, tool);
      if (!hit) return { exitCode: 0 };
      const state = loadState(store);
      if (!deniedCapabilities(state, { session: p.session_id ?? null }).includes(hit.capId)) return { exitCode: 0 };
      appendEvent(store, makeEvent('enforcement', { tool, capability: hit.capId, access: hit.access, action: 'blocked' }, { session, agent }));
      return { exitCode: 2, stderr: `Blocked by agent-skills-brain: the user denied capability "${hit.capId}" for this project, so ${tool} is not allowed. Use the skill's fallback, or ask the user whether they want to re-enable it (\`brain consent grant ${hit.capId}\`).` };
    }

    const opened = openIndex(store, { readEventsFn: () => readEvents(store) });
    index = opened.index;

    if (event === 'session-start') {
      pruneEvents(store, { days: config.retention.events_days, maxLines: config.retention.max_event_lines });
      const ctx = buildContext({ store, project, config, cli: cliInvocation(), indexStatus: opened.status === 'unavailable' ? `unavailable (${opened.reason}); using file scan` : opened.reason ? `${opened.status}: ${opened.reason}` : opened.status });
      appendEvent(store, makeEvent('context', { source: p.source ?? null, chars: ctx.stats.chars, sources: ctx.sources, omitted: ctx.omitted, index: opened.status, facts: ctx.stats.facts, stale: ctx.stats.stale }, { session, agent }), { index });
      return { exitCode: 0, stdout: contextOutput(eventName, ctx.text) };
    }

    if (event === 'user-prompt-submit') {
      const prompt = typeof p.prompt === 'string' ? p.prompt : '';
      if (prompt.trim().length < 8 || prompt.trim().startsWith('/')) return { exitCode: 0 };
      const catalog = loadRuntimeCatalog();
      const r = route(prompt, catalog, { maxSkills: config.routing.max_skills, minScore: config.routing.min_score });
      const state = loadState(store);
      const registry = loadCapabilityRegistry();
      const flags = [];
      for (const s of r.selected) {
        const entry = catalog.find((c) => c.id === s.id);
        const ev = evaluateSkill({ id: s.id, capabilities: entry?.capabilities ?? {}, approvals: entry?.approvals ?? [] }, state, registry, { session: p.session_id ?? null });
        for (const it of ev.items) if (it.decision !== 'proceed' && (it.importance === 'required' || it.decision === 'fallback' || it.decision === 'blocked')) flags.push({ skill: s.id, capability: it.capability, decision: it.decision, message: it.message });
      }
      appendEvent(store, makeEvent('route', { prompt_sha: sha256(prompt).slice(0, 12), prompt_chars: prompt.length, intents: r.intents, selected: r.selected.map((s) => ({ id: s.id, score: s.score, reasons: s.reasons.slice(0, 6) })), supporting: r.supporting.map((s) => s.id), capability_flags: flags.map((f) => `${f.skill}:${f.capability}:${f.decision}`) }, { session, agent }), { index });
      if (!r.selected.length) return { exitCode: 0 };
      const lines = ['[agent-skills-brain] Suggested skills for this request (keyword router; use judgement, the user\'s explicit choice wins):'];
      for (const s of r.selected) lines.push(`- ${s.id} — matched ${s.reasons.slice(0, 4).join(', ')}. If not already loaded, read ${s.path}`);
      for (const s of r.supporting) lines.push(`- supporting: ${s.id} (${s.reason}) — ${s.path}`);
      if (flags.length) {
        lines.push('Capability checks (from skill manifests):');
        for (const f of flags) lines.push(`- ${f.skill} → ${f.capability}: ${f.decision}. ${truncate(f.message, 420)}`);
      }
      lines.push(`Record user decisions with \`${cliInvocation()} consent grant|deny <capability> --access read|write\`.`);
      return { exitCode: 0, stdout: contextOutput(eventName, lines.join('\n')) };
    }

    // stop, pre-compact, session-end: mechanical checkpoint (no conversation content)
    checkpoint(store, resolveProject(cwd, { withGitState: false }), event, p, session, index);
    return { exitCode: 0 };
  } catch (e) {
    try {
      if (store) appendEvent(store, makeEvent('error', { hook: event, message: truncate(String(e?.message ?? e), 300) }, { session, agent }));
    } catch {
      /* trace unavailable; nothing else to do */
    }
    if (event === 'session-start' || event === 'user-prompt-submit') {
      return { exitCode: 0, stdout: contextOutput(eventName, `[agent-skills-brain] Automatic project memory is unavailable this ${event === 'session-start' ? 'session' : 'turn'} (${truncate(String(e?.message ?? e), 200)}). The canonical files are still readable: start with .agent-brain/index.md. Run \`brain doctor\` to diagnose.`) };
    }
    return { exitCode: 0 };
  } finally {
    index?.close();
  }
}

/** Read stdin JSON with a size cap and timeout. Resolves to {} on empty/invalid input. */
export function readStdinJson(stream = process.stdin, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (stream.isTTY) return resolve({});
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.pause?.();
      resolve(v);
    };
    const t = setTimeout(() => finish(safeParse(buf)), timeoutMs);
    stream.setEncoding?.('utf8');
    stream.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_STDIN) finish({});
    });
    stream.on('end', () => finish(safeParse(buf)));
    stream.on('error', () => finish({}));
  });
}

function safeParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Process wrapper with a hard deadline: if the budget is exceeded, exit 0 (or emit a fallback note for context events). */
export async function runHookProcess(agent, event) {
  const budget = Number(process.env.BRAIN_HOOK_BUDGET_MS) || BUDGET_MS[event] || 2000;
  const eventName = HOOK_EVENTS[event];
  const timer = setTimeout(() => {
    if (event === 'session-start' || event === 'user-prompt-submit') {
      process.stdout.write(contextOutput(eventName, `[agent-skills-brain] Project memory timed out after ${budget} ms and was skipped. Read .agent-brain/index.md directly; run \`brain doctor\`.`));
    }
    process.exit(0);
  }, budget);
  const payload = await readStdinJson(process.stdin, Math.min(1500, budget / 2));
  const testDelay = Number(process.env.BRAIN_TEST_HOOK_DELAY_MS); // test-only: simulates a slow controller
  if (testDelay > 0) await new Promise((r) => setTimeout(r, testDelay));
  const r = handleHook(agent, event, payload);
  clearTimeout(timer);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr + '\n');
  process.exitCode = r.exitCode;
}
