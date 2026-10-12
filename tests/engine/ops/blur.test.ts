// ops.blur (engine.md section 5): the Gaussian against a CPU reference on both kinds, sigma as a length on fields
// of any size, the copy below a quarter of a texel, the coarser grid of a wide blur and its error bound, and the
// same blur on two ladder levels.
//
// Sizes: fields of at most 513 x 513 floats (1 MiB). The CPU references are separable: at most 513 x 513 texels
// times 2 x 241 taps. No list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { FieldAccessError, ops, type Field } from '../../../src/core/api.ts';
import { BLUR_COARSE_ERROR, BLUR_DIRECT_MAX_SIGMA } from '../../../src/core/ops/blur.ts';
import { writeGrey, writeHillshade } from '../pictures.ts';
import {
  assertClose, assertIdentical, gaussianReference, grid, hills, rangeOf, sampled, SETTINGS, speckle, startOps, upload, worstOf,
} from './rig.ts';

const rig = await startOps();
after(() => rig.dispose());

/** GPU float32 against the float64 reference, on any adapter (testing.md 3.6). */
const TOLERANCE = 1e-5;

/** One blur of uploaded data on an n x n field, read back. `sigma` is in texels of that field. */
async function blurred(data: Float32Array, n: number, sigma: number, kind: 'field' | 'color' = 'field', res = 65): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, kind, n, data);
    const result = ops.blur(ctx, src, sigma / (n - 1));
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], [kind, n, n, false]);
    assert.notEqual(result.id, src.id, 'the result is a new field');
    out = await ctx.read(result);
  }, { res });
  return out!;
}

/** A field with every scale in it: a step, a block and speckle. */
const edges = (n: number): Float32Array => grid(n, n, (x, y) => {
  const step = x > 0.55 * n ? 1 : 0;
  const block = Math.abs(x - 0.3 * n) < 0.08 * n && Math.abs(y - 0.6 * n) < 0.15 * n ? 0.6 : 0;
  return Math.min(0.25 * step + block + 0.15 * speckle(x, y), 1);
});

test('the Gaussian of sigma texels, with weights beyond 3 sigma dropped and borders clamped, against the CPU reference', async () => {
  const n = 65;
  const source = edges(n);
  for (const sigma of [0.4, 1, 2.5, 5, BLUR_DIRECT_MAX_SIGMA]) {
    const out = await blurred(source, n, sigma);
    assertClose(out, gaussianReference(source, n, 1, sigma), TOLERANCE, `sigma ${sigma} texels`);
  }
});

test('sigma is a length: it is measured on the field that is blurred, whatever the evaluation resolution', async () => {
  // The same length on 33, 129 and 257 texels, in an evaluation at 65.
  const length = 0.0625;
  for (const n of [33, 129, 257]) {
    const source = edges(n);
    let out: Float32Array | null = null;
    await rig.run(async (ctx) => {
      assert.equal(ctx.res, 65);
      out = await ctx.read(ops.blur(ctx, upload(ctx, 'field', n, source), length));
    });
    const sigma = length * (n - 1);
    if (sigma <= BLUR_DIRECT_MAX_SIGMA) assertClose(out!, gaussianReference(source, n, 1, sigma), TOLERANCE, `${n} texels: sigma ${sigma}`);
    else assertClose(out!, gaussianReference(source, n, 1, sigma), BLUR_COARSE_ERROR, `${n} texels: sigma ${sigma}`);
  }
});

test('below a quarter of a texel, and while no neighbour lies within 3 sigma, the blur is a copy in a new field', async () => {
  const n = 65;
  const source = grid(n, n, (x, y) => speckle(x, y, 3));
  for (const sigma of [0, 0.1, 0.249, 0.3]) {
    assertIdentical(await blurred(source, n, sigma), source, `sigma ${sigma} texels`);
  }
  const first = await blurred(source, n, 0.34);
  assert.ok(worstOf(first, source).difference > 1e-3, 'at a third of a texel the nearest neighbours count');
});

test('a color field is blurred per channel', async () => {
  const n = 65;
  // Multiples of 1/256: exact in the 16-bit floats of a color field.
  const source = grid(n, n, (x, y) => [0, 1, 2, 3].map((c) => Math.floor((0.5 * speckle(x, y, c) + (x > 30 + 5 * c ? 0.5 : 0)) * 256) / 256));
  const half = 1 / 1024;   // each pass rounds to the 11 bits of a half float
  for (const sigma of [1.5, 6]) {
    assertClose(await blurred(source, n, sigma, 'color'), gaussianReference(source, n, 4, sigma), half, `sigma ${sigma} texels`);
  }
  // A wide one, through the coarser grid: three stores to half floats on the way.
  const n2 = 129;
  const large = grid(n2, n2, (x, y) => [0, 1, 2, 3].map((c) => Math.floor((0.5 * speckle(x, y, c) + (y > 60 + 5 * c ? 0.5 : 0)) * 256) / 256));
  assertClose(await blurred(large, n2, 13, 'color', n2), gaussianReference(large, n2, 4, 13), BLUR_COARSE_ERROR + 2 * half, 'sigma 13 texels of 129');
});

