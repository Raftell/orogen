// tests/nodes/adjust/bias-gain.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/adjust/bias-gain.ts';
import { COLOR_TOL, countValues, mapValues, WIDE, WIDE_COLOR } from './_reference.ts';

conformance(def);

/** Schlick's bias: 0 and 1 stay, one half becomes b. */
function lean(t: number, b: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return (t * b) / (t * b + (1 - t) * (1 - b));
}

/** The node in float64: the bias, then Schlick's gain, on what lies between 0 and 1; what lies beyond keeps its distance from that end. */
function reference(bias: number, gain: number): (x: number) => number {
  return (x) => {
    const s = Math.min(1, Math.max(0, x));
    const t = lean(s, bias);
    const g = t < 0.5 ? 0.5 * lean(2 * t, 1 - gain) : 1 - 0.5 * lean(2 - 2 * t, 1 - gain);
    return g + (x - s);
  };
}

async function shaped(src: FieldData, bias: number, gain: number): Promise<FieldData> {
  return (await renderNode(def, { inputs: { in: src }, params: { bias, gain } })).out;
}

test('adjust/bias-gain: the node starts with a bias below one half and no gain', () => {
  assert.deepEqual(Object.fromEntries(def.params.map((param) => [param.name, param.default])), { bias: 0.25, gain: 0.5 });
});

for (const [bias, gain] of [[0.25, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.9], [0.2, 0.75], [0.9, 0.1], [0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1], [0, 0], [1, 1]] as const) {
  test(`adjust/bias-gain: bias ${bias}, gain ${gain}: every value from -1 to 2 is the reference's`, async () => {
    const out = await shaped(WIDE, bias, gain);
    expectClose(out, mapValues(WIDE, reference(bias, gain)), { max: 2e-6 });
    assert.equal(countValues(out, (v, i) => i % 257 > 0 && v < out.data[i - 1] - 1e-6), 0, 'the output falls where the input rises');
  });
}

test('adjust/bias-gain: one half for both changes nothing', async () => {
  expectClose(await shaped(WIDE, 0.5, 0.5), WIDE, { max: 1e-6 });
});

test('adjust/bias-gain: 0 and 1 stay where they are, and the bias is the level one half is moved to', async () => {
  const levels = fieldOf(257, (u) => (u < 0.25 ? 0 : u < 0.5 ? 0.5 : u < 0.75 ? 1 : 0.25));
  for (const bias of [0.1, 0.3, 0.7]) {
    const out = await shaped(levels, bias, 0.5);
    expectClose(out, mapValues(levels, (x) => (x === 0.5 ? bias : x === 0.25 ? reference(bias, 0.5)(0.25) : x)), { max: 1e-6 });
    assert.equal(countValues(out, (v, i) => (levels.data[i] === 0 || levels.data[i] === 1) && v !== levels.data[i]), 0, '0 or 1 moved');
  }
  // The gain moves a quarter away from the middle or toward it, and leaves the middle itself.
  const more = await shaped(levels, 0.5, 0.8), less = await shaped(levels, 0.5, 0.2);
  expectClose(more, mapValues(levels, (x) => (x === 0.25 ? 0.1 : x)), { max: 1e-6 });
  expectClose(less, mapValues(levels, (x) => (x === 0.25 ? 0.4 : x)), { max: 1e-6 });
});

test('adjust/bias-gain: the gain treats the two halves of the range alike', async () => {
  // Without a bias, the gain of 1 - x is 1 minus the gain of x.
  const ramp = fixtures.rampX(257), back = fieldOf(257, (u) => 1 - u);
  const out = await shaped(ramp, 0.5, 0.85), mirrored = await shaped(back, 0.5, 0.85);
  expectClose(mirrored, mapValues(out, (x) => 1 - x), { max: 1e-6 });
});

test('adjust/bias-gain: a bias below one half presses a terrain down and a gain above one half spreads it', async () => {
  const src = fixtures.terrain(257);
  const pressed = await shaped(src, 0.25, 0.5), spread = await shaped(src, 0.5, 0.8), gathered = await shaped(src, 0.5, 0.2);
  assert.ok(stats(pressed).mean < stats(src).mean - 0.1, `the mean went from ${stats(src).mean} to ${stats(pressed).mean}`);
  assert.equal(countValues(pressed, (v, i) => v > src.data[i]), 0, 'a bias below one half raised a height');
  assert.ok(stats(spread).std > 1.2 * stats(src).std && stats(gathered).std < 0.8 * stats(src).std);
});

test('adjust/bias-gain: a color is shaped channel by channel and keeps its alpha', async () => {
  for (const [bias, gain] of [[0.3, 0.5], [0.7, 0.8]] as const) {
    const out = await shaped(WIDE_COLOR, bias, gain);
    assert.equal(out.kind, 'color');
    expectClose(out, mapValues(WIDE_COLOR, reference(bias, gain)), { max: COLOR_TOL });
    expectIdentical(channelOf(out, 3), channelOf(WIDE_COLOR, 3));
  }
});
