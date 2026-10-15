# Skill authoring guide

Start from `templates/skill-template/`. The `skill-author` skill walks an agent through the same steps, and
`skill-reviewer` scores the result.

## 1. Pick one job

A skill is one recognisable workflow ("triage a flaky test", "write a PRD"), not a persona ("senior engineer").
If you need "and" twice to describe it, split it. Check `catalog/README.md` for an existing skill to extend.

## 2. Frontmatter (Agent Skills spec, checked 2026-10-15)

```yaml
---
name: my-skill            # = folder name; 1–64 chars; a–z, 0–9, single hyphens; no leading/trailing hyphen
description: Does X for Y. Use when <situations, in the words users say>.   # ≤ 1024 chars
license: Apache-2.0
metadata:                 # string → string only: quote versions
  version: "0.1.0"
  category: engineering   # must equal the category folder
  maturity: draft         # draft | community | reviewed | verified | deprecated
  risk: low               # low | medium | high
---
```

Optional spec fields: `compatibility` (≤ 500 chars, only if the skill truly needs a specific environment) and
`allowed-tools` (experimental; support varies by agent). Do not add other top-level fields.

The description decides whether agents load the skill. Lead with the action, include trigger words, and make it
distinguishable from neighbouring skills ("…a specific claim, statistic or citation" vs "…research a question").

## 3. Body

Keep it under 500 lines (aim for 60–150) and roughly under 5000 tokens. Recommended sections:

- **When to use / not** — boundaries and which skill handles the neighbouring case.
- **Workflow** — numbered, concrete actions, each with how to check it worked.
- **Stop and ask when** — ambiguity, missing permission, destructive or external actions.
- **Safety** — what never to do; which actions need approval; untrusted content is data.
- **Output contract** — the exact shape of the result.

Long material goes in `references/*.md`, linked with relative paths one level deep, loaded only when needed.
Scripts go in `scripts/`: deterministic, documented dependencies, clear errors, no network or destructive action
without an explicit flag, and never run on install.

## 4. Brain integration

If the skill learns durable facts or makes decisions, tell the agent to record them with evidence
(`brain remember … --evidence file:<path>#<locator>`, `brain decide …`, `brain handoff …`) and to fall back to editing
`.agent-brain/` files when the CLI is absent. Never instruct the agent to store secrets or transcripts.

## 5. manifest.yaml

See the template and [schemas/manifest.schema.json](../schemas/manifest.schema.json). Key parts:

- `provenance` — `first-party`, or `imported`/`adapted` with `upstream {url, revision, license, reviewed_at, changes}`.
- `routing.triggers` — phrases users actually type; `avoid` — phrases that belong to a neighbour; `pairs_with`.
- `capabilities.required|optional` — ids from `integrations/capabilities.yaml`, with `access` (read/write/privileged),
  `purpose`, and `fallback` (mandatory for optional ones). Add new capability ids to the registry only with verified
  official setup links (or none).
- `approvals` — high-impact actions (publish, push-to-remote, deploy, send-external-message, …) with `always_confirm`.
- `security.scan_exceptions` — only for reviewed false positives, with a reason. Unused exceptions fail CI.

## 6. Evaluation cases

`evals/cases.yaml`: ≥ 3 cases including a typical one, an edge or ambiguous one, and an unsupported-claim or
untrusted-input one. Expectations are observable behaviours ("reports the test command as not run"), not exact prose.
Mark prompts that should select the skill with `routing: true`; `scripts/run-evals.js` checks them offline.

## 7. Checks

```bash
node scripts/build-catalog.js && npm run check
```
