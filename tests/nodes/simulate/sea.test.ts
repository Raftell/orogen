// tests/nodes/simulate/sea.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectMask, expectStats, fieldOf, fixtures, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/simulate/sea.ts';
import { COAST_FLAT, COAST_SWEEPS, COAST_TALUS } from '../../../src/core/nodes/simulate/_water-constants.ts';
import { neighbour } from './_route-reference.ts';

conformance(def, {
  resolutionTol: {
    value: 0.04,
    reason: 'The beach and the shelf are placed by the distance to the nearest sea texel, which lies up to half a coarse cell elsewhere at the next level. Measured: 0.0025 of the standard deviation for out, 0.026 for depth, whose values are all near the shore.',
  },
});

const SEA = 0.25;
/** The test settings: 16 m per texel at 257 and 1024 m of height range. */
const CELL = 16, R = 1024;
const UNSHAPED = { strength: 0 };

/** The sea the border reaches, by trying: from the border-ring texels at or below the sea level through N4 neighbours at or below it. */
function reached(input: FieldData, sea: number): Float32Array {
  const res = input.width, water = new Float32Array(res * res);
  const queue: number[] = [];
  const visit = (i: number): void => {
    if (water[i] === 1 || !(input.data[i]! <= sea)) return;
    water[i] = 1;
    queue.push(i);
  };
  for (let i = 0; i < res; i++) for (const j of [i, (res - 1) * res + i, i * res, i * res + res - 1]) visit(j);
  for (let at = 0; at < queue.length; at++) for (let k = 0; k < 4; k++) { const q = neighbour(queue[at]!, k, res); if (q >= 0) visit(q); }
  return water;
}

test('simulate/sea: global marks everything at or below the sea level; depth is how far the ground lies below it, surface the sea over it', async () => {
  const input = fixtures.terrain(257);
  const { out, water, depth, surface } = await renderNode(def, { inputs: { in: input }, params: { mode: 'global', ...UNSHAPED } });
  expectIdentical(out, input);
  expectMask(water);
  let wrong = 0, sea = 0;
  for (let i = 0; i < input.data.length; i++) {
    const h = input.data[i]!, wet = h <= SEA;
    if (wet) sea++;
    if (water.data[i] !== (wet ? 1 : 0) || depth.data[i] !== (wet ? Math.fround(SEA - h) : 0) || surface.data[i] !== (wet ? SEA : h)) wrong++;
  }
  assert.equal(wrong, 0, 'texels whose water, depth or surface is not that of the sea level');
  assert.ok(sea > 0.05 * input.data.length, `the terrain fixture has a sea: ${sea} texels`);
  expectStats(depth, { min: [0, 0], max: [0.1, 0.15] });
});

test('simulate/sea: connected marks only the sea the border reaches, and every texel of it is joined to the border through the sea', async () => {
  for (const sea of [SEA, 0.45]) {
    const input = fixtures.terrain(257);
    const connected = await renderNode(def, { inputs: { in: input }, params: UNSHAPED, settings: { seaLevel: sea } });
    const global = await renderNode(def, { inputs: { in: input }, params: { mode: 'global', ...UNSHAPED }, settings: { seaLevel: sea }, wants: ['water'] });
    expectIdentical(connected.water, { ...input, data: reached(input, Math.fround(sea)) });
    let inland = 0, outside = 0;
    for (let i = 0; i < input.data.length; i++) {
      if (connected.water.data[i] === 1 && global.water.data[i] !== 1) outside++;
      if (connected.water.data[i] === 0 && global.water.data[i] === 1) inland++;
      // Dry ground has no depth and its own surface, also where it lies below the sea level.
      if (connected.water.data[i] === 0 && (connected.depth.data[i] !== 0 || connected.surface.data[i] !== input.data[i])) outside++;
    }
    assert.equal(outside, 0, `sea level ${sea}: connected sea that is not below the sea level, or dry ground with a depth`);
    if (sea === 0.45) assert.ok(inland > 20, `sea level ${sea}: ${inland} texels below it lie in basins the sea does not reach`);
  }
});

