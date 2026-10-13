// tests/nodes/select/occlusion.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectLadder, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/select/occlusion.ts';

/** What two levels of the ladder may differ by, as a part of the standard deviation: the default is 0.01. */
const LADDER_TOLERANCE = 0.03;

conformance(def, {
  resolutionTol: {
    value: LADDER_TOLERANCE,
    reason: 'Looks out at distances that double from one texel: the finer level has one distance nearer, which the coarser has no texels for. On the terrain fixture the mask differs by 1.1 % of its standard deviation between 257 and 513 at the defaults and by 2.0 % at a radius of 0.01; the test below measures both.',
  },
});

// With the test settings the terrain is 4096 m wide and a height of 1 is 1024 m: a cell is 16 m at 257.
const TERRAIN = 4096, RANGE = 1024, CELL = 16;
/** The node's gain: an occlusion of 0.3 is fully selected at a strength of 0.5, and the strength acts as its cube. */
const gain = (strength: number): number => (2 * strength) ** 3 / 0.3;
/** The sine of the angle whose tangent is `rise`: what one hollow hides, 0 where the ground does not rise. */
const hidden = (rise: number): number => (rise > 0 ? rise / Math.sqrt(1 + rise * rise) : 0);
/**
 * The weight of a distance, in texels, at a radius in texels: the distances from a quarter of the radius to four
 * times the radius count, most at the radius itself, as sin^2 over the four doublings between them.
 */
function weight(distance: number, radius: number): number {
  const below = -Math.log2(distance / (4 * radius));
  return below <= 0 || below >= 4 ? 0 : Math.sin((Math.PI * below) / 4) ** 2;
}
/** The four axes a texel looks along, to both sides: their lengths in texels. */
const AXES = [1, Math.SQRT2, 1, Math.SQRT2];

/** One texel: the radius at which a texel at 257 looks one and two texels out and no farther, on the terrain itself. */
const ONE_TEXEL = 1 / 256;

test('select/occlusion: a pit is sheltered by the sines of the angles its rim stands above it, and the ground around it is not', async () => {
  // A pit one texel wide and 10.24 m deep. One texel out, along the two axes, the rim stands 10.24 m above it on
  // both sides: a tangent of 0.64; along the two diagonals, 22.63 m out, 0.4525. Two texels out, half of each.
  const depth = 0.01;
  const pit = fieldOf(257, (u, v) => (Math.round(u * 256) === 128 && Math.round(v * 256) === 128 ? 0.5 - depth : 0.5));
  let sum = 0;
  for (const reach of [1, 2]) {
    for (const axis of AXES) sum += 0.5 * 0.25 * weight(axis * reach, 1) * hidden((depth * RANGE) / (axis * reach * CELL));
  }
  assert.ok(Math.abs(sum - 0.2689) < 1e-3, `the pit hides ${sum} of its sky`);
  const { out } = await renderNode(def, { inputs: { in: pit }, params: { radius: ONE_TEXEL } });
  assert.ok(Math.abs(at(out, 128, 128) - sum * gain(0.5)) <= 1e-4, `the pit is ${at(out, 128, 128)}; expected ${sum * gain(0.5)}`);
  let around = 0;
  for (let i = 0; i < out.data.length; i++) if (i !== 128 * 257 + 128 && out.data[i] !== 0) around++;
  assert.equal(around, 0, 'texels around the pit that are selected');
  // A spike is the pit upside down: nothing of it is sheltered.
  const spike = fieldOf(257, (u, v) => (Math.round(u * 256) === 128 && Math.round(v * 256) === 128 ? 0.5 + depth : 0.5));
  const upside = (await renderNode(def, { inputs: { in: spike }, params: { radius: ONE_TEXEL } })).out;
  assert.equal(at(upside, 128, 128), 0, 'the tip of the spike');
  // Beside the spike the ground has it on one side only, and that is half a hollow.
  assert.ok(at(upside, 129, 128) > 0 && at(upside, 129, 128) < at(out, 128, 128));
});

