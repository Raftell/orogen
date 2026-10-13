// ops.slope and ops.normal (engine.md section 5, 1.6 rule 2, 1.8): the physical slope angle and the unit normal
// against CPU references, on planes with a known answer, and on fields of other sizes than the evaluation's.
//
// Sizes: fields of at most 513 x 513 floats (1 MiB), a normal map of four floats per texel. No list is handed to
// an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { FieldAccessError, ops, type Field } from '../../../src/core/api.ts';
import { writeGrey } from '../pictures.ts';
import { assertClose, assertIdentical, channel, grid, hills, rangeOf, sampled, SETTINGS, slopeReference, startOps, upload, writeRgb } from './rig.ts';

const rig = await startOps();
after(() => rig.dispose());

/** Degrees. WGSL bounds atan loosely (thousands of ULP), so an angle near 1 radian may be off by 0.01 degree on some adapter. */
const ANGLE_TOLERANCE = 0.02;
/** A normal is stored in 16-bit floats: 11 significant bits of a component below 1. */
const NORMAL_TOLERANCE = 1e-3;

const degrees = (dx: number, dy: number): number => (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;

async function slopeOf(data: Float32Array, n: number, opts: { res?: number; terrainSize?: number; heightRange?: number } = {}): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', n, data);
    const result = ops.slope(ctx, src);
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], ['field', n, n, false]);
    out = await ctx.read(result);
  }, { res: opts.res ?? 65, settings: { ...(opts.terrainSize ? { terrainSize: opts.terrainSize } : {}), ...(opts.heightRange ? { heightRange: opts.heightRange } : {}) } });
  return out!;
}

async function normalOf(data: Float32Array, n: number, res = 65): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const result = ops.normal(ctx, upload(ctx, 'field', n, data));
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], ['color', n, n, false]);
    out = await ctx.read(result);
  }, { res });
  return out!;
}

test('slope is degrees(atan(|gradient|)) of the physical surface, central inside and of second order on the border', async () => {
  const n = 65;
  const heights = sampled(n, hills);
  const out = await slopeOf(heights, n);
  const { dx, dy } = slopeReference(heights, n, SETTINGS.terrainSize, SETTINGS.heightRange);
  assertClose(out, (i) => degrees(dx[i]!, dy[i]!), ANGLE_TOLERANCE, 'hills at 65');
  const range = rangeOf(out);
  assert.ok(range.nonFinite === 0 && range.min >= 0 && range.max < 90 && range.max > 30, `the angles: ${JSON.stringify(range)}`);
});

test('a plane has one slope everywhere, the border included, and the slope is physical', async () => {
  // 0.3 u + 0.4 v rises 0.5 per terrain width along its gradient.
  const n = 65;
  const plane = grid(n, n, (x, y) => 0.1 + (0.3 * x + 0.4 * y) / (n - 1));
  // 1000 m of height on 1000 m of terrain: tan = 0.5.
  assertClose(await slopeOf(plane, n, { terrainSize: 1000, heightRange: 1000 }), () => degrees(0.5, 0), ANGLE_TOLERANCE, 'tan 0.5');
  // Twice the height range, or half the terrain: tan = 1, 45 degrees.
  assertClose(await slopeOf(plane, n, { terrainSize: 1000, heightRange: 2000 }), () => 45, ANGLE_TOLERANCE, 'twice the height range');
  assertClose(await slopeOf(plane, n, { terrainSize: 500, heightRange: 1000 }), () => 45, ANGLE_TOLERANCE, 'half the terrain');
  // A flat field has no slope at all, and a cliff of the whole height range between two texels stays below 90.
  assertIdentical(await slopeOf(grid(n, n, () => 0.7), n), new Float32Array(n * n), 'a flat field');
  const cliff = await slopeOf(grid(n, n, (x) => (x < 32 ? 0 : 1)), n);
  const steepest = rangeOf(cliff);
  assert.ok(Math.abs(steepest.max - degrees(SETTINGS.heightRange / (2 * SETTINGS.terrainSize / (n - 1)), 0)) < ANGLE_TOLERANCE, `the cliff: ${steepest.max}`);
  assert.equal(cliff[0], 0);
});

test('the cell size is that of the field itself: a field of another size than the evaluation gives the slope of its own grid', async () => {
  for (const n of [33, 129, 257]) {
    const heights = sampled(n, hills);
    const out = await slopeOf(heights, n, { res: 65 });
    const { dx, dy } = slopeReference(heights, n, SETTINGS.terrainSize, SETTINGS.heightRange);
    assertClose(out, (i) => degrees(dx[i]!, dy[i]!), ANGLE_TOLERANCE, `hills at ${n} in an evaluation at 65`);
  }
  // One surface on two ladder levels: the slopes at the shared vertices agree to the accuracy of a central difference.
  const fine = await slopeOf(sampled(257, hills), 257, { res: 257 });
  const coarse = await slopeOf(sampled(129, hills), 129, { res: 129 });
  let worst = 0;
  for (let y = 1; y < 128; y++) for (let x = 1; x < 128; x++) worst = Math.max(worst, Math.abs(fine[2 * y * 257 + 2 * x]! - coarse[y * 129 + x]!));
  assert.ok(worst < 0.2, `257 against 129 inside the border: ${worst} degrees`);
  // A 1 x 1 field is a constant.
  assert.deepEqual([...(await slopeOf(Float32Array.of(0.4), 1))], [0]);
});

