#!/usr/bin/env node
// Run the skill-package-audit static scanner over every first-party skill, honouring reviewed exceptions in
// manifest.yaml. Fails on any unexcepted high or medium finding, and on exceptions that no longer match anything.
import { loadSkills } from '../src/catalog.js';
import { scanSkill, summarize } from '../skills/security/skill-package-audit/scripts/scan.mjs';

let failed = false;
for (const s of loadSkills()) {
  const exceptions = s.manifest?.security?.scan_exceptions ?? [];
  const findings = scanSkill(s.dir, { exceptions });
  const sum = summarize(findings);
  const open = findings.filter((f) => !f.excepted && f.severity !== 'low');
  for (const f of findings) {
    const tag = f.excepted ? `excepted (${f.excepted})` : f.severity;
    if (f.excepted || f.severity !== 'low' || process.argv.includes('--verbose')) console.log(`${s.relDir}/${f.file}:${f.line} [${tag}] ${f.rule} — ${f.excerpt}`);
  }
  const unused = exceptions.filter((e) => !findings.some((f) => f.rule === e.rule && (e.file === '*' || f.file === e.file)));
  for (const u of unused) {
    console.log(`${s.relDir}: unused scan exception ${u.rule} @ ${u.file} — remove it`);
    failed = true;
  }
  if (open.length) failed = true;
  if (sum.low && !process.argv.includes('--verbose')) console.log(`${s.relDir}: ${sum.low} low-severity signal(s) (run with --verbose)`);
}
console.log(failed ? 'scan: FAILED (unexcepted high/medium findings or stale exceptions)' : 'scan: no unexcepted high/medium findings. Static signals only — not proof of safety.');
process.exit(failed ? 1 : 0);
