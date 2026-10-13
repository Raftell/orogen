// The harness on a device (testing.md 2.1, 2.3, 2.6, 2.8): the engine and its replacement, renderNode and
// traceNode with every option and every outcome, the reports, the fbm fixture, renderLadder, expectNoLeaks,
// and the two functions that belong to later stages.
//
// Sizes: fields of at most 257 x 257; no field is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adapterNamed } from '../../../src/core/gpu/caps.ts';
import fbm from '../../../src/core/nodes/ref/fbm.ts';
import { DeviceLostError } from '../../../src/core/runtime.ts';
import {
  at, buildGraph, channelOf, expectClose, expectIdentical, expectNoLeaks, expectStats, fieldOf, fixtures, getEngine, launchApp, makeDoc,
  NodeFailure, renderLadder, renderNode, TEST_SETTINGS, traceNode, useNodes, type FieldData,
} from '../../helpers/index.ts';
import { climb, dim, either, failing, harnessNodes, probe, scale, split, splitCalls } from './nodes.ts';

useNodes(harnessNodes);

const FIELD_BYTES = (res: number): number => res * res * 4;
const times = (f: FieldData, factor: number): FieldData => fieldOf(f.width, (u, v) => at(f, Math.round(u * (f.width - 1)), Math.round(v * (f.height - 1))) * factor);
const rejection = (work: Promise<unknown>): Promise<unknown> => work.then(() => assert.fail('the call resolved'), (thrown: unknown) => thrown);

// ---- the engine ----------------------------------------------------------------------------------------------------

test('TEST_SETTINGS are those of the contract', () => {
  assert.deepEqual(TEST_SETTINGS, { terrainSize: 4096, heightRange: 1024, seed: 1, buildResolution: 513, previewLevel: 1, seaLevel: 0.25 });
});

test('getEngine: one device, the profile of the environment, one engine per slicing', async () => {
  const auto = await getEngine();
  assert.equal(auto.gpu.profile, process.env.OROGEN_GPU_PROFILE || 'core', 'core unless the environment says otherwise');
  if (process.env.OROGEN_GPU_ADAPTER) assert.ok(adapterNamed(auto.gpu.caps.adapter, process.env.OROGEN_GPU_ADAPTER), JSON.stringify(auto.gpu.caps.adapter));
  assert.equal(auto.engine.memory().budgetBytes, 1_073_741_824);
  assert.equal(auto.engine.registry.get('ref/fbm'), fbm, 'the reference nodes are registered');
  assert.equal(auto.engine.registry.get('ref/h-scale'), scale, 'and what useNodes was given');
  assert.ok(auto.engine.registry.get('ref/harness-source') && auto.engine.registry.get('ref/harness-source-color'), 'and the source nodes of the harness');

  assert.equal((await getEngine('auto')).engine, auto.engine, 'the same engine while nothing changes');
  const small = await getEngine('small');
  assert.equal(small.gpu, auto.gpu, 'one GpuContext per process');
  assert.notEqual(small.engine, auto.engine, 'another slicing is another engine');
  await assert.rejects(auto.engine.keys(makeDoc({ nodes: {} })), /disposed/, 'one engine is alive at a time');
  assert.equal((await getEngine('small')).engine, small.engine);
  await assert.rejects(getEngine('tiny' as never), TypeError);
});

test('useNodes: a definition handed over after the engine exists replaces the engine; one type has one definition', async () => {
  const before = await getEngine();
  useNodes([scale, fbm]);
  assert.equal((await getEngine()).engine, before.engine, 'definitions it already holds change nothing');
  // A definition made before the first engine and handed over only now. Definitions are sealed by createEngine.
  useNodes([late]);
  const after = await getEngine();
  assert.notEqual(after.engine, before.engine);
  assert.equal(after.engine.registry.get('ref/h-late'), late);
  assert.throws(() => useNodes([{ ...scale }]), /Two definitions of the node type "ref\/h-scale"/);
  assert.throws(() => useNodes([{ type: 'ref/x' } as never]), TypeError);
});
const late = { ...probe, type: 'ref/h-late', title: 'Late (Reference)' };

