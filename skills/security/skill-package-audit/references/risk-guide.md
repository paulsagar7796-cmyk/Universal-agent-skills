# Risk guide for scanner findings

Each rule in `scripts/scan.mjs` describes a *pattern*, not a verdict. Judge every finding in context.

| Rule | What it means | Legitimate uses | Usually means trouble when |
|---|---|---|---|
| remote-script-exec | Downloaded code is piped straight into an interpreter | Rare; some official installers document it | The domain is not the tool's official one, or the skill runs it without asking |
| encoded-exec | Encoded text is decoded and executed | Almost none in skills | Always investigate; decode the payload offline (do not run it) |
| destructive-delete | Recursive delete of a root, home, wildcard or parent path | Cleaning a build folder by explicit path | The target is variable, home, root or relative to an unknown cwd |
| credential-access | Mentions key files, cloud credential folders, browser login data, keychains | A security skill explaining what *not* to touch | The skill reads, copies or prints them |
| env-exfiltration | Environment variables are sent over the network | None | Always block |
| network-upload | Data is posted/uploaded to an endpoint | Calling a documented API the skill is about | Endpoint is unrelated, hard-coded, or receives files/secrets |
| hidden-unicode | Zero-width or bidirectional control characters | Rare (some languages need direction marks in prose) | Inside instructions or code; may hide text from reviewers |
| concealment | Tells the agent to keep actions from the user | None | Always block |
| instruction-override | Tries to replace system or user instructions | Quoting an attack in a security guide (should be marked as an example) | Phrased as a directive to the agent |
| permission-bypass | Disables approvals or sandboxing | None for third-party skills | Always at least caution |
| persistence | Scheduled jobs, launch agents, shell startup edits | An ops skill that explicitly asks first | Done silently or unrelated to the stated purpose |
| install-hook | Code runs automatically on package install | Building native modules | Any skill that does not obviously need it |
| privilege-escalation | Uses root privileges | System administration skills with explicit approval | Unexplained or unattended |
| world-writable | Makes files writable by everyone | Almost none | Always fix |
| embedded-payload | Large encoded blob or data-URI script | Small images in assets | Inside instructions or scripts |
| symlink / binary-file / unexpected-executable | Content that cannot be reviewed as plain text, or may point elsewhere | Images and fonts in assets (not flagged unless executable/binary formats) | Executables, archives, or links outside the folder |

## License checks

- Read the repository `LICENSE` and any per-skill `LICENSE.txt` or `license` frontmatter. They may differ.
- "Source-available" or "proprietary" terms may forbid redistribution or modification even if the repo is public.
- No license = all rights reserved: do not copy or redistribute; link to it instead.
- Record SPDX id, file, and date checked in the audit report.
