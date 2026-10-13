// How a build runs and how it ends when it does not succeed (export-unreal.md 3.2 to 3.9, 10.3): staged delivery
// in row bands, the engine's ledger during a build, cancellation in a stage and in the weights, a failing node, a
// sink that fails. A build that did not succeed leaves the report and no other file, under no name.
//
// Sizes: 241 x 241, and 1009 x 1009 where a field has to span more than one band.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodes as ioNodes } from '../../src/core/nodes/io/index.ts';
import type { AnyFieldHandle, BuildEvent, Engine, EvalEvent, FileWriter } from '../../src/core/runtime.ts';
import { bandRows, buildProject } from '../../src/export/build.ts';
import { planBuild } from '../../src/export/plan.ts';
import { quantiseHeights, quantiseWeights, SRGB8, weightFloorCode } from '../../src/export/unreal.ts';
import { getEngine, makeDoc, memorySink, renderGraph, stats, useNodes, type GraphSpec, type MemorySink } from '../helpers/index.ts';
import {
  direct, expectTexture, file, floats, fullGraph, FULL_FILES, idOf, manifestOf, normalPlanes, onTexels, pngSamples, reportOf, SETTINGS, u16, unitCode,
} from './_build.ts';
import { assertSame } from './unit/_support.ts';

useNodes(ioNodes);

// One build whose fields span two bands (1009 rows are 512 and 497), with dither, behind an engine that records
// what the pipeline reads; and the engine's own output of what it exported, from an evaluation of its own.
const B = 1009;
const reads: { handle: AnyFieldHandle; rows: readonly [number, number] | undefined }[] = [];
const measured = { calls: 0 };
const banded = await direct(makeDoc(fullGraph({ dither: true })), {
  resolution: B,
  wrap: (engine) => Object.create(engine, {
    read: { value: (handle: AnyFieldHandle, rows?: readonly [number, number]) => { reads.push({ handle, rows }); return engine.read(handle, rows); } },
    stats: { value: (handle: Parameters<Engine['stats']>[0]) => { measured.calls++; return engine.stats(handle); } },
  }) as Engine,
});
const whole = (await renderGraph(fullGraph(), ['land.out', 'rock.out', 'scree.out', 'paint.out'], { mode: 'build', res: B })).fields;

const cancelled = (): DOMException => new DOMException('Cancelled by the test', 'AbortError');
const types = (events: readonly (EvalEvent | BuildEvent)[]): string[] => events.map((e) => e.type);
/** What a build that did not succeed leaves: the report, no other file, no open writer, and nothing in its result. */
function expectOnlyReport(built: Awaited<ReturnType<typeof direct>>, name: string, status: 'aborted' | 'errors'): void {
  assert.equal(built.result.status, status);
  assert.deepEqual([...built.sink.files.keys()], [`${name}.report.json`], 'the report and no other file');
  assert.deepEqual(built.sink.open, [], 'no writer is left open: every partial file is gone');
  assert.deepEqual([built.result.files, built.result.manifest, built.result.report], [[], null, `${name}.report.json`]);
  assert.equal(reportOf(built.sink, name).status, status);
  assert.deepEqual(reportOf(built.sink, name).files, []);
  assert.ok(!built.events.some((e) => e.type === 'build-progress' && e.phase === 'commit'), 'the commit never began');
  assert.equal(built.events.at(-1)!.type, 'build-result');
}

/** A sink that behaves as `inner` does, but for what `change` replaces. */
function sinkWith(inner: MemorySink, change: Partial<Pick<MemorySink, 'create' | 'write' | 'abortAll'>>): MemorySink {
  return Object.create(inner, Object.fromEntries(Object.entries(change).map(([name, value]) => [name, { value }]))) as MemorySink;
}
/** A sink whose writer of `path` is changed. */
function writerOf(inner: MemorySink, path: string, change: (writer: FileWriter) => Partial<FileWriter>): MemorySink {
  return sinkWith(inner, {
    async create(relPath) {
      const writer = await inner.create(relPath);
      return relPath === path ? { write: (c) => writer.write(c), close: () => writer.close(), abort: () => writer.abort(), ...change(writer) } : writer;
    },
  });
}

