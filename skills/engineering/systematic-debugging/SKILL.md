---
name: systematic-debugging
description: Finds the root cause of a bug, failing test, crash, error or regression by reproducing it, isolating it, and testing one hypothesis at a time before fixing, then proves the fix with a regression test. Use when something is broken, failing, flaky, throwing an exception, or behaving unexpectedly and the cause is not yet known.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: engineering
  maturity: draft
  risk: medium
---

# Systematic debugging

Do not fix what you have not explained. Guess-and-patch cycles create new bugs and hide the real one.

## Workflow

1. **Capture the symptom exactly**: error message, stack trace, inputs, environment, expected vs actual, when it
   started (commit, deploy, dependency change). Check the brain for known issues (`brain search <error words>`).
2. **Reproduce** with the smallest reliable command or test. Write it down. If you cannot reproduce, gather more data
   (logs, versions, configuration differences) instead of changing code; say the bug is unconfirmed.
3. **Isolate.** Narrow the failing region: bisect inputs, comment-free toggles (flags, env), `git bisect` between a
   known-good and known-bad commit (read-only; ask before checking out over uncommitted work), or add temporary logging.
4. **Hypothesise and test one at a time.** For each hypothesis write: prediction → experiment → result. Discard
   hypotheses the evidence contradicts. Keep a short log; it becomes the explanation.
5. **Explain the root cause** in one or two sentences that account for *all* symptoms (including why it did not
   fail before, if it is a regression). If the explanation does not cover everything, keep isolating.
6. **Fix at the cause**, not the symptom. Prefer the smallest change that removes the cause. Note other places the
   same pattern exists — report them rather than silently widening the change.
7. **Regression test** that fails before the fix and passes after; run it both ways when practical.
8. **Verify** (`verification-before-completion`) and remove temporary logging/debug code.
9. **Record**: the root cause and any non-obvious gotcha as a fact with evidence; failed approaches only if they will
   save future time.

## Flaky failures

Run the test repeatedly (with a bound) and record the failure rate. Suspect ordering, shared state, time/timezones,
randomness, concurrency, network, and resource limits. Never "fix" flakiness by adding retries or sleeps without
explaining the race.

## Stop and ask when

Reproducing needs production data, credentials, destructive operations, or paid resources; or the fix requires a
behaviour change users would notice.

## Output contract

```
Symptom: …            Reproduction: <command>
Root cause: <explanation with file#symbol evidence>
Hypotheses ruled out: …
Fix: <files>          Regression test: <name> (fails before / passes after: yes/no/not checked)
Verification: <command — result>
```
