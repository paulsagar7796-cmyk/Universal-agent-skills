// Human approval gate for privilege-increasing operations (consent grants, memory approvals).
//
// What it checks: the command is not running inside an agent hook or a Claude Code agent session, and a person at the
// process's *controlling terminal* types back a random code. Measured on Claude Code 2.1.300: commands run through the
// agent's Bash tool have no controlling terminal (/dev/tty → ENXIO) and CLAUDECODE is set, so the supported agent path
// cannot approve.
//
// What it does NOT guarantee: a process running as the same OS user can fake a terminal (e.g. `script`) and type the
// code, or edit the policy files directly. That is a guardrail against honest-but-fallible agents and accidental
// approval, not a security boundary. The boundary is an OS sandbox the agent cannot leave (see docs/security-model.md).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { nowIso } from './util.js';

const tokens = new WeakSet();
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export class HumanApprovalRequired extends Error {
  constructor(message) {
    super(message);
    this.name = 'HumanApprovalRequired';
  }
}

export function agentContextReason(env = process.env) {
  if (env.BRAIN_HOOK_ACTIVE === '1') return 'running inside an agent lifecycle hook';
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'running inside a Claude Code agent session (CLAUDECODE is set)';
  return null;
}

function randomCode(n = 6) {
  const bytes = crypto.randomBytes(n);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Open the controlling terminal for synchronous line I/O. Throws HumanApprovalRequired when there is none. */
export function openControllingTerminal(ttyPath = '/dev/tty') {
  let fd;
  try {
    fd = fs.openSync(ttyPath, 'r+');
  } catch (e) {
    throw new HumanApprovalRequired(`no controlling terminal (${e.code ?? e.message}). Approvals must be typed by a person in an interactive terminal.`);
  }
  return {
    write: (s) => fs.writeSync(fd, s),
    readLine: (max = 200) => {
      const buf = Buffer.alloc(1);
      let line = '';
      for (;;) {
        let n;
        try {
          n = fs.readSync(fd, buf, 0, 1, null);
        } catch (e) {
          if (e.code === 'EAGAIN') {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            continue;
          }
          throw e;
        }
        if (n === 0) return line;
        const ch = buf.toString('utf8');
        if (ch === '\n' || ch === '\r') return line;
        line += ch;
        if (line.length >= max) return line;
      }
    },
    close: () => fs.closeSync(fd),
  };
}

/**
 * Ask the person at the controlling terminal to approve. Returns an approval token (only tokens minted here are
 * accepted by the policy store). `io` lets tests inject a simulated terminal; the CLI always uses the real one.
 */
export function confirmHuman({ title, lines = [], env = process.env, io = null, now = new Date() }) {
  const ctx = agentContextReason(env);
  if (ctx) throw new HumanApprovalRequired(`refusing to approve: ${ctx}. Ask the user to run this command themselves in their own terminal.`);
  const tty = io ?? openControllingTerminal();
  const code = randomCode();
  try {
    tty.write(`\n${title}\n${lines.map((l) => `  ${l}`).join('\n')}\n\nOnly approve if YOU (not an agent) want this. Type ${code} and press Enter to approve, anything else cancels: `);
    const answer = String(tty.readLine() ?? '').trim().toUpperCase();
    if (answer !== code) {
      tty.write('Cancelled.\n');
      throw new HumanApprovalRequired('approval cancelled: the confirmation code did not match');
    }
    tty.write('Approved.\n');
  } finally {
    tty.close?.();
  }
  const token = Object.freeze({ via: 'tty-challenge', at: nowIso(now) });
  tokens.add(token);
  return token;
}

export function isHumanApproval(token) {
  return token !== null && typeof token === 'object' && tokens.has(token);
}
