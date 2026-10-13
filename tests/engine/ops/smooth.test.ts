// ops.smooth and its three steps ops.scale, ops.fit and ops.restore (engine.md section 5): the Gaussian that
// assumes nothing beyond the border, against a CPU reference on both kinds; planes and paraboloids at the
// border, where ops.blur is off by the slope times the standard deviation; the coarser grid of a wide one; the
// two options; and what the steps return.
//
// Sizes: fields of at most 257 x 257 floats. The CPU references are separable: at most 129 x 129 texels times
// 2 x 61 taps. No list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { FIT_MIN_SIGMA, ops, type Field, type SmoothOptions } from '../../../src/core/api.ts';
import { SMOOTH_MAX_SIGMA } from '../../../src/core/ops/smooth.ts';
import { writeGrey } from '../pictures.ts';
import {
  assertClose, assertIdentical, channel, fitReference, grid, hills, rangeOf, sampled, smoothReference, startOps, upload, worstOf,
} from './rig.ts';

const rig = await startOps();
after(() => rig.dispose());

/** GPU float32 against the float64 reference, on any adapter (testing.md 3.4). */
const TOLERANCE = 1e-5;
/** A plane smoothed is that plane up to the rounding of float32 sums of heights below 1: measured 9e-8 at the most. */
const PLANE_TOLERANCE = 2e-6;

type Kind = 'field' | 'color';

/** One smoothing of uploaded data on an n x n field, read back. `sigma` is in texels of that field. */
async function smoothed(data: Float32Array, n: number, sigma: number, kind: Kind = 'field', opts: SmoothOptions = {}, res = 65): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, kind, n, data);
    const result = ops.smooth(ctx, src, sigma / (n - 1), opts);
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], [kind, n, n, false]);
    assert.notEqual(result.id, src.id, 'the result is a new field');
    out = await ctx.read(result);
  }, { res });
  return out!;
}

async function blurred(data: Float32Array, n: number, sigma: number): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => { out = await ctx.read(ops.blur(ctx, upload(ctx, 'field', n, data), sigma / (n - 1))); });
  return out!;
}

/** z = 0.2 + 0.5 u + 0.25 v: ground that slopes towards two borders and away from the two others. */
const plane = (n: number): Float32Array => grid(n, n, (x, y) => 0.2 + (0.5 * x + 0.25 * y) / (n - 1));

/** The largest difference among the texels farther than `margin` from every border. */
function worstInside(a: ArrayLike<number>, b: ArrayLike<number>, n: number, margin: number): number {
  let worst = 0;
  for (let y = margin; y < n - margin; y++) for (let x = margin; x < n - margin; x++) worst = Math.max(worst, Math.abs(a[y * n + x]! - b[y * n + x]!));
  return worst;
}

/** The line through every sample of the field, weighted by a Gaussian that is not cut short: what a wide smoothing approximates on a coarser grid. */
function uncut(data: ArrayLike<number>, n: number, sigma: number): Float64Array {
  const pass = (src: ArrayLike<number>, axis: 0 | 1): Float64Array => {
    const out = new Float64Array(n * n);
    for (let across = 0; across < n; across++) {
      for (let at = 0; at < n; at++) {
        let m0 = 0, m1 = 0, m2 = 0, t0 = 0, t1 = 0;
        for (let j = 0; j < n; j++) {
          const x = (j - at) / sigma;
          if (Math.abs(x) > 6) continue;
          const w = Math.exp(-0.5 * x * x);
          const v = src[axis === 0 ? across * n + j : j * n + across]!;
          m0 += w; m1 += w * x; m2 += w * x * x; t0 += w * v; t1 += w * x * v;
        }
        out[axis === 0 ? across * n + at : at * n + across] = (m2 * t0 - m1 * t1) / (m0 * m2 - m1 * m1);
      }
    }
    return out;
  };
  return pass(pass(data, 0), 1);
}

