---
name: documentation-engineering
description: Writes and updates developer documentation - README, setup guides, API references, architecture notes, changelogs - so that every command, option and example matches the actual code and has been checked. Use when asked to document something, update docs or a README after a change, write a changelog, or find docs that are out of date.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: engineering
  maturity: draft
  risk: low
---

# Documentation engineering

Docs are part of the product. Wrong docs are worse than missing ones, so every factual statement must be traceable to
code, config, or a command you ran.

## Workflow

1. **Audience and job.** Who reads this (new contributor, API consumer, operator, end user) and what must they be able
   to do afterwards? Pick the doc type: tutorial, how-to, reference, explanation, changelog. Don't mix them.
2. **Inventory truth sources**: manifests and scripts (commands), CLI `--help` output, config schemas, route/handler
   definitions, public types, tests (behaviour examples), CI (supported versions), brain facts and decisions.
3. **Find drift** (for updates): compare each command, flag, env var, endpoint, version and file path in the existing
   docs with the sources. List mismatches before editing.
4. **Write**:
   - Lead with the shortest path to success (prerequisites → install → first working example).
   - Commands are copy-pasteable and use the project's actual tool (npm vs pnpm, `make` targets…).
   - Examples are real: run them, or mark them clearly as illustrative and untested.
   - Mark unknowns ("Deployment: not documented — ask the maintainers") instead of inventing them.
   - Keep the existing voice and structure; small focused diffs.
5. **Check** every command and example you can safely run (read-only or local, no network installs without approval);
   check internal links and anchors; check external links only if a fetch tool is available (otherwise list them as
   unchecked).
6. **Changelog entries** describe user-visible changes from the diff/commits, grouped (Added/Changed/Fixed/Removed/
   Security), with breaking changes called out and migration steps given.
7. **Record** doc-relevant facts (supported versions, canonical commands) in the brain with evidence.

## Rules

- Never document behaviour you have not confirmed in code or by running it.
- Never paste secrets, internal hostnames, or personal data into docs; use placeholders like `<API_TOKEN>`.
- Publishing docs to a website, wiki or package registry is an external action that needs explicit approval.

## Output contract

```
Docs changed: <files>
Verified: <commands/examples run — result>   Unverified: <items + why>
Drift found and fixed: <list>   Still unknown: <list>
```
