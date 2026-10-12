// ops.minMax and ops.remap (engine.md section 5): the extremes of known fields on the GPU, the result bound to a
// kernel as a constant, and the remap formula with its three options.
//
// Sizes: fields of at most 257 x 257 floats. No list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, FieldAccessError, ops, type Field } from '../../../src/core/api.ts';
import { assertClose, assertIdentical, grid, rangeOf, speckle, startOps, upload } from './rig.ts';

// Reads a minMax result as the constant it is: every texel of the output is max - min.
const spread = defineKernel({
  name: 'test/spread',
  inputs: { range: 'vec2', src: 'field' },
  outputs: { out: 'field' },
  cost: 2,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { let r = range_at(px); return r.y - r.x + 0.0 * src_at(px); }',
});

const rig = await startOps({ kernels: [spread] });
after(() => rig.dispose());

/** The (min, max) the GPU finds in uploaded data of the given size. */
async function extremes(data: Float32Array, size: number | readonly [number, number]): Promise<readonly [number, number]> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const result = ops.minMax(ctx, upload(ctx, 'field', size, data));
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], ['vec2', 1, 1, false]);
    out = await ctx.read(result);
  });
  assert.equal(out!.length, 2);
  return [out![0]!, out![1]!];
}

test('minMax finds the extremes of a known field wherever they are, at any size', async () => {
  // Speckle in -0.5..1.5 with one texel below and one above it, placed where a block scheme would lose them.
  for (const n of [1, 5, 8, 9, 65, 100, 257]) {
    const spots: readonly (readonly [number, number])[] = [[0, 0], [n - 1, n - 1], [n - 1, 0], [Math.floor(n / 2), n - 1], [Math.min(7, n - 1), Math.min(8, n - 1)]];
    for (let k = 0; k < spots.length; k++) {
      const low = spots[k]!, high = spots[(k + 2) % spots.length]!;
      const data = grid(n, n, (x, y) => 2 * speckle(x, y, n) - 0.5);
      data[high[1] * n + high[0]] = 7.25;
      data[low[1] * n + low[0]] = -3.5;   // on a 1 x 1 field both spots are the one texel
      const expected = rangeOf(data);
      assert.deepEqual(await extremes(data, n), [expected.min, expected.max], `${n} x ${n}, minimum at ${low}, maximum at ${high}`);
    }
  }
});

test('minMax of a field that is not square, and of a constant', async () => {
  for (const [w, h] of [[80, 48], [3, 70], [129, 1]] as const) {
    const data = grid(w, h, (x, y) => speckle(x, y, w));
    data[(h - 1) * w + (w - 1)] = 5;
    data[(h - 1) * w] = -5;
    assert.deepEqual(await extremes(data, [w, h]), [-5, 5], `${w} x ${h}`);
  }
  assert.deepEqual(await extremes(grid(65, 65, () => 0.375), 65), [0.375, 0.375]);
  assert.deepEqual(await extremes(grid(65, 65, () => -2), 65), [-2, -2]);
});

test('minMax is over the finite texels; a field without one gives (0, 0)', async () => {
  const n = 65;
  const data = grid(n, n, (x, y) => 0.25 + 0.5 * speckle(x, y));
  const expected = rangeOf(data);
  for (const [x, y, v] of [[0, 0, NaN], [64, 64, Infinity], [10, 33, -Infinity], [63, 1, NaN]] as const) data[y * n + x] = v;
  assert.deepEqual(await extremes(data, n), [expected.min, expected.max]);
  assert.deepEqual(await extremes(grid(n, n, () => NaN), n), [0, 0]);
  assert.deepEqual(await extremes(grid(n, n, (x) => (x % 2 === 0 ? Infinity : -Infinity)), n), [0, 0]);
  // One finite texel in a field of infinities, in the last block of the last pass.
  const lone = grid(n, n, () => Infinity);
  lone[64 * n + 64] = -0.75;
  assert.deepEqual(await extremes(lone, n), [-0.75, -0.75]);
});

