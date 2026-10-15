# Compatibility matrix

Statuses: **verified** (tested on a real host, evidence below) · **tested (simulated)** (exercised by automated tests
that run the exact hook commands, not the host) · **documented** (per vendor docs, not tested here) · **unsupported**
(no adapter) · **not tested**.

Last updated 2026-10-15. Re-check vendor docs before relying on any "documented" row; these products change quickly.

## Skills (Agent Skills format)

| Agent | Install path (project) | Status | Evidence |
|---|---|---|---|
| Claude Code | `.claude/skills/` | verified (install) | `npx skills@1.7.0 add … -a claude-code --copy` installed into `.claude/skills/` |
| Codex | `.agents/skills/` | documented | Codex docs: scans `.agents/skills` from CWD to repo root |
| Google Antigravity | `.agents/skills/` | documented | Antigravity skills docs |
| Gemini CLI, Cursor, GitHub Copilot, OpenCode | `.agents/skills/` | documented | `skills` CLI README install-path table |
| Any agent that can read files | point it at `skills/<category>/<name>/SKILL.md` | manual | — |

All 17 skills pass the official `skills-ref validate` (agentskills/agentskills @ `69ef37e`). How each agent *selects*
skills (implicit invocation by description) is host behaviour and was not measured.

## Lifecycle automation

| Capability | Claude Code 2.1.300 | Codex | Antigravity | Gemini CLI | Cursor / Copilot / others |
|---|---|---|---|---|---|
| `session_start_hook` (context injection) | **verified** — `claude -p` answered a fact present only in the brain, tools disabled | documented (SessionStart in `hooks.json`); adapter not implemented | documented (different payload/`injectSteps`); adapter not implemented | not tested | unsupported |
| `user_prompt_hook` (skill routing note) | **verified** — route event recorded from a real session | documented; no adapter | not tested | not tested | unsupported |
| `pre_tool_hook` (deny enforcement) | **verified** — real WebSearch call blocked after `consent deny web.search` | documented; no adapter | documented; no adapter | not tested | unsupported |
| `pre_tool_hook` (self-approval / policy-edit guard) | **verified** 2026-10-15 — `brain consent grant` via Bash blocked by the guard | no adapter | no adapter | not tested | unsupported |
| OS sandbox for agent shell (`--harden`) | **verified** 2026-10-15 — obfuscated append to the policy file failed with `operation not permitted` (macOS Seatbelt); Linux bubblewrap not tested | n/a | n/a | n/a | n/a |
| Permission deny rules for file tools (`--harden`) | **verified** 2026-10-15 — Write to `.agent-brain/config.yaml` refused by settings | n/a | n/a | n/a | n/a |
| Human approval challenge (no controlling TTY in agent Bash) | **verified** 2026-10-15 — `/dev/tty` → ENXIO and `CLAUDECODE` set inside the Bash tool | not tested | not tested | not tested | not tested |
| Behavioural eval provider | **implemented**; stream-json parser verified on a real 2.1.300 run; full 102-case live run **not yet executed** | interface documented; not implemented | not implemented | not implemented | not implemented |
| `stop_hook` (checkpoint) | **verified** — checkpoint recorded from a real session | documented; no adapter | documented; no adapter | not tested | unsupported |
| `pre_compact_hook` | tested (simulated) — host compaction not triggered in tests | documented; no adapter | not tested | not tested | unsupported |
| `session_end_hook` | **verified** — checkpoint (`reason: other`) recorded in `-p` mode | documented; no adapter | not tested | not tested | unsupported |
| `project_instructions` fallback | `CLAUDE.md` not modified (hooks used instead) | `AGENTS.md` block via `--agent agents-md` (documented that Codex reads AGENTS.md; not tested) | `AGENTS.md` block (not tested) | not tested | `AGENTS.md` block (not tested) |
| `mcp_client` brain server | not implemented | not implemented | not implemented | not implemented | not implemented |
| `automatic_skill_discovery` | host feature | host feature | host feature | host feature | host feature |

Notes for Claude Code:

- Interactive sessions hold back settings-file hooks until the workspace-trust dialog is accepted; `-p`/SDK sessions
  treat the folder as trusted (Claude Code docs, "Workspace trust"). The real-host verification used `-p`.
- Hooks are written to `.claude/settings.local.json` (project) or `~/.claude/settings.json` (`--global`).
- `SessionEnd` hooks share a short default budget (1.5 s); setup sets `timeout: 5` for ours. Measured hook latency on
  the development machine: 106–207 ms. With enforcement on, the guard hook also runs for every Bash/Edit/Write call.
- The capability hook uses `onFailure: "block"` (fail closed); the guard hook does not (a broken controller must not
  block every shell command). Settings containing `onFailure` were accepted by 2.1.300 (hooks fired).

## Manual fallback (all agents)

```bash
brain context            # paste or let the agent read it
brain route "<request>"  # which skills apply
brain capabilities check <skill>
brain remember … / brain decide … / brain handoff …
```

Or without the CLI: read `.agent-brain/index.md` and follow `.agent-brain/README.md`.

## How to add an adapter

1. Read the host's current hook documentation; record URL and date in `docs/references.md`.
2. Map its events and payload fields onto `handleHook` (agent id, cwd, session id, prompt, tool name) and its
   context-injection output format.
3. Add plan/merge/uninstall logic for its config file with ownership markers, plus temp-HOME tests.
4. Verify on a real host version and update this matrix with the evidence. Until then, mark it `not tested`.
