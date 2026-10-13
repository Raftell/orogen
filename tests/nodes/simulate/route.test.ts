// tests/nodes/simulate/route.test.ts
// The routing module on the GPU (simulation.md 6.3, 6.5): the sweep and the receiver kernel against the router
// task, through a probe node that runs all three. The task alone is tested in unit/route.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectIdentical, fieldOf, fixtures, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import { mixSeed } from '../../../src/core/api.ts';
import { routeEps } from '../../../src/core/nodes/simulate/_route.ts';
import probe from './_route-probe.ts';
import { adjacent, neighbour, receiverOf, referenceRoute } from './_route-reference.ts';

const SEA = 0.25, R = 1024, PROJECT_SEED = 1;
const field = (like: FieldData, data: Float32Array): FieldData => ({ ...like, data });

test('simulate/route: the task runs in the CPU worker and gives the surface and the area of the algorithm as written', async () => {
  const input = fixtures.terrain(129);
  const { out, area } = await renderNode(probe, { res: 129, inputs: { in: input, start: null }, wants: ['out', 'area'] });
  const expected = referenceRoute({ height: input.data, res: 129, eps: routeEps(R), seaLevel: SEA, routing: 'single', seed: mixSeed(mixSeed(PROJECT_SEED, 0), 0) });
  expectIdentical(out, field(input, expected.filled));
  let apart = 0;
  for (let i = 0; i < area.data.length; i++) if (!adjacent(area.data[i]!, expected.area![i]!)) apart++;
  assert.equal(apart, 0, 'areas more than a float32 step from the reference');
});

test('simulate/route: a sweep leaves the router\'s surface as it is, within one float32 step (6.5 item 3)', async (t) => {
  for (const res of [257, 513]) {
    for (const name of ['terrain', 'bowl'] as const) {
      const { out, swept } = await renderNode(probe, { res, inputs: { in: name, start: null }, params: { count: 1 }, wants: ['out', 'swept'] });
      let moved = 0, differing = 0;
      for (let i = 0; i < out.data.length; i++) {
        if (out.data[i] !== swept.data[i]) differing++;
        if (!adjacent(out.data[i]!, swept.data[i]!)) moved++;
      }
      assert.equal(moved, 0, `${name} at ${res}: texels a sweep moves by more than a float32 step`);
      t.diagnostic(`${name} at ${res}: ${differing === 0 ? 'bit-identical' : `${differing} texels differ by one float32 step`}`);
    }
  }
});

test('simulate/route: from a surface that is nowhere below it, sweeps never take a texel below the router\'s surface, and settle it from the outlets inwards (6.5 item 4)', async () => {
  for (const res of [257, 513]) {
    const input = fixtures.terrain(res);
    // A start far above every surface: valid. The outlets take their own height in the first sweep.
    const start = fieldOf(res, () => 2);
    let settledBefore = 0;
    for (const count of [1, 4, 32, 64]) {
      const { out, swept } = await renderNode(probe, { res, inputs: { in: input, start }, params: { count }, wants: ['out', 'swept'] });
      let below = 0, settled = 0;
      for (let i = 0; i < out.data.length; i++) {
        if (swept.data[i]! < out.data[i]!) below++;
        if (swept.data[i] === out.data[i]) settled++;
      }
      assert.equal(below, 0, `${res}, ${count} sweeps: texels below the router's surface`);
      // A sweep settles the texels one step further from the outlets; what it has not reached it raises by eps.
      assert.ok(settled > settledBefore, `${res}: ${settled} texels are settled after ${count} sweeps, ${settledBefore} after fewer`);
      settledBefore = settled;
    }
  }
});

test('simulate/route: after the terrain rises by up to a lift, a first sweep with that lift keeps the surface above the new exact one (6.3 warm start)', async () => {
  const lift = 0.002;
  for (const res of [257, 513]) {
    const old = fixtures.terrain(res), bump = fixtures.mask(res);
    // The surface of the old terrain, then the terrain raised by up to the lift under the disc of the mask.
    const exact = (await renderNode(probe, { res, inputs: { in: old, start: null }, params: { count: 0 }, wants: ['out'] })).out;
    const raised = fieldOf(res, (u, v) => { const x = Math.round(u * (res - 1)), y = Math.round(v * (res - 1)); return old.data[y * res + x]! + lift * bump.data[y * res + x]!; });
    for (const count of [1, 4]) {
      const { out, swept } = await renderNode(probe, { res, inputs: { in: raised, start: exact }, params: { count, lift }, wants: ['out', 'swept'] });
      let below = 0, far = 0;
      for (let i = 0; i < out.data.length; i++) {
        if (swept.data[i]! < out.data[i]!) below++;
        if (swept.data[i]! > out.data[i]! + 2 * lift) far++;
      }
      assert.equal(below, 0, `${res}, ${count} sweeps: texels below the exact surface of the raised terrain`);
      assert.equal(far, 0, `${res}, ${count} sweeps: texels more than the lift above it`);
    }
    // Without the lift the first sweep starts from a surface that lies below the new one under the disc.
    const none = await renderNode(probe, { res, inputs: { in: raised, start: exact }, params: { count: 1, lift: 0 }, wants: ['out', 'swept'] });
    let below = 0;
    for (let i = 0; i < none.out.data.length; i++) if (none.swept.data[i]! < none.out.data[i]!) below++;
    assert.ok(below > 0, 'the lift is what keeps the bound: without it some texel falls below the exact surface');
  }
});

test('simulate/route: the receiver kernel gives every texel that is no outlet a strictly lower neighbour, the one step 2 of the router draws', async (t) => {
  for (const res of [257, 513]) {
    const input = fixtures.terrain(res);
    for (const seed of [0, 7]) {
      const { out, rcv } = await renderNode(probe, { res, inputs: { in: input, start: null }, params: { count: 0, seed }, wants: ['out', 'rcv'] });
      const reference = referenceRoute({ height: input.data, res, eps: routeEps(R), seaLevel: SEA, routing: 'none', seed: 0 });
      const routerSeed = mixSeed(mixSeed(PROJECT_SEED, seed), 0);
      let invalid = 0, uphill = 0, other = 0;
      for (let i = 0; i < rcv.data.length; i++) {
        const k = rcv.data[i]!;
        if (reference.outlet[i]) { if (k !== 4) invalid++; continue; }
        if (!(k === 0 || k === 1 || k === 2 || k === 3)) { invalid++; continue; }
        if (!(out.data[neighbour(i, k, res)]! < out.data[i]!)) uphill++;
        if (k !== receiverOf(out.data, i % res, Math.floor(i / res), res, routerSeed)) other++;
      }
      assert.equal(invalid, 0, `${res}, seed ${seed}: codes that are no receiver code, or outlets with a receiver`);
      assert.equal(uphill, 0, `${res}, seed ${seed}: receivers that are not lower`);
      // A code may differ where the random threshold falls within a float32 step of a partial sum (6.3). On a
      // flat the router task takes another receiver than step 2 (6.2 step 3); the kernel draws from the drops there too.
      assert.ok(other <= 1e-3 * rcv.data.length, `${res}, seed ${seed}: ${other} receivers differ from step 2's`);
      t.diagnostic(`${res}, seed ${seed}: ${other} of ${rcv.data.length} receivers differ from step 2's`);
    }
  }
  assert.ok(stats(fixtures.terrain(257)).std > 0.1);
});