test('select/occlusion: the foot of a step is sheltered, its top and its edge are not', async () => {
  // A plateau 32 m high (0.03125) over the texels up to column 100, level ground beyond.
  const height = 0.03125;
  const step = fieldOf(257, (u) => (Math.round(u * 256) <= 100 ? height : 0));
  const { out } = await renderNode(def, { inputs: { in: step }, params: { radius: ONE_TEXEL } });
  // The texel at the foot has the wall one texel away on one side, along the axis across it and along both
  // diagonals, and level ground on the other: half the rise of a hollow. Two texels out likewise.
  const rise = (distance: number): number => (height * RANGE) / (2 * distance * CELL);
  const foot = 0.5 * 0.25 * (weight(1, 1) * hidden(rise(1)) + 2 * weight(Math.SQRT2, 1) * hidden(rise(Math.SQRT2))
    + weight(2, 1) * hidden(rise(2)) + 2 * weight(2 * Math.SQRT2, 1) * hidden(rise(2 * Math.SQRT2)));
  // The next texel sees the wall two texels out only.
  const next = 0.5 * 0.25 * (weight(2, 1) * hidden(rise(2)) + 2 * weight(2 * Math.SQRT2, 1) * hidden(rise(2 * Math.SQRT2)));
  for (const y of [5, 128, 250]) {
    assert.ok(Math.abs(at(out, 101, y) - foot * gain(0.5)) <= 1e-4, `the foot is ${at(out, 101, y)}; expected ${foot * gain(0.5)}`);
    assert.ok(Math.abs(at(out, 102, y) - next * gain(0.5)) <= 1e-4, `the texel beside it is ${at(out, 102, y)}; expected ${next * gain(0.5)}`);
    for (const x of [0, 50, 98, 99, 100, 103, 104, 200, 256]) assert.equal(at(out, x, y), 0, `the texel at ${x}`);
  }
  assert.ok(foot > 2 * next && next > 0);
});

/** The paraboloid k * ((u - 0.5)^2 + (v - 0.5)^2): a bowl for k above 0, a dome below. */
const paraboloid = (res: number, k: number): FieldData => fieldOf(res, (u, v) => k * ((u - 0.5) ** 2 + (v - 0.5) ** 2));

test('select/occlusion: in a bowl every distance finds the same hollow everywhere: the mask is the sum over the distances that count', async () => {
  // Along any axis the two ends of a paraboloid a r^2 stand a d^2 above the middle, d metres out, wherever the
  // middle is: a tangent of a d. Reduced, the bowl is the same bowl, so every reach finds exactly that on its
  // own level. With a = k * RANGE / TERRAIN^2 and k = 1 the bowl is gentle enough not to be fully selected.
  const a = RANGE / TERRAIN ** 2;
  for (const radius of [0.004, 0.02, 0.06]) {
    const texels = radius * 256;
    let sum = 0;
    for (let reach = 1; reach <= 4096; reach *= 2) {
      for (const axis of AXES) sum += 0.5 * 0.25 * weight(axis * reach, texels) * hidden(a * axis * reach * CELL);
    }
    const { out } = await renderNode(def, { inputs: { in: paraboloid(257, 1) }, params: { radius, strength: 1 } });
    assert.ok(sum * gain(1) > 0.01 && sum * gain(1) < 1, `radius ${radius}: the bowl hides ${sum}`);
    // Away from the border, by the farthest reach: nearer to it a reach is as long as the terrain is on both sides.
    const margin = Math.min(Math.ceil(8 * texels) + 4, 100);
    let worst = 0;
    for (let y = margin; y <= 256 - margin; y++) for (let x = margin; x <= 256 - margin; x++) worst = Math.max(worst, Math.abs(at(out, x, y) - sum * gain(1)));
    assert.ok(worst <= 2e-3, `radius ${radius}: the mask differs from ${sum * gain(1)} by ${worst}`);
    // The dome is the bowl upside down: no ground stands above any of it.
    expectStats((await renderNode(def, { inputs: { in: paraboloid(257, -1) }, params: { radius, strength: 1 } })).out, { min: [0, 0], max: [0, 0] });
  }
});

test('select/occlusion: a slope is not sheltered by being steep, up to its border and at any radius', async () => {
  const rise = 4 * Math.tan((50 * Math.PI) / 180);
  const plane = fieldOf(257, (u, v) => rise * (0.4 * u + 0.9 * v));
  for (const radius of [ONE_TEXEL, 0.01, 0.04, 0.25]) {
    // Full strength: 27 times the occlusion. What is left is the rounding of heights near 4 in float32.
    expectStats((await renderNode(def, { inputs: { in: plane }, params: { radius, strength: 1 } })).out, { min: [0, 2e-3], max: [0, 2e-3] });
  }
  expectStats((await renderNode(def, { inputs: { in: 'one' }, params: { strength: 1 } })).out, { min: [0, 0], max: [0, 0] });
});

