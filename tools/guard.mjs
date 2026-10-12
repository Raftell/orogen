#!/usr/bin/env node
// Runs a command with a memory cap and a time limit, so a runaway process dies alone.
// On Linux a process that exhausts RAM is killed by the kernel together with the whole
// group that launched it (an IDE, a terminal session). This puts the command in its own
// systemd scope instead. On other platforms only the time limit applies.
//
//   node tools/guard.mjs [--mem=3G] [--timeout=1800] node --test tests/unit/foo.test.ts
//   OROGEN_GUARD_MEM=8G OROGEN_GUARD_TIMEOUT=3600 node tools/guard.mjs node src/cli/main.ts ...
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node tools/guard.mjs <command> [args...]');
  process.exit(2);
}
// Leading --mem= and --timeout= set the defaults for one script; the environment still overrides them.
const flags = {};
while (args.length > 0 && /^--(mem|timeout)=/.test(args[0])) {
  const [key, value] = args.shift().slice(2).split('=');
  flags[key] = value;
}
if (args.length === 0) {
  console.error('usage: node tools/guard.mjs [--mem=3G] [--timeout=1800] <command> [args...]');
  process.exit(2);
}
const mem = process.env.OROGEN_GUARD_MEM ?? flags.mem ?? '3G';
const limit = Number(process.env.OROGEN_GUARD_TIMEOUT ?? flags.timeout ?? 1800);
const nested = process.env.OROGEN_GUARD_ACTIVE === '1';
const scoped = !nested && process.platform === 'linux'
  && spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0;

let command = args[0] === 'node' ? process.execPath : args[0];
let rest = args.slice(1);
if (scoped) {
  rest = ['--user', '--scope', '-q', '--collect',
    '-p', `MemoryMax=${mem}`, '-p', 'MemorySwapMax=0',
    '-p', `RuntimeMaxSec=${limit}`, '--', command, ...rest];
  command = 'systemd-run';
}
const child = spawn(command, rest, { stdio: 'inherit', env: { ...process.env, OROGEN_GUARD_ACTIVE: '1' } });
const timer = scoped || nested ? null : setTimeout(() => child.kill('SIGKILL'), limit * 1000);
child.on('error', (e) => { console.error(`guard: cannot start ${args[0]}: ${e.message}`); process.exit(127); });
child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer);
  if (signal || code === 137) console.error(`guard: command killed (${signal ?? 'SIGKILL'}): over the ${mem} memory cap or the ${limit}s time limit`);
  process.exit(code ?? 137);
});
