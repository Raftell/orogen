// ops.resample (engine.md section 5): the vertex-centred mapping of 1.1, the four filters against CPU references,
// exactness on the vertex ladder of 1.5, reductions too large for one pass, sources that are not square, both kinds.
//
// Sizes: sources of at most 513 x 513 floats (1 MiB) and results of at most 257 x 257; the CPU references visit
// at most 16 000 result texels with at most 4 096 source texels each. No list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { FieldAccessError, ops, type Field, type ResampleFilter } from '../../../src/core/api.ts';
import { assertClose, assertIdentical, grid, hills, rangeOf, resampleReference, sampled, speckle, startOps, upload, worstOf } from './rig.ts';

const rig = await startOps();
after(() => rig.dispose());

/** Against a float64 reference: float32 sums of up to 64 weighted texels of values in 0..1, on any adapter (testing.md 3.6). */
const TOLERANCE = 1e-5;

/** One resample of uploaded data, read back. */
async function resampled(
  data: Float32Array, source: number | readonly [number, number], size: number, filter?: ResampleFilter, kind: 'field' | 'color' = 'field',
): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, kind, source, data);
    const result = ops.resample(ctx, src, filter === undefined ? { size } : { size, filter });
    assert.equal(result.kind, kind);
    assert.deepEqual([result.width, result.height, result.readOnly], [size, size, false]);
    assert.notEqual(result.id, src.id, 'the result is a new field');
    out = await ctx.read(result);
  });
  return out!;
}

/** The texels of an n x n grid that are not on its border ring. */
function interior(data: ArrayLike<number>, n: number, channels = 1): Float32Array {
  const out = new Float32Array((n - 2) * (n - 2) * channels);
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      for (let c = 0; c < channels; c++) out[((y - 1) * (n - 2) + (x - 1)) * channels + c] = data[(y * n + x) * channels + c]!;
    }
  }
  return out;
}

test("'nearest' down the ladder is the shared vertices themselves, bit for bit", async () => {
  const source = grid(129, 129, (x, y) => speckle(x, y));
  for (const [size, step] of [[65, 2], [33, 4]] as const) {
    const out = await resampled(source, 129, size, 'nearest');
    assertIdentical(out, grid(size, size, (x, y) => source[y * step * 129 + x * step]!), `129 to ${size}`);
  }
});

test("'nearest' off the ladder takes the texel nearest to the mapped position, a tie going to the higher one", async () => {
  const source = grid(50, 50, (x, y) => speckle(x, y, 3));
  for (const size of [129, 23, 99]) {
    const out = await resampled(source, 50, size, 'nearest');
    assertIdentical(out, Float32Array.from(resampleReference(source, 50, 50, 1, size, 'nearest')), `50 to ${size}`);
  }
  // 3 texels onto 5: the mapped positions are 0, 0.5, 1, 1.5, 2.
  const row = await resampled(grid(3, 3, (x) => x), 3, 5, 'nearest');
  assert.deepEqual([...row.subarray(0, 5)], [0, 1, 1, 2, 2]);
});

test("'bilinear' up the ladder: a shared vertex keeps its value bit for bit, a new vertex is the mean of its neighbours", async () => {
  const n = 65, size = 129;
  const source = grid(n, n, (x, y) => speckle(x, y, 11));
  const out = await resampled(source, n, size, 'bilinear');
  const shared = grid(n, n, (x, y) => out[2 * y * size + 2 * x]!);
  assertIdentical(shared, source, 'the even texels of the finer grid');
  assertClose(out, resampleReference(source, n, n, 1, size, 'bilinear'), 1e-6, 'every texel against the bilinear interpolant');
  // Two levels up at once: three new vertices between two shared ones.
  const twice = await resampled(source, n, 257, 'bilinear');
  assertIdentical(grid(n, n, (x, y) => twice[4 * y * 257 + 4 * x]!), source, 'every fourth texel of the grid two levels finer');
});

