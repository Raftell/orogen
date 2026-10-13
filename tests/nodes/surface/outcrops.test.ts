// tests/nodes/surface/outcrops.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectIdentical, expectLadder, expectMask, fixtures, renderLadder, renderNode, stats, traceNode, type FieldData,
} from '../../helpers/index.ts';
import def, { OUTCROPS } from '../../../src/core/nodes/surface/outcrops.ts';
import { mapField, share } from './_probe.ts';

conformance(def, {
  resolutionTol: {
    value: 0.08,
    reason: 'coverage is the all-but-binary outline of blocks down to 6 texels wide at 257, where a block under 4 texels stands lower and one under 2 is left out: 5.2 % from 257 to 513, 1.3 % from 513 to 1025, 1.3 % with blocks of 0.15; out differs by 0.3 %.',
  },
});

const N = 257;
/** With this height range rampX climbs at 45 degrees: a slope of 1, which falls the block size across a block. */
const STEEP = { heightRange: 4096 };

/** What the node adds to a terrain. */
const raised = (out: FieldData, src: FieldData): FieldData => mapField(out, (v, x, y) => v - at(src, x, y));

test('surface/outcrops: rock only ever stands above the ground, and the coverage is where it does', async () => {
  const src = await fixtures.fbm(N);
  const { out, coverage } = await renderNode(def, { inputs: { in: src }, params: { slopeMin: 25, size: 0.04 } });
  expectMask(coverage);
  const lift = raised(out, src);
  assert.ok(stats(lift).min >= 0, `the lowest the terrain is moved is ${stats(lift).min}`);
  // A slope of 1 falls 0.04 * 4096 / 1024 heights across a block; the coverage is full where the rock of the
  // blocks that break out of the ground stands a tenth of that above it. Smaller blocks stand on that rock
  // and nowhere else: they raise it further, and add no coverage.
  const full = OUTCROPS.edge * 0.04 * 4;
  let wrong = 0, covered = 0;
  for (let i = 0; i < lift.data.length; i++) {
    const up = lift.data[i]!, c = coverage.data[i]!;
    if (c > 0) covered++;
    if ((up > 0) !== (c > 0)) wrong++;
    else if (up < c * full * 0.999 - 1e-6) wrong++;
  }
  assert.equal(wrong, 0, 'texels whose coverage is not where the rock stands above the ground');
  assert.ok(covered > 0.05 * lift.data.length, `${covered} of ${lift.data.length} texels of a fractal terrain show rock`);
});

test('surface/outcrops: rock comes out of ground steeper than the lower slope, and gentle ground stays as it is', async () => {
  // The notch is nowhere steeper than 10.1 degrees, and level ground has no slope at all.
  for (const name of ['notch', 'one'] as const) {
    const { out, coverage } = await renderNode(def, { inputs: { in: name } });
    expectIdentical(out, fixtures[name](N));
    assert.equal(stats(coverage).max, 0, `no rock on the ${name} fixture`);
  }
  // The cone has a flank of 45 degrees on a level floor.
  const cone = fixtures.cone(N);
  const { out, coverage } = await renderNode(def, { inputs: { in: cone }, params: { size: 0.05 } });
  let floor = 0, flank = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x - 128, y - 128);
      if (r > 80) floor = Math.max(floor, at(coverage, x, y), Math.abs(at(out, x, y) - at(cone, x, y)));
      else if (r > 16 && r < 52) flank += at(coverage, x, y);
    }
  }
  assert.equal(floor, 0, 'the level floor around the cone');
  assert.ok(flank > 500, `${flank} texels of the flank show rock`);
  // A lower slope above the flank's: nothing comes out.
  const none = await renderNode(def, { inputs: { in: cone }, params: { size: 0.05, slopeMin: 60 } });
  expectIdentical(none.out, cone);
  assert.equal(stats(none.coverage).max, 0);
});

test('surface/outcrops: the rock is angular: flat faces that meet in edges, and blocks as tall as the slope falls across them', async () => {
  // Blocks of 0.2 on a ramp of 45 degrees: 102 texels each at 513, and those of the layers below 41, 16 and 6.5.
  const M = 513;
  const ramp = fixtures.rampX(M);
  const { out, coverage } = await renderNode(def, { res: M, inputs: { in: ramp }, params: { size: 0.2 }, settings: STEEP });
  const lift = raised(out, ramp);
  // A face is a plane: where the rock shows, the height bends along neither axis, except on the edges between faces.
  let rock = 0, flat = 0;
  for (let y = 1; y < M - 1; y++) {
    for (let x = 1; x < M - 1; x++) {
      if (at(coverage, x, y) < 1 || at(coverage, x - 1, y) < 1 || at(coverage, x + 1, y) < 1 || at(coverage, x, y - 1) < 1 || at(coverage, x, y + 1) < 1) continue;
      rock++;
      const bendX = at(out, x - 1, y) - 2 * at(out, x, y) + at(out, x + 1, y);
      const bendY = at(out, x, y - 1) - 2 * at(out, x, y) + at(out, x, y + 1);
      if (Math.abs(bendX) < 3e-6 && Math.abs(bendY) < 3e-6) flat++;
    }
  }
  assert.ok(rock > 0.1 * M * M, `${rock} texels of the ramp are rock`);
  // Of rounded rock, or of noise, no texel is flat. Here only the texels on an edge between two faces are not.
  assert.ok(flat > 0.7 * rock, `${flat} of ${rock} rock texels lie on a flat face`);
  // The ramp falls 0.2 across a block. The top of a block stands out of it by up to 0.3 of that at its middle,
  // and keeps a quarter of the slope at the least: at its lower edge, 0.45 of a block from the middle at the
  // most, it stands 0.75 * 0.45 higher still, and a tipped top a little more at a corner.
  const most = stats(lift).max;
  const edge = OUTCROPS.set[1] + (1 - OUTCROPS.lay[0]) * OUTCROPS.reach[1];
  assert.ok(most > 0.5 * edge * 0.2 && most < (edge + OUTCROPS.tip * OUTCROPS.reach[1] * OUTCROPS.long) * 0.2, `the rock stands up to ${most} above a ramp that falls 0.2 across a block`);
  // No face is steeper than a rock face stands, on top of the slope of the tops: nothing is a wall between two texels.
  let steepest = 0;
  for (let y = 0; y < M; y++) for (let x = 0; x < M - 1; x++) steepest = Math.max(steepest, Math.abs(at(out, x + 1, y) - at(out, x, y)));
  const limit = Math.tan((OUTCROPS.face * Math.PI) / 180) + 2 * OUTCROPS.steepest;
  assert.ok(steepest * (M - 1) <= limit, `the steepest face climbs at a tangent of ${steepest * (M - 1)}; allowed ${limit}`);
});

