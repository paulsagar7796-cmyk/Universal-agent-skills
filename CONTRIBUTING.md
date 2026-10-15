# Contributing

Thanks for helping. Quality beats quantity here: one skill that reliably does its job is worth more than ten generic ones.

## Development setup

Node.js ≥ 22.13. No `npm install` is needed (there are no dependencies).

```bash
npm run check        # validate, catalog drift, skill scan, secret scan, routing evals, tests
```

## Adding or changing a skill

1. Copy `templates/skill-template/` to `skills/<category>/<name>/` (folder name = `name`).
2. Follow [docs/skill-authoring-guide.md](docs/skill-authoring-guide.md). Keep `SKILL.md` operational and short.
3. Fill `manifest.yaml`: provenance (and upstream license for imported/adapted material), routing triggers,
   local permissions, external capabilities with fallbacks, approvals for high-impact actions.
4. Write `evals/cases.yaml`: at least one typical, one edge/ambiguous, one unsupported-claim/untrusted-input case;
   mark prompts that should select the skill with `routing: true`.
5. `node scripts/build-catalog.js`, then `npm run check`. Optionally run the official validator (see CI).
6. New skills are `maturity: draft`. Promotion rules are in [docs/evaluation-guide.md](docs/evaluation-guide.md).

## Changing the controller

- Keep zero runtime dependencies and no lifecycle scripts.
- Add tests for new behaviour, including failure and denial paths. Setup tests must use a temporary `HOME`.
- Never log prompts, assistant messages, file contents or credentials.
- Hooks must not block the host except for explicit-denial enforcement.

## Imported or adapted content

Record `provenance.origin: imported|adapted` and `upstream` (url, revision, license, reviewed_at, changes). Do not
import content whose license does not allow redistribution and modification. When in doubt, link instead of copying.
See [docs/licensing-and-provenance.md](docs/licensing-and-provenance.md).

## Pull requests

Describe what changed and why, list the checks you ran with results, and note anything not verified. By contributing
you agree your contribution is licensed under Apache-2.0.