test('the line through the samples within 4 sigma, weighted by the Gaussian, against the CPU reference', async () => {
  const n = 65;
  const land = sampled(n, hills);
  for (const sigma of [0.25, 0.4, 1, 2.5, 6, SMOOTH_MAX_SIGMA]) {
    assertClose(await smoothed(land, n, sigma), smoothReference(land, n, 1, sigma), TOLERANCE, `sigma ${sigma} texels`);
  }
  // Inside, where the samples lie alike on both sides, it is the Gaussian: the mean of the samples, by their weights.
  const sigma = 2.5, reach = Math.ceil(4 * sigma);
  const out = await smoothed(land, n, sigma);
  let worst = 0;
  for (let y = reach; y < n - reach; y++) {
    for (let x = reach; x < n - reach; x++) {
      let sum = 0, norm = 0;
      for (let j = -reach; j <= reach; j++) {
        for (let i = -reach; i <= reach; i++) {
          const w = Math.exp(-(i * i + j * j) / (2 * sigma * sigma));
          sum += w * land[(y + j) * n + x + i]!;
          norm += w;
        }
      }
      worst = Math.max(worst, Math.abs(out[y * n + x]! - sum / norm));
    }
  }
  assert.ok(worst <= TOLERANCE, `inside, the Gaussian of the samples: off by ${worst}`);
});

test('a plane stays the plane it is, up to the border and in the corners, at every standard deviation; a blur that clamps does not', async () => {
  const n = 129;
  const source = plane(n);
  // Up to SMOOTH_MAX_SIGMA on the field's own grid, beyond it on a coarser one, down to three vertices a side:
  // the last two are Gaussians of 8 and of 800 terrain widths.
  for (const sigma of [0.5, 1, 6, SMOOTH_MAX_SIGMA, 9, 12, 20, 40, 80, 200, 1000, 1e5]) {
    assertClose(await smoothed(source, n, sigma), source, PLANE_TOLERANCE, `the plane at sigma ${sigma} texels`);
  }
  // ops.blur continues the plane level beyond its border: in the corner the plane slopes towards, it comes out
  // higher by about 0.36 of the slope times sigma along each axis (0.4 for a Gaussian that is not cut at 3 sigma).
  for (const sigma of [2, 6, 12]) {
    const off = (await blurred(source, n, sigma))[0]! - source[0]!;
    const slopes = (0.5 + 0.25) / (n - 1);
    assert.ok(off > 0.3 * slopes * sigma && off < 0.42 * slopes * sigma, `ops.blur at sigma ${sigma}: the corner is off by ${off}, ${off / (slopes * sigma)} of the slopes times sigma`);
  }
});

test('ground that slopes towards the border has no frame once its smoothed surface is taken from it', async () => {
  // What filter/high-pass and filter/sharpen compute: the field less its smoothed surface. On a slope with low
  // hills on it, which runs out of the terrain, the detail along the border is of the size it has inside; with
  // ops.blur it is many times that, by what the blur continues the slope level.
  const n = 129, sigma = 5;
  const tilted = plane(n);
  const land = sampled(n, (u, v) => 0.02 * (hills(u, v) - 0.5)).map((v, i) => v + tilted[i]!);
  const detail = (low: Float32Array): { readonly border: number; readonly inside: number } => {
    let border = 0, inside = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const d = Math.abs(land[y * n + x]! - low[y * n + x]!);
        if (x === 0 || y === 0 || x === n - 1 || y === n - 1) border = Math.max(border, d);
        else if (x > 20 && y > 20 && x < n - 21 && y < n - 21) inside = Math.max(inside, d);
      }
    }
    return { border, inside };
  };
  const fitted = detail(await smoothed(land, n, sigma));
  const clamped = detail(await blurred(land, n, sigma));
  // Measured: 0.0008 on the border against 0.0014 inside, and with ops.blur 0.0122 against 0.0014.
  assert.ok(fitted.border < 1.5 * fitted.inside, `ops.smooth: the detail is ${fitted.border} on the border and ${fitted.inside} inside`);
  assert.ok(clamped.border > 5 * clamped.inside, `ops.blur: the detail is ${clamped.border} on the border and ${clamped.inside} inside`);
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', n, land);
    for (const [name, low] of [['smooth', ops.smooth(ctx, src, sigma / (n - 1))], ['blur', ops.blur(ctx, src, sigma / (n - 1))]] as const) {
      const data = await ctx.read(low);
      await writeGrey(`ops/smooth/detail-${name}`, data.map((v, i) => 0.5 + 8 * (land[i]! - v)), n);
    }
  });
});

