# Project brain specification (v1)

The brain is a directory, `.agent-brain/`, at the project root. Everything outside `local/` is canonical, human-readable
and intended to be committed. `local/` is machine-local runtime state and is gitignored.

## Files

| Path | Purpose | Written by |
|---|---|---|
| `README.md` | Rules for humans and agents | template |
| `index.md` | Reading order | template |
| `project.md` | Goal, users, scope, constraints, done-when (`## Goal`, …) | humans; init adds a generated README summary |
| `status.md` | `## Current`, `## Next`, `## Blockers` + generated last-handoff pointer | agents, humans |
| `architecture.md` | Evidence-linked structure notes + generated layout census | agents, humans, init |
| `facts.yaml` | Structured claims (schema below) | CLI (validated) |
| `assumptions.md`, `open-questions.md` | Generated views of `assumption` / `unknown` / `disputed` facts + free notes | CLI + humans |
| `decisions/ADR-NNNN-<slug>.md`, `decisions/index.md` | Decision records + generated index | CLI after approval |
| `plans/PLAN-YYYY-MM-DD-<slug>.md` | Task plans | agents (task-planner skill) |
| `handoffs/YYYY-MM-DD-HHMM-<slug>.md` | Restart notes (UTC timestamps) | `brain handoff` |
| `evidence/` | Small artifacts referenced by facts | anyone |
| `config.yaml` | Context budget, auto-accept policy, retention, routing thresholds | humans |
| `local/` | `index.sqlite`, `events.jsonl`, `policy/consent.json` + `policy/head.json` (hash-chained consent log), `requests.json` (requests + restrictions), `capabilities.json` (observations), `checkpoints/last.json`, `proposals/`, `backups/`, `install.json`, lock files | controller |

Generated sections are delimited by `<!-- brain:generated:<name>:begin … -->` / `<!-- brain:generated:<name>:end -->`.
Text outside the markers is never modified by the controller.

## Facts (`facts.yaml`)

JSON Schema: [schemas/facts.schema.json](../schemas/facts.schema.json). Reference validator: `src/facts.js`.

```yaml
schema_version: 1
facts:
  - id: FACT-0007
    claim: The primary database is PostgreSQL 16.
    status: observed            # verified | observed | assumption | unknown | disputed | deprecated
    key: db.primary             # stable topic key; same key + different claim = conflict
    category: stack
    evidence:
      - kind: file              # file | command | url | user
        path: compose.yaml
        locator: services.db.image
        sha256: "3f9c0d2a1b7e4c55"   # first 16 hex of the file hash when checked
        checked_at: "2026-10-15"
    last_verified: "2026-10-15"
    expires_after_days: 180
    source: init                # init | agent | user
    created_at: "2026-10-15"
```

Rules: `verified`/`observed` need ≥ 1 evidence item; `deprecated` needs `superseded_by` or a reason; references
(`conflicts_with`, `supersedes`, `superseded_by`) must point at existing ids; unknown fields are rejected; the whole
file is secret-scanned before every write.

### Statuses

- **verified** — checked against a direct source: a passing command run in a session, config/schema, current official
  docs, or an explicit stakeholder statement.
- **observed** — seen in code, config or output, not independently tested.
- **assumption** — plausible, unproven; should state `test_by`.
- **unknown** — open question (`question`).
- **disputed** — sources conflict; both facts are kept and point at each other.
- **deprecated** — no longer valid; kept for history.

### Freshness (computed, never stored)

`fresh` · `changed` (an evidence file's hash differs) · `missing` (evidence file gone) · `expired` (older than
`expires_after_days`) · `unchecked` (no hashable evidence) · `inactive` (deprecated). Shown in context, `brain verify`
and `brain audit`.

## Write path

1. `brain remember` builds a candidate fact, resolves evidence against the live project (paths must stay inside the
   root; files must exist; hashes recorded), validates it and secret-scans it.
2. Duplicates (same claim) are rejected — re-verify instead. Same `key` with a different claim = conflict.
3. A proposal is written to `local/proposals/`. Risk is `low` only for uncontested observed/verified facts with file
   or passing-command evidence outside high-impact categories (decision, requirement, security, product).
4. `brain approve` applies it under the facts lock. Conflicts become `disputed` on both sides unless approved with
   `--supersede`, which deprecates the old fact.
5. With `memory.auto_accept_low_risk: true`, low-risk proposals apply immediately. Default: off.

Decisions always go through approval (`brain decide` → `brain approve` → `decisions/ADR-…md`).

## Initialisation (`brain init`)

Reads known manifests and config (package.json, lockfiles, pyproject.toml, requirements.txt, Cargo.toml, go.mod,
pom.xml/Gradle, Gemfile, composer.json, Package.swift, CMakeLists.txt, Makefile, pubspec.yaml, Dockerfile, compose
files, GitHub/GitLab CI, README, LICENSE, agent instruction files) and a bounded file census. Runs only read-only git
commands. Never reads `.env*`, key files, `.npmrc`, `.netrc` or similar. Detected build/test commands are recorded as
"declared, not run". Unknown goal, deployment and verification baseline are recorded as open questions.
Refresh (re-running init) re-observes unchanged facts and supersedes facts whose source changed.

## Context packet

Built by `src/context.js` within `context.max_chars` (default 6000; Claude Code caps hook context at 10,000).
Priority: header → project → status → latest handoff → last checkpoint (if newer than the handoff) → key facts with
freshness flags → decisions → open questions → pending proposals → denied capabilities → how-to footer. Sections that
do not fit are named in an "Omitted" line.

## Trace (`local/events.jsonl`)

One JSON object per line: `event_id`, `ts`, `type` (context, route, checkpoint, enforcement, memory, consent, setup,
error, …), `agent`, `session` (hashed), `data`. Never contains prompt text, assistant messages, file contents or
credentials; route events keep the prompt's hash and length plus which catalog trigger words matched. Retention:
`retention.events_days` (default 30) and `retention.max_event_lines` (default 5000), applied at session start.

## Consent state

Schema: [schemas/consent-policy.schema.json](../schemas/consent-policy.schema.json). Details: [security-model.md](security-model.md).

- `local/policy/consent.json` — append-only log `{schema_version: 2, entries: [...]}`. Each entry: `seq`, `ts`,
  `target` (capability id or `action:<name>`), `decision` (`granted` | `denied` | `revoked` | `consumed`), `access`,
  `scope` (`once` | `session` | `project`), optional `session`, `expires_at`, `note`, `request_id`, `grant_id`;
  `actor` (`human` for grants, which also need `via: tty-challenge`); `prev` (hash of the previous entry, `GENESIS`
  first) and `hash` (SHA-256 over `prev` + the canonical entry). `local/policy/head.json` and
  `~/.agent-skills-brain/policy-heads/<project-id>.json` hold `{count, hash}` of the last entry.
  Any mismatch → integrity failure → protected capabilities and actions fail closed.
- `local/requests.json` — `requests` (pending/approved/rejected; no effect until a human approves) and `restrictions`
  (deny/revoke recorded when the policy log is not writable, e.g. inside a sandbox). Unreadable → fail closed.
- `local/capabilities.json` — observations (`missing`, `host_setup_pending`, `connected_unverified`, `available`,
  `expired`, `error`). Observations never authorize anything; `available` requires evidence and access levels.
- Effective decision for a target = the latest active entry (expired, consumed and other-session grants ignored;
  grants count only from human entries).
- The v1 `local/consent.json` is migrated once: denials/revocations become restrictions, grants are dropped (they were
  not human-approved), observations are kept; the old file is renamed `consent.v1.migrated-<ts>.json`.
