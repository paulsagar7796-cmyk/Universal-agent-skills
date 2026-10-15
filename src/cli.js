import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stringify } from './yaml.js';
import { resolveProject } from './project.js';
import { BrainStore } from './store.js';
import { loadConfig } from './config.js';
import { freshness } from './facts.js';
import { buildContext, lastCheckpoint } from './context.js';
import { openIndex, fallbackSearch, sqliteStatus } from './index-db.js';
import { appendEvent, makeEvent, readEvents, hashSession } from './events.js';
import { initBrain } from './init.js';
import { applyProposal, confirmFact, deprecateFact, getProposal, listProposals, proposeDecision, proposeFact, rejectProposal } from './proposals.js';
import { writeHandoff } from './handoff.js';
import { compareExperiments, finishExperiment, getExperiment, listExperiments, logMetrics, recordComparison, startExperiment } from './experiments.js';
import { audit } from './audit.js';
import { loadRuntimeCatalog, loadCapabilityRegistry, CATALOG_FILE, REPO_ROOT, findSkillDirs } from './catalog.js';
import { route } from './router.js';
import { activeDecision, authorizeAction, blockedCapabilities, CAP_STATES, consumeGrant, evaluateCapability, evaluateSkill, loadState, recordCapability, recordHumanGrant, recordRestriction, rejectRequest, requestConsent } from './broker.js';
import { confirmHuman, HumanApprovalRequired } from './human.js';
import { applySetup, applyUninstall, detectAgents, mergeClaudeSettings, planSetup, planUninstall, renderPlan, renderUninstall, smokeTest, verifyControllerFiles, OWNER_MARK } from './setup.js';
import { spawnSync } from 'node:child_process';
import { cliInvocation, runHookProcess } from './hooks.js';
import { exists, readJsonIfExists, truncate } from './util.js';

const REPEATABLE = new Set(['evidence', 'done', 'next', 'blocker', 'check', 'assumption', 'alternative', 'agent', 'access', 'config', 'data', 'seed']);
const BOOLEAN = new Set(['json', 'full', 'verbose', 'dry-run', 'yes', 'global', 'no-enforce', 'no-diff', 'confirm', 'supersede', 'dispute', 'always-confirm', 'help', 'all', 'harden', 'no-env-probe', 'lower-better', 'no-record']);

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      if (a === '-h') flags.help = true;
      else if (a === '-y') flags.yes = true;
      else pos.push(a);
      continue;
    }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (k.startsWith('owner')) continue; // ownership marker on hook commands
    if (v === undefined) {
      if (BOOLEAN.has(k)) v = true;
      else {
        v = argv[++i];
        if (v === undefined) throw new UsageError(`--${k} needs a value`);
      }
    }
    if (REPEATABLE.has(k)) (flags[k] ??= []).push(...String(v).split(k === 'agent' || k === 'access' ? ',' : /\u0000/).filter(Boolean));
    else flags[k] = v;
  }
  return { pos, flags };
}

class UsageError extends Error {}

const HELP = `brain — local project brain + skill router for coding agents (agent-skills-brain)

Setup (explicit, consent-gated, reversible):
  brain setup [--global] [--agent claude-code,agents-md] [--no-enforce] [--harden] [--dry-run] [--yes]
                                   --harden: opt-in Claude Code OS sandbox protecting consent policy (project scope)
  brain repair                     re-apply the recorded setup (e.g. after moving node or this checkout)
  brain uninstall [--global] [--dry-run] [--yes]
  brain doctor                     diagnose controller, index, adapters, hooks
  brain runtime status             hook activity and index state (no daemon is used)

Memory:
  brain init                       create/refresh .agent-brain/ from repository evidence (read-only scan)
  brain status [--verbose]         project summary
  brain context [--full] [--json]  the packet injected at session start
  brain search <query>             full-text search over the brain
  brain show <FACT-…|ADR-…|P-…>
  brain remember --claim "…" [--status observed|verified|assumption|unknown] --evidence file:<path>[#loc]
                 [--evidence cmd:<exit>:<command>] [--evidence url:<https://…>] [--evidence user:<note>]
                 [--key k] [--category c] [--question q] [--test-by how] [--supersedes FACT-…]
  brain proposals | reject <P-…> [--reason r]
  brain approve <P-…> [--supersede|--dispute]        HUMAN ONLY: run in your own terminal (typed confirmation code)
  brain decide --title t --decision d [--context c] [--alternative a]… [--consequences c] [--status proposed|accepted]
  brain verify [FACT-…] [--confirm --evidence …]     report freshness / record re-verification
  brain deprecate <FACT-…> --reason r
  brain handoff --task t [--done x]… [--next x]… [--blocker x]… [--check "cmd=passed|failed|not-run|blocked[: note]"]… [--assumption x]…
  brain audit                      stale, disputed, unevidenced, secrets, experiment honesty checks

Experiments (metrics are read from result files only; there is no way to type a value):
  brain exp start --title t [--question q] [--hypothesis h] [--baseline EXP-…] [--config file]… [--data role=file]…
                  [--split desc] [--seed N]… [--python path] [--no-env-probe]
  brain exp log <EXP-…> --from results.json|.jsonl|.csv [--select a,b] [--row N] [--seed N]
  brain exp finish <EXP-…> --status completed|failed|abandoned [--conclusion "…"]
  brain exp compare <baseline> <candidate> --metric m [--baseline-metric m0] [--lower-better] [--alpha 0.05]
                  [--min-seeds 3] [--no-record]
  brain exp list | show <EXP-…>
  brain index rebuild|status
  brain explain-last-run           what the controller did since the last session start

Skills & capabilities:
  brain route "<request>"          show which skills the router would suggest
  brain capabilities [check <skill>] | capabilities record <capability> <state> --access read --evidence "…"
  brain consent status | explain <capability|action:NAME|skill>          read-only
  brain consent request <capability|action:NAME> [--access read|write|privileged] [--scope once|session|project]
                [--expires ISO] [--skill s] [--reason r]                 agent-usable; changes nothing
  brain consent deny|revoke <target> | reject <request-id>               agent-usable; can only reduce privilege
  brain consent approve <request-id> | grant <target> [--access …]       HUMAN ONLY: run in your own terminal
  brain authorize <action> [--always-confirm]   may this high-impact action run now?
  brain connect <capability>       official setup guidance (never installs anything)

Global: --project <dir> (default: cwd)   Exit codes: 0 ok, 1 error, 2 usage, 3 consent required, 4 human approval required`;

function out(s = '') {
  process.stdout.write(s + '\n');
}

function ctx(flags) {
  const project = resolveProject(flags.project ?? process.cwd());
  const store = new BrainStore(project);
  const { config, warnings } = loadConfig(store.dir);
  return { project, store, config, warnings };
}

function requireBrain(store) {
  if (!store.exists()) throw new Error(`no ${path.basename(store.dir)}/ in ${store.root}. Run \`brain init\` (or \`brain setup\`) first.`);
}

function logEvent(store, type, data) {
  try {
    appendEvent(store, makeEvent(type, data, { agent: 'cli' }));
  } catch {
    /* tracing is best-effort for CLI commands */
  }
}