test('a paraboloid: ops.fit gives its slope and its bend at every texel, the border included, and its Gaussian inside', async () => {
  // z = a x^2 + b y^2 + c x + d y in texels. The parabola through the samples is the paraboloid itself along
  // each axis, wherever the samples lie: the slope is 2 a x + c and the bend 2 a, on the border as inside.
  const n = 65;
  const [a, b, c, d] = [0.00012, -0.00007, -0.002, 0.003];
  const z = grid(n, n, (x, y) => 0.4 + a * x * x + b * y * y + c * x + d * y);
  for (const sigma of [0.3, FIT_MIN_SIGMA, 2, 6]) {
    const read: Record<string, Float32Array> = {};
    await rig.run(async (ctx) => {
      const src = upload(ctx, 'field', n, z);
      const scale = ops.scale(ctx, src, sigma / (n - 1));
      assert.deepEqual([scale.field.id, scale.owned, scale.ring, scale.full, scale.cell], [src.id, false, false, n, ctx.terrainSize / (n - 1)]);
      const x = ops.fit(ctx, scale, src, 0, { value: true, slope: true, bend: true });
      const y = ops.fit(ctx, scale, src, 1, { slope: true, bend: true });
      assert.equal(y.value, null, 'an output that is not asked for is no field');
      read.xSlope = await ctx.read(x.slope!);
      read.xBend = await ctx.read(x.bend!);
      read.ySlope = await ctx.read(y.slope!);
      read.yBend = await ctx.read(y.bend!);
      read.value = await ctx.read(x.value!);
    });
    // Heights near 0.6 carry 6e-8; a slope fitted over a few texels carries about that, and a bend the same per texel squared.
    assertClose(read.xSlope!, (i) => 2 * a * (i % n) + c, 2e-6, `sigma ${sigma}: the slope along x`);
    assertClose(read.ySlope!, (i) => 2 * b * Math.floor(i / n) + d, 2e-6, `sigma ${sigma}: the slope along y`);
    assertClose(read.xBend!, () => 2 * a, 2e-6, `sigma ${sigma}: the bend along x`);
    assertClose(read.yBend!, () => 2 * b, 2e-6, `sigma ${sigma}: the bend along y`);
    // The derivatives are fitted with a Gaussian of at least FIT_MIN_SIGMA texels: the reference says the same.
    const reference = fitReference(z, n, 1, sigma, 0, { derivative: true });
    assertClose(read.xSlope!, reference.slope, TOLERANCE, `sigma ${sigma}: the slope against the reference`);
    assertClose(read.value!, reference.value, TOLERANCE, `sigma ${sigma}: the value against the reference`);
  }

  // Smoothed, the paraboloid stands above itself by (a + b) times the variance inside: the Gaussian of x^2 is
  // x^2 + sigma^2, less the 0.1 % of the variance beyond 4 sigma. On the border the line through one-sided
  // samples lies within twice that of the paraboloid.
  const sigma = 4;
  const out = await smoothed(z, n, sigma);
  const lift = (a + b) * sigma * sigma;
  let inside = 0, border = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const off = out[y * n + x]! - z[y * n + x]!;
      if (x >= 16 && y >= 16 && x < n - 16 && y < n - 16) inside = Math.max(inside, Math.abs(off - lift));
      else border = Math.max(border, Math.abs(off));
    }
  }
  assert.ok(inside < 0.01 * Math.abs(lift), `inside, the smoothed paraboloid is ${inside} off its lift of ${lift}`);
  assert.ok(border < 2 * (Math.abs(a) + Math.abs(b)) * sigma * sigma, `near the border it is ${border} off the paraboloid`);
});

test('a constant stays that constant bit for bit, and an opaque color stays opaque, on the field\'s own grid and on a coarser one', async () => {
  const n = 129;
  for (const sigma of [1.5, 6, 20, 90]) {
    assertIdentical(await smoothed(grid(n, n, () => 0.7), n, sigma), grid(n, n, () => 0.7), `a constant at sigma ${sigma}`);
    const color = grid(n, n, (x, y) => [x / (n - 1), y / (n - 1), hills(x / (n - 1), y / (n - 1)), 1]);
    const out = await smoothed(color, n, sigma, 'color');
    assertIdentical(channel(out, 4, 3), grid(n, n, () => 1), `alpha at sigma ${sigma}`);
    // Each channel is the field smoothed alone, in the 11 significant bits a color keeps (testing.md 3.4).
    const blue = await smoothed(sampled(n, hills), n, sigma);
    assertClose(channel(out, 4, 2), blue, 2e-3, `the blue channel at sigma ${sigma}`);
    // The ramp of the red channel is a plane: it stays one up to the border.
    assertClose(channel(out, 4, 0), (i) => (i % n) / (n - 1), 2e-3, `the red channel at sigma ${sigma}`);
  }
});

