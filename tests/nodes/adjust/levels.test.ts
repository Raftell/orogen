// tests/nodes/adjust/levels.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, conformance, expectClose, expectFinite, expectIdentical, fieldOf, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/adjust/levels.ts';
import { COLOR_TOL, countValues, extremes, HUGE_A, mapValues, WIDE, WIDE_COLOR } from './_reference.ts';

conformance(def);

interface Levels { inMin: number; inMax: number; gamma: number; outMin: number; outMax: number; clamp: boolean }
const DEFAULTS: Levels = { inMin: 0.25, inMax: 0.75, gamma: 1, outMin: 0, outMax: 1, clamp: true };

/** The node as its help texts read, in float64. */
function reference(p: Levels): (x: number) => number {
  return (x) => {
    const width = p.inMax - p.inMin;
    const t = width !== 0 ? (x - p.inMin) / width : x >= p.inMin ? 1 : 0;
    const s = Math.min(1, Math.max(0, t));
    let g = s > 0 && s < 1 ? s ** (1 / p.gamma) : s;
    if (!p.clamp) g += t - s;
    return p.outMin + g * (p.outMax - p.outMin);
  };
}

async function levels(src: FieldData, params: Partial<Levels>): Promise<FieldData> {
  return (await renderNode(def, { inputs: { in: src }, params: params as Record<string, ParamValue> })).out;
}

test('adjust/levels: the defaults of this test are those of the node', () => {
  assert.deepEqual(Object.fromEntries(def.params.map((param) => [param.name, param.default])), DEFAULTS);
});

// The two points of every case are numbers a float holds exactly, so that the node and the reference divide the same numbers.
const CASES: Readonly<Record<string, Partial<Levels>>> = {
  'the defaults': {},
  'a gamma above 1': { gamma: 2.5 },
  'a gamma below 1': { gamma: 0.4 },
  'an output range inside 0..1': { outMin: 0.125, outMax: 0.625, gamma: 1.5 },
  'an output range turned over': { outMin: 1, outMax: 0 },
  'a white point below the black point': { inMin: 0.875, inMax: 0.125 },
  'the two points far outside 0..1': { inMin: -0.75, inMax: 1.75, gamma: 0.5 },
  'no limit': { clamp: false },
  'no limit and a gamma': { clamp: false, gamma: 2, outMin: -0.5, outMax: 1.5 },
  'the two points on one value': { inMin: 0.5, inMax: 0.5, outMin: 0.25, outMax: 0.75 },
};

for (const [name, params] of Object.entries(CASES)) {
  test(`adjust/levels: ${name}: every value from -1 to 2 is the reference's`, async () => {
    const out = await levels(WIDE, params);
    // A power is the device's own; a straight line is exact to the last bits.
    expectClose(out, mapValues(WIDE, reference({ ...DEFAULTS, ...params })), { max: (params.gamma ?? 1) === 1 ? 2e-6 : 2e-5 });
  });
}

test('adjust/levels: with the limit, everything at or beyond the two points is exactly the end of the output range', async () => {
  const out = await levels(WIDE, { outMin: 0.2, outMax: 0.7, gamma: 3 });
  const low = Math.fround(0.2), high = Math.fround(0.7);
  assert.equal(countValues(out, (v, i) => WIDE.data[i] <= 0.25 && v !== low), 0, 'a value at or below the black point is not the output minimum');
  assert.equal(countValues(out, (v, i) => WIDE.data[i] >= 0.75 && v !== high), 0, 'a value at or above the white point is not the output maximum');
  assert.equal(countValues(out, (v) => v < low || v > high), 0, 'a value lies outside the output range');
  // Between the two points the order of the heights is kept.
  assert.equal(countValues(out, (v, i) => i % 257 > 0 && v < out.data[i - 1]), 0, 'the output falls where the input rises');
});

test('adjust/levels: the points at 0 and 1 without a gamma or a limit leave every value as it is', async () => {
  const neutral = { inMin: 0, inMax: 1, gamma: 1, outMin: 0, outMax: 1, clamp: false };
  expectIdentical(await levels(WIDE, neutral), WIDE);
  // With the limit the same setting is a clamp to 0..1 and nothing else.
  expectIdentical(await levels(WIDE, { ...neutral, clamp: true }), mapValues(WIDE, (x) => Math.min(1, Math.max(0, x))));
});

test('adjust/levels: without the limit a result too large for a float is the largest float, and an output range of no width gives its one value', async () => {
  // Two points a thousandth apart: a height of 3e38 lies 3e41 widths beyond them, which is no float.
  const far = await levels(HUGE_A, { clamp: false, inMin: 0, inMax: 0.001 });
  expectFinite(far);
  assert.ok(extremes(far).max > 1e38 && extremes(far).min < -1e38, `the result spans ${extremes(far).min}..${extremes(far).max}`);
  expectIdentical(await levels(HUGE_A, { clamp: false, inMin: 0, inMax: 0.001, outMin: 0.5, outMax: 0.5 }), fieldOf(257, () => 0.5));
  // With the limit such heights are the two ends of the output range like any others beyond the two points.
  expectIdentical(await levels(HUGE_A, { inMin: 0, inMax: 0.001 }), mapValues(HUGE_A, (x) => (x >= 0.001 ? 1 : 0)));
});

test('adjust/levels: a terrain is stretched: its floor and its top become flat, and what lies between spans the whole range', async () => {
  const src = fixtures.terrain(257);
  const out = await levels(src, {});
  const flat = countValues(out, (v) => v === 0 || v === 1);
  const expected = countValues(src, (v) => v <= 0.25 || v >= 0.75);
  assert.equal(flat, expected);
  assert.ok(expected > 0.1 * src.data.length, 'the fixture has ground beyond both points');
});

test('adjust/levels: a color is remapped channel by channel and keeps its alpha', async () => {
  for (const params of [{}, { gamma: 2, outMin: 0.25, outMax: 0.5 }, { clamp: false, inMin: 0, inMax: 0.5 }]) {
    const out = await levels(WIDE_COLOR, params);
    assert.equal(out.kind, 'color');
    expectClose(out, mapValues(WIDE_COLOR, reference({ ...DEFAULTS, ...params })), { max: COLOR_TOL });
    expectIdentical(channelOf(out, 3), channelOf(WIDE_COLOR, 3));
  }
});

test('adjust/levels: the mask of the node blends the result over the input', async () => {
  // The mask fixture is 1 inside a radius of 0.2 and 0 outside 0.35.
  const src = fixtures.terrain(257), mask = fixtures.mask(257);
  const full = await levels(src, {});
  const { out } = await renderNode(def, { inputs: { in: src }, mask });
  assert.equal(countValues(out, (v, i) => mask.data[i] === 0 && v !== src.data[i]), 0, 'a texel outside the mask changed');
  assert.equal(countValues(out, (v, i) => mask.data[i] === 1 && v !== full.data[i]), 0, 'a texel inside the mask is not the result');
});