async function confirm(question, flags) {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

async function ask(question, def, flags) {
  if (flags.yes || !process.stdin.isTTY) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} [${def ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
    return a === '' ? def : a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

function withIndex(store, fn) {
  const opened = openIndex(store, { readEventsFn: () => readEvents(store) });
  try {
    return fn(opened);
  } finally {
    opened.index?.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------

async function cmdSetup(flags) {
  const home = os.homedir();
  const detected = detectAgents({ home });
  out('Detected agents (from documented config locations; detection is not a support claim):');
  for (const a of detected) out(`  ${a.detected ? '●' : '○'} ${a.name.padEnd(20)} ${a.detected ? a.evidence.join('; ') : 'not found'}\n      adapter: ${a.adapter}`);
  out('');
  out('Clone/download never runs anything. This command changes only what the plan below lists, after you approve it.\n');
  let agents = flags.agent;
  let enforce = !flags['no-enforce'];
  if (!agents) {
    agents = [];
    const claude = detected.find((a) => a.id === 'claude-code');
    if (await ask(`Configure Claude Code lifecycle hooks${claude.detected ? '' : ' (Claude Code not detected)'}?`, claude.detected, flags)) agents.push('claude-code');
    if (await ask('Add an AGENTS.md "Project brain" block for agents without a tested hook adapter (Codex, Antigravity, Cursor…)?', false, flags)) agents.push('agents-md');
    if (agents.includes('claude-code') && !flags['no-enforce']) enforce = await ask('Block WebSearch/WebFetch/GitHub-MCP tools for capabilities the user explicitly denies (PreToolUse hook)?', true, flags);
  }
  if (!agents.length) {
    out('No adapters selected; nothing to do. File-only use needs no setup: copy templates/project-brain/ to .agent-brain/ or run `brain init`.');
    return 0;
  }
  const plan = planSetup({ cwd: flags.project ?? process.cwd(), scope: flags.global ? 'global' : 'project', agents, enforceDenials: enforce, harden: Boolean(flags.harden), home });
  out(renderPlan(plan, { diffs: !flags['no-diff'] }));
  if (flags['dry-run']) {
    out('\nDry run: no changes were made.');
    return 0;
  }
  if (plan.noop) {
    const st = smokeTest(plan);
    if (st.ran) out(`Hook smoke test: ${st.ok ? `passed (${st.chars} chars of context)` : `FAILED (exit ${st.status}) ${st.stderr ?? ''}`}`);
    return st.ran && !st.ok ? 1 : 0;
  }
  const ok = await confirm(`\nApply these ${plan.changes.length} change(s)?`, flags);
  if (ok === null) {
    out('\nConsent required: no TTY to ask. Review the plan above, then re-run with --yes to apply (or --dry-run to only preview).');
    return 3;
  }
  if (!ok) {
    out('Cancelled; nothing was changed.');
    return 0;
  }
  const res = applySetup(plan);
  for (const r of res.results) out(`  ✔ ${r}`);
  for (const b of res.backups) out(`  ↺ backup of ${b.path} → ${b.backup}`);
  const st = smokeTest(plan);
  const store = new BrainStore(resolveProject(plan.project.root));
  if (store.exists()) logEvent(store, 'setup', { scope: plan.scope, agents: plan.agents, enforce: plan.enforceDenials, changes: plan.changes.length, smoke: st.ran ? st.ok : null });
  out('\nState after setup:');
  out(`  skills on disk ............ ${findSkillDirs().length} in ${path.join(REPO_ROOT, 'skills')} (install into agents with \`npx skills add\`; see README)`);
  out(`  project brain ............. ${store.exists() ? 'present' : 'not present in this directory'}`);
  out(`  claude-code hooks ......... ${plan.agents.includes('claude-code') ? 'configured' : 'not selected'}`);
  out(`  hook smoke test ........... ${st.ran ? (st.ok ? `passed (synthetic SessionStart payload, ${st.chars} chars)` : `FAILED: ${st.stderr}`) : `not run (${st.reason})`}`);
  out('  delivery by the host ...... not verified by setup — start a new Claude Code session here, then run `brain explain-last-run`');
  out(`  AGENTS.md fallback ........ ${plan.agents.includes('agents-md') ? 'configured (manual: agents must choose to read it)' : 'not selected'}`);
  out('  integrations .............. none connected by setup (the broker asks when a skill needs one)');
  if (plan.agents.includes('claude-code')) out('\nNote: Claude Code may ask you to review new hooks (/hooks) before they run, and holds hooks until the folder is trusted.');
  return st.ran && !st.ok ? 1 : 0;
}

async function cmdRepair(flags) {
  const project = resolveProject(flags.project ?? process.cwd());
  const home = os.homedir();
  const local = readJsonIfExists(path.join(project.brainDir, 'local', 'install.json'));
  const global = readJsonIfExists(path.join(home, '.agent-skills-brain', 'install.json'));
  const m = flags.global ? global : local ?? global;
  if (!m) {
    out('No install record found; run `brain setup` first.');
    return 1;
  }
  return cmdSetup({ ...flags, global: m.scope === 'global', agent: m.agents, 'no-enforce': !m.enforce_denials, harden: flags.harden ?? m.harden ?? false });
}

async function cmdUninstall(flags) {
  const plan = planUninstall({ cwd: flags.project ?? process.cwd(), scope: flags.global ? 'global' : 'project' });
  out(renderUninstall(plan));
  if (plan.noop && !plan.manifestData) return 0;
  if (flags['dry-run']) {
    out('\nDry run: no changes were made.');
    return 0;
  }
  const ok = await confirm(`\nRemove ${plan.changes.length} owned entr${plan.changes.length === 1 ? 'y' : 'ies'}?`, flags);
  if (ok === null) {
    out('\nConsent required: re-run with --yes after reviewing the plan.');
    return 3;
  }
  if (!ok) {
    out('Cancelled.');
    return 0;
  }
  for (const d of applyUninstall(plan)) out(`  ✔ ${d}`);
  return 0;
}

function cmdInit(flags) {
  const { project, store } = ctx(flags);
  if (project.isUnsafeRoot) throw new Error(`refusing to initialise a brain in ${project.root} (home directory or filesystem root). cd into a project first.`);
  const existed = store.exists();
  const s = initBrain(store, project);
  logEvent(store, 'init', { refreshed: existed, added: s.added.length, refreshed_facts: s.refreshed.length, superseded: s.superseded.length, questions: s.questions.length });
  out(`${existed ? 'Refreshed' : 'Created'} ${store.dir}`);
  if (s.created.length) out(`  template files created: ${s.created.length}`);
  out(`  project type hints: ${s.notes.types.join(', ')}`);
  out(`  facts added: ${s.added.length}; re-observed: ${s.refreshed.length}; superseded by changed files: ${s.superseded.length}; open questions added: ${s.questions.length}`);
  if (s.notes.commandsNotRun.length) out(`  commands detected but NOT run: ${s.notes.commandsNotRun.join(', ')}`);
  out('  Only read-only git commands were executed. Nothing was installed, built or tested.');
  out('  Next: review .agent-brain/project.md (goal is unknown until the owner states it) and `brain status`.');
  return 0;
}

function factsSummary(project, store) {
  const { doc, errors } = store.loadFacts();
  const counts = {};
  let stale = 0;
  for (const f of doc.facts ?? []) {
    counts[f.status] = (counts[f.status] ?? 0) + 1;
    if (['changed', 'missing', 'expired'].includes(freshness(f, project.root).state)) stale++;
  }
  return { counts, stale, errors, total: (doc.facts ?? []).length };
}

function installState(project) {
  const local = readJsonIfExists(path.join(project.brainDir, 'local', 'install.json'));
  const global = readJsonIfExists(path.join(os.homedir(), '.agent-skills-brain', 'install.json'));
  return { local, global };
}

function cmdStatus(flags) {
  const { project, store, warnings } = ctx(flags);
  const s = { project: { root: project.root, id: project.id, remote: project.remote, brain: store.exists() }, git: project.git };
  if (!store.exists()) {
    if (flags.json) out(JSON.stringify(s, null, 2));
    else out(`No project brain in ${project.root}. Run \`brain init\` or \`brain setup\`.`);
    return 0;
  }
  const f = factsSummary(project, store);
  const inst = installState(project);
  const handoff = store.latestHandoff();
  const cp = lastCheckpoint(store);
  Object.assign(s, { facts: f, decisions: store.listDecisions().length, proposals: listProposals(store).length, latestHandoff: handoff?.file ?? null, lastCheckpoint: cp?.at ?? null, setup: { project: inst.local ? inst.local.agents : null, global: inst.global ? inst.global.agents : null }, configWarnings: warnings });
  if (flags.json) {
    out(JSON.stringify(s, null, 2));
    return 0;
  }
  out(`Project ${project.root} (id ${project.id}${project.remote ? `, ${project.remote}` : ''})`);
  if (project.git) out(`Git: ${project.git.branch} @ ${project.git.head ?? 'no commits'}, ${project.git.changedCount} uncommitted change(s)`);
  out(`Facts: ${f.total} — ${Object.entries(f.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}${f.stale ? `; ${f.stale} need re-checking` : ''}${f.errors.length ? `; ${f.errors.length} schema error(s)` : ''}`);
  out(`Decisions: ${s.decisions}; pending proposals: ${s.proposals}; latest handoff: ${s.latestHandoff ?? 'none'}; last checkpoint: ${s.lastCheckpoint ?? 'none'}`);
  out(`Setup: project ${inst.local ? inst.local.agents.join('+') : 'not configured'}; global ${inst.global ? inst.global.agents.join('+') : 'not configured'}`);
  for (const w of warnings) out(`! ${w}`);
  if (flags.verbose) {
    const r = audit(store, project);
    for (const e of r.errors) out(`✖ ${e}`);
    for (const w of r.warnings) out(`! ${w}`);
    for (const i of r.info) out(`· ${i}`);
  }
  return 0;
}

function cmdContext(flags) {
  const { project, store, config } = ctx(flags);
  requireBrain(store);
  const status = withIndex(store, (o) => o.status);
  const c = buildContext({ store, project, config, cli: cliInvocation(), full: Boolean(flags.full), indexStatus: status });
  if (flags.json) out(JSON.stringify({ ...c.stats, sources: c.sources, omitted: c.omitted, text: c.text }, null, 2));
  else out(c.text);
  return 0;
}

function cmdSearch(flags, pos) {
  const { store } = ctx(flags);
  requireBrain(store);
  const q = pos.join(' ');
  if (!q.trim()) throw new UsageError('usage: brain search <query>');
  const limit = Number(flags.limit) || 10;
  const res = withIndex(store, (o) => ({ rows: o.index ? o.index.search(q, limit) : fallbackSearch(store, q, limit), mode: o.index ? 'sqlite-fts5' : `file scan (${o.reason})` }));
  if (flags.json) {
    out(JSON.stringify(res, null, 2));
    return 0;
  }
  if (!res.rows.length) out(`No matches for "${q}".`);
  for (const r of res.rows) out(`- [${r.kind}] ${r.ref} — ${truncate(r.title, 100)}\n    ${truncate(r.snippet.replace(/\s+/g, ' '), 200)}`);
  out(`(${res.mode})`);
  return 0;
}

function cmdShow(flags, pos) {
  const { project, store } = ctx(flags);
  requireBrain(store);
  const id = pos[0];
  if (!id) throw new UsageError('usage: brain show <FACT-…|ADR-…|P-…>');
  if (id.startsWith('FACT-')) {
    const f = (store.loadFacts().doc.facts ?? []).find((x) => x.id === id);
    if (!f) throw new Error(`no fact ${id}`);
    out(stringify(f).trimEnd());
    const fr = freshness(f, project.root);
    out(`freshness: ${fr.state}${fr.reasons.length ? ` (${fr.reasons.join('; ')})` : ''}`);
    return 0;
  }
  if (id.startsWith('ADR-')) {
    const d = store.listDecisions().find((x) => x.id === id);
    if (!d) throw new Error(`no decision ${id}`);
    out(store.read(`decisions/${d.file}`));
    return 0;
  }
  if (id.startsWith('P-')) {
    const p = getProposal(store, id);
    if (!p) throw new Error(`no pending proposal ${id}`);
    const { file, ...rest } = p;
    out(stringify(rest).trimEnd());
    return 0;
  }
  throw new UsageError('ids look like FACT-0001, ADR-0001 or P-20261015-abc123');
}

function cmdRemember(flags) {
  const { store, config } = ctx(flags);
  requireBrain(store);
  if (!flags.claim) throw new UsageError('--claim is required');
  const { proposal, applied } = proposeFact(store, { claim: flags.claim, status: flags.status, evidence: flags.evidence ?? [], key: flags.key, category: flags.category, question: flags.question, testBy: flags['test-by'], expiresAfterDays: flags['expires-days'], note: flags.note, supersedes: flags.supersedes }, { config });
  logEvent(store, 'memory', { action: 'propose', proposal: proposal.id, risk: proposal.risk, applied: applied?.id ?? null });
  out(`Proposed ${proposal.id} (risk: ${proposal.risk})${proposal.reasons.length ? ` — ${proposal.reasons.join('; ')}` : ''}`);
  if (applied) out(`Auto-accepted per config (memory.auto_accept_low_risk): recorded as ${applied.id}.`);
  else out(`Pending. Show it to the user (brain show ${proposal.id}); only they can approve it, in their own terminal: brain approve ${proposal.id}${proposal.conflicts.length ? ' [--supersede | --dispute]' : ''}   (or anyone: brain reject ${proposal.id})`);
  return 0;
}

function cmdProposals(flags) {
  const { store } = ctx(flags);
  requireBrain(store);
  const ps = listProposals(store);
  if (flags.json) {
    out(JSON.stringify(ps, null, 2));
    return 0;
  }
  if (!ps.length) out('No pending proposals.');
  for (const p of ps) {
    if (p.error) out(`- ${p.id}: unreadable (${p.error})`);
    else if (p.type === 'decision') out(`- ${p.id} [decision] ${p.decision.title} → ${p.decision.status}`);
    else out(`- ${p.id} [fact, ${p.risk}] [${p.fact.status}] ${truncate(p.fact.claim, 120)}${p.conflicts?.length ? ` (conflicts: ${p.conflicts.join(', ')})` : ''}${p.supersedes ? ` (supersedes ${p.supersedes})` : ''}`);
  }
  return 0;
}

function cmdApprove(flags, pos) {
  const { store } = ctx(flags);
  requireBrain(store);
  if (!pos[0]) throw new UsageError('usage: brain approve <P-…> [--supersede|--dispute]   (must be run by a person in their own terminal)');
  const p = getProposal(store, pos[0]);
  if (!p) throw new Error(`no pending proposal ${pos[0]}`);
  const lines = p.type === 'decision'
    ? [`Decision: ${p.decision.title}`, `Status if approved: ${p.decision.status}`, `Decision text: ${truncate(p.decision.decision, 300)}`]
    : [`Claim: ${truncate(p.fact?.claim ?? '?', 300)}`, `Status: ${p.fact?.status}`, `Evidence: ${(p.fact?.evidence ?? []).map((e) => e.path ?? e.command ?? e.url ?? e.note).join('; ') || 'none'}`, `Risk: ${p.risk}${p.reasons?.length ? ` (${p.reasons.join('; ')})` : ''}`];
  const approval = confirmHuman({ title: `Approve memory proposal ${p.id} (${p.type}) for ${store.root}?`, lines });
  const r = applyProposal(store, pos[0], { resolution: flags.supersede ? 'supersede' : flags.dispute ? 'dispute' : null });
  logEvent(store, 'memory', { action: 'approve', proposal: pos[0], result: r.id, via: approval.via });
  out(`Applied ${pos[0]} → ${r.id}${r.file ? ` (${r.file})` : ''}${r.superseded?.length ? `; superseded ${r.superseded.join(', ')}` : ''}${r.disputed?.length ? `; marked disputed with ${r.disputed.join(', ')}` : ''}${r.answered?.length ? `; answered and closed ${r.answered.join(', ')}` : ''}`);
  return 0;
}

function cmdReject(flags, pos) {
  const { store } = ctx(flags);
  requireBrain(store);
  if (!pos[0]) throw new UsageError('usage: brain reject <P-…> [--reason r]');
  rejectProposal(store, pos[0], flags.reason ?? '');
  logEvent(store, 'memory', { action: 'reject', proposal: pos[0] });
  out(`Rejected ${pos[0]}.`);
  return 0;
}

function cmdDecide(flags) {
  const { store } = ctx(flags);
  requireBrain(store);
  const { proposal } = proposeDecision(store, { title: flags.title, decision: flags.decision, context: flags.context, alternatives: flags.alternative ?? [], consequences: flags.consequences, revisitWhen: flags['revisit-when'], status: flags.status, evidence: flags.evidence ?? [] });
  logEvent(store, 'memory', { action: 'propose-decision', proposal: proposal.id });
  out(`Proposed decision ${proposal.id}. Decisions are always reviewed: show it to the user; only they can approve it, in their own terminal (\`brain approve ${proposal.id}\`).`);
  return 0;
}

function cmdVerify(flags, pos) {
  const { project, store } = ctx(flags);
  requireBrain(store);
  if (flags.confirm) {
    if (pos.length !== 1) throw new UsageError('usage: brain verify <FACT-…> --confirm --evidence <spec> [--status verified|observed]');
    const r = confirmFact(store, pos[0], flags.evidence ?? [], { status: flags.status ?? null });
    logEvent(store, 'memory', { action: 'reverify', fact: r.id, status: r.status });
    out(`${r.id} re-verified on ${r.last_verified} (status ${r.status}).`);
    return 0;
  }
  const facts = (store.loadFacts().doc.facts ?? []).filter((f) => !pos.length || pos.includes(f.id));
  let attention = 0;
  for (const f of facts) {
    const fr = freshness(f, project.root);
    if (['changed', 'missing', 'expired'].includes(fr.state)) attention++;
    if (pos.length || fr.state !== 'fresh') out(`${f.id} [${f.status}] ${fr.state}${fr.reasons.length ? ` — ${fr.reasons.join('; ')}` : ''}`);
  }
  out(`${facts.length} fact(s) checked; ${attention} need re-checking. (This compares evidence hashes and expiry; it does not re-run commands.)`);
  return attention ? 1 : 0;
}

function cmdDeprecate(flags, pos) {
  const { store } = ctx(flags);
  requireBrain(store);
  if (!pos[0]) throw new UsageError('usage: brain deprecate <FACT-…> --reason r');
  deprecateFact(store, pos[0], flags.reason);
  logEvent(store, 'memory', { action: 'deprecate', fact: pos[0] });
  out(`${pos[0]} deprecated.`);
  return 0;
}

function cmdHandoff(flags) {
  const { project, store } = ctx(flags);
  requireBrain(store);
  const r = writeHandoff(store, project, { task: flags.task, done: flags.done, next: flags.next, blockers: flags.blocker, checks: flags.check, assumptions: flags.assumption, agent: flags.agent?.[0] });
  logEvent(store, 'handoff', { file: r.file, checks: r.checks });
  out(`Wrote ${r.file}${r.checks ? '' : ' (no checks reported — the handoff says the work is unverified)'}`);
  return 0;
}

function cmdAudit(flags) {
  const { project, store } = ctx(flags);
  const r = audit(store, project);
  if (flags.json) out(JSON.stringify(r, null, 2));
  else {
    for (const e of r.errors) out(`✖ ${e}`);
    for (const w of r.warnings) out(`! ${w}`);
    for (const i of r.info) out(`· ${i}`);
    out(`${r.errors.length} error(s), ${r.warnings.length} warning(s).`);
  }
  return r.errors.length ? 1 : 0;
}

function cmdIndex(flags, pos) {
  const { store } = ctx(flags);
  requireBrain(store);
  const sub = pos[0] ?? 'status';
  if (sub === 'rebuild') {
    const file = path.join(store.localDir(), 'index.sqlite');
    for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  } else if (sub !== 'status') throw new UsageError('usage: brain index rebuild|status');
  return withIndex(store, (o) => {
    if (!o.index) out(`Index unavailable: ${o.reason}. Search uses a file scan; canonical files are unaffected.`);
    else out(`Index ${o.status}${o.reason ? ` (${o.reason})` : ''}: ${JSON.stringify(o.index.counts())} at ${o.index.file}`);
    return 0;
  });
}

function cmdRoute(flags, pos) {
  const { config } = ctx(flags);
  const prompt = pos.join(' ');
  if (!prompt) throw new UsageError('usage: brain route "<request>"');
  const r = route(prompt, loadRuntimeCatalog(), { maxSkills: config.routing.max_skills, minScore: config.routing.min_score });
  if (flags.json) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  out(`intents: ${r.intents.join(', ') || 'none'}`);
  if (!r.selected.length) out('no skill above threshold');
  for (const s of r.selected) out(`- ${s.id} (score ${s.score}): ${s.reasons.join(', ')}`);
  for (const s of r.supporting) out(`- supporting ${s.id}: ${s.reason}`);
  return 0;
}

function cmdCapabilities(flags, pos) {
  const { store } = ctx(flags);
  const sub = pos[0] ?? 'list';
  const registry = loadCapabilityRegistry();
  if (sub === 'record') {
    requireBrain(store);
    const [capId, state] = pos.slice(1);
    if (!capId || !state) throw new UsageError(`usage: brain capabilities record <capability> <${CAP_STATES.join('|')}> [--access read] [--evidence "…"]`);
    if (!registry.capabilities?.[capId]) throw new Error(`unknown capability "${capId}" (known: ${Object.keys(registry.capabilities ?? {}).join(', ')})`);
    const r = recordCapability(store, capId, state, { evidence: flags.evidence?.[0], access: flags.access ?? [] });
    logEvent(store, 'capability', r);
    out(`${capId}: ${r.from} → ${r.to}`);
    return 0;
  }
  const catalog = loadRuntimeCatalog();
  const state = store.exists() ? loadState(store) : { capabilities: {}, grants: [] };
  if (sub === 'check') {
    const id = pos[1];
    const entry = catalog.find((c) => c.id === id);
    if (!entry) throw new Error(`unknown skill "${id}"`);
    const ev = evaluateSkill({ id, capabilities: entry.capabilities ?? {}, approvals: entry.approvals ?? [] }, state, registry);
    if (store.exists()) logEvent(store, 'capability-check', { skill: id, ready: ev.ready, items: ev.items.map((i) => `${i.capability}:${i.decision}`) });
    if (flags.json) {
      out(JSON.stringify(ev, null, 2));
      return 0;
    }
    out(`${id}: ${ev.blocked ? 'BLOCKED' : ev.ready ? 'ready' : 'needs attention'}`);
    if (!ev.items.length) out('  no external capabilities declared (works with local files/tools only)');
    for (const i of ev.items) out(`- ${i.capability} [${i.importance}, ${i.access}] status=${i.status} → ${i.decision}\n    ${i.message}`);
    for (const a of ev.approvals) out(`- approval required before: ${a.action}${a.always_confirm ? ' (every time)' : ''}`);
    return ev.blocked ? 1 : 0;
  }
  if (sub !== 'list') throw new UsageError('usage: brain capabilities [list|check <skill>|record <capability> <state>]');
  out('Capability registry (integrations/capabilities.yaml) and this project\'s recorded state:');
  for (const [id, def] of Object.entries(registry.capabilities ?? {})) {
    const s = state.capabilities[id];
    const users = catalog.filter((c) => [...(c.capabilities?.required ?? []), ...(c.capabilities?.optional ?? [])].some((d) => d.id === id)).map((c) => c.id);
    out(`- ${id}: ${def.description}\n    state: ${s ? `${s.state}${s.access?.length ? ` (${s.access.join('/')})` : ''} since ${s.at}` : 'not recorded (treated as missing)'}; used by: ${users.join(', ') || 'no skill'}`);
  }
  return 0;
}

function describeTarget(registry, target) {
  if (target.startsWith('action:')) return [`High-impact action: ${target.slice(7)}`];
  const def = registry.capabilities?.[target];
  const tools = Object.entries(def?.claude_code_tools ?? {}).map(([a, pats]) => `${a}: ${pats.join(', ')}`);
  return [`Capability: ${target} — ${def?.description ?? 'unknown'}`, ...(tools.length ? [`Claude Code tools covered: ${tools.join('; ')}`] : []), 'Does NOT authorize high-impact actions (publish, push, merge, deploy, send, delete, spend); those need their own approval.'];
}

function consentStatus(store, registry, config) {
  const st = loadState(store);
  const caps = Object.keys(registry.capabilities ?? {});
  const actions = [...new Set(st.grants.map((g) => g.target).filter((t) => t.startsWith('action:')))];
  const rows = [...caps, ...actions].map((target) => {
    const d = activeDecision(st, target);
    return { target, decision: d?.decision ?? 'none', access: d?.decision === 'granted' ? d.access : null, scope: d?.scope ?? null, expires_at: d?.expires_at ?? null, actor: d?.actor ?? null, at: d?.at ?? null, observed: st.capabilities[target]?.state ?? null };
  });
  const blocked = blockedCapabilities(st, registry, { mode: config.consent.enforcement });
  return { integrity: st.integrity, enforcement: config.consent.enforcement, blocked: blocked.ids, rows, pending: st.requests.filter((r) => r.status === 'pending'), requestsError: st.requestsError };
}

function cmdConsent(flags, pos) {
  const { store, config } = ctx(flags);
  requireBrain(store);
  const [sub, target] = pos;
  const registry = loadCapabilityRegistry();
  const knownTarget = (t) => {
    if (!t) throw new UsageError(`usage: brain consent ${sub} <capability|action:NAME>`);
    if (!t.startsWith('action:') && !registry.capabilities?.[t]) throw new Error(`unknown capability "${t}" (known: ${Object.keys(registry.capabilities ?? {}).join(', ')}); for an action use action:<name>`);
    if (t.startsWith('action:') && !(registry.privileged_actions ?? []).includes(t.slice(7))) throw new Error(`unknown action "${t.slice(7)}" (registered: ${(registry.privileged_actions ?? []).join(', ')})`);
    return t;
  };
  switch (sub) {
    case undefined:
    case 'status':
    case 'verify': {
      const s = consentStatus(store, registry, config);
      if (flags.json) {
        out(JSON.stringify(s, null, 2));
        return s.integrity.ok ? 0 : 1;
      }
      out(`Policy integrity: ${s.integrity.ok ? 'ok' : `FAILED — ${s.integrity.error}. Protected capabilities and actions are blocked (fail closed).`}`);
      out(`Enforcement mode: ${s.enforcement} (host-enforced only where an adapter is installed; see docs/security-model.md)`);
      for (const r of s.rows) out(`- ${r.target}: ${r.decision}${r.access ? ` (${r.access}, ${r.scope}${r.expires_at ? `, until ${r.expires_at}` : ''})` : ''}${r.actor ? ` by ${r.actor}` : ''}${r.observed ? `; observed: ${r.observed}` : ''}${s.blocked.includes(r.target) ? ' [BLOCKED]' : ''}`);
      if (s.pending.length) {
        out('Pending requests (approve only in your own terminal):');
        for (const r of s.pending) out(`  ${r.id}: ${r.target} (${r.access}, ${r.scope})${r.skill ? ` for ${r.skill}` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
      }
      if (s.requestsError) out(`! ${s.requestsError}`);
      return s.integrity.ok ? 0 : 1;
    }
    case 'explain': {
      if (!target) throw new UsageError('usage: brain consent explain <capability|action:NAME|skill>');
      const st = loadState(store);
      const entry = loadRuntimeCatalog().find((c) => c.id === target);
      if (entry) {
        const ev = evaluateSkill({ id: target, capabilities: entry.capabilities ?? {}, approvals: entry.approvals ?? [] }, st, registry);
        if (flags.json) out(JSON.stringify(ev, null, 2));
        else for (const it of ev.items) out(`- ${it.capability} [${it.importance}, ${it.access}] consent=${it.consent} observed=${it.status} → ${it.decision}\n    ${it.message}`);
        if (!ev.items.length) out(`${target} declares no external capabilities.`);
        return 0;
      }
      if (target.startsWith('action:')) {
        const r = authorizeAction(st, knownTarget(target).slice(7));
        out(`${r.decision.toUpperCase()}: ${r.reason}`);
        return 0;
      }
      const it = evaluateCapability({ id: knownTarget(target), access: flags.access?.[0] ?? 'read' }, 'required', st, registry);
      out(`${it.decision}: ${it.message}`);
      return 0;
    }
    case 'request': {
      const r = requestConsent(store, knownTarget(target), { access: flags.access?.[0] ?? 'read', scope: flags.scope ?? 'project', reason: flags.reason ?? null, skill: flags.skill ?? null, session: flags.session ?? null, expiresAt: flags.expires ?? null });
      logEvent(store, 'consent', { action: 'request', request: r.id, target: r.target, access: r.access, scope: r.scope });
      out(`Requested ${r.id}: ${r.target} (${r.access}, ${r.scope}). This changes nothing yet.`);
      out(`The user approves it themselves, in their own terminal (not through the agent): brain consent approve ${r.id}`);
      return 0;
    }
    case 'reject': {
      const r = rejectRequest(store, target);
      logEvent(store, 'consent', { action: 'reject', request: r.id });
      out(`Rejected request ${r.id}.`);
      return 0;
    }
    case 'deny':
    case 'revoke': {
      const r = recordRestriction(store, knownTarget(target), sub === 'deny' ? 'denied' : 'revoked', { note: flags.note ?? null });
      logEvent(store, 'consent', { action: sub, target: r.target, store: r.store });
      out(`Recorded: ${r.target} ${r.decision} (takes effect immediately; recorded in ${r.store === 'policy' ? 'the policy log' : 'the restrictions list because the policy log is not writable here'}). Re-enabling it requires the user's own approval.`);
      return 0;
    }
    case 'approve':
    case 'grant': {
      let req = null;
      let t = target;
      let access = flags.access?.[0] ?? 'read';
      let scope = flags.scope ?? 'project';
      let session = flags.session ?? null;
      let expiresAt = flags.expires ?? null;
      if (sub === 'approve') {
        if (!target) throw new UsageError('usage: brain consent approve <request-id>   (run it yourself in your own terminal)');
        req = loadState(store).requests.find((r) => r.id === target && r.status === 'pending');
        if (!req) throw new Error(`no pending consent request ${target} (see brain consent status)`);
        ({ target: t, access, scope } = req);
        session = req.session ?? null;
        expiresAt = req.expires_at ?? null;
      }
      knownTarget(t);
      const approval = confirmHuman({
        title: `Grant ${t} (${access}, ${scope}${expiresAt ? `, until ${expiresAt}` : ''}) for ${store.root}?`,
        lines: [...describeTarget(registry, t), ...(req ? [`Requested ${req.at}${req.skill ? ` by skill ${req.skill}` : ''}${req.reason ? `: ${req.reason}` : ''}`] : [])],
      });
      const g = recordHumanGrant(store, t, { approval, access, scope, session, expiresAt, note: flags.note ?? null, requestId: req?.id ?? null });
      logEvent(store, 'consent', { action: 'grant', target: t, access, scope, via: approval.via, request: req?.id ?? null });
      out(`Granted ${t} (${access}, ${scope}) as ${g.id}. Connecting the integration (if needed) still happens through the agent host's own flow.`);
      return 0;
    }
    default:
      throw new UsageError('usage: brain consent [status|explain <x>|request <x>|reject <request-id>|deny <x>|revoke <x>|approve <request-id>|grant <x>]');
  }
}

function cmdAuthorize(flags, pos) {
  const { store } = ctx(flags);
  requireBrain(store);
  if (!pos[0]) throw new UsageError('usage: brain authorize <action> [--always-confirm]');
  const r = authorizeAction(loadState(store), pos[0], { alwaysConfirm: Boolean(flags['always-confirm']) });
  if (r.decision === 'allow' && r.grant?.scope === 'once') consumeGrant(store, r.grant.id);
  logEvent(store, 'authorize', { action: pos[0], decision: r.decision });
  out(`${r.decision.toUpperCase()}: ${r.reason}${r.decision === 'allow' && r.grant?.scope === 'once' ? ' (one-time approval now used)' : ''}`);
  return r.decision === 'allow' ? 0 : r.decision === 'ask' ? 3 : 1;
}

function cmdConnect(flags, pos) {
  const id = pos[0];
  const def = loadCapabilityRegistry().capabilities?.[id];
  if (!def) throw new Error(`unknown capability "${id}"`);
  out(`${id}: ${def.description}\nAccess levels: ${def.access_levels.join(', ')}\n`);
  for (const p of def.providers ?? []) out(`- ${p.id} (${p.kind}, host: ${p.host})\n    ${p.setup}\n    ${p.official_setup_url ? `official docs: ${p.official_setup_url} (verified ${p.verified_on})` : 'no verified official link on file'}`);
  out('\nThis command does not install, connect or authorize anything. Complete the host\'s own flow, then record what you verified:');
  out(`  brain capabilities record ${id} available --access read --evidence "<what you checked>"`);
  return 0;
}

function cmdExplain(flags) {
  const { project, store } = ctx(flags);
  requireBrain(store);
  const events = readEvents(store);
  const smoke = hashSession('setup-smoke-test');
  const starts = events.filter((e) => e.type === 'context' && e.session !== smoke);
  const start = starts.at(-1);
  const since = start?.ts ?? events.at(-1)?.ts ?? '';
  const run = events.filter((e) => (e.ts ?? '') >= since && e.session !== smoke);
  if (flags.json) {
    out(JSON.stringify({ project: { root: project.root, id: project.id }, since, events: run }, null, 2));
    return 0;
  }
  out(`Project: ${project.root} (id ${project.id})`);
  if (!run.length) {
    out('No controller activity recorded yet. If hooks are configured, start a new agent session in this folder.');
    return 0;
  }
  out(`Last run: since ${since}${start ? ` (session ${start.session ?? '?'}, ${start.agent ?? '?'})` : ' (no session start recorded; showing latest activity)'}`);
  for (const e of run) {
    const d = e.data ?? {};
    let line;
    if (e.type === 'context') line = `context injected (${d.chars} chars, source ${d.source ?? '?'}) from ${(d.sources ?? []).join(', ') || 'no files'}${d.omitted?.length ? `; omitted ${d.omitted.join(', ')}` : ''}; index ${d.index}; ${d.stale ?? 0} stale fact(s)`;
    else if (e.type === 'route') line = `request routed (prompt ${d.prompt_chars} chars, not stored; intents ${d.intents?.join('+') || 'none'}) → ${d.selected?.map((s) => `${s.id} [${s.reasons.join(', ')}]`).join('; ') || 'no skill'}${d.capability_flags?.length ? `; capability flags: ${d.capability_flags.join(', ')}` : ''}`;
    else if (e.type === 'checkpoint') line = `checkpoint at ${d.event}${d.reason ? ` (${d.reason})` : ''}: ${d.branch ?? '?'} @ ${d.head ?? '?'}, ${d.changed} uncommitted change(s)`;
    else if (e.type === 'enforcement') line = d.rule ? `BLOCKED ${d.tool} (guard: ${d.rule})` : `BLOCKED ${d.tool} (capability ${d.capability}: ${d.reason ?? 'denied by user'})`;
    else line = `${e.type}: ${JSON.stringify(d)}`;
    out(`- ${e.ts.slice(11, 19)} ${line}`);
  }
  out('\nNot recorded by design: prompt text, assistant messages, file contents, credentials.');
  return 0;
}

function cmdDoctor(flags) {
  let problems = 0;
  const ok = (m) => out(`✔ ${m}`);
  const warn = (m) => out(`! ${m}`);
  const bad = (m) => {
    problems++;
    out(`✖ ${m}`);
  };
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`node ${process.versions.node} (${process.execPath})`);
  else bad(`node ${process.versions.node}: need >= 22.13 for node:sqlite (file-only mode still works)`);
  const sq = sqliteStatus();
  sq.available ? ok('node:sqlite available') : warn(`SQLite index unavailable: ${sq.reason} — search falls back to file scan`);
  const catalog = readJsonIfExists(CATALOG_FILE);
  catalog ? ok(`skill catalog: ${catalog.skills.length} skills (${CATALOG_FILE})`) : bad(`skill catalog missing (${CATALOG_FILE}); run node scripts/build-catalog.js`);
  const { project, store, warnings } = ctx(flags);
  for (const w of warnings) warn(w);
  if (!store.exists()) warn(`no project brain in ${project.root}`);
  else {
    const r = audit(store, project);
    r.errors.length ? bad(`brain audit: ${r.errors.length} error(s) — run brain audit`) : ok(`brain files valid (${r.warnings.length} warning(s); run brain audit)`);
    withIndex(store, (o) => (o.index ? ok(`index ${o.status}: ${JSON.stringify(o.index.counts())}${o.reason ? ` — ${o.reason}` : ''}`) : warn(`index unavailable: ${o.reason}`)));
    const errs = readEvents(store, { tail: 300 }).filter((e) => e.type === 'error');
    errs.length ? warn(`${errs.length} recent hook error(s); latest: ${errs.at(-1).data?.message}`) : ok('no recent hook errors');
    const last = readEvents(store, { tail: 300 }).filter((e) => e.type === 'context' && e.session !== hashSession('setup-smoke-test')).at(-1);
    last ? ok(`last session-start context: ${last.ts}`) : warn('no session-start context recorded from a real agent session yet');
  }
  const inst = installState(project);
  const pathNode = spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim() || null;
  for (const [scope, m] of [['project', inst.local], ['global', inst.global]]) {
    if (!m) continue;
    if (m.state && m.state !== 'complete') bad(`${scope}: setup was interrupted (state "${m.state}"); review with \`brain setup --dry-run\`, then \`brain repair\` or \`brain uninstall\``);
    const integrity = verifyControllerFiles(m.controller?.files);
    if (!integrity.recorded) warn(`${scope}: no controller checksums recorded (installed by an older version) — run brain repair`);
    else if (integrity.ok) ok(`${scope}: controller files match the state approved at setup (${Object.keys(m.controller.files).length} files; trust-on-first-use, not proof of upstream authenticity)`);
    else bad(`${scope}: controller files changed since setup — modified: ${integrity.modified.join(', ') || '—'}; missing: ${integrity.missing.join(', ') || '—'}; new: ${integrity.added.join(', ') || '—'}. Review (git diff/log in ${REPO_ROOT}), then brain repair`);
    if (!exists(m.controller.node)) warn(`${scope}: recorded node ${m.controller.node} no longer exists; hooks fall back to PATH node (${pathNode ?? 'none found!'}${pathNode ? `, ${spawnSync(pathNode, ['--version'], { encoding: 'utf8' }).stdout.trim()}` : ''}) — run brain repair to record it`);
    else ok(`${scope}: hook runtime ${m.controller.node}`);
    for (const e of m.entries.filter((x) => x.kind === 'claude-settings')) {
      const text = exists(e.path) ? fs.readFileSync(e.path, 'utf8') : null;
      if (text === null) {
        bad(`${scope}: ${e.path} is missing — run brain repair`);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        bad(`${scope}: ${e.path} is not valid JSON`);
        continue;
      }
      const expected = mergeClaudeSettings(parsed, m.controller, { enforceDenials: m.enforce_denials !== false });
      const n = text.split(OWNER_MARK).length - 1;
      if (JSON.stringify(expected.hooks ?? {}) === JSON.stringify(parsed.hooks ?? {})) ok(`${scope}: ${n} owned Claude Code hook(s) in ${e.path} match the expected configuration`);
      else bad(`${scope}: owned hooks in ${e.path} are missing or were modified — review, then brain repair`);
      if (e.hardening) {
        const dw = parsed.sandbox?.filesystem?.denyWrite ?? [];
        const missingDw = e.hardening.denyWrite.filter((x) => !dw.includes(x));
        if (parsed.sandbox?.enabled === false) bad(`${scope}: hardening recorded but sandbox.enabled is false`);
        else if (missingDw.length) bad(`${scope}: hardening denyWrite entries missing: ${missingDw.join(', ')}`);
        else ok(`${scope}: OS sandbox hardening configured (effective only where Claude Code's sandbox runs)`);
      }
    }
    const pkg = readJsonIfExists(path.join(REPO_ROOT, 'package.json'));
    if (m.controller.version !== pkg?.version) warn(`${scope}: configured with controller v${m.controller.version}, current is v${pkg?.version} — run brain repair`);
  }
  if (store.exists()) {
    const st = loadState(store);
    st.integrity.ok ? ok('consent policy log verifies') : bad(`consent policy integrity FAILED: ${st.integrity.error} (protected capabilities fail closed)`);
  }
  if (!inst.local && !inst.global) warn('no adapters configured (brain setup); manual CLI/file use only');
  out(problems ? `${problems} problem(s) found.` : 'No blocking problems found.');
  return problems ? 1 : 0;
}

function cmdRuntime(flags) {
  const { project, store } = ctx(flags);
  out('Runtime model: short-lived CLI processes launched by agent hooks; no daemon, no network listener.');
  const inst = installState(project);
  out(`Configured: project ${inst.local ? inst.local.agents.join('+') : 'no'}; global ${inst.global ? inst.global.agents.join('+') : 'no'}`);
  if (!store.exists()) return 0;
  const events = readEvents(store, { tail: 500 });
  for (const t of ['context', 'route', 'checkpoint', 'enforcement', 'error']) {
    const e = events.filter((x) => x.type === t).at(-1);
    out(`  last ${t.padEnd(11)} ${e ? e.ts : '—'}`);
  }
  return 0;
}

function fmtExp(e) {
  const m = (e.runs ?? []).length ? Object.keys(e.runs[0].metrics ?? {}).filter((k) => !/^(epoch|step|steps|iter|iteration|global_step|batch)$/i.test(k)).slice(0, 3) : [];
  const stats = m.map((k) => {
    const v = e.runs.map((r) => r.metrics[k]).filter((x) => typeof x === 'number');
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return `${k}=${Math.round(mean * 10000) / 10000}${v.length > 1 ? ` (n=${v.length})` : ''}`;
  });
  return `${e.id} [${e.status}] ${e.title}${e.baseline ? ` (baseline ${e.baseline})` : ''}${stats.length ? ` — ${stats.join(', ')}` : ''}${(e.comparisons ?? []).length ? ` — vs ${e.comparisons.map((c) => `${c.against}: ${c.verdict}`).join('; ')}` : ''}`;
}

function cmdExp(flags, pos) {
  const { project, store } = ctx(flags);
  requireBrain(store);
  const [sub, a, b] = pos;
  switch (sub) {
    case 'start': {
      const e = startExperiment(store, project, { title: flags.title, question: flags.question, hypothesis: flags.hypothesis, baseline: flags.baseline, configs: flags.config ?? [], data: flags.data ?? [], split: flags.split, seeds: flags.seed ?? [], python: flags.python, probeEnv: !flags['no-env-probe'] });
      logEvent(store, 'experiment', { action: 'start', id: e.id });
      out(`Started ${e.id}: ${e.title}`);
      out(`  code: ${e.code ? `${e.code.branch} @ ${e.code.commit ?? 'no commits'}${e.code.uncommitted_changes ? ` (+${e.code.uncommitted_changes} uncommitted change(s) — commit first for exact reproducibility)` : ''}` : 'not a git repository'}`);
      out(`  config: ${e.config.map((c) => `${c.path} (${c.sha256})`).join(', ') || 'none recorded'}; data: ${e.data.map((d) => `${d.role}=${d.path} (${d.sha256}${d.hash_mode !== 'full' ? `, ${d.hash_mode}` : ''})`).join(', ') || 'none recorded'}`);
      out(`  seeds: ${e.seeds.join(', ') || 'none recorded'}; environment: ${e.environment.python ? `python ${e.environment.python}` : 'python not probed'}${e.environment.libraries ? `, ${Object.entries(e.environment.libraries).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}${e.environment.gpus ? `, GPU ${e.environment.gpus.join('; ')}` : ''}`);
      out(`Next: run it, then \`brain exp log ${e.id} --from <results.json|csv> [--seed N]\`, then \`brain exp finish ${e.id} --status completed\`.`);
      return 0;
    }
    case 'log': {
      const e = logMetrics(store, project, a, { from: flags.from, select: flags.select ? String(flags.select).split(',').map((x) => x.trim()) : null, row: flags.row ?? null, seed: flags.seed?.[0] ?? null });
      const r = e.runs.at(-1);
      logEvent(store, 'experiment', { action: 'log', id: e.id, metrics: Object.keys(r.metrics).length });
      out(`Logged run ${e.runs.length} of ${e.id}${r.seed !== null ? ` (seed ${r.seed})` : ''} from ${r.source.path} [${r.source.locator}]: ${Object.entries(r.metrics).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      return 0;
    }
    case 'finish': {
      const e = finishExperiment(store, a, { status: flags.status, conclusion: flags.conclusion ?? null });
      logEvent(store, 'experiment', { action: 'finish', id: e.id, status: e.status });
      out(`${e.id} → ${e.status}.${e.status === 'completed' && e.baseline ? ` Compare it honestly: brain exp compare ${e.baseline} ${e.id} --metric <name>` : ''}`);
      return 0;
    }
    case 'compare': {
      if (!a || !b || !flags.metric) throw new UsageError('usage: brain exp compare <baseline EXP> <candidate EXP> --metric <name> [--lower-better] [--alpha 0.05] [--min-seeds 3] [--no-record]');
      const opts = { higherIsBetter: !flags['lower-better'], alpha: flags.alpha ? Number(flags.alpha) : 0.05, minSeeds: flags['min-seeds'] ? Number(flags['min-seeds']) : 3, baselineMetric: flags['baseline-metric'] ?? null };
      const r = flags['no-record'] ? compareExperiments(getExperiment(store, a), getExperiment(store, b), flags.metric, opts) : recordComparison(store, a, b, flags.metric, opts);
      logEvent(store, 'experiment', { action: 'compare', baseline: a, candidate: b, metric: flags.metric, verdict: r.verdict });
      if (flags.json) {
        out(JSON.stringify(r, null, 2));
        return 0;
      }
      out(`${b} vs ${a} on ${flags.metric} (${opts.higherIsBetter ? 'higher' : 'lower'} is better): ${r.verdict.toUpperCase()}`);
      if (r.summary) for (const [id, s] of Object.entries(r.summary)) out(`  ${id}: mean ${s.mean} ± ${s.sd} (sd), n=${s.n}`);
      if (r.difference !== undefined) out(`  difference ${r.difference}${r.relative_change_pct !== null ? ` (${r.relative_change_pct}%)` : ''}${r.test ? `; ${r.test.name}: t=${r.test.t}, df=${r.test.df}, p=${r.test.p}` : ''}`);
      for (const x of [...(r.reasons ?? []), ...(r.warnings ?? []), ...(r.caveats ?? [])]) out(`  - ${x}`);
      return 0;
    }
    case 'show': {
      const e = getExperiment(store, a);
      out(flags.json ? JSON.stringify(e, null, 2) : stringify(e).trimEnd());
      return 0;
    }
    case undefined:
    case 'list': {
      const all = listExperiments(store);
      if (flags.json) out(JSON.stringify(all, null, 2));
      else if (!all.length) out('No experiments recorded. Start one with: brain exp start --title "..." --config <file> --data train=<file> --seed 1');
      else for (const e of all) out(e.error ? `${e.id}: unreadable (${e.error})` : fmtExp(e));
      return 0;
    }
    default:
      throw new UsageError('usage: brain exp start|log|finish|compare|list|show (see brain help)');
  }
}

const COMMANDS = {
  setup: cmdSetup, repair: cmdRepair, uninstall: cmdUninstall, init: cmdInit, status: cmdStatus, context: cmdContext, search: cmdSearch, show: cmdShow,
  remember: cmdRemember, proposals: cmdProposals, approve: cmdApprove, reject: cmdReject, decide: cmdDecide, verify: cmdVerify, deprecate: cmdDeprecate,
  handoff: cmdHandoff, audit: cmdAudit, index: cmdIndex, route: cmdRoute, capabilities: cmdCapabilities, consent: cmdConsent, authorize: cmdAuthorize,
  connect: cmdConnect, 'explain-last-run': cmdExplain, doctor: cmdDoctor, runtime: cmdRuntime, exp: cmdExp,
};

export async function main(argv) {
  if (argv[0] === 'hook') {
    await runHookProcess(argv[1], argv[2]);
    return process.exitCode ?? 0;
  }
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const [cmd, ...rest] = parsed.pos;
  if (!cmd || parsed.flags.help || cmd === 'help') {
    out(HELP);
    return cmd || parsed.flags.help ? 0 : 2;
  }
  if (cmd === 'version' || cmd === '--version') {
    out(readJsonIfExists(path.join(REPO_ROOT, 'package.json'))?.version ?? 'unknown');
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    process.stderr.write(`unknown command "${cmd}". Run brain help.\n`);
    return 2;
  }
  try {
    return (await fn(parsed.flags, rest)) ?? 0;
  } catch (e) {
    if (e instanceof HumanApprovalRequired) {
      process.stderr.write(`human approval required: ${e.message}\n`);
      return 4;
    }
    process.stderr.write(`${e instanceof UsageError ? '' : 'error: '}${e.message}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