test("'tent' on an exact 2:1 ladder step has the weights 1-2-1 per axis, with reads clamped at the border", async () => {
  const n = 129, size = 65;
  const source = grid(n, n, (x, y) => speckle(x, y, 5));
  const at = (x: number, y: number): number => source[Math.min(Math.max(y, 0), n - 1) * n + Math.min(Math.max(x, 0), n - 1)]!;
  const expected = grid(size, size, (x, y) => {
    let sum = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += (2 - Math.abs(i)) * (2 - Math.abs(j)) * at(2 * x + i, 2 * y + j);
    return sum / 16;
  });
  const out = await resampled(source, n, size, 'tent');
  assertClose(out, expected, 1e-6, '129 to 65');
  // The weights are renormalised: a constant stays what it is, to the rounding of nine float32 sums.
  const flat = await resampled(grid(n, n, () => 0.3), n, size, 'tent');
  assertClose(flat, () => Math.fround(0.3), 1e-6, 'a constant field');
});

test("'auto' is 'tent' when the result is coarser and 'bilinear' when it is finer", async () => {
  const source = grid(65, 65, (x, y) => speckle(x, y, 9));
  assertIdentical(await resampled(source, 65, 33), await resampled(source, 65, 33, 'tent'), 'shrinking: the default against tent');
  assertIdentical(await resampled(source, 65, 33, 'auto'), await resampled(source, 65, 33, 'tent'), 'shrinking: auto against tent');
  assertIdentical(await resampled(source, 65, 129), await resampled(source, 65, 129, 'bilinear'), 'growing: the default against bilinear');
  assertIdentical(await resampled(source, 65, 100, 'tent'), await resampled(source, 65, 100, 'bilinear'), 'growing: a triangle is never narrower than a source texel');
});

test("'tent' in one pass is the triangle as wide as the reduction, for any ratio up to 4:1", async () => {
  const cases: readonly (readonly [number, number])[] = [[129, 33], [100, 37], [97, 33], [129, 44], [61, 16]];
  for (const [n, size] of cases) {
    const source = grid(n, n, (x, y) => speckle(x, y, n));
    const out = await resampled(source, n, size, 'tent');
    assertClose(out, resampleReference(source, n, n, 1, size, 'tent'), TOLERANCE, `${n} to ${size}`);
  }
});

test('a reduction beyond 4:1 made of whole-number passes, as between ladder levels, is still the one triangle of that width', async () => {
  // 8:1 (4 then 2), 16:1 (4, 2, 2) and 6:1 (3 then 2). The reference applies a single triangle of half-width 8,
  // 16 or 6 source texels with clamped reads: the passes agree with it on the border ring too.
  const cases: readonly (readonly [number, number])[] = [[257, 33], [513, 33], [193, 33]];
  for (const [n, size] of cases) {
    const source = grid(n, n, (x, y) => speckle(x, y, size + n));
    const out = await resampled(source, n, size, 'tent');
    assertClose(out, resampleReference(source, n, n, 1, size, 'tent'), TOLERANCE, `${n} to ${size}`);
  }
});

test('any other reduction goes down the 2:1 grids above the result, and has the width of the one triangle', async () => {
  // 200 to 23 is 9.05:1: a first pass of 2.26:1 onto 89, then 45, then 23.
  const n = 200, size = 23;
  const source = grid(n, n, (x, y) => speckle(x, y, 2));
  const out = await resampled(source, n, size, 'tent');
  const to89 = resampleReference(source, n, n, 1, 89, 'tent', { out: 1 });
  const to45 = resampleReference(to89, 91, 91, 1, 45, 'tent', { src: 1, out: 1 });
  assertClose(out, resampleReference(to45, 47, 47, 1, size, 'tent', { src: 1 }), TOLERANCE, '200 to 23 against the three passes');

  // On a smooth surface the chain and the single wide triangle agree closely.
  const smooth = sampled(n, hills);
  const chain = await resampled(smooth, n, size, 'tent');
  const single = resampleReference(smooth, n, n, 1, size, 'tent');
  const worst = worstOf(chain, single);
  assert.ok(worst.difference < 2e-3, `the chain differs from the one triangle by ${worst.difference}`);
});

