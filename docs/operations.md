# Operations guide

Commands assume `alias brain="node ~/agent-skills-brain/bin/brain.js"` and a project directory as the working directory.

## Run every check

```bash
npm run check            # validator, catalog drift, skill scan, secret scan, routing evals, all tests
node scripts/eval.js run --provider mock --judge mock   # offline behavioural-harness run (tests the harness)
```

Individual pieces: `node scripts/validate-skills.js`, `node scripts/build-catalog.js --check`,
`node scripts/scan-skills.js`, `node scripts/scan-secrets.js`, `node scripts/run-evals.js`,
`node --test tests/*.test.js`, `node --test tests/security.test.js` (adversarial consent tests).
Tests that need a pseudo-terminal use the system `script` utility (present on macOS and most Linux distributions); they
are skipped with a message if it is missing.

## Consent: request, approve, inspect, revoke

| Who | Command | Effect |
|---|---|---|
| anyone | `brain consent status` | Integrity, decisions, blocked capabilities, pending requests |
| anyone | `brain consent explain <capability|action:NAME|skill>` | Why a capability is allowed/blocked and what to do |
| agent or user | `brain consent request web.search --access read --scope project --reason "…" [--skill s] [--expires ISO]` | Pending request; no effect |
| **user, own terminal** | `brain consent approve R-…` | Shows the request; you type a random code; records a human grant |
| **user, own terminal** | `brain consent grant github.write --access write --scope once` | Direct grant (same challenge) |
| agent or user | `brain consent deny web.search` / `brain consent revoke web.search` | Takes effect immediately |
| agent or user | `brain consent reject R-…` | Drops a pending request |
| anyone | `brain authorize publish [--always-confirm]` | allow / ask / deny for a high-impact action; consumes once-grants |

"Own terminal" means a shell you opened yourself — not the agent's tools and not Claude Code's `!` prefix (the command
refuses when `CLAUDECODE` is set). Scopes: `once` (consumed on use), `session` (needs `--session`), `project`.
A later decision overrides an earlier one; an approval you make after a denial re-enables the capability.

Memory proposals work the same way: the agent runs `brain remember …` / `brain decide …`; you run
`brain approve P-…` (or `brain reject P-…`).

## Declaring an integration dependency for a skill

1. Use an existing capability id from `integrations/capabilities.yaml` (`web.search`, `web.fetch`, `github.read`,
   `github.write`) or add one there: description, `access_levels`, providers with a **verified** official setup URL
   and `verified_on` date (omit the URL if you cannot verify it), and `claude_code_tools` regexes for enforcement.
2. In the skill's `manifest.yaml`:

   ```yaml
   capabilities:
     required:
       - id: web.search
         access: read          # read | write | privileged — the minimum the workflow needs
         purpose: find current sources
         fallback: offline answer labelled not current
   approvals:
     - action: publish        # high-impact actions need their own approval, regardless of connections
       always_confirm: true
   ```

   Only `id`, `access`, `purpose`, `fallback` are accepted; anything else (e.g. `granted: true`) fails validation.
3. Run `node scripts/validate-skills.js && node scripts/build-catalog.js`.
4. If the registry changed, run `brain repair` in projects that were set up earlier (the hooks fail closed for
   protected tools until the new registry hash is approved).

## Recover after a Node upgrade, moved checkout or damaged install

```bash
brain doctor            # read-only diagnosis
brain setup --dry-run   # what repair would change (diff)
brain repair            # re-apply the recorded setup; asks before changing anything
```

`brain doctor` reports: recorded node binary missing (hooks fall back to `node` on PATH meanwhile), controller files
modified/missing/new since setup, owned hooks missing or edited, hardening entries missing, an interrupted setup
(`state: applying`), and policy integrity. `brain repair` re-records controller checksums **only after you approve** —
review the change first (`git -C ~/agent-skills-brain log -p`).

What the checksums prove: the controller files match what you approved at setup (trust on first use). They do **not**
prove the files are authentic upstream code — a checksum taken from an already-compromised checkout is not a security
guarantee.

To remove everything setup added: `brain uninstall` (shows the diff first). Project memory in `.agent-brain/` is kept.

## Policy integrity failure

`brain consent status` shows `FAILED — <reason>` and protected capabilities are blocked. Investigate before fixing:
`git log -p .agent-brain/` will not help (the policy is gitignored); check `.agent-brain/local/policy/consent.json`
and `head.json`, and backups if you keep them. Options: restore a known-good copy, or deliberately start a new policy
log by moving the directory aside (`mv .agent-brain/local/policy /tmp/policy.broken`) and the home mirror
(`~/.agent-skills-brain/policy-heads/<project-id>.json`), then re-approve what you need. Treat an unexplained failure as
a possible tampering attempt.

## Investigate a security finding

1. Reproduce with the smallest case: `hook('pre-tool-use', …)` for host behaviour, `tests/pty.js` for terminal paths,
   library calls for policy logic — add it to `tests/security.test.js`.
2. Classify the layer that failed (recorded policy / host guardrail / OS sandbox / advisory) using
   [security-model.md](security-model.md).
3. Record host and version for anything involving a real agent; for a live check use a scratch project and a
   `--max-budget-usd` cap.
4. Report privately per [SECURITY.md](../SECURITY.md).

## Add a new skill and evaluation cases

See [skill-authoring-guide.md](skill-authoring-guide.md) and [evaluation-guide.md](evaluation-guide.md#adding-or-changing-cases).
