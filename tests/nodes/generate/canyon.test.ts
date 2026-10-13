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

test('generate/canyon: the walls climb in terraces, and floors and benches are level', async () => {
  // The cut below the plateau, as a part of the depth: with three terraces the ground gathers at 0, 1/3, 2/3 and 1.
  const depth = 0.6;
  const stepped = async (levels: number): Promise<number> => {
    const { out } = await renderNode(def, { params: { levels, depth, width: 0.3 } });
    // A tenth of the wall is left unstepped, and the plateau rolls by up to ROLL: within 0.07 of a level counts.
    return share(out, (value) => {
      const cut = (0.5 + 0.5 * depth - value) / depth * 3;
      return Math.abs(cut - Math.round(cut)) < 0.07 * 3;
    });
  };
  const [three, sixteen] = [await stepped(3), await stepped(16)];
  // The cliffs between the benches take 38 % of each climb and a tenth of the wall is left unstepped; the rest of
  // the terrain is level ground at one of the four heights. With sixteen terraces the walls pass through
  // those heights like any other.
  assert.ok(three > 0.75, `with 3 terraces ${three} of the terrain lies at one of their levels`);
  assert.ok(three > sixteen + 0.02, `with 16 terraces ${sixteen} lies at the levels of 3, against ${three} with 3`);
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
