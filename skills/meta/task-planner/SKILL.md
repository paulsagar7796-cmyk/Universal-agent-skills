---
name: task-planner
description: Turns a request into a small, ordered execution plan with explicit acceptance criteria, risks, dependencies and verification steps, and records it in the project brain. Use before non-trivial work, when asked to plan, scope, break down or estimate a task, or when requirements are unclear.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: meta
  maturity: draft
  risk: low
---

# Task planner

A plan is a contract for "done". It must be checkable, minimal, and honest about what is unknown.

## When to use

- Any change touching several files/components, an unfamiliar area, data migrations, or external systems.
- The user asks to plan, scope, break down, estimate, or "think before coding".
- Requirements are ambiguous — the plan's open questions become the clarification you send.

Skip it for one-line fixes; just do them and verify.

## Workflow

1. **Restate the goal** in one sentence and list explicit constraints from the user and the brain (`project.md`,
   accepted decisions). If the goal is unclear, write the questions first — do not plan around a guess.
2. **Map the ground truth.** Identify the files/components involved (use `codebase-explorer` if needed) and the
   checks that exist (tests, linters, type checks, CI jobs). Cite what you looked at.
3. **Write acceptance criteria** that an outsider could verify: observable behaviour, commands that must pass,
   artefacts that must exist. Avoid "works well", "clean", "robust".
4. **Order the steps** as small, independently verifiable increments. Each step names: change, files, how it is
   verified, and rollback if risky. Put the riskiest unknown first (spike or test) when it could invalidate the plan.
5. **List risks and approvals**: destructive operations, migrations, external writes, deployments, cost, security.
   Mark which steps need explicit user approval before running.
6. **Estimate only with stated basis** ("3 files, existing test harness"); give a range, never false precision.
7. **Save** the plan to `.agent-brain/plans/PLAN-YYYY-MM-DD-<slug>.md` using
   [references/plan-template.md](references/plan-template.md), and set `status.md` → Current to point at it.
8. **Confirm with the user** when the plan has open questions, approvals, or more than a few hours of work.

## Rules

- Plans describe intended work; never present planned checks as completed.
- Do not pad plans with generic steps ("write clean code", "add comments").
- If new evidence breaks an assumption mid-task, update the plan file and say what changed.

## Output contract

Goal · Acceptance criteria (checklist) · Steps (with verification each) · Risks & approvals · Open questions · Estimate with basis · Plan file path.
