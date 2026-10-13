// tests/nodes/adjust/combine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, channelOf, colorOf, conformance, expectClose, expectFinite, expectIdentical, fieldOf, fixtures, renderNode, type FieldData, type FixtureName,
} from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/adjust/combine.ts';
import { COLOR_TOL, countValues, half, HUGE_A, HUGE_B, PAIR_A, PAIR_B, WIDE_COLOR, zipValues } from './_reference.ts';

conformance(def);

/** The smoothness the smooth modes are tested with: the band of heights over which the two inputs join. */
const K = 0.5;
/** What a smooth maximum stands above the higher input and a smooth minimum below the lower. */
const seam = (a: number, b: number, k: number): number => (k <= 0 ? 0 : (Math.max(k - Math.abs(a - b), 0) / k) ** 3 * (k / 6));

/** Every mode at full strength, in float64. None clamps: each is defined for every pair of values. */
const MODES: Readonly<Record<string, (a: number, b: number, k: number) => number>> = {
  mix: (_a, b) => b,
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  screen: (a, b) => 1 - (1 - a) * (1 - b),
  overlay: (a, b) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)),
  maximum: (a, b) => Math.max(a, b),
  minimum: (a, b) => Math.min(a, b),
  difference: (a, b) => Math.abs(a - b),
  'smooth-maximum': (a, b, k) => Math.max(a, b) + seam(a, b, k),
  'smooth-minimum': (a, b, k) => Math.min(a, b) - seam(a, b, k),
};

type Input = FieldData | FixtureName | null;
async function combine(a: Input, b: Input, params: Readonly<Record<string, ParamValue>>, mask: Input = null): Promise<FieldData> {
  return (await renderNode(def, { inputs: { a, b, mask }, params: { smoothness: K, ...params } })).out;
}

test('adjust/combine: the modes of the node are the eleven of this test, and it starts as an even mix', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), Object.keys(MODES));
  assert.deepEqual(Object.fromEntries(def.params.map((param) => [param.name, param.default])), { mode: 'mix', strength: 0.5, smoothness: 0.1 });
});

test('adjust/combine: the smoothness is shown for the two smooth modes and for no other', () => {
  const smoothness = def.params.find((param) => param.name === 'smoothness');
  assert.deepEqual(smoothness?.visibleWhen, { param: 'mode', equals: ['smooth-maximum', 'smooth-minimum'] });
  // The modes whose result the smoothness changes are exactly those two.
  const shown = Object.keys(MODES).filter((mode) => MODES[mode]!(0.4, 0.5, 0) !== MODES[mode]!(0.4, 0.5, K));
  assert.deepEqual(shown, ['smooth-maximum', 'smooth-minimum']);
});

for (const [mode, combined] of Object.entries(MODES)) {
  test(`adjust/combine: mode ${mode}: every pair of values from -1 to 2 gives the reference at full strength, and its mean with \`a\` at half`, async () => {
    const full = await combine(PAIR_A, PAIR_B, { mode, strength: 1 });
    expectFinite(full);
    // Products of values up to 2 reach 8, where a float steps by 1e-6.
    expectClose(full, zipValues(PAIR_A, PAIR_B, (a, b) => combined(a, b, K)), { max: 4e-6 });
    expectClose(await combine(PAIR_A, PAIR_B, { mode, strength: 0.5 }), zipValues(PAIR_A, PAIR_B, (a, b) => a + 0.5 * (combined(a, b, K) - a)), { max: 4e-6 });
    // No strength leaves `a`, bit for bit.
    expectIdentical(await combine(PAIR_A, PAIR_B, { mode, strength: 0 }), PAIR_A);
  });
}

test('adjust/combine: every mode gives a float for every pair of heights as large as a float holds', async () => {
  for (const mode of Object.keys(MODES)) {
    for (const strength of [1, 0.5]) expectFinite(await combine(HUGE_A, HUGE_B, { mode, strength }));
  }
  // The modes that select are exact there too, and a smooth one is the hard one wherever the two heights differ:
  // no two of these heights that differ lie within a smoothness of 0.25 of each other.
  const higher = zipValues(HUGE_A, HUGE_B, (a, b) => Math.max(a, b)), lower = zipValues(HUGE_A, HUGE_B, (a, b) => Math.min(a, b));
  expectIdentical(await combine(HUGE_A, HUGE_B, { mode: 'maximum', strength: 1 }), higher);
  expectIdentical(await combine(HUGE_A, HUGE_B, { mode: 'minimum', strength: 1 }), lower);
  const differ = (i: number): boolean => HUGE_A.data[i] !== HUGE_B.data[i];
  const smoothMax = await combine(HUGE_A, HUGE_B, { mode: 'smooth-maximum', strength: 1, smoothness: 0.25 });
  const smoothMin = await combine(HUGE_A, HUGE_B, { mode: 'smooth-minimum', strength: 1, smoothness: 0.25 });
  assert.equal(countValues(smoothMax, (v, i) => differ(i) && v !== higher.data[i]), 0, 'the smooth maximum of two heights far apart is not the higher');
  assert.equal(countValues(smoothMin, (v, i) => differ(i) && v !== lower.data[i]), 0, 'the smooth minimum of two heights far apart is not the lower');
});

