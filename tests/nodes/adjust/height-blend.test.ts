// tests/nodes/adjust/height-blend.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectMask, fieldOf, fixtures, renderNode, type FieldData, type FixtureName } from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/adjust/height-blend.ts';
import { countValues, mapValues, PAIR_A, PAIR_B, zipValues } from './_reference.ts';

conformance(def);

/** Half the band of heights in which the two terrains blend: 0.5 at no contrast, nothing at full contrast. */
const band = (contrast: number): number => 0.5 * (1 - contrast);

/** The share of the second terrain where it stands `d` above the first: a smoothstep across the band. */
function share(d: number, contrast: number): number {
  const k = band(contrast);
  if (k <= 0) return d > 0 ? 1 : d < 0 ? 0 : 0.5;
  const t = Math.min(1, Math.max(0, (d + k) / (2 * k)));
  return t * t * (3 - 2 * t);
}

interface Blend { contrast: number; offset: number }
const DEFAULTS: Blend = { contrast: 0.8, offset: 0 };

type Input = FieldData | FixtureName | null;
async function blend(a: Input, b: Input, params: Partial<Blend>, mask: Input = null): Promise<{ out: FieldData; weight: FieldData }> {
  const { out, weight } = await renderNode(def, { inputs: { a, b, mask }, params: params as Record<string, ParamValue> });
  return { out, weight };
}

test('adjust/height-blend: the defaults of this test are those of the node', () => {
  assert.deepEqual(Object.fromEntries(def.params.map((param) => [param.name, param.default])), DEFAULTS);
});

for (const params of [{}, { contrast: 0 }, { contrast: 0.5, offset: 0.25 }, { contrast: 0.95, offset: -0.5 }, { contrast: 0.2, offset: 1.5 }] as Partial<Blend>[]) {
  test(`adjust/height-blend: ${JSON.stringify(params)}: every pair of heights from -1 to 2 gives the reference, and the weight is the share of the second terrain`, async () => {
    const p = { ...DEFAULTS, ...params };
    const { out, weight } = await blend(PAIR_A, PAIR_B, params);
    const w = zipValues(PAIR_A, PAIR_B, (a, b) => share(b + p.offset - a, p.contrast));
    expectClose(weight, w, { max: 2e-6 });
    expectClose(out, zipValues(PAIR_A, PAIR_B, (a, b, i) => a + w.data[i] * (b + p.offset - a)), { max: 4e-6 });
    expectMask(weight);
  });
}

test('adjust/height-blend: beyond the band the higher terrain is the result, bit for bit, and the weight is 0 or 1', async () => {
  // A contrast of 0.5 is a band of 0.25 on either side of the crossing.
  const { out, weight } = await blend(PAIR_A, PAIR_B, { contrast: 0.5 });
  const above = (i: number): number => PAIR_B.data[i] - PAIR_A.data[i];
  assert.equal(countValues(out, (v, i) => above(i) >= 0.2501 && (v !== PAIR_B.data[i] || weight.data[i] !== 1)), 0, 'the second terrain does not win outright where it stands above the band');
  assert.equal(countValues(out, (v, i) => above(i) <= -0.2501 && (v !== PAIR_A.data[i] || weight.data[i] !== 0)), 0, 'the first terrain does not win outright where it stands above the band');
  // Within the band the result lies between the two, and where they cross it is both.
  assert.equal(countValues(out, (v, i) => v < Math.min(PAIR_A.data[i], PAIR_B.data[i]) - 1e-6 || v > Math.max(PAIR_A.data[i], PAIR_B.data[i]) + 1e-6), 0);
  for (const x of [0, 100, 256]) assert.ok(at(out, x, x) === at(PAIR_A, x, x) && at(weight, x, x) === 0.5);
});