test('no pass reads more than 64 texels per written texel', async () => {
  rig.t.slices.length = 0;
  await resampled(grid(257, 257, (x, y) => speckle(x, y)), 257, 33, 'tent');
  const work = rig.t.slices.filter((s) => s.kernels.includes('ops/resample#field'));
  assert.ok(work.length > 0);
  assert.deepEqual([...new Set(work.flatMap((s) => s.kernels))], ['ops/resample#field']);
  // 257 to 65 at 4:1 with 8 x 8 taps, onto a grid with a ring of one texel; then the 2:1 step to 33 with 4 x 4.
  assert.equal(work.reduce((sum, s) => sum + s.work, 0), 67 * 67 * 64 + 33 * 33 * 16);
});

test('a source that is not square is resampled per axis: one axis may shrink while the other grows', async () => {
  const [w, h] = [80, 48];
  const source = grid(w, h, (x, y) => speckle(x, y, 4));
  for (const filter of ['nearest', 'bilinear', 'tent', 'bspline'] as const) {
    const out = await resampled(source, [w, h], 65, filter);
    const reference = resampleReference(source, w, h, 1, 65, filter);
    if (filter === 'nearest') assertIdentical(out, Float32Array.from(reference), `80x48 to 65, ${filter}`);
    else assertClose(out, reference, TOLERANCE, `80x48 to 65, ${filter}`);
  }
  // The corners of the terrain stay where they are: uv (0,0) and (1,1) are the first and the last texel of both.
  const corners = await resampled(source, [w, h], 33, 'bilinear');
  assert.equal(corners[0], source[0]);
  assert.equal(corners[33 * 33 - 1], source[w * h - 1]);
  // 200 x 20 onto 17 is 12.4:1 along x: staged, with y interpolated on the way.
  const strip = sampled(200, hills).subarray(0, 200 * 20);
  const reduced = await resampled(strip, [200, 20], 17);
  const first = resampleReference(strip, 200, 20, 1, 65, 'tent', { out: 1 });
  const second = resampleReference(first, 67, 67, 1, 33, 'tent', { src: 1, out: 1 });
  assertClose(reduced, resampleReference(second, 35, 35, 1, 17, 'tent', { src: 1 }), TOLERANCE, '200x20 to 17 against its three passes');
});

test("'bspline' is the cubic B-spline about the mapped position: smooth, and slightly blurring", async () => {
  const n = 33;
  const source = grid(n, n, (x, y) => speckle(x, y, 6));
  for (const size of [129, 65, 100, 33]) {
    const out = await resampled(source, n, size, 'bspline');
    assertClose(out, resampleReference(source, n, n, 1, size, 'bspline'), TOLERANCE, `33 to ${size}`);
  }
  // At the source's own size it is the 1-4-1 blur per axis, not a copy.
  const same = await resampled(source, n, n, 'bspline');
  const at = (x: number, y: number): number => source[Math.min(Math.max(y, 0), n - 1) * n + Math.min(Math.max(x, 0), n - 1)]!;
  assertClose(same, grid(n, n, (x, y) => {
    let sum = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += (i === 0 ? 4 : 1) * (j === 0 ? 4 : 1) * at(x + i, y + j);
    return sum / 36;
  }), TOLERANCE, 'same size');
  // It reproduces a plane inside the border ring of the source (where no read is clamped).
  const plane = grid(n, n, (x, y) => 0.1 + 0.02 * x - 0.01 * y);
  const fine = await resampled(plane, n, 129, 'bspline');
  const worst = worstOf(grid(121, 121, (x, y) => fine[(y + 4) * 129 + x + 4]!), grid(121, 121, (x, y) => 0.1 + 0.02 * ((x + 4) / 4) - 0.01 * ((y + 4) / 4)));
  assert.ok(worst.difference < TOLERANCE, `a plane is off by ${worst.difference}`);
});

