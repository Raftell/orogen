// tests/nodes/select/distance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectLadder, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import { hashCell, hashUnit } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/select/distance.ts';

conformance(def);

const saturate = (v: number): number => Math.min(1, Math.max(0, v));

/** A hard mask: 1 on the texels up to column 128 of 257, 0 beyond. Its edge lies half-way between 128 and 129. */
const half = fieldOf(257, (u) => (Math.round(u * 256) <= 128 ? 1 : 0));
/** The distance of column x from that edge, as a length. */
const fromHalf = (x: number): number => Math.abs(x - 128.5) / 256;

/**
 * The pieces of a mask's edge, in texels: in every cell of four texels the straight lines between the points
 * where the mask crosses 0.5 on the cell's sides. A cell crossed on all four sides holds two, and its middle,
 * the mean of its corners, decides which corners they cut off.
 */
function pieces(mask: FieldData): [number, number, number, number][] {
  const n = mask.width;
  const m = (x: number, y: number): number => saturate(mask.data[y * n + x]);
  const along = (a: number, b: number): number => saturate((0.5 - a) / (b - a));
  const out: [number, number, number, number][] = [];
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v00 = m(x, y), v10 = m(x + 1, y), v01 = m(x, y + 1), v11 = m(x + 1, y + 1);
      const i00 = v00 >= 0.5, i10 = v10 >= 0.5, i01 = v01 >= 0.5, i11 = v11 >= 0.5;
      const side: ([number, number] | null)[] = [
        i00 !== i10 ? [x + along(v00, v10), y] : null,
        i10 !== i11 ? [x + 1, y + along(v10, v11)] : null,
        i01 !== i11 ? [x + along(v01, v11), y + 1] : null,
        i00 !== i01 ? [x, y + along(v00, v01)] : null,
      ];
      const crossed = side.filter((s) => s !== null);
      if (crossed.length === 2) out.push([...crossed[0]!, ...crossed[1]!]);
      if (crossed.length === 4) {
        const pairs = (v00 + v10 + v01 + v11) / 4 >= 0.5 === i00 ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];
        for (const [a, b] of pairs) out.push([...side[a]!, ...side[b]!]);
      }
    }
  }
  return out;
}

/** The CPU reference: for every texel the distance to the nearest piece of the edge, by trying them all. Sizes: 65 x 65 texels. */
function nearest(mask: FieldData): Float64Array {
  const n = mask.width;
  const edge = pieces(mask);
  const out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let best = Infinity;
      for (const [ax, ay, bx, by] of edge) {
        const abx = bx - ax, aby = by - ay;
        const t = saturate(((x - ax) * abx + (y - ay) * aby) / Math.max(abx * abx + aby * aby, 1e-12));
        best = Math.min(best, (x - ax - t * abx) ** 2 + (y - ay - t * aby) ** 2);
      }
      out[y * n + x] = Math.sqrt(best) / (n - 1);
    }
  }
  return out;
}

test('select/distance: raw is the length of the straight line to the edge, which lies between the texels of its two sides', async () => {
  const both = await renderNode(def, { inputs: { in: half }, params: { mode: 'both' } });
  expectClose(both.raw, fieldOf(257, (u) => fromHalf(Math.round(u * 256))), { max: 1e-6 });
  // Outside measures from the selection outwards and is 0 on it; inside the other way round.
  const outside = await renderNode(def, { inputs: { in: half }, params: { mode: 'outside' } });
  expectClose(outside.raw, fieldOf(257, (u) => (Math.round(u * 256) <= 128 ? 0 : fromHalf(Math.round(u * 256)))), { max: 1e-6 });
  const inside = await renderNode(def, { inputs: { in: half }, params: { mode: 'inside' } });
  expectClose(inside.raw, fieldOf(257, (u) => (Math.round(u * 256) <= 128 ? fromHalf(Math.round(u * 256)) : 0)), { max: 1e-6 });
});

