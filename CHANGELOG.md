# Changelog

All notable changes are documented here. Format: Keep a Changelog; versions follow SemVer.

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
