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

## Implemented (phase 2, unreleased)

- Consent hardening: human-only grants/approvals (terminal challenge), hash-chained policy log with fail-closed
  integrity, observations ≠ authorization, allowlist mode, PreToolUse guard, `--harden` OS sandbox option — host-verified
  on Claude Code 2.1.300 (macOS). Threat model and adversarial test suite.
- Behavioural evaluation harness with mock and Claude Code providers, structured checks on 48/181 expectations,
  evidence-validated judge, human grading, reports, re-runs and an advisory release gate (proposed policy).
- Setup integrity: controller checksums (trust on first use), journaled apply, PATH fallback, richer doctor/repair.

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

1. **First live behavioural run** on Claude Code (owner-approved budget), then human/judge grading of the 133
   prose expectations; fix skills and checks from the failures; decide on the proposed release policy.
2. **Fixture fidelity** — add workspaces for the ~20 cases whose fixture is described only in prose (see
   docs/evaluation-guide.md), and more structured checks where they are faithful.
3. **Stronger approval boundary** — a separately privileged approval component or OS-keychain-backed signing key the
   agent cannot read (threat-model U1/U4); Linux bubblewrap verification of `--harden`.
4. **Codex adapter** — `hooks.json` with hash-trust notes, plus a Codex eval provider; verify on a real Codex version.
5. **Initialisation benchmark** — six public fixture repositories with human-labelled expected facts.
6. Read-only MCP server (`brain_context`, `brain_search`, `brain_get_fact`, `capability_status`) for MCP-capable hosts.
7. Antigravity / Gemini CLI adapters (different payload shapes).
8. `brain plan` command and plan ↔ status integration.

## Later

Release 0.2 skills (frontend, backend, database, DevOps, security, data, UX, project management) informed by eval
failures; community submission pipeline with automated audit; signed releases/checksums; team policy profiles;
optional semantic retrieval only if benchmarks show it beats FTS.
