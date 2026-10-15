---
name: test-driven-development
description: Writes tests before or alongside code using a red-green-refactor loop - specify one behaviour as a failing test, make it pass with the simplest change, then clean up with tests green. Use when adding tests, when behaviour can be specified up front, for bug fixes needing a regression test, or when asked for TDD or better coverage.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: engineering
  maturity: draft
  risk: low
---

# Test-driven development

Tests are executable acceptance criteria. Write the one that proves the behaviour, watch it fail for the right reason,
then make it pass.

## When to use / not

Use for new behaviour with clear inputs/outputs, bug fixes (the failing test is the reproduction), refactors that need
a safety net (characterisation tests first), and coverage gaps in risky code.
Do not force it for exploratory spikes or pure UI layout tweaks — but add a test once behaviour stabilises.

## Loop

1. **Find the harness.** Identify the project's test framework, file naming, fixtures/factories, and the command that
   runs a single test (record it in the brain if it is not there). Do not introduce a new framework without approval.
2. **Red.** Write one small test for one behaviour, named for the behaviour ("rejects expired coupons"). Run it.
   It must fail, and fail for the expected reason (assertion on the behaviour — not an import error or typo).
3. **Green.** Make the simplest production change that passes it. Run the test, then the surrounding file/suite.
4. **Refactor.** Remove duplication and clarify names in code *and* tests while everything stays green.
5. **Repeat** for the next behaviour: edge cases, error paths, boundaries (empty, max, invalid, concurrent, timezone).
6. **Finish** with `verification-before-completion`: full relevant suite, lint/type check.

## Test quality rules

- Assert observable behaviour, not private implementation details.
- One reason to fail per test; clear arrange / act / assert.
- Deterministic: control time, randomness, network and ordering. No sleeps to wait for async work.
- Use real collaborators where cheap; mock only boundaries (network, clock, filesystem, paid APIs).
- Never weaken an assertion, mark a test skipped, or update a snapshot just to get green without understanding why.
- Tests must not need secrets or production services; use fixtures with fake data.

## Characterisation tests for legacy code

Before changing untested code, write tests that pin current behaviour (even if odd), mark surprising behaviour in the
test name, and ask before "correcting" it.

## Output contract

For each behaviour: test name → red (failure reason) → green (change) → result. Then the final suite command and result.