test('simulate/sea: a basin below the sea level that the border does not reach is sea only in global mode', async () => {
  // The basin fixture: 3 % of it lies below the test sea level, in the middle of the terrain.
  const connected = await renderNode(def, { inputs: { in: 'basin' }, params: UNSHAPED });
  expectStats(connected.water, { min: [0, 0], max: [0, 0] });
  expectStats(connected.depth, { min: [0, 0], max: [0, 0] });
  expectIdentical(connected.surface, fixtures.basin(257));
  const global = await renderNode(def, { inputs: { in: 'basin' }, params: { mode: 'global', ...UNSHAPED } });
  assert.ok(Math.abs(stats(global.water).mean - 0.03) < 0.01, `${stats(global.water).mean} of the basin fixture is sea`);
  assert.equal(at(global.water, 128, 128), 1);
  // The fixture is 0.3 + 0.4 * 0.5 - 0.35 = 0.15 at its centre.
  assert.ok(Math.abs(at(global.depth, 128, 128) - (SEA - 0.15)) < 1e-6, `the sea is ${at(global.depth, 128, 128)} deep over the centre`);
  assert.equal(at(global.surface, 128, 128), SEA);
});

test('simulate/sea: without coast shaping the terrain passes through unchanged', async () => {
  for (const mode of ['connected', 'global']) {
    const { out } = await renderNode(def, { inputs: { in: 'terrain' }, params: { mode, ...UNSHAPED }, wants: ['out'] });
    expectIdentical(out, fixtures.terrain(257));
  }
});

test('simulate/sea: coast shaping draws the ground to a ramp through the waterline, in full near it and less towards the edge of the band', async () => {
  // rampX is the height u: the sea ends at column 64, and the waterline lies half a texel beyond it. The ramp
  // of the shore is gentler than the talus angle everywhere, so nothing slumps.
  const shoreSize = 0.0625, shoreHeight = 0.02, strength = 0.8;   // a band of 16 texels to each side
  const input = fixtures.rampX(257);
  const { out, water, depth, surface } = await renderNode(def, { inputs: { in: input }, params: { strength, shoreSize, shoreHeight } });
  const expected = fieldOf(257, (u) => {
    const column = Math.round(u * 256), wet = column <= 64;
    const x = (wet ? -(64 - column + 0.5) : column - 64 - 0.5) / 16;
    if (Math.abs(x) >= 1) return u;
    // In full over the inner COAST_FLAT of the band, and from there to nothing at its edge by a smooth step.
    const t = Math.min(Math.max((Math.abs(x) - COAST_FLAT) / (1 - COAST_FLAT), 0), 1);
    const drawn = u + (SEA + shoreHeight * x - u) * strength * (1 - t * t * (3 - 2 * t));
    return wet ? Math.min(drawn, SEA) : Math.min(u, drawn);
  });
  expectClose(out, expected, { max: 2e-6 });
  let moved = 0, raised = 0, outside = 0;
  for (let i = 0; i < out.data.length; i++) {
    const column = i % 257;
    if ((out.data[i]! <= SEA) !== (input.data[i]! <= SEA)) moved++;
    if (column > 64 && out.data[i]! > input.data[i]!) raised++;
    if (Math.abs(column - 64.5) > 16.5 && out.data[i] !== input.data[i]) outside++;
  }
  assert.equal(moved, 0, 'texels that changed sides of the waterline');
  assert.equal(raised, 0, 'land that was raised: the coast is only cut back');
  assert.equal(outside, 0, 'texels beyond the band that changed');
  // Behind the waterline the ground lay above the beach and was cut down to it; the sea bed off this coast lay
  // below the shelf and was raised towards it, never above the sea level.
  assert.ok(at(out, 68, 100) < at(input, 68, 100) - 1e-3, 'the beach is cut into the land');
  assert.ok(at(out, 60, 100) > at(input, 60, 100) + 1e-3 && at(out, 60, 100) <= SEA, 'the shelf is laid on the sea bed');
  // Water is the sea as it was found; depth and surface are those of the shaped ground.
  expectIdentical(water, fieldOf(257, (u) => (Math.round(u * 256) <= 64 ? 1 : 0)));
  expectClose(depth, fieldOf(257, (u) => (Math.round(u * 256) <= 64 ? SEA - at(out, Math.round(u * 256), 0) : 0)), { max: 1e-7 });
  expectClose(surface, fieldOf(257, (u) => (Math.round(u * 256) <= 64 ? SEA : at(out, Math.round(u * 256), 0))), { max: 1e-7 });
  expectStats(depth, { min: [0, 0] });
});

