// tests/nodes/generate/crater-field.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectStats, fixtures, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/crater-field.ts';
import { mapField, share } from './_land-probe.ts';

conformance(def);

/** The craters alone: no terrain connected, so they are cut into level ground at `height`. */
const alone = { in: null } as const;

/** The part of the terrain that lies in a bowl: lower than the ground by more than a hundredth of the depth. */
const cratered = (depth: number) => (value: number): boolean => value < 0.5 - 0.01 * depth;

test('generate/crater-field: more impacts crater more of the ground', async () => {
  const shares: number[] = [];
  for (const count of [5, 40, 320]) {
    const { out } = await renderNode(def, { inputs: alone, params: { count } });
    shares.push(share(out, cratered(0.18)));
  }
  assert.ok(shares[0]! < shares[1]! && shares[1]! < shares[2]!, `the cratered part of the terrain is ${shares.join(', ')} at 5, 40 and 320 impacts`);
  assert.ok(shares[0]! > 0 && shares[2]! > 0.3, 'five impacts leave bowls, and 320 crater a third of the terrain');
});

test('generate/crater-field: no crater is deeper than the depth, and the depth scales every crater', async () => {
  for (const seed of [0, 1, 2]) {
    const { out } = await renderNode(def, { inputs: alone, params: { seed, depth: 0.2 } });
    // The depth is that of a fresh crater of the largest radius: every crater is smaller, older or both.
    expectStats(out, { min: [0.5 - 0.2, 0.5 - 0.2 * 0.05] });
    assert.ok(stats(out).max > 0.5 && stats(out).max < 0.5 + 0.2 * 0.4, `seed ${seed}: the highest rim is at ${stats(out).max}`);
  }
  const shallow = await renderNode(def, { inputs: alone, params: { depth: 0.1 } });
  const deep = await renderNode(def, { inputs: alone, params: { depth: 0.2 } });
  expectClose(mapField(shallow.out, (value) => 0.5 + 2 * (value - 0.5)), deep.out, { max: 1e-6 });
});

test('generate/crater-field: craters of one radius all cover the same area, and larger craters cover more', async () => {
  // One crater of a radius of 0.1: its bowl, lower than the ground, has about the area of a disc of that radius
  // if it lies on the terrain; over several seeds at least one does.
  let largest = 0;
  for (const seed of [0, 1, 2, 3]) {
    const { out } = await renderNode(def, { inputs: alone, params: { seed, count: 1, radiusMin: 0.1, radiusMax: 0.1 } });
    largest = Math.max(largest, share(out, (value) => value < 0.5));
  }
  const disc = Math.PI * 0.1 ** 2;
  assert.ok(largest > 0.7 * disc && largest < 1.3 * disc, `one crater of radius 0.1 lowers ${largest} of the terrain; a disc of that radius is ${disc}`);

  const small = await renderNode(def, { inputs: alone, params: { radiusMin: 0.01, radiusMax: 0.03 } });
  const large = await renderNode(def, { inputs: alone, params: { radiusMin: 0.03, radiusMax: 0.09 } });
  assert.ok(share(large.out, cratered(0.18)) > 3 * share(small.out, cratered(0.18)), 'craters three times as wide cover several times the ground');
});

test('generate/crater-field: small craters outnumber large ones', async () => {
  // With depth in proportion to the radius to the power 0.75, shallow ground belongs to small or old craters and
  // only the largest reach deep: most of the cratered ground is shallow.
  const { out } = await renderNode(def, { inputs: alone, params: { count: 400, radiusMin: 0.01, radiusMax: 0.1, depth: 0.2 } });
  const shallow = share(out, (value) => value < 0.5 - 0.002 && value >= 0.5 - 0.05);
  const deep = share(out, (value) => value < 0.5 - 0.1);
  assert.ok(shallow > 2 * deep && deep > 0, `${shallow} of the terrain lies in shallow bowls and ${deep} in deep ones`);
});

test('generate/crater-field: stamped into a terrain, the craters are added to it, and flattening levels it inside each rim', async () => {
  const terrain = fixtures.terrain(257);
  const flat = await renderNode(def, { inputs: alone });
  const added = await renderNode(def, { inputs: { in: terrain }, params: { flatten: 0 } });
  expectClose(added.out, mapField(terrain, (value, x, y) => value + at(flat.out, x, y) - 0.5), { max: 1e-6 });
  // Full flattening: wherever the ground is deep in a bowl, the terrain is gone and the result is the field on level ground.
  const levelled = await renderNode(def, { inputs: { in: terrain }, params: { flatten: 1 } });
  let worst = 0, bowls = 0;
  for (let i = 0; i < flat.out.data.length; i++) {
    if (flat.out.data[i]! > 0.5 - 0.04) continue;
    bowls++;
    worst = Math.max(worst, Math.abs(levelled.out.data[i]! - flat.out.data[i]!));
  }
  assert.ok(bowls > 500 && worst <= 1e-6, `in ${bowls} texels of the bowls the levelled terrain differs from level ground by up to ${worst}`);
  // Half of it leaves half of the terrain's relief there.
  const half = await renderNode(def, { inputs: { in: terrain }, params: { flatten: 0.5, count: 1, radiusMin: 0.3, radiusMax: 0.3 } });
  const one = await renderNode(def, { inputs: alone, params: { count: 1, radiusMin: 0.3, radiusMax: 0.3 } });
  // The lowest part of the one bowl lies well inside its rim, whatever its age and wherever it struck.
  const floor = stats(one.out).min;
  let off = 0, deepest = 0;
  for (let i = 0; i < one.out.data.length; i++) {
    if (one.out.data[i]! > floor + 0.3 * (0.5 - floor)) continue;
    deepest++;
    off = Math.max(off, Math.abs(half.out.data[i]! - (one.out.data[i]! + 0.5 * (terrain.data[i]! - 0.5))));
  }
  assert.ok(off <= 1e-6, `at half flattening the ${deepest} texels of the floor hold half the terrain's relief, to within ${off}`);
});
