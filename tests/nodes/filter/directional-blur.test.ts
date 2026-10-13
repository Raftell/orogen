// tests/nodes/filter/directional-blur.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, channelOf, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, traceNode,
  type FieldData,
} from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/directional-blur.ts';
import { clamped, mapField, range } from './_reference.ts';

conformance(def);

const N = 257;

/**
 * The Gaussian of `sigma` texels along the line at `angle`, in float64 and with every tap: one at every texel
 * along the axis the line is nearer to, read between the two texels the line passes there; weights beyond 3 sigma
 * are dropped. Beyond the border the picture continues as its mirror image, and the line runs on into that.
 */
function lineGaussian(src: FieldData, sigma: number, angle: number): FieldData {
  const r = (angle * Math.PI) / 180;
  const dx = Math.cos(r), dy = Math.sin(r);
  const alongX = Math.abs(dx) >= Math.abs(dy);
  const ratio = alongX ? dy / dx : dx / dy;
  const lean = Math.abs(ratio) < 1e-9 ? 0 : ratio;
  const spacing = Math.hypot(1, lean);
  const taps = Math.floor((3 * sigma) / spacing);
  const last = src.width - 1;
  const mirrored = (v: number): number => {
    const period = 2 * last;
    const k = v - period * Math.floor(v / period);
    return k > last ? period - k : k;
  };
  return mapField(src, (x, y) => {
    const major = alongX ? x : y, minor = alongX ? y : x;
    let sum = 0, total = 0;
    for (let i = -taps; i <= taps; i++) {
      const w = Math.exp(-((i * spacing) ** 2) / (2 * sigma * sigma));
      const m = mirrored(major + i);
      const across = mirrored(Math.fround(minor + Math.fround(i * Math.fround(lean))));
      const whole = Math.floor(across), f = across - whole;
      const a = alongX ? clamped(src, m, whole) : clamped(src, whole, m);
      const b = alongX ? clamped(src, m, whole + 1) : clamped(src, whole + 1, m);
      sum += w * (a + f * (b - a));
      total += w;
    }
    return sum / total;
  });
}

const HALF = (Math.atan(0.5) * 180) / Math.PI;      // one texel down for two across
const QUARTER = 360 - (Math.atan(0.25) * 180) / Math.PI;   // one texel up for four across

/** The spread of a response to an impulse along a direction and across it, in texels, and what it sums to. */
function spread(f: FieldData, angle: number): { along: number; across: number; sum: number } {
  const r = (angle * Math.PI) / 180;
  let sum = 0, along = 0, across = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = at(f, x, y);
      const dx = x - 128, dy = y - 128;
      sum += v;
      along += v * (dx * Math.cos(r) + dy * Math.sin(r)) ** 2;
      across += v * (-dx * Math.sin(r) + dy * Math.cos(r)) ** 2;
    }
  }
  return { along: Math.sqrt(along / sum), across: Math.sqrt(across / sum), sum };
}

test('filter/directional-blur: within the taps of one pass the output is the Gaussian along the line, which runs on into the mirror image at the border', async () => {
  // A radius of 0.015 is 3.84 texels at 257. At 0 and 90 degrees the line is a row or a column, at 45 a diagonal.
  const src = await fixtures.fbm(N);
  for (const angle of [0, 90, 180, 45, 135, HALF, 90 + HALF, QUARTER, 30, 200, 290]) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { radius: 0.015, angle } });
    expectClose(out, lineGaussian(src, 0.015 * 256, angle), { max: 2e-5 });
  }
});

test('filter/directional-blur: a wide radius, made of several passes, is the same Gaussian along the line, up to the border', async () => {
  // 12.8, 25.6 and 64 texels at 257: two and three passes, the later ones with their taps 3 to 26 texels apart.
  const src = await fixtures.fbm(N);
  for (const [radius, angle] of [[0.05, 0], [0.1, 0], [0.25, 90], [0.1, 45], [0.1, HALF], [0.1, 60], [0.25, 20]] as const) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { radius, angle } });
    const exact = lineGaussian(src, radius * 256, angle);
    // Along a row or a column the passes are the Gaussian within 0.05 % of the range. Elsewhere each pass reads
    // between two lines, and a later pass finds the mirror image blurred along the line, not along its mirror
    // image, by the passes before it: measured, up to 0.9 % of the range at a border at a radius of 0.1 and
    // 1.4 % at 0.25, and 0.1 % and 0.26 % in the root mean square.
    const axis = angle % 90 === 0;
    expectClose(out, exact, { max: (axis ? 5e-4 : 2e-2) * range(src), rms: (axis ? 2e-4 : 4e-3) * range(src) });
  }
});