test('select/distance: the mask fades over the distance from the edge: outwards, inwards, or half of it to either side', async () => {
  // A distance of 0.0625 is 16 texels.
  const params = { distance: 0.0625 };
  const outside = (await renderNode(def, { inputs: { in: half }, params: { ...params, mode: 'outside' } })).out;
  expectClose(outside, fieldOf(257, (u) => (Math.round(u * 256) <= 128 ? 1 : saturate(1 - fromHalf(Math.round(u * 256)) / 0.0625))), { max: 1e-6 });
  const inside = (await renderNode(def, { inputs: { in: half }, params: { ...params, mode: 'inside' } })).out;
  expectClose(inside, fieldOf(257, (u) => (Math.round(u * 256) <= 128 ? saturate(fromHalf(Math.round(u * 256)) / 0.0625) : 0)), { max: 1e-6 });
  const both = (await renderNode(def, { inputs: { in: half }, params: { ...params, mode: 'both' } })).out;
  expectClose(both, fieldOf(257, (u) => saturate(0.5 + (128.5 - Math.round(u * 256)) / 256 / (2 * 0.0625))), { max: 1e-6 });
  // The selection itself stays selected when it is grown, and what is not selected stays out when it is shrunk.
  assert.equal(at(outside, 100, 9), 1);
  assert.equal(at(outside, 129 + 16, 9), 0);
  assert.equal(at(inside, 200, 9), 0);
  assert.equal(at(inside, 128 - 16, 9), 1);
  // Both is the mean of the other two.
  expectClose(both, fieldOf(257, (u, v) => 0.5 * (at(outside, Math.round(u * 256), Math.round(v * 256)) + at(inside, Math.round(u * 256), Math.round(v * 256)))), { max: 1e-6 });
});

test('select/distance: a soft edge is placed where the mask crosses 0.5, to a fraction of a texel', async () => {
  // A ramp 12.8 texels wide that crosses 0.5 at texel 128.3.
  const edgeAt = 128.3 / 256;
  const ramp = fieldOf(257, (u) => saturate(0.5 + 20 * (edgeAt - u)));
  const { raw } = await renderNode(def, { inputs: { in: ramp }, params: { mode: 'both' } });
  expectClose(raw, fieldOf(257, (u) => Math.abs(u - edgeAt)), { max: 1e-6 });
  // The disc of the mask fixture crosses 0.5 at a radius of 0.275. Its edge is measured as straight pieces a
  // texel long, which lie inside the circle by 0.002 of a texel.
  const disc = await renderNode(def, { inputs: { in: 'mask' }, params: { mode: 'both' } });
  expectClose(disc.raw, fieldOf(257, (u, v) => Math.abs(Math.hypot(u - 0.5, v - 0.5) - 0.275)), { max: 5e-5 });
});

test('select/distance: the distance is that to the nearest piece of the edge, whatever the shape of the mask', async () => {
  // Broad areas with curved edges, a disc with a soft edge, a third of all texels one by one, a handful of lone
  // texels, and rings three texels apart. The flood hands each texel a point of the edge near the nearest one
  // and the pieces around that point are measured; at most a texel in 200 has its nearest piece beyond them,
  // and is then too far by 0.04 of a texel, or by an eighth where edges lie three texels apart.
  const speckle = (seed: number, share: number): FieldData =>
    fieldOf(65, (u, v) => (hashUnit(hashCell(Math.round(u * 64), Math.round(v * 64), seed)) < share ? 1 : 0));
  const rings = fieldOf(65, (u, v) => 0.5 + 0.5 * Math.sin(130 * Math.hypot(u - 0.3, v - 0.4)));
  for (const mask of [fixtures.terrain(65), fixtures.mask(65), fixtures.cone(65), speckle(7, 1 / 3), speckle(8, 0.002), rings]) {
    assert.ok(stats(mask).max >= 0.5 && stats(mask).min < 0.5, 'the mask selects some texels and not all');
    const { raw } = await renderNode(def, { res: 65, inputs: { in: mask }, params: { mode: 'both' } });
    const expected = nearest(mask);
    let worst = 0, off = 0;
    for (let i = 0; i < expected.length; i++) {
      const error = Math.abs(raw.data[i] - expected[i]) * 64;   // in texels
      worst = Math.max(worst, error);
      if (error > 1e-3) off++;
      assert.ok(raw.data[i] >= expected[i] - 1e-6, 'no texel is nearer to the edge than its nearest piece');
    }
    assert.ok(worst <= 0.15, `the largest error is ${worst} texels`);
    assert.ok(off <= 0.005 * 65 * 65, `${off} of ${65 * 65} texels are off by more than a thousandth of a texel`);
  }
});

