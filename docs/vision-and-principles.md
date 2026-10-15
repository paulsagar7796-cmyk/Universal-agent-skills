# Vision and principles

## Vision

An agent opening a project should know — from evidence, not guesses — what the project is, how it is built and
verified, what was decided and why, what is unknown, and where the last session stopped. It should load the procedures
(skills) that fit the task, ask before using integrations or taking high-impact actions, verify its work, and leave the
project's memory better than it found it. This should work across agents, offline, with no hosted service.

## Principles

1. **Evidence over guessing.** Every durable claim carries a status and evidence; unknowns are recorded as questions.
   We mitigate hallucination with provenance, freshness checks and verification; we never claim to eliminate it.
2. **Standards first.** Skills use the open Agent Skills format; installation uses the existing `skills` CLI.
   Structured extras live beside skills (`manifest.yaml`), not in non-standard frontmatter.
3. **Markdown-first, local-first.** Canonical memory is plain files in the repository. Indexes are disposable.
   No account, API key, vector database or network is required.
4. **Explicit trust boundary.** Clone and install execute nothing. `brain setup` shows a diff, asks, backs up,
   records ownership, and can be fully reversed.
5. **Automatic where verified, honest where not.** Automation exists only through tested host adapters. Every other
   agent gets a documented manual path, and the compatibility matrix says which is which.
6. **Consent is specific.** Connecting a service ≠ granting a scope ≠ approving an action. Denials are respected and
   not re-asked.
7. **Small, operational skills.** One job per skill, concrete steps, stop conditions, output contracts, tests.
8. **Privacy by default.** No telemetry. No prompts or assistant messages in traces. No secrets anywhere in the brain.
9. **Measured quality.** Validation, scanning and routing evals run in CI; maturity labels reflect what was actually
   tested; behaviour evals that have not run are reported as not run.

## Non-goals (for now)

A hosted service or UI, a mandatory vector database, an autonomous multi-agent system, a custom skill installer,
"every possible skill", and any claim of zero hallucination.
