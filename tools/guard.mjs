#!/usr/bin/env node
// Runs a command with a memory cap and a time limit, so a runaway process dies alone.
// On Linux a process that exhausts RAM is killed by the kernel together with the whole
// group that launched it (an IDE, a terminal session). This puts the command in its own
// systemd scope instead. On other platforms only the time limit applies.
//
//   node tools/guard.mjs [--mem=2G] [--timeout=1800] [--lock] node --test tests/unit/foo.test.ts
//   OROGEN_GUARD_MEM=8G OROGEN_GUARD_TIMEOUT=3600 node tools/guard.mjs node src/cli/main.ts ...
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { guardCommand, killedMessage } from './guard-command.ts';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node tools/guard.mjs <command> [args...]');
  process.exit(2);
}
// Leading --mem= and --timeout= set the defaults for one script; the environment still overrides them.
const flags = {};
while (args.length > 0 && /^--(mem=|timeout=|lock$)/.test(args[0])) {
  const [key, value] = args.shift().slice(2).split('=');
  flags[key] = value ?? '1';
}
if (args.length === 0) {
  console.error('usage: node tools/guard.mjs [--mem=2G] [--timeout=1800] [--lock] <command> [args...]');
  process.exit(2);
}
const mem = process.env.OROGEN_GUARD_MEM ?? flags.mem ?? '2G';
const limit = Number(process.env.OROGEN_GUARD_TIMEOUT ?? flags.timeout ?? 1800);
const nested = process.env.OROGEN_GUARD_ACTIVE === '1';
const linux = process.platform === 'linux';
const has = (command, ...probe) => spawnSync(command, probe, { stdio: 'ignore' }).status === 0;

// --lock: one such run at a time on this machine. Several people (or agents) share one GPU and its
// memory; whole suites and large renders queue here instead of failing each other. The lock is taken
// outside the scope: the wait for it is no part of the run's own time limit.
const lock = Boolean(flags.lock);
const plan = guardCommand({
  args, lock, mem, limit, nested,
  platform: process.platform,
  systemd: linux && !nested && has('systemctl', '--user', 'show-environment'),
  flock: linux && !nested && lock && has('flock', '--version'),
  node: process.execPath,
  lockFile: join(tmpdir(), 'orogen-gpu.lock'),
});
const child = spawn(plan.command, plan.args, { stdio: 'inherit', shell: plan.shell, env: { ...process.env, OROGEN_GUARD_ACTIVE: '1' } });
const timer = plan.timer ? setTimeout(() => child.kill('SIGKILL'), limit * 1000) : null;
child.on('error', (e) => { console.error(`guard: cannot start ${args[0]}: ${e.message}`); process.exit(127); });
child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer);
  const said = killedMessage(code, signal, mem, limit, plan.command === 'flock' && plan.scoped);
  if (said !== null) console.error(said);
  process.exit(code ?? 137);
});