// ---- renderNode ----------------------------------------------------------------------------------------------------

test('renderNode: the outputs by port name, at 257, from the default fixtures', async () => {
  const outputs = await renderNode(scale);
  assert.deepEqual(Object.keys(outputs), ['out']);
  assert.deepEqual([outputs.out!.kind, outputs.out!.width, outputs.out!.height, outputs.out!.channels], ['field', 257, 257, 1]);
  expectIdentical(outputs.out!, times(fixtures.terrain(257), 2));
  // A colour input gets the colour fixture, an `any` input the terrain.
  const dimmed = await renderNode(dim, { res: 129 });
  assert.deepEqual([dimmed.out!.kind, dimmed.out!.channels, dimmed.out!.width], ['color', 4, 129]);
  expectClose(channelOf(dimmed.out!, 2), times(fixtures.terrain(129), 0.5), { max: 2e-3 });
  expectStats(dimmed.out!, { min: 1, max: 1 }, 3);
  expectIdentical((await renderNode(either, { res: 129 })).out!, fixtures.terrain(129));
});

test('renderNode: params are merged over the defaults and normalised; an unknown name rejects before anything runs', async () => {
  const src = fixtures.rampX(129);
  expectIdentical((await renderNode(scale, { res: 129, inputs: { in: src }, params: { factor: 3 } })).out!, times(src, 3));
  // Stored with setParam: a value beyond a hard limit is clamped, as one loaded from a document is.
  expectIdentical((await renderNode(scale, { res: 129, inputs: { in: src }, params: { factor: 1e9 } })).out!, times(src, 100));
  await assert.rejects(renderNode(scale, { res: 129, params: { gain: 3 } }), /Scale \(Reference\) has no parameter "gain"/);
});

test('renderNode: inputs are field data of the right size and kind, fixtures by name, or null', async () => {
  const custom = fieldOf(129, (u, v) => u * v);
  expectIdentical((await renderNode(scale, { res: 129, inputs: { in: custom } })).out!, times(custom, 2));
  expectIdentical((await renderNode(scale, { res: 129, inputs: { in: 'cone' } })).out!, times(fixtures.cone(129), 2));
  assert.equal((await renderNode(either, { res: 129, inputs: { in: fixtures.color(129) } })).out!.kind, 'color', 'an `any` input takes either kind');
  const fromGpu = await renderNode(scale, { res: 129, inputs: { in: 'fbm' } });
  expectClose(fromGpu.out!, times(await fixtures.fbm(129), 2), { max: 0 });

  await assert.rejects(renderNode(scale, { res: 129, inputs: { in: fixtures.rampX(257) } }), /The input "in" of ref\/h-scale is 257 x 257; the evaluation is at 129 x 129/);
  await assert.rejects(renderNode(scale, { res: 129, inputs: { in: fixtures.color(129) } }), /takes a field; the data is a color/);
  await assert.rejects(renderNode(dim, { res: 129, inputs: { in: 'terrain' } }), /takes a color; the fixture "terrain" is a field/);
  await assert.rejects(renderNode(scale, { res: 129, inputs: { height: 'terrain' } }), /ref\/h-scale has no input "height"/);
  await assert.rejects(renderNode(scale, { res: 129, inputs: { in: 'granite' as never } }), /not a fixture/);

  // null leaves the input unconnected: a required one is the evaluator's `missing-input`.
  const missing = await rejection(renderNode(scale, { res: 129, inputs: { in: null } }));
  assert.ok(missing instanceof NodeFailure, String(missing));
  assert.deepEqual([missing.message, missing.error.kind, missing.error.nodeId, missing.error.nodeType], ['missing input "in"', 'missing-input', 'node', 'ref/h-scale']);
  assert.deepEqual([missing.report.status, missing.report.nodes.node?.state], ['errors', 'error']);
});

