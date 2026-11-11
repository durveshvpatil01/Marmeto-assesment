'use strict';

// `npm start`: runs the mock courier and the service together, with prefixed logs.
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const procs = [];

function run(name, file) {
  const p = spawn(process.execPath, [file], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (stream, out) =>
    stream.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => out.write(`${name} | ${l}\n`)));
  prefix(p.stdout, process.stdout);
  prefix(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${name} | exited (${code})`);
    shutdown();
  });
  procs.push(p);
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run('courier', 'mock-courier.js');
run('service', 'src/index.js');
