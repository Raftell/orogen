// The test hooks as createEngine passes them on (runtime.md 5.14), and who owns a slice (3.1): a node by its
// id, an engine service by its name.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineKernel, defineNode } from '../../../src/core/api.ts';
import type { AnyFieldHandle } from '../../../src/core/runtime.ts';
import { testGpu } from '../gpu/rig.ts';
import { assertUniform, constantNode, gainNode, startEngine, tintNode } from './rig.ts';

const waveKernel = defineKernel({
  name: 'test/wave',
  outputs: { out: 'field' },
  cost: 4,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return sin(uv.x * 9.0) * cos(uv.y * 7.0) + f32(px.y) * 0.125; }',
});
const waveNode = defineNode({
  type: 'ref/wave',
  title: 'Wave (Test)',
  category: 'ref',
  description: 'A field that differs in every row.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [waveKernel],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(waveKernel, { out: { out } });
    ctx.output('out', out);
  },
});

/** What the node read from a texture it got back from the pool without writing it. */
let recycled: number | string = 'not run';
const sloppyNode = defineNode({
  type: 'ref/sloppy',
  title: 'Sloppy (Test)',
  category: 'ref',
  description: 'Reads a field it never wrote.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  async evaluate(ctx) {
    const first = ctx.alloc('field', { size: 17, clear: 5 });
    ctx.release(first);
    const again = ctx.alloc('field', { size: 17 });
    const data = await ctx.read(again);
    recycled = data.every((v) => v === data[0]) ? data[0]! : 'mixed';
    ctx.output('out', ctx.alloc('field', { clear: 0 }));
  },
});

const DEFS = [constantNode, gainNode, tintNode, waveNode, sloppyNode];

test('maxTileRows and sliceTargetMs change how a run is cut, never its result; onSlice names the node and its kernels', async () => {
  const plain = await startEngine(DEFS);
  const doc = plain.doc({ w: { type: 'ref/wave' } });
  const whole = (await plain.run(doc, ['w.out'], { mode: 'build' })).data[0]!;
  const one = plain.slices.filter((s) => s.nodeId === 'w');
  assert.equal(one.length, 1, 'one slice for one small run');
  assert.deepEqual([one[0]!.service, one[0]!.kernels, one[0]!.work], [null, ['test/wave'], 65 * 65 * 4]);
  assert.ok(one[0]!.estimateMs > 0 && one[0]!.measuredMs >= 0);
  await plain.dispose();

  for (const hooks of [{ maxTileRows: 8 }, { sliceTargetMs: 1e-6 }, { maxTileRows: 16, sliceTargetMs: 1e9 }]) {
    const cut = await startEngine(DEFS, { hooks });
    const tiled = (await cut.run(doc, ['w.out'], { mode: 'build' })).data[0]!;
    const a = new Uint32Array(whole.buffer), b = new Uint32Array(tiled.buffer);
    assert.equal(a.findIndex((bits, i) => bits !== b[i]), -1, `${JSON.stringify(hooks)}: bit-identical`);
    const slices = cut.slices.filter((s) => s.nodeId === 'w');
    // One workgroup row per tile and every tile its own slice under the smallest target.
    if (hooks.sliceTargetMs === 1e-6) assert.equal(slices.length, Math.ceil(65 / 8), 'a slice per tile');
    assert.equal(slices.reduce((sum, s) => sum + s.work, 0), 65 * 65 * 4, 'the tiles cover the grid once');
    cut.noLeaks();
    await cut.dispose();
  }
});

test('a slice of an engine service carries the service\'s name and no node id', async () => {
  const t = await startEngine(DEFS);
  const doc = t.doc({
    level: { type: 'ref/constant', params: { value: 0.5 } },
    tint: { type: 'ref/tint' },
    masked: { type: 'ref/gain', inputs: { in: 'tint.out', mask: 'level.out' } },
    off: { type: 'ref/gain', bypass: true },
  });
  const { result } = await t.evaluate(doc, ['masked.out', 'off.out'], { thumbnails: true });
  assert.equal(result.status, 'ok', JSON.stringify(result.errors));
  const [masked, off] = result.fields as [AnyFieldHandle, AnyFieldHandle];
  assertUniform(await t.engine.read(off), 0, 'the constant behind a bypassed node without an input');
  assert.equal(masked.kind, 'field');
  if (masked.kind === 'field') await t.engine.stats(masked);
  masked.release();
  off.release();
  // The thumbnails are read back behind the evaluation: a bounded wait for their slices.
  for (let rounds = 0; rounds < 400 && !t.slices.some((s) => s.service === 'thumbnail'); rounds++) await new Promise((resolve) => setTimeout(resolve, 5));

  const services = new Set(t.slices.filter((s) => s.nodeId === null).map((s) => s.service));
  assert.deepEqual([...services].sort(), ['constant', 'convert', 'mask', 'read', 'stats', 'thumbnail']);
  assert.ok(t.slices.every((s) => (s.nodeId === null) !== (s.service === null)), 'exactly one of the two is not null');
  assert.deepEqual([...new Set(t.slices.filter((s) => s.service === 'convert').flatMap((s) => s.kernels))], ['core/convert#luma']);
  assert.deepEqual([...new Set(t.slices.filter((s) => s.service === 'mask').flatMap((s) => s.kernels))], ['core/mask#field']);
  assert.deepEqual([...new Set(t.slices.filter((s) => s.service === 'stats').flatMap((s) => s.kernels))], ['core/stats']);
  t.noLeaks();
  await t.dispose();
});

test('poisonRecycled: a texture handed out a second time holds -1e30, not what its last owner left', async () => {
  const t = await startEngine(DEFS, { hooks: { poisonRecycled: true } });
  recycled = 'not run';
  const out = await t.run(t.doc({ n: { type: 'ref/sloppy' } }), ['n.out'], { mode: 'build' });
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assert.equal(recycled, Math.fround(-1e30));
  t.noLeaks();
  await t.dispose();
});

test('inFlightLimit 2 needs timestamp queries: createEngine rejects it on a device without them', async (context) => {
  const gpu = await testGpu();
  if (gpu.caps.timestampQuery) {
    const t = await startEngine(DEFS, { hooks: { inFlightLimit: 2 } });
    assertUniform((await t.run(t.doc({ n: { type: 'ref/constant' } }), ['n.out'])).data[0], 0.5, 'two slices in flight');
    await t.dispose();
    context.diagnostic('the device has timestamp-query: the refusal is checked under profile "core"');
    return;
  }
  await assert.rejects(startEngine(DEFS, { hooks: { inFlightLimit: 2 } }), RangeError);
  const one = await startEngine(DEFS, { hooks: { inFlightLimit: 1 } });
  assertUniform((await one.run(one.doc({ n: { type: 'ref/constant' } }), ['n.out'])).data[0], 0.5, 'one slice in flight');
  await one.dispose();
});