test("'bspline' when shrinking is scaled to the reduction; beyond 2:1 it is the last step after 'tent' passes", async () => {
  const source = grid(129, 129, (x, y) => speckle(x, y, 8));
  assertClose(await resampled(source, 129, 65, 'bspline'), resampleReference(source, 129, 129, 1, 65, 'bspline'), TOLERANCE, '129 to 65 in one pass');
  assertClose(await resampled(source, 129, 87, 'bspline'), resampleReference(source, 129, 129, 1, 87, 'bspline'), TOLERANCE, '129 to 87 in one pass');
  // 129 to 17 is 8:1: 'tent' at 4:1 onto 33, then the B-spline of the 2:1 step.
  const out = await resampled(source, 129, 17, 'bspline');
  const to33 = resampleReference(source, 129, 129, 1, 33, 'tent', { out: 1 });
  assertClose(out, resampleReference(to33, 35, 35, 1, 17, 'bspline', { src: 1 }), TOLERANCE, '129 to 17 against its two passes');
});

test('a color field is resampled per channel', async () => {
  const n = 65;
  // Multiples of 1/256: exact in the 16-bit floats of a color field.
  const source = grid(n, n, (x, y) => [0, 1, 2, 3].map((c) => Math.floor(speckle(x, y, c + 20) * 256) / 256));
  const half = 1 / 1024;   // a result is rounded to the 11 bits of a half float
  assertClose(await resampled(source, n, 33, 'tent', 'color'), resampleReference(source, n, n, 4, 33, 'tent'), half, 'tent, 65 to 33');
  assertClose(await resampled(source, n, 129, 'bilinear', 'color'), resampleReference(source, n, n, 4, 129, 'bilinear'), half, 'bilinear, 65 to 129');
  assertClose(await resampled(source, n, 100, 'bspline', 'color'), resampleReference(source, n, n, 4, 100, 'bspline'), half, 'bspline, 65 to 100');
  assertClose(await resampled(source, n, 9, 'tent', 'color'), (() => {
    const to17 = resampleReference(source, n, n, 4, 17, 'tent', { out: 1 });
    return resampleReference(to17, 19, 19, 4, 9, 'tent', { src: 1 });
  })(), half, 'tent, 65 to 9 in two passes');
  const nearest = await resampled(source, n, 33, 'nearest', 'color');
  assertIdentical(nearest, grid(33, 33, (x, y) => [...source.subarray((2 * y * n + 2 * x) * 4, (2 * y * n + 2 * x) * 4 + 4)]), 'nearest, 65 to 33');
});

test('the source size is a copy, a 1 x 1 source is a constant, and a 1 x 1 result is finite and inside the range', async () => {
  const source = grid(65, 65, (x, y) => speckle(x, y, 13));
  for (const filter of ['auto', 'nearest', 'bilinear', 'tent'] as const) {
    assertIdentical(await resampled(source, 65, 65, filter), source, `65 to 65, ${filter}`);
  }
  for (const filter of ['nearest', 'bilinear', 'tent', 'bspline'] as const) {
    const out = await resampled(Float32Array.of(0.625), 1, 33, filter);
    assertClose(out, () => 0.625, 1e-6, `1 to 33, ${filter}`);
    // A constant stays that constant bit for bit, in one pass and in several: the weights are applied to
    // differences from a source texel, so their sum never divides the value.
    const third = Math.fround(0.3);
    for (const size of [9, 33, 100, 129]) {
      const flat = await resampled(grid(65, 65, () => third), 65, size, filter);
      let changed = 0;
      for (const v of flat) if (v !== third) changed++;
      assert.equal(changed, 0, `a constant, 65 to ${size}, ${filter}: ${changed} of ${flat.length} texels changed`);
    }
  }
  for (const filter of ['nearest', 'bilinear', 'tent', 'bspline'] as const) {
    const out = await resampled(source, 65, 1, filter);
    assert.equal(out.length, 1);
    assert.ok(out[0]! >= 0 && out[0]! <= 1, `65 to 1, ${filter}: ${out[0]}`);
    const flat = await resampled(grid(65, 65, () => 0.25), 65, 1, filter);
    assert.ok(Math.abs(flat[0]! - 0.25) <= 1e-6, `a constant to 1, ${filter}: ${flat[0]}`);
  }
  // uv (0, 0) is the first texel: the nearest and the bilinear value of a 1 x 1 result are that texel, and its
  // 'tent' value is the triangle of the whole reduction, 64:1, about that texel.
  assert.equal((await resampled(source, 65, 1, 'nearest'))[0], source[0]);
  assert.equal((await resampled(source, 65, 1, 'bilinear'))[0], source[0]);
  assertClose(await resampled(source, 65, 1, 'tent'), resampleReference(source, 65, 65, 1, 1, 'tent'), TOLERANCE, '65 to 1, tent');
});