test('renderNode: `mask` connects the mask of a maskable node; `wants` chooses the targets', async () => {
  const src = fixtures.terrain(129);
  expectClose((await renderNode(scale, { res: 129, mask: 'zero' })).out!, src, { max: 1e-6 });
  expectClose((await renderNode(scale, { res: 129, mask: 'one' })).out!, times(src, 2), { max: 1e-6 });
  const half = fieldOf(129, () => 0.5);
  expectClose((await renderNode(scale, { res: 129, mask: half })).out!, times(src, 1.5), { max: 1e-6 });
  await assert.rejects(renderNode(split, { res: 129, mask: 'one' }), /ref\/h-split is not maskable/);
  await assert.rejects(renderNode(scale, { res: 129, mask: fixtures.one(65) }), /The mask of ref\/h-scale is 65 x 65/);

  splitCalls.count = splitCalls.halves = 0;
  const both = await renderNode(split, { res: 129 });
  assert.deepEqual(Object.keys(both), ['out', 'half'], 'every output by default');
  expectIdentical(both.half!, times(src, 0.5));
  const alone = await renderNode(split, { res: 129, wants: ['out'] });
  assert.deepEqual(Object.keys(alone), ['out'], 'only the wanted outputs are returned');
  assert.deepEqual(splitCalls, { count: 2, halves: 1 }, 'ctx.wants() is true exactly for the targets');
  expectIdentical(alone.out!, src);
  await assert.rejects(renderNode(split, { res: 129, wants: ['third'] }), /ref\/h-split has no output "third"/);
});

test('renderNode: settings are merged over the test settings; the resolution is one of engine.md 1.5', async () => {
  const number = async (what: string, res: number, settings?: Parameters<typeof renderNode>[1] & object): Promise<number> => {
    const { out } = await renderNode(probe, { res, params: { what }, ...settings });
    expectStats(out!, { min: at(out!, 0, 0), max: at(out!, 0, 0) });
    return at(out!, 0, 0);
  };
  assert.equal(await number('sea', 129), 0.25);
  assert.equal(await number('sea', 129, { settings: { seaLevel: 0.5 } }), 0.5);
  // With the test settings a cell is 16 m at 257, 8 m at 513 and 32 m at 129.
  assert.deepEqual([await number('cell', 257), await number('cell', 513), await number('cell', 129)], [16, 8, 32]);
  assert.deepEqual([await number('cell', 129, { settings: { terrainSize: 1024 } }), await number('range', 129, { settings: { heightRange: 300 } })], [8, 300]);
  assert.deepEqual([await number('cell', 33), await number('cell', 64)], [128, Math.fround(4096 / 63)], 'any level of a ladder');

  for (const res of [32, 8192, 300.5, 0, 4099]) await assert.rejects(renderNode(probe, { res }), RangeError, `resolution ${res}`);
});

test('renderNode: a failing node rejects with NodeFailure, whose message is that of the first NodeError', async () => {
  await assert.rejects(renderNode(failing, { res: 129, params: { message: 'Reference failure' } }), /Reference failure/);
  const thrown = await rejection(renderNode(failing, { res: 129, params: { message: 'Reference failure' } }));
  assert.ok(thrown instanceof NodeFailure && thrown instanceof Error);
  assert.deepEqual([thrown.name, thrown.message, thrown.error.kind, thrown.error.nodeId], ['NodeFailure', 'Reference failure', 'node-exception', 'node']);
  const node = thrown.report.nodes.node!;
  assert.deepEqual([thrown.report.status, node.state, node.error?.message, node.wallMs, node.peakBytes], ['errors', 'error', 'Reference failure', 0, 0]);
  assert.equal(thrown.report.nodes.src0?.state, 'done', 'the source of the input ran');
  await expectNoLeaks();
  expectIdentical((await renderNode(failing, { res: 129 })).out!, fixtures.terrain(129));
});

