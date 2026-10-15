# References checked

All pages below were fetched on **2026-10-15** while designing the MVP. Facts recorded here are what the pages said on that
date; re-check them before relying on them — these products change quickly. Nothing was copied wholesale.

| Source | What we took from it |
|---|---|
| [Agent Skills specification](https://agentskills.io/specification) | Frontmatter fields and constraints: `name` 1–64 chars, lowercase alphanumerics and single hyphens, must match the parent directory; `description` 1–1024 chars; `compatibility` 1–500 chars; `metadata` is a string→string map; `allowed-tools` is experimental. Keep `SKILL.md` under 500 lines / ~5000 tokens; references one level deep. |
| [agentskills/agentskills – skills-ref](https://github.com/agentskills/agentskills/tree/main/skills-ref) | Official reference validator, `skills-ref validate <dir>`; installed from the repo (`pip install -e .`); Apache-2.0; "intended for demonstration purposes only". Used as a second validator. |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) | `npx skills add <source>` with `--list`, `-s/--skill`, `-a/--agent`, `-g/--global`, `--copy`, `-y`. Discovers `skills/` up to three levels deep (so `skills/<category>/<name>/SKILL.md` works). Project paths: Claude Code `.claude/skills/`; Codex, Antigravity, Gemini CLI, Cursor, Copilot, OpenCode `.agents/skills/`. Hooks support listed only for Claude Code, Cline, Kiro CLI. |
| [Claude Code hooks](https://code.claude.com/docs/en/hooks) | Settings locations (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`); `hooks.<Event>[].hooks[] = {type:"command", command, timeout}`; common stdin fields `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`; `SessionStart.source` ∈ startup/resume/clear/compact/fork; plain stdout or `hookSpecificOutput.additionalContext` adds context for SessionStart/UserPromptSubmit (SessionStart cap 10,000 chars); `UserPromptSubmit.prompt`; `Stop.stop_hook_active`; `PreCompact.trigger`; `SessionEnd.reason`, 1.5 s default budget; exit 2 blocks some events — **we exit 2 only from PreToolUse, to enforce a capability the user explicitly denied**; workspace-trust rules and security best practices (quote variables, absolute paths). |
| [Codex skills](https://learn.chatgpt.com/docs/build-skills) (redirected from developers.openai.com/codex/skills) | Codex scans `.agents/skills` from CWD to repo root and `$HOME/.agents/skills`; optional `agents/openai.yaml`; implicit invocation by description. |
| [Codex hooks](https://learn.chatgpt.com/docs/hooks) (redirected from developers.openai.com/codex/hooks) | Events include SessionStart/UserPromptSubmit/Stop/PreCompact/SessionEnd; config in `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`; SessionStart stdout adds developer context; hooks must be reviewed/trusted by hash. **Not host-tested here** (Codex is not installed). |
| [Google Antigravity skills](https://antigravity.google/docs/skills?tab=ide) | Workspace skills in `<workspace-root>/.agents/skills/`; global `~/.gemini/config/skills/`; legacy `~/.gemini/antigravity/skills/`. |
| [Google Antigravity hooks](https://antigravity.google/docs/hooks/) | `.agents/hooks.json` / `~/.gemini/config/hooks.json`; camelCase payloads; SessionStart returns `injectSteps`. Different shape from Claude Code — needs its own adapter. **Not host-tested.** |
| [anthropics/skills](https://github.com/anthropics/skills), [openai/skills](https://github.com/openai/skills) | Structural prior art only (folder-per-skill, curated vs experimental). No content copied. |

## Additional checks during implementation (2026-10-15)

| Source / tool | What was checked |
|---|---|
| [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference) | Exact built-in tool names (`WebSearch`, `WebFetch`, …) used in PreToolUse matchers |
| [Claude Code MCP](https://code.claude.com/docs/en/mcp) | `claude mcp add`, scopes (local/project/user), `.mcp.json`, OAuth via `/mcp` |
| [github/github-mcp-server](https://github.com/github/github-mcp-server) | Official GitHub MCP server, MIT, `--read-only` flag, read vs write tool names |
| agentskills/agentskills @ `69ef37e9424c0a7ea9dd2293b559e43ec8176379` (2026-08-09) | `skills-ref validate` → 17/17 skills valid |
| `skills` CLI 1.7.0 (npm, MIT, released 2026-09-17) | `add <repo> --list` listed 17 skills; `--skill … -a claude-code --copy -y` installed into `.claude/skills/` (temp HOME, scratch project) |
| Claude Code 2.1.300 (VS Code extension binary) | Real `claude -p` sessions in a fixture project: SessionStart context delivered; UserPromptSubmit, Stop, SessionEnd fired; PreToolUse blocked a denied WebSearch |
| GitHub Actions | `actions/checkout` v7.0.1 `3d3c42e` (2026-07-17), `actions/setup-node` v7.0.0 `8207627` (2026-07-14), `actions/setup-python` v7.0.0 `5fda3b9` (2026-07-20) pinned by SHA in CI |

## Not yet verified

- Gemini CLI extension hooks, Cursor, Copilot, OpenCode lifecycle behaviour — listed in `docs/compatibility.md` as `not_tested`.
- Whether npm package name `agent-skills-brain` will remain free: `npm view agent-skills-brain` returned 404 on 2026-10-15. Nothing has been published or reserved.
