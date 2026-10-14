// buildToFolder (export-unreal.md 3.8, 10.3) on real folders: the output folder holds one complete build with
// its manifest, or is untouched. A build that fails or is cancelled never leaves a partial output folder.
//
// The folders are under <OROGEN_TEST_OUTPUT>/export-folder-<process id>, removed when the file has run.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { nodes as ioNodes } from '../../src/core/nodes/io/index.ts';
import type { BuildEvent, BuildResult, EvalEvent, GraphDoc } from '../../src/core/runtime.ts';
import { buildToFolder, previousOf, stagingOf } from '../../src/export/folder.ts';
import { NodeFileSink } from '../../src/platform/node/files.ts';
import { expectNoLeaks, getEngine, makeDoc, useNodes, type GraphSpec } from '../helpers/index.ts';
import { SETTINGS } from './_build.ts';

useNodes(ioNodes);

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRATCH = path.join(path.resolve(process.env.OROGEN_TEST_OUTPUT || path.join(ROOT, 'test-output')), `export-folder-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** A terrain with one layer and one image: small, and with names a second build can change. */
const graph = (name: string, layer: string, extra: GraphSpec['nodes'] = {}): GraphSpec => ({
  settings: SETTINGS,
  nodes: {
    land: { type: 'ref/fbm', params: { octaves: 3 } },
    rock: { type: 'ref/slope-mask', inputs: { in: 'land.out' } },
    outland: { type: 'io/export-landscape', params: { name }, inputs: { in: 'land.out' } },
    outrock: { type: 'io/export-layer', params: { layer }, inputs: { in: 'rock.out' } },
    outfield: { type: 'io/export-field', params: { name: `${name}Field`, format: 'r16' }, inputs: { in: 'land.out' } },
    ...extra,
  },
});
const filesOf = (name: string, layer: string): string[] => [
  `${name}Height.png`, `${name}Height.r16`, 'LayerBase.png', 'LayerBase.r8', `Layer${layer}.png`, `Layer${layer}.r8`, `${name}Field.r16`, `${name}.orogen.json`,
];

let requestId = 2_000_000;
async function build(doc: GraphDoc, outDir: string, opts: { signal?: AbortSignal; resolution?: number; onEvent?: (e: EvalEvent | BuildEvent) => void } = {}): Promise<{ result: BuildResult; events: (EvalEvent | BuildEvent)[] }> {
  const { engine } = await getEngine();
  await engine.trim();
  const events: (EvalEvent | BuildEvent)[] = [];
  requestId += 1000;
  const result = await buildToFolder(engine, {
    doc, outDir, createSink: NodeFileSink, requestId, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.resolution !== undefined ? { resolution: opts.resolution } : {}),
    onEvent(event) {
      events.push(event);
      opts.onEvent?.(event);
    },
  });
  await expectNoLeaks();
  return { result, events };
}
const list = (dir: string): string[] => fs.readdirSync(dir).sort();
/** No staging folder, no folder of a previous build and no temporary file is left beside or in the output folder. */
function expectClean(outDir: string): void {
  assert.deepEqual([fs.existsSync(stagingOf(outDir)), fs.existsSync(previousOf(outDir))], [false, false], 'no staging folder and no previous folder');
  if (fs.existsSync(outDir)) assert.deepEqual(list(outDir).filter((name) => name.endsWith('.partial')), [], 'no partial file');
}

test('a build into a folder that does not exist: the folder holds the build, its manifest and its report, and nothing else', async () => {
  const out = path.join(SCRATCH, 'new', 'deep', 'folder');
  const { result, events } = await build(makeDoc(graph('First', 'Rock')), out);
  assert.deepEqual([result.status, result.problems, result.outDir, result.manifest, result.report], ['ok', [], out, 'First.orogen.json', 'First.report.json']);
  assert.deepEqual(result.files.map((f) => f.path), filesOf('First', 'Rock'));
  assert.deepEqual(list(out), [...filesOf('First', 'Rock'), 'First.report.json'].sort());
  for (const f of result.files) assert.equal(fs.statSync(path.join(out, f.path)).size, f.bytes, `the size of ${f.path} on disk`);
  expectClean(out);
  // The manifest on disk lists the sizes on disk.
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'First.orogen.json'), 'utf8')) as { files: { path: string; bytes: number }[] };
  for (const f of manifest.files) assert.equal(fs.statSync(path.join(out, f.path)).size, f.bytes);
  // One result, last, and it is the folder's: it names the folder.
  const results = events.filter((e): e is Extract<BuildEvent, { type: 'build-result' }> => e.type === 'build-result');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]!.result, result);
  assert.equal(events.at(-1)!.type, 'build-result');
  assert.equal(events[0]!.type, 'build-plan');
});

test('a second build into the same folder replaces it and leaves no file of the first', async () => {
  const out = path.join(SCRATCH, 'replace');
  const first = await build(makeDoc(graph('First', 'Rock')), out);
  assert.equal(first.result.status, 'ok');
  const second = await build(makeDoc(graph('Second', 'Grass')), out);
  assert.deepEqual([second.result.status, second.result.outDir], ['ok', out]);
  assert.deepEqual(list(out), [...filesOf('Second', 'Grass'), 'Second.report.json'].sort(), 'the folder holds the second build alone: no layer file of the first survives');
  expectClean(out);

  // An empty folder is taken as well, and so is a folder that was emptied by hand.
  const empty = path.join(SCRATCH, 'empty');
  fs.mkdirSync(empty);
  assert.equal((await build(makeDoc(graph('First', 'Rock')), empty)).result.status, 'ok');
  assert.deepEqual(list(empty).length, 9);
});

test('a folder with files that are no Orogen build is refused and left as it is', async () => {
  const foreign = path.join(SCRATCH, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'mine');
  const { result, events } = await build(makeDoc(graph('First', 'Rock')), foreign);
  assert.deepEqual([result.status, result.files, result.manifest, result.report, result.outDir], ['errors', [], null, null, null]);
  assert.deepEqual(result.problems.map((p) => [p.severity, p.code]), [['error', 'E_OUT_DIR']]);
  assert.equal(result.peakPoolBytes, null, 'nothing was evaluated');
  assert.match(result.problems[0]!.message, /^Cannot build into this folder: .*foreign holds files and no Orogen build manifest/);
  assert.deepEqual(list(foreign), ['notes.txt']);
  assert.equal(fs.readFileSync(path.join(foreign, 'notes.txt'), 'utf8'), 'mine');
  expectClean(foreign);
  // Nothing was planned or evaluated: the problem and the result are all there is.
  assert.deepEqual(events.map((e) => e.type), ['build-problem', 'build-result']);

  // A manifest of something else, and a manifest that cannot be read, do not make a folder Orogen's.
  for (const [name, content] of [['other.orogen.json', '{"schema":"something.else/1"}'], ['broken.orogen.json', '{"schema": "orogen.unreal.landscape/1"'], ['no.orogen.json', 'null']] as const) {
    const dir = path.join(SCRATCH, `foreign-${name}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, name), content);
    assert.deepEqual((await build(makeDoc(graph('First', 'Rock')), dir)).result.problems.map((p) => p.code), ['E_OUT_DIR'], name);
    assert.deepEqual(list(dir), [name]);
  }
  // A later major version of the manifest is still a build of Orogen's: the folder may be replaced, with the files it lists.
  const later = path.join(SCRATCH, 'later');
  fs.mkdirSync(later);
  fs.writeFileSync(path.join(later, 'Old.orogen.json'), '{"schema":"orogen.unreal.landscape/7","files":[{"path":"OldHeight.png","bytes":3}]}');
  fs.writeFileSync(path.join(later, 'OldHeight.png'), 'old');
  // What an operating system leaves in a folder it has shown is nobody's work.
  fs.writeFileSync(path.join(later, 'desktop.ini'), '[.ShellClassInfo]');
  assert.equal((await build(makeDoc(graph('First', 'Rock')), later)).result.status, 'ok');
  assert.deepEqual(list(later), [...filesOf('First', 'Rock'), 'First.report.json'].sort());

  // A file where the folder should be.
  const taken = path.join(SCRATCH, 'taken');
  fs.writeFileSync(taken, 'a file');
  assert.deepEqual((await build(makeDoc(graph('First', 'Rock')), taken)).result.problems.map((p) => p.code), ['E_OUT_DIR']);
  assert.equal(fs.readFileSync(taken, 'utf8'), 'a file');
});

