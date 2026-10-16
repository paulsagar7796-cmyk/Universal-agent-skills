# Universal-agent-skills

> Version 0.1.0 (MVP). Repository: https://github.com/paulsagar7796-cmyk/Universal-agent-skills. Not published to npm or any registry.
> The controller CLI is `brain`; internal markers and state paths still use the original working name `agent-skills-brain`.

Two things for AI coding agents, designed to work together but usable separately:

1. **A portable skill library** — 21 narrow, operational skills in the open [Agent Skills](https://agentskills.io/specification)
   format (`SKILL.md`), installable into Claude Code, Codex, Antigravity, Cursor, Gemini CLI, Copilot and others with
   the existing [`skills` CLI](https://github.com/vercel-labs/skills).
2. **A project brain** — durable, evidence-labelled project memory in plain Markdown/YAML (`.agent-brain/`), plus a
   small local controller (`brain`) that, after an explicit setup, loads compact context at session start, suggests
   relevant skills per request, checks whether required integrations are available and consented, and checkpoints work —
   automatically in Claude Code, manually elsewhere.

It does **not** promise hallucination-free agents. It makes claims checkable: every fact carries its evidence and
status (verified / observed / assumption / unknown / disputed / deprecated), stale facts are detected when their source
files change, and skills require reporting checks as passed / failed / not run / blocked.

## What is verified today

| Claim | Evidence |
|---|---|
| All 17 skills conform to the Agent Skills spec | Official `skills-ref validate` (commit `69ef37e`) and `scripts/validate-skills.js`, 2026-10-15 |
| The `skills` CLI discovers and installs them | `npx skills@1.7.0 add <repo> --list` listed 17; `--skill … -a claude-code --copy` installed into `.claude/skills/` (2026-10-15) |
| Claude Code receives brain context automatically after setup | Real run on Claude Code **2.1.300** (`claude -p`, tools disabled): answered a fact that existed only in the brain |
| UserPromptSubmit, Stop and SessionEnd hooks fire and are recorded | Same real runs, `brain explain-last-run` |
| A user-denied capability is blocked in the host | Real run: Claude Code's WebSearch call was refused by the PreToolUse hook after `brain consent deny web.search` |
| The agent cannot grant itself consent or edit policy (with `--harden`) | Real run (2.1.300): self-grant blocked by the guard hook; obfuscated shell append to the policy blocked by the OS sandbox; Write to `config.yaml` refused by permission rules |
| Behavioural evaluation harness | 102 cases load; offline mock suite deterministic; live Claude Code provider parser checked against a real run. **The 102 live behavioural cases have not been run yet.** |
| Setup/uninstall, routing, broker, consent hardening, eval harness | Automated tests: see `docs/phase2-plan.md` for the latest counts per Node version |

Not verified: Codex, Antigravity, Gemini CLI, Cursor, Copilot lifecycle hooks (no adapters yet; they get an
`AGENTS.md` fallback). PreCompact delivery by a real host (unit-tested only). Skill *behaviour* with real models
(102 eval cases are written; none have been run). See [docs/compatibility.md](docs/compatibility.md).

## Quick start

Requires Node.js ≥ 22.13. Search indexing uses the built-in `node:sqlite` with FTS5 when the Node build includes it
(verified on Node 24.21; Node 22.13.0's bundled SQLite lacks FTS5, so it falls back to file-scan search automatically).
There are **no npm dependencies and no install scripts**: cloning runs nothing.

### A. Skills only (any agent)

```bash
npx skills add paulsagar7796-cmyk/Universal-agent-skills --list
npx skills add paulsagar7796-cmyk/Universal-agent-skills --skill project-initializer --skill software-engineer -a claude-code
```

Check `npx skills --help` for current flags. Review skills before installing them; they run with your agent's
permissions (use the bundled `skill-package-audit` skill for third-party skills).

### B. Brain + automatic lifecycle in Claude Code

```bash
git clone https://github.com/paulsagar7796-cmyk/Universal-agent-skills.git ~/agent-skills-brain   # downloads files; executes nothing
cd ~/code/my-project
node ~/agent-skills-brain/bin/brain.js setup --dry-run   # shows exactly what would change
node ~/agent-skills-brain/bin/brain.js setup             # asks before applying
```

Setup (project scope by default):

- creates `.agent-brain/` from the template and scans the repository read-only (no installs, builds or tests);
- adds hooks to `.claude/settings.local.json` (personal, not committed) and keeps that file out of git via
  `.git/info/exclude`;
- backs up every file it modifies and records what it owns in `.agent-brain/local/install.json`;
- runs a smoke test of the hook command; **host delivery is confirmed only when you start a session** —
  then run `brain explain-last-run`.

`brain uninstall` removes only the entries setup added. Brain data is kept.

Add `--global` to register the hooks in `~/.claude/settings.json` instead (they stay idle in folders without
`.agent-brain/`). Add `--agent agents-md` to write a managed instruction block into `AGENTS.md` for agents without a
tested hook adapter.

### C. File-only (no CLI)

Copy `templates/project-brain/` to `.agent-brain/` in your project and point your agent's instruction file at
`.agent-brain/README.md`. Nothing is automatic in this mode; the rules in that README still apply.

## How a session works (Claude Code, after setup)

| Stage | Mechanism | Automatic? |
|---|---|---|
| Load compact project context | `SessionStart` hook → `brain hook claude-code session-start` (also after `/clear`, resume and compaction) | Yes (host-verified) |
| Suggest skills for the request; flag missing/denied capabilities | `UserPromptSubmit` hook → keyword router + capability broker | Yes (host-verified) |
| Native skill loading | Claude Code reads installed skills by description | Yes (host feature) |
| Block tools for capabilities the user denied | `PreToolUse` hook (WebSearch, WebFetch, GitHub MCP) — exit 2 | Yes (host-verified) |
| Checkpoint git state (no conversation content) | `Stop`, `PreCompact`, `SessionEnd` hooks | Yes (Stop/SessionEnd host-verified) |
| Record facts, decisions, handoffs | Agent runs `brain remember / decide / handoff` as the skills instruct | Agent-driven; risky changes need approval |
| Verify work | `verification-before-completion` skill | Agent-driven |

The controller is a short-lived process per hook (hard time budget, recursion guard). There is no daemon and no
network listener. Hooks never block the agent except to enforce an explicit denial.

## Commands

```
brain setup [--harden] | repair | uninstall | doctor | runtime status
brain init | status | context | search <q> | show <id> | audit | index rebuild
brain exp start | log | finish | compare | list | show
brain remember | proposals | approve | reject | decide | verify | deprecate | handoff
brain route "<request>" | capabilities [check <skill>] | consent status|explain|request|deny|revoke|reject | authorize <action>
brain approve <P-…> | consent approve <R-…> | consent grant <target>      # human only, own terminal
brain connect <capability>
brain explain-last-run
```

`brain help` lists every flag. Tip: `alias brain="node ~/agent-skills-brain/bin/brain.js"`.

## Skills

| Category | Skills |
|---|---|
| meta | project-initializer, brain-curator, codebase-explorer, task-planner, verification-before-completion, skill-author, skill-reviewer |
| engineering | software-engineer, systematic-debugging, test-driven-development, code-review, documentation-engineering |
| business | business-analyst, prd-writer |
| research | web-research, source-verification |
| security | skill-package-audit |
| ml | ml-experiment |
| data | data-analysis |
| science | bioinformatics-pipeline |

`research` also includes `literature-review`.

Full table with capabilities and approvals: [catalog/README.md](catalog/README.md). All are `maturity: draft`.

## For ML, data and research projects

`brain init` understands notebooks, ML/science libraries, data and model folders (names and sizes only), DVC/LFS,
Snakemake/Nextflow and reference genome builds. `brain exp start|log|finish|compare` keeps a reproducible experiment
log whose metrics are read only from result files, and compares runs over seeds with a t-test instead of eyeballing.
See [docs/research-guide.md](docs/research-guide.md).

## Consent and approvals

Agents can *request*; only you can *approve*. `brain consent request …` and `brain remember …` create pending items;
`brain consent approve R-…` and `brain approve P-…` must be run by you in your own terminal and ask you to type a
random code. This stops agents from approving through their normal tools; it cannot stop a process that runs as your
user and deliberately emulates a terminal — for that, use `brain setup --harden` (OS sandbox) on Claude Code. Details:
[docs/security-model.md](docs/security-model.md), [docs/operations.md](docs/operations.md).

## Behavioural evaluations

```bash
node scripts/eval.js list                                  # 102 cases, no execution
node scripts/eval.js run --provider mock --judge mock      # offline harness run (not a skill-quality signal)
node scripts/eval.js run --provider claude-code --dry-run  # live plan: invocations, model, spend cap
```

See [docs/evaluation-guide.md](docs/evaluation-guide.md). No live behavioural run has been performed yet.

## Security and privacy

- Nothing runs on clone or install; only `brain setup` changes agent configuration, after showing a diff.
- No credentials in brain files, the index, the trace or consent records — writes are secret-scanned and rejected.
- The trace stores no prompts or assistant messages (a hash and length only, plus which catalog trigger words matched).
- Connecting a service never authorizes high-impact actions (publish, push, merge, send, deploy, delete, spend).
- Consent decisions live in a hash-chained log; tampering is detected and protected tools then fail closed.
- Repository and web content is treated as data, not instructions.

Details: [docs/security-model.md](docs/security-model.md). Report vulnerabilities per [SECURITY.md](SECURITY.md).

## Documentation

[Vision & principles](docs/vision-and-principles.md) · [Architecture](docs/architecture.md) · [Threat model](docs/threat-model.md) ·
[Operations](docs/operations.md) · [Research guide](docs/research-guide.md) · [Release policy (proposed)](docs/release-policy.md) ·
[Brain spec](docs/brain-spec.md) · [Skill authoring](docs/skill-authoring-guide.md) ·
[Security model](docs/security-model.md) · [Evaluation](docs/evaluation-guide.md) ·
[Compatibility](docs/compatibility.md) · [Roadmap](docs/roadmap.md) · [References](docs/references.md) ·
[Licensing & provenance](docs/licensing-and-provenance.md)

## Development

```bash
node scripts/validate-skills.js && node scripts/build-catalog.js --check && node scripts/scan-skills.js \
  && node scripts/scan-secrets.js && node scripts/run-evals.js && node --test tests/*.test.js
```

(`npm run check` runs the same sequence.) See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 for first-party code and skills ([LICENSE](LICENSE)). Imported skills must keep their own license and
provenance in their manifest.

