// tests/nodes/generate/dunes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectStats, fieldOf, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/dunes.ts';
import { mapField, mean, ring, share } from './_land-probe.ts';

conformance(def, {
  skip: {
    'generator-range': 'Dunes are low relief by nature: at the default height of 0.07 the field spans 0.06, and a slip face at the angle of repose allows no more for dunes this far apart. The tests below hold the range to 0..height.',
  },
});

/** Where along its wavelength a transverse dune has its crest. */
const CREST = 0.74;

/** The profile of a transverse dune at the position u = 0..1 along its wavelength, downwind. */
function ridge(u: number): number {
  const up = Math.sin(0.5 * Math.PI * Math.min(u / CREST, 1));
  return Math.min(up ** 1.3, Math.min((1 - u) / (1 - CREST), 1));
}

/** The steps from each texel to its neighbour at +X, the downwind direction at a wind direction of 0. */
function stepsDownwind(f: FieldData): number[] {
  const steps: number[] = [];
  for (let y = 0; y < f.height; y++) for (let x = 0; x + 1 < f.width; x++) steps.push(at(f, x + 1, y) - at(f, x, y));
  return steps;
}

/** Of the steepest `part` of the steps, the part that goes down. */
function descents(steps: readonly number[], part: number): number {
  const sorted = steps.map(Math.abs).sort((a, b) => b - a);
  const threshold = sorted[Math.floor(part * sorted.length)]!;
  let steep = 0, down = 0;
  for (const step of steps) {
    if (Math.abs(step) < threshold || step === 0) continue;
    steep++;
    if (step < 0) down++;
  }
  return down / Math.max(steep, 1);
}

test('generate/dunes: regular transverse dunes are one profile repeated downwind: a long windward slope, a short slip face', async () => {
  // Wind towards +X, 8 dunes across the terrain, no irregularity: every row is the same.
  const params = { angle: 0, size: 0.125, height: 0.1, irregularity: 0 };
  const { out } = await renderNode(def, { params });
  const expected = fieldOf(257, (u) => {
    const along = (u - 0.5) / 0.125;
    return 0.1 * ridge(along - Math.floor(along));
  });
  expectClose(out, expected, { max: 1e-5 });
  expectStats(out, { min: [0, 1e-6], max: [0.099, 0.1] });

  // The slip face takes about a quarter of the wavelength, and is the steepest ground by far.
  const steps = stepsDownwind(out);
  const falling = steps.filter((step) => step < 0).length / steps.length;
  assert.ok(Math.abs(falling - (1 - CREST)) < 0.04, `${falling} of the ground falls downwind; the slip face is ${1 - CREST} of a wavelength`);
  const steepestRise = Math.max(...steps.slice(0, 256)), steepestFall = -Math.min(...steps.slice(0, 256));
  assert.ok(steepestFall > 1.7 * steepestRise, `the slip face falls ${steepestFall} a texel, the windward slope rises ${steepestRise} at most`);
});

test('generate/dunes: the dune spacing is the distance from crest to crest, and the height that of the crests', async () => {
  for (const size of [0.25, 0.0625]) {
    const { out } = await renderNode(def, { params: { angle: 0, size, height: 0.08, irregularity: 0 } });
    let crests = 0;
    for (let x = 1; x < 256; x++) if (at(out, x, 128) > at(out, x - 1, 128) && at(out, x, 128) >= at(out, x + 1, 128)) crests++;
    assert.equal(crests, 1 / size, `crests along a row at spacing ${size}`);
  }
  const low = await renderNode(def, { params: { height: 0.04 } });
  const high = await renderNode(def, { params: { height: 0.08 } });
  expectClose(mapField(low.out, (value) => 2 * value), high.out, { max: 1e-6 });
  expectStats(high.out, { min: [0, 1e-6], max: [0.5 * 0.08, 0.08] });
});

test('generate/dunes: the slip faces look the way the wind blows', async () => {
  const regular = { size: 0.125, irregularity: 0 };
  // Wind towards +Y: the field of wind towards +X, with rows and columns exchanged.
  const east = await renderNode(def, { params: { ...regular, angle: 0 } });
  const south = await renderNode(def, { params: { ...regular, angle: 90 } });
  expectClose(south.out, mapField(east.out, (_value, x, y) => at(east.out, y, x)), { max: 1e-6 });
  // Wind towards -X: the steep steps now rise towards +X.
  const west = await renderNode(def, { params: { ...regular, angle: 180 } });
  assert.ok(descents(stepsDownwind(east.out), 0.1) > 0.99, 'with the wind to +X the steepest ground falls towards +X');
  assert.ok(descents(stepsDownwind(west.out), 0.1) < 0.01, 'with the wind to -X the steepest ground rises towards +X');
});