test('minMax is synchronous and stays on the GPU: its result is bound to a kernel as a constant, also inside a loop body', async () => {
  const n = 65;
  const data = grid(n, n, (x, y) => 3 * speckle(x, y, 4) - 1);
  const expected = rangeOf(data);
  let out: Float32Array | null = null, looped: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', n, data);
    const range = ops.minMax(ctx, src);
    const result = ctx.alloc('field', { size: n });
    ctx.run(spread, { in: { range, src }, out: { out: result } });
    out = await ctx.read(result);
    const again = ctx.alloc('field', { size: n });
    await ctx.loop(2, () => {
      const r = ops.minMax(ctx, src);
      ctx.run(spread, { in: { range: r, src }, out: { out: again } });
      ctx.release(r);
    });
    looped = await ctx.read(again);
  });
  assertIdentical(out!, grid(n, n, () => Math.fround(expected.max - expected.min)), 'max - min on every texel');
  assertIdentical(looped!, out!, 'the same inside a loop body');
});

test('no pass of minMax reads more than 64 texels per written texel', async () => {
  rig.t.slices.length = 0;
  await extremes(grid(257, 257, (x, y) => speckle(x, y)), 257);
  const mine = rig.t.slices.filter((s) => s.kernels.some((k) => k.startsWith('ops/min-max')));
  assert.deepEqual([...new Set(mine.flatMap((s) => s.kernels))].sort(), ['ops/min-max.first', 'ops/min-max.next']);
  // 257 texels a side: 33 x 33 blocks, then 5 x 5, then 1.
  assert.equal(mine.reduce((sum, s) => sum + s.work, 0), (33 * 33 + 5 * 5 + 1) * 64);
});

/** One remap of uploaded data, read back. */
async function remapped(data: Float32Array, n: number, opts: Parameters<typeof ops.remap>[2]): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', n, data);
    const result = ops.remap(ctx, src, opts);
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], ['field', n, n, false]);
    out = await ctx.read(result);
  });
  return out!;
}

test('remap is to[0] + (v - from[0]) / (from[1] - from[0]) * (to[1] - to[0]); to defaults to 0..1', async () => {
  const n = 33;   // another size than the evaluation's 65
  const data = grid(n, n, (x, y) => 4 * speckle(x, y, 2) - 1);
  const formula = (from: readonly [number, number], to: readonly [number, number]) => (i: number): number =>
    to[0] + ((data[i]! - from[0]) / (from[1] - from[0])) * (to[1] - to[0]);
  assertClose(await remapped(data, n, { from: [-1, 3] }), formula([-1, 3], [0, 1]), 1e-6, 'from -1..3');
  assertClose(await remapped(data, n, { from: [0, 1], to: [10, 20] }), formula([0, 1], [10, 20]), 1e-4, 'to 10..20, extrapolating');
  assertClose(await remapped(data, n, { from: [-1, 3], to: [1, 0] }), formula([-1, 3], [1, 0]), 1e-6, 'an inverted target');
  assertClose(await remapped(data, n, { from: [3, -1], to: [0, 1] }), formula([3, -1], [0, 1]), 1e-6, 'an inverted source');
  // Without clamp the result leaves the target range.
  const open = rangeOf(await remapped(data, n, { from: [0, 1], clamp: false }));
  assert.ok(open.min < -0.5 && open.max > 2, JSON.stringify(open));
});

test('remap with clamp limits the result to the target range exactly; a zero-width source gives to[0]', async () => {
  const n = 65;
  const data = grid(n, n, (x, y) => 4 * speckle(x, y, 2) - 1);
  for (const to of [[0, 1], [0.1, 0.7], [0.7, 0.1], [-2, 5]] as const) {
    const out = await remapped(data, n, { from: [0, 1], to, clamp: true });
    const lo = Math.fround(Math.min(...to)), hi = Math.fround(Math.max(...to));
    const range = rangeOf(out);
    assert.deepEqual([range.min, range.max, range.nonFinite], [lo, hi, 0], `to ${to}: the limits are reached and never passed`);
    assertClose(out, (i) => Math.min(Math.max(to[0] + data[i]! * (to[1] - to[0]), Math.min(...to)), Math.max(...to)), 1e-5, `to ${to}`);
  }
  assertIdentical(await remapped(data, n, { from: [0.5, 0.5], to: [0.25, 9] }), grid(n, n, () => 0.25), 'a source of no width');
  assertIdentical(await remapped(data, n, { from: [0.5, 0.5], to: [0.25, 9], clamp: true }), grid(n, n, () => 0.25), 'a source of no width, clamped');
  // A source of almost no width overflows the result: it is still finite.
  const narrow = rangeOf(await remapped(data, n, { from: [0, 2e-38], to: [0, 4] }));
  assert.equal(narrow.nonFinite, 0);
  assert.ok(narrow.max > 3e38 && narrow.min < -1e38, JSON.stringify(narrow));
});

