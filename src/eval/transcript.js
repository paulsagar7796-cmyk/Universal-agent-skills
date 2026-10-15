// Provider-neutral transcript: what the agent said and did. Providers translate their native output into this shape.
//
// {
//   provider, model, host_version, available_skills: [],
//   final_text: string,
//   events: [ { type: 'tool_use', id, name, input } | { type: 'tool_result', id, is_error, text } | { type: 'text', text } ],
//   skills_loaded: [names], usage: { cost_usd, turns, duration_ms }, is_error, error
// }
import { findSecrets, redactSecrets } from '../secrets.js';
import { truncate } from '../util.js';

/** Parse Claude Code `--output-format stream-json --verbose` lines (format observed on Claude Code 2.1.300). */
export function parseClaudeStream(text) {
  const t = { provider: 'claude-code', model: null, host_version: null, available_skills: [], final_text: '', events: [], skills_loaded: [], usage: {}, is_error: false, error: null, unparsed_lines: 0 };
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      t.unparsed_lines++;
      continue;
    }
    if (d.type === 'system' && d.subtype === 'init') {
      t.model = d.model ?? t.model;
      t.host_version = d.claude_code_version ?? null;
      t.available_skills = Array.isArray(d.skills) ? d.skills : [];
    } else if (d.type === 'assistant') {
      for (const c of d.message?.content ?? []) {
        if (c.type === 'tool_use') {
          t.events.push({ type: 'tool_use', id: c.id ?? null, name: c.name, input: c.input ?? {} });
          if (c.name === 'Skill' && c.input?.skill) t.skills_loaded.push(String(c.input.skill));
        } else if (c.type === 'text' && c.text) t.events.push({ type: 'text', text: c.text });
      }
      if (d.message?.model) t.model = d.message.model;
    } else if (d.type === 'user') {
      const content = Array.isArray(d.message?.content) ? d.message.content : [];
      for (const c of content) {
        if (c?.type === 'tool_result') {
          const body = Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('\n') : String(c.content ?? '');
          t.events.push({ type: 'tool_result', id: c.tool_use_id ?? null, is_error: c.is_error === true, text: body });
        }
      }
    } else if (d.type === 'result') {
      t.final_text = typeof d.result === 'string' ? d.result : t.final_text;
      t.is_error = d.is_error === true || (d.subtype && d.subtype !== 'success');
      if (t.is_error) t.error = `result subtype ${d.subtype}`;
      t.usage = { cost_usd: d.total_cost_usd ?? null, turns: d.num_turns ?? null, duration_ms: d.duration_ms ?? null };
    }
  }
  if (!t.final_text) {
    const texts = t.events.filter((e) => e.type === 'text');
    t.final_text = texts.at(-1)?.text ?? '';
  }
  // Skills can also be followed by reading their SKILL.md directly.
  for (const e of t.events) {
    if (e.type === 'tool_use' && e.name === 'Read') {
      const m = String(e.input?.file_path ?? '').match(/\/([a-z0-9-]+)\/SKILL\.md$/);
      if (m && !t.skills_loaded.includes(m[1])) t.skills_loaded.push(m[1]);
    }
  }
  return t;
}

/** All text an agent produced or passed to tools (used for disclosure checks and evidence validation). */
export function transcriptCorpus(t) {
  const parts = [t.final_text ?? ''];
  for (const e of t.events ?? []) {
    if (e.type === 'text') parts.push(e.text);
    if (e.type === 'tool_use') parts.push(JSON.stringify(e.input ?? {}));
  }
  return parts.join('\n');
}

/**
 * Redact and truncate a transcript before it is written to disk: credentials, the planted canary, absolute workspace
 * and home paths. Tool results are cut short (they can contain file contents).
 */
export function sanitiseTranscript(t, { workspace = null, home = null, canary = null, maxText = 4000, maxInput = 600, maxResult = 300 } = {}) {
  const clean = (s, max) => {
    let x = String(s ?? '');
    if (canary) x = x.split(canary).join('[CANARY]');
    if (workspace) x = x.split(workspace).join('<workspace>');
    if (home) x = x.split(home).join('~');
    x = redactSecrets(x);
    return truncate(x, max);
  };
  return {
    ...t,
    final_text: clean(t.final_text, maxText),
    events: (t.events ?? []).map((e) => (e.type === 'tool_use' ? { ...e, input: JSON.parse(JSON.stringify(e.input ?? {}), (k, v) => (typeof v === 'string' ? clean(v, maxInput) : v)) } : e.type === 'tool_result' ? { ...e, text: clean(e.text, maxResult) } : { ...e, text: clean(e.text, maxText) })),
    available_skills: t.available_skills ?? [],
    redaction: { secrets_found_before_redaction: findSecrets(transcriptCorpus(t)).length > 0 },
  };
}