test('filter/directional-blur: the border is mirrored, not repeated: a border that differs from what lies inside it', async () => {
  // A column of 1 on the right border of a terrain of 0, blurred along the rows by 12.8 texels in two passes.
  // Mirrored, the column is one texel wide; were the border repeated it would be half of everything, and 0.5 there.
  const edge = fieldOf(N, (u) => (u === 1 ? 1 : 0));
  const { out } = await renderNode(def, { inputs: { in: edge }, params: { radius: 0.05, angle: 0 } });
  expectClose(out, lineGaussian(edge, 0.05 * 256, 0), { max: 2e-3 });
  assert.ok(at(out, 256, 128) < 0.05, `the border texel is ${at(out, 256, 128)}`);
});

test('filter/directional-blur: an impulse is drawn out along the direction and not across it', async () => {
  for (const [radius, angle] of [[0.02, 0], [0.02, 90], [0.03, 45], [0.08, 30], [0.08, 110]] as const) {
    const sigma = radius * 256;
    const { out } = await renderNode(def, { inputs: { in: 'impulse' }, params: { radius, angle } });
    const s = spread(out, angle);
    assert.ok(Math.abs(s.sum - 1) <= 1e-4, `radius ${radius}, angle ${angle}: the response sums to ${s.sum}`);
    // Cut at 3 sigma and renormalised, the weights of a Gaussian have 0.987 of its standard deviation.
    assert.ok(Math.abs(s.along / (0.987 * sigma) - 1) <= 0.03, `radius ${radius}, angle ${angle}: spread along the line ${s.along} texels; the radius is ${sigma}`);
    // Across the line there is only what reading between two texels adds, once per pass: under a texel.
    assert.ok(s.across <= 0.8, `radius ${radius}, angle ${angle}: spread across the line ${s.across} texels`);
  }
});

test('filter/directional-blur: a terrain that does not change along the direction is left alone', async () => {
  // rampY is the same all along x; rampX changes evenly along it, and an even slope has no detail to blur either.
  for (const input of ['rampY', 'rampX'] as const) {
    const { out } = await renderNode(def, { inputs: { in: input }, params: { radius: 0.02, angle: 0 } });
    const ramp = fixtures[input](N);
    for (let x = 16; x <= 240; x += 16) assert.ok(Math.abs(at(out, x, 100) - at(ramp, x, 100)) <= 1e-6);
  }
  const flat = fieldOf(N, () => 0.3);
  expectIdentical((await renderNode(def, { inputs: { in: flat }, params: { radius: 0.1, angle: 33 } })).out, flat);
});

test('filter/directional-blur: below a third of a texel the output is the input itself', async () => {
  const src = await fixtures.fbm(N);
  for (const radius of [0.3 / 256, 0, -0.05]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { radius, angle: 30 } });
    expectIdentical(outputs.out, src);
    assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
});

test('filter/directional-blur: a color is blurred channel by channel, and an opaque one stays opaque', async () => {
  const color = fixtures.color(N);
  for (const radius of [0.015, 0.1]) {
    const { out } = await renderNode(def, { inputs: { in: color }, params: { radius, angle: 30 } });
    assert.equal(out.kind, 'color');
    const blue = await renderNode(def, { inputs: { in: channelOf(color, 2) }, params: { radius, angle: 30 } });
    expectClose(channelOf(out, 2), blue.out, { max: 2e-3 });
    expectIdentical(channelOf(out, 3), fixtures.one(N));
  }
});

test('filter/directional-blur: the blur is the same at two levels of the ladder, with one pass and with several', async () => {
  for (const [radius, angle] of [[0.01, 30], [0.05, 30], [0.15, 75]] as const) {
    const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius, angle } });
    expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
  }
});
