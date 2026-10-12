// tests/nodes/ref/distance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, decimate, expectClose, expectLadder, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import { hashCell, hashUnit } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/ref/distance.ts';

/** What two levels of the ladder may differ by, as a part of the standard deviation: the default is 0.01. */
const LADDER_TOLERANCE = 0.03;

conformance(def, {
  resolutionTol: {
    value: LADDER_TOLERANCE,
    reason: 'Selects texels by a threshold: between two levels the edge of the selection moves by up to one coarse cell, and every distance with it. That is 0.5 % of the standard deviation around a disc and 1.3 % on a mask with many edges; the test below measures both.',
  },
});

/** The CPU reference: for every texel the nearest selected one, by trying them all. Sizes: 65 x 65 texels. */
function nearest(mask: FieldData): FieldData {
  const n = mask.width;
  const selected: number[] = [];
  for (let i = 0; i < n * n; i++) if (mask.data[i] >= 0.5) selected.push(i);
  const data = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    let best = Infinity;
    for (const s of selected) best = Math.min(best, ((i % n) - (s % n)) ** 2 + (Math.floor(i / n) - Math.floor(s / n)) ** 2);
    data[i] = Math.sqrt(best) / (n - 1);
  }
  return { ...mask, data };
}

/** A mask of 65 x 65 that selects the given share of its texels, each on its own. */
const speckle = (seed: number, share: number): FieldData =>
  fieldOf(65, (u, v) => (hashUnit(hashCell(Math.round(u * 64), Math.round(v * 64), seed)) < share ? 1 : 0));

test('ref/distance: from a single texel the distance is the length of the straight line to it', async () => {
  // The impulse is 1 at the centre texel, (128, 128) at 257. A length is a fraction of the terrain width.
  const { out } = await renderNode(def, { inputs: { in: 'impulse' } });
  expectClose(out, fieldOf(257, (u, v) => Math.hypot(u - 0.5, v - 0.5)), { max: 1e-6 });
  assert.equal(at(out, 128, 128), 0);
});

test('ref/distance: the distance is exact for any shape of the selection', async () => {
  // Broad areas with curved edges, a disc, a third of all texels one by one, and a handful of lone texels.
  for (const mask of [fixtures.terrain(65), fixtures.cone(65), speckle(7, 1 / 3), speckle(8, 0.002)]) {
    assert.ok(stats(mask).max >= 0.5 && stats(mask).min < 0.5, 'the mask selects some texels and not all');
    const { out } = await renderNode(def, { res: 65, inputs: { in: mask } });
    expectClose(out, nearest(mask), { max: 1e-6 });
  }
});

test('ref/distance: a texel is selected from 0.5 upwards, and the distance on it is 0', async () => {
  // Left of the middle column the mask is just below 0.5, from the middle column on it is 0.5 and more.
  const mask = fieldOf(257, (u) => (u < 0.5 ? 0.4999 : 0.5 + u));
  const { out } = await renderNode(def, { inputs: { in: mask } });
  expectClose(out, fieldOf(257, (u) => Math.max(0, 0.5 - u)), { max: 1e-6 });
  let nonzero = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] >= 0.5 && out.data[i] !== 0) nonzero++;
  assert.equal(nonzero, 0, 'selected texels with a distance other than 0');
});

test('ref/distance: with nothing selected the distance is the diagonal of the terrain everywhere, with everything selected 0', async () => {
  const none = await renderNode(def, { inputs: { in: 'zero' } });
  expectStats(none.out, { min: Math.SQRT2, max: Math.SQRT2 });
  const all = await renderNode(def, { inputs: { in: 'one' } });
  expectStats(all.out, { min: [0, 0], max: [0, 0] });
});

test('ref/distance: between two levels of the ladder a distance changes by at most one coarse cell, which is what the tolerance is for', async () => {
  // A finer level selects every texel the coarser one selects and some between them, so its distances are the
  // shorter ones. The disc is the mask fixture; the terrain fixture as a mask selects areas with long edges.
  const share: Record<string, number> = {};
  for (const mask of ['mask', 'terrain'] as const) {
    const levels = await renderLadder(def, { inputs: { in: mask } });
    const coarse = levels[257].out, fine = decimate(levels[513].out);
    let longer = 0;
    for (let i = 0; i < coarse.data.length; i++) if (fine.data[i] > coarse.data[i] + 1e-6) longer++;
    assert.equal(longer, 0, `${mask}: distances that are longer at 513 than at 257`);
    share[mask] = expectLadder(coarse, levels[513].out, { max: 1 / 256 + 1e-6, rel: LADDER_TOLERANCE }).rel;
  }
  assert.ok(share.mask > 0 && share.mask < 0.01, `around the disc the levels differ by ${share.mask} of the standard deviation`);
  assert.ok(share.terrain > 0.01, `on a mask with many edges the levels differ by ${share.terrain} of the standard deviation: the default tolerance does not cover it`);
});