test('simulate/sea: behind a beach cut into a cliff the scarp slumps towards the talus angle, and only inside the band', async () => {
  // A plateau that drops into the sea in one step, 358 m high: the cut leaves a wall behind the beach.
  const input = fieldOf(257, (u) => (u < 0.3 ? 0.1 : 0.6));
  const shoreSize = 0.0625, shoreHeight = 0.01;
  const { out } = await renderNode(def, { inputs: { in: input }, params: { strength: 1, shoreSize, shoreHeight }, wants: ['out'] });
  // What the cut alone gives: the sea ends at column 76.
  const cut = (column: number): number => {
    const u = column / 256, h = u < 0.3 ? 0.1 : 0.6, wet = column <= 76;
    const x = (wet ? -(76 - column + 0.5) : column - 76 - 0.5) / 16;
    if (Math.abs(x) >= 1) return h;
    const t = Math.min(Math.max((Math.abs(x) - COAST_FLAT) / (1 - COAST_FLAT), 0), 1);
    const drawn = h + (SEA + shoreHeight * x - h) * (1 - t * t * (3 - 2 * t));
    return wet ? Math.min(drawn, SEA) : Math.min(h, drawn);
  };
  const steepest = (height: (column: number) => number): number => {
    let most = 0;
    for (let column = 77; column < 92; column++) most = Math.max(most, (Math.abs(height(column + 1) - height(column)) * R) / CELL);
    return most;
  };
  const before = steepest(cut), after = steepest((column) => at(out, column, 128));
  assert.ok(before > 2, `the cut leaves a slope of ${before} behind the beach`);
  assert.ok(after < 0.9 * before, `after ${COAST_SWEEPS} sweeps the steepest slope is ${after}, from ${before}; the talus angle of ${COAST_TALUS} degrees is ${Math.tan((COAST_TALUS * Math.PI) / 180)}`);
  let outside = 0, wrongSide = 0;
  for (let i = 0; i < out.data.length; i++) {
    const column = i % 257;
    if (Math.abs(column - 76.5) > 16.5 && out.data[i] !== input.data[i]) outside++;
    if ((out.data[i]! <= SEA) !== (input.data[i]! <= SEA)) wrongSide++;
  }
  assert.equal(outside, 0, 'texels beyond the band that changed');
  assert.equal(wrongSide, 0, 'the slumped ground moved the waterline');
});

test('simulate/sea: a wider shore shapes a broader band, a higher one a steeper beach, and more strength a deeper cut', async () => {
  const input = fixtures.terrain(257);
  const run = async (params: Record<string, number>): Promise<FieldData> => (await renderNode(def, { inputs: { in: input }, params, wants: ['out'] })).out;
  const changed = (out: FieldData): number => { let n = 0; for (let i = 0; i < out.data.length; i++) if (out.data[i] !== input.data[i]) n++; return n; };
  const removed = (out: FieldData): number => { let sum = 0; for (let i = 0; i < out.data.length; i++) sum += Math.max(input.data[i]! - out.data[i]!, 0); return sum; };
  const narrow = await run({ shoreSize: 0.01 }), wide = await run({ shoreSize: 0.05 });
  assert.ok(changed(wide) > 3 * changed(narrow) && changed(narrow) > 500, `${changed(narrow)} texels change with a narrow shore and ${changed(wide)} with a wide one`);
  const half = await run({ strength: 0.5, shoreSize: 0.05 });
  assert.ok(removed(half) < 0.8 * removed(wide) && removed(half) > 0, `half the strength removes ${removed(half)}, all of it ${removed(wide)}`);
  // No land is ever raised and no waterline moves, whatever the parameters.
  for (const out of [narrow, wide, half, await run({ shoreSize: 0.05, shoreHeight: 0.05 }), await run({ shoreSize: 0.05, shoreHeight: 0 })]) {
    let raised = 0, moved = 0;
    for (let i = 0; i < out.data.length; i++) {
      if (input.data[i]! > SEA && out.data[i]! > input.data[i]! + 1e-7) raised++;
      if ((out.data[i]! <= SEA) !== (input.data[i]! <= SEA)) moved++;
    }
    assert.equal(moved, 0, 'texels that changed sides of the waterline');
    // Slumping lays a little of the scarp onto the foot of the beach: nothing rises by more than that.
    assert.ok(raised < 0.01 * out.data.length, `${raised} land texels were raised`);
  }
});

test('simulate/sea: in connected mode a basin the sea does not reach has no shore to shape', async () => {
  const basin = fixtures.basin(257);
  const connected = await renderNode(def, { inputs: { in: basin }, wants: ['out'] });
  expectIdentical(connected.out, basin);
  const global = await renderNode(def, { inputs: { in: basin }, params: { mode: 'global' }, wants: ['out'] });
  let cut = 0;
  for (let i = 0; i < global.out.data.length; i++) if (global.out.data[i]! < basin.data[i]! - 1e-4) cut++;
  assert.ok(cut > 200, `as a sea of its own the basin gets a beach: ${cut} texels of its shore are cut down`);
});
