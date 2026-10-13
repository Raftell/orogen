// tests/nodes/select/peaks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectLadder, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/select/peaks.ts';

conformance(def);

const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * The CPU reference of the surroundings: the Gaussian of `sigma` texels in float64, rows then columns. Its taps
 * reach 4 sigma and the weights are renormalised. It clamps at the border, which the node does not: the two
 * are compared away from it.
 */
function gaussian(src: FieldData, sigma: number): Float64Array {
  const n = src.width;
  const taps = Math.ceil(4 * sigma);
  const weights = Array.from({ length: taps + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
  const total = weights.reduce((sum, w, i) => sum + (i === 0 ? w : 2 * w), 0);
  const inside = (i: number): number => Math.min(n - 1, Math.max(0, i));
  const rows = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let i = -taps; i <= taps; i++) sum += weights[Math.abs(i)] * src.data[y * n + inside(x + i)];
      rows[y * n + x] = sum / total;
    }
  }
  const out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let i = -taps; i <= taps; i++) sum += weights[Math.abs(i)] * rows[inside(y + i) * n + x];
      out[y * n + x] = sum / total;
    }
  }
  return out;
}

/** A height above the surroundings that the node counts as none: the rounding of float32 sums on a slope. */
const LEVEL = 2e-6;

/** The largest difference between the mask and the smooth step of the height above the reference surroundings, four radii from the border. */
function worstInside(out: FieldData, src: FieldData, radius: number, feather: number, side: 1 | -1 = 1): number {
  const n = src.width;
  const around = gaussian(src, radius * (n - 1));
  const margin = Math.ceil(4 * radius * (n - 1));
  let worst = 0;
  for (let y = margin; y < n - margin; y++) {
    for (let x = margin; x < n - margin; x++) {
      const above = (src.data[y * n + x] - around[y * n + x]) * side;
      worst = Math.max(worst, Math.abs(at(out, x, y) - ease((above - LEVEL) / feather)));
    }
  }
  return worst;
}

/** A plain at 0.3 with a round hill of the given height and width (the standard deviation of its Gaussian profile) at the centre. */
const hill = (height: number, width: number): FieldData =>
  fieldOf(257, (u, v) => 0.3 + height * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / (2 * width * width)));

test('select/peaks: the mask is the smooth step of the height above the Gaussian mean of the surroundings', async () => {
  // A radius of 0.01 and 0.025 is smoothed in one pass at 257, 2.56 and 6.4 texels; 0.05 and 0.1 on a coarser
  // grid, where a triangle and a B-spline stand for part of the Gaussian and the height above it is off by
  // 0.04 % of the terrain's range.
  for (const src of [await fixtures.fbm(257), fixtures.terrain(257)]) {
    for (const [radius, tolerance] of [[0.01, 1e-5], [0.025, 1e-5], [0.05, 0.015], [0.1, 0.015]] as const) {
      const { out } = await renderNode(def, { inputs: { in: src }, params: { radius } });
      const worst = worstInside(out, src, radius, 0.05);
      assert.ok(worst <= tolerance, `radius ${radius}: the mask differs from the reference by ${worst}; allowed ${tolerance}`);
      assert.ok(stats(out).max > 0.05 && stats(out).min === 0, 'the terrain has tops that are selected and ground that is not');
    }
  }
});

test('select/peaks: a hill on a plain is selected at its top, by the height the Gaussian of the radius leaves it above its surroundings', async () => {
  // A hill 0.1 high with a Gaussian profile of width 0.05. Smoothed over a radius r its top is
  // 0.1 * 0.05^2 / (0.05^2 + r^2) high: with r = 0.03, 0.0735, which leaves the top 0.0265 above its surroundings.
  const above = 0.1 * (1 - 0.05 ** 2 / (0.05 ** 2 + 0.03 ** 2));
  const { out } = await renderNode(def, { inputs: { in: hill(0.1, 0.05) }, params: { radius: 0.03 } });
  assert.ok(Math.abs(at(out, 128, 128) - ease(above / 0.05)) <= 0.005, `the top is ${at(out, 128, 128)}; expected ${ease(above / 0.05)}`);
  // The plain far from the hill, and the foot of the hill, which lies below what surrounds it.
  assert.equal(at(out, 10, 10), 0);
  assert.equal(at(out, 128 + 26, 128), 0, 'two widths from the top the hill is hollow');
  // The mask falls from the top outwards.
  for (let x = 128; x < 150; x++) assert.ok(at(out, x + 1, 128) <= at(out, x, 128), `the mask rises from texel ${x} to ${x + 1}`);
});

