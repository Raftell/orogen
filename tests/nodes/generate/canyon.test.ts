// tests/nodes/generate/canyon.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectStats, renderNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/canyon.ts';
import { mapField, share } from './_land-probe.ts';

conformance(def);

/** The gentle roll of the plateau: 0.035 at most, and 0.3 of that on a canyon floor. */
const ROLL = 0.035;

/** The part of the terrain that lies in a canyon: lower than the plateau at 0.5 + depth / 2 by more than a tenth of the depth. */
const canyonShare = (out: FieldData, depth: number): number => share(out, (value) => value < 0.5 + 0.5 * depth - 0.1 * depth - ROLL);

test('generate/canyon: the plateau lies half the depth above the middle height and the main canyon floor half the depth below', async () => {
  for (const [seed, depth] of [[0, 0.55], [1, 0.55], [2, 0.3]] as const) {
    const { out } = await renderNode(def, { params: { seed, depth } });
    expectStats(out, {
      min: [0.5 - 0.5 * depth - 0.3 * ROLL, 0.5 - 0.5 * depth + 0.3 * ROLL],
      max: [0.5 + 0.5 * depth, 0.5 + 0.5 * depth + ROLL],
    });
    // Most of the terrain is plateau.
    assert.ok(share(out, (value) => value > 0.5 + 0.5 * depth - ROLL) > 0.3, `seed ${seed}: the plateau takes less than 0.3 of the terrain`);
    assert.ok(canyonShare(out, depth) > 0.05, `seed ${seed}: canyons take less than 0.05 of the terrain`);
  }
  const flat = await renderNode(def, { params: { depth: 0 } });
  expectStats(flat.out, { min: [0.5 - ROLL, 0.5], max: [0.5, 0.5 + ROLL] });
});

/**
 * The benches in the walls: the heights between the floor of the main canyon and the plateau at which ground
 * gathers. A bench is gentle and takes much ground for its height, a cliff little: over the heights, the
 * ground lies in as many heaps as the walls have benches.
 */
function benches(out: FieldData, depth: number, levels: number): number {
  const top = 0.5 + 0.5 * depth - ROLL, bottom = 0.5 - 0.5 * depth + 0.3 * ROLL;
  const bins = 24 * levels;
  const heap = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < out.data.length; i++) {
    const t = (out.data[i]! - bottom) / (top - bottom);
    if (t <= 0.02 || t >= 0.98) continue;
    heap[Math.min(Math.floor(t * bins), bins - 1)]!++;
    total++;
  }
  // A heap begins where a band of heights holds a quarter more ground than the mean and ends where one holds a fifth less.
  const mean = total / bins;
  let count = 0, inHeap = false;
  for (let k = 0; k < bins; k++) {
    if (heap[k]! > 1.25 * mean) {
      if (!inHeap) count++;
      inHeap = true;
    } else if (heap[k]! < 0.8 * mean) inHeap = false;
  }
  return count;
}

test('generate/canyon: the walls step down through as many beds as there are terraces, each a cliff above a bench', async () => {
  // The main canyon alone, wide, without side gullies: its walls are all the ground between plateau and floor.
  for (const seed of [0, 1, 2]) {
    const counts: number[] = [];
    for (const levels of [1, 2, 4, 8]) {
      const { out } = await renderNode(def, { res: 513, params: { seed, levels, depth: 0.6, width: 0.5, branching: 0, erosion: 0 } });
      counts.push(benches(out, 0.6, levels));
    }
    // Beds differ in thickness, and a thin one may not show apart from its neighbor at this resolution.
    assert.ok(counts[0] === 1 && counts[1] === 2, `seed ${seed}: walls of 1 and 2 beds show ${counts[0]} and ${counts[1]} benches`);
    assert.ok(Math.abs(counts[2]! - 4) <= 1 && counts[3]! >= 6 && counts[3]! > counts[2]!, `seed ${seed}: walls of 4 and 8 beds show ${counts[2]} and ${counts[3]} benches`);
  }
});

