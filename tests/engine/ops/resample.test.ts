// ops.resample (engine.md section 5): the vertex-centred mapping of 1.1, the four filters against CPU references,
// exactness on the vertex ladder of 1.5, reductions too large for one pass, sources that are not square, both kinds.
//
// Sizes: sources of at most 513 x 513 floats (1 MiB) and results of at most 257 x 257; the CPU references visit
// at most 16 000 result texels with at most 4 096 source texels each. No list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { FieldAccessError, ops, type Field, type ResampleFilter } from '../../../src/core/api.ts';
import { BLUR_COARSE_ERROR } from '../../../src/core/ops/blur.ts';
import {
  assertClose, assertIdentical, gaussianReference, grid, hills, rangeOf, resampleReference, sampled, speckle, startOps, upload, worstOf,
} from './rig.ts';

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

test('ring: a result with a ring is the grid continued by one cell past the terrain, and a source with one is read as that grid', async () => {
  const n = 65, size = 33, side = size + 2;
  const source = grid(n, n, (x, y) => speckle(x, y, 21));
  for (const filter of ['tent', 'bilinear', 'nearest', 'bspline'] as const) {
    let ringed: Float32Array | null = null, plain: Float32Array | null = null, up: Float32Array | null = null;
    await rig.run(async (ctx) => {
      const src = upload(ctx, 'field', n, source);
      const coarse = ops.resample(ctx, src, { size, filter, ring: { out: true } });
      assert.deepEqual([coarse.kind, coarse.width, coarse.height, coarse.readOnly], ['field', side, side, false], 'one texel more on every side');
      ringed = await ctx.read(coarse);
      plain = await ctx.read(ops.resample(ctx, src, { size, filter }));
      const fine = ops.resample(ctx, coarse, { size: n, filter: 'bilinear', ring: { src: true } });
      assert.deepEqual([fine.width, fine.height], [n, n], 'the size counts vertices, with a ring on the source too');
      up = await ctx.read(fine);
    });
    // The vertices are those of the grid without a ring, bit for bit; the ring is what the filter gives one cell
    // further out when the source continues with its border texels.
    assertIdentical(grid(size, size, (x, y) => ringed![(y + 1) * side + x + 1]!), plain!, `${filter}: the vertices of the grid with a ring`);
    assertClose(ringed!, resampleReference(source, n, n, 1, size, filter, { out: 1 }), TOLERANCE, `${filter}: every texel, the ring included`);
    assertClose(up!, resampleReference(ringed!, side, side, 1, n, 'bilinear', { src: 1 }), TOLERANCE, `${filter}: back up from the grid with a ring`);
    // Up the ladder from a grid with a ring, a shared vertex is that grid's vertex, not its ring.
    assertIdentical(grid(size, size, (x, y) => up![2 * y * n + 2 * x]!), plain!, `${filter}: the shared vertices after the way back up`);
  }
  // A color field, and a ring on both ends at once: 35 x 35 with a ring onto 19 x 19 with a ring.
  // Multiples of 1/256, which the 16-bit floats of a color field hold exactly; a result is rounded to their 11 bits.
  const tinted = grid(side, side, (x, y) => [...[1, 2, 3].map((c) => Math.floor(speckle(x, y, c) * 256) / 256), 1]);
  let both: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const out = ops.resample(ctx, upload(ctx, 'color', side, tinted), { size: 17, ring: { src: true, out: true } });
    assert.deepEqual([out.kind, out.width], ['color', 19]);
    both = await ctx.read(out);
  });
  assertClose(both!, resampleReference(tinted, side, side, 4, 17, 'tent', { src: 1, out: 1 }), 1 / 1024, 'a color field with a ring on both ends');
});