test('generate/dunes: irregularity bends the crests and varies the dunes, and without it the field is exactly regular', async () => {
  // Along the crests, which run along Y when the wind blows to +X, a regular field does not change at all.
  const alongCrests = async (irregularity: number): Promise<number> => {
    const { out } = await renderNode(def, { params: { angle: 0, irregularity } });
    let worst = 0;
    for (let x = 0; x <= 256; x++) {
      let low = Infinity, high = -Infinity;
      for (let y = 0; y <= 256; y++) {
        low = Math.min(low, at(out, x, y));
        high = Math.max(high, at(out, x, y));
      }
      worst = Math.max(worst, high - low);
    }
    return worst;
  };
  assert.ok(await alongCrests(0) <= 1e-6, 'a regular field is the same along every crest');
  // A crest that bends by its own width takes a column from trough to crest.
  assert.ok(await alongCrests(1) > 0.7 * 0.07, 'an irregular field changes along the crests by most of the dune height');
});

test('generate/dunes: barchans are crescents on bare ground with their slip faces downwind', async () => {
  const { out } = await renderNode(def, { params: { mode: 'barchan', angle: 0, height: 0.1 } });
  expectStats(out, { min: [0, 0], max: [0.5 * 0.1, 0.1] });
  const bare = share(out, (value) => value === 0);
  assert.ok(bare > 0.3 && bare < 0.95, `${bare} of the terrain is bare ground between the dunes`);
  // The steepest ground is the slip face inside the crescent: it falls towards +X, the way the wind blows.
  assert.ok(descents(stepsDownwind(out), 0.02) > 0.9, `${descents(stepsDownwind(out), 0.02)} of the steepest steps fall downwind`);
  // Regular barchans are all the same dune, a place of 0.2375 apart: the top of each, the highest ground within
  // 12 texels, is equally high wherever the dune stands whole on the terrain.
  const ranks = await renderNode(def, { params: { mode: 'barchan', angle: 0, height: 0.1, irregularity: 0, size: 0.125 } });
  const tops: number[] = [];
  for (let y = 30; y <= 226; y++) {
    for (let x = 30; x <= 226; x++) {
      const value = at(ranks.out, x, y);
      if (value < 0.05) continue;
      let highest = true;
      for (let j = -12; j <= 12 && highest; j++) {
        for (let i = -12; i <= 12 && highest; i++) {
          const other = at(ranks.out, x + i, y + j);
          if (other > value || (other === value && (j < 0 || (j === 0 && i < 0)))) highest = false;
        }
      }
      if (highest) tops.push(value);
    }
  }
  assert.ok(tops.length >= 6, `${tops.length} whole dunes on the terrain`);
  assert.ok(Math.max(...tops) - Math.min(...tops) < 0.005, `regular dunes are between ${Math.min(...tops)} and ${Math.max(...tops)} high`);
});

test('generate/dunes: star dunes are peaks with three to five arms that fall away on every side', async () => {
  const { out } = await renderNode(def, { params: { mode: 'star', angle: 0, height: 0.1 } });
  expectStats(out, { min: [0, 0], max: [0.5 * 0.1, 0.1] });
  // No direction is the lee: the steepest ground falls one way as often as the other.
  const down = descents(stepsDownwind(out), 0.05);
  assert.ok(down > 0.3 && down < 0.7, `${down} of the steepest steps fall towards +X`);

  // Regular star dunes stand 2.1 spacings apart, each the full height less the tenth its drawn-out foot takes:
  // at a spacing of 1 / 8.4 they are a quarter of the terrain apart, with summits on texels 32, 96, 160 and 224.
  const regular = await renderNode(def, { params: { mode: 'star', angle: 0, height: 0.1, irregularity: 0, size: 1 / 8.4 } });
  const summit = 0.1 / 1.11;
  expectStats(regular.out, { min: [0, 1e-6], max: [summit - 1e-5, summit + 1e-5] });
  for (const y of [32, 96, 160, 224]) {
    for (const x of [32, 96, 160, 224]) {
      assert.ok(Math.abs(at(regular.out, x, y) - summit) <= 1e-5, `the dune at (${x}, ${y}) tops at ${at(regular.out, x, y)}, not at ${summit}`);
      // Around the summit the ground is lower, and lower again further out.
      const near = mean(ring(regular.out, x / 256, y / 256, 0.03)), far = mean(ring(regular.out, x / 256, y / 256, 0.06));
      assert.ok(near < 0.8 * summit && far < 0.8 * near, `around (${x}, ${y}) the ground is at ${near} and ${far}`);
      // A dune reaches 0.185 from its summit and its neighbours stand 0.25 away. A walk around it at 0.055, where
      // it stands alone, crosses each of its arms once: up through the mean height of the walk and down again.
      const around = ring(regular.out, x / 256, y / 256, 0.055, 720);
      const level = mean(around), margin = 0.1 * (Math.max(...around) - Math.min(...around));
      let arms = 0, below = around[around.length - 1]! < level;
      for (const value of [...around, ...around]) {
        if (below && value > level + margin) { arms++; below = false; }
        else if (!below && value < level - margin) below = true;
      }
      arms = Math.round(arms / 2);
      assert.ok(arms >= 3 && arms <= 5, `the dune at (${x}, ${y}) has ${arms} arms`);
    }
  }
});
