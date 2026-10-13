// tests/nodes/generate/volcano.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectStats, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/volcano.ts';
import { deviation, mapField, mean, ring, share } from './_land-probe.ts';

conformance(def, {
  skip: {
    'generator-range': 'One cone on level ground at height 0: the ground and the low apron take most of the terrain, so the mean is 0.11 to 0.12 at the defaults. The tests below hold the range to 0..height.',
  },
});

test('generate/volcano: the rim is the highest ground, close under the height asked for, and the cone stands on level ground', async () => {
  for (const seed of [0, 1, 2]) {
    const { out } = await renderNode(def, { params: { seed } });
    // The height is the highest a rim can stand; where the rim wanders outwards it stands lower.
    expectStats(out, { min: [0, 0], max: [0.9 * 0.8, 0.8] });
  }
  // A base 0.5 wide, which the warp can move by a tenth of its radius.
  const { out } = await renderNode(def, { params: { size: 0.5 } });
  assert.equal(share(out, (value, x, y) => Math.hypot(x - 128, y - 128) > 0.3 * 256 && value !== 0), 0, 'texels off the ground farther than 0.3 from the center');
});

test('generate/volcano: the flank falls from the rim to the foot, and the crater lies inside the rim', async () => {
  // Defaults: the crater is 0.16 wide, so the rim lies 0.08 from the center, and the base radius is 0.45.
  const { out } = await renderNode(def);
  const heights = [0.08, 0.14, 0.22, 0.3, 0.38].map((radius) => mean(ring(out, 0.5, 0.5, radius)));
  for (let k = 1; k < heights.length; k++) {
    assert.ok(heights[k]! < heights[k - 1]!, `the mean height at ring ${k} is ${heights[k]}, not below ${heights[k - 1]} further in`);
  }
  assert.ok(at(out, 128, 128) < mean(ring(out, 0.5, 0.5, 0.08)) - 0.1, `the crater floor at ${at(out, 128, 128)} lies below the rim at ${heights[0]}`);
});

test('generate/volcano: the crater depth is how far the floor lies below the rim, and 0 leaves a level top', async () => {
  // The floor hangs from the rim above it, which wanders by up to 14 % of the crater's radius: with the defaults
  // that moves the rim's height by less than 0.06.
  for (const craterDepth of [0.1, 0.3]) {
    const { out } = await renderNode(def, { params: { craterDepth, erosion: 0 } });
    const below = stats(out).max - at(out, 128, 128);
    assert.ok(Math.abs(below - craterDepth) < 0.07, `at depth ${craterDepth} the floor lies ${below} below the highest rim`);
  }
  const { out } = await renderNode(def, { params: { craterDepth: 0, erosion: 0 } });
  assert.ok(stats(out).max - at(out, 128, 128) < 0.07, 'without depth the top is level with the rim');
  // A crater deeper than the cone is high goes down to the ground and no further.
  const pit = await renderNode(def, { params: { craterDepth: 1, height: 0.5, erosion: 0 } });
  assert.ok(Math.abs(at(pit.out, 128, 128)) < 0.05 * 0.5 && stats(pit.out).min >= 0, `the floor of a bottomless crater is at ${at(pit.out, 128, 128)}`);
});

test('generate/volcano: a wider crater moves the rim outwards', async () => {
  // The radius at which the mean height around the center is highest.
  const rimRadius = async (craterSize: number): Promise<number> => {
    const { out } = await renderNode(def, { params: { craterSize, erosion: 0 } });
    let best = 0, top = -1;
    for (let radius = 0.01; radius <= 0.4; radius += 0.005) {
      const height = mean(ring(out, 0.5, 0.5, radius));
      if (height > top) { top = height; best = radius; }
    }
    return best;
  };
  const [small, large] = [await rimRadius(0.12), await rimRadius(0.36)];
  assert.ok(Math.abs(small - 0.06) < 0.02, `a crater 0.12 wide has its rim ${small} from the center`);
  assert.ok(Math.abs(large - 0.18) < 0.03, `a crater 0.36 wide has its rim ${large} from the center`);
});

test('generate/volcano: erosion cuts gullies down the flank, and none into the crater', async () => {
  const smooth = await renderNode(def, { params: { erosion: 0 } });
  const cut = await renderNode(def, { params: { erosion: 1 } });
  // Around the cone at mid-flank the ground goes up and down across the gullies.
  const across = (radius: number): [number, number] => [deviation(ring(smooth.out, 0.5, 0.5, radius, 720)), deviation(ring(cut.out, 0.5, 0.5, radius, 720))];
  const [flankSmooth, flankCut] = across(0.2);
  assert.ok(flankCut > 1.5 * flankSmooth, `around the mid-flank the height varies by ${flankCut} with erosion and ${flankSmooth} without`);
  // Inside the crater, well within the rim at 0.08, nothing changes.
  let worst = 0;
  for (let y = 118; y <= 138; y++) for (let x = 118; x <= 138; x++) worst = Math.max(worst, Math.abs(at(cut.out, x, y) - at(smooth.out, x, y)));
  assert.ok(worst <= 1e-6, `the crater floor moved by ${worst}`);
});

test('generate/volcano: the height scales the cone and the center places it', async () => {
  const low = await renderNode(def, { params: { height: 0.4, craterDepth: 0.08 } });
  const high = await renderNode(def, { params: { height: 0.8, craterDepth: 0.16 } });
  expectClose(mapField(low.out, (value) => 2 * value), high.out, { max: 1e-6 });
  // Moved by a quarter of the terrain, 64 texels at 257, the cone is the same cone.
  const base = await renderNode(def, { params: { size: 0.4 } });
  const moved = await renderNode(def, { params: { size: 0.4, center: [0.75, 0.25] } });
  let worst = 0;
  for (let y = 64; y <= 192; y++) for (let x = 64; x <= 192; x++) worst = Math.max(worst, Math.abs(at(moved.out, x + 64, y - 64) - at(base.out, x, y)));
  assert.ok(worst <= 1e-6, `the moved cone differs by up to ${worst}; allowed 1e-6`);
});
