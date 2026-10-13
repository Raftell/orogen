// `orogen build` as a user runs it (export-unreal.md 3.11): child processes started through tools/guard.mjs,
// with their exit codes, what they print and what they leave on disk; and a cancellation, which is made in this
// process, where the moment of it can be chosen. This file uses no harness engine: each child opens its own
// device, and the cancelled build opens one here, on the adapter and with the profile the environment selects.
//
// Sizes: 241 x 241. What is written stays under <OROGEN_TEST_OUTPUT>/export-cli-<process id> until the file has run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import type { BuildEvent, EvalEvent } from '../../src/core/runtime.ts';
import { runExportCli } from '../../src/export/cli.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRATCH = path.join(path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output')), `export-cli-${process.pid}`);
const PROFILE = process.env.OROGEN_GPU_PROFILE || 'core';
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

interface Done { readonly code: number | null; readonly out: string; readonly err: string }
function orogen(args: readonly string[], set: Readonly<Record<string, string>> = {}): Done {
  const env: NodeJS.ProcessEnv = { ...process.env, OROGEN_GPU_PROFILE: PROFILE, ...set };
  delete env.NODE_TEST_CONTEXT;
  const done = spawnSync(process.execPath, [path.join('tools', 'guard.mjs'), 'node', path.join('src', 'cli', 'main.ts'), 'build', ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 << 20,
  });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

interface NodeSpec { readonly type: string; readonly params?: Readonly<Record<string, unknown>>; readonly in?: string }
/** A project file of the given nodes, with the ids as written. */
function project(name: string, nodes: Readonly<Record<string, NodeSpec>>, settings: Readonly<Record<string, number>> = {}): string {
  const doc = {
    format: 'orogen', version: 1,
    settings: { terrainSize: 2000, heightRange: 600, seed: 7, buildResolution: 241, previewLevel: 1, seaLevel: 0.3, ...settings },
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { id, type: node.type, version: 1, position: { x: 0, y: 0 }, params: node.params ?? {} }])),
    edges: Object.fromEntries(Object.entries(nodes).flatMap(([id, node]) => {
      if (node.in === undefined) return [];
      const [from, port] = node.in.split('.') as [string, string];
      return [[`e-${id}`, { id: `e-${id}`, from: { node: from, port }, to: { node: id, port: 'in' } }]];
    })),
    groups: {}, ui: {},
  };
  const file = path.join(SCRATCH, `${name}.orogen`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

const TERRAIN: Readonly<Record<string, NodeSpec>> = {
  land: { type: 'ref/fbm', params: { octaves: 4 } },
  rock: { type: 'ref/slope-mask', in: 'land.out' },
  outland: { type: 'io/export-landscape', params: { name: 'Cli' }, in: 'land.out' },
  outrock: { type: 'io/export-layer', params: { layer: 'Rock' }, in: 'rock.out' },
  outfield: { type: 'io/export-field', params: { name: 'Heights', format: 'r32' }, in: 'land.out' },
};
const FILES = ['CliHeight.png', 'CliHeight.r16', 'LayerBase.png', 'LayerBase.r8', 'LayerRock.png', 'LayerRock.r8', 'Heights.r32', 'Cli.orogen.json'];
const PROJECT = project('terrain', TERRAIN);
const list = (dir: string): string[] => fs.readdirSync(dir).sort();
const jsonLines = (out: string): (EvalEvent | BuildEvent)[] => out.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as EvalEvent | BuildEvent);

