// tests/nodes/generate/mountain-range.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectStats, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/mountain-range.ts';
import { mapField, meanStep, share } from './_land-probe.ts';

conformance(def, {
  skip: {
    'generator-range': 'One chain of peaks on level ground at height 0: the ground takes most of the terrain, so the mean is 0.04 to 0.06 at the defaults. The tests below hold the range to 0..height.',
  },
});

/** How far the ground above `level` spreads along x and along y: the standard deviation of its texels' positions, as lengths. */
function spread(f: FieldData, level: number): { x: number; y: number } {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      if (at(f, x, y) <= level) continue;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
    }
  }
  const last = f.width - 1;
  return { x: Math.sqrt(sxx / n - (sx / n) ** 2) / last, y: Math.sqrt(syy / n - (sy / n) ** 2) / last };
}

test('generate/mountain-range: the highest peak reaches the height asked for, and the ground beside the range is level at 0', async () => {
  for (const seed of [0, 1, 2]) {
    const { out } = await renderNode(def, { params: { seed } });
    // The smooth union of the crests that meet at a peak is corrected for four of them; a peak where a spur was
    // not drawn stands a little lower.
    expectStats(out, { min: [0, 0], max: [0.95 * 0.75, 0.75] });
  }
  // A range 0.3 wide along x: nothing rises farther than 0.3 from its axis.
  const { out } = await renderNode(def, { params: { size: 0.3 } });
  assert.equal(share(out, (value, _x, y) => Math.abs(y - 128) > 0.3 * 256 && value !== 0), 0, 'texels off the ground farther than 0.3 from the axis');
});

test('generate/mountain-range: the range is elongated along its direction', async () => {
  const along = spread((await renderNode(def)).out, 0.1);
  assert.ok(along.x > 2 * along.y, `at direction 0 the range spreads ${along.x} along x and ${along.y} along y`);
  // A quarter turn: texel (x, y) holds what texel (y, 256 - x) held, the direction of +X turned towards +Y.
  const base = await renderNode(def);
  const turned = await renderNode(def, { params: { angle: 90 } });
  expectClose(turned.out, mapField(base.out, (_value, x, y) => at(base.out, y, 256 - x)), { max: 1e-6 });
  const across = spread(turned.out, 0.1);
  assert.ok(across.y > 2 * across.x, `at direction 90 the range spreads ${across.y} along y and ${across.x} along x`);
});

test('generate/mountain-range: a longer range reaches further along its direction', async () => {
  const short = spread((await renderNode(def, { params: { length: 0.6 } })).out, 0.05);
  const long = spread((await renderNode(def, { params: { length: 1.2 } })).out, 0.05);
  assert.ok(long.x > 1.4 * short.x, `spread along x ${long.x} at length 1.2 against ${short.x} at 0.6`);
});

test('generate/mountain-range: a wider range has broader flanks', async () => {
  const narrow = spread((await renderNode(def, { params: { size: 0.3, length: 3 } })).out, 0.05);
  const wide = spread((await renderNode(def, { params: { size: 0.6, length: 3 } })).out, 0.05);
  assert.ok(wide.y > 1.5 * narrow.y, `spread across ${wide.y} at width 0.6 against ${narrow.y} at 0.3`);
});

test('generate/mountain-range: every peak is a summit of the crest', async () => {
  // Along the axis of a range that crosses the whole terrain, the highest ground of each column rises and falls
  // once per peak. Without erosion and at full sharpness the crest is clean enough to count.
  const summits = async (count: number): Promise<number> => {
    const { out } = await renderNode(def, { params: { count, length: 1.4, size: 0.5, erosion: 0, sharpness: 1 } });
    const crest: number[] = [];
    for (let x = 0; x <= 256; x++) {
      let top = 0;
      for (let y = 0; y <= 256; y++) top = Math.max(top, at(out, x, y));
      crest.push(top);
    }
    // A summit: higher than everything within 6 columns, and well above the ground.
    let found = 0;
    for (let x = 0; x <= 256; x++) {
      let isTop = crest[x]! > 0.2;
      for (let k = Math.max(0, x - 6); k <= Math.min(256, x + 6) && isTop; k++) if (crest[k]! > crest[x]!) isTop = false;
      if (isTop && (x === 0 || crest[x - 1]! < crest[x]!)) found++;
    }
    return found;
  };
  const few = await summits(3), many = await summits(9);
  assert.ok(few >= 2 && few <= 5, `a range of 3 peaks shows ${few} summits along its crest`);
  assert.ok(many >= 7 && many > few, `a range of 9 peaks shows ${many} summits along its crest`);
});

test('generate/mountain-range: the height scales the range, and erosion cuts into its flanks', async () => {
  const low = await renderNode(def, { params: { height: 0.375 } });
  const high = await renderNode(def, { params: { height: 0.75 } });
  expectClose(mapField(low.out, (value) => 2 * value), high.out, { max: 1e-6 });
  const smooth = await renderNode(def, { params: { erosion: 0 } });
  const cut = await renderNode(def, { params: { erosion: 1 } });
  assert.ok(meanStep(cut.out) > 1.2 * meanStep(smooth.out), `mean step ${meanStep(cut.out)} with erosion against ${meanStep(smooth.out)} without`);
  assert.ok(stats(cut.out).mean < stats(smooth.out).mean, 'erosion removes material');
});
