# Skill checklist

## SKILL.md

```markdown
---
name: <folder-name>
description: <What it does>. Use when <triggers in the user's words>.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: <meta|engineering|business|research|security|...>
  maturity: draft
  risk: <low|medium|high>
---

# <Title>

<One paragraph: the job and the standard of done.>

## When to use
## Workflow
1. …
## Stop and ask when
## Safety
## Output contract
```

- [ ] `name` matches the folder; no uppercase, no double hyphen, no leading/trailing hyphen
- [ ] `description` states what + when, ≤ 1024 chars, no ": " issues (quote it if it contains a colon followed by a space)
- [ ] every `metadata` value is a quoted string
- [ ] body < 500 lines; references linked with relative paths, one level deep
- [ ] steps are concrete actions with verification, not exhortations
- [ ] stop conditions and approval gates are explicit
- [ ] no secrets, no hidden network calls, no instructions to bypass user or host controls

## manifest.yaml

```yaml
schema_version: 1
id: <name>
owner: <team or person>
provenance:
  origin: first-party            # or imported / adapted
  authors: [<names>]
  created: "YYYY-MM-DD"
  upstream:                      # required when imported/adapted
    url: <repository or page>
    revision: <commit or release>
    license: <SPDX id>
    reviewed_at: "YYYY-MM-DD"
    changes: <what you changed>
routing:
  intents: [build|debug|test|research|business|docs|review|plan|brain|skills]
  triggers: [<phrases users say>]
  avoid: [<phrases that mean a different skill>]
  pairs_with: [<supporting skills>]
local_permissions: [filesystem.read, filesystem.write, shell.read-only, shell.exec, git.read, git.write]
capabilities:
  required:
    - id: web.search             # must exist in integrations/capabilities.yaml
      access: read               # read | write | privileged
      purpose: <why the workflow needs it>
      fallback: <what to do without it>
  optional: []
approvals:
  - action: publish              # see privileged_actions in integrations/capabilities.yaml
    always_confirm: true
verified_agents: []
security:
  scan_exceptions: []            # [{rule, file, reason}] — reviewed explanations only
```

## evals/cases.yaml

```yaml
schema_version: 1
skill: <name>
cases:
  - id: <short-id>
    kind: typical | edge | ambiguous | unsupported-claim | untrusted-input
    routing: true                # this prompt should select the skill
    prompt: <what a user would say>
    fixture: <state of the world, optional>
    expect:
      must: [<observable behaviour>]
      must_not: [<forbidden behaviour>]
```
