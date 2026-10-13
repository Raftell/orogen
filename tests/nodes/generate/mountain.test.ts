// tests/nodes/generate/mountain.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectStats, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/mountain.ts';
import { deviation, mapField, meanStep, ring, share } from './_land-probe.ts';

conformance(def, {
  skip: {
    'generator-range': 'One massif on level ground at height 0: the ground takes most of the terrain, so the mean is 0.08 to 0.11 at the defaults. The tests below hold the range to 0..height.',
  },
});

test('generate/mountain: the summit stands at the center, at the height asked for, and nothing is higher', async () => {
  for (const seed of [0, 1, 2]) {
    const { out } = await renderNode(def, { params: { seed } });
    assert.ok(Math.abs(at(out, 128, 128) - 0.9) <= 1e-6, `seed ${seed}: the center is at ${at(out, 128, 128)}, not at the height 0.9`);
    expectStats(out, { min: [0, 0], max: 0.9 });
  }
  // 0.25 and 0.75 of the width are texels 64 and 192 at 257.
  const moved = await renderNode(def, { params: { center: [0.25, 0.75], height: 0.6 } });
  assert.ok(Math.abs(at(moved.out, 64, 192) - 0.6) <= 1e-6, `the moved summit is at ${at(moved.out, 64, 192)}`);
  expectStats(moved.out, { max: 0.6 });
});

test('generate/mountain: beyond its foot the ground is level at exactly 0', async () => {
  // A base 0.4 wide: the crests end within 0.27 of the center, and the warp and the aprons add less than 0.1.
  for (const seed of [0, 1, 2]) {
    const { out } = await renderNode(def, { params: { size: 0.4, seed } });
    const far = share(out, (value, x, y) => Math.hypot(x - 128, y - 128) > 0.4 * 256 && value !== 0);
    assert.equal(far, 0, `seed ${seed}: texels off the ground farther than 0.4 from the center`);
    assert.ok(share(out, (value) => value > 0.01) > 0.03, `seed ${seed}: the massif takes its part of the terrain`);
    assert.ok(stats(out).min === 0, 'nothing lies below the ground');
  }
});

test('generate/mountain: the height scales the whole massif', async () => {
  const low = await renderNode(def, { params: { height: 0.45 } });
  const high = await renderNode(def, { params: { height: 0.9 } });
  expectClose(mapField(low.out, (value) => 2 * value), high.out, { max: 1e-6 });
});

test('generate/mountain: the base width scales the massif about its center', async () => {
  // Half the width: texel 128 + k of the small massif is texel 128 + 2k of the large one.
  const large = await renderNode(def, { params: { size: 0.9 } });
  const small = await renderNode(def, { params: { size: 0.45 } });
  let worst = 0;
  for (let y = 64; y <= 192; y++) {
    for (let x = 64; x <= 192; x++) worst = Math.max(worst, Math.abs(at(small.out, x, y) - at(large.out, 2 * x - 128, 2 * y - 128)));
  }
  assert.ok(worst <= 1e-6, `the two differ by up to ${worst}; allowed 1e-6`);
});

test('generate/mountain: stronger ridges stand higher above the valleys between them', async () => {
  // Around the summit, a quarter of the way to the foot, the ground goes up and down over crests and valleys.
  const around = async (ridges: number): Promise<number> => {
    const { out } = await renderNode(def, { params: { ridges, erosion: 0 } });
    return deviation(ring(out, 0.5, 0.5, 0.12));
  };
  const [faint, strong] = [await around(0), await around(1)];
  assert.ok(strong > 1.5 * faint, `the relief around the summit is ${strong} at ridges 1 against ${faint} at ridges 0`);
});

test('generate/mountain: erosion cuts gullies into the flanks and leaves the summit alone', async () => {
  const smooth = await renderNode(def, { params: { erosion: 0 } });
  const cut = await renderNode(def, { params: { erosion: 1 } });
  assert.ok(meanStep(cut.out) > 1.2 * meanStep(smooth.out), `mean step ${meanStep(cut.out)} with erosion against ${meanStep(smooth.out)} without`);
  assert.ok(Math.abs(at(cut.out, 128, 128) - at(smooth.out, 128, 128)) <= 1e-6, 'the summit keeps its height');
  // Gullies are cut below the uneroded flank far more than their crests stand above it.
  assert.ok(stats(cut.out).mean < stats(smooth.out).mean, 'erosion removes material');
});

test('generate/mountain: a sharper massif is slimmer under the same summit', async () => {
  const worn = await renderNode(def, { params: { sharpness: 0 } });
  const sharp = await renderNode(def, { params: { sharpness: 1 } });
  assert.ok(stats(sharp.out).mean < 0.8 * stats(worn.out).mean, `mean ${stats(sharp.out).mean} at sharpness 1 against ${stats(worn.out).mean} at 0`);
  expectStats(sharp.out, { max: 0.9 });
  expectStats(worn.out, { max: 0.9 });
});