test('generate/canyon: erosion cuts side gullies that scallop the walls, and leaves the plateau and the floors where they are', async () => {
  const depth = 0.55, plateau = 0.5 + 0.5 * depth, floor = 0.5 - 0.5 * depth;
  // The line along which the walls pass the middle height: land texels above it with a neighbor at or below it.
  const contour = (out: FieldData): number => {
    let count = 0;
    for (let y = 1; y < out.height - 1; y++) {
      for (let x = 1; x < out.width - 1; x++) {
        if (at(out, x, y) > 0.5 && (at(out, x - 1, y) <= 0.5 || at(out, x + 1, y) <= 0.5 || at(out, x, y - 1) <= 0.5 || at(out, x, y + 1) <= 0.5)) count++;
      }
    }
    return count;
  };
  for (const seed of [0, 1]) {
    const smooth = await renderNode(def, { res: 513, params: { seed, erosion: 0 } });
    const cut = await renderNode(def, { res: 513, params: { seed, erosion: 1 } });
    assert.ok(contour(cut.out) > 1.15 * contour(smooth.out), `seed ${seed}: the walls pass the middle height along ${contour(cut.out)} texels with erosion and ${contour(smooth.out)} without`);
    const onPlateau = (out: FieldData): number => share(out, (value) => value > plateau - ROLL);
    const onFloor = (out: FieldData): number => share(out, (value) => value < floor + 0.02 * depth);
    assert.ok(Math.abs(onPlateau(cut.out) - onPlateau(smooth.out)) < 0.01, `seed ${seed}: the plateau takes ${onPlateau(cut.out)} of the terrain with erosion and ${onPlateau(smooth.out)} without`);
    assert.ok(Math.abs(onFloor(cut.out) - onFloor(smooth.out)) < 0.01, `seed ${seed}: the main floor takes ${onFloor(cut.out)} with erosion and ${onFloor(smooth.out)} without`);
    expectStats(cut.out, { min: [floor - 0.3 * ROLL, floor + 0.3 * ROLL], max: [plateau, plateau + ROLL] });
  }
});

test('generate/canyon: more branching and more width give more canyon', async () => {
  const branches: number[] = [];
  for (const branching of [0, 0.5, 1]) branches.push(canyonShare((await renderNode(def, { params: { branching } })).out, 0.55));
  assert.ok(branches[0]! > 0.01, 'the main canyon alone crosses the terrain');
  assert.ok(branches[0]! < branches[1]! && branches[1]! < branches[2]!, `canyons take ${branches.join(', ')} of the terrain at branching 0, 0.5 and 1`);
  const narrow = canyonShare((await renderNode(def, { params: { width: 0.06 } })).out, 0.55);
  const wide = canyonShare((await renderNode(def, { params: { width: 0.24 } })).out, 0.55);
  assert.ok(wide > 2 * narrow, `canyons take ${wide} of the terrain at width 0.24 and ${narrow} at 0.06`);
});

test('generate/canyon: a larger spacing sets fewer canyons across the terrain', async () => {
  // Rims crossed along the rows of the terrain: places where the ground leaves the plateau.
  const rims = async (size: number): Promise<number> => {
    const { out } = await renderNode(def, { params: { size, width: 0.05, branching: 1 } });
    const low = (x: number, y: number): boolean => at(out, x, y) < 0.5 + 0.275 - 0.1;
    let count = 0;
    for (let y = 0; y <= 256; y += 8) for (let x = 1; x <= 256; x++) if (low(x, y) && !low(x - 1, y)) count++;
    return count;
  };
  const [close, apart] = [await rims(0.12), await rims(0.4)];
  assert.ok(close > 2 * apart, `${close} canyons are crossed at spacing 0.12 and ${apart} at 0.4`);
});

test('generate/canyon: the depth scales the cut and leaves the network where it is', async () => {
  // out = 0.5 + depth / 2 - depth * cut + roll, with the cut and the roll the same at any depth: the height is
  // linear in the depth, so the canyon at depth 0.6 is as far from that at 0.3 as that is from the bare plateau.
  const bare = await renderNode(def, { params: { depth: 0 } });
  const shallow = await renderNode(def, { params: { depth: 0.3 } });
  const deep = await renderNode(def, { params: { depth: 0.6 } });
  expectClose(deep.out, mapField(shallow.out, (value, x, y) => 2 * value - at(bare.out, x, y)), { max: 1e-6 });
  assert.ok(canyonShare(deep.out, 0.6) > 0.05 && Math.abs(canyonShare(deep.out, 0.6) - canyonShare(shallow.out, 0.3)) < 0.05, 'the canyons take the same ground at either depth');
});
