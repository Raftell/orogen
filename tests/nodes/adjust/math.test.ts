// tests/nodes/adjust/math.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformance, expectClose, expectFinite, expectIdentical, fieldOf, fixtures, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/adjust/math.ts';
import { countValues, expectRelative, extremes, mapValues, PAIR_A, PAIR_B, WIDE, zipValues } from './_reference.ts';

conformance(def);

/** The remainder with the sign of the divisor; 0 for a divisor of 0. */
const modulo = (v: number, w: number): number => (w === 0 ? 0 : v - w * Math.floor(v / w));

/** Every operation as the node's help states it, in float64. */
const OPERATIONS: Readonly<Record<string, (v: number, w: number) => number>> = {
  add: (v, w) => v + w,
  subtract: (v, w) => v - w,
  multiply: (v, w) => v * w,
  divide: (v, w) => (w === 0 ? 0 : v / w),
  power: (v, w) => (v === 0 ? 0 : Math.sign(v) * Math.abs(v) ** w),
  absolute: (v, w) => Math.abs(v - w),
  minimum: (v, w) => Math.min(v, w),
  maximum: (v, w) => Math.max(v, w),
  modulo,
  fold: (v, w) => Math.abs(w) - Math.abs(modulo(v, 2 * Math.abs(w)) - Math.abs(w)),
};

async function math(mode: string, src: FieldData, operand: FieldData | number): Promise<FieldData> {
  const byField = typeof operand !== 'number';
  return (await renderNode(def, { inputs: { in: src, b: byField ? operand : null }, params: { mode, ...(byField ? {} : { value: operand }) } })).out;
}

test('adjust/math: the operations of the node are the ten of this test', () => {
  const mode = def.params.find((param) => param.name === 'mode');
  assert.ok(mode?.kind === 'enum');
  assert.deepEqual(mode.options.map((option) => option.value), Object.keys(OPERATIONS));
});

for (const [mode, operation] of Object.entries(OPERATIONS)) {
  test(`adjust/math: ${mode}: with a constant, every height from -1 to 2 is the reference's`, async () => {
    // 0.3 is not a number a float holds exactly: the node works with the float nearest to it, and so does the reference.
    for (const value of [0.5, 2, -0.75, 0.3]) {
      const w = Math.fround(value);
      // A sawtooth steps where the height is a multiple of the divisor, and there the two computations may round apart.
      expectRelative(await math(mode, WIDE, value), mapValues(WIDE, (v) => operation(v, w)), 1e-5, mode === 'modulo' ? () => w : undefined);
    }
  });

  test(`adjust/math: ${mode}: with a second input, every pair of heights from -1 to 2 is the reference's`, async () => {
    expectRelative(await math(mode, PAIR_A, PAIR_B), zipValues(PAIR_A, PAIR_B, operation), 1e-5, mode === 'modulo' ? (i) => PAIR_B.data[i] : undefined);
  });
}

test('adjust/math: a connected second input replaces the constant', async () => {
  const cone = fixtures.cone(257);
  const one = await renderNode(def, { inputs: { in: 'terrain', b: cone }, params: { mode: 'add', value: 0.5 } });
  const other = await renderNode(def, { inputs: { in: 'terrain', b: cone }, params: { mode: 'add', value: -1.5 } });
  expectIdentical(one.out, other.out);
  expectClose(one.out, zipValues(fixtures.terrain(257), cone, (v, w) => v + w), { max: 1e-6 });
});

test('adjust/math: a division by 0 and a remainder of 0 give 0, and a fold at 0 gives 0', async () => {
  const zero = fixtures.zero(257);
  for (const mode of ['divide', 'modulo', 'fold']) {
    expectIdentical(await math(mode, WIDE, 0), zero);
    expectIdentical(await math(mode, WIDE, zero), zero);
  }
});