test('ring: a wide blur a node builds on a coarser grid is right at the border with a ring, and wrong without one', async () => {
  // What ops.blur does for a sigma of 21 texels at 257 (blur.ts): down 4:1 with a triangle, a Gaussian of the
  // variance that is missing there, and back up with the B-spline. Speckle is the hard case for the border.
  const n = 257, sigma = 21, size = 65, ratio = (n - 1) / (size - 1);
  const coarseSigma = Math.sqrt((sigma * sigma) / (ratio * ratio) - 0.5 + 1 / (6 * ratio * ratio));
  const source = grid(n, n, (x, y) => speckle(x, y, 2));
  let withRing: Float32Array | null = null, without: Float32Array | null = null, whole: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', n, source);
    const build = (ring: boolean): Field<'field'> => {
      const small = ops.resample(ctx, src, { size, filter: 'tent', ring: { out: ring } });
      // ops.blur takes a length of the field it blurs: this many texels of `small`.
      const blurred = ops.blur(ctx, small, coarseSigma / (small.width - 1));
      const out = ops.resample(ctx, blurred, { size: n, filter: 'bspline', ring: { src: ring } });
      ctx.release(small);
      ctx.release(blurred);
      return out;
    };
    withRing = await ctx.read(build(true));
    without = await ctx.read(build(false));
    whole = await ctx.read(ops.blur(ctx, src, sigma / (n - 1)));
  }, { res: n });
  assertIdentical(withRing!, whole!, 'the public ring option builds what ops.blur builds');
  const reference = gaussianReference(source, n, 1, sigma);
  const offWith = worstOf(withRing!, reference), offWithout = worstOf(without!, reference);
  assert.ok(offWith.difference <= BLUR_COARSE_ERROR, `with a ring the blur is off by ${offWith.difference} of the range; the bound is ${BLUR_COARSE_ERROR}`);
  // Measured on a GTX 1660 Ti: off by 0.00015 of the range with a ring, by 0.070 without, at a corner texel.
  assert.ok(offWithout.difference > 10 * BLUR_COARSE_ERROR, `without a ring the blur is off by ${offWithout.difference}`);
  const x = offWithout.index % n, y = Math.floor(offWithout.index / n);
  assert.ok(Math.min(x, y, n - 1 - x, n - 1 - y) < 3 * sigma, `the error without a ring is at the border: (${x}, ${y})`);
});

test('what resample refuses: a size that is no field side, an unknown filter, a field that is neither a field nor a color', async () => {
  await rig.run((ctx) => {
    const src = ctx.alloc('field', { size: 9, clear: 0 });
    for (const size of [0, 8193, 2.5, -1, Number.NaN]) {
      assert.throws(() => ops.resample(ctx, src, { size }), (e: Error) => e instanceof RangeError && /whole number of texels from 1 to 8192/.test(e.message), String(size));
    }
    assert.throws(() => ops.resample(ctx, src, { size: 9, filter: 'cubic' as ResampleFilter }), (e: Error) => e instanceof TypeError && /unknown filter "cubic"/.test(e.message));
    // A ring continues a grid by one cell: the grid has at least two vertices a side, and the result fits a field.
    assert.throws(() => ops.resample(ctx, src, { size: 9, ring: true as unknown as { out: boolean } }), (e: Error) => e instanceof TypeError && /ring is \{ src\?: boolean; out\?: boolean \}/.test(e.message));
    assert.throws(() => ops.resample(ctx, src, { size: 9, ring: { out: 1 as unknown as boolean } }), TypeError);
    for (const size of [1, 8191, 8192]) {
      assert.throws(() => ops.resample(ctx, src, { size, ring: { out: true } }), (e: Error) => e instanceof RangeError && /with ring\.out the size is \d+; .* from 2 to 8190/.test(e.message), String(size));
    }
    const tiny = ctx.alloc('field', { size: 3, clear: 0 });
    assert.throws(() => ops.resample(ctx, tiny, { size: 9, ring: { src: true } }), (e: Error) => e instanceof RangeError && /it is 3x3; a grid with a ring has at least 4 texels a side/.test(e.message));
    const pair = ctx.alloc('vec2', { size: 9, clear: 0 });
    assert.throws(() => ops.resample(ctx, pair as unknown as Field<'field'>, { size: 5 }), (e: Error) => e instanceof FieldAccessError && /of kind "vec2"; it must be a "field" or a "color"/.test(e.message));
  });
  const error = await rig.fail((ctx) => {
    ops.resample(ctx, ctx.alloc('field', { size: 9 }), { size: 0 });
  });
  assert.equal(error.kind, 'binding');
});