test('renderNode: an aborted evaluation rejects with the reason of the signal, and leaves nothing behind', async () => {
  const before = new AbortController();
  before.abort();
  assert.equal(await rejection(renderNode(climb, { res: 129, signal: before.signal })), before.signal.reason);

  // Aborted from onSlice at the first slice of the node, as the `abort` check does it.
  const during = new AbortController();
  const reason = new Error('enough');
  const seen: (string | null)[] = [];
  const thrown = await rejection(renderNode(climb, {
    res: 129, slices: 'small', signal: during.signal,
    onSlice: (slice) => {
      seen.push(slice.nodeId);
      if (slice.nodeId === 'node') during.abort(reason);
    },
  }));
  assert.equal(thrown, reason);
  assert.ok(seen.includes('node') && seen.every((id) => id === 'node' || id === 'src0' || id === null), `slices are named by the ids of the report: ${seen.join(', ')}`);
  await expectNoLeaks();
  expectIdentical((await renderNode(climb, { res: 129, slices: 'small' })).out!, (await renderNode(climb, { res: 129 })).out!);
});

test('renderNode: fieldBudgetBytes is the memory of the fields for one evaluation', async () => {
  // The input and the output of ref/h-scale at 129: two fields. One does not hold both.
  const thrown = await rejection(renderNode(scale, { res: 129, fieldBudgetBytes: FIELD_BYTES(129) }));
  assert.ok(thrown instanceof NodeFailure, String(thrown));
  assert.equal(thrown.error.kind, 'budget');
  assert.match(thrown.message, /GPU memory at 129 × 129/);
  await expectNoLeaks();
  // The budget is restored afterwards, and enough is enough.
  const { engine } = await getEngine();
  assert.equal(engine.memory().budgetBytes, 1_073_741_824);
  expectIdentical((await renderNode(scale, { res: 129, fieldBudgetBytes: 4 * FIELD_BYTES(129) })).out!, times(fixtures.terrain(129), 2));
  assert.equal(engine.memory().budgetBytes, 1_073_741_824);
  await assert.rejects(renderNode(scale, { res: 129, fieldBudgetBytes: -1 }), RangeError);
});

// ---- traceNode -----------------------------------------------------------------------------------------------------

test('traceNode: the report of a build evaluation, with the node under the id "node"', async () => {
  const { outputs, report } = await traceNode(climb, { res: 129, params: { count: 16 } });
  const src = fixtures.terrain(129);
  expectClose(outputs.out!, fieldOf(129, (u, v) => at(src, Math.round(u * 128), Math.round(v * 128)) + 0.25), { max: 1e-6 });
  assert.equal(report.status, 'ok');
  assert.deepEqual(Object.keys(report.nodes).sort(), ['node', 'src0']);
  const node = report.nodes.node!;
  assert.deepEqual([node.nodeId, node.state, node.error, node.skipReason, node.upstream], ['node', 'done', null, null, null]);
  // The node held two fields of its own, the ping-pong pair; its input is not counted (runtime.md 5.10).
  assert.equal(node.peakBytes, 2 * FIELD_BYTES(129));
  assert.ok(node.wallMs > 0 && node.slices >= 1, `${node.wallMs} ms in ${node.slices} slices`);
  // How many batches the rounds make, and so which fractions are reported, follows from measured time: see the trace in one slice below.
  assert.ok(node.progress.length >= 1 && node.progress.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= node.progress[i - 1]!)), `progress ${node.progress.join(', ')}`);
  assert.deepEqual([report.nodesRun, report.nodesCached], [2, 0], 'the source and the node ran; a build reads no cache');
  // The longest slice the device measured (runtime.md 3.5): by wall clock a slice this short may not be resolved,
  // and by the device's timer it may measure nothing. That timer has steps: 65.536 µs on the GTX 1660 Ti, where
  // these 16 passes at 129 measured 0 in two runs of six and one step in the others.
  assert.ok(report.slices >= node.slices && report.longestSliceMs >= 0);
  // How long a slice of many steps measures is the device's to say (testing.md 8.3): 64 passes at 513 measured
  // 0.85 to 0.92 ms there. Whatever it is, the report holds the longest of what the slices reported.
  const heard: number[] = [];
  const long = await traceNode(climb, { res: 513, params: { count: 64 }, onSlice: (slice) => { heard.push(slice.measuredMs); } });
  const longest = Math.max(...heard);
  if ((await getEngine()).gpu.caps.timestampQuery) assert.equal(long.report.longestSliceMs, longest, `the longest of ${long.report.slices} slices`);
  else assert.ok(long.report.longestSliceMs <= longest, 'by wall clock only the slices that were resolved count');

  // The events are those of the evaluation, in order, with the ids of the report.
  assert.deepEqual([report.events[0]!.type, report.events.at(-1)!.type], ['eval-start', 'eval-end']);
  const start = report.events[0]!;
  assert.ok(start.type === 'eval-start' && start.mode === 'build' && start.resolution === 129);
  assert.deepEqual(start.plan.map((entry) => `${entry.nodeId}:${entry.state}`), ['src0:run', 'node:run']);
  assert.deepEqual(report.events.filter((e) => e.type === 'node-done').map((e) => e.nodeId), ['src0', 'node']);
  assert.ok(report.events.every((e) => !('nodeId' in e) || e.nodeId === 'node' || e.nodeId === 'src0'));
});

