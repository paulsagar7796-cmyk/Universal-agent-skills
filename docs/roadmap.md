# Roadmap

Status as of 2026-10-15.

## Implemented (0.1.0)

- 17 draft skills with manifests and 102 eval cases; generated catalog; validator; static scanner; secret scanner;
  offline routing evals; CI (Node 22.13/24, Linux/macOS, official validator job).
- Project brain: template, evidence-labelled facts, generated views, ADRs, handoffs, plans directory, config.
- Controller: init/refresh, context, search (SQLite FTS5 + file fallback), remember/approve/reject/decide, verify,
  deprecate, handoff, audit, explain-last-run, doctor, runtime status.
- Explicit setup/repair/uninstall with dry run, diff, consent, backups, ownership markers, idempotency.
- Claude Code adapter: SessionStart, UserPromptSubmit, Stop, PreCompact, SessionEnd, PreToolUse enforcement —
  host-verified on 2.1.300 except PreCompact.
- Capability registry, consent store, broker with state machine and action authorization.

## Partially implemented

- **Automatic memory updates:** hooks checkpoint mechanical state (git) automatically; durable facts and decisions are
  written by the agent through the CLI as skills instruct. There is no automatic extraction of facts from conversations
  (by design: transcripts are not read).
- **Multi-agent support:** skills install everywhere the `skills` CLI supports; lifecycle automation only in Claude
  Code; other agents get an `AGENTS.md` instruction block (manual).
- **Capability detection:** the broker cannot query a host's tool list from hooks; the agent confirms availability and
  records it. Enforcement of denials exists only for Claude Code tool names in the registry.
- **`brain update`:** not a command; update by `git pull` in the checkout, then `brain repair`.

## Next (priority order)

1. **Behaviour-eval harness** — run the 102 cases against Claude Code and Codex in fixture repos; publish per-case
   results; promote skills that pass to `reviewed`.
2. **Codex adapter** — `hooks.json` (SessionStart/UserPromptSubmit/Stop/PreToolUse) with hash-trust notes; verify on a
   real Codex version.
3. **Initialisation benchmark** — six public fixture repositories with human-labelled expected facts; measure precision
   and unsupported claims.
4. Read-only MCP server (`brain_context`, `brain_search`, `brain_get_fact`, `capability_status`) for MCP-capable hosts.
5. Antigravity / Gemini CLI adapters (different payload shapes).
6. `brain plan` command and plan ↔ status integration.

## Later

Release 0.2 skills (frontend, backend, database, DevOps, security, data, UX, project management) informed by eval
failures; community submission pipeline with automated audit; signed releases/checksums; team policy profiles;
optional semantic retrieval only if benchmarks show it beats FTS.
