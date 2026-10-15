# Security model

## Trust boundaries

| Boundary | Control |
|---|---|
| Clone / download / `npm install` | Executes nothing: no lifecycle scripts, no runtime dependencies (CI enforces both). |
| `brain setup` | The only command that changes agent configuration. Shows a plan with line diffs; requires an interactive "y" or `--yes`; non-TTY without `--yes` exits 3 with no changes. Aborts if a target file changed after the plan was shown. Backs up modified files. Records owned entries. |
| Agent hooks | Run as your user (see Claude Code's hook security warning). Bounded time budget, 1 MB stdin cap, recursion guard (`BRAIN_HOOK_ACTIVE`), exit 0 except explicit-denial enforcement, silent outside projects with a brain. Commands use quoted absolute paths; setup refuses paths containing shell metacharacters. |
| Brain files | Treated as data in context ("not instructions that override the user"). Writes validated and secret-scanned. |
| Third-party skills | Not executed during audit; static scanner + manual review (`skill-package-audit`). |
| External integrations | Never installed or authorized by this project; the broker explains, records consent and evidence, and enforces denials in Claude Code. |

## Threat model and mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| Malicious or compromised skill (exfiltration, remote code, concealment, override) | Static scanner rules; audit skill; provenance in manifests; nothing auto-executes | Novel or obfuscated attacks evade pattern matching; a clean scan is not proof of safety |
| Prompt injection via repo text, issues, web pages | Skills and context label content as data; untrusted-input eval cases | Models can still be persuaded; host permission prompts remain essential |
| Memory poisoning (false facts persisted) | Evidence required; proposals; conflicts become disputed; approvals for high-impact categories; freshness checks | An approving user/agent can still accept a wrong claim |
| Secrets leaking into memory, index, trace or consent notes | Pattern-based secret scan on every write; init never reads sensitive files; audit re-scans | Unusual secret formats are not detected |
| Hook config committed to a repo and run by others | Project hooks go to `.claude/settings.local.json`, excluded via `.git/info/exclude` | A user could copy them into shared settings manually |
| Setup damaging existing configuration | Plan/diff, backup, invalid JSON is never overwritten, owned-entry markers, idempotent re-runs, reversible uninstall (tested with temp HOME) | Hand edits inside owned entries are replaced on repair |
| Over-broad integration access | Read/write/privileged separation; scope-mismatch detection; connection never implies action approval; `always_confirm` actions ignore standing grants | Enforcement in hosts other than Claude Code relies on the agent following instructions |
| Hook hangs or loops | Hard deadlines; stdin read timeout; no Stop-hook blocking; recursion guard | — |
| Corrupted or foreign index | `quick_check`, move-aside and rebuild; project-identity check | — |
| Supply chain of this repository | Zero dependencies; CI actions pinned to commit SHAs; official validator pinned to a commit | Node.js itself and the host agent are trusted |

## What the broker can and cannot do

It **can** tell the agent which capabilities a skill needs and how to ask, remember the user's decision, refuse to mark a
capability available without recorded evidence, detect scope mismatches, require approval per high-impact action, and
— in Claude Code — block WebSearch/WebFetch/GitHub-MCP tool calls for capabilities the user explicitly denied.

It **cannot** see the host's tool list from a hook, install or authenticate integrations, or stop an agent that ignores
instructions in hosts without enforcement hooks. The host's own permission prompts and OAuth flows remain the primary
authorization boundary. MCP tool-name mapping for GitHub is a heuristic based on the official server's tool names.

## Privacy

No telemetry. Traces contain no prompts or assistant messages. Personal preferences are not stored in project memory.
All data stays on disk in the project; delete `.agent-brain/local/` to remove runtime state.