test('select/distance: a mask without an edge is all or nothing, at the longest distance there is', async () => {
  for (const mode of ['outside', 'inside', 'both'] as const) {
    const none = await renderNode(def, { inputs: { in: 'zero' }, params: { mode } });
    expectStats(none.out, { min: [0, 0], max: [0, 0] });
    const all = await renderNode(def, { inputs: { in: 'one' }, params: { mode } });
    expectStats(all.out, { min: [1, 1], max: [1, 1] });
    // The diagonal of the terrain, on the side the mode measures; 0 on the other.
    expectStats(none.raw, mode === 'inside' ? { min: [0, 0], max: [0, 0] } : { min: Math.SQRT2, max: Math.SQRT2 });
    expectStats(all.raw, mode === 'outside' ? { min: [0, 0], max: [0, 0] } : { min: Math.SQRT2, max: Math.SQRT2 });
  }
});

test('select/distance: shrinking a mask is growing what it leaves out', async () => {
  const mask = fixtures.terrain(257);
  const complement = fieldOf(257, (u, v) => 1 - at(mask, Math.round(u * 256), Math.round(v * 256)));
  const shrunk = await renderNode(def, { inputs: { in: mask }, params: { mode: 'inside' } });
  const grown = await renderNode(def, { inputs: { in: complement }, params: { mode: 'outside' } });
  expectClose(shrunk.out, fieldOf(257, (u, v) => 1 - at(grown.out, Math.round(u * 256), Math.round(v * 256))), { max: 1e-5 });
  expectClose(shrunk.raw, grown.raw, { max: 1e-6 });
});

test('select/distance: a distance of 0 leaves the hard edge of the mask, and inverting leaves raw alone', async () => {
  const mask = fixtures.terrain(257);
  for (const mode of ['outside', 'inside', 'both'] as const) {
    const { out } = await renderNode(def, { inputs: { in: mask }, params: { mode, distance: 0 } });
    expectIdentical(out, fieldOf(257, (u, v) => (at(mask, Math.round(u * 256), Math.round(v * 256)) >= 0.5 ? 1 : 0)));
  }
  const plain = await renderNode(def, { inputs: { in: mask } });
  const inverted = await renderNode(def, { inputs: { in: mask }, params: { invert: true } });
  expectClose(inverted.out, fieldOf(257, (u, v) => 1 - at(plain.out, Math.round(u * 256), Math.round(v * 256))), { max: 1e-6 });
  expectIdentical(inverted.raw, plain.raw);
});

test('select/distance: distances are lengths: they do not change with the size of the terrain or its height range', async () => {
  const base = await renderNode(def, { inputs: { in: 'mask' } });
  const scaled = await renderNode(def, { inputs: { in: 'mask' }, settings: { terrainSize: 16384, heightRange: 256 } });
  expectIdentical(scaled.out, base.out);
  expectIdentical(scaled.raw, base.raw);
});

test('select/distance: two levels of the ladder agree to a small part of a cell, in the mask and in raw', async () => {
  // The edge lies where the mask crosses 0.5, which is the same place at both levels: around the disc of the
  // mask fixture, and along the many edges of the terrain fixture read as a mask.
  for (const input of ['mask', 'terrain'] as const) {
    for (const mode of ['outside', 'both'] as const) {
      const levels = await renderLadder(def, { inputs: { in: input }, params: { mode } });
      expectLadder(levels[257].out, levels[513].out, { rel: 0.005 });
      // Nowhere by more than half a cell of the coarser level, where the finer one resolves a neck of the mask.
      expectLadder(levels[257].raw, levels[513].raw, { rel: 0.005, max: 0.5 / 256 });
    }
  }
});