test('orogen build writes the build into the folder, prints the path of the manifest, and exits with 0', () => {
  const out = path.join(SCRATCH, 'built');
  const done = orogen([PROJECT, '--out', out]);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, `${path.join(out, 'Cli.orogen.json')}\n`, 'standard output carries the path of the manifest and nothing else');
  assert.deepEqual(list(out), [...FILES, 'Cli.report.json'].sort());
  assert.deepEqual([fs.existsSync(`${out}.partial`), fs.existsSync(`${out}.previous`)], [false, false]);
  // Progress on standard error: the plan, the targets, the end.
  assert.match(done.err, new RegExp(`^orogen build: 8 files at 241 x 241 into ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(done.err, /^orogen build: \[1\/3\] Unreal Landscape: CliHeight\.png$/m);
  assert.match(done.err, /^orogen build: done in [\d.]+ s: 8 files, [\d.]+ [MG]B; peak GPU pool [\d.]+ [MG]B, peak process memory [\d.]+ [MG]B$/m);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'Cli.orogen.json'), 'utf8')) as { resolution: { x: number }; project: { seed: number }; files: { path: string; bytes: number }[] };
  assert.deepEqual([manifest.resolution.x, manifest.project.seed], [241, 7]);
  for (const f of manifest.files) assert.equal(fs.statSync(path.join(out, f.path)).size, f.bytes, f.path);

  // --res and --seed override the project; a relative folder is taken from the working directory; --quiet says nothing of progress.
  const again = orogen([PROJECT, `--out=${path.relative(ROOT, out)}`, '--res', '337', '--seed', '5', '--quiet']);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.out, `${path.join(out, 'Cli.orogen.json')}\n`);
  assert.ok(!/^orogen build: /m.test(again.err), `--quiet prints no progress: ${again.err}`);
  const changed = JSON.parse(fs.readFileSync(path.join(out, 'Cli.orogen.json'), 'utf8')) as typeof manifest;
  assert.deepEqual([changed.resolution.x, changed.project.seed], [337, 5]);
  assert.equal(fs.statSync(path.join(out, 'Heights.r32')).size, 4 * 337 * 337);
});

test('orogen build --json writes every event as one JSON object per line on standard output, and nothing else there', () => {
  const out = path.join(SCRATCH, 'json');
  const done = orogen([PROJECT, '--out', out, '--json']);
  assert.equal(done.code, 0, done.err);
  const events = jsonLines(done.out);
  assert.equal(events[0]!.type, 'build-plan');
  assert.equal(events.at(-1)!.type, 'build-result');
  const result = (events.at(-1) as Extract<BuildEvent, { type: 'build-result' }>).result;
  assert.deepEqual([result.status, result.outDir, result.manifest, result.files.map((f) => f.path)], ['ok', out, 'Cli.orogen.json', FILES]);
  const kinds = new Set(events.map((e) => e.type));
  for (const type of ['eval-start', 'node-start', 'node-done', 'eval-end', 'build-target', 'build-progress']) assert.ok(kinds.has(type as never), `an event of type ${type}`);
  assert.ok(!/^orogen build: /m.test(done.err), 'with --json the progress lines are not printed');
  assert.ok(fs.existsSync(path.join(out, 'Cli.orogen.json')));
});

test('orogen build exits with 1 when the build has errors: nothing is written for a plan error, and a failed build leaves its report beside the folder', () => {
  // 513 is no landscape size.
  const planned = path.join(SCRATCH, 'plan-error');
  const size = orogen([PROJECT, '--out', planned, '--res', '513']);
  assert.equal(size.code, 1, size.err);
  assert.equal(size.out, '');
  assert.match(size.err, /^orogen build: error E_SIZE_NOT_LANDSCAPE: Unreal Landscape: 513 x 513 is not a size an Unreal landscape can have/m);
  assert.match(size.err, /^orogen build: failed; nothing was written$/m);
  assert.deepEqual([fs.existsSync(planned), fs.existsSync(`${planned}.partial`)], [false, false]);
  // A resolution that is none.
  const bad = orogen([PROJECT, '--out', planned, '--res', '1000']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^orogen build: error E_RESOLUTION: /m);

  // A node that fails.
  const failing = project('failing', {
    ...TERRAIN,
    broken: { type: 'ref/fail', params: { message: 'Reference failure' }, in: 'rock.out' },
    outrock: { type: 'io/export-layer', params: { layer: 'Rock' }, in: 'broken.out' },
  });
  const out = path.join(SCRATCH, 'failed');
  const failed = orogen([failing, '--out', out]);
  assert.equal(failed.code, 1, failed.err);
  assert.equal(failed.out, '');
  assert.match(failed.err, /^orogen build: error E_NODE_FAILED: Fail \(Reference\): Reference failure\.$/m);
  assert.match(failed.err, new RegExp(`^orogen build: failed; the report is ${`${out}.partial`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
  assert.equal(fs.existsSync(out), false, 'the output folder was not made');
  assert.deepEqual(list(`${out}.partial`), ['Cli.report.json'], 'the report and no other file, under no name');
  assert.equal((JSON.parse(fs.readFileSync(path.join(`${out}.partial`, 'Cli.report.json'), 'utf8')) as { status: string }).status, 'errors');

  // A folder that is someone else's.
  const foreign = path.join(SCRATCH, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'mine');
  const refused = orogen([PROJECT, '--out', foreign]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^orogen build: error E_OUT_DIR: /m);
  assert.deepEqual(list(foreign), ['notes.txt']);
});

test('orogen build exits with 2 for a usage error, before anything is planned or written', () => {
  const never = path.join(SCRATCH, 'never');
  const notProject = path.join(SCRATCH, 'not-a-project.orogen');
  fs.writeFileSync(notProject, 'this is no JSON');
  const newer = path.join(SCRATCH, 'newer.orogen');
  fs.writeFileSync(newer, JSON.stringify({ format: 'orogen', version: 2 }));
  const usage: readonly (readonly [readonly string[], RegExp])[] = [
    [[], /name the project file to build/],
    [[PROJECT], /--out <dir> names the folder the build is written into/],
    [[PROJECT, PROJECT, '--out', never], /one project file is built at a time, not 2/],
    [[path.join(SCRATCH, 'no-such.orogen'), '--out', never], /Cannot read the project file .*no-such\.orogen/],
    [[notProject, '--out', never], /not-a-project\.orogen is not a project file/],
    [[newer, '--out', never], /newer\.orogen is not a project file: .*newer version/],
    [[PROJECT, '--out', never, '--fast'], /there is no option "--fast"/],
    [[PROJECT, '--out', never, '--res'], /--res needs a value/],
    [[PROJECT, '--out', never, '--res', 'large'], /--res "large" is not a number of vertices per side/],
    [[PROJECT, '--out', never, '--seed', '-1'], /--seed "-1" is not an integer in 0\.\.4294967295/],
    [[PROJECT, '--out', never, '--seed', '4294967296'], /--seed "4294967296" is not an integer/],
    [[PROJECT, '--out', never, '--budget-mb', '0'], /--budget-mb "0" is not a number of MiB above 0/],
    [[PROJECT, '--out', never, '--profile', 'fast'], /the profile is "core" or "max", not "fast"/],
    [[PROJECT, '--out', never, '--json=yes'], /--json takes no value/],
    [[PROJECT, '--out', never, '--out', never], /--out is given twice/],
  ];
  for (const [args, message] of usage) {
    const done = orogen(args);
    assert.equal(done.code, 2, `orogen build ${args.join(' ')}: ${done.err}`);
    assert.equal(done.out, '', 'nothing on standard output');
    assert.match(done.err, message);
    assert.match(done.err, /^usage: orogen build <project\.orogen> --out <dir>/m);
  }
  assert.deepEqual([fs.existsSync(never), fs.existsSync(`${never}.partial`)], [false, false]);
});

test('orogen build exits with 3 when no GPU device can be used', () => {
  const out = path.join(SCRATCH, 'no-device');
  const done = orogen([PROJECT, '--out', out, '--adapter', 'no adapter has this name']);
  assert.equal(done.code, 3, done.err);
  assert.equal(done.out, '');
  assert.match(done.err, /^orogen build: .*no adapter has this name/m);
  assert.deepEqual([fs.existsSync(out), fs.existsSync(`${out}.partial`)], [false, false]);
});

test('a build that is cancelled ends with 130, and leaves its report beside an output folder it did not touch', async () => {
  const out = path.join(SCRATCH, 'cancelled');
  assert.equal(orogen([PROJECT, '--out', out]).code, 0);
  const before = new Map(list(out).map((name) => [name, fs.readFileSync(path.join(out, name))]));

  // The second build of the folder runs in this process, so that it can be cancelled at a chosen event: the
  // start of its second stage. Its standard output, the events of --json, is read here and not printed.
  const controller = new AbortController();
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  let stages = 0;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]): boolean => {
    // Only the events of the build: what the test runner itself writes meanwhile goes where it was going.
    if (typeof chunk !== 'string' || !chunk.startsWith('{"type":"')) return write(chunk, ...rest);
    for (const line of chunk.split('\n')) {
      if (line === '') continue;
      lines.push(line);
      if (line.startsWith('{"type":"build-target"') && ++stages === 2) controller.abort(new DOMException('Cancelled by the test', 'AbortError'));
    }
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await runExportCli('build', [project('other', { ...TERRAIN, outland: { type: 'io/export-landscape', params: { name: 'Other' }, in: 'land.out' } }), '--out', out, '--json', '--quiet', '--profile', PROFILE], controller.signal);
  } finally {
    process.stdout.write = write;
  }
  assert.equal(code, 130);
  const events = lines.map((line) => JSON.parse(line) as EvalEvent | BuildEvent);
  const result = (events.at(-1) as Extract<BuildEvent, { type: 'build-result' }>).result;
  assert.deepEqual([result.status, result.outDir, result.files, result.manifest], ['aborted', `${out}.partial`, [], null]);
  assert.deepEqual(list(`${out}.partial`), ['Other.report.json'], 'no partial output folder: the report and nothing else');
  assert.deepEqual(list(out), [...before.keys()], 'the folder of the earlier build is untouched');
  for (const [name, bytes] of before) assert.ok(bytes.equals(fs.readFileSync(path.join(out, name))), name);

  // The next build takes the folder and clears the leftover away.
  const next = orogen([PROJECT, '--out', out]);
  assert.equal(next.code, 0, next.err);
  assert.equal(fs.existsSync(`${out}.partial`), false);
});
