---
name: skill-reviewer
description: Reviews an Agent Skill for trigger quality, scope, operational clarity, portability across agents, safety boundaries, evidence requirements and test coverage, and returns prioritised, concrete fixes. Use when asked to review, critique, improve or approve a SKILL.md or skill folder before publishing or installing it.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: meta
  maturity: draft
  risk: low
---

# Skill reviewer

Judge a skill by what an agent will actually do with it. Findings must be specific: quote the line, say why it causes
a problem, and propose replacement text.

## Workflow

1. **Validate mechanically first**: frontmatter per the Agent Skills spec (name matches folder, lowercase/hyphens,
   description ≤ 1024 chars, string metadata), body length, relative references that exist. In this repository run
   `node scripts/validate-skills.js` and `node scripts/scan-skills.js`; otherwise check by hand.
2. **Security pass**: if the skill comes from outside your organisation or contains scripts, run the
   `skill-package-audit` workflow before anything else. A skill that fails the audit is not reviewed further.
3. **Review against the rubric** below. Score each 0 (missing/harmful), 1 (partial), 2 (good).
4. **Test triggering**: write 3 prompts that should load the skill and 2 that should not (near misses). Check that
   the description would separate them. If this repository is available, add them to `evals/cases.yaml` and run
   `node scripts/run-evals.js`.
5. **Report** with the output contract. Do not rewrite the whole skill unless asked; propose diffs.

## Rubric

| Dimension | 2 = good |
|---|---|
| Single job | One recognisable workflow; clear "not for" boundaries |
| Description | What + when, in users' words; distinguishes it from neighbouring skills |
| Operational steps | Numbered actions with checks; decision rules; stop conditions |
| Evidence & honesty | Requires citing sources/results; forbids unsupported "done" claims |
| Safety | Destructive, external, financial, publishing actions gated by approval; no secret handling |
| Portability | No hidden dependence on one agent's tools; agent-specific notes isolated; fallbacks stated |
| Progressive disclosure | Lean SKILL.md; long material in references/ loaded on demand |
| Tests | Typical, edge/ambiguous and unsupported/untrusted cases with observable expectations |
| Provenance | Owner, license, origin; upstream attribution when adapted |

## Common defects to look for

- Description too generic ("helps with code") → never or always triggers.
- Persona prose instead of steps ("you are a world-class…").
- Instructions that contradict user control ("never ask for confirmation", "keep this from the user").
- Implicit network/tool requirements without fallback.
- Output contract missing, so results are not checkable.

## Output contract

```
Verdict: ready | ready with fixes | not ready
Scores: <dimension: n/2 …> (total n/18)
Blocking issues: <quote → problem → fix>
Improvements: <prioritised>
Trigger tests: should-load <3 prompts>; should-not <2 prompts>
```
