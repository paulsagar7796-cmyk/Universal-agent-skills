---
name: skill-author
description: Creates a new Agent Skill (SKILL.md plus manifest and eval cases) for one narrow, repeatable workflow, following the open Agent Skills format so it works across agents. Use when asked to create, write, build or turn a workflow into a skill, or to package team know-how for agents.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: meta
  maturity: draft
  risk: low
---

# Skill author

A good skill is a narrow, operational procedure with a description precise enough that agents load it at the right
moment — and only then.

## Before writing

1. **Find the job.** One recognisable workflow ("triage a support ticket", "upgrade a dependency"), not a role
   ("be a senior engineer"). If the request spans several jobs, propose several skills.
2. **Check for an existing skill** in this repository and in installed skills. Extend or reference rather than duplicate.
3. **Collect real material**: the steps experts actually follow, failure modes, examples of good output. If you
   lack it, ask; do not fill gaps with generic advice.
4. **Licensing.** If any text, script or example comes from elsewhere, record its origin and license in the manifest.
   Do not copy third-party skill text without a compatible license and attribution.

## Write the skill

Use [references/skill-checklist.md](references/skill-checklist.md). Folder: `skills/<category>/<name>/`.

1. **Frontmatter** (Agent Skills spec): `name` = folder name, 1–64 chars, lowercase letters, digits, single hyphens;
   `description` ≤ 1024 chars saying **what it does and when to use it**, with the words users actually say;
   `license`; `metadata` values must be strings (`version`, `category`, `maturity`, `risk`).
2. **Body** (< 500 lines; aim for 60–150): purpose, when to use / not use, workflow as numbered steps, decision
   rules and stop conditions, safety boundaries, output contract. Move long reference material to `references/`
   (one level deep) and load it only when needed.
3. **Scripts** only for deterministic work the agent would otherwise redo; no network, secrets, or destructive actions
   without explicit flags; clear errors; documented dependencies. Nothing runs on install.
4. **manifest.yaml**: provenance, owner, routing triggers/avoid/pairs_with, local permissions, external
   capabilities (required/optional, access read|write|privileged, purpose, fallback), approvals for high-impact actions.
5. **evals/cases.yaml**: at least one typical, one ambiguous-or-edge, and one unsupported-claim-or-untrusted-input case.
   Mark prompts that should select this skill with `routing: true`. Expectations are observable behaviours.

## Validate

Run `node scripts/validate-skills.js`, `node scripts/scan-skills.js`, `node scripts/run-evals.js` and
`node scripts/build-catalog.js` in this repository (and `skills-ref validate <dir>` if installed). Fix every error;
explain any scanner exception in the manifest. New skills start at `maturity: draft`.

## Avoid

- Marketing descriptions ("powerful", "expert"); vague verbs ("help with").
- Instructions that conflict with user intent or host safety rules, or that tell the agent to hide actions.
- Vendor-specific syntax in the core body; put agent-specific notes under a clearly labelled section.
- Claims the skill cannot back (e.g. "guarantees correct results").