test('adjust/combine: the modes that select one of the two inputs pass its bits through', async () => {
  expectIdentical(await combine(PAIR_A, PAIR_B, { mode: 'mix', strength: 1 }), PAIR_B);
  expectIdentical(await combine(PAIR_A, PAIR_B, { mode: 'maximum', strength: 1 }), zipValues(PAIR_A, PAIR_B, (a, b) => Math.max(a, b)));
  expectIdentical(await combine(PAIR_A, PAIR_B, { mode: 'minimum', strength: 1 }), zipValues(PAIR_A, PAIR_B, (a, b) => Math.min(a, b)));
});

test('adjust/combine: overlay is continuous where it changes from multiplying to screening', async () => {
  // At a = 0.5 both halves give b. Across that line the result changes by no more than its slope allows.
  const out = await combine(PAIR_A, PAIR_B, { mode: 'overlay', strength: 1 });
  let jump = 0;
  for (let y = 0; y < 257; y++) for (let x = 120; x < 136; x++) jump = Math.max(jump, Math.abs(at(out, x + 1, y) - at(out, x, y)));
  // d/da of either half is at most 2 * max(|b|, |1 - b|) = 4 for b from -1 to 2, and a rises by 3 / 256 per texel.
  assert.ok(jump <= 4 * (3 / 256) + 1e-5, `overlay steps by ${jump} between two neighbouring texels`);
});

for (const mode of ['smooth-maximum', 'smooth-minimum']) {
  const hard = mode === 'smooth-maximum' ? 'maximum' : 'minimum';
  const sign = mode === 'smooth-maximum' ? 1 : -1;

  test(`adjust/combine: ${mode} is the same whichever input comes first`, async () => {
    const ab = await combine(PAIR_A, PAIR_B, { mode, strength: 1 });
    const ba = await combine(PAIR_B, PAIR_A, { mode, strength: 1 });
    expectIdentical(ab, ba);
  });

  test(`adjust/combine: ${mode} is the ${hard} where the inputs differ by the smoothness or more, and at most a sixth of it beyond the ${hard} elsewhere`, async () => {
    const smooth = await combine(PAIR_A, PAIR_B, { mode, strength: 1 });
    const plain = await combine(PAIR_A, PAIR_B, { mode: hard, strength: 1 });
    assert.equal(countValues(smooth, (v, i) => Math.abs(PAIR_A.data[i] - PAIR_B.data[i]) >= K && v !== plain.data[i]), 0, 'the two differ where the inputs are apart');
    assert.equal(countValues(smooth, (v, i) => sign * (v - plain.data[i]) < 0 || sign * (v - plain.data[i]) > K / 6 + 1e-6), 0, 'the smooth result is on the wrong side or too far');
    // Where the two inputs are equal, on the diagonal of the two ramps, it is a sixth of the smoothness beyond them.
    for (const x of [0, 77, 256]) assert.ok(Math.abs(at(smooth, x, x) - (at(PAIR_A, x, x) + sign * (K / 6))) <= 1e-6);
  });

  test(`adjust/combine: ${mode} has no crease where the two inputs cross, and the ${hard} has one`, async () => {
    // Along a row `a` rises by 3 / 256 per texel and `b` is constant. The slope of the hard result steps from 0 to
    // that rise at the crossing; the smooth one turns over the band, and its slope changes by at most
    // step * step / smoothness from one texel to the next (the cubic seam has a second derivative of 1 / k at most).
    const step = 3 / 256;
    const bend = (f: FieldData): number => {
      let worst = 0;
      for (let y = 0; y < 257; y += 16) for (let x = 1; x < 256; x++) worst = Math.max(worst, Math.abs(at(f, x - 1, y) - 2 * at(f, x, y) + at(f, x + 1, y)));
      return worst;
    };
    const plain = bend(await combine(PAIR_A, PAIR_B, { mode: hard, strength: 1 }));
    const smooth = bend(await combine(PAIR_A, PAIR_B, { mode, strength: 1 }));
    assert.ok(plain > 0.9 * step, `the ${hard} bends by ${plain} at one texel; the step of the input is ${step}`);
    assert.ok(smooth <= 1.02 * (step * step) / K + 1e-6, `${mode} bends by ${smooth} at one texel; the cubic seam bends by ${(step * step) / K} at most`);
  });

  test(`adjust/combine: ${mode} without smoothness is the ${hard}`, async () => {
    expectIdentical(await combine(PAIR_A, PAIR_B, { mode, strength: 1, smoothness: 0 }), await combine(PAIR_A, PAIR_B, { mode: hard, strength: 1 }));
  });
}