test('bandRows: at most 32 MiB of floats and 512 rows, at least 16', () => {
  assert.deepEqual([bandRows(8129, 1), bandRows(8129, 4), bandRows(1009, 1), bandRows(241, 4), bandRows(60000, 4), bandRows(16400, 4)], [512, 256, 512, 512, 32, 112]);
  assert.equal(bandRows(8129, 4) * 8129 * 4 * 4, 33_296_384, '256 rows of an 8129-wide color are 33.3 MB');
  assert.equal(bandRows(1_000_000, 4), 16);
});

test('a build reads every target in bands, top row first and in order, and never a whole field at once', () => {
  // 1009 rows are two bands of a field. The engine the pipeline was given is the real one behind a spy.
  assert.equal(banded.result.status, 'ok');
  // Nine targets; the landscape and the image of a measured range are measured.
  assert.equal(measured.calls, 2);
  const byHandle = new Map<AnyFieldHandle, (readonly [number, number])[]>();
  for (const read of reads) {
    assert.ok(read.rows, 'every read names its rows');
    byHandle.set(read.handle, [...(byHandle.get(read.handle) ?? []), read.rows]);
  }
  assert.equal(byHandle.size, 9, 'one handle per target');
  for (const [handle, rows] of byHandle) {
    assert.deepEqual([handle.width, handle.height], [B, B]);
    // 512 rows, then the rest, for a field and for a color alike at this width.
    assert.deepEqual(rows, [[0, 512], [512, B]], `the bands of a ${handle.kind}`);
    // The evaluator released the handle when its stage settled: the pipeline kept none.
    assert.throws(() => handle.texture, (thrown: Error) => thrown.name === 'FieldAccessError');
  }
  assert.deepEqual([...byHandle.keys()].map((handle) => handle.kind).sort(), ['color', 'field', 'field', 'field', 'field', 'field', 'field', 'field', 'field']);
  // The reads of one target are not interleaved with those of another: one stage at a time.
  const order = reads.map((read) => read.handle);
  assert.deepEqual(order.filter((handle, i) => i === 0 || handle !== order[i - 1]).length, 9);
});

