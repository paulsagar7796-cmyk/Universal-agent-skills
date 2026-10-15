#!/usr/bin/env node
// Scan repository text files for credential patterns (same rules the brain uses before writing).
// Test fixtures build fake secrets at runtime, so nothing in the repository should match. Lines that *define*
// detection patterns carry the marker `secret-scan: allow-pattern-definition`.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/catalog.js';
import { findSecrets } from '../src/secrets.js';

const SKIP = new Set(['.git', 'node_modules', '.agent-brain']);
let hits = 0;
let files = 0;
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.isFile() && fs.statSync(p).size < 2 * 1024 * 1024) {
      const buf = fs.readFileSync(p);
      if (buf.includes(0)) continue;
      files++;
      buf
        .toString('utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes('secret-scan: allow-pattern-definition')) return;
          const r = findSecrets(line);
          if (r.length) {
            hits++;
            console.log(`${path.relative(REPO_ROOT, p)}:${i + 1} possible credential (${r.join(', ')})`);
          }
        });
    }
  }
};
walk(REPO_ROOT);
console.log(`${files} file(s) scanned: ${hits} possible credential(s).`);
process.exit(hits ? 1 : 0);
