// Local operation trace (.agent-brain/local/events.jsonl). Records what the controller did — never raw prompts,
// assistant messages, file contents or credentials. Used by `brain explain-last-run` and `brain doctor`.
import fs from 'node:fs';
import { findSecrets } from './secrets.js';
import { nowIso, sha256, withLock, writeFileAtomic } from './util.js';

const MAX_EVENT_BYTES = 3500;

export function eventsFile(store) {
  return store.p('local', 'events.jsonl');
}

export function hashSession(sessionId) {
  return sessionId ? sha256(String(sessionId)).slice(0, 12) : null;
}

/** Build a normalized event. `event_id` should be deterministic for retried hook deliveries. */
export function makeEvent(type, data = {}, { session = null, agent = null, eventId = null, ts = nowIso() } = {}) {
  let payload = data;
  const secrets = findSecrets(payload);
  if (secrets.length) payload = { redacted: true, reason: `possible credential (${secrets.join(', ')})` };
  let json = JSON.stringify(payload);
  if (json.length > MAX_EVENT_BYTES) payload = { truncated: true, keys: Object.keys(data).slice(0, 20) };
  json = JSON.stringify(payload);
  return { event_id: eventId ?? sha256(`${type}\n${session}\n${ts}\n${json}`).slice(0, 24), ts, type, agent, session, data: payload };
}

/**
 * Append an event. Returns false when it was a duplicate (same event_id already recorded).
 * With an index, dedupe is transactional; without one, the tail of the log is scanned.
 */
export function appendEvent(store, event, { index = null } = {}) {
  fs.mkdirSync(store.localDir(), { recursive: true });
  const file = eventsFile(store);
  if (index) {
    if (!index.recordEvent(event)) return false;
  } else if (readEvents(store, { tail: 500 }).some((e) => e.event_id === event.event_id)) return false;
  fs.appendFileSync(file, JSON.stringify(event) + '\n', { flag: 'a' });
  return true;
}

export function readEvents(store, { tail = null } = {}) {
  let text;
  try {
    text = fs.readFileSync(eventsFile(store), 'utf8');
  } catch {
    return [];
  }
  let lines = text.split('\n').filter(Boolean);
  if (tail) lines = lines.slice(-tail);
  const out = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip torn or corrupt line */
    }
  }
  return out;
}

/** Apply retention: drop events older than `days` and keep at most `maxLines`. */
export function pruneEvents(store, { days, maxLines }, now = new Date()) {
  const file = eventsFile(store);
  if (!fs.existsSync(file)) return 0;
  return withLock(store.p('local', 'events.lock'), () => {
    const events = readEvents(store);
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const kept = events.filter((e) => (e.ts ?? '') >= cutoff).slice(-maxLines);
    if (kept.length === events.length) return 0;
    writeFileAtomic(file, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
    return events.length - kept.length;
  });
}
