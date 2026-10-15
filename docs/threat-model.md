# Threat model

Scope: the `brain` controller (consent policy, approvals, hooks, setup), the skills it ships, and the evaluation
harness. Last reviewed 2026-10-15 against Claude Code 2.1.300 on macOS. See [security-model.md](security-model.md) for
which controls exist and how strong each one is.

## Assets

| Asset | Why it matters |
|---|---|
| Consent policy (`.agent-brain/local/policy/`) | Decides which integrations and high-impact actions the agent may use |
| Pending requests / restrictions (`local/requests.json`) | Records denials an agent or user made; deleting them could re-enable a capability |
| Project memory (`facts.yaml`, decisions, handoffs) | Future sessions trust it; poisoned memory misleads them |
| Brain config (`config.yaml`) | Controls auto-accept and enforcement mode |
| Agent settings (`.claude/settings*.json`, `~/.claude/settings.json`) | Hooks, permissions and sandbox configuration |
| Controller code + capability registry | Decide what the hooks enforce |
| Secrets in the working tree (`.env`, keys) | Must never enter memory, traces or reports |

## Actors

1. **Honest but fallible agent** — tries to help, misreads instructions, over-reaches ("the user surely meant yes"),
   or claims success it did not verify.
2. **Prompt-injected agent** — follows instructions planted in READMEs, code comments, issues, web pages, build logs or
   skill files.
3. **Malicious or compromised skill** — a third-party skill whose instructions or scripts try to exfiltrate data,
   escalate permissions or hide actions.
4. **Accidental over-permissioning** — a user or setup grants broader or longer access than a task needs.
5. **Agent with arbitrary shell execution** — any agent whose tools run commands as the user's OS account. It can
   read and write the same files as the user, start processes, and emulate a terminal.
6. **Out of scope:** an attacker who already controls the user's account, the OS, Node.js, or the agent host itself.

## Threats and treatment

| # | Threat | Actor | Treatment | Residual risk |
|---|---|---|---|---|
| T1 | Agent grants itself a capability (`brain consent grant`) or approves its own memory proposal (`brain approve`) | 1, 2, 3 | Human-only commands behind a terminal challenge (refused without a controlling TTY, inside agent sessions and hooks); Claude Code PreToolUse guard blocks the commands; OS sandbox denies writes to the policy (opt-in `--harden`) | Without the sandbox, a deliberate same-user process can emulate a terminal or rewrite files (T6) |
| T2 | Agent converts a denial into a grant by editing policy files | 2, 5 | Hash-chained policy log with head mirror → integrity failure → everything protected fails closed; guard blocks file-tool edits; sandbox denies shell writes | A process that rewrites the whole chain and both heads consistently is not detected (test "known limitation") |
| T3 | Agent uses a denied integration anyway | 1, 2 | Claude Code PreToolUse blocks mapped tools (WebSearch, WebFetch, GitHub MCP) with `onFailure: "block"`; denylist or allowlist mode | Tools not in the registry (other MCP servers, Bash `curl`) are not mapped; other agents have no enforcement |
| T4 | Connecting a service is treated as permission to act (publish, push, merge, send, deploy) | 1, 4 | Separate action grants; `always_confirm` actions ignore standing grants; once-grants are consumed | Enforcement of action approval depends on the agent calling `brain authorize` (advisory) |
| T5 | Availability mistaken for permission | 1 | Observations (`capabilities record … available`) never authorize; `proceed` needs a human grant **and** an observation | — |
| T6 | Same-user process bypasses every in-process check | 5 | Documented boundary; opt-in OS sandbox for agent shell commands; Edit deny rules for file tools | Hooks, MCP servers and file tools run outside the sandbox; a host without a sandbox has no boundary |
| T7 | Prompt injection asks for secrets or destructive commands | 2 | Skills treat repository/web text as data; secrets rejected from memory/trace/consent; init redacts credentials from copied text (fixed in phase 2); eval harness plants a canary and fails any case that discloses it | Model behaviour is probabilistic; only measured by behavioural evals |
| T8 | Malicious skill ships instructions/scripts | 3 | `skill-package-audit` static scanner + manual review; manifests cannot self-grant (`granted:` fields rejected); nothing executes on install | Static scanning misses novel or obfuscated payloads |
| T9 | Tampered or unparseable capability registry disables enforcement | 5 | Registry hash recorded at setup; drift or load failure → protected tools fail closed; conservative fallback patterns | Drift check uses trust-on-first-use hashes from the same checkout |
| T10 | Broken controller (Node upgrade, moved checkout) silently disables enforcement | 4 | PATH fallback in hook commands; capability hook `onFailure: "block"`; `brain doctor` / `brain repair` | Guard hook fails open (deliberately) to avoid blocking every Bash call |
| T11 | Poisoned project memory | 2 | Evidence-required facts, proposals, human approval for review-risk items, disputes instead of overwrites, freshness checks | Agents can still edit brain Markdown directly (file-only mode); changes are visible in git |
| T12 | Setup damages unrelated configuration | 4 | Plan/diff, consent, backups, ownership markers, journaled apply, exact uninstall (tested in temp HOME) | Manual edits inside owned entries are replaced by repair |
| T13 | Secrets or private content leak through eval artefacts | — | Transcripts redacted (credentials, canary, absolute paths), truncated, stored under ignored `evals/results/`; live runs require explicit consent | Prompts and fixture content are sent to the model provider during live runs (synthetic fixtures only) |

## Findings and status (phase 2 audit)

| ID | Finding | Status |
|---|---|---|
| F1 | `brain consent grant` freely invokable; denial → grant | **Fixed**: human gate + guard + optional sandbox; regression tests in `tests/security.test.js` |
| F2 | `brain approve` freely invokable | **Fixed**: human gate + guard |
| F3 | Malformed consent file → hook exception → fail open | **Fixed**: integrity check; fail closed for protected tools |
| F4 | "available" observation authorized use without consent | **Fixed**: observations never authorize |
| F5 | Registry edits / load errors fail open | **Fixed**: fallback patterns + setup-time hash drift check → fail closed |
| F6 | PreToolUse timeout lets tool run | **Mitigated**: `onFailure: "block"` on the capability hook (host-verified that settings load) |
| F7 | `config.yaml` agent-editable (auto-accept) | **Mitigated**: guard + Edit deny rule + sandbox denyWrite (with `--harden`) |
| F8 | Node path change silently disables hooks | **Fixed**: PATH fallback; doctor reports it; repair re-records |
| F9 | `once` grants reusable via `brain authorize` | **Fixed**: consumed on allow |
| F10 | No integrity record of controller files | **Fixed** (trust-on-first-use): SHA-256 of runtime files recorded at setup; doctor compares |
| F11 | `brain init` copied credentials from README text into `project.md` | **Fixed** (found by the new adversarial test): redaction of copied text |
| U1 | Same-user process can emulate a terminal or rewrite the hash chain | **Open by design** — needs the OS sandbox (`--harden`) or a separately privileged approval component |
| U2 | Bash guard is pattern-based; obfuscation evades it | **Open** — sandbox is the control that does not depend on command text |
| U3 | No enforcement on agents other than Claude Code | **Open** — needs per-host adapters |
| U4 | Unkeyed hash chain | **Open** — a keyed signature needs a key the agent cannot read (OS keychain with user presence, or a separate service) |
