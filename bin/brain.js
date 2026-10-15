#!/usr/bin/env node
// agent-skills-brain controller. Runs only when invoked; nothing executes on clone or package install.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

// A closed pipe (e.g. `brain show … | head`) is a normal end of output, not a crash.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
