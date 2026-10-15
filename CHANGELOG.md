# Changelog

All notable changes are documented here. Format: Keep a Changelog; versions follow SemVer.

## [Unreleased] — phase 2 (hardening + behavioural evaluation)

### Security
- Consent grants and memory approvals now require a person at a controlling terminal (typed random code); refused in
  agent sessions, hooks and without a TTY. Agents can request, deny, revoke and reject only.
- Consent decisions stored in a hash-chained policy log with a mirrored head; tampering, truncation or malformed files
  fail closed for protected tools and actions. v1 `consent.json` is migrated keeping only denials/revocations.
- Availability observations no longer authorize use; `proceed` needs a human grant plus a verified observation.
- PreToolUse guard blocks self-approval commands, terminal emulation around the CLI, and edits to policy/settings/
  controller files; capability hook uses `onFailure: "block"`; registry drift or load failure fails closed.
- `brain setup --harden` (opt-in): Claude Code OS sandbox `denyWrite` for policy/config plus Edit deny rules.
- `brain init` redacts credentials found in copied README text (found by a new adversarial test).
- Allowlist enforcement mode; once-grants consumed by `brain authorize`.

### Added
- Behavioural evaluation harness (`scripts/eval.js`): mock and Claude Code providers, fixture workspaces, structured and
  global safety checks, evidence-validated judge, human grading sheets, reports, re-runs, advisory release gate.
- Structured checks on 40 of the 102 cases (48 of 181 expectations), workspace/requires/environment annotations.
- Setup integrity: controller file checksums (trust on first use), journaled apply, PATH fallback for hook commands,
  expanded `brain doctor`, consented re-recording via `brain repair`.
- Docs: threat model, operations guide, proposed release policy; adversarial test suite.

## [0.1.0] — 2026-10-15 (unreleased MVP)

### Added

- 17 first-party skills (draft): project-initializer, brain-curator, codebase-explorer, task-planner,
  verification-before-completion, skill-author, skill-reviewer, software-engineer, systematic-debugging,
  test-driven-development, code-review, documentation-engineering, business-analyst, prd-writer, web-research,
  source-verification, skill-package-audit — each with `manifest.yaml` and eval cases (102 cases in total).
- `brain` controller (zero dependencies): init, status, context, search, show, remember/approve/reject, decide,
  verify, deprecate, handoff, audit, index, route, capabilities, consent, authorize, connect, explain-last-run,
  doctor, runtime status, setup, repair, uninstall.
- Project-brain template with evidence-labelled `facts.yaml`, generated views, ADRs, plans and handoffs.
- Disposable SQLite/FTS5 index with schema versioning, corruption recovery, project-identity check and file-scan fallback
  (also used automatically when the Node build lacks FTS5, e.g. Node 22.13.0).
- Claude Code adapter: SessionStart, UserPromptSubmit, Stop, PreCompact, SessionEnd and optional PreToolUse
  enforcement; host-verified on Claude Code 2.1.300.
- Capability registry, consent store and broker (read/write/privileged separation; connection ≠ action approval).
- Validator, generated catalog, static skill scanner, secret scanner, offline routing evals, CI workflow.