test('adjust/math: a power keeps the sign of a negative height, and 0 stays 0 whatever the exponent', async () => {
  const src = fieldOf(257, (u) => (u < 0.25 ? -0.25 : u < 0.5 ? 0 : u < 0.75 ? 0.25 : -4));
  const expected = (w: number) => mapValues(src, (v) => (v === 0 ? 0 : Math.sign(v) * Math.abs(v) ** w));
  for (const exponent of [2, 0.5, -1, 0, -0.5]) expectRelative(await math('power', src, exponent), expected(exponent), 1e-5);
  // The square root of 0.25 and of 4, with the sign of the height.
  const root = await math('power', src, 0.5);
  assert.ok(Math.abs(root.data[0] + 0.5) <= 1e-6 && root.data[100] === 0 && Math.abs(root.data[160] - 0.5) <= 1e-6 && Math.abs(root.data[256] + 2) <= 1e-5);
});

test('adjust/math: the operations that change nothing change nothing, bit for bit', async () => {
  expectIdentical(await math('add', WIDE, 0), WIDE);
  expectIdentical(await math('subtract', WIDE, 0), WIDE);
  expectIdentical(await math('multiply', WIDE, 1), WIDE);
  expectIdentical(await math('divide', WIDE, 1), WIDE);
  expectIdentical(await math('minimum', WIDE, 5), WIDE);
  expectIdentical(await math('maximum', WIDE, -5), WIDE);
});

test('adjust/math: a remainder lies between 0 and the divisor, and a fold never leaves that band nor makes a step', async () => {
  const saw = await math('modulo', WIDE, 0.375);
  assert.equal(countValues(saw, (v) => v < 0 || v > 0.375), 0, 'a remainder outside 0..0.375');
  const folded = await math('fold', WIDE, 0.375);
  const { min, max } = extremes(folded);
  assert.ok(min >= 0 && max <= 0.375 && max > 0.37 && min < 0.005, `the fold spans ${min}..${max}`);
  // Along a row the input rises by 0.0088 from texel to texel; the fold rises or falls by as much and no more.
  const step = (3 * 0.75) / 256;
  assert.equal(countValues(folded, (v, i) => i % 257 > 0 && Math.abs(v - folded.data[i - 1]) > step + 1e-6), 0, 'the fold has a step');
  assert.ok(countValues(saw, (v, i) => i % 257 > 0 && Math.abs(v - saw.data[i - 1]) > 0.3) > 257, 'the sawtooth has none');
  // Within 0 and the operand a fold leaves the height as it is.
  assert.equal(countValues(folded, (v, i) => WIDE.data[i] >= 0 && WIDE.data[i] <= 0.375 && Math.abs(v - WIDE.data[i]) > 1e-6), 0);
});

test('adjust/math: a fold by an operand far larger than the heights leaves them as they are, mirrored at 0', async () => {
  // Within its first rise the fold is the magnitude of the height itself, bit for bit: it is not the small
  // difference of two numbers as large as the operand.
  for (const operand of [1e8, 1e30, 3e38]) expectIdentical(await math('fold', WIDE, operand), mapValues(WIDE, Math.abs));
});

test('adjust/math: a remainder stays between 0 and the divisor where the height is more divisors than a float counts', async () => {
  const huge = fieldOf(257, (u) => 1e30 * (u - 0.5));
  const divisor = Math.fround(1e-30);
  assert.equal(countValues(await math('modulo', huge, 1e-30), (v) => !(v >= 0 && v <= divisor)), 0, 'a remainder outside 0..1e-30');
  assert.equal(countValues(await math('modulo', huge, -1e-30), (v) => !(v <= 0 && v >= -divisor)), 0, 'a remainder outside -1e-30..0');
});

test('adjust/math: a result too large for a float is the largest float, not infinity', async () => {
  const huge = fieldOf(257, (u) => 1e30 * (u - 0.5));
  for (const [mode, value] of [['multiply', 1e30], ['divide', 1e-30], ['power', 40], ['add', 3e38]] as const) {
    const out = await math(mode, huge, value);
    expectFinite(out);
    assert.ok(extremes(out).max > 1e38, `${mode}: the result reaches ${extremes(out).max}`);
  }
});

test('adjust/math: at its defaults the node halves a terrain', async () => {
  const src = fixtures.terrain(257);
  const { out } = await renderNode(def, { inputs: { in: src, b: null } });
  expectClose(out, mapValues(src, (v) => 0.5 * v), { max: 1e-6 });
  assert.ok(Math.abs(stats(out).std - 0.5 * stats(src).std) <= 1e-6);
});