test('a build folder into which somebody put a file of their own is refused, not emptied', async () => {
  // The project file saved into the folder of its build: the next build would delete it with everything else.
  const out = path.join(SCRATCH, 'shared');
  assert.equal((await build(makeDoc(graph('First', 'Rock')), out)).result.status, 'ok');
  const built = list(out);
  for (const [name, make] of [
    ['alps.orogen', () => fs.writeFileSync(path.join(out, 'alps.orogen'), '{"format":"orogen"}')],
    ['Notes', () => fs.mkdirSync(path.join(out, 'Notes'))],
    ['Mine.report.json', () => fs.writeFileSync(path.join(out, 'Mine.report.json'), '{"quarter":3}')],
  ] as const) {
    make();
    const { result, events } = await build(makeDoc(graph('Second', 'Grass')), out);
    assert.deepEqual([result.status, result.outDir, result.problems.map((p) => p.code)], ['errors', null, ['E_OUT_DIR']], name);
    assert.match(result.problems[0]!.message, new RegExp(`shared holds an Orogen build and also ${name.replace('.', '\\.')}, which is no file of that build`));
    assert.deepEqual(events.map((e) => e.type), ['build-problem', 'build-result']);
    assert.deepEqual(list(out), [...built, name].sort(), 'the folder is as it was');
    expectClean(out);
    fs.rmSync(path.join(out, name), { recursive: true });
  }
  // With the file moved away the folder is the build's again.
  assert.equal((await build(makeDoc(graph('Second', 'Grass')), out)).result.status, 'ok');
  assert.deepEqual(list(out), [...filesOf('Second', 'Grass'), 'Second.report.json'].sort());

  // A file that arrives while the build runs: the build is complete, stays beside the folder, and nothing is deleted.
  let dropped = false;
  const late = await build(makeDoc(graph('Third', 'Snow')), out, {
    onEvent(event) {
      if (event.type !== 'build-target' || dropped) return;
      dropped = true;
      fs.writeFileSync(path.join(out, 'saved-meanwhile.orogen'), 'mine');
    },
  });
  assert.deepEqual([late.result.status, late.result.outDir, late.result.problems.map((p) => [p.severity, p.code])], ['errors', stagingOf(out), [['error', 'E_COMMIT_FAILED']]]);
  assert.match(late.result.problems[0]!.message, /^The build is complete but could not be moved to .*shared: .*saved-meanwhile\.orogen, which is no file of that build; .* it is in .*shared\.partial\.$/);
  assert.deepEqual(list(out), [...filesOf('Second', 'Grass'), 'Second.report.json', 'saved-meanwhile.orogen'].sort());
  assert.deepEqual(list(stagingOf(out)), [...filesOf('Third', 'Snow'), 'Third.report.json'].sort(), 'the complete build, without anything of the protocol');
});

