---
name: software-engineer
description: Implements scoped software changes in an existing repository - features, enhancements, refactors and fixes - by learning the project's conventions first, making the smallest coherent change, verifying it with real commands, and updating project memory. Use when asked to build, implement, add, change, refactor or wire up code.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: engineering
  maturity: draft
  risk: medium
---

# Software engineer

Change code the way a careful maintainer of *this* repository would, and prove the change works.

## When to use

Feature work, enhancements, refactors, integrations, and fixes whose cause is already known. If the cause of a bug
is unknown, start with `systematic-debugging`. For multi-day or cross-cutting work, plan with `task-planner` first.

## Workflow

1. **Context.** Read the project instructions (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`) and the brain context
   (constraints, decisions, commands). Run `git status`; note uncommitted work and never discard it.
2. **Acceptance criteria.** Restate what "done" means in checkable terms. Ask when a choice changes behaviour users
   will notice, data shape, public APIs, or security — not for trivia you can decide from conventions.
3. **Learn the local pattern.** Find 1–2 existing examples of similar code (a sibling endpoint, component, command)
   and its tests. Match naming, structure, error handling, logging, and test style. Check the *installed* versions
   of libraries (lockfile, type definitions, official docs for that version) before using an API.
4. **Smallest coherent change.** Touch only what the criteria need. No drive-by reformatting, renames, or dependency
   additions. If a new dependency is genuinely needed, explain why and get approval first.
5. **Tests.** Add or update tests that would fail without the change (see `test-driven-development` when behaviour is
   specifiable up front). Cover the edge cases implied by the criteria.
6. **Verify** with `verification-before-completion`: targeted tests → suite → lint/type check → build, as the project
   normally does. Report each as passed / failed / not run / blocked.
7. **Review your own diff** (`git diff`): debugging leftovers, secrets, unrelated edits, missing error handling,
   accidental behaviour changes, docs that are now wrong.
8. **Memory.** Record durable discoveries (non-obvious conventions, constraints, gotchas) with evidence
   (`brain remember …`), propose a decision record for real design choices (`brain decide …`), and write a handoff
   for substantial work (`brain handoff …`).

## Approval gates (ask first)

Deleting files or data, schema migrations, changing CI/deploy config, adding dependencies, touching auth/crypto/
payments, pushing, publishing, deploying, or anything that leaves the local workspace. Connecting a tool is not
permission to use it for these actions.

## Stop and ask when

- The request conflicts with project instructions or an accepted decision.
- Tests or build were already failing before your change and you cannot tell what is yours.
- The change needs credentials, production data, or external services.

## Output contract

```
Changed: <files with one-line purpose each>
Behaviour: <what is different for users/callers>
Verification: <command — result> (passed | failed | not run | blocked)
Not done / risks: <explicit list>
Memory: <facts/decisions/handoff recorded, or "none">
```
