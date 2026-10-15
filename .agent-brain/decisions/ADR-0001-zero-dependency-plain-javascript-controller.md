---
id: ADR-0001
title: Zero-dependency plain-JavaScript controller
status: proposed
date: "2026-10-15"
---

# ADR-0001: Zero-dependency plain-JavaScript controller

## Context

The controller runs from agent hooks and must be safe to clone and run without an install step; the spec forbids install-time execution.

## Decision

Write the controller in ESM JavaScript on Node >= 22.13 with no runtime dependencies: node:sqlite for the index, node:test for tests, and a strict YAML-subset parser.

## Alternatives considered

- TypeScript + npm dependencies (yaml, better-sqlite3): type safety, but needs an install/build step and adds supply-chain surface
- Python: not aligned with the skills CLI ecosystem

## Consequences

No type checking; YAML features outside the subset are rejected; FTS5 depends on the Node build (fallback to file scan).

## Revisit when

If contributors need TypeScript or the YAML subset blocks real skills

## Evidence

- file: docs/implementation-plan.md (2026-10-15)
- file: package.json (2026-10-15)
