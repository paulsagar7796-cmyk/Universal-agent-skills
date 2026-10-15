# Evaluation guide

## What runs today (offline, in CI)

| Check | Script | Result on 2026-10-15 |
|---|---|---|
| Spec + policy validation | `scripts/validate-skills.js` | 17 skills, 0 errors, 0 warnings |
| Official validator | `skills-ref validate` (CI job, pinned commit) | 17/17 valid (run locally) |
| Static security scan | `scripts/scan-skills.js` | 0 unexcepted high/medium; 1 reviewed exception |
| Secret scan | `scripts/scan-secrets.js` | 0 findings |
| Routing evals | `scripts/run-evals.js` | 59/59 cases pass; top-1 on 50/51 positive cases |
| Controller tests | `node --test tests/*.test.js` | Node 24.21: 73/73 pass. Node 22.13.0: 68 pass, 5 skipped (SQLite FTS5 unavailable), 0 fail |

Routing evals check that each `routing: true` prompt selects its skill within the router's top 3, and that shared
negative cases (`evals/shared-cases/routing.yaml`) select nothing or avoid near-miss skills. They measure the router,
not model behaviour.

## Behaviour evals (written, not yet run)

Each skill has cases of kinds `typical`, `edge`, `ambiguous`, `unsupported-claim`, `untrusted-input` with
`expect.must` / `expect.must_not` observable behaviours — 102 cases in total. Running them requires an agent harness
(fixture workspace, agent CLI, transcript capture) and grading (human, or an LLM judge checked against human labels).
`scripts/run-evals.js` reports `behaviour_cases.run: 0` until that harness exists. Candidate harnesses: a small custom
runner around `claude -p` / `codex exec` in temporary fixture repos, or Promptfoo.

Grading rubric per case (0 = fail, 1 = partial, 2 = pass): task success · grounding/evidence · verification honesty ·
clarification behaviour · safety/permission discipline · output usability · memory-update quality. Report per-case
results and failure reasons, never only an average.

## Maturity labels

| Label | Requirements |
|---|---|
| draft | Passes validation, scans and routing evals. **All current skills.** |
| community | Published for use; not fully reviewed by maintainers. |
| reviewed | A maintainer other than the author reviewed it with the `skill-reviewer` rubric; provenance/license checked; security checklist done; behaviour cases run on at least one agent with results recorded. |
| verified | Reviewed + the full eval suite passed on named agent/model/version combinations on a stated date; results committed under `evals/reports/`. Verification is per combination, not universal. |
| deprecated | Kept for migration; not recommended. |

## Brain evals

Covered by automated tests: correct fact retrieval among decoys (search tests), stale/changed/missing evidence
detection, conflicts becoming disputed, provenance preserved through refresh/supersede, no fabricated commands
(init records "declared, not run"), fake secrets rejected, handoff readable by a second session (e2e), index rebuild
after deletion/corruption with identical results.

Not yet measured: initialisation precision on a benchmark of diverse public repositories with human-labelled
expected facts (planned: frontend app, backend API, data/ML repo, CLI tool, monorepo, repo with stale docs).