test('what a build writes does not depend on its bands: every file of a two-band build is the whole field converted at once', async () => {
  const { sink } = banded;
  const land = whole['land.out']!, rock = whole['rock.out']!, scree = whole['scree.out']!, paint = whole['paint.out']!;
  const manifest = manifestOf(sink, 'TestLand');

  // The heights, with dither: the noise of a texel depends on its row in the field, not on its row in the band.
  const { valueMin: a, valueMax: b, measuredMin, measuredMax } = manifest.landscape!.heightmap;
  assert.deepEqual([measuredMin, measuredMax, a, b], [stats(land).min, stats(land).max, stats(land).min, stats(land).max]);
  const codes = new Uint16Array(B * B);
  quantiseHeights(land.data, codes, { width: B, y0: 0, a, b, dither: true });
  assertSame(u16(file(sink, 'TestLandHeight.r16')), codes, 'the .r16');
  assertSame(pngSamples(sink, 'TestLandHeight.png', { size: B, channels: 1, bits: 16 }), codes, 'the PNG');

  // The layers: the planes are filled band by band and quantised band by band.
  const planes = [rock, scree].map((mask) => Uint16Array.from(mask.data, (v) => unitCode(v, 65535)));
  const weights = [new Uint8Array(B * B), new Uint8Array(B * B), new Uint8Array(B * B)];
  quantiseWeights(planes, weights, { offset: 0, count: B * B, floorCode: weightFloorCode(0.008), limit: 0 });
  for (const [j, name] of ['Base', 'Rock', 'Scree'].entries()) {
    assertSame(file(sink, `Layer${name}.r8`), weights[j]!, `Layer${name}.r8`);
    assertSame(pngSamples(sink, `Layer${name}.png`, { size: B, channels: 1, bits: 8 }), weights[j]!, `Layer${name}.png`);
  }
  let off = 0;
  for (let i = 0; i < B * B; i++) if (weights[0]![i]! + weights[1]![i]! + weights[2]![i]! !== 255) off++;
  assert.equal(off, 0, 'texels whose weight-blended bytes do not total 255');
  assertSame(file(sink, 'LayerSteep.r8'), Uint8Array.from(rock.data, (v) => unitCode(v, 255)), 'LayerSteep.r8');

  // The textures, against 5.9 in float64 on the whole field: the resampler's window and the rows a normal needs
  // from the band before and the band after cross the band boundary at row 512.
  const S = 1024;
  const color = new Uint8Array(S * S * 3);
  for (const c of [0, 1, 2]) {
    const plane = onTexels(paint, S, c);
    for (let i = 0; i < S * S; i++) color[3 * i + c] = SRGB8[unitCode(plane[i]!, 65535)]!;
  }
  expectTexture(pngSamples(sink, 'T_Color_1024.png', { size: S, channels: 3, bits: 8 }), color, 'the color texture');
  expectTexture(pngSamples(sink, 'T_Mask_1024.png', { size: S, channels: 1, bits: 16 }), Uint16Array.from(onTexels(scree, S), (v) => unitCode(v, 65535)), 'the mask texture');
  const components = normalPlanes(land, SETTINGS.heightRange, SETTINGS.terrainSize).map((plane) => onTexels(plane, S));
  const normal = new Uint8Array(S * S * 3);
  for (let i = 0; i < S * S; i++) {
    const length = Math.hypot(components[0]![i]!, components[1]![i]!, components[2]![i]!);
    for (const c of [0, 1, 2]) normal[3 * i + c] = Math.floor((components[c]![i]! / length * 0.5 + 0.5) * 255 + 0.5);
  }
  expectTexture(pngSamples(sink, 'T_Normal_1024.png', { size: S, channels: 3, bits: 8 }), normal, 'the normal texture');

  // The images: every float as the engine has it, and the measured range over the codes.
  assertSame(await floats(sink, 'Heights.exr', B), land.data, 'Heights.exr');
  const { min, max } = stats(land);
  assertSame(pngSamples(sink, 'Steepness.png', { size: B, channels: 1, bits: 16 }), Uint16Array.from(land.data, (v) => unitCode((v - min) / (max - min), 65535)), 'Steepness.png');
});

test('during a build the engine\'s ledger shows no allocation made by the pipeline', async () => {
  const { engine } = await getEngine();
  await engine.trim();
  const before = engine.memory();
  let outputPeak = 0;
  const samples: { type: string; phase: string; working: number; held: number; reserved: number }[] = [];
  const { result } = await direct(makeDoc(fullGraph()), {
    resolution: 1009,
    onEvent(event, live) {
      if (event.type === 'eval-start') outputPeak = event.outputPeakBytes ?? 0;
      if (!event.type.startsWith('build-')) return;
      const m = live.memory();
      samples.push({ type: event.type, phase: event.type === 'build-progress' ? event.phase : '', working: m.workingBytes, held: m.pinnedBytes + m.cacheBytes, reserved: m.reservedBytes });
    },
  });
  assert.equal(result.status, 'ok');
  const inStages = samples.filter((s) => s.type === 'build-target' || s.phase === 'targets');
  assert.ok(inStages.length >= 9);
  // While a stage runs no node runs, and the pipeline acquires nothing: no texture is WORKING.
  assert.deepEqual(inStages.filter((s) => s.working !== 0), []);
  // What is held is what the evaluation holds for its targets and the nodes still to run: the widest cut of the plan, which it stated before it began.
  assert.ok(outputPeak > 0);
  assert.deepEqual(inStages.filter((s) => s.held > outputPeak), []);
  assert.ok(inStages.some((s) => s.held >= 1009 * 1009 * 4), 'a target is held while its stage reads it');
  // Beyond textures, the engine's one staging buffer of at most 64 MiB and its statistics buffers: nothing that grows with the layers.
  const grown = Math.max(...samples.map((s) => s.reserved)) - before.reservedBytes;
  assert.ok(grown <= (64 << 20) + (8 << 20), `the reserved memory grew by ${grown} bytes`);
  // The weights and the commit hold no GPU memory at all: the planes are on the CPU.
  const after = samples.filter((s) => s.phase === 'weights' || s.phase === 'commit' || s.type === 'build-result');
  assert.ok(after.length >= 2);
  assert.deepEqual(after.filter((s) => s.working !== 0 || s.held !== 0), []);
  // The plan said how much the planes take.
  assert.equal(planBuild(makeDoc(fullGraph()), engine.registry, { resolution: 1009 }).estimate.planeBytes, 2 * 2 * 1009 * 1009);
});

