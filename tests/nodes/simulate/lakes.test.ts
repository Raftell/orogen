// tests/nodes/simulate/lakes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectIdentical, expectMask, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/simulate/lakes.ts';
import { neighbour, outletsOf, referenceRoute } from './_route-reference.ts';

conformance(def, {
  resolutionTol: {
    value: 0.15,
    reason: 'Water is a mask of 0 and 1: a spill level differs by up to 4e-4 between 257 and 513, and on a flat shore that moves the shoreline across texels that then differ by 1. Measured: 0.090 of the standard deviation for water, 0.007 for depth.',
  },
});

const SEA = 0.25;
const field = (like: FieldData, data: Float32Array): FieldData => ({ ...like, data });
/** Every lake kept, however small. */
const ALL = { minDepth: 0, minSize: 0 };

/** A plane that rises towards +x with two hollows: a pond at (0.25, 0.3) and a lake at (0.65, 0.6). */
const twoHollows = (res: number): FieldData => fieldOf(res, (u, v) =>
  0.5 + 0.2 * u - 0.03 * Math.exp(-((u - 0.25) ** 2 + (v - 0.3) ** 2) / 0.0008) - 0.25 * Math.exp(-((u - 0.65) ** 2 + (v - 0.6) ** 2) / 0.01));

test('simulate/lakes: the terrain passes through unchanged', async () => {
  const input = fixtures.terrain(257);
  const { out } = await renderNode(def, { inputs: { in: input } });
  expectIdentical(out, input);
});

test('simulate/lakes: with no threshold the surface is the terrain filled to where it spills, and water and depth follow from it', async () => {
  for (const name of ['terrain', 'cone'] as const) {
    const input = fixtures[name](257);
    const { water, depth, surface } = await renderNode(def, { inputs: { in: input }, params: ALL });
    const expected = referenceRoute({ height: input.data, res: 257, eps: 0, seaLevel: SEA, routing: 'none', seed: 0 }).filled;
    expectIdentical(surface, field(input, expected));
    let wrong = 0;
    for (let i = 0; i < expected.length; i++) {
      const lake = expected[i]! > input.data[i]!;
      if (water.data[i] !== (lake ? 1 : 0) || depth.data[i] !== Math.fround(expected[i]! - input.data[i]!)) wrong++;
    }
    assert.equal(wrong, 0, `${name}: texels whose water or depth is not that of the surface`);
  }
});

test('simulate/lakes: water is 0 or 1, depth is never below 0, a lake has one level and none of its texels is an outlet', async () => {
  const input = fixtures.terrain(257);
  const { water, depth, surface } = await renderNode(def, { inputs: { in: input } });
  expectMask(water);
  const outlet = outletsOf(input.data, 257, SEA);
  let between = 0, negative = 0, onOutlet = 0, tilted = 0, dry = 0, lake = 0;
  for (let i = 0; i < water.data.length; i++) {
    const w = water.data[i]!;
    if (w !== 0 && w !== 1) between++;
    if (depth.data[i]! < 0) negative++;
    if (w === 0) { if (depth.data[i] !== 0 || surface.data[i] !== input.data[i]) dry++; continue; }
    lake++;
    if (outlet[i]) onOutlet++;
    if (!(depth.data[i]! > 0) || surface.data[i] !== Math.fround(input.data[i]! + depth.data[i]!)) dry++;
    for (let k = 0; k < 2; k++) {
      const q = neighbour(i, k, 257);
      if (q >= 0 && water.data[q] === 1 && surface.data[q] !== surface.data[i]) tilted++;
    }
  }
  assert.equal(between, 0, 'texels of water that are neither 0 nor 1');
  assert.equal(negative, 0, 'texels with a depth below 0');
  assert.equal(dry, 0, 'texels whose depth or surface disagrees with water');
  assert.equal(onOutlet, 0, 'lake texels on the border ring or at or below the sea level');
  assert.equal(tilted, 0, 'neighbouring texels of one lake at different levels');
  assert.ok(lake > 0.005 * water.data.length, `the terrain fixture has lakes: ${lake} texels`);
});

test('simulate/lakes: a bowl is one lake up to its rim', async () => {
  // The border ring of the bowl is at 0.9 and its floor at 0.3.
  const { water, depth, surface } = await renderNode(def, { inputs: { in: 'bowl' } });
  expectStats(surface, { min: Math.fround(0.9), max: Math.fround(0.9) });
  assert.ok(Math.abs(at(depth, 128, 128) - 0.6) < 1e-6, `the lake is ${at(depth, 128, 128)} deep at the centre`);
  // Dry: the ring, and the texels beside its middles that are as high as it within float32.
  assert.ok(stats(water).mean > 0.98, `${stats(water).mean} of the bowl is water`);
  assert.equal(at(water, 0, 100), 0);
  assert.equal(at(water, 128, 128), 1);
});