test('adjust/combine: the mask scales the strength texel by texel, and is saturated on reading', async () => {
  // The mask fixture is 1 inside a radius of 0.2 and 0 outside 0.35.
  const a = fixtures.terrain(257), b = fixtures.cone(257), mask = fixtures.mask(257);
  expectClose(await combine(a, b, { mode: 'add', strength: 0.8 }, mask), zipValues(a, b, (x, y, i) => x + 0.8 * mask.data[i] * y), { max: 1e-6 });
  // A data field is a legal mask: below 0 it reads 0 and above 1 it reads 1.
  const wild = fieldOf(257, (u) => 4 * u - 1.5);
  expectClose(await combine(a, b, { mode: 'mix', strength: 1 }, wild), zipValues(a, b, (x, y, i) => x + Math.min(1, Math.max(0, wild.data[i])) * (y - x)), { max: 1e-6 });
});

test('adjust/combine: an unconnected mask reads 1, and a mask of 0 leaves `a`', async () => {
  const params = { mode: 'multiply', strength: 0.5 };
  expectIdentical(await combine('terrain', 'cone', params, null), await combine('terrain', 'cone', params, 'one'));
  expectIdentical(await combine('terrain', 'cone', params, 'zero'), fixtures.terrain(257));
});

test('adjust/combine: two colors are combined channel by channel, and the result keeps the alpha of `a`', async () => {
  // The channels of `b` run against those of `a`, and its alpha is another one.
  const b = colorOf(257, (u, v) => [half(2 - 3 * v), half(-1 + 3 * u), half(0.5 + u - v), half(0.75)]);
  for (const mode of Object.keys(MODES)) {
    const out = await combine(WIDE_COLOR, b, { mode, strength: 1 });
    assert.equal(out.kind, 'color');
    // The largest results, of overlay, reach 8, where a half float steps by 1 / 256.
    expectClose(out, zipValues(WIDE_COLOR, b, (x, y) => MODES[mode](x, y, K)), { max: mode === 'overlay' || mode === 'multiply' || mode === 'screen' ? 4 * COLOR_TOL : COLOR_TOL });
    expectIdentical(channelOf(out, 3), channelOf(WIDE_COLOR, 3));
  }
  const masked = await combine(WIDE_COLOR, b, { mode: 'mix', strength: 0.5 }, 'mask');
  const mask = fixtures.mask(257);
  expectClose(masked, zipValues(WIDE_COLOR, b, (x, y, i) => x + 0.5 * mask.data[i] * (y - x)), { max: COLOR_TOL });
  expectIdentical(channelOf(masked, 3), channelOf(WIDE_COLOR, 3));
});

test('adjust/combine: the result has the kind of `a`, and a `b` of the other kind is read as a connection would convert it', async () => {
  const color = colorOf(257, (u, v) => [half(u), half(v), half(1 - u), half(0.5)]);
  const luma = fieldOf(257, (u, v) => 0.2126 * half(u) + 0.7152 * half(v) + 0.0722 * half(1 - u));
  const field = fieldOf(257, (u, v) => half(0.75 * u + 0.25 * v));

  // A color under a terrain is its luminance.
  const onField = await combine(field, color, { mode: 'add', strength: 1 });
  assert.equal(onField.kind, 'field');
  expectClose(onField, zipValues(field, luma, (x, y) => x + y), { max: 1e-6 });

  // A terrain over a color is grey: the same value in red, green and blue.
  const onColor = await combine(color, field, { mode: 'multiply', strength: 1 });
  assert.equal(onColor.kind, 'color');
  for (const channel of [0, 1, 2] as const) {
    expectClose(channelOf(onColor, channel), zipValues(channelOf(color, channel), field, (x, y) => x * y), { max: COLOR_TOL });
  }
  expectIdentical(channelOf(onColor, 3), channelOf(color, 3));
});

test('adjust/combine: at its defaults the node is the mean of its two inputs', async () => {
  const a = fixtures.terrain(257), b = fixtures.cone(257);
  expectClose((await renderNode(def, { inputs: { a, b, mask: null } })).out, zipValues(a, b, (x, y) => (x + y) / 2), { max: 1e-6 });
});
