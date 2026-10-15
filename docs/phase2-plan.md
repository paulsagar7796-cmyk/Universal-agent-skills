# Phase 2 plan — harden the brain, build the behavioural evaluation system

Written 2026-10-15 before implementation. Working tree: `~/agent-skills-brain` (clean; `main` = `origin/main` @ `c471fab`).
No commits or pushes in this phase.

## Baseline (re-run, not assumed)

| Check | Result |
|---|---|
| `npm run check` on Node 24.21.0 | exit 0 — validator 17/0 errors, catalog in sync, scans clean, routing 59/59, tests 73/73 |
| `node --test` on Node 22.13.0 (checksum-verified download in scratch dir) | 73 tests: 68 pass, 5 skipped (no FTS5), 0 fail |
| Official `skills-ref validate` (agentskills @ 69ef37e) | 17/17 valid |

## Audit findings (before changes)

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| F1 | High | `brain consent grant` is freely invokable by any process (incl. the agent's Bash) and converts a user denial into a grant; the PreToolUse block disappears | `tests/hooks.test.js` "re-granting lifts the block" does exactly this non-interactively |
| F2 | High | `brain approve` is freely invokable: an agent can approve its own memory proposals and decisions | `src/cli.js` `cmdApprove` has no human check |
| F3 | Medium | Consent state is plain JSON with no integrity check; a malformed file makes the PreToolUse hook throw → caught → exit 0 → **fail open** | `src/hooks.js` catch path returns `{exitCode: 0}` |
| F4 | Medium | `capabilities record … available` (agent-writable) makes the broker return `proceed` without any user consent | `evaluateCapability` "available" branch |
| F5 | Medium | Capability registry can be edited or broken; load errors fail open | `capabilityForTool` + catch path |
| F6 | Medium | PreToolUse hook timeout/crash lets the tool run (host default) | Claude Code docs: timed-out hooks do not block unless `onFailure: "block"` |
| F7 | Medium | `config.yaml memory.auto_accept_low_risk` is agent-editable → self-enabled auto-accept | no protection on config |
| F8 | Medium | Hooks hard-code an absolute node path; after a Node upgrade every hook fails (exit 127, non-blocking) → enforcement silently off | `hookCommand` |
| F9 | Low | `once` grants are never consumed by `brain authorize` → reusable | `cmdAuthorize` |
| F10 | Info | No measurement of controller-file integrity since setup | install.json has version/commit only |

## Security design

Measured host facts (2026-10-15, Claude Code 2.1.300 Bash tool): no controlling terminal (`/dev/tty` → ENXIO);
`CLAUDECODE` is set. A same-user process **can** fake a terminal with `script` and feed input (demonstrated).

Layers, weakest to strongest:
1. **Policy recorded** — hash-chained consent log; malformed/tampered → fail closed for protected operations.
2. **CLI separation** — read-only `consent status|explain`, agent-usable `consent request|deny|revoke|reject`,
   human-only `consent approve|grant` and `approve` (memory) behind a terminal challenge (controlling TTY + random code;
   refused in hook subprocesses and agent sessions). Guardrail, not a boundary (pty emulation).
3. **Host-enforced (Claude Code)** — PreToolUse guard on Bash/Edit/Write/NotebookEdit denies policy-mutating CLI
   commands, pty wrappers around the CLI, and edits to protected files; capability blocking with `onFailure: "block"`.
   Heuristic for Bash text; exact for file-tool paths.
4. **Outside the agent's control** — opt-in `brain setup --harden`: Claude Code OS sandbox (`denyWrite` on the policy
   directory and config, `allowUnsandboxedCommands: false`) + `Edit(...)` deny rules. Only this layer stops a
   deliberately adversarial sandboxed shell command from writing policy. Hooks run outside the sandbox.

## Work order

1. Policy store + broker + human gate + CLI split + hook guard + adversarial tests (Priority A).
2. Evaluation harness: case loader, providers (mock, claude-code), checks, grading, runner, reports (Priority B).
3. Bootstrap integrity: file checksums (trust-on-first-use), PATH-fallback hook command, journaled setup, doctor (Priority C).
4. Docs, CI, full regression on Node 24 and 22.13 (Priority D).

## Status at end of phase 2 (2026-10-15)

| Area | Result | Evidence |
|---|---|---|
| Baseline re-run | Matched the reported baseline (73/73 Node 24; 68+5 skipped Node 22.13; skills-ref 17/17) | logs in session scratch dir |
| F1–F10 audit findings | Fixed or mitigated; F11 (credential copied by `init`) found and fixed | docs/threat-model.md, tests/security.test.js |
| Host verification (Claude Code 2.1.300, macOS) | Guard blocked self-grant; OS sandbox blocked obfuscated policy write; deny rule blocked config write; request allowed; policy unchanged | docs/security-model.md |
| Evaluation harness | 102 cases load; 48/181 expectations structured; mock suite deterministic (2 identical runs); stream-json parser checked on a real run | tests/eval-harness.test.js |
| Live behavioural evaluation | **Not run** (pending owner decision on budget) | command in docs/evaluation-guide.md |
| Open by design | U1 terminal emulation / chain rewrite by a same-user process without sandbox; U2 Bash guard heuristic; U3 no enforcement on other agents; U4 unkeyed chain | docs/threat-model.md |