test('a blur keeps a constant, stays inside the range of its input, and keeps the sum of what is far from the border', async () => {
  const n = 65;
  for (const sigma of [1, 7, 16, 40]) {
    // Bit for bit, on the field's own grid and through a coarser one: every pass sums differences from one of
    // its own texels. So an opaque color stays opaque, whatever the device does with a division.
    const flat = grid(n, n, () => Math.fround(0.3));
    assertIdentical(await blurred(flat, n, sigma), flat, `a constant, sigma ${sigma}`);
    const opaque = await blurred(grid(n, n, (x, y) => [speckle(x, y), 0.5, speckle(x, y, 3), 1]), n, sigma, 'color');
    let translucent = 0;
    for (let i = 3; i < opaque.length; i += 4) if (opaque[i] !== 1) translucent++;
    assert.equal(translucent, 0, `sigma ${sigma}: texels of an opaque color whose alpha is no longer 1`);
    const range = rangeOf(await blurred(edges(n), n, sigma));
    assert.ok(range.nonFinite === 0 && range.min >= -1e-6 && range.max <= 1 + 1e-6, `sigma ${sigma}: ${JSON.stringify(range)}`);
  }
  // One texel of 1 in the middle of 129 x 129: the 3 sigma radius of sigma 4 ends 52 texels before the border.
  const point = grid(129, 129, (x, y) => (x === 64 && y === 64 ? 1 : 0));
  const spread = await blurred(point, 129, 4);
  const sum = spread.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-4, `the sum is ${sum}`);
  assert.ok(Math.abs(spread[64 * 129 + 64]! - spread.reduce((m, v) => Math.max(m, v), 0)) === 0, 'the peak stays where the point was');
});

test('no pass reads more than 64 texels per written texel', async () => {
  rig.t.slices.length = 0;
  await blurred(edges(65), 65, BLUR_DIRECT_MAX_SIGMA);
  const work = rig.t.slices.filter((s) => s.kernels.includes('ops/blur#field')).reduce((sum, s) => sum + s.work, 0);
  // Two passes of 2 * floor(3 sigma) + 1 loads.
  assert.equal(work, 2 * 65 * 65 * (2 * Math.floor(3 * BLUR_DIRECT_MAX_SIGMA) + 1));
  assert.ok(2 * Math.floor(3 * BLUR_DIRECT_MAX_SIGMA) + 1 <= 64);
});

test('a blur wider than one pass allows runs on a coarser grid and stays within its error bound of the Gaussian', async () => {
  const report: string[] = [];
  let worstOfAll = 0;
  for (const [n, sigma] of [[257, 10.05], [257, 14], [257, 21], [257, 45], [129, 100], [513, 30]] as const) {
    // Speckle is the hard case for the border: every texel beyond it repeats one border texel that says nothing about its neighbours.
    for (const [name, source] of [['edges', edges(n)], ['hills', sampled(n, hills)], ['speckle', grid(n, n, (x, y) => speckle(x, y, 2))]] as const) {
      rig.t.slices.length = 0;
      const out = await blurred(source, n, sigma, 'field', n);
      assert.ok(rig.t.slices.some((s) => s.kernels.includes('ops/resample#field')), `${n}, sigma ${sigma}: evaluated through a coarser grid`);
      const range = rangeOf(source);
      const worst = worstOf(out, gaussianReference(source, n, 1, sigma));
      const relative = worst.difference / (range.max - range.min);
      report.push(`${name} ${n} sigma ${sigma}: ${relative.toExponential(2)}`);
      worstOfAll = Math.max(worstOfAll, relative);
      assert.ok(relative <= BLUR_COARSE_ERROR, `${name} at ${n}, sigma ${sigma} texels: off by ${relative} of the range at float ${worst.index}; the bound is ${BLUR_COARSE_ERROR}`);
    }
  }
  // A bound that is far above what is measured hides a regression: it is to calibrate, not to be generous.
  assert.ok(worstOfAll > BLUR_COARSE_ERROR / 10, `the bound ${BLUR_COARSE_ERROR} is more than ten times the measured ${worstOfAll}: ${report.join('; ')}`);
});

/** A surface with features of 0.05 to 0.3 of the terrain: a sigma of 0.02 removes most of the small ones. */
const ridged = (u: number, v: number): number =>
  hills(u, v) + 0.1 * Math.sin(2 * Math.PI * 12 * u) * Math.sin(2 * Math.PI * 9 * v) + 0.05 * Math.sin(2 * Math.PI * (20 * u - 17 * v));