test('the two names beside the output folder are cleared only when what bears them is Orogen\'s', async () => {
  const out = path.join(SCRATCH, 'beside');
  assert.equal((await build(makeDoc(graph('First', 'Rock')), out)).result.status, 'ok');
  const built = list(out);
  // A folder of the user's that happens to be named like the staging folder, or like the folder of the previous build.
  for (const beside of [stagingOf(out), previousOf(out)]) {
    fs.mkdirSync(beside);
    fs.writeFileSync(path.join(beside, 'backup-of-my-terrain.r16'), 'mine');
    const { result } = await build(makeDoc(graph('Second', 'Grass')), out);
    assert.deepEqual([result.status, result.outDir, result.problems.map((p) => p.code)], ['errors', null, ['E_OUT_DIR']]);
    assert.match(result.problems[0]!.message, /a build needs the name .* beside it, and what bears that name holds files and no Orogen build manifest/);
    assert.deepEqual(list(beside), ['backup-of-my-terrain.r16'], 'it is left as it is');
    assert.deepEqual(list(out), built);
    fs.rmSync(beside, { recursive: true });
  }

  // What Orogen itself leaves there: a build interrupted while it wrote (the marker says so, whatever lies beside it),
  // a complete build whose swap failed, and the previous build of a swap that was interrupted.
  fs.mkdirSync(stagingOf(out));
  fs.writeFileSync(path.join(stagingOf(out), '.orogen-staging'), '');
  fs.writeFileSync(path.join(stagingOf(out), 'HalfHeight.r16.partial'), 'half a file');
  fs.writeFileSync(path.join(stagingOf(out), 'HalfHeight.png'), 'put in place before the interruption');
  fs.cpSync(out, previousOf(out), { recursive: true });
  const second = await build(makeDoc(graph('Second', 'Grass')), out);
  assert.deepEqual([second.result.status, second.result.outDir], ['ok', out]);
  assert.deepEqual(list(out), [...filesOf('Second', 'Grass'), 'Second.report.json'].sort());
  expectClean(out);
  fs.cpSync(out, stagingOf(out), { recursive: true });
  assert.equal((await build(makeDoc(graph('First', 'Rock')), out)).result.status, 'ok');
  expectClean(out);

  // While a build runs the staging folder bears the marker, and no folder a build ends in holds it.
  let marked = false;
  const third = await build(makeDoc(graph('Third', 'Snow')), out, {
    onEvent(event) {
      if (event.type === 'build-target') marked ||= fs.existsSync(path.join(stagingOf(out), '.orogen-staging'));
    },
  });
  assert.deepEqual([third.result.status, marked, list(out).includes('.orogen-staging')], ['ok', true, false]);
});

