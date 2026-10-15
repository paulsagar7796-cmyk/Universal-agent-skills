// Provider registry and interface.
//
// A provider runs one case in a prepared workspace and returns a provider-neutral transcript (see ../transcript.js).
// It must not grade: grading is done by ../grade.js from observable behaviour.
//
//   {
//     id: 'my-agent',
//     live: boolean,                       // true when it calls a model / spends money
//     capabilities: {
//       reportsSkillLoading: boolean,      // can tell which skill the agent loaded
//       sandboxedShell: boolean,           // agent shell runs under an OS sandbox
//       costReported: boolean,
//     },
//     describe(opts) → { name, model, version, notes: [] }
//     plan(cases, opts) → { invocations, perInvocationBudgetUsd, notes: [] }   // no side effects
//     async run(evalCase, workspace, opts) → transcript                         // throw ProviderError on failure
//     async judge?(request, opts) → [{ criterion, verdict: 'pass'|'fail'|'unclear', evidence: [quotes] }]
//   }
//
// Adding a provider (e.g. Codex): implement the object above in providers/<id>.js and register it below. Do not assume
// another agent loads skills the same way as Claude Code: report skills_loaded only when the agent's output shows it,
// otherwise leave it undefined so `skill_loaded` checks report "not observable" instead of failing or passing.
import { mockProvider } from './mock.js';
import { claudeCodeProvider } from './claude-code.js';

export { ProviderError } from '../errors.js';

export const PROVIDERS = { mock: mockProvider, 'claude-code': claudeCodeProvider };

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider "${id}" (available: ${Object.keys(PROVIDERS).join(', ')})`);
  return p;
}
