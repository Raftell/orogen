// `orogen` as a program, where it ends before it opens a device (testing.md 8.6): help, every kind of usage
// error with exit code 2 and nothing on standard output, and `build`, which belongs to src/export/cli.ts.
// Each case is one child process, started through tools/guard.mjs; none of them needs a GPU.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../..');

/** Runs `orogen` with the arguments. `set` replaces variables of the environment; undefined removes one. */
function orogen(args: readonly string[], set: Readonly<Record<string, string | undefined>> = {}): { readonly code: number | null; readonly out: string; readonly err: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...set };
  delete env.NODE_TEST_CONTEXT;
  for (const [name, value] of Object.entries(set)) if (value === undefined) delete env[name];
  const done = spawnSync(process.execPath, [path.join('tools', 'guard.mjs'), 'node', path.join('src', 'cli', 'main.ts'), ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

/** The arguments are refused: exit code 2, the reason and the synopsis on standard error, nothing on standard output. */
function refused(args: readonly string[], message: RegExp, set: Readonly<Record<string, string | undefined>> = {}): void {
  const done = orogen(args, set);
  const line = `orogen ${args.join(' ')}`;
  assert.equal(done.code, 2, `${line}: ${done.err}`);
  assert.equal(done.out, '', line);
  assert.match(done.err, message, line);
  assert.match(done.err, /^usage: orogen /m, line);
}

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-cli-main-'));
after(() => fs.rmSync(folder, { recursive: true, force: true }));

test('orogen: without a subcommand it prints the usage and exits with 2; asked for help it prints it and exits with 0', () => {
  refused([], /^orogen: name a subcommand$/m);
  refused(['frobnicate'], /^orogen: "frobnicate" is not a subcommand$/m);

  const help = orogen(['--help']);
  assert.deepEqual([help.code, help.err], [0, '']);
  assert.match(help.out, /^usage: orogen <subcommand> \[options\]/);
  assert.match(help.out, /exit codes: 0 success, 1 a node failed, 2 usage error, 3 no usable GPU device or device lost, 130 cancelled/);

  const render = orogen(['help', 'render']);
  assert.deepEqual([render.code, render.err], [0, '']);
  assert.match(render.out, /^usage: orogen render <type> /);
  assert.ok(!render.out.includes('orogen gallery'));
});

test('orogen: a usage error of probe, render and gallery ends before a device is opened', () => {
  refused(['probe', '--profile', 'fastest'], /^orogen: --profile is "fastest"; it is "core" or "max"$/m);
  refused(['probe'], /^orogen: OROGEN_GPU_PROFILE is "fastest"; it is "core" or "max"$/m, { OROGEN_GPU_PROFILE: 'fastest' });
  refused(['render'], /^orogen: name a node type or a project file$/m);
  refused(['render', 'ref/fbm', '--res', '600'], /^orogen: --res "600" is not a resolution/m);
  refused(['gallery', '--category', 'rocks'], /^orogen: --category "rocks" is not a category/m);
  refused(['gallery', '--res'], /^orogen: --res needs a value$/m);
});

test('orogen render <type>: a type, a parameter or a value the registry does not have is a usage error', () => {
  refused(['render', 'ref/no-such-node'], /^orogen: Unknown node type "ref\/no-such-node"; the nodes of "ref" are .*\bref\/fbm\b.*\bref\/talus\b/m);
  refused(['render', 'ref/fbm', '--param', 'radius=1'], /^orogen: ref\/fbm has no parameter "radius"; its parameters are seed, size, octaves, gain$/m);
  refused(['render', 'ref/fbm', '--param', 'octaves=99'], /^orogen: --param octaves of ref\/fbm: 99 is outside 1\.\.16$/m);
  refused(['render', 'ref/fbm', '--param', 'gain="rough"'], /^orogen: --param gain of ref\/fbm: "rough" is not a finite number$/m);
  refused(['render', 'ref/talus', '--seed', '3'], /^orogen: --seed sets the node's seed, and ref\/talus has no seed parameter$/m);
});

test('orogen render <project.orogen>: a file that cannot be read, is no project, or lacks the node is a usage error', () => {
  const missing = path.join(folder, 'no-such.orogen');
  refused(['render', missing, '--node', 'a'], /^orogen: Cannot read the project file .*no-such\.orogen: /m);

  const garbage = path.join(folder, 'garbage.orogen');
  fs.writeFileSync(garbage, 'this is not a project');
  refused(['render', garbage, '--node', 'a'], /^orogen: .*garbage\.orogen is not a project file: /m);

  const project = path.join(folder, 'small.orogen');
  fs.writeFileSync(project, JSON.stringify({
    format: 'orogen', version: 1,
    settings: { terrainSize: 4096, heightRange: 1024, seed: 1, buildResolution: 513, previewLevel: 2, seaLevel: 0 },
    nodes: { noise: { id: 'noise', type: 'ref/fbm', version: 1, position: { x: 0, y: 0 }, params: {} } },
    edges: {}, groups: {}, ui: {},
  }));
  refused(['render', project, '--node', 'nobody'], /^orogen: .*small\.orogen has no node "nobody"; its nodes are noise$/m);
  // Without --res the resolution is the project's preview resolution: level 2 of 513 is 129.
  refused(['render', project, '--node', 'noise', '--crop', '200'], /^orogen: --crop 200 is larger than the resolution 129$/m);
  // A relative path is taken from the working directory.
  refused(['render', 'no/such/folder/a.orogen', '--node', 'a'], new RegExp(`^orogen: Cannot read the project file ${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
});

test('orogen build and unreal-test are handed to src/export/cli.ts, and say so where a checkout lacks it', () => {
  const present = fs.existsSync(path.join(ROOT, 'src', 'export', 'cli.ts'));
  for (const args of [['build', path.join(folder, 'no-such.orogen'), '--out', path.join(folder, 'built')], ['unreal-test']]) {
    const done = orogen(args);
    assert.notEqual(done.code, 0, `orogen ${args.join(' ')} cannot succeed: ${done.err}`);
    assert.notEqual(done.code, null, 'the program ended by itself');
    assert.equal(done.out, '', 'nothing on standard output');
    assert.equal(fs.existsSync(path.join(folder, 'built')), false, 'nothing was written');
    if (!present) {
      assert.equal(done.code, 2);
      assert.match(done.err, new RegExp(`^orogen ${args[0]}: this build of Orogen has no build pipeline: .*src/export/cli\\.ts .*does not exist\\. Nothing was planned or written\\.$`, 'm'));
    }
  }
});