test('a cancelled build and a failed one leave the output folder untouched and the report beside it; the next build clears that away', async () => {
  const out = path.join(SCRATCH, 'kept');
  const first = await build(makeDoc(graph('First', 'Rock')), out);
  assert.equal(first.result.status, 'ok');
  const before = new Map(list(out).map((name) => [name, fs.readFileSync(path.join(out, name))]));
  const untouched = (): void => {
    assert.deepEqual(list(out), [...before.keys()]);
    for (const [name, bytes] of before) assert.ok(bytes.equals(fs.readFileSync(path.join(out, name))), `${name} is as the first build left it`);
  };

  // Cancelled in its second stage.
  const controller = new AbortController();
  let stages = 0;
  const cancelled = await build(makeDoc(graph('Second', 'Grass')), out, {
    signal: controller.signal,
    onEvent(event) {
      if (event.type === 'build-target' && ++stages === 2) controller.abort(new DOMException('Cancelled by the test', 'AbortError'));
    },
  });
  const staging = stagingOf(out);
  assert.deepEqual([cancelled.result.status, cancelled.result.outDir, cancelled.result.files, cancelled.result.manifest, cancelled.result.report], ['aborted', staging, [], null, 'Second.report.json']);
  assert.deepEqual(list(staging), ['Second.report.json'], 'the staging folder holds the report and nothing else: no partial file');
  untouched();
  assert.equal(fs.existsSync(previousOf(out)), false);

  // Failed: a node upstream of the layer raises an error.
  const failing = graph('Third', 'Snow', { broken: { type: 'ref/fail', params: { message: 'Reference failure' }, inputs: { in: 'land.out' } }, outbroken: { type: 'io/export-mask', inputs: { in: 'broken.out' } } });
  const failed = await build(makeDoc(failing), out);
  assert.deepEqual([failed.result.status, failed.result.outDir, failed.result.problems.map((p) => p.code)], ['errors', staging, ['E_NODE_FAILED']]);
  assert.deepEqual(list(staging), ['Third.report.json'], 'the leftover of the cancelled build was removed, and this one left its report');
  untouched();

  // A plan with an error: nothing is staged at all.
  const unplanned = await build(makeDoc(graph('1234', 'Rock')), out);
  assert.deepEqual([unplanned.result.status, unplanned.result.outDir, unplanned.result.report, unplanned.result.problems.map((p) => p.code)], ['errors', null, null, ['E_NAME_INVALID']]);
  assert.equal(fs.existsSync(staging), false, 'the staging folder is deleted when the plan has an error');
  untouched();

  // The next build that succeeds replaces the folder, whatever the failed ones left: here the report of the last one.
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'Third.report.json'), JSON.stringify({ schema: 'orogen.build-report/1', status: 'errors' }));
  const fourth = await build(makeDoc(graph('Fourth', 'Sand')), out);
  assert.deepEqual([fourth.result.status, fourth.result.outDir], ['ok', out]);
  assert.deepEqual(list(out), [...filesOf('Fourth', 'Sand'), 'Fourth.report.json'].sort());
  expectClean(out);
});

test('buildToFolder rejects a malformed call: a folder that is no absolute path, no way to make a sink', async () => {
  const { engine } = await getEngine();
  const doc = makeDoc(graph('First', 'Rock'));
  await assert.rejects(buildToFolder(engine, { doc, outDir: 'relative/folder', createSink: NodeFileSink, requestId: 9_000_000 }), TypeError);
  await assert.rejects(buildToFolder(engine, { doc, outDir: SCRATCH, createSink: undefined as never, requestId: 9_000_000 }), TypeError);
  assert.equal(fs.existsSync(path.join(ROOT, 'relative')), false);
});