test('select/occlusion: a valley that runs out of the terrain is sheltered up to the border', async () => {
  // The notch fixture: a V-shaped channel along the middle row, from one border to the other, in a tilted plane.
  // On the border the hollow is that of the one axis that runs along it, across the channel, and no less than
  // the mean of the four axes inside; faded out with the room there is, it would be a quarter of it.
  for (const radius of [0.01, 0.04, 0.1]) {
    const { out } = await renderNode(def, { inputs: { in: 'notch' }, params: { radius } });
    const inside = at(out, 128, 128);
    assert.ok(inside > 0.1 && inside < 0.5, `radius ${radius}: the floor of the channel is ${inside} inside the terrain`);
    for (const x of [0, 1, 2, 4, 8, 16, 32, 224, 248, 252, 255, 256]) {
      assert.ok(at(out, x, 128) >= inside - 1e-3 && at(out, x, 128) <= 1.7 * inside, `radius ${radius}: the floor is ${at(out, x, 128)} at column ${x} and ${inside} inside`);
    }
    // Beside the channel the plane is not sheltered, on the border either.
    for (const x of [0, 3, 128, 256]) assert.ok(at(out, x, 40) <= 1e-3, `radius ${radius}: the plane at column ${x} is ${at(out, x, 40)}`);
  }
  // A channel that runs into two corners, where no axis has ground on both sides.
  const diagonal = fieldOf(257, (u, v) => 0.3 + 0.3 * Math.abs(u - v));
  const { out } = await renderNode(def, { inputs: { in: diagonal } });
  for (const i of [0, 1, 2, 8, 250, 255, 256]) assert.ok(at(out, i, i) > 0.5 * at(out, 128, 128), `the floor is ${at(out, i, i)} at (${i}, ${i}) and ${at(out, 128, 128)} inside`);
});

test('select/occlusion: the mask has no frame: along the border ground is sheltered as much as it is with more ground beyond', async () => {
  // The middle of a rough terrain, by itself and as part of the whole. With the same cell and the same heights
  // both are the same ground, and the whole knows what lies beyond the border of the part.
  const whole = await fixtures.fbm(513);
  const part = fieldOf(257, (u, v) => at(whole, 128 + Math.round(u * 256), 128 + Math.round(v * 256)));
  for (const radius of [0.01, 0.04]) {
    const settings = { heightRange: 2 * RANGE };
    const alone = (await renderNode(def, { inputs: { in: part }, params: { radius }, settings })).out;
    const within = (await renderNode(def, { res: 513, inputs: { in: whole }, params: { radius: radius / 2 }, settings: { ...settings, terrainSize: 2 * TERRAIN } })).out;
    let sumAlone = 0, sumWithin = 0, middle = 0;
    for (let y = 0; y < 257; y++) {
      for (let x = 0; x < 257; x++) {
        const fromBorder = Math.min(x, y, 256 - x, 256 - y);
        if (fromBorder < 3) {
          sumAlone += at(alone, x, y);
          sumWithin += at(within, 128 + x, 128 + y);
        }
        // Farther from the border than the farthest ground that counts, four radii, the two are the same mask.
        if (fromBorder > 6 * radius * 256) middle = Math.max(middle, Math.abs(at(alone, x, y) - at(within, 128 + x, 128 + y)));
      }
    }
    assert.ok(sumWithin > 300, `radius ${radius}: the border texels of the part add up to ${sumWithin} within the whole`);
    assert.ok(sumAlone > 0.8 * sumWithin && sumAlone < 1.25 * sumWithin, `radius ${radius}: along its border the part alone is sheltered ${sumAlone / sumWithin} times as much as within the whole`);
    assert.ok(middle <= 0.02, `radius ${radius}: away from the border the two differ by ${middle}`);
  }
});

test('select/occlusion: the radius is the distance of the ground that shelters: a narrow hollow and a wide valley', async () => {
  // Two round hollows 0.05 deep: one 0.01 wide at u = 0.25 and one 0.08 wide at u = 0.7.
  const hollows = fieldOf(257, (u, v) => 0.5
    - 0.05 * Math.exp(-((u - 0.25) ** 2 + (v - 0.5) ** 2) / (2 * 0.01 ** 2))
    - 0.05 * Math.exp(-((u - 0.7) ** 2 + (v - 0.5) ** 2) / (2 * 0.08 ** 2)));
  const near = (await renderNode(def, { inputs: { in: hollows }, params: { radius: 0.01 } })).out;
  const far = (await renderNode(def, { inputs: { in: hollows }, params: { radius: 0.1 } })).out;
  const narrow = [64, 128] as const, wide = [179, 128] as const;
  assert.ok(at(near, ...narrow) > 0.9, `at a radius of 0.01 the narrow hollow is ${at(near, ...narrow)}`);
  assert.ok(at(near, ...wide) < 0.1, `and the wide valley ${at(near, ...wide)}`);
  assert.ok(at(far, ...wide) > 3 * at(near, ...wide) && at(far, ...wide) > 0.1, `at a radius of 0.1 the wide valley is ${at(far, ...wide)}`);
  assert.ok(at(far, ...narrow) < 0.5 * at(near, ...narrow), `and the narrow hollow ${at(far, ...narrow)}`);
  // Level ground far from both is not sheltered at either radius.
  assert.equal(at(near, 128, 20), 0);
  assert.ok(at(far, 128, 10) < 0.01);
});