test('cancelling before a build begins, in a stage and in the weights leaves the report and nothing else', async () => {
  // Before it begins.
  const early = new AbortController();
  early.abort(cancelled());
  const never = await direct(makeDoc(fullGraph()), { signal: early.signal });
  expectOnlyReport(never, 'TestLand', 'aborted');
  assert.ok(!types(never.events).includes('build-target') && !types(never.events).includes('node-start'), 'nothing was evaluated or exported');
  assert.deepEqual(reportOf(never.sink, 'TestLand').targets.map((t) => [t.evaluateMs, t.exportMs]), Array(9).fill([null, null]));
  assert.deepEqual(never.result.problems, []);

  // At the start of the third stage: two targets are done by then, with their files open under temporary names.
  const third = new AbortController();
  let stages = 0;
  const inStage = await direct(makeDoc(fullGraph()), {
    signal: third.signal,
    onEvent(event) {
      if (event.type === 'build-target' && ++stages === 3) third.abort(cancelled());
    },
  });
  expectOnlyReport(inStage, 'TestLand', 'aborted');
  const reached = reportOf(inStage.sink, 'TestLand').targets.filter((t) => t.exportMs !== null).length;
  assert.equal(reached, 3, 'two stages ran and the third began');
  assert.equal(types(inStage.events).filter((t) => t === 'build-target').length, 3);

  // In the middle of a stage, between two bands of the heightmap (1009 rows are two bands).
  const middle = new AbortController();
  const betweenBands = await direct(makeDoc(fullGraph()), {
    resolution: 1009, signal: middle.signal,
    onEvent(event) {
      if (event.type === 'build-progress' && event.phase === 'targets') middle.abort(cancelled());
    },
  });
  expectOnlyReport(betweenBands, 'TestLand', 'aborted');
  const progress = betweenBands.events.filter((e): e is Extract<BuildEvent, { type: 'build-progress' }> => e.type === 'build-progress');
  assert.ok(progress.length === 1 && progress[0]!.fraction > 0 && progress[0]!.fraction < 0.2, 'one band of the first target was converted');

  // In the weights: every target is done, and the files of the base layer are being created.
  const weights = new AbortController();
  const plain = memorySink();
  const inWeights = await direct(makeDoc(fullGraph()), {
    signal: weights.signal,
    sink: sinkWith(plain, {
      create(relPath) {
        if (relPath === 'LayerBase.png') weights.abort(cancelled());
        return plain.create(relPath);
      },
    }),
  });
  expectOnlyReport(inWeights, 'TestLand', 'aborted');
  assert.equal(types(inWeights.events).filter((t) => t === 'build-target').length, 9, 'every stage had run');
  assert.ok(reportOf(inWeights.sink, 'TestLand').weightsMs !== null);
  assert.ok(reportOf(inWeights.sink, 'TestLand').targets.every((t) => t.exportMs !== null));
});

