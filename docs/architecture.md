# Architecture

```
            ┌──────────────────────────── agent host (Claude Code, Codex, …) ────────────────────────────┐
            │  native skill discovery ──► skills installed by `npx skills add` (.claude/skills, .agents/…) │
            │  lifecycle hooks (Claude Code only, after `brain setup`)                                     │
            └───────┬───────────────┬──────────────┬───────────────┬───────────────┬──────────────────────┘
       SessionStart │ UserPromptSubmit│ PreToolUse   │ Stop/PreCompact│ SessionEnd
                    ▼               ▼              ▼               ▼
            ┌──────────────── brain controller (short-lived node process per event) ────────────────┐
            │ hooks.js: deadline, stdin cap, recursion guard, never blocks (except explicit denial)   │
            │ context.js  router.js  broker.js  checkpoint                                            │
            │ store.js / facts.js / proposals.js / handoff.js / audit.js   (validated, locked writes) │
            │ index-db.js (SQLite FTS5, disposable)   events.js (local trace, no prompts)             │
            └───────────────┬───────────────────────────────────────────┬──────────────────────────┘
                            ▼                                           ▼
      .agent-brain/  (canonical, committed)                 .agent-brain/local/ (gitignored, rebuildable)
      project.md status.md architecture.md facts.yaml       index.sqlite events.jsonl consent.json
      assumptions.md open-questions.md decisions/ plans/    checkpoints/ proposals/ backups/ install.json
      handoffs/ evidence/ config.yaml README.md index.md
```

## Layers

| Layer | Code | Notes |
|---|---|---|
| A. Skills | `skills/<category>/<name>/` | Agent Skills spec; `manifest.yaml` for structured data; `evals/cases.yaml` |
| B. Catalog | `scripts/build-catalog.js` → `catalog/` | Generated from canonical skill files; CI fails on drift |
| C. Brain files | `templates/project-brain/`, `src/store.js` | Markdown/YAML; generated sections between `<!-- brain:generated:… -->` markers |
| D. Controller | `bin/brain.js`, `src/cli.js` | Zero dependencies; ESM; Node ≥ 22.13 |
| E. Adapters | `src/hooks.js`, `src/setup.js` | Claude Code hooks; `AGENTS.md` block as fallback |
| F. Quality | `src/validate.js`, `scripts/*`, `tests/` | Validator, scanners, routing evals, tests, CI |
| G. Bootstrap | `src/setup.js` | Plan → diff → consent → backup → apply → smoke test → install record |
| H. Broker | `src/broker.js`, `src/policy.js`, `src/human.js`, `integrations/capabilities.yaml` | Hash-chained consent log, human-only grants (terminal challenge), observations vs. consent, action authorization, enforcement modes |
| I. Guard | `src/guard.js` | PreToolUse checks against self-approval, terminal emulation and edits to protected paths |
| J. Evaluation | `src/eval/*`, `scripts/eval.js`, `evals/` | Behavioural harness: cases, workspaces, providers, checks, grading, reports, release gate |

## Key decisions

- **Plain JS, no dependencies.** Removes install-time supply-chain risk and lets `git clone` + `node bin/brain.js` work
  immediately. Costs: no TypeScript checking; a strict YAML subset parser (`src/yaml.js`) instead of a full YAML library.
- **YAML subset that fails loudly.** Anchors, tags, multi-document files and ambiguous plain scalars are rejected
  with line numbers rather than misparsed. All 14 third-party skills found on the development machine parsed correctly.
- **Sidecar manifest.** The spec restricts frontmatter `metadata` to string values, so capabilities, provenance and
  routing live in `manifest.yaml`. Other agents ignore it.
- **Project-scope hooks in `settings.local.json`.** Hooks committed to `.claude/settings.json` would run for anyone
  using `claude -p` on the repository; personal hooks with machine-specific paths do not belong in git.
- **Short-lived processes, no daemon.** Each hook runs `node bin/brain.js hook claude-code <event>` with a hard budget
  (1–4 s). Typical latency on the development machine: ~100–300 ms including index freshness checks.
- **Disposable index.** `index.sqlite` is rebuilt whenever the fingerprint of canonical files changes, the schema
  version is newer than the code, the project identity differs, or `PRAGMA quick_check` fails (the corrupt file is
  moved aside). Without `node:sqlite` — or when the Node build's SQLite lacks FTS5, as in Node 22.13.0 — search falls
  back to scanning files and event de-duplication uses a tail scan of the trace.
- **Advisory router.** Keyword/phrase scoring over manifest triggers, intents and descriptions. It explains every
  match and never overrides the user's explicit choice or the host's own skill selection.

## Concurrency and idempotency

- `facts.yaml` writes take an exclusive lock file (stale after 15 s) and re-read the file inside the lock; callers can
  pass an expected hash for optimistic concurrency (`StaleWriteError`).
- All file writes are atomic (temp file + rename).
- Hook events carry deterministic ids (`session + event + git fingerprint` for checkpoints); duplicates are ignored via
  `INSERT OR IGNORE` (index) or a tail scan (file-only mode).
- Setup re-runs compute the same merged settings and become no-ops; owned hook groups are replaced in place.

## Project identity and isolation

Root = git top-level, or the nearest ancestor with `.agent-brain/`, else the working directory. Identity =
`sha256(realpath(root) + normalized remote)` (credentials stripped from remotes). Each project's runtime state lives in
its own `.agent-brain/local/`; an index carrying a different identity is rebuilt. Worktrees resolve to their own root.

## Lifecycle contract → implementation

`SESSION_START → DISCOVER_PROJECT → LOAD_COMPACT_CONTEXT → ROUTE_SKILLS → CHECK_CAPABILITIES → PLAN → EXECUTE → VERIFY → PROPOSE_MEMORY_UPDATES → SAVE_HANDOFF → SESSION_END`

| Stage | Claude Code (after setup) | Other agents |
|---|---|---|
| Session start, discover, load context | SessionStart hook | `AGENTS.md` block → agent reads `.agent-brain/index.md` or runs `brain context` |
| Route skills | UserPromptSubmit hook + host skill discovery | Host skill discovery; `brain route` manually |
| Check capabilities | UserPromptSubmit hook flags; PreToolUse enforces denials | `brain capabilities check <skill>` |
| Plan / execute / verify | Skills (task-planner, software-engineer, verification-before-completion) | Same skills |
| Memory updates, handoff | Agent runs `brain remember/decide/handoff`; Stop/PreCompact/SessionEnd checkpoints | Agent runs the CLI or edits files |
