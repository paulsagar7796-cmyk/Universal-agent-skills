// Keyword-based skill router. Deterministic and explainable: every selection lists the terms that matched.
// It complements, not replaces, the host agent's own skill discovery (which reads skill descriptions).

const STOP = new Set('a an and are as at be but by can do does for from how i in is it its me my of on or our please should so that the this to up us we what when where which who why will with would you your'.split(' '));

const INTENTS = {
  build: ['build', 'implement', 'add', 'create', 'feature', 'refactor', 'change', 'update', 'write code', 'ship', 'app', 'endpoint', 'migrate'],
  debug: ['bug', 'error', 'fails', 'failing', 'crash', 'broken', 'exception', 'stack trace', 'regression', 'flaky', 'not working', 'fix'],
  test: ['test', 'tests', 'tdd', 'coverage', 'unit test', 'red green'],
  research: ['research', 'sources', 'cite', 'citation', 'look up', 'find out', 'latest', 'compare', 'evidence', 'literature'],
  business: ['business', 'startup', 'market', 'customers', 'stakeholder', 'requirements', 'revenue', 'pricing', 'users need'],
  docs: ['document', 'documentation', 'readme', 'docs', 'guide', 'changelog'],
  review: ['review', 'pull request', 'pr', 'audit', 'critique'],
  plan: ['plan', 'roadmap', 'break down', 'breakdown', 'estimate', 'steps', 'milestones'],
  brain: ['memory', 'brain', 'handoff', 'remember', 'context', 'onboard', 'onboarding'],
  skills: ['skill', 'skills', 'skill.md'],
  ml: ['train', 'training', 'model', 'ablation', 'baseline', 'seed', 'seeds', 'hyperparameter', 'fine-tune', 'epoch', 'loss'],
  data: ['dataset', 'data', 'statistics', 'statistical', 'significant', 'p-value', 'csv', 'notebook', 'leakage', 'analyse', 'analyze'],
  science: ['genome', 'sequencing', 'fastq', 'fasta', 'vcf', 'bioinformatics', 'variant', 'protein', 'dna', 'rna', 'snakemake', 'reads'],
};

function norm(s) {
  // Keep dots inside tokens (skill.md, v1.2) but drop sentence-ending ones ("…the data.").
  return ` ${String(s).toLowerCase().replace(/[^\p{L}\p{N}.+#-]+/gu, ' ').replace(/\.+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function hasPhrase(normText, phrase) {
  const p = norm(phrase);
  return p.trim() !== '' && normText.includes(p);
}

export function detectIntents(prompt) {
  const t = norm(prompt);
  return Object.entries(INTENTS)
    .filter(([, words]) => words.some((w) => hasPhrase(t, w)))
    .map(([k]) => k);
}

/**
 * Route a request to skills.
 * @returns {{ intents: string[], selected: Array<{id, score, reasons, explicit, path, category}>, supporting: Array<{id, reason, path}> }}
 */
export function route(prompt, catalog, { maxSkills = 3, minScore = 3 } = {}) {
  const t = norm(prompt);
  const intents = detectIntents(prompt);
  const words = new Set(t.trim().split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
  const scored = [];
  for (const s of catalog) {
    const reasons = [];
    let score = 0;
    let explicit = false;
    const id = s.id;
    if (hasPhrase(t, id) || t.includes(` $${id} `) || t.includes(` /${id} `) || hasPhrase(t, id.replace(/-/g, ' '))) {
      explicit = true;
      score += 100;
      reasons.push(`named explicitly (${id})`);
    }
    for (const trig of s.routing?.triggers ?? []) {
      if (hasPhrase(t, trig)) {
        const w = String(trig).includes(' ') ? 4 : 3;
        score += w;
        reasons.push(`"${trig}"`);
      }
    }
    for (const avoid of s.routing?.avoid ?? []) {
      if (hasPhrase(t, avoid)) {
        score -= 5;
        reasons.push(`-"${avoid}"`);
      }
    }
    const intentHits = (s.routing?.intents ?? []).filter((i) => intents.includes(i));
    if (intentHits.length) {
      score += intentHits.length;
      reasons.push(`intent:${intentHits.join('+')}`);
    }
    const descWords = new Set(norm(s.description).trim().split(' ').filter((w) => w.length > 3 && !STOP.has(w)));
    const overlap = [...words].filter((w) => descWords.has(w));
    if (overlap.length) {
      score += Math.min(2, overlap.length * 0.5);
      reasons.push(`description:${overlap.slice(0, 4).join(',')}`);
    }
    scored.push({ id, score, reasons, explicit, path: s.absPath ?? s.path, category: s.category, pairsWith: s.routing?.pairs_with ?? [] });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected = scored.filter((s) => s.explicit || s.score >= minScore).slice(0, Math.max(maxSkills, scored.filter((s) => s.explicit).length));
  const chosen = new Set(selected.map((s) => s.id));
  const supporting = [];
  for (const s of selected) {
    for (const p of s.pairsWith) {
      if (chosen.has(p) || supporting.some((x) => x.id === p)) continue;
      const entry = catalog.find((c) => c.id === p);
      if (entry && supporting.length < 2) supporting.push({ id: p, reason: `pairs with ${s.id}`, path: entry.absPath ?? entry.path });
    }
  }
  return { intents, selected: selected.map(({ pairsWith, ...rest }) => ({ ...rest, score: Math.round(rest.score * 10) / 10 })), supporting };
}