test('a failing node upstream of the second target ends the build with E_NODE_FAILED, and no data file becomes visible', async () => {
  const spec: GraphSpec = {
    settings: SETTINGS,
    nodes: {
      land: { type: 'ref/fbm', params: { octaves: 4 } },
      rock: { type: 'ref/slope-mask', inputs: { in: 'land.out' } },
      broken: { type: 'ref/fail', params: { message: 'Reference failure' }, inputs: { in: 'rock.out' } },
      outland: { type: 'io/export-landscape', inputs: { in: 'land.out' } },
      outrock: { type: 'io/export-layer', params: { layer: 'Rock', weightBlended: false }, inputs: { in: 'broken.out' } },
      outfield: { type: 'io/export-field', inputs: { in: 'land.out' } },
    },
  };
  const doc = makeDoc(spec);
  const built = await direct(doc);
  expectOnlyReport(built, 'Orogen', 'errors');
  const failing = idOf(doc, 'ref/fail');
  assert.deepEqual(built.result.problems, [{ severity: 'error', code: 'E_NODE_FAILED', message: 'Fail (Reference): Reference failure.', nodeId: failing }]);
  // The terrain feeds the first and the third target: both were exported before the node failed. Their files were open, and are gone.
  const report = reportOf(built.sink, 'Orogen');
  assert.deepEqual(report.targets.map((t) => [t.kind, t.exportMs !== null]), [['landscape', true], ['layer', false], ['image', true]]);
  assert.deepEqual(report.problems, built.result.problems);
  // The node's error reaches the listener as the evaluation's event, and the build adds its problem and its result.
  const order = types(built.events);
  assert.ok(order.indexOf('node-error') > order.indexOf('build-target') && order.indexOf('build-problem') > order.indexOf('node-error'));
  assert.equal(order.filter((t) => t === 'build-problem').length, 1);
  // The build stops at the first error: no stage begins after it.
  assert.equal(order.filter((t) => t === 'build-target').length, 2);
  assert.ok(order.lastIndexOf('build-target') < order.indexOf('node-error'));
});

test('a file that cannot be written is E_WRITE_FAILED, with its path, and the build leaves the report alone', async () => {
  const full = new Error('disk full');
  // A write that is refused in a stage, and one in the weights.
  for (const path of ['TestLandHeight.r16', 'LayerSteep.png', 'T_Normal_1024.png', 'Heights.exr', 'LayerRock.r8']) {
    const inner = memorySink();
    const built = await direct(makeDoc(fullGraph()), { sink: writerOf(inner, path, () => ({ write: () => Promise.reject(full) })) });
    expectOnlyReport(built, 'TestLand', 'errors');
    assert.deepEqual(built.result.problems.map((p) => [p.severity, p.code]), [['error', 'E_WRITE_FAILED']], path);
    assert.equal(built.result.problems[0]!.message, `Cannot write ${path}: disk full.`);
  }
  // A file that cannot be created.
  const inner = memorySink();
  const doc = makeDoc(fullGraph());
  const refused = await direct(doc, {
    sink: sinkWith(inner, { create: (relPath) => (relPath === 'T_Color_1024.png' ? Promise.reject(new Error('no permission')) : inner.create(relPath)) }),
  });
  expectOnlyReport(refused, 'TestLand', 'errors');
  assert.deepEqual(refused.result.problems, [{ severity: 'error', code: 'E_WRITE_FAILED', message: 'Cannot write T_Color_1024.png: no permission.', nodeId: idOf(doc, 'io/export-color') }]);
});

