// tests/nodes/adjust/invert.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/adjust/invert.ts';
import { COLOR_TOL, mapValues, WIDE, WIDE_COLOR } from './_reference.ts';

conformance(def);

async function inverted(src: FieldData, pivot?: number): Promise<FieldData> {
  return (await renderNode(def, { inputs: { in: src }, ...(pivot === undefined ? {} : { params: { pivot } }) })).out;
}

test('adjust/invert: at the default pivot of one half a value x becomes 1 - x, also outside 0..1', async () => {
  assert.equal(def.params[0].default, 0.5);
  expectClose(await inverted(WIDE), mapValues(WIDE, (x) => 1 - x), { max: 1e-6 });
});

for (const pivot of [0, 0.25, 1, -0.75, 1.75]) {
  test(`adjust/invert: pivot ${pivot}: every value is mirrored around the pivot, which stays where it is`, async () => {
    expectClose(await inverted(WIDE, pivot), mapValues(WIDE, (x) => 2 * pivot - x), { max: 1e-6 });
    // A float minus itself is 0 and 2 * pivot - pivot is the pivot, exactly.
    const level = fieldOf(257, () => pivot);
    expectIdentical(await inverted(level, pivot), level);
  });
}

test('adjust/invert: inverting twice gives the input back', async () => {
  const src = fixtures.terrain(257);
  expectClose(await inverted(await inverted(src, 0.3), 0.3), src, { max: 1e-6 });
});

test('adjust/invert: the peaks of a terrain become its pits', async () => {
  const src = fixtures.cone(257);
  const out = await inverted(src);
  // The cone is 1 at its tip and 0 on its floor.
  assert.equal(out.data[128 * 257 + 128], 0);
  assert.equal(out.data[0], 1);
  const before = stats(src), after = stats(out);
  assert.ok(Math.abs(after.min - (1 - before.max)) <= 1e-6 && Math.abs(after.max - (1 - before.min)) <= 1e-6 && Math.abs(after.mean - (1 - before.mean)) <= 1e-6);
});

test('adjust/invert: a color is mirrored channel by channel and keeps its alpha', async () => {
  for (const pivot of [0.5, 0.125]) {
    const out = await inverted(WIDE_COLOR, pivot);
    assert.equal(out.kind, 'color');
    expectClose(out, mapValues(WIDE_COLOR, (x) => 2 * pivot - x), { max: COLOR_TOL });
    expectIdentical(channelOf(out, 3), channelOf(WIDE_COLOR, 3));
  }
});