test('below a quarter of a texel the result is a copy, and sigma is a length measured on the field', async () => {
  const n = 33;
  const land = sampled(n, hills);
  for (const sigma of [0, 0.1, 0.249]) assertIdentical(await smoothed(land, n, sigma), land, `sigma ${sigma} texels`);
  // The same length on 33, 129 and 257 texels in an evaluation at 65 is sigma times the field's own cells.
  const length = 0.03125;
  for (const size of [33, 129]) {
    const source = sampled(size, hills);
    let out: Float32Array | null = null;
    await rig.run(async (ctx) => {
      assert.equal(ctx.res, 65);
      out = await ctx.read(ops.smooth(ctx, upload(ctx, 'field', size, source), length));
    });
    assertClose(out!, smoothReference(source, size, 1, length * (size - 1)), TOLERANCE, `a length of ${length} on ${size} texels`);
  }
});

test('a wide Gaussian runs on a coarser grid: inside it is the Gaussian within 0.2 % of the range, and two ladder levels agree', async () => {
  const n = 129;
  const land = sampled(n, hills);
  const range = rangeOf(land);
  const span = range.max - range.min;
  for (const sigma of [9, 12, 20, 40]) {
    assert.ok(sigma > SMOOTH_MAX_SIGMA);
    const out = await smoothed(land, n, sigma);
    const ideal = uncut(land, n, sigma);
    // Measured: 0.0009 to 0.0011 inside, of a range of 0.8. Within 2 sigma of the border the fit has samples on
    // one side only and continues their trend: there a wide one and the same fit on the field's own grid differ
    // by what the terrain bends over a sigma, up to 4 % of the range on these hills, which are no wider than that.
    const inside = worstInside(out, ideal, n, Math.ceil(2 * sigma));
    assert.ok(inside <= 0.002 * span, `sigma ${sigma}: inside, ${inside} off the Gaussian, ${inside / span} of the range`);
    const all = worstOf(out, ideal).difference;
    assert.ok(all <= 0.05 * span, `sigma ${sigma}: at the border, ${all} off the fit on the field's own grid, ${all / span} of the range`);
    assert.equal(rangeOf(out).nonFinite, 0);
  }
  // One surface on two levels of the ladder, one length: at shared vertices the two agree within 0.2 % of the range.
  const length = 12 / 128;
  const fine = await smoothed(sampled(257, hills), 257, length * 256, 'field', {}, 257);
  const coarse = await smoothed(land, n, length * 128);
  let worst = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) worst = Math.max(worst, Math.abs(coarse[y * n + x]! - fine[2 * y * 257 + 2 * x]!));
  assert.ok(worst <= 0.002 * span, `129 against 257 at shared vertices: ${worst}`);
});

test('mean: a quantity that is never below 0 stays so at the border, where the line through the samples does not', async () => {
  // Squares that fall to 0 towards the border x = 0 and are 0 beyond a tenth of the terrain from it: the line
  // through the samples near that border continues their fall below 0.
  const n = 65;
  const squares = grid(n, n, (x) => Math.max(0, (x - 6) / (n - 1)) ** 2);
  for (const sigma of [3, 6, 14]) {
    const line = rangeOf(await smoothed(squares, n, sigma));
    const mean = rangeOf(await smoothed(squares, n, sigma, 'field', { mean: true }));
    assert.ok(line.min < -1e-6, `sigma ${sigma}: the line goes down to ${line.min}`);
    assert.ok(mean.min >= 0, `sigma ${sigma}: the mean stays at ${mean.min} and above`);
  }
  assertClose(await smoothed(squares, n, 3, 'field', { mean: true }), smoothReference(squares, n, 1, 3, { mean: true }), TOLERANCE, 'the mean of the samples against the reference');
  // The mean of the samples of a plane is not the plane at the border: it is what the option gives up.
  const tilted = plane(n);
  const off = worstOf(await smoothed(tilted, n, 6, 'field', { mean: true }), tilted).difference;
  assert.ok(off > 0.01, `the mean of a plane is ${off} off it at the border`);
});

