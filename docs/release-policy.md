# Skill release policy (PROPOSED — pending owner approval)

Status: proposal written 2026-10-15. Until the repository owner approves it, **every skill stays `draft`** and nobody
promotes skills on the basis of this document.

## Maturity levels

| Level | Meaning |
|---|---|
| draft | Passes structural validation, static scan and routing evals. Behaviour not established. |
| community | Published for use by others; not maintainer-reviewed. |
| reviewed | Meets the gate below on at least one agent, plus a maintainer review (not the author). |
| verified | Reviewed, and the gate passes on each claimed agent/model/version combination within the last 90 days. |
| deprecated | Kept for migration only. |

## Promotion gate (draft → reviewed)

All of the following, for one named agent + model + host version:

1. **Structure:** `validate-skills`, official `skills-ref validate`, `scan-skills` clean (exceptions reviewed).
2. **Coverage:** at least 5 cases including ≥ 1 passing `typical`, ≥ 1 passing `edge` or `ambiguous`, ≥ 1 passing
   `unsupported-claim` or `untrusted-input`; every expectation graded (structured, human, or evidence-validated judge).
3. **Behaviour:** no failing cases in the latest live run; any earlier failure has a fix and a re-run.
4. **Security:** zero safety violations across all runs of the last 30 days for that skill (canary disclosure,
   forbidden commands, protected-file writes, denied-capability use, self-approval attempts).
5. **Sample-size honesty:** report case count and graded count with the pass rate. A 5/5 pass rate is evidence of
   basic behaviour on those prompts only — never a quality or security certification.
6. **Human review:** a maintainer other than the author reviews the skill with the `skill-reviewer` rubric and the run
   report, and records the decision (PR approval) with the run id.
7. **Compatibility evidence:** `manifest.yaml` `verified_agents` gets an entry
   `{agent, version, date, evidence: <run id>}` only for combinations that met the gate. Installing a skill
   successfully is not behavioural evidence.

`node scripts/eval.js gate <run-id>` checks items 2–4 automatically and prints "eligible for human review" or the
reasons it is not. It never edits files.

## Demotion

Any safety violation, or a failing case on a claimed combination, returns the skill to `draft` (or `deprecated`) until
fixed and re-run. Promotions expire after 90 days without a re-run.

## Decisions required from the owner

1. Approve, amend or reject this policy.
2. Who may perform the human review (maintainer list).
3. Which agents/models are in scope for `verified`.
4. Budget owner for live evaluation runs.
