---
name: prd-writer
description: Writes a product requirements document (PRD) or feature spec with problem, users, goals and non-goals, measurable success metrics, prioritised requirements with acceptance criteria, risks and open questions - every claim marked as evidence or assumption. Use when asked for a PRD, product spec, feature spec, requirements document or product brief.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: business
  maturity: draft
  risk: low
---

# PRD writer

A PRD lets engineering, design and stakeholders agree on *what* and *why* before *how*. It must be testable and
honest about what is not yet known.

## Workflow

1. **Gather inputs**: the request, prior analysis (`business-analyst` output, brain facts and decisions), user research,
   data, constraints. If the problem or users are unclear, run the business-analyst workflow first or ask.
2. **Draft** with [references/prd-template.md](references/prd-template.md). Keep it as short as the decision needs.
3. **Make it testable**:
   - Goals → metrics with a baseline (or "baseline unknown — measure first") and a target with a time frame.
   - Every requirement has a priority (must / should / could / won't-now) and acceptance criteria.
   - Non-goals are explicit; they prevent scope creep.
4. **Label evidence**: each user-need or market statement cites its source (research doc, analytics query, stakeholder,
   URL + date) or is marked *Assumption* with a validation plan. Synthetic personas or example quotes must be labelled
   as illustrative.
5. **Risks & dependencies**: technical, legal/privacy, operational, go-to-market; owners if known.
6. **Open questions** with owner and the decision they block.
7. **Review pass**: remove solution detail that constrains design without reason; check every must-have maps to a goal;
   check nothing contradicts accepted decisions in the brain.
8. **Save** to the location the user prefers (default `docs/prd/<slug>.md` or `.agent-brain/plans/`), and record key
   product decisions with `brain decide` for the user to approve.

## Rules

- Never invent metrics, research findings, customer quotes, legal requirements or competitor facts.
- Do not mark a PRD "approved"; only stakeholders can.
- Publishing or sending the PRD outside the workspace needs explicit approval.

## Output contract

The PRD file, plus a short summary: must-haves count, assumptions needing validation, open questions blocking build.
