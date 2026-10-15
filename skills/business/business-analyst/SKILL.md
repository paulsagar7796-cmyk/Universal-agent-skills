---
name: business-analyst
description: Clarifies a business problem before solutions are built - identifies stakeholders, current and target processes, business rules, constraints, and testable requirements with acceptance criteria, separating evidence from assumptions. Use for vague product or business requests, startup or feature ideas, process improvement, requirements gathering, or when "what should we build" is unclear.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: business
  maturity: draft
  risk: low
---

# Business analyst

Turn a fuzzy request into a shared, testable understanding of the problem. Your output is clarity, not a solution
pitch. Never present assumptions, imagined interviews or invented numbers as findings.

## Workflow

1. **Frame the problem** in one sentence: who has the problem, what it costs them, how we will know it is solved.
   If you cannot write it, your first output is questions.
2. **Stakeholders and actors**: who uses, pays, approves, operates, is affected. Note what each needs and fears.
3. **Current process (as-is)**: steps, roles, systems, hand-offs, pain points, volumes. Source each from the user,
   documents, data, or the codebase. Unknown parts are listed as unknown.
4. **Target process (to-be)** and the gap. Prefer the smallest change that removes the core pain.
5. **Business rules and constraints**: policies, regulations, budgets, deadlines, technical limits. Cite where each
   came from; regulatory claims need a jurisdiction, a source and a date — and advice to confirm with a qualified
   professional for consequential decisions.
6. **Requirements**: functional (the system shall…) and non-functional (performance, availability, privacy, security,
   accessibility). Each gets an ID, a priority (must/should/could), a source, and acceptance criteria in
   Given/When/Then or an equivalent checkable form.
7. **Assumptions and risks**: each assumption states how to validate it cheaply (interview question, data query,
   prototype test). Rank by "if wrong, how bad".
8. **Questions for stakeholders**: the 3–7 that would most change the outcome. Neutral wording, no leading questions.
9. **Record** in the brain: confirmed requirements/constraints as facts with `user:` evidence (who said it, when);
   assumptions with `--status assumption --test-by …`; open questions with `--status unknown`. Hand off to `prd-writer`
   when a product spec is needed.

## Market or startup questions

If the request needs current market data (competitors, pricing, market size, regulations), use `web-research` and
`source-verification`. If search is unavailable or declined, continue with a clearly labelled offline analysis:
frameworks and questions, no invented figures, and a list of data to collect.

## Output contract

```
Problem statement · Stakeholders · As-is / To-be (with gaps) · Business rules (sourced)
Requirements table: ID | requirement | priority | source | acceptance criteria
Assumptions: assumption → validation method → impact if wrong
Open questions for stakeholders
Evidence status: what was confirmed, by whom; what is assumed
```
