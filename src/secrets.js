// Secret detection used before anything is written to the brain, the index, the event log or consent records.
// Pattern-based detection is a safety net, not a guarantee: it catches common credential formats only.

const RULES = [
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'aws-access-key-id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'openai-key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-key', re: /\b[rs]k_live_[0-9A-Za-z]{20,}\b/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/i },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  {
    id: 'assigned-secret',
    re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?(?!<|\$\{|\$[A-Z_]|xxx|\*\*\*|redacted|example|changeme|placeholder|your[_-])[^\s"']{8,}/i,
  },
];

/** Return the list of rule ids that match `text` (empty array when clean). */
export function findSecrets(text) {
  if (text === null || text === undefined) return [];
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  const hits = [];
  for (const r of RULES) if (r.re.test(s)) hits.push(r.id);
  return hits;
}

export class SecretDetectedError extends Error {
  constructor(where, rules) {
    super(`refusing to write ${where}: content looks like a credential (${rules.join(', ')}). Remove it; secrets never belong in the brain.`);
    this.name = 'SecretDetectedError';
    this.rules = rules;
  }
}

export function assertNoSecrets(text, where) {
  const hits = findSecrets(text);
  if (hits.length) throw new SecretDetectedError(where, hits);
}

/** Remove credentials embedded in a URL's authority (everything before '@' after the scheme). */
export function redactUrl(url) {
  if (!url) return url;
  return String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/i, '$1');
}