test('select/occlusion: a cone is sheltered around its foot and nowhere else', async () => {
  const { out } = await renderNode(def, { inputs: { in: 'cone' }, params: { radius: 0.02 } });
  // The foot is the circle 64 texels from the tip where the flank meets the floor.
  for (const [x, y] of [[192, 128], [64, 128], [128, 192], [128, 64], [173, 173], [83, 173]] as const) {
    assert.ok(at(out, x, y) > 0.3, `the foot at (${x}, ${y}) is ${at(out, x, y)}`);
  }
  assert.equal(at(out, 128, 128), 0, 'the tip');
  for (const [x, y] of [[158, 128], [128, 100], [108, 108]] as const) assert.ok(at(out, x, y) < 0.02, `the flank at (${x}, ${y}) is ${at(out, x, y)}`);
  assert.equal(at(out, 6, 6), 0, 'the floor far from the cone');
});

test('select/occlusion: the strength acts as its cube, and none selects nothing', async () => {
  const bowl = paraboloid(257, 0.5);
  const half = (await renderNode(def, { inputs: { in: bowl }, params: { radius: 0.02 } })).out;
  const full = (await renderNode(def, { inputs: { in: bowl }, params: { radius: 0.02, strength: 1 } })).out;
  assert.ok(stats(full).max < 1 && stats(half).max > 0);
  expectClose(full, fieldOf(257, (u, v) => 8 * at(half, Math.round(u * 256), Math.round(v * 256))), { max: 1e-4 });
  expectStats((await renderNode(def, { inputs: { in: 'terrain' }, params: { strength: 0 } })).out, { min: [0, 0], max: [0, 0] });
});

test('select/occlusion: the occlusion is physical: it follows the height range, and not the scale of the whole', async () => {
  // A gentle bowl: the angles its ground hides are all but proportional to the height range.
  const bowl = paraboloid(257, 0.25);
  const base = (await renderNode(def, { inputs: { in: bowl }, params: { radius: 0.02, strength: 1 } })).out;
  const tall = (await renderNode(def, { inputs: { in: bowl }, params: { radius: 0.02, strength: 1 }, settings: { heightRange: 2 * RANGE } })).out;
  assert.ok(Math.abs(at(tall, 128, 128) / at(base, 128, 128) - 2) <= 0.01, `the taller bowl has ${at(tall, 128, 128) / at(base, 128, 128)} times the mask`);
  // Twice the height range on twice the width is the same shape.
  const terrain = (await renderNode(def, { inputs: { in: 'terrain' } })).out;
  const scaled = (await renderNode(def, { inputs: { in: 'terrain' }, settings: { terrainSize: 2 * TERRAIN, heightRange: 2 * RANGE } })).out;
  expectClose(scaled, terrain, { max: 1e-5 });
});

test('select/occlusion: inverted, the mask is its complement: open ground', async () => {
  const plain = (await renderNode(def, { inputs: { in: 'terrain' } })).out;
  const inverted = (await renderNode(def, { inputs: { in: 'terrain' }, params: { invert: true } })).out;
  expectClose(inverted, fieldOf(257, (u, v) => 1 - at(plain, Math.round(u * 256), Math.round(v * 256))), { max: 1e-6 });
  assert.ok(stats(plain).max > 0.2 && stats(plain).min < 0.01, 'the fixture has sheltered ground and open ground');
  // A radius too small to reach any ground selects nothing, and inverted everything.
  expectStats((await renderNode(def, { inputs: { in: 'terrain' }, params: { radius: 0.0001 } })).out, { min: [0, 0], max: [0, 0] });
  expectStats((await renderNode(def, { inputs: { in: 'terrain' }, params: { radius: 0.0001, invert: true } })).out, { min: [1, 1], max: [1, 1] });
});

test('select/occlusion: two levels of the ladder agree at any radius', async () => {
  // The finer level looks the same distances out, each on the same grid the coarser level uses for it, and
  // one distance nearer that the coarser has no texels for.
  for (const radius of [0.01, 0.04, 0.15]) {
    const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius } });
    assert.ok(stats(levels[257].out).std > 0.05, `radius ${radius}: the mask has a standard deviation of ${stats(levels[257].out).std}`);
    expectLadder(levels[257].out, levels[513].out, { rel: LADDER_TOLERANCE });
  }
});
