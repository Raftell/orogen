// tests/nodes/ref/blur.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, channelOf, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode,
  type FieldData,
} from '../../helpers/index.ts';
import def from '../../../src/core/nodes/ref/blur.ts';

conformance(def);

/**
 * The CPU reference: the Gaussian of `sigma` texels in float64. Weights beyond 3 sigma are dropped and the rest
 * renormalised, reads beyond the border take the border texel; rows first, then columns.
 */
function gaussian(src: FieldData, sigma: number): FieldData {
  const n = src.width;
  const taps = Math.floor(3 * sigma);
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
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let i = -taps; i <= taps; i++) sum += weights[Math.abs(i)] * rows[inside(y + i) * n + x];
      data[y * n + x] = sum / total;
    }
  }
  return { ...src, data };
}

/** The texels farther than `margin` from every border. */
function inner(f: FieldData, margin: number): FieldData {
  const size = f.width - 2 * margin;
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = at(f, x + margin, y + margin);
  return { ...f, width: size, height: size, data };
}

const range = (f: FieldData): number => stats(f).max - stats(f).min;
const FIELD_257 = 257 * 257 * 4;   // bytes

test('ref/blur: within the taps of one pass the output is the Gaussian whose standard deviation is the radius', async () => {
  // A radius of 0.02 is 5.12 texels at 257: 15 taps on each side.
  const src = await fixtures.fbm(257);
  const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { radius: 0.02 } });
  expectClose(outputs.out, gaussian(src, 0.02 * 256), { max: 1e-5 });
  assert.equal(report.nodes.node.peakBytes, 2 * FIELD_257, 'the field of the rows and the result');
});

test('ref/blur: a radius too wide for one pass is handed to ops.blur and is the same Gaussian, up to the border', async () => {
  // At 257 a radius of 0.05 is 12.8 texels, which 30 taps do not hold; 0.25 is the end of the slider.
  const src = await fixtures.fbm(257);
  for (const radius of [0.05, 0.1, 0.25]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { radius } });
    const exact = gaussian(src, radius * 256);
    // A triangle, a narrower Gaussian and a B-spline of the same variance stand for the one Gaussian; at the
    // widest radius the three together are a little less of a Gaussian.
    expectClose(outputs.out, exact, { max: (radius < 0.25 ? 3e-3 : 6e-3) * range(src) });
    const margin = Math.ceil(3 * radius * 256);
    if (radius < 0.25) expectClose(inner(outputs.out, margin), inner(exact, margin), { max: 2e-3 * range(src) });
    assert.ok(report.nodes.node.peakBytes < 2 * FIELD_257, `radius ${radius}: the passes ran at 257: the node held ${report.nodes.node.peakBytes} bytes`);
  }
});

test('ref/blur: borders clamp on both paths: a border that differs from what lies inside it is blurred as the Gaussian blurs it', async () => {
  // A ring of 1 around 0: the reads beyond the border all take a texel that differs from its neighbours. A coarse
  // grid that ended at the border would hold that texel mixed with them, and be wrong by a seventh of the range.
  const ring = fieldOf(257, (u, v) => (u === 0 || v === 0 || u === 1 || v === 1 ? 1 : 0));
  for (const [radius, tolerance] of [[0.03, 1e-5], [0.05, 3e-3], [0.1, 3e-3]] as const) {
    const { out } = await renderNode(def, { inputs: { in: ring }, params: { radius } });
    expectClose(out, gaussian(ring, radius * 256), { max: tolerance });
  }
});

test('ref/blur: a blur computed on a coarser grid shows no trace of that grid', async () => {
  // A radius of 0.1 at 257 is computed on a grid of 65: every fourth texel is a vertex of that grid. Brought back by
  // straight lines between its vertices, the surface would bend at those texels and nowhere else.
  const { out } = await renderNode(def, { inputs: { in: await fixtures.fbm(257) }, params: { radius: 0.1 } });
  const bend = [0, 0, 0, 0];   // the squared second difference along x, summed by the place between two coarse vertices
  for (let y = 64; y <= 192; y++) {
    for (let x = 64; x < 192; x++) bend[x % 4] += (at(out, x - 1, y) - 2 * at(out, x, y) + at(out, x + 1, y)) ** 2;
  }
  assert.ok(Math.max(...bend) <= 1.5 * Math.min(...bend), `the surface bends ${Math.max(...bend) / Math.min(...bend)} times as much at one place between two coarse vertices as at another`);
});

