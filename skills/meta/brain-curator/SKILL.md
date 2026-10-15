---
name: brain-curator
description: Keeps the project brain (.agent-brain/) accurate - records new evidence-backed facts, decisions, open questions and handoffs as small reviewed changes, and resolves stale or conflicting memory. Use when asked to remember something, record a decision, update or audit project memory, or hand off work to another session or agent.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: meta
  maturity: draft
  risk: low
---

# Brain curator

Project memory is only useful if it is true, current and small. Your job is to add what future sessions need,
with evidence, and to keep wrong or stale entries from misleading them.

## What belongs in the brain

| Put it in | When |
|---|---|
| `facts.yaml` (via `brain remember`) | Durable claims about the project: stack, commands, contracts, constraints, known issues |
| `decisions/ADR-*.md` (via `brain decide`) | A choice between alternatives with consequences |
| `status.md` | Current task, next actions, blockers — keep it short |
| `handoffs/` (via `brain handoff`) | End of substantial work; what the next session needs to continue |
| `assumptions` / `unknown` facts | Hypotheses (with how to test) and open questions |

Do **not** store: secrets, tokens, personal data, raw chat transcripts, large logs, or things obvious from the code.

## Workflow: recording something

1. **Classify** the item: fact, decision, assumption, open question, task status, or ephemeral (do not store).
2. **Find evidence.** File + locator, command + exit code you actually ran, URL + date, or a named stakeholder note.
   No evidence → it is an `assumption` or `unknown`, never `observed`/`verified`.
3. **Check for duplicates and conflicts:** `brain search <topic>`. If an existing fact covers it, re-verify it
   (`brain verify FACT-… --confirm --evidence …`) instead of adding a copy. Use a stable `--key` (e.g. `db.primary`)
   so future conflicts are detected automatically.
4. **Propose**, don't rewrite: `brain remember --claim "…" --status observed --key … --evidence file:path#locator`.
   Decisions: `brain decide --title … --decision … --alternative … --consequences …`.
5. **Get approval** for anything with risk `review` (conflicts, decisions, product/security claims): show the
   proposal (`brain show P-…`) and ask the user to approve it **themselves, in their own terminal**
   (`brain approve P-…` asks them to type a confirmation code). You cannot approve on their behalf, and you must never
   say a proposal was approved unless `brain status` shows it applied. Low-risk proposals may be auto-applied if the
   user enabled `memory.auto_accept_low_risk`.
6. **Confirm** with `brain status` that the change landed and nothing else was disturbed.

## Workflow: curating (audit)

1. Run `brain audit`. For each **changed/missing** fact, open the evidence file and decide: still true → re-verify;
   no longer true → `brain deprecate FACT-… --reason "…"` and propose the corrected fact.
2. **Disputed** facts: present both sides with their evidence and ask the owner. They approve the winner with
   `brain approve P-… --supersede` in their terminal; never pick silently.
3. Open questions that have been answered → record the answer as a fact with the stakeholder as evidence (`user:` note).
4. Keep `status.md` to what is true now; move history into handoffs.

## Handoff contract

`brain handoff --task "…" --done "…" --next "…" --blocker "…" --check "<command>=passed|failed|not-run|blocked[: note]" --assumption "…"`.
Every check you mention must have actually run, or be marked `not-run`/`blocked`. Git state is captured automatically.

## Source priority when things disagree

Current repository behaviour: checked-in code/config and commands you ran > old memory. Library behaviour: current
official docs for the installed version > model recall. Product intent: explicit stakeholder statements and accepted
decisions > implementation details. If two good sources disagree, mark `disputed`; do not resolve by guessing.

## Without the CLI

Edit the files directly following `.agent-brain/README.md`: same statuses, same evidence fields, small diffs, and
show the diff to the user for anything that is not a mechanical update.