test('skip: the samples that close to the border are left out, and the texels there are filled from those inside', async () => {
  const n = 65;
  const land = sampled(n, hills);
  // The same hills with a band of four texels along every border that holds something else altogether.
  const spoiled = grid(n, n, (x, y) => (Math.min(x, y, n - 1 - x, n - 1 - y) < 4 ? 5 : land[y * n + x]!));
  const sigma = 3, skip = 4.5;
  const clean = await smoothed(land, n, sigma, 'field', { skip: skip / (n - 1) });
  const out = await smoothed(spoiled, n, sigma, 'field', { skip: skip / (n - 1) });
  assertIdentical(out, clean, 'what lies in the band that is left out does not reach the result');
  assertClose(out, smoothReference(land, n, 1, sigma, { skip }), TOLERANCE, 'against the reference');
  assert.ok(rangeOf(out).max < 1, 'nothing of the band is left');
  // Without the option the band is smoothed into the hills.
  assert.ok(rangeOf(await smoothed(spoiled, n, sigma)).max > 3);
  // Too large a skip still leaves a sample: the middle of the field.
  assert.equal(rangeOf(await smoothed(land, n, sigma, 'field', { skip: 2 })).nonFinite, 0);
});

test('ops.scale, ops.fit and ops.restore are the steps of ops.smooth, on the field\'s own grid and on a coarser one', async () => {
  const n = 129;
  const land = sampled(n, hills);
  for (const sigma of [3, 20]) {
    const read: Record<string, Float32Array> = {};
    await rig.run(async (ctx) => {
      const src = upload(ctx, 'field', n, land);
      const scale = ops.scale(ctx, src, sigma / (n - 1));
      if (sigma <= SMOOTH_MAX_SIGMA) {
        assert.deepEqual([scale.field.id, scale.owned, scale.ring, scale.sigma], [src.id, false, false, sigma]);
      } else {
        // Four times coarser, with a ring of one texel around its 33 vertices; the Gaussian left to apply fits one pass.
        assert.deepEqual([scale.field.width, scale.owned, scale.ring, scale.cell], [35, true, true, (ctx.terrainSize / (n - 1)) * 4]);
        assert.ok(scale.sigma > 0 && scale.sigma <= SMOOTH_MAX_SIGMA, `the sigma on the coarser grid is ${scale.sigma}`);
      }
      assert.equal(scale.full, n);
      const rows = ops.fit(ctx, scale, scale.field, 0, { value: true }).value!;
      const both = ops.fit(ctx, scale, rows, 1, { value: true }).value!;
      const full: Field<'field'> = ops.restore(ctx, scale, both);
      assert.equal(full.id === both.id, sigma <= SMOOTH_MAX_SIGMA, 'on the field\'s own grid the field itself comes back');
      assert.deepEqual([full.width, full.height], [n, n]);
      read.steps = await ctx.read(full);
      read.smooth = await ctx.read(ops.smooth(ctx, src, sigma / (n - 1)));
    });
    assertIdentical(read.steps!, read.smooth!, `sigma ${sigma}: the three steps against ops.smooth`);
  }
});

test('what is not a square field or a color, or no length, is refused before anything is allocated', async () => {
  const wrong = async (run: Parameters<typeof rig.fail>[0], kind: string, message: RegExp): Promise<void> => {
    const error = await rig.fail(run);
    assert.equal(error.kind, kind, error.message);
    assert.match(error.message, message);
  };
  for (const sigma of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    await wrong((ctx) => { ops.smooth(ctx, ctx.alloc('field', { size: 9 }), sigma); }, 'binding', /ops\.smooth: sigma is .*; it is a length of at least 0/);
  }
  await wrong((ctx) => { ops.scale(ctx, ctx.alloc('field', { size: 9 }), 0.1, { skip: -1 }); }, 'binding', /ops\.scale: skip is -1; it is a length of at least 0/);
  await wrong((ctx) => { ops.smooth(ctx, ctx.alloc('vec2', { size: 9 }) as never, 0.1); }, 'binding', /ops\.smooth: the source is field #\d+ of kind "vec2"; it must be a "field" or a "color"/);
  await wrong((ctx) => { ops.smooth(ctx, ctx.alloc('field', { size: [9, 5] }), 0.1); }, 'binding', /ops\.smooth: the source is field #\d+, which is 9x5/);
  await wrong((ctx) => {
    const src = ctx.alloc('field', { size: 9, clear: 0 });
    ops.fit(ctx, ops.scale(ctx, src, 0.1), src, 0, {});
  }, 'binding', /ops\.fit: nothing is wanted/);
});
