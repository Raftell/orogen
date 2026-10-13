// tests/nodes/generate/island.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectMask, expectStats, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/island.ts';
import { mapField, share } from './_land-probe.ts';

conformance(def, {
  skip: {
    'generator-range': 'Most of the terrain is seabed, which lies below the project sea level by design (0.25 in the test settings): the mean is 0.16 to 0.18 at the defaults. The tests below hold the range.',
  },
});

/** The sea level of the test settings. */
const SEA = 0.25;

/** The number of land texels that have water beside them: the length of the shore in texels. */
function shoreLength(water: FieldData): number {
  let count = 0;
  for (let y = 1; y < water.height - 1; y++) {
    for (let x = 1; x < water.width - 1; x++) {
      if (at(water, x, y) === 0 && (at(water, x - 1, y) === 1 || at(water, x + 1, y) === 1 || at(water, x, y - 1) === 1 || at(water, x, y + 1) === 1)) count++;
    }
  }
  return count;
}

test('generate/island: the water mask is the ground below sea level, and the shore lies at sea level', async () => {
  for (const [seed, seaLevel] of [[0, SEA], [1, SEA], [2, 0.4]] as const) {
    const { out, water } = await renderNode(def, { params: { seed }, settings: { seaLevel } });
    expectMask(water);
    let wrong = 0, lowestLand = Infinity, highestSea = -Infinity;
    for (let i = 0; i < out.data.length; i++) {
      const wet = water.data[i]!;
      if (wet !== 0 && wet !== 1) wrong++;
      if ((wet === 1) !== (out.data[i]! < seaLevel)) wrong++;
      if (wet === 0) lowestLand = Math.min(lowestLand, out.data[i]!);
      else highestSea = Math.max(highestSea, out.data[i]!);
    }
    assert.equal(wrong, 0, `seed ${seed}: texels where the mask and the height disagree about the sea`);
    // Land comes up from the waterline and the seabed goes down from it: both meet the sea level at the shore.
    assert.ok(lowestLand >= seaLevel && lowestLand < seaLevel + 0.01, `seed ${seed}: the lowest land is at ${lowestLand}, sea level ${seaLevel}`);
    assert.ok(highestSea < seaLevel && highestSea > seaLevel - 0.01, `seed ${seed}: the shallowest seabed is at ${highestSea}, sea level ${seaLevel}`);
    assert.ok(stats(out).min >= 0, 'the seabed is never below height 0');
  }
});

test('generate/island: the borders of the terrain are under water, whatever the size', async () => {
  for (const size of [0.6, 1.2, 2]) {
    const { water } = await renderNode(def, { params: { size, coast: 1 } });
    let dry = 0;
    for (let k = 0; k <= 256; k++) dry += 4 - at(water, k, 0) - at(water, k, 256) - at(water, 0, k) - at(water, 256, k);
    assert.equal(dry, 0, `at size ${size}: border texels that are land`);
    assert.ok(share(water, (value) => value === 0) > 0.1, `at size ${size} there is land`);
  }
});

test('generate/island: a larger size is more land, and the height lifts it further above the sea', async () => {
  const land = async (size: number): Promise<number> => share((await renderNode(def, { params: { size } })).water, (value) => value === 0);
  const [small, large] = [await land(0.3), await land(0.6)];
  // Twice the width is four times the area of the same island.
  assert.ok(large > 3 * small && large < 5 * small, `land takes ${large} of the terrain at size 0.6 and ${small} at 0.3`);

  const low = await renderNode(def, { params: { height: 0.3 } });
  const high = await renderNode(def, { params: { height: 0.6 } });
  // What is above the sea doubles; the seabed, and with it the mask, stays.
  expectClose(mapField(low.out, (value) => (value >= SEA ? SEA + 2 * (value - SEA) : value)), high.out, { max: 1e-6 });
  expectClose(low.water, high.water, { max: 0 });
  expectStats(high.out, { max: [SEA + 0.3, SEA + 0.6] });
});

test('generate/island: without irregularity the shore is a circle; with it the shore is longer', async () => {
  // Size 0.6: the unbroken shore lies 0.3 from the middle, 76.8 texels at 257.
  const round = await renderNode(def, { params: { coast: 0 } });
  let wrong = 0;
  for (let y = 0; y <= 256; y++) {
    for (let x = 0; x <= 256; x++) {
      const r = Math.hypot(x - 128, y - 128);
      if (Math.abs(r - 76.8) > 0.5 && (at(round.water, x, y) === 1) !== (r > 76.8)) wrong++;
    }
  }
  assert.equal(wrong, 0, 'texels of a round island on the wrong side of its shore');
  const ragged = await renderNode(def, { params: { coast: 1 } });
  assert.ok(shoreLength(ragged.water) > 1.5 * shoreLength(round.water), `the shore is ${shoreLength(ragged.water)} texels long at irregularity 1 and ${shoreLength(round.water)} at 0`);
});

test('generate/island: at a sea level of 0 the island stands on a level floor', async () => {
  const { out, water } = await renderNode(def, { settings: { seaLevel: 0 } });
  let wrong = 0;
  for (let i = 0; i < out.data.length; i++) if (water.data[i] === 1 ? out.data[i] !== 0 : out.data[i]! < 0) wrong++;
  assert.equal(wrong, 0, 'texels where the sea is not at height 0, or land lies below it');
  assert.ok(stats(out).max > 0.3, 'the land stands above the floor');
  // The same island as at any other sea level: the land is the sea level higher, the shore is where it was.
  const raised = await renderNode(def);
  expectClose(raised.water, water, { max: 0 });
  expectClose(mapField(raised.out, (value) => Math.max(value - SEA, 0)), out, { max: 1e-6 });
});

test('generate/island: the water alone is the water of the island', async () => {
  const both = await renderNode(def);
  const alone = await renderNode(def, { wants: ['water'] });
  expectClose(alone.water!, both.water, { max: 0 });
});