test('the same blur, in world terms, on three ladder levels: the shared vertices agree', async () => {
  // sigma 0.02 of the terrain is 10.24 texels at 513 (evaluated on a coarser grid), 5.12 at 257 and 2.56 at 129 (direct).
  const length = 0.02;
  const levels: Float32Array[] = [];
  for (const n of [513, 257, 129]) {
    let out: Float32Array | null = null;
    await rig.run(async (ctx) => {
      assert.equal(ctx.lengthToPx(length), length * (n - 1));
      out = await ctx.read(ops.blur(ctx, upload(ctx, 'field', n, sampled(n, ridged)), length));
    }, { res: n });
    levels.push(out!);
  }
  const [fine, middle, coarse] = levels as [Float32Array, Float32Array, Float32Array];
  const shared = (data: Float32Array, n: number, step: number): Float32Array => {
    const m = (n - 1) / step + 1;
    return grid(m, m, (x, y) => data[y * step * n + x * step]!);
  };
  /**
   * The surface spans 1.1. The levels differ in where 3 sigma falls between two texels (7 of 7.7, 15 of 15.4, and
   * the coarser grid of the wide blur); measured on a GTX 1660 Ti they agree within 0.00084.
   */
  const LEVEL_TOLERANCE = 2.5e-3;
  const a = worstOf(shared(fine, 513, 2), middle);
  const b = worstOf(shared(middle, 257, 2), coarse);
  const c = worstOf(shared(fine, 513, 4), coarse);
  assert.ok(a.difference <= LEVEL_TOLERANCE, `513 against 257: ${a.difference}`);
  assert.ok(b.difference <= LEVEL_TOLERANCE, `257 against 129: ${b.difference}`);
  assert.ok(c.difference <= LEVEL_TOLERANCE, `513 against 129: ${c.difference}`);
  // The blur did something: it moved the surface by far more than the levels differ.
  const moved = worstOf(middle, sampled(257, ridged)).difference;
  assert.ok(moved > 20 * LEVEL_TOLERANCE, `the blur changed the surface by ${moved}`);
});

test('a blur is a synchronous op: repeated inside a ctx.loop body it is the repeated Gaussian', async () => {
  const n = 65;
  const source = edges(n);
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    let current = upload(ctx, 'field', n, source);
    await ctx.loop(3, () => {
      const next = ops.blur(ctx, current, 2 / (n - 1));
      ctx.release(current);
      current = next;
    });
    out = await ctx.read(current);
  });
  let expected: ArrayLike<number> = source;
  for (let i = 0; i < 3; i++) expected = gaussianReference(Float32Array.from(expected), n, 1, 2);
  assertClose(out!, expected, TOLERANCE, 'three blurs of sigma 2');
});

test('what blur refuses: a sigma that is no length, a field that is not square, a kind that is no image', async () => {
  await rig.run((ctx) => {
    const src = ctx.alloc('field', { size: 9, clear: 0 });
    for (const sigma of [-0.1, Number.NaN, Infinity]) {
      assert.throws(() => ops.blur(ctx, src, sigma), (e: Error) => e instanceof RangeError && /it is a length of at least 0/.test(e.message), String(sigma));
    }
    const wide = ctx.alloc('field', { size: [9, 5], clear: 0 });
    assert.throws(() => ops.blur(ctx, wide, 0.1), (e: Error) => e instanceof FieldAccessError && /which is 9x5; .*ops\.resample/.test(e.message));
    const pair = ctx.alloc('vec2', { size: 9, clear: 0 });
    assert.throws(() => ops.blur(ctx, pair as unknown as Field<'field'>, 0.1), (e: Error) => e instanceof FieldAccessError && /of kind "vec2"/.test(e.message));
  });
});

test('pictures: a terrain, a narrow blur of it and a wide one', async () => {
  const n = 513;
  let terrain: Float32Array | null = null, narrow: Float32Array | null = null, wide: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const input = ctx.input('in') as Field<'field'>;
    terrain = await ctx.read(input);
    narrow = await ctx.read(ops.blur(ctx, input, 0.004));
    wide = await ctx.read(ops.blur(ctx, input, 0.04));
  }, { res: n, sources: { fbm: { type: 'ref/fbm', params: { seed: 5 } } }, inputs: { in: 'fbm.out' } });
  writeHillshade('ops/blur-source-hillshade', terrain!, n, SETTINGS.terrainSize, SETTINGS.heightRange);
  writeHillshade('ops/blur-narrow-hillshade', narrow!, n, SETTINGS.terrainSize, SETTINGS.heightRange);
  writeHillshade('ops/blur-wide-hillshade', wide!, n, SETTINGS.terrainSize, SETTINGS.heightRange);
  writeGrey('ops/blur-wide-grey', wide!, n);
  // A blur removes detail: the largest second difference along a row falls with sigma.
  const roughness = (data: Float32Array): number => {
    let worst = 0;
    for (let y = 0; y < n; y++) for (let x = 1; x < n - 1; x++) worst = Math.max(worst, Math.abs(data[y * n + x - 1]! - 2 * data[y * n + x]! + data[y * n + x + 1]!));
    return worst;
  };
  assert.ok(roughness(narrow!) < 0.5 * roughness(terrain!), `narrow: ${roughness(narrow!)} against ${roughness(terrain!)}`);
  assert.ok(roughness(wide!) < 0.05 * roughness(terrain!), `wide: ${roughness(wide!)} against ${roughness(terrain!)}`);
  const range = rangeOf(wide!);
  assert.ok(range.nonFinite === 0 && range.max - range.min > 0.05, `the wide blur is not flat: ${JSON.stringify(range)}`);
});
