---
name: verification-before-completion
description: Gate before saying work is done - runs the relevant checks, compares results against the acceptance criteria, and reports each check as passed, failed, not run or blocked with the exact command. Use whenever finishing a code change, fix, migration or deliverable, and whenever asked whether something works, is ready, or passes.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: meta
  maturity: draft
  risk: low
---

# Verification before completion

"Done" is a claim about the world. Make it only with evidence you produced in this session, and say plainly what
you did not verify.

## Workflow

1. **Collect the criteria**: the user's request, the plan's acceptance criteria, and project checks recorded in the
   brain (`brain search test command`) or manifests/CI config.
2. **Choose checks**, narrowest first: the test(s) for the changed code → the package/module suite → lint/type check
   → build → broader suites the project normally runs before merge. Include a manual reproduction for bug fixes
   (the original failing scenario now succeeds).
3. **Run them** and read the output. Exit code 0 is necessary, not sufficient: confirm the expected tests actually
   ran (count > 0, no "skipped" for the area you changed, no "no tests found").
4. **Classify each check**:
   - **passed** — ran, succeeded, covered the change;
   - **failed** — ran and failed (quote the key error line);
   - **not run** — you chose not to or it was not applicable (say why);
   - **blocked** — could not run (missing dependency, credentials, network, environment) — say exactly what is missing.
5. **Compare against criteria.** Every acceptance criterion maps to at least one passed check or is explicitly unmet.
6. **Fix or report.** If something failed because of your change, fix it and re-run. If it was failing before your
   change, show that (e.g. run on a clean stash/branch only if safe and approved) or state that you did not establish it.
7. **Record**: put the results in the handoff (`brain handoff --check "<cmd>=<result>[: note]"`) and update any brain
   fact that the work verified (`brain verify FACT-… --confirm --evidence cmd:0:<command>`).

## Never

- Say "tests pass", "works", "fixed", "deployed" or "ready" without a check from this session that shows it.
- Weaken, skip or delete tests, or loosen assertions, to make a check pass — unless the user agrees the test was wrong.
- Treat a long-running command you cancelled, or output you did not read, as passed.
- Run destructive or external commands (deploys, migrations on shared databases, publishing) as "verification"
  without explicit approval.

## Output contract

```
Verification
- <command> — passed (N tests) | failed: <key line> | not run: <why> | blocked: <what is missing>
Acceptance criteria: <n>/<m> met; unmet: <list>
Confidence limits: <what these checks do not cover>
```