test('adjust/height-blend: at full contrast the result is the higher terrain, with a crease, and the blend has none', async () => {
  const hard = await blend(PAIR_A, PAIR_B, { contrast: 1 });
  expectIdentical(hard.out, zipValues(PAIR_A, PAIR_B, (a, b) => Math.max(a, b)));
  assert.equal(countValues(hard.weight, (v, i) => v !== (PAIR_B.data[i] > PAIR_A.data[i] ? 1 : PAIR_B.data[i] < PAIR_A.data[i] ? 0 : 0.5)), 0);

  // Along a row `a` rises by 3 / 256 per texel and `b` is constant. The slope of the higher terrain steps by that
  // rise where the two cross. Through a band of half-width k the blend a + w(d) * d turns with a second derivative
  // of at most 1.5 / k (the smoothstep's slope 0.75 / k twice, where its curvature is 0), and less at the ends.
  const step = 3 / 256, k = band(0.5);
  const bend = (f: FieldData): number => {
    let worst = 0;
    for (let y = 0; y < 257; y += 16) for (let x = 1; x < 256; x++) worst = Math.max(worst, Math.abs(at(f, x - 1, y) - 2 * at(f, x, y) + at(f, x + 1, y)));
    return worst;
  };
  const soft = await blend(PAIR_A, PAIR_B, { contrast: 0.5 });
  assert.ok(bend(hard.out) > 0.9 * step, `the higher terrain bends by ${bend(hard.out)} at one texel; the step of the input is ${step}`);
  assert.ok(bend(soft.out) <= (1.6 * step * step) / k, `the blend bends by ${bend(soft.out)} at one texel; allowed ${(1.6 * step * step) / k}`);
});

test('adjust/height-blend: the offset raises the second terrain itself, so the result has no step where it takes over', async () => {
  // A level plain at 0.25 against a ramp: with an offset of 0.5 the plain stands at 0.75 and wins below that height.
  const ramp = fixtures.rampX(257), plain = fieldOf(257, () => 0.25);
  const { out, weight } = await blend(ramp, plain, { contrast: 1, offset: 0.5 });
  expectClose(out, mapValues(ramp, (v) => Math.max(v, 0.75)), { max: 1e-6 });
  assert.equal(countValues(weight, (v, i) => v !== (ramp.data[i] < 0.75 ? 1 : ramp.data[i] > 0.75 ? 0 : 0.5)), 0);
  // A negative offset sinks it out of sight.
  const sunk = await blend(ramp, plain, { contrast: 1, offset: -0.5 });
  expectIdentical(sunk.out, ramp);
  expectIdentical(sunk.weight, fixtures.zero(257));
});

test('adjust/height-blend: the mask scales the share of the second terrain, in the result and in the weight', async () => {
  // The mask fixture is 1 inside a radius of 0.2 and 0 outside 0.35.
  const a = fixtures.terrain(257), b = fixtures.cone(257), mask = fixtures.mask(257);
  const { out, weight } = await blend(a, b, { contrast: 0.6 }, mask);
  const w = zipValues(a, b, (x, y, i) => mask.data[i] * share(y - x, 0.6));
  expectClose(weight, w, { max: 2e-6 });
  expectClose(out, zipValues(a, b, (x, y, i) => x + w.data[i] * (y - x)), { max: 2e-6 });
  // Where the mask is 0 the first terrain is untouched and nothing of the second shows.
  assert.equal(countValues(out, (v, i) => mask.data[i] === 0 && (v !== a.data[i] || weight.data[i] !== 0)), 0);
  const none = await blend(a, b, {}, 'zero');
  expectIdentical(none.out, a);
  expectIdentical(none.weight, fixtures.zero(257));
});

test('adjust/height-blend: two terrains merge into one that is nowhere lower than the lower of them and mostly the higher', async () => {
  const a = fixtures.terrain(257), b = fixtures.basin(257);
  const { out, weight } = await blend(a, b, {});
  const higher = zipValues(a, b, (x, y) => Math.max(x, y));
  // The blend a + w(d) * d is never above the higher terrain, and below it by (1 - w(d)) * |d| at most: for a
  // smoothstep that is 0.087 of the band, where the two are 0.37 of the band apart. The default band is 0.1.
  assert.equal(countValues(out, (v, i) => v > higher.data[i] + 1e-6 || v < higher.data[i] - 0.09 * 0.1), 0);
  assert.ok(countValues(out, (v, i) => v === higher.data[i]) > 0.5 * out.data.length, 'most of the result is the higher terrain itself');
  // The weight says where the second terrain shows: 1 where it is well above the first, 0 where well below.
  assert.equal(countValues(weight, (v, i) => (b.data[i] - a.data[i] > 0.1001 && v !== 1) || (b.data[i] - a.data[i] < -0.1001 && v !== 0)), 0);
});