test('simulate/lakes: the sea is no lake', async () => {
  // The hollow of the basin fixture reaches below the test sea level: its floor is sea, and what drains into
  // the sea holds no water of its own.
  const wet = await renderNode(def, { inputs: { in: 'basin' }, params: ALL });
  expectStats(wet.water, { min: [0, 0], max: [0, 0] });
  expectStats(wet.depth, { min: [0, 0], max: [0, 0] });
  expectIdentical(wet.surface, fixtures.basin(257));
  // With the sea below its floor the same hollow is a lake, level and inside the terrain.
  const dry = await renderNode(def, { inputs: { in: 'basin' }, settings: { seaLevel: 0 } });
  assert.equal(at(dry.water, 128, 128), 1);
  const level = at(dry.surface, 128, 128);
  let other = 0, lake = 0;
  for (let i = 0; i < dry.water.data.length; i++) if (dry.water.data[i] === 1) { lake++; if (dry.surface.data[i] !== level) other++; }
  assert.equal(other, 0, 'lake texels at another level');
  assert.ok(lake > 0.03 * 257 * 257 && lake < 0.25 * 257 * 257, `the lake covers ${lake} texels`);
  assert.ok(stats(dry.depth).max > 0.15, `it is ${stats(dry.depth).max} deep`);
});

test('simulate/lakes: lakes shallower than minDepth or smaller than a square of side minSize are left out', async () => {
  const input = twoHollows(257);
  const pond = [64, 77] as const, lake = [166, 154] as const;   // texels at the hollows' deepest points
  const all = await renderNode(def, { inputs: { in: input }, params: ALL, settings: { seaLevel: 0 } });
  assert.deepEqual([at(all.water, ...pond), at(all.water, ...lake)], [1, 1], 'both hollows hold water');
  // The pond lies in the window of texels 30..99 by 40..114; everything else that holds water is the lake.
  let pondDepth = 0, pondTexels = 0;
  for (let y = 40; y < 115; y++) {
    for (let x = 30; x < 100; x++) {
      pondDepth = Math.max(pondDepth, at(all.depth, x, y));
      pondTexels += at(all.water, x, y);
    }
  }
  const lakeDepth = stats(all.depth).max;
  assert.ok(pondDepth > 0.01 && pondDepth < 0.03 && lakeDepth > 0.1, `the pond is ${pondDepth} deep and the lake ${lakeDepth}`);
  // A texel covers one cell of the terrain, and 256 x 256 cells make the whole.
  const pondArea = pondTexels / 256 ** 2, lakeArea = (stats(all.water).mean * 257 ** 2 - pondTexels) / 256 ** 2;
  assert.ok(pondArea > 0 && pondArea < 0.25 * lakeArea, `the pond covers ${pondArea} of the terrain and the lake ${lakeArea}`);

  const run = async (params: Record<string, number>): Promise<[number, number]> => {
    const r = await renderNode(def, { inputs: { in: input }, params: { ...ALL, ...params }, settings: { seaLevel: 0 } });
    // Where a lake is left out its texels are terrain again: no water, no depth, the surface on the ground.
    for (const [x, y] of [pond, lake]) assert.equal(at(r.depth, x, y) > 0, at(r.water, x, y) === 1);
    return [at(r.water, ...pond), at(r.water, ...lake)];
  };
  assert.deepEqual(await run({ minDepth: pondDepth * 0.99 }), [1, 1]);
  assert.deepEqual(await run({ minDepth: pondDepth * 1.01 }), [0, 1]);
  assert.deepEqual(await run({ minDepth: lakeDepth * 1.01 }), [0, 0]);
  assert.deepEqual(await run({ minSize: Math.sqrt(pondArea) * 0.98 }), [1, 1]);
  assert.deepEqual(await run({ minSize: Math.sqrt(pondArea) * 1.02 }), [0, 1]);
  assert.deepEqual(await run({ minSize: Math.sqrt(lakeArea) * 1.02 }), [0, 0]);
  const dropped = await renderNode(def, { inputs: { in: input }, params: { minDepth: pondDepth * 1.01, minSize: 0 }, settings: { seaLevel: 0 } });
  assert.equal(at(dropped.surface, ...pond), at(input, ...pond));
});

test('simulate/lakes: the size of a lake is measured on the terrain, so the same lakes are kept at every resolution', async () => {
  // The bowl is one lake at every level: the same share of the terrain is water.
  const levels = await renderLadder(def, { inputs: { in: 'bowl' }, resolutions: [129, 257], wants: ['water'] });
  assert.ok(Math.abs(stats(levels[129]!.water!).mean - stats(levels[257]!.water!).mean) < 0.02);
  // A minimum between the sizes of the pond and of the lake: the pond goes and the lake stays, at 129 as at 513.
  for (const res of [129, 257, 513]) {
    const input = twoHollows(res);
    const { water } = await renderNode(def, { res, inputs: { in: input }, params: { minDepth: 0, minSize: 0.12 }, settings: { seaLevel: 0 }, wants: ['water'] });
    const last = res - 1;
    assert.deepEqual([at(water, Math.round(0.25 * last), Math.round(0.3 * last)), at(water, Math.round(0.65 * last), Math.round(0.6 * last))], [0, 1], `at ${res}`);
  }
});