test('ref/blur: the response to an impulse is symmetric and as wide as the radius, on both paths', async () => {
  // In one pass at a radius of 0.03, 7.68 texels; through ops.blur at a radius of 0.1, 25.6 texels.
  for (const [radius, tolerance] of [[0.03, 1e-4], [0.1, 3e-3]] as const) {
    const sigma = radius * 256;
    const { out } = await renderNode(def, { inputs: { in: 'impulse' }, params: { radius } });
    let sum = 0, moment = 0, skew = 0;
    for (let y = 0; y < 257; y++) {
      for (let x = 0; x < 257; x++) {
        const v = at(out, x, y);
        sum += v;
        moment += v * (x - 128) ** 2;
        skew = Math.max(skew, Math.abs(v - at(out, y, x)), Math.abs(v - at(out, 256 - x, y)));
      }
    }
    assert.ok(Math.abs(sum - 1) <= 1e-4, `radius ${radius}: the response sums to ${sum}`);
    assert.ok(skew <= 1e-6, `radius ${radius}: the response differs from its transpose or its mirror image by ${skew}`);
    // Cut at 3 sigma and renormalised, the weights of a Gaussian have 0.987 of its standard deviation.
    let weight = 1, spread = 0;
    for (let i = 1; i <= Math.floor(3 * sigma); i++) {
      const w = Math.exp(-(i * i) / (2 * sigma * sigma));
      weight += 2 * w;
      spread += 2 * w * i * i;
    }
    const expected = Math.sqrt(spread / weight), measured = Math.sqrt(moment / sum);
    assert.ok(Math.abs(measured / expected - 1) <= tolerance, `radius ${radius}: the standard deviation of the response is ${measured} texels; that of the Gaussian is ${expected}`);
  }
});

test('ref/blur: a constant stays that constant', async () => {
  const flat = fieldOf(257, () => 0.3);
  // Bit for bit on both paths: every pass and every resampling sums differences from one of its own texels.
  expectIdentical((await renderNode(def, { inputs: { in: flat }, params: { radius: 0.02 } })).out, flat);
  expectIdentical((await renderNode(def, { inputs: { in: flat }, params: { radius: 0.1 } })).out, flat);
});

test('ref/blur: below a quarter of a texel the output is the input itself', async () => {
  // 0.24 texels at 257. The same length is 0.48 texels at 513, where the blur has an effect.
  const src = await fixtures.fbm(257);
  const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { radius: 0.24 / 256 } });
  expectIdentical(outputs.out, src);
  assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  const fine = await fixtures.fbm(513);
  const blurred = await renderNode(def, { res: 513, inputs: { in: fine }, params: { radius: 0.24 / 256 } });
  assert.ok(stats(blurred.out).std < stats(fine).std);
});

test('ref/blur: a color is blurred channel by channel, and an opaque one stays opaque', async () => {
  const color = fixtures.color(257);
  for (const radius of [0.01, 0.05]) {
    const { out } = await renderNode(def, { inputs: { in: color }, params: { radius } });
    assert.equal(out.kind, 'color');
    for (const channel of [0, 1, 2] as const) {
      const alone = await renderNode(def, { inputs: { in: channelOf(color, channel) }, params: { radius } });
      expectClose(channelOf(out, channel), alone.out, { max: 2e-3 });
    }
    expectIdentical(channelOf(out, 3), fixtures.one(257));
  }
});

test('ref/blur: the blur is the same at two levels of the ladder, also where only the finer one needs a coarser grid', async () => {
  // 5.12 texels at 257, in one pass; 10.24 texels at 513, on the grid of 257.
  const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius: 0.02 } });
  expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
});

test('ref/blur: a wide radius on a resolution whose ladder is short', async () => {
  // 255 is a level of the ladder of 8129, which ends at 128: ctx.ladder is [255, 128]. The end of the slider, a
  // radius of 0.25, is 63.5 texels at 255 and still 31.75 at 128, three times what one pass holds.
  const src = fixtures.terrain(255);
  const { out } = await renderNode(def, { res: 255, inputs: { in: src }, params: { radius: 0.25 } });
  // 3 sigma is wider than the field: every texel is within reach of a border.
  expectClose(out, gaussian(src, 0.25 * 254), { max: 6e-3 * range(src) });
});
