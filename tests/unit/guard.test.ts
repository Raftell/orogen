// The command line tools/guard.mjs starts (testing.md 8.1): the memory cap and the time limit as a systemd
// scope, the machine-wide lock outside that scope, npm through the shell on Windows, and what it says of a
// command that was killed. The script itself is two spawn calls around these functions.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { guardCommand, killedMessage, type GuardInput } from '../../tools/guard-command.ts';

const LINUX: GuardInput = {
  args: ['node', '--test', 'tests/unit/a b.test.ts'], lock: false, mem: '4G', limit: 1000, platform: 'linux', nested: false, systemd: true, flock: true,
  node: '/usr/bin/node', lockFile: '/tmp/orogen-gpu.lock',
};
const SCOPE = ['--user', '--scope', '-q', '--collect', '-p', 'MemoryMax=4G', '-p', 'MemorySwapMax=0', '-p', 'RuntimeMaxSec=1000', '--'];

test('guard: on Linux the command runs in a scope with the memory cap and the time limit; "node" is this Node', () => {
  const plan = guardCommand(LINUX);
  assert.deepEqual([plan.command, plan.args], ['systemd-run', [...SCOPE, '/usr/bin/node', '--test', 'tests/unit/a b.test.ts']]);
  assert.deepEqual([plan.shell, plan.scoped, plan.timer], [false, true, false]);
});

test('guard: the lock is taken outside the scope, so that the wait for it is not counted against the time limit', () => {
  const plan = guardCommand({ ...LINUX, lock: true });
  // flock <file> systemd-run … -- <command>: RuntimeMaxSec begins when flock starts systemd-run, which is when it has the lock.
  assert.equal(plan.command, 'flock');
  assert.deepEqual(plan.args, ['/tmp/orogen-gpu.lock', 'systemd-run', ...SCOPE, '/usr/bin/node', '--test', 'tests/unit/a b.test.ts']);
  assert.ok(plan.args.indexOf('systemd-run') < plan.args.indexOf('RuntimeMaxSec=1000'));
  assert.equal(plan.scoped, true);
  // Without flock on the machine there is no lock, and the scope is as before.
  assert.equal(guardCommand({ ...LINUX, lock: true, flock: false }).command, 'systemd-run');
});

test('guard: inside another guard nothing is added, and without systemd the guard\'s own timer is the limit', () => {
  const nested = guardCommand({ ...LINUX, lock: true, nested: true });
  assert.deepEqual([nested.command, nested.args, nested.scoped, nested.timer], ['/usr/bin/node', ['--test', 'tests/unit/a b.test.ts'], false, false]);
  const bare = guardCommand({ ...LINUX, systemd: false });
  assert.deepEqual([bare.command, bare.scoped, bare.timer], ['/usr/bin/node', false, true]);
});

test('guard: on Windows npm and npx are started through the shell, and nothing else is', () => {
  const windows = { ...LINUX, platform: 'win32', systemd: false, flock: false, node: 'C:\\node\\node.exe' };
  for (const tool of ['npm', 'npx']) {
    const plan = guardCommand({ ...windows, args: [tool, 'run', 'orogen', '--', 'build', 'a.orogen'] });
    assert.deepEqual([plan.command, plan.args, plan.shell, plan.timer], [tool, ['run', 'orogen', '--', 'build', 'a.orogen'], true, true]);
  }
  assert.deepEqual([guardCommand(windows).command, guardCommand(windows).shell], ['C:\\node\\node.exe', false]);
  assert.equal(guardCommand({ ...LINUX, args: ['npm', 'run', 'check'] }).shell, false, 'on Linux npm is a program');
});

test('guard: a killed command is told which limit ended it; one that ended by itself is not spoken of', () => {
  assert.equal(killedMessage(0, null, '4G', 1000, false), null);
  assert.equal(killedMessage(1, null, '4G', 1000, false), null);
  // The scope's time limit sends SIGTERM; through flock it is the exit code 143.
  for (const [code, signal] of [[null, 'SIGTERM'], [143, null]] as const) {
    const said = killedMessage(code, signal, '4G', 1000, false)!;
    assert.match(said, /over the 1000s time limit$/);
    assert.ok(!said.includes('memory'), said);
  }
  assert.match(killedMessage(143, null, '4G', 1000, true)!, /time limit, which began when the lock was taken$/);
  // The memory cap kills.
  for (const [code, signal] of [[null, 'SIGKILL'], [137, null]] as const) assert.match(killedMessage(code, signal, '4G', 1000, false)!, /over the 4G memory cap/);
});
