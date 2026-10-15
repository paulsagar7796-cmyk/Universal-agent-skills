import path from 'node:path';
import { parse } from './yaml.js';
import { readTextIfExists } from './util.js';

export const DEFAULT_CONFIG = Object.freeze({
  schema_version: 1,
  context: { max_chars: 6000, max_facts: 25, max_questions: 8 },
  memory: { auto_accept_low_risk: false },
  retention: { events_days: 30, max_event_lines: 5000 },
  routing: { max_skills: 3, min_score: 3 },
});

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

/** Load .agent-brain/config.yaml merged over defaults. Invalid values fall back to defaults with a warning. */
export function loadConfig(brainDir) {
  const text = readTextIfExists(path.join(brainDir, 'config.yaml'));
  const warnings = [];
  let user = {};
  if (text !== null) {
    try {
      user = parse(text) ?? {};
    } catch (e) {
      warnings.push(`config.yaml ignored: ${e.message}`);
    }
  }
  const cfg = merge(DEFAULT_CONFIG, user);
  const num = (obj, key, min, max) => {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      warnings.push(`config ${key}=${JSON.stringify(v)} out of range [${min}, ${max}]; using default`);
      return false;
    }
    return true;
  };
  if (!num(cfg.context, 'max_chars', 500, 9500)) cfg.context.max_chars = DEFAULT_CONFIG.context.max_chars;
  if (!num(cfg.context, 'max_facts', 0, 200)) cfg.context.max_facts = DEFAULT_CONFIG.context.max_facts;
  if (!num(cfg.context, 'max_questions', 0, 50)) cfg.context.max_questions = DEFAULT_CONFIG.context.max_questions;
  if (!num(cfg.retention, 'events_days', 1, 3650)) cfg.retention.events_days = DEFAULT_CONFIG.retention.events_days;
  if (!num(cfg.retention, 'max_event_lines', 100, 1_000_000)) cfg.retention.max_event_lines = DEFAULT_CONFIG.retention.max_event_lines;
  if (!num(cfg.routing, 'max_skills', 0, 10)) cfg.routing.max_skills = DEFAULT_CONFIG.routing.max_skills;
  if (!num(cfg.routing, 'min_score', 1, 100)) cfg.routing.min_score = DEFAULT_CONFIG.routing.min_score;
  if (typeof cfg.memory.auto_accept_low_risk !== 'boolean') {
    warnings.push('config memory.auto_accept_low_risk must be true/false; using false');
    cfg.memory.auto_accept_low_risk = false;
  }
  return { config: cfg, warnings };
}
