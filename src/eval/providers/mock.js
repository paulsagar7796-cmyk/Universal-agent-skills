// Deterministic offline provider. Replays scripted behaviour from evals/mock/responses.yaml so the harness itself
// (workspaces, checks, grading, retries, timeouts, reports) can be tested without a model, network or credentials.
// Mock results measure the HARNESS, never skill quality.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../../yaml.js';
import { REPO_ROOT } from '../../catalog.js';
import { ProviderError } from '../errors.js';
import { readTextIfExists } from '../../util.js';

const RESPONSES = path.join(REPO_ROOT, 'evals', 'mock', 'responses.yaml');
const attempts = new Map();

export function loadMockResponses(file = RESPONSES) {
  const text = readTextIfExists(file);
  return text ? parse(text) ?? {} : {};
}

export const mockProvider = {
  id: 'mock',
  live: false,
  capabilities: { reportsSkillLoading: true, sandboxedShell: false, costReported: false },
  describe() {
    return { name: 'mock (deterministic replay)', model: 'none', version: '1', notes: ['Scripted transcripts from evals/mock/responses.yaml; results test the harness, not skills.'] };
  },
  plan(cases) {
    return { invocations: cases.length, perInvocationBudgetUsd: 0, notes: ['offline; no model calls, no network, no cost'] };
  },
  async run(c, ws, opts = {}) {
    const all = opts.responses ?? loadMockResponses();
    const r = all.cases?.[c.id] ?? all.default ?? { final_text: `MOCK: no scripted behaviour for ${c.id}.` };
    const n = (attempts.get(`${opts.runId}:${c.id}`) ?? 0) + 1;
    attempts.set(`${opts.runId}:${c.id}`, n);
    if (r.fail_attempts && n <= r.fail_attempts) {
      throw new ProviderError(`mock transient failure (attempt ${n})`, { transient: true });
    }
    if (r.hang_ms) await new Promise((res) => setTimeout(res, r.hang_ms));
    if (r.error) {
      throw new ProviderError(String(r.error), { transient: false });
    }
    for (const w of r.file_writes ?? []) {
      const p = path.join(ws.dir, w.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (w.append !== undefined) fs.appendFileSync(p, String(w.append));
      else fs.writeFileSync(p, String(w.content ?? ''));
    }
    const finalText = String(r.final_text ?? '').replaceAll('{{CANARY}}', ws.canary);
    const events = [];
    for (const tc of r.tool_calls ?? []) {
      const input = JSON.parse(JSON.stringify(tc.input ?? {}).replaceAll('{{CANARY}}', ws.canary).replaceAll('{{WS}}', ws.dir));
      events.push({ type: 'tool_use', id: null, name: tc.name, input });
      events.push({ type: 'tool_result', id: null, is_error: tc.is_error === true, text: String(tc.result ?? '') });
    }
    if (finalText) events.push({ type: 'text', text: finalText });
    return { provider: 'mock', model: 'mock', host_version: '1', available_skills: ws.skills, final_text: finalText, events, skills_loaded: r.skills_loaded ?? [], usage: { cost_usd: 0, turns: (r.tool_calls ?? []).length + 1, duration_ms: 0 }, is_error: false, error: null };
  },
  async judge(req, opts = {}) {
    // Deterministic judge for harness tests: verdicts scripted per case in responses.yaml under judge:.
    const all = opts.responses ?? loadMockResponses();
    return all.cases?.[req.caseId]?.judge ?? [];
  },
};
