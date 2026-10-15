# What to inspect (in priority order)

Read the smallest set of files that answers: what is this, how is it built and tested, how is it shipped, what
conventions must be followed. Stop when the brief is complete; record the rest as open questions.

| Question | Look at | Record as |
|---|---|---|
| Rules for agents/contributors | `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.cursorrules` | observed, cite file + section |
| Purpose | `README` first section, package description | observed "README says…"; goal stays unknown until the owner confirms |
| Language / framework / versions | `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `pubspec.yaml`, lockfiles, `.nvmrc`, `.tool-versions` | observed with locator (e.g. `package.json#engines.node`) |
| Build, test, lint commands | scripts in manifests, `Makefile`, CI workflow steps | observed "declared, not run" |
| Entry points | manifest `main`/`bin`, `src/main.*`, `cmd/`, `app/`, server bootstrap files | observed with symbol name |
| Data and contracts | migrations, schema files, OpenAPI/GraphQL/protobuf files | observed; do not infer business meaning |
| Deployment | `Dockerfile`, compose files, IaC directories, CI deploy jobs | observed; environments are usually unknown |
| Tests | test directories, test config, CI test job | observed; "passing" only if you ran them |

## Project types that are not web apps

- **Monorepo:** list workspaces/sub-projects; initialise one brain at the repo root and describe each package briefly.
- **Data / notebook project:** record data locations (not contents), notebook count, environment files, how results are reproduced.
- **Research paper / docs repo:** record build tool (LaTeX, Quarto, MkDocs), output targets, citation files.
- **Hardware / embedded:** toolchain, board/target, flashing procedure (never run flashing commands during init).
- **Empty or new project:** record that it is empty; ask for the goal, stack preferences and constraints.

## Evidence locator examples

- `package.json#scripts.test`
- `src/server.ts#createServer`
- `.github/workflows/ci.yml#jobs.test.steps[2]`
- `cmd:0:git rev-parse --show-toplevel`