test('normal is normalize(-dz/dx, -dz/dy, 1) with alpha 1: unit length, +Z up, tilted away from the rise', async () => {
  const n = 65;
  const heights = sampled(n, hills);
  const out = await normalOf(heights, n);
  const { dx, dy } = slopeReference(heights, n, SETTINGS.terrainSize, SETTINGS.heightRange);
  const expected = grid(n, n, (x, y) => {
    const i = y * n + x;
    const length = Math.hypot(dx[i]!, dy[i]!, 1);
    return [-dx[i]! / length, -dy[i]! / length, 1 / length, 1];
  });
  assertClose(out, expected, NORMAL_TOLERANCE, 'hills at 65');
  const lengths = grid(n, n, (x, y) => Math.hypot(...out.subarray((y * n + x) * 4, (y * n + x) * 4 + 3)));
  assertClose(lengths, () => 1, 2 * NORMAL_TOLERANCE, 'the length of every normal');
  assertIdentical(channel(out, 4, 3), grid(n, n, () => 1), 'alpha');
  assert.ok(rangeOf(channel(out, 4, 2)).min > 0, '+Z is up on every texel');

  // A field that rises towards +X (increasing column) has a normal that leans towards -X, and none towards Y.
  const rising = await normalOf(grid(n, n, (x) => 0.2 + (0.25 * x) / (n - 1)), n);
  const tan = (0.25 * SETTINGS.heightRange) / SETTINGS.terrainSize;
  assertClose(rising, grid(n, n, () => [-tan / Math.hypot(tan, 1), 0, 1 / Math.hypot(tan, 1), 1]), NORMAL_TOLERANCE, 'a plane rising towards +X');
  // +Y is the next row.
  const south = await normalOf(grid(n, n, (_x, y) => 0.2 + (0.25 * y) / (n - 1)), n);
  assert.ok(south[1]! < -0.05 && Math.abs(south[0]!) < NORMAL_TOLERANCE, `a plane rising towards +Y: ${[...south.subarray(0, 4)]}`);
  // Flat: straight up, exactly (as numbers: the horizontal components are -0).
  assertClose(await normalOf(grid(n, n, () => 0.3), n), grid(n, n, () => [0, 0, 1, 1]), 0, 'a flat field');
});

test('normal on a field of another size than the evaluation, and on an input of the node, which it leaves unchanged', async () => {
  const n = 129;
  const heights = sampled(n, hills);
  const out = await normalOf(heights, n, 65);
  const { dx, dy } = slopeReference(heights, n, SETTINGS.terrainSize, SETTINGS.heightRange);
  assertClose(channel(out, 4, 2), (i) => 1 / Math.hypot(dx[i]!, dy[i]!, 1), NORMAL_TOLERANCE, 'the z component at 129 in an evaluation at 65');

  let before: Float32Array | null = null, after_: Float32Array | null = null, angle: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const input = ctx.input('in') as Field<'field'>;
    before = await ctx.read(input);
    const slope = ops.slope(ctx, input);
    const normal = ops.normal(ctx, input);
    angle = await ctx.read(slope);
    await ctx.read(normal);
    after_ = await ctx.read(input);
  }, { sources: { ramp: { type: 'ref/ramp', params: { gainX: 0.5, gainY: 0, base: 0.25 } } }, inputs: { in: 'ramp.out' } });
  assertIdentical(after_!, before!, 'the input after both ops');
  assertClose(angle!, () => degrees((0.5 * SETTINGS.heightRange) / SETTINGS.terrainSize, 0), ANGLE_TOLERANCE, 'the slope of the ramp');
});

test('what slope and normal refuse: a field that is not square, a kind that is no height', async () => {
  await rig.run((ctx) => {
    const wide = ctx.alloc('field', { size: [9, 5], clear: 0 });
    const color = ctx.alloc('color', { size: 9, clear: 0 });
    assert.throws(() => ops.slope(ctx, wide), (e: Error) => e instanceof FieldAccessError && /ops\.slope: the height is field #\d+, which is 9x5/.test(e.message));
    assert.throws(() => ops.normal(ctx, wide), (e: Error) => e instanceof FieldAccessError && /ops\.normal: the height is field #\d+, which is 9x5/.test(e.message));
    assert.throws(() => ops.slope(ctx, color as unknown as Field<'field'>), (e: Error) => e instanceof FieldAccessError && /of kind "color"; it needs 1 channel/.test(e.message));
    assert.throws(() => ops.normal(ctx, color as unknown as Field<'field'>), (e: Error) => e instanceof FieldAccessError && /of kind "color"; it needs 1 channel/.test(e.message));
  });
});

test('pictures: the slope map and the normal map of a terrain', async () => {
  const n = 513;
  let slope: Float32Array | null = null, normal: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const input = ctx.input('in') as Field<'field'>;
    slope = await ctx.read(ops.slope(ctx, input));
    normal = await ctx.read(ops.normal(ctx, input));
  }, { res: n, sources: { fbm: { type: 'ref/fbm', params: { seed: 5 } } }, inputs: { in: 'fbm.out' } });
  await writeGrey('ops/slope-grey', slope!, n, [0, 90]);
  writeRgb('ops/normal-rgb', normal!, n, 4, [-1, 1]);
  const angles = rangeOf(slope!);
  assert.ok(angles.nonFinite === 0 && angles.min >= 0 && angles.max < 90, JSON.stringify(angles));
  // A terrain has flat places and steep ones, and its normals point every way but down.
  assert.ok(angles.min < 2 && angles.max > 20, `the slopes of the terrain: ${JSON.stringify(angles)}`);
  const x = rangeOf(channel(normal!, 4, 0)), y = rangeOf(channel(normal!, 4, 1)), z = rangeOf(channel(normal!, 4, 2));
  assert.ok(x.min < -0.2 && x.max > 0.2 && y.min < -0.2 && y.max > 0.2 && z.min > 0 && z.max <= 1, JSON.stringify({ x, y, z }));
});