test('select/peaks: the radius is the size of the surroundings: a knoll stands out of small ones, a massif only of large ones', async () => {
  // Two hills of the same height 0.1: a knoll 0.01 wide at u = 0.25 and a massif 0.1 wide at u = 0.75.
  const two = fieldOf(257, (u, v) => 0.3
    + 0.1 * Math.exp(-((u - 0.25) ** 2 + (v - 0.5) ** 2) / (2 * 0.01 ** 2))
    + 0.1 * Math.exp(-((u - 0.75) ** 2 + (v - 0.5) ** 2) / (2 * 0.1 ** 2)));
  const near = (await renderNode(def, { inputs: { in: two }, params: { radius: 0.01, feather: 0.05 } })).out;
  assert.ok(at(near, 64, 128) > 0.9, `within a radius of 0.01 the knoll stands ${at(near, 64, 128)}`);
  assert.ok(at(near, 192, 128) < 0.01, `and the massif ${at(near, 192, 128)}`);
  const far = (await renderNode(def, { inputs: { in: two }, params: { radius: 0.1, feather: 0.05 } })).out;
  assert.equal(at(far, 64, 128), 1, 'within a radius of 0.1 the knoll stands out in full');
  assert.ok(at(far, 192, 128) > 0.9, `and the massif ${at(far, 192, 128)}`);
});

test('select/peaks: a slope has no peaks, however steep, up to the border and at any radius', async () => {
  // A blur that clamped at the border would find the upper end of a slope above its surroundings and the lower end below.
  const slope = fieldOf(257, (u, v) => 0.1 + 0.5 * u + 0.3 * v);
  for (const radius of [0.0001, 0.005, 0.03, 0.06, 0.25]) {
    for (const invert of [false, true]) {
      // A feather of 0 selects whatever stands above its surroundings at all.
      const { out } = await renderNode(def, { inputs: { in: slope }, params: { radius, feather: 0, invert } });
      expectStats(out, { min: [0, 0], max: [0, 0] });
    }
  }
  expectStats((await renderNode(def, { inputs: { in: 'one' } })).out, { min: [0, 0], max: [0, 0] });
});

test('select/peaks: a feather of 0 selects everything that stands above its surroundings, in full', async () => {
  const src = fixtures.terrain(257);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { radius: 0.025, feather: 0 } });
  const around = gaussian(src, 0.025 * 256);
  let wrong = 0;
  for (let y = 26; y <= 230; y++) {
    for (let x = 26; x <= 230; x++) {
      const above = src.data[y * 257 + x] - around[y * 257 + x];
      // Ground within a millionth of the height range of its surroundings is level with them, either way.
      if (Math.abs(above) > 1e-5 && at(out, x, y) !== (above > 0 ? 1 : 0)) wrong++;
    }
  }
  assert.equal(wrong, 0, 'texels above their surroundings that are not 1, or below them that are not 0');
});

test('select/peaks: inverted, it selects ground below its surroundings: a pit as it selects the hill', async () => {
  const up = hill(0.1, 0.05);
  const down = hill(-0.1, 0.05);
  const peak = (await renderNode(def, { inputs: { in: up }, params: { radius: 0.03 } })).out;
  const pit = (await renderNode(def, { inputs: { in: down }, params: { radius: 0.03, invert: true } })).out;
  expectClose(pit, peak, { max: 1e-5 });
  // Inverted is not the complement: the hill is no hollow, and neither is the plain around it.
  const hollow = (await renderNode(def, { inputs: { in: up }, params: { radius: 0.03, invert: true } })).out;
  assert.equal(at(hollow, 128, 128), 0, 'the top of the hill, inverted');
  assert.equal(at(hollow, 10, 10), 0, 'the plain, inverted');
  assert.ok(at(hollow, 128 + 26, 128) > 0, 'the foot of the hill lies below its surroundings');
});

test('select/peaks: heights are normalised: the mask does not change with the height range or the terrain size', async () => {
  const base = await renderNode(def, { inputs: { in: 'terrain' } });
  const scaled = await renderNode(def, { inputs: { in: 'terrain' }, settings: { heightRange: 4096, terrainSize: 1024 } });
  expectIdentical(scaled.out, base.out);
});

test('select/peaks: two levels of the ladder agree, whichever of them smooths on a coarser grid', async () => {
  // The default radius of 0.04 is 10.24 texels at 257 and 20.48 at 513: both smooth on a coarser grid.
  const wide = await renderLadder(def, { inputs: { in: 'terrain' } });
  expectLadder(wide[257].out, wide[513].out, { rel: 0.01 });
  // 0.02 is 5.12 texels at 257, in one pass, and 10.24 at 513.
  const mixed = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius: 0.02 } });
  expectLadder(mixed[257].out, mixed[513].out, { rel: 0.01 });
  // Inverted likewise.
  const hollows = await renderLadder(def, { inputs: { in: 'terrain' }, params: { invert: true } });
  expectLadder(hollows[257].out, hollows[513].out, { rel: 0.01 });
});
