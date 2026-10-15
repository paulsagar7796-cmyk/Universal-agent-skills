# Handoff: MVP 0.1.0 of agent-skills-brain

- Written: 2026-10-15T13:51:41.690Z by agent
- Git: main @ no commits; 21 uncommitted change(s)

## Done
- 17 draft skills with manifests and 102 eval cases
- brain controller, Claude Code adapter, broker, setup/uninstall
- docs, schemas, templates, CI workflow

## Checks
- `node --test tests/*.test.js` — **passed** (72/72 on Node 24.21; 67 pass + 5 skipped on Node 22.13.0)
- `node scripts/run-evals.js` — **passed** (routing 59/59)
- `skills-ref validate` — **passed** (17/17)
- `GitHub Actions CI` — **not-run** (no remote configured)
- `behaviour evals` — **not-run** (no agent harness yet)

## Next steps
- Owner: review and accept or reject ADR-0001; fill SECURITY.md contact; choose final name/license
- Build the behaviour-eval harness (docs/roadmap.md item 1)
- Codex adapter, verified on a real Codex install

## Blockers
_None._

## Unverified assumptions
- Apache-2.0 is acceptable to the owner

## Uncommitted files at handoff
- `.agent-brain/` (??)
- `.github/` (??)
- `.gitignore` (??)
- `AGENTS.md` (??)
- `CHANGELOG.md` (??)
- `CONTRIBUTING.md` (??)
- `LICENSE` (??)
- `README.md` (??)
- `SECURITY.md` (??)
- `bin/` (??)
- `catalog/` (??)
- `docs/` (??)
- `evals/` (??)
- `integrations/` (??)
- `package.json` (??)
- `schemas/` (??)
- `scripts/` (??)
- `skills/` (??)
- `src/` (??)
- `templates/` (??)
- `tests/` (??)
