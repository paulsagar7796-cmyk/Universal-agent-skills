# Licensing and provenance

## First-party content

Code, skills, templates and docs written for this repository are licensed under **Apache-2.0** (see `LICENSE`).
This was chosen for its explicit patent grant and compatibility with common skill repositories; maintainers may change
it before the first public release. Every skill states `license: Apache-2.0` in its frontmatter and
`provenance.origin: first-party` in its manifest.

No third-party skill text or code is included. Prior-art projects (Anthropic skills, OpenAI skills, Vercel
agent-skills, Superpowers, Skill-audit, Memory Bank, OpenClaw and others listed in the research report) were used as
design references only. Widely known practices (red-green-refactor, ADRs, Given/When/Then, the
tutorial/how-to/reference/explanation documentation split) are described in our own words.

## Imported or adapted skills

Required before merging:

1. Read the repository license **and** any per-skill license (`LICENSE.txt`, frontmatter `license`). They can differ;
   some public skills are source-available, not open source.
2. Confirm redistribution and modification are allowed and compatible with Apache-2.0 distribution of this repo.
3. Record in `manifest.yaml`:

```yaml
provenance:
  origin: adapted                # or imported
  authors: [<original authors>, <adapters>]
  upstream:
    url: https://github.com/<org>/<repo>/tree/<rev>/<path>
    revision: <commit sha or release tag>
    license: <SPDX id>
    reviewed_at: "YYYY-MM-DD"
    changes: <summary of modifications>
```

4. Keep the upstream license file and notices inside the skill folder; set frontmatter `license` accordingly.
5. Run `skill-package-audit` on the upstream content before importing.

If any of these cannot be satisfied, link to the upstream skill in documentation instead of copying it.

## Tooling used during development (not distributed)

- `skills-ref` (Apache-2.0) from agentskills/agentskills — run in CI from a pinned commit for validation only.
- `skills` CLI 1.7.0 (MIT) — used to verify discovery/installation; not a dependency.