test('down and up the ladder: a surface filtered to the coarser level is close to the surface sampled there', async () => {
  const fine = sampled(257, hills);
  const coarse = await resampled(fine, 257, 129);
  const worst = worstOf(interior(coarse, 129), interior(sampled(129, hills), 129));
  assert.ok(worst.difference < 1e-3, `257 to 129 differs from the surface at 129 by ${worst.difference}`);
  // Up again and back down with 'nearest': the coarse level is recovered exactly.
  let back: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', 129, coarse);
    const up = ops.resample(ctx, src, { size: 257 });
    const down = ops.resample(ctx, up, { size: 129, filter: 'nearest' });
    ctx.release(up);
    back = await ctx.read(down);
  });
  assertIdentical(back!, coarse, 'up with bilinear, down with nearest');
});

test('an input of the node is resampled without being changed, at an evaluation resolution other than both sizes', async () => {
  let before: Float32Array | null = null, after_: Float32Array | null = null, out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const input = ctx.input('in') as Field<'field'>;
    assert.deepEqual([ctx.res, input.width, input.readOnly], [129, 129, true]);
    before = await ctx.read(input);
    const small = ops.resample(ctx, input, { size: 33 });
    out = await ctx.read(small);
    after_ = await ctx.read(input);
  }, { res: 129, sources: { ramp: { type: 'ref/ramp', params: { gainX: 1, gainY: 0.5, base: 0.125 } } }, inputs: { in: 'ramp.out' } });
  assertIdentical(after_!, before!, 'the input after the op');
  // A plane survives a triangle filter inside the border ring.
  const worst = worstOf(interior(out!, 33), interior(grid(33, 33, (x, y) => x / 32 + 0.5 * (y / 32) + 0.125), 33));
  assert.ok(worst.difference < TOLERANCE, `the plane is off by ${worst.difference}`);
});

test('what resample refuses: a size that is no field side, an unknown filter, a field that is neither a field nor a color', async () => {
  await rig.run((ctx) => {
    const src = ctx.alloc('field', { size: 9, clear: 0 });
    for (const size of [0, 8193, 2.5, -1, Number.NaN]) {
      assert.throws(() => ops.resample(ctx, src, { size }), (e: Error) => e instanceof RangeError && /whole number of texels from 1 to 8192/.test(e.message), String(size));
    }
    assert.throws(() => ops.resample(ctx, src, { size: 9, filter: 'cubic' as ResampleFilter }), (e: Error) => e instanceof TypeError && /unknown filter "cubic"/.test(e.message));
    const pair = ctx.alloc('vec2', { size: 9, clear: 0 });
    assert.throws(() => ops.resample(ctx, pair as unknown as Field<'field'>, { size: 5 }), (e: Error) => e instanceof FieldAccessError && /of kind "vec2"; it must be a "field" or a "color"/.test(e.message));
  });
  const error = await rig.fail((ctx) => {
    ops.resample(ctx, ctx.alloc('field', { size: 9 }), { size: 0 });
  });
  assert.equal(error.kind, 'binding');
});
