# Implementation plan (MVP)

Status: written before coding on 2026-10-15; updated at the end of the MVP pass.
Source specification: `universal_agent_skills_brain_report.md` (research report, 15 Oct 2026).

## Intended architecture (summary)

| Layer | What ships in the MVP |
|---|---|
| A. Skills | 17 first-party skills in `skills/<category>/<name>/` using the open Agent Skills format |
| B. Catalog | `catalog/skills.json` + `catalog/README.md`, generated from `SKILL.md` frontmatter + a sidecar `manifest.yaml` |
| C. Brain | `.agent-brain/` canonical Markdown/YAML in each project (template in `templates/project-brain/`) |
| D. Controller | `brain` CLI (`bin/brain.js`), short-lived, local-only, no daemon |
| E. Adapters | Claude Code lifecycle hooks (tested); `AGENTS.md` instruction block as a manual fallback for other agents |
| F. Quality | validators, security scanner, routing evals, unit/integration tests, CI |
| G. Bootstrap | `brain setup` explicit, consent-gated, dry-run, backups, idempotent, reversible |
| H. Broker | `manifest.yaml` capability declarations, consent store, capability state machine |

## Constraints taken from the spec

- Agent Skills spec (checked 2026-10-15): `name` ≤64 chars `[a-z0-9-]`, no leading/trailing/double hyphen, must match folder;
  `description` 1–1024 chars; optional `license`, `compatibility` (≤500), `metadata` (**string→string map only**), `allowed-tools`.
  Therefore structured metadata (capabilities, provenance, routing triggers) lives in a sidecar `manifest.yaml`, not in frontmatter.
- No install-time execution: `package.json` has no lifecycle scripts; cloning executes nothing; only `brain setup` changes agent config.
- Claude Code project-scope hooks go into `.claude/settings.local.json` (personal, not committed) — committed `.claude/settings.json`
  hooks run unprompted for anyone using `claude -p` on the repo (Claude Code docs, "Workspace trust").
- Markdown/YAML is canonical. SQLite (`node:sqlite`, FTS5) is a disposable index under `.agent-brain/local/` (gitignored).
- No credentials anywhere in brain files, index, logs, or consent records; writes are secret-scanned and rejected.
- No raw prompts stored: traces keep a hash and length only.

## Stack decision

- **Plain ESM JavaScript, Node ≥ 22.13, zero runtime dependencies.**
  - `node:sqlite` (bundled SQLite 3.53 with FTS5 on the dev machine's Node 24.21) provides the index without native modules.
  - `node:test` provides the test runner.
  - A strict YAML-subset parser (`src/yaml.js`) handles our own files; anything outside the subset fails loudly.
- Trade-offs: no TypeScript type-checking (JSDoc only); our YAML parser does not accept all YAML (anchors, tags, multi-doc).
  Third-party skills with exotic YAML are reported as "outside supported subset" rather than misparsed. The official
  `skills-ref` validator is used as a second, independent check where available.
- Rejected for MVP: daemon, MCP server, vector search, hosted service, custom skill installer (the Vercel `skills` CLI already installs skills).

## MVP acceptance criteria

1. All first-party skills pass our validator and the official `skills-ref validate`.
2. Every skill has `manifest.yaml` (license, provenance, risk, capabilities, owner) and `evals/cases.yaml` covering
   typical / ambiguous-or-edge / unsupported-claim-or-untrusted-input cases; routing cases pass the offline router eval.
3. `brain init` on fixture repos produces only evidence-backed facts (file + locator + hash), lists unknowns, runs no project commands.
4. `brain setup` in a temp HOME: dry-run changes nothing; apply preserves unrelated settings; re-run is a no-op; `uninstall` removes only owned entries.
5. Hook entrypoint: bounded time, recursion guard, never blocks the agent, degrades to a file-only notice on failure.
6. SQLite index deleted or corrupted → rebuilt from canonical files with identical search results.
7. Broker: missing / denied / approved / scope-mismatch / expired / revoked / connection-without-action-approval cases tested.
8. Secrets in proposed memory, events, or consent notes are rejected.
9. One real host run: Claude Code (`claude -p`) receives SessionStart context from the hook in a fixture project.
10. CI workflow runs validators, tests, scanner, evals, catalog drift check with `contents: read` permissions.

## Explicitly out of scope for this pass

MCP server, Codex/Antigravity/Gemini hook adapters (documented as not tested), semantic retrieval, team/remote storage,
community submission pipeline, LLM-graded behaviour evals (cases + rubric exist; automated grading does not).

## Status at end of MVP pass (2026-10-15)

| Criterion | Result |
|---|---|
| 1. Skills pass our validator and official `skills-ref` | Met — 17/17 both |
| 2. Manifests + eval coverage; routing evals | Met — 102 cases; routing 59/59 |
| 3. Evidence-only init, no project commands | Met — tests on Node/Python/empty/ambiguous fixtures |
| 4. Setup dry-run / preserve / idempotent / uninstall | Met — temp-HOME tests |
| 5. Bounded, recursion-safe, non-blocking hooks | Met — deadline, open-stdin, recursion, missing-controller tests |
| 6. Index rebuild/recovery | Met — deletion, corruption, foreign identity, staleness tests |
| 7. Broker cases | Met — missing/denied/approved/scope/expired/revoked/once/session/action tests |
| 8. Secrets rejected | Met — proposals, consent notes, evidence, events, audit |
| 9. Real host run | Met — Claude Code 2.1.300 (`-p`): context, routing, checkpoints, denial enforcement |
| 10. CI workflow | Written; not yet run on GitHub (no remote) |