test('traceNode: slices follow the slicing, and onSlice hears every one; the result does not depend on them', async () => {
  const heard: { nodeId: string | null; kernels: readonly string[]; measuredMs: number }[] = [];
  const small = await traceNode(climb, { res: 129, slices: 'small', onSlice: (slice) => { heard.push(slice); } });
  const one = await traceNode(climb, { res: 129, slices: 'one' });
  expectIdentical(small.outputs.out!, one.outputs.out!);
  assert.deepEqual(one.report.nodes.node!.progress, [1], 'in one slice the loop has one batch boundary, after its last round');
  assert.equal(heard.length, small.report.slices, 'one call per slice of the evaluation');
  assert.equal(heard.filter((slice) => slice.nodeId === 'node').length, small.report.nodes.node!.slices);
  assert.ok(heard.some((slice) => slice.nodeId === 'node' && slice.kernels.includes('ref/h-add')), 'a slice names its kernels');
  assert.ok(heard.every((slice) => slice.measuredMs >= 0 && Object.keys(slice).sort().join() === 'kernels,measuredMs,nodeId'));
  // 129 rows in tiles one workgroup high, 8 iterations: far more slices than one run in one piece needs.
  assert.ok(small.report.nodes.node!.slices > 8 * one.report.nodes.node!.slices, `${small.report.nodes.node!.slices} against ${one.report.nodes.node!.slices}`);
  const longestHeard = Math.max(...heard.map((slice) => slice.measuredMs));
  if ((await getEngine()).gpu.caps.timestampQuery) assert.equal(small.report.longestSliceMs, longestHeard, 'every slice is timed');
  else assert.ok(small.report.longestSliceMs <= longestHeard, 'by wall clock only the slices that were resolved count');

  // What a callback throws does not reach the engine: the call rejects with it once the evaluation has settled.
  const mistake = new Error('an assertion inside onSlice');
  assert.equal(await rejection(traceNode(climb, { res: 129, onSlice: () => { throw mistake; } })), mistake);
  await expectNoLeaks();
  expectIdentical((await renderNode(climb, { res: 129 })).out!, one.outputs.out!);
});

// ---- fixtures.fbm and renderLadder ---------------------------------------------------------------------------------

