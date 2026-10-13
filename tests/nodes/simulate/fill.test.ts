// tests/nodes/simulate/fill.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectStats, fixtures, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/simulate/fill.ts';
import { neighbour, outletsOf, referenceRoute } from './_route-reference.ts';

conformance(def);

const SEA = 0.25;
const field = (like: FieldData, data: Float32Array): FieldData => ({ ...like, data });

test('simulate/fill: out is the routing surface of the terrain with level lakes, bit for bit', async () => {
  for (const name of ['terrain', 'basin', 'bowl', 'cone'] as const) {
    const input = fixtures[name](129);
    const { out } = await renderNode(def, { res: 129, inputs: { in: input } });
    const expected = referenceRoute({ height: input.data, res: 129, eps: 0, seaLevel: SEA, routing: 'none', seed: 0 });
    expectIdentical(out, field(input, expected.filled));
  }
});

test('simulate/fill: the filled terrain is nowhere below the input, is the input at every outlet, and its lakes are level', async () => {
  const input = fixtures.terrain(257);
  const { out, depth } = await renderNode(def, { inputs: { in: input } });
  const outlet = outletsOf(input.data, 257, SEA);
  let below = 0, moved = 0, lake = 0, tilted = 0, wrongDepth = 0;
  for (let i = 0; i < out.data.length; i++) {
    if (out.data[i]! < input.data[i]!) below++;
    if (outlet[i] && out.data[i] !== input.data[i]) moved++;
    if (depth.data[i] !== Math.fround(out.data[i]! - input.data[i]!)) wrongDepth++;
    if (!(out.data[i]! > input.data[i]!)) continue;
    lake++;
    for (let k = 0; k < 2; k++) {
      const q = neighbour(i, k, 257);
      if (q >= 0 && out.data[q]! > input.data[q]! && out.data[q] !== out.data[i]) tilted++;
    }
  }
  assert.equal(below, 0, 'texels below the input');
  assert.equal(moved, 0, 'outlets that changed');
  assert.equal(wrongDepth, 0, 'texels where depth is not out - in');
  // The terrain fixture has between 26 and 30 depressions: together they hold a few percent of it.
  assert.ok(lake > 0.01 * out.data.length && lake < 0.2 * out.data.length, `${lake} texels were filled`);
  assert.equal(tilted, 0, 'neighbouring texels of one lake at different levels');
  expectStats(depth, { min: [0, 0], max: [0.01, 0.2] });
});

test('simulate/fill: a terrain without a depression is returned as it is, and depth is 0', async () => {
  const { out, depth } = await renderNode(def, { inputs: { in: 'notch' } });
  expectIdentical(out, fixtures.notch(257));
  expectStats(depth, { min: [0, 0], max: [0, 0] });
});

test('simulate/fill: a bowl fills to its rim', async () => {
  // The border ring of the bowl is at 0.9 and its floor at 0.3, above the sea.
  const { out, depth } = await renderNode(def, { inputs: { in: 'bowl' } });
  expectStats(out, { min: Math.fround(0.9), max: Math.fround(0.9) });
  assert.ok(Math.abs(at(depth, 128, 128) - 0.6) < 1e-6, `the fill is ${at(depth, 128, 128)} deep at the centre`);
});

test('simulate/fill: ground at or below the sea level is an outlet, so a hollow that reaches below it stays open', async () => {
  // The floor of the basin fixture is at 0.147: below the test sea level of 0.25 it drains into the sea.
  const wet = await renderNode(def, { inputs: { in: 'basin' } });
  expectIdentical(wet.out, fixtures.basin(257));
  // Without a sea it is a depression and fills to where it spills.
  const dry = await renderNode(def, { inputs: { in: 'basin' }, settings: { seaLevel: 0 } });
  const filled = at(dry.out, 128, 128);
  assert.ok(filled > 0.3 && filled < 0.5, `the basin fills to ${filled}`);
  assert.ok(stats(dry.depth).max > 0.15, `its fill is ${stats(dry.depth).max} deep`);
});

test('simulate/fill: with a tilt every texel that is no outlet has a neighbour lower by the fall of that slope over one cell', async () => {
  for (const name of ['terrain', 'bowl'] as const) {
    const input = fixtures[name](257);
    const tilt = 2;
    const { out } = await renderNode(def, { inputs: { in: input }, params: { tilt } });
    // 16 m per cell and 1024 m of height range: the fall per texel as a normalised height.
    const eps = Math.fround((Math.tan((tilt * Math.PI) / 180) * 16) / 1024);
    const outlet = outletsOf(input.data, 257, SEA);
    let stuck = 0, below = 0;
    for (let i = 0; i < out.data.length; i++) {
      if (out.data[i]! < input.data[i]!) below++;
      if (outlet[i]) continue;
      let lowest = Infinity;
      for (let k = 0; k < 4; k++) lowest = Math.min(lowest, out.data[neighbour(i, k, 257)]!);
      if (!(out.data[i]! >= Math.fround(lowest + eps))) stuck++;
    }
    assert.equal(stuck, 0, `${name}: texels without a neighbour lower by the tilt`);
    assert.equal(below, 0, `${name}: texels below the input`);
    expectIdentical(out, field(input, referenceRoute({ height: input.data, res: 257, eps, seaLevel: SEA, routing: 'none', seed: 0 }).filled));
  }
});

test('simulate/fill: the tilt is a physical slope, the same at every resolution', async () => {
  // In the bowl the fill rises from the rim towards the centre, half the terrain away as the texels step:
  // 2048 m at 5 degrees is 179 m, 0.175 of the height range.
  const expected = 0.9 + (Math.tan((5 * Math.PI) / 180) * 2048) / 1024;
  for (const res of [129, 257]) {
    const { out } = await renderNode(def, { res, inputs: { in: 'bowl' }, params: { tilt: 5 } });
    const centre = at(out, (res - 1) / 2, (res - 1) / 2);
    assert.ok(Math.abs(centre - expected) < 2e-4, `at ${res} the centre is filled to ${centre}; the slope gives ${expected}`);
  }
  // A level fill for comparison: the tilt only ever raises.
  const level = await renderNode(def, { inputs: { in: 'terrain' } });
  const tilted = await renderNode(def, { inputs: { in: 'terrain' }, params: { tilt: 5 } });
  let lower = 0;
  for (let i = 0; i < level.out.data.length; i++) if (tilted.out.data[i]! < level.out.data[i]!) lower++;
  assert.equal(lower, 0, 'texels a tilted fill leaves lower than a level one');
  assert.ok(stats(tilted.depth).mean > stats(level.depth).mean);
  expectClose(level.out, tilted.out, { max: 0.2 });
});
