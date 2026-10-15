// Drive the brain CLI through a real pseudo-terminal (via the system `script` utility) to simulate a person typing the
// approval code. This is also exactly how a same-user process could defeat the terminal challenge — see
// docs/security-model.md. Works with BSD `script` (macOS) and util-linux `script` (Linux).
import { spawn, spawnSync } from 'node:child_process';
import { BRAIN_JS } from './helpers.js';

export const ptyAvailable = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run `brain <args>` with a controlling terminal. `answer`: 'code' types the displayed code, any other string is typed
 * verbatim, null types nothing (EOF). Resolves { code, output }.
 */
export function brainWithTty(args, { cwd, env = {}, answer = 'code', timeoutMs = 20000 } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'BRAIN_HOOK_ACTIVE']) if (!(k in env)) delete childEnv[k];
  const argv = [process.execPath, BRAIN_JS, ...args];
  // `cat |` gives script a real pipe on stdin (macOS script rejects socket stdin, which is what Node provides).
  const inner = process.platform === 'darwin' ? `script -q /dev/null ${argv.map(shQuote).join(' ')}` : `script -q -e -c ${shQuote(argv.map(shQuote).join(' '))} /dev/null`;
  const spec = ['sh', ['-c', `cat | ${inner}`]];
  return new Promise((resolve) => {
    const child = spawn(spec[0], spec[1], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let answered = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let closed = false;
    const closeInput = () => {
      if (!closed) {
        closed = true;
        child.stdin.end();
      }
    };
    const onData = (d) => {
      output += d.toString();
      const m = output.match(/Type ([A-Z0-9]{6}) and press Enter/);
      if (m && !answered) {
        answered = true;
        if (answer === null) closeInput();
        else {
          child.stdin.write(`${answer === 'code' ? m[1] : answer}\n`);
          // Closing stdin right away can deliver EOF to the pseudo-terminal before the typed line is read (seen on a
          // slower macOS CI runner). Keep it open until the CLI has consumed the answer; fallback after 5 s.
          setTimeout(closeInput, 5000).unref();
        }
      }
      if (answered && /\b(Approved|Cancelled)\./.test(output)) closeInput();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ code, output: output.replace(/\r/g, '') });
    });
  });
}