test('fixtures.fbm is the output of ref/fbm at its defaults, with the given node seed and the test settings', async () => {
  const a = await fixtures.fbm(129);
  expectIdentical(a, (await renderNode(fbm, { res: 129 })).out!);
  expectIdentical(a, await fixtures.fbm(129, 0));
  expectIdentical(a, await fixtures.byName('fbm', 129));
  expectIdentical(await fixtures.fbm(129, 7), (await renderNode(fbm, { res: 129, params: { seed: 7 } })).out!);
  expectStats(a, { min: [-0.05, 0.5], max: [0.5, 1.05], std: [0.05, 0.3] });
});

test('renderLadder renders one node at several levels, from fixtures that exist at each of them', async () => {
  const levels = await renderLadder(scale, { inputs: { in: 'cone' }, params: { factor: 0.5 } });
  assert.deepEqual(Object.keys(levels), ['257', '513'], '257 and 513 by default');
  expectIdentical(levels[513]!.out!, times(fixtures.cone(513), 0.5));
  const chosen = await renderLadder(scale, { resolutions: [33, 65, 129] });
  assert.deepEqual(Object.keys(chosen), ['33', '65', '129']);
  expectIdentical(chosen[65]!.out!, times(fixtures.terrain(65), 2));

  await assert.rejects(renderLadder(scale, { inputs: { in: fixtures.cone(257) } }), /field data; a ladder comparison takes a fixture name/);
  await assert.rejects(renderLadder(scale, { inputs: { in: 'fbm' } }), /"fbm", which is not band-limited/);
  await assert.rejects(renderLadder(scale, { inputs: { in: 'impulse' } }), /"impulse"/);
  await assert.rejects(renderLadder(scale, { mask: fixtures.one(257) }), /the mask is field data/);
  await assert.rejects(renderLadder(scale, { res: 129 } as never), /resolutions/);
});

// ---- leaks, and the engine driven by a test ------------------------------------------------------------------------

test('expectNoLeaks fails while a handle of a result is held, with the MemoryReport in its message', async () => {
  const { engine } = await getEngine('one');
  const doc = makeDoc({ nodes: { noise: { type: 'ref/fbm' } } });
  const id = Object.keys(doc.nodes)[0]!;
  // A request id of the test's own: the harness keeps its sequence ahead of it.
  const result = await engine.evaluate(doc, [{ ref: { node: id, port: 'out' } }], { resolution: 129, mode: 'preview', requestId: 1_000_000, thumbnails: false });
  assert.equal(result.status, 'ok');
  const thrown = await rejection(expectNoLeaks());
  assert.ok(thrown instanceof assert.AssertionError, String(thrown));
  assert.match(thrown.message, new RegExp(`^Leaked textures: pinnedBytes is ${FIELD_BYTES(129)}: a FieldHandle was not released\\. MemoryReport: \\{"budgetBytes":1073741824,`));
  assert.deepEqual(JSON.parse(thrown.message.slice(thrown.message.indexOf('{'))), engine.memory());

  // A harness evaluation on the same engine checks for leaks itself, and reports the handle the test holds.
  await assert.rejects(renderNode(scale, { res: 129, slices: 'one' }), /Leaked textures: pinnedBytes/);
  result.fields[0]!.release();
  await expectNoLeaks();
  // What that preview left in the cache does not count against the build evaluation that follows.
  assert.ok(engine.memory().cacheBytes > 0);
  expectIdentical((await renderNode(scale, { res: 129, slices: 'one' })).out!, times(fixtures.terrain(129), 2));
  assert.equal((await getEngine('one')).engine.memory().cacheBytes, 0);
});

// ---- later stages --------------------------------------------------------------------------------------------------

test('buildGraph and launchApp belong to later stages, and say which', async () => {
  await assert.rejects(buildGraph({ nodes: {} }), /buildGraph belongs to the export stage/);
  await assert.rejects(launchApp(), /launchApp and its AppDriver belong to the application stage/);
  assert.ok(new DeviceLostError('x') instanceof Error);
});
