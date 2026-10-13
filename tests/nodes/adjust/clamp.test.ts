// tests/nodes/adjust/clamp.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, channelOf, conformance, expectClose, expectIdentical, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/adjust/clamp.ts';
import { COLOR_TOL, countValues, extremes, mapValues, WIDE, WIDE_COLOR } from './_reference.ts';

conformance(def);

interface Clamp { min: number; max: number; softness: number }
const DEFAULTS: Clamp = { min: 0.35, max: 0.65, softness: 0.25 };

/**
 * The node in float64. Within a knee of a limit, on either side of it, a quadratic joins the flat line of the
 * limit to the line of the values; the knee is `softness` times half the range.
 */
function reference(p: Clamp): (x: number) => number {
  const lo = Math.min(p.min, p.max), hi = Math.max(p.min, p.max);
  const knee = (p.softness * (hi - lo)) / 2;
  const bend = (d: number): number => Math.max(knee - Math.abs(d), 0) ** 2 / (4 * knee);
  return (x) => {
    if (knee <= 0) return Math.min(hi, Math.max(lo, x));
    const raised = Math.max(x, lo) + bend(x - lo);
    return Math.min(raised, hi) - bend(raised - hi);
  };
}

async function clamped(src: FieldData, params: Partial<Clamp>): Promise<FieldData> {
  return (await renderNode(def, { inputs: { in: src }, params: params as Record<string, ParamValue> })).out;
}

test('adjust/clamp: the defaults of this test are those of the node', () => {
  assert.deepEqual(Object.fromEntries(def.params.map((param) => [param.name, param.default])), DEFAULTS);
});

const CASES: Readonly<Record<string, Partial<Clamp>>> = {
  'the defaults': {},
  'a hard edge': { softness: 0 },
  'full softness': { softness: 1 },
  'the two levels given the other way round': { min: 0.75, max: 0.25, softness: 0.5 },
  'a range outside 0..1': { min: -0.5, max: 1.5, softness: 0.6 },
  'a range of no width': { min: 0.5, max: 0.5, softness: 1 },
};

for (const [name, params] of Object.entries(CASES)) {
  test(`adjust/clamp: ${name}: every value from -1 to 2 is the reference's and lies within the range`, async () => {
    const p = { ...DEFAULTS, ...params };
    const out = await clamped(WIDE, params);
    expectClose(out, mapValues(WIDE, reference(p)), { max: 1e-6 });
    const { min, max } = extremes(out);
    assert.ok(min >= Math.fround(Math.min(p.min, p.max)) && max <= Math.fround(Math.max(p.min, p.max)), `the result spans ${min}..${max}`);
    assert.equal(countValues(out, (v, i) => i % 257 > 0 && v < out.data[i - 1]), 0, 'the output falls where the input rises');
  });
}

test('adjust/clamp: without softness the values inside the range pass bit for bit and the others are the limits', async () => {
  const lo = Math.fround(0.3), hi = Math.fround(0.8);
  expectIdentical(await clamped(WIDE, { min: 0.3, max: 0.8, softness: 0 }), mapValues(WIDE, (x) => Math.min(hi, Math.max(lo, x))));
});

test('adjust/clamp: with softness a value farther than the knee from both limits passes bit for bit', async () => {
  // A range of 0.25..0.75 at a softness of 0.4 has a knee of 0.1.
  const out = await clamped(WIDE, { min: 0.25, max: 0.75, softness: 0.4 });
  assert.equal(countValues(out, (v, i) => WIDE.data[i] >= 0.36 && WIDE.data[i] <= 0.64 && v !== WIDE.data[i]), 0, 'a value in the middle of the range changed');
  assert.equal(countValues(out, (v, i) => WIDE.data[i] <= 0.14 && v !== 0.25), 0, 'a value far below the range is not the minimum');
  assert.equal(countValues(out, (v, i) => WIDE.data[i] >= 0.86 && v !== 0.75), 0, 'a value far above the range is not the maximum');
});

test('adjust/clamp: a hard edge is a crease and a soft knee is none', async () => {
  // Along a row the input rises by the same step from texel to texel. Where a hard clamp meets a limit the slope
  // jumps from 0 to that step; through a knee it changes by step * step / (2 * knee) per texel, and no faster.
  const step = (3 * 0.75) / 256, knee = 0.4 * 0.25;
  const bend = (f: FieldData): number => {
    let worst = 0;
    for (let x = 1; x < 256; x++) worst = Math.max(worst, Math.abs(at(f, x - 1, 128) - 2 * at(f, x, 128) + at(f, x + 1, 128)));
    return worst;
  };
  const hard = bend(await clamped(WIDE, { min: 0.25, max: 0.75, softness: 0 }));
  const soft = bend(await clamped(WIDE, { min: 0.25, max: 0.75, softness: 0.4 }));
  assert.ok(hard > 0.5 * step, `the hard edge bends by ${hard} at one texel; the step of the input is ${step}`);
  assert.ok(soft <= 1.02 * (step * step) / (2 * knee) + 1e-6, `the knee bends by ${soft} at one texel; a quadratic of that knee bends by ${(step * step) / (2 * knee)}`);
});

test('adjust/clamp: a terrain keeps its middle and loses what lies beyond the two levels', async () => {
  const src = fixtures.terrain(257);
  const out = await clamped(src, {});
  const { min, max } = extremes(out);
  assert.ok(min === Math.fround(0.35) && max === Math.fround(0.65), `the result spans ${min}..${max}`);
  assert.ok(countValues(src, (v) => v < 0.35) > 0.1 * src.data.length && countValues(src, (v) => v > 0.65) > 0.1 * src.data.length, 'the fixture has ground beyond both levels');
});

test('adjust/clamp: a color is limited channel by channel and keeps its alpha', async () => {
  for (const params of [{}, { softness: 0 }, { min: -0.25, max: 1.25, softness: 1 }]) {
    const out = await clamped(WIDE_COLOR, params);
    assert.equal(out.kind, 'color');
    expectClose(out, mapValues(WIDE_COLOR, reference({ ...DEFAULTS, ...params })), { max: COLOR_TOL });
    expectIdentical(channelOf(out, 3), channelOf(WIDE_COLOR, 3));
  }
});