test('surface/outcrops: the blocks come in sizes: with fewer layers of them on a coarser grid, in the same places', async () => {
  // On the cone at 513, blocks of 0.05 are 26, 10 and 4 texels wide: three layers of them.
  const cone = fixtures.cone(513);
  const { out, coverage } = await renderNode(def, { res: 513, inputs: { in: cone }, params: { size: 0.05 } });
  // The same blocks at 129 are 6.4 and 2.6 texels wide: the first layer is whole, and the second all but left out.
  const coarse = await renderNode(def, { res: 129, inputs: { in: 'cone' }, params: { size: 0.05 } });
  let both = 0, onlyFine = 0, onlyCoarse = 0;
  for (let y = 0; y < 129; y++) {
    for (let x = 0; x < 129; x++) {
      const fine = at(coverage, 4 * x, 4 * y) > 0, rough = at(coarse.coverage, x, y) > 0;
      if (fine && rough) both++;
      else if (fine) onlyFine++;
      else if (rough) onlyCoarse++;
    }
  }
  assert.ok(both > 400, `${both} texels show rock on both grids`);
  // The finer grid has the smaller blocks beside the large ones as well, and loses next to none of the large.
  assert.ok(onlyFine > 0.15 * both && onlyCoarse < 0.1 * both, `${onlyFine} texels show rock on the finer grid alone and ${onlyCoarse} on the coarser alone`);
  assert.ok(stats(raised(out, cone)).max > 0.01);
});

test('surface/outcrops: the strength sets how far the blocks stand out, and none gives the input itself', async () => {
  const src = await fixtures.fbm(N);
  const lifts: number[] = [];
  for (const strength of [0.25, 0.5, 1]) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { strength, slopeMin: 25 } });
    lifts.push(stats(raised(out, src)).mean);
  }
  // A block stands the strength's part of its height above the ground: half the strength is about half the rock.
  assert.ok(lifts[0]! > 0.15 * lifts[2]! && lifts[0]! < 0.35 * lifts[2]! && lifts[1]! > 0.4 * lifts[2]! && lifts[1]! < 0.6 * lifts[2]!, `the mean raise at strengths 0.25, 0.5 and 1 is ${lifts.join(', ')}`);
  const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { strength: 0 } });
  expectIdentical(outputs.out!, src);
  assert.equal(stats(outputs.coverage!).max, 0);
  assert.equal(report.nodes.node!.state, 'done');
});

test('surface/outcrops: blocks too small for the grid are left out, and another seed gives other blocks', async () => {
  const src = await fixtures.fbm(N);
  // A block of 0.004 is one texel at 257.
  const tiny = await renderNode(def, { inputs: { in: src }, params: { size: 0.004, slopeMin: 20 } });
  expectIdentical(tiny.out, src);
  assert.equal(stats(tiny.coverage).max, 0);
  const a = await renderNode(def, { inputs: { in: src }, params: { slopeMin: 25 } });
  const b = await renderNode(def, { inputs: { in: src }, params: { slopeMin: 25, seed: 1 } });
  assert.ok(share(a.coverage, (v, x, y) => (v > 0) !== (at(b.coverage, x, y) > 0)) > 0.05, 'the rock of another seed shows elsewhere');
});

test('surface/outcrops: the blocks are the same at two levels of the ladder', async () => {
  // Blocks of 0.15 are 38 and 15 texels at 257: both layers that break out of the ground are whole at both levels.
  const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { slopeMin: 15, size: 0.15 } });
  assert.ok(stats(levels[257]!.coverage).mean > 0.05, 'the terrain fixture shows rock');
  expectLadder(levels[257]!.out, levels[513]!.out, { rel: 0.004 });
  expectLadder(levels[257]!.coverage, levels[513]!.coverage, { rel: 0.025 });
  const finer = await renderLadder(def, { inputs: { in: 'terrain' }, params: { slopeMin: 15, size: 0.15 }, resolutions: [513, 1025] });
  expectLadder(finer[513]!.coverage, finer[1025]!.coverage, { rel: 0.01 });
});