test('the commit: a file that reports another size is E_WRITE_FAILED, one that cannot be put in place E_COMMIT_FAILED, and the manifest is not written', async () => {
  // close() reports fewer bytes than the pipeline handed over.
  const short = memorySink();
  const wrongSize = await direct(makeDoc(fullGraph()), {
    sink: writerOf(short, 'LayerBase.r8', (writer) => ({ close: async () => ({ bytes: (await writer.close()).bytes - 1 }) })),
  });
  assert.equal(wrongSize.result.status, 'errors');
  assert.deepEqual(wrongSize.result.problems.map((p) => p.code), ['E_WRITE_FAILED']);
  assert.match(wrongSize.result.problems[0]!.message, /^Cannot write LayerBase\.r8: 58081 bytes were handed to the file and it reports 58080\.$/);
  assert.ok(!wrongSize.sink.files.has('TestLand.orogen.json'), 'no manifest');

  // A rename that fails in the middle of the commit: the files before it stay, the others are aborted, no manifest follows.
  const locked = memorySink();
  const stuck = await direct(makeDoc(fullGraph()), {
    sink: writerOf(locked, 'LayerRock.png', () => ({ close: () => Promise.reject(new Error('the file is open in another program')) })),
  });
  assert.equal(stuck.result.status, 'errors');
  assert.deepEqual(stuck.result.problems.map((p) => [p.severity, p.code]), [['error', 'E_COMMIT_FAILED']]);
  assert.match(stuck.result.problems[0]!.message, /^Cannot put LayerRock\.png in place: the file is open in another program; .* build again\.$/);
  const before = FULL_FILES.slice(0, FULL_FILES.indexOf('LayerRock.png'));
  assert.deepEqual([...stuck.sink.files.keys()], [...before, 'TestLand.report.json'], 'files already in place stay; the manifest is not written');
  assert.deepEqual(stuck.sink.open, []);
  assert.deepEqual([stuck.result.files, stuck.result.manifest], [[], null]);
  assert.deepEqual(reportOf(stuck.sink, 'TestLand').files.map((f) => f.path), before, 'the report lists what became visible');
  // The commit had begun: progress reached 1.
  assert.ok(stuck.events.some((e) => e.type === 'build-progress' && e.phase === 'commit' && e.fraction === 1));

  // The manifest itself cannot be written.
  const full = memorySink();
  const noManifest = await direct(makeDoc(fullGraph()), {
    sink: sinkWith(full, { write: (relPath, data) => (relPath.endsWith('.orogen.json') ? Promise.reject(new Error('disk full')) : full.write(relPath, data)) }),
  });
  assert.deepEqual([noManifest.result.status, noManifest.result.problems.map((p) => p.code), noManifest.result.manifest], ['errors', ['E_COMMIT_FAILED'], null]);
  assert.ok(!noManifest.sink.files.has('TestLand.orogen.json') && noManifest.sink.files.has('TestLandHeight.r16'));

  // A report that cannot be written does not undo a build: the files are in place, the result has no report.
  const mute = memorySink();
  const noReport = await direct(makeDoc(fullGraph()), {
    sink: sinkWith(mute, { write: (relPath, data) => (relPath.endsWith('.report.json') ? Promise.reject(new Error('disk full')) : mute.write(relPath, data)) }),
  });
  assert.deepEqual([noReport.result.status, noReport.result.report, noReport.result.manifest], ['ok', null, 'TestLand.orogen.json']);
  assert.deepEqual(noReport.result.problems.map((p) => [p.severity, p.code]), [['warning', 'E_WRITE_FAILED']]);
  assert.deepEqual([...noReport.sink.files.keys()], FULL_FILES);
  // The heights are those of every other build of the graph.
  assert.equal(u16(file(noReport.sink, 'TestLandHeight.r16')).length, 241 * 241);
});

test('buildProject rejects a malformed call and nothing else', async () => {
  const { engine } = await getEngine();
  const doc = makeDoc(fullGraph());
  await assert.rejects(buildProject(engine, { doc, sink: memorySink(), requestId: 1.5 }), TypeError);
  await assert.rejects(buildProject(engine, { doc, sink: {} as never, requestId: 5_000_000 }), TypeError);
  await assert.rejects(buildProject(engine, { doc: null as never, sink: memorySink(), requestId: 5_000_000 }), TypeError);
  await assert.rejects(buildProject({} as never, { doc, sink: memorySink(), requestId: 5_000_000 }), TypeError);
  // A request id that does not grow is the engine's to refuse, and the build passes its refusal on.
  const sink = memorySink();
  await assert.rejects(buildProject(engine, { doc, sink, requestId: 1 }), /requestId 1 is not an integer greater than/);
  assert.deepEqual([[...sink.files.keys()], sink.open], [[], []]);

  // Anything else an evaluation rejects with is no malformed call: the build ends with E_INTERNAL and leaves its report.
  const broken = await direct(doc, { wrap: (real) => Object.create(real, { evaluate: { value: () => Promise.reject(new Error('the evaluator broke')) } }) as Engine });
  expectOnlyReport(broken, 'TestLand', 'errors');
  assert.deepEqual(broken.result.problems, [{ severity: 'error', code: 'E_INTERNAL', message: 'the evaluator broke' }]);
});
