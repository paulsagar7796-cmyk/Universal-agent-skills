# Security policy

## Reporting a vulnerability

Please report privately; do not open a public issue for vulnerabilities.
**Maintainers must fill in a contact before publishing** (a security email or GitHub private vulnerability reporting).
Until then, contact the repository owner directly.

Include: affected version/commit, a minimal reproduction, impact, and whether it is being exploited.
We aim to acknowledge within 5 working days and to agree a disclosure date with you.

## Scope

In scope: the `brain` controller (setup, hooks, broker, index, trace), the skill scanner, first-party skills (including
instructions that could cause an agent to act unsafely), templates and CI configuration.

Out of scope: third-party skills you install yourself, agent hosts (report to their vendors), and findings that require
an attacker who can already modify your local files or agent configuration.

## Security properties we intend to hold

- No code runs on clone or package install; there are no npm lifecycle scripts and no runtime dependencies.
- `brain setup` changes only what its displayed plan lists, after consent; backups are written; `brain uninstall`
  removes only owned entries.
- Hooks are bounded, recursion-guarded, never block except to enforce an explicit denial, and store no conversation content.
- Secrets are rejected from brain files, the index, the trace and consent records (pattern-based; not perfect).
- Connecting an integration never authorizes high-impact actions.

## Skill withdrawal

A skill found to be unsafe is marked `maturity: deprecated` (or removed), noted in `CHANGELOG.md` under **Security**,
and an advisory is published. Users who installed it with the `skills` CLI should run `npx skills remove <name>`.

See [docs/security-model.md](docs/security-model.md) for the threat model and known limitations.