test('remap from a minMax result brings the field onto the target range, its extremes exactly on the ends', async () => {
  const n = 65;
  const data = grid(n, n, (x, y) => 3 * speckle(x, y, 9) + 5);
  const expected = rangeOf(data);
  let unit: Float32Array | null = null, wide: Float32Array | null = null, flat: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', n, data);
    const range = ops.minMax(ctx, src);
    unit = await ctx.read(ops.remap(ctx, src, { from: range }));
    wide = await ctx.read(ops.remap(ctx, src, { from: range, to: [-1, 1], clamp: true }));
    // The range of a constant has no width.
    const level = ctx.alloc('field', { size: n, clear: 0.6 });
    flat = await ctx.read(ops.remap(ctx, level, { from: ops.minMax(ctx, level), to: [0.5, 1] }));
  });
  const lo = Math.fround(expected.min), hi = Math.fround(expected.max);
  assertClose(unit!, (i) => (data[i]! - lo) / (hi - lo), 1e-6, 'onto 0..1');
  assert.deepEqual([rangeOf(unit!).min, rangeOf(unit!).max], [0, 1]);
  assertClose(wide!, (i) => -1 + ((data[i]! - lo) / (hi - lo)) * 2, 2e-6, 'onto -1..1');
  assert.deepEqual([rangeOf(wide!).min, rangeOf(wide!).max], [-1, 1]);
  assertIdentical(flat!, grid(n, n, () => 0.5), 'a constant goes to to[0]');
});

test('what remap refuses: a range that is no pair of numbers, a range field that is not 1 x 1, a source that is no field', async () => {
  await rig.run((ctx) => {
    const src = ctx.alloc('field', { size: 9, clear: 0 });
    const untyped = ops.remap as (c: typeof ctx, s: Field, o: unknown) => Field;
    assert.throws(() => untyped(ctx, src, { from: [0, NaN] }), (e: Error) => e instanceof TypeError && /"from" is two finite numbers/.test(e.message));
    assert.throws(() => untyped(ctx, src, { from: [0, 1, 2] }), (e: Error) => e instanceof TypeError && /"from" is two finite numbers/.test(e.message));
    assert.throws(() => untyped(ctx, src, {}), (e: Error) => e instanceof TypeError && /"from" is two finite numbers or the result of ops\.minMax/.test(e.message));
    assert.throws(() => untyped(ctx, src, { from: [0, 1], to: [0, Infinity] }), (e: Error) => e instanceof TypeError && /"to" is two finite numbers/.test(e.message));
    const pairs = ctx.alloc('vec2', { size: 9, clear: 0 });
    assert.throws(() => ops.remap(ctx, src, { from: pairs }), (e: Error) => e instanceof FieldAccessError && /which is 9x9; a range is a pair of numbers or the 1x1 result of ops\.minMax/.test(e.message));
    assert.throws(() => untyped(ctx, src, { from: src }), (e: Error) => e instanceof FieldAccessError && /"from" is field #\d+ of kind "field"; it needs 2 channels/.test(e.message));
    const color = ctx.alloc('color', { size: 9, clear: 0 });
    assert.throws(() => untyped(ctx, color, { from: [0, 1] }), (e: Error) => e instanceof FieldAccessError && /the source is field #\d+ of kind "color"/.test(e.message));
    assert.throws(() => untyped(ctx, ctx.alloc('field', { size: [9, 5] }), { from: [0, 1] }), (e: Error) => e instanceof FieldAccessError && /which is 9x5/.test(e.message));
    assert.throws(() => ops.minMax(ctx, color as unknown as Field<'field'>), (e: Error) => e instanceof FieldAccessError && /ops\.minMax: the source is field #\d+ of kind "color"/.test(e.message));
  });
});
