#!/usr/bin/env node
// Validate every skill under skills/: Agent Skills frontmatter rules, references, manifest, eval coverage.
import { validateAll } from '../src/validate.js';

const { skills, errors, warnings } = validateAll();
for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error:   ${e}`);
console.log(`${skills.length} skill(s) checked: ${errors.length} error(s), ${warnings.length} warning(s).`);
process.exit(errors.length ? 1 : 0);
