# Handoff: Phase 2: consent hardening and behavioural evaluation harness

- Written: 2026-10-15T15:02:26.337Z by agent
- Git: main @ c471fab; 65 uncommitted change(s) (list truncated)

## Done
- Human-only approvals, hash-chained consent policy, PreToolUse guard, --harden sandbox option (host-verified on Claude Code 2.1.300)
- Evaluation harness with mock and claude-code providers; 48/181 expectations structured
- Setup integrity: checksums, journal, PATH fallback, doctor/repair

## Checks
- `node --test tests/*.test.js` — **passed** (107/107 Node 24.21; 102 pass + 5 skipped Node 22.13.0)
- `node scripts/eval.js run --provider mock --judge mock` — **passed** (deterministic, 0 errors (tests the harness only))
- `skills-ref validate` — **passed** (17/17 + template)
- `live behavioural run (102 cases)` — **not-run** (needs owner budget approval)
- `GitHub Actions CI with phase-2 changes` — **not-run** (nothing committed or pushed)

## Next steps
- Owner: approve pending proposal for verification.baseline (brain approve, in your terminal)
- Owner: decide release policy, live-eval budget, ADR-0001, license, security contact
- Run first live eval: node scripts/eval.js run --provider claude-code --model haiku --budget 0.25 --dry-run

## Blockers
- Live evaluation and CI run need owner decisions

## Unverified assumptions
_None._

## Uncommitted files at handoff
- `.github/workflows/ci.yml` (M)
- `.gitignore` (M)
- `AGENTS.md` (M)
- `CHANGELOG.md` (M)
- `README.md` (M)
- `SECURITY.md` (M)
- `docs/architecture.md` (M)
- `docs/brain-spec.md` (M)
- `docs/compatibility.md` (M)
- `docs/evaluation-guide.md` (M)
- `docs/roadmap.md` (M)
- `docs/security-model.md` (M)
- `package.json` (M)
- `schemas/eval-cases.schema.json` (M)
- `skills/business/business-analyst/evals/cases.yaml` (M)
- `skills/engineering/code-review/evals/cases.yaml` (M)
- `skills/engineering/documentation-engineering/evals/cases.yaml` (M)
- `skills/engineering/software-engineer/evals/cases.yaml` (M)
- `skills/engineering/systematic-debugging/evals/cases.yaml` (M)
- `skills/engineering/test-driven-development/evals/cases.yaml` (M)
- `skills/meta/brain-curator/SKILL.md` (M)
- `skills/meta/brain-curator/evals/cases.yaml` (M)
- `skills/meta/codebase-explorer/evals/cases.yaml` (M)
- `skills/meta/project-initializer/evals/cases.yaml` (M)
- `skills/meta/skill-author/evals/cases.yaml` (M)
- `skills/meta/task-planner/evals/cases.yaml` (M)
- `skills/meta/verification-before-completion/evals/cases.yaml` (M)
- `skills/research/source-verification/evals/cases.yaml` (M)
- `skills/research/web-research/SKILL.md` (M)
- `skills/research/web-research/evals/cases.yaml` (M)
- `skills/security/skill-package-audit/evals/cases.yaml` (M)
- `src/broker.js` (M)
- `src/cli.js` (M)
- `src/config.js` (M)
- `src/context.js` (M)
- `src/hooks.js` (M)
- `src/init.js` (M)
- `src/secrets.js` (M)
- `src/setup.js` (M)
- `src/validate.js` (M)
- `templates/project-brain/README.md` (M)
- `templates/project-brain/config.yaml` (M)
- `tests/broker.test.js` (M)
- `tests/e2e-lifecycle.test.js` (M)
- `tests/helpers.js` (M)
- `tests/hooks.test.js` (M)
- `tests/index.test.js` (M)
- `tests/setup.test.js` (M)
- `docs/operations.md` (??)
- `docs/phase2-plan.md` (??)
