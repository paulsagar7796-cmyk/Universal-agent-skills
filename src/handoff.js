import { gitState } from './project.js';
import { replaceGenerated } from './store.js';
import { assertNoSecrets } from './secrets.js';
import { slugify, writeFileAtomic } from './util.js';

export const CHECK_RESULTS = ['passed', 'failed', 'not-run', 'blocked'];

/** Parse "<command>=<result>[: note]" e.g. "npm test=passed" or "npm run e2e=not-run: needs browser". */
export function parseCheck(spec) {
  const m = String(spec).match(/^(.+?)=(passed|failed|not-run|blocked)(?::\s*(.*))?$/s);
  if (!m) throw new Error(`--check must look like "<command>=passed|failed|not-run|blocked[: note]" (got ${JSON.stringify(spec)})`);
  return { command: m[1].trim(), result: m[2], note: m[3]?.trim() || null };
}

function list(items, empty = '_None._') {
  return items?.length ? items.map((i) => `- ${i}`).join('\n') : empty;
}

/** Write a restart note into handoffs/ and point status.md at it. Git state is captured automatically. */
export function writeHandoff(store, project, input, { now = new Date() } = {}) {
  if (!input.task || !String(input.task).trim()) throw new Error('--task is required (what was being worked on)');
  const checks = (input.checks ?? []).map((c) => (typeof c === 'string' ? parseCheck(c) : c));
  const g = project.isRepo ? gitState(project.root) : null;
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13); // YYYYMMDDTHHMM
  const datePart = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}-${stamp.slice(9, 13)}`;
  const file = `handoffs/${datePart}-${slugify(input.task, 40)}.md`;
  const changed = g ? g.changed.map((c) => `\`${c.path}\` (${c.status})`) : [];
  const text = [
    `# Handoff: ${input.task}`,
    '',
    `- Written: ${now.toISOString()} by ${input.agent ?? 'agent'}`,
    g ? `- Git: ${g.branch ?? '?'} @ ${g.head ?? 'no commits'}; ${g.changedCount} uncommitted change(s)${g.truncated ? ' (list truncated)' : ''}` : '- Git: not a repository',
    '',
    '## Done',
    list(input.done),
    '',
    '## Checks',
    checks.length ? checks.map((c) => `- \`${c.command}\` — **${c.result}**${c.note ? ` (${c.note})` : ''}`).join('\n') : '_No checks reported. Treat the work as unverified._',
    '',
    '## Next steps',
    list(input.next),
    '',
    '## Blockers',
    list(input.blockers),
    '',
    '## Unverified assumptions',
    list(input.assumptions),
    '',
    '## Uncommitted files at handoff',
    list(changed, '_None (or not a git repository)._'),
    '',
  ].join('\n');
  assertNoSecrets(text, 'handoff');
  writeFileAtomic(store.p(file), text);
  const statusText = store.read('status.md') ?? '# Status\n';
  writeFileAtomic(store.p('status.md'), replaceGenerated(statusText, 'last-handoff', `Last handoff: [${file.replace('handoffs/', '')}](${file}) — ${input.task}`));
  return { file, checks: checks.length };
}
