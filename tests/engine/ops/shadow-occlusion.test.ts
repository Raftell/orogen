// ops.shadow and ops.occlusion (engine.md section 5): the share of the sun's disc a texel sees over the terrain
// towards the sun, against the length and the penumbra of the shadow a step casts; and how sheltered a texel is
// by the ground around it, against the sines of the angles the rim of a pit and the sides of a bowl stand above it.
//
// Sizes: fields of at most 257 x 257 floats. No list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { ops, type OcclusionOptions, type ShadowOptions } from '../../../src/core/api.ts';
import { writeGrey } from '../pictures.ts';
import { assertClose, assertIdentical, grid, hills, rangeOf, sampled, SETTINGS, startOps, upload } from './rig.ts';

const rig = await startOps();
after(() => rig.dispose());

const TAN = (degrees: number): number => Math.tan((degrees * Math.PI) / 180);
const ATAN = (tangent: number): number => (Math.atan(tangent) * 180) / Math.PI;
type Settings = { readonly terrainSize?: number; readonly heightRange?: number };

async function shadowOf(data: Float32Array, n: number, opts: ShadowOptions, settings: Settings = {}, res = 65): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', n, data);
    const result = await ops.shadow(ctx, src, opts);
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], ['field', n, n, false]);
    assert.notEqual(result.id, src.id, 'the result is a new field');
    out = await ctx.read(result);
  }, { res, settings });
  return out!;
}

async function occlusionOf(data: Float32Array, n: number, radius: number, settings: Settings = {}, res = 65, opts?: OcclusionOptions): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const src = upload(ctx, 'field', n, data);
    const result = await ops.occlusion(ctx, src, radius, opts);
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], ['field', n, n, false]);
    assert.notEqual(result.id, src.id, 'the result is a new field');
    out = await ctx.read(result);
  }, { res, settings });
  return out!;
}

// ---- shadow --------------------------------------------------------------------------------------------------------

const N = 129;
/** Metres between two texels of a field of N texels, and metres of a height of 1, with the settings of the rig. */
const CELL = SETTINGS.terrainSize / (N - 1), RANGE = SETTINGS.heightRange;
/** Level ground at 0.25 with a plateau 0.25 higher, 256 m, from column 80 on: a cliff that faces -X. */
const STEP = 0.25, EDGE = 80;
const plateau = grid(N, N, (x) => (x >= EDGE ? 0.25 + STEP : 0.25));
const transposed = (data: Float32Array, n: number): Float32Array => grid(n, n, (x, y) => data[x * n + y]!);
const mirrored = (data: Float32Array, n: number): Float32Array => grid(n, n, (x, y) => data[y * n + (n - 1 - x)]!);

test('shadow: level ground, and ground that rises towards the sun less steeply than its rays, sees all of it', async () => {
  // A sun exactly on the horizon, between the axes: the march interpolates two equal heights there, and level
  // ground must not rise above itself by the rounding of that (on lavapipe mix() of two equal numbers is not that number).
  for (const [angle, elevation, disc] of [[0, 30, 0], [200, 5, 0], [45, 60, 10], [90, 90, 0], [270, 0, 0], [300, 0, 0], [17, 0, 0]] as const) {
    assertIdentical(await shadowOf(grid(N, N, () => 0.4), N, { angle, elevation, disc }), grid(N, N, () => 1), `level ground, the sun at ${angle} / ${elevation}`);
  }
  // The part of a disc that lies below the horizontal is seen by nothing: of a sun half set, level ground sees half.
  assertClose(await shadowOf(grid(N, N, () => 0.4), N, { angle: 300, elevation: 0, disc: 5 }), () => 0.5, 1e-6, 'a sun half below the horizon');
  // A plane that rises towards +X at 0.25 m/m, 14 degrees: a sun at 30 degrees in the +X shines over it, and one
  // at 10 degrees is below its horizon everywhere but on the last column, which has no ground beyond it.
  const ramp = grid(N, N, (x) => x / (N - 1));
  assertIdentical(await shadowOf(ramp, N, { angle: 0, elevation: 30 }), grid(N, N, () => 1), 'the sun above the slope');
  const below = await shadowOf(ramp, N, { angle: 0, elevation: 10 });
  assertIdentical(below, grid(N, N, (x) => (x === N - 1 ? 1 : 0)), 'the sun below the slope');
  // From the other side the same sun lights all of it.
  assertIdentical(await shadowOf(ramp, N, { angle: 180, elevation: 10 }), grid(N, N, () => 1), 'the sun behind the slope');
});

test('shadow: a cliff of 256 m casts a shadow 256 m / tan(elevation) long, away from a point sun; heights and distances are physical', async () => {
  // The sun in the +X, over the plateau: the ground at its foot lies in shadow as far as the ray from the edge reaches.
  for (const elevation of [20, 30, 50, 75]) {
    const out = await shadowOf(plateau, N, { angle: 0, elevation });
    const reach = (STEP * RANGE) / TAN(elevation) / CELL;       // texels; never a whole number here
    assertIdentical(out, grid(N, N, (x) => (x < EDGE && EDGE - x < reach ? 0 : 1)), `elevation ${elevation}: a shadow of ${reach} texels`);
  }
  // Twice the height range is a cliff twice as high, and twice the terrain size is ground twice as far away.
  const tall = await shadowOf(plateau, N, { angle: 0, elevation: 50 }, { heightRange: 2 * RANGE });
  assertIdentical(tall, grid(N, N, (x) => (x < EDGE && EDGE - x < (2 * STEP * RANGE) / TAN(50) / CELL ? 0 : 1)), 'twice the height range');
  const wide = await shadowOf(plateau, N, { angle: 0, elevation: 30 }, { terrainSize: 2 * SETTINGS.terrainSize });
  assertIdentical(wide, grid(N, N, (x) => (x < EDGE && EDGE - x < (STEP * RANGE) / TAN(30) / (2 * CELL) ? 0 : 1)), 'twice the terrain size');
  // The cell is that of the field itself: the same field in an evaluation at another resolution casts the same shadow.
  assertIdentical(await shadowOf(plateau, N, { angle: 0, elevation: 30 }, {}, 257), await shadowOf(plateau, N, { angle: 0, elevation: 30 }), 'in an evaluation at 257');
  // A sun at the zenith casts none, and a sun on the horizon shadows all the ground at the cliff's foot.
  assertIdentical(await shadowOf(plateau, N, { angle: 0, elevation: 90 }), grid(N, N, () => 1), 'the sun at the zenith');
  assertIdentical(await shadowOf(plateau, N, { angle: 0, elevation: 0 }), grid(N, N, (x) => (x < EDGE ? 0 : 1)), 'the sun on the horizon');
});

test('shadow: the angle is the direction towards the sun, 0 at +X and 90 at +Y, and the shadow falls the other way', async () => {
  const east = await shadowOf(plateau, N, { angle: 0, elevation: 30 });
  // The plateau in the +Y and the sun at 90 degrees: the same picture with its axes exchanged.
  assertIdentical(await shadowOf(transposed(plateau, N), N, { angle: 90, elevation: 30 }), transposed(east, N), 'the sun in the +Y');
  // The plateau in the -X and the sun at 180 degrees: the mirror image.
  assertIdentical(await shadowOf(mirrored(plateau, N), N, { angle: 180, elevation: 30 }), mirrored(east, N), 'the sun in the -X');
  // The sun behind the cliff lights its foot: nothing is shadowed.
  assertIdentical(await shadowOf(plateau, N, { angle: 180, elevation: 30 }), grid(N, N, () => 1), 'the sun in the -X over the plateau in the +X');
  // 360 degrees is 0 degrees and -90 is 270, up to the border: the sine of 360 degrees is -2.4e-16 and the
  // cosine of 270 is -1.8e-16, and a step that far out of the terrain would leave its first row or column unshadowed.
  assertIdentical(await shadowOf(plateau, N, { angle: 360, elevation: 30 }), east, '360 degrees');
  assertIdentical(await shadowOf(plateau, N, { angle: -360, elevation: 30 }), east, '-360 degrees');
  const south = await shadowOf(mirrored(transposed(mirrored(plateau, N), N), N), N, { angle: 270, elevation: 30 });
  assertIdentical(await shadowOf(mirrored(transposed(mirrored(plateau, N), N), N), N, { angle: -90, elevation: 30 }), south, '-90 degrees');
  let shadowed = 0;
  for (let y = 0; y < N; y++) if (south[y * N] === 0) shadowed++;
  assert.equal(shadowed, 13, 'texels of the first column in the shadow of a plateau in the -Y, the sun at 270 degrees');

  // A pillar and a sun on the diagonal, 45 degrees between +X and +Y: the shadow runs towards -X -Y, as long as
  // the pillar is high over the tangent, and nowhere else.
  const pillar = grid(N, N, (x, y) => (Math.abs(x - 64) <= 1 && Math.abs(y - 64) <= 1 ? 0.5 : 0.25));
  const out = await shadowOf(pillar, N, { angle: 45, elevation: 30 });
  const reach = (0.25 * RANGE) / TAN(30) / (CELL * Math.SQRT2);  // diagonal steps: 9.8
  for (let k = 3; k <= 20; k++) {
    // The pillar is three texels across: its near side is one step nearer than its middle.
    assert.equal(out[(64 - k) * N + 64 - k], k - 1 < reach ? 0 : 1, `${k} diagonal steps behind the pillar`);
    assert.equal(out[(64 + k) * N + 64 + k], 1, `${k} diagonal steps towards the sun`);
    assert.equal(out[(64 + k) * N + 64 - k], 1, `${k} steps to the side`);
  }
  // A direction between the axes and the diagonal: the shadow of the pillar lies along it, on the far side from the sun.
  const slanted = await shadowOf(pillar, N, { angle: 20, elevation: 30 });
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (slanted[y * N + x]! < 0.5 && (Math.abs(x - 64) > 1 || Math.abs(y - 64) > 1)) { sumX += x - 64; sumY += y - 64; count++; }
    }
  }
  const bearing = (Math.atan2(sumY / count, sumX / count) * 180) / Math.PI;
  assert.ok(count > 10 && Math.abs(bearing - (20 - 180)) < 3, `${count} texels lie in the shadow, towards ${bearing} degrees`);
});

test('shadow: a disc with a height gives the edge of a shadow a penumbra: the share of the disc above the horizon', async () => {
  // The horizon of a texel d metres from the foot of the cliff stands atan(256 / d) high. Of a disc from
  // elevation - disc to elevation + disc it hides the part below that.
  for (const [elevation, disc] of [[30, 10], [45, 3], [20, 15], [8, 15]] as const) {
    const out = await shadowOf(plateau, N, { angle: 0, elevation, disc });
    const lo = elevation - disc, hi = elevation + disc;
    const expected = grid(N, N, (x) => {
      // On the plateau the horizon is the horizontal. The part of the disc below that is never seen, by any texel.
      const horizon = x >= EDGE ? 0 : ATAN((STEP * RANGE) / ((EDGE - x) * CELL));
      return Math.min(Math.max((hi - Math.max(horizon, lo, 0)) / (hi - lo), 0), 1);
    });
    // WGSL holds atan to 4096 ULP: the angle of a horizon near 45 degrees may be off by 5e-4 radians on some
    // adapter, which is 5e-3 of the narrowest disc here, 6 degrees.
    assertClose(out, expected, 5e-3, `elevation ${elevation}, disc ${disc}`);
    const range = rangeOf(out);
    assert.ok(range.min === 0 && range.max <= 1, `the shares lie in ${range.min}..${range.max}`);
    if (lo >= 0) assert.equal(range.max, 1, 'in the open the whole disc is seen');
    else assert.ok(Math.abs(range.max - hi / (hi - lo)) < 1e-6, `a disc that dips below the horizontal is seen in part at the most: ${range.max}`);
  }
  // A disc of no height is a point: the edge is hard.
  assertIdentical(await shadowOf(plateau, N, { angle: 0, elevation: 30, disc: 0 }), await shadowOf(plateau, N, { angle: 0, elevation: 30 }), 'a disc of 0');
});

test('shadow: on hills the shadows lengthen as the sun sinks, and nothing is shadowed that faces a high sun', async () => {
  const n = 257;
  const land = sampled(n, hills);
  const shares: number[] = [];
  for (const elevation of [70, 40, 20, 8]) {
    const out = await shadowOf(land, n, { angle: 135, elevation, disc: 2 }, {}, 257);
    const range = rangeOf(out);
    assert.ok(range.nonFinite === 0 && range.min >= 0 && range.max <= 1, `elevation ${elevation}: ${JSON.stringify(range)}`);
    shares.push(out.reduce((sum, v) => sum + (1 - v), 0) / out.length);
    if (elevation === 20) await writeGrey('ops/shadow/hills-20', out, n);
  }
  assert.equal(shares[0], 0, 'the hills are nowhere as steep as a sun at 70 degrees');
  assert.ok(shares[1]! < shares[2]! && shares[2]! < shares[3]! && shares[3]! > 0.2, `the shadowed share grows: ${shares.join(', ')}`);
});

test('shadow and occlusion report their progress within the share they are given, and refuse what is no angle, no length or no height field', async () => {
  // What a loop of the node reports is its share of the node's progress (engine.md 4.7): each op hands the share
  // it is given to its loops, the march of the shadows to its one and the occlusion a half to each of its two.
  // The shares are read where the op passes them: how many progress events an evaluation emits depends on its timing.
  const land = sampled(N, hills);
  const shares: (readonly [number, number] | undefined)[] = [];
  await rig.run(async (ctx) => {
    const watched: typeof ctx = Object.create(ctx, {
      loop: { value: (count: number, body: (i: number) => void, opts?: { readonly progress?: readonly [number, number] }) => {
        shares.push(opts?.progress);
        return ctx.loop(count, body, opts);
      } },
    });
    const src = upload(ctx, 'field', N, land);
    await ops.shadow(watched, src, { angle: 30, elevation: 20, disc: 4 });
    await ops.shadow(watched, src, { angle: 30, elevation: 20, disc: 4, progress: [0.1, 0.4] });
    await ops.occlusion(watched, src, 0.05);
    await ops.occlusion(watched, src, 0.05, { progress: [0.4, 1] });
  });
  assert.deepEqual(shares, [undefined, [0.1, 0.4], [0, 0.5], [0.5, 1], [0.4, 0.7], [0.7, 1]]);

  const wrong = async (run: Parameters<typeof rig.fail>[0], message: RegExp): Promise<void> => {
    const error = await rig.fail(run);
    assert.equal(error.kind, 'binding', error.message);
    assert.match(error.message, message);
  };
  await wrong(async (ctx) => { await ops.shadow(ctx, ctx.alloc('field', { size: 9 }), { angle: 0, elevation: 91 }); }, /ops\.shadow: elevation is 91; it is 0 to 90 degrees/);
  await wrong(async (ctx) => { await ops.shadow(ctx, ctx.alloc('field', { size: 9 }), { angle: 0, elevation: 30, disc: -1 }); }, /ops\.shadow: disc is -1; it is 0 to 90 degrees/);
  await wrong(async (ctx) => { await ops.shadow(ctx, ctx.alloc('field', { size: 9 }), { angle: Number.NaN, elevation: 30 }); }, /ops\.shadow: angle is NaN; it is a direction in degrees/);
  await wrong(async (ctx) => { await ops.shadow(ctx, ctx.alloc('color', { size: 9 }) as never, { angle: 0, elevation: 30 }); }, /ops\.shadow: the height is field #\d+ of kind "color"; it needs 1 channel/);
  await wrong(async (ctx) => { await ops.shadow(ctx, ctx.alloc('field', { size: [9, 5] }), { angle: 0, elevation: 30 }); }, /ops\.shadow: the height is field #\d+, which is 9x5/);
  await wrong(async (ctx) => { await ops.occlusion(ctx, ctx.alloc('field', { size: 9 }), -0.1); }, /ops\.occlusion: the radius is -0\.1; it is a length of at least 0/);
  await wrong(async (ctx) => { await ops.occlusion(ctx, ctx.alloc('vec2', { size: 9 }) as never, 0.1); }, /ops\.occlusion: the height is field #\d+ of kind "vec2"; it needs 1 channel/);
});

// ---- occlusion -----------------------------------------------------------------------------------------------------

/** The sine of the angle whose tangent is `rise`: what one hollow hides, 0 where the ground does not rise. */
const hidden = (rise: number): number => (rise > 0 ? rise / Math.sqrt(1 + rise * rise) : 0);
/** The weight of a distance at a radius, both in texels: from a quarter of the radius to four times the radius, most at the radius, as sin^2 over the four doublings. */
function weight(distance: number, radius: number): number {
  const below = -Math.log2(distance / (4 * radius));
  return below <= 0 || below >= 4 ? 0 : Math.sin((Math.PI * below) / 4) ** 2;
}
/** The lengths, in texels, of the four axes a texel looks along to both sides. */
const AXES = [1, Math.SQRT2, 1, Math.SQRT2];
/** The distances a radius of `radius` texels looks out to, in texels: those that double from one texel and lie inside four radii and no more than four doublings below. */
const reaches = (radius: number): number[] => Array.from({ length: 13 }, (_, k) => 2 ** k).filter((d) => d < 4 * radius && Math.SQRT2 * d > radius / 4);

test('occlusion: a plane is not sheltered at any tilt, nor is a dome; a radius below a quarter of a texel reaches nothing', async () => {
  for (const radius of [0.01, 0.05, 0.25]) {
    const out = await occlusionOf(grid(N, N, (x, y) => 0.1 + (0.6 * x + 0.3 * y) / (N - 1)), N, radius);
    // The two ends of an axis on a plane cancel up to the rounding of two heights near 1: a few 1e-8 of height, times 32 metres of height a metre here.
    assertClose(out, () => 0, 2e-5, `a plane at a radius of ${radius}`);
    const dome = await occlusionOf(grid(N, N, (x, y) => 0.9 - 0.5 * (((x - 64) / 64) ** 2 + ((y - 64) / 64) ** 2)), N, radius);
    assertClose(dome, () => 0, 2e-5, `a dome at a radius of ${radius}`);
  }
  const land = sampled(N, hills);
  for (const radius of [0, 0.2 / (N - 1)]) assertIdentical(await occlusionOf(land, N, radius), new Float32Array(N * N), `a radius of ${radius}`);
});

test('occlusion: a pit is sheltered by the sines of the angles its rim stands above it, as a mean over the axes and the distances', async () => {
  // A pit one texel wide and 10.24 m deep, at a radius of one texel: the op looks one and two texels out. One
  // texel out along the two axes, 32 m, the rim stands 10.24 m higher on both sides; along the diagonals, 45.25 m.
  const depth = 0.01;
  const pit = grid(N, N, (x, y) => (x === 64 && y === 64 ? 0.5 - depth : 0.5));
  let sum = 0;
  for (const reach of reaches(1)) for (const axis of AXES) sum += 0.5 * 0.25 * weight(axis * reach, 1) * hidden((depth * RANGE) / (axis * reach * CELL));
  const out = await occlusionOf(pit, N, 1 / (N - 1));
  // WGSL holds sin to 2^-11 and the weights are squares of sines: the adapters tested agree with this within
  // 3e-5 (select/occlusion asserts as much of the same sum), and another may not do better.
  assert.ok(Math.abs(out[64 * N + 64]! - sum) <= 1e-4, `the pit is sheltered ${out[64 * N + 64]}; expected ${sum}`);
  let around = 0;
  for (let i = 0; i < out.length; i++) if (i !== 64 * N + 64 && out[i] !== 0) around++;
  assert.equal(around, 0, 'texels around the pit that are sheltered');
  // Heights are physical: a pit twice as deep in metres hides more, by the sines.
  let deep = 0;
  for (const reach of reaches(1)) for (const axis of AXES) deep += 0.5 * 0.25 * weight(axis * reach, 1) * hidden((2 * depth * RANGE) / (axis * reach * CELL));
  const tall = await occlusionOf(pit, N, 1 / (N - 1), { heightRange: 2 * RANGE });
  assert.ok(Math.abs(tall[64 * N + 64]! - deep) <= 1e-4 && deep > sum + 0.05, `at twice the height range the pit is sheltered ${tall[64 * N + 64]}; expected ${deep}`);
});

test('occlusion: a bowl is sheltered alike all over its floor, by its curvature and the radius', async () => {
  // z = a r^2: the two ends of every axis stand a d above a texel at any place, d metres out. The op looks out at
  // distances that double, on levels of the terrain reduced as far, which leaves a paraboloid its bend.
  const n = 257, cell = SETTINGS.terrainSize / (n - 1);
  const bowl = (curve: number): Float32Array => grid(n, n, (x, y) => 0.1 + curve * (((x - 128) / 128) ** 2 + ((y - 128) / 128) ** 2));
  const expected = (curve: number, radius: number): number => {
    const perMetre = (curve * RANGE) / (128 * cell) ** 2;    // a, in metres of height per metre squared
    let sum = 0;
    for (const reach of reaches(radius)) for (const axis of AXES) sum += 0.5 * 0.25 * weight(axis * reach, radius) * hidden(perMetre * axis * reach * cell);
    return sum;
  };
  const results: number[] = [];
  for (const [curve, radius] of [[0.4, 6], [0.4, 12], [0.2, 12], [0.8, 3]] as const) {
    const out = await occlusionOf(bowl(curve), n, radius / (n - 1), {}, 257);
    const want = expected(curve, radius);
    // Inside four radii of the border the far end of an axis is nearer than the distance looked for.
    let worst = 0;
    const margin = Math.ceil(4 * radius * Math.SQRT2) + 8;
    for (let y = margin; y < n - margin; y++) for (let x = margin; x < n - margin; x++) worst = Math.max(worst, Math.abs(out[y * n + x]! - want));
    assert.ok(worst <= 0.01 * want + 1e-4, `curve ${curve}, radius ${radius} texels: off by ${worst} of ${want}`);
    const range = rangeOf(out);
    assert.ok(range.nonFinite === 0 && range.min >= 0 && range.max <= 1, JSON.stringify(range));
    results.push(want);
  }
  // A wider radius looks at ground that stands higher, and a shallower bowl hides less.
  assert.ok(results[1]! > results[0]! && results[2]! < results[1]!, results.join(', '));
});

test('occlusion: the floors of valleys are sheltered and the crests are not, up to the border, alike on two ladder levels', async () => {
  const n = 257;
  const land = sampled(n, hills);
  const out = await occlusionOf(land, n, 0.05, {}, 257);
  await writeGrey('ops/occlusion/hills', out, n);
  // The more sheltered half of the terrain lies lower than the less sheltered half.
  let low = 0, lowCount = 0, high = 0, highCount = 0;
  const sorted = Float32Array.from(out).sort();
  const median = sorted[sorted.length >> 1]!;
  for (let i = 0; i < out.length; i++) {
    if (out[i]! > median) { low += land[i]!; lowCount++; } else { high += land[i]!; highCount++; }
  }
  assert.ok(low / lowCount < high / highCount - 0.05, `sheltered ground lies at ${low / lowCount}, open ground at ${high / highCount}`);
  // The border is no frame: its texels are sheltered as much, in the mean, as the texels eight in from it.
  const ring = (inset: number): number => {
    let sum = 0, count = 0;
    for (let i = inset; i < n - inset; i++) {
      for (const [x, y] of [[i, inset], [i, n - 1 - inset], [inset, i], [n - 1 - inset, i]] as const) { sum += out[y * n + x]!; count++; }
    }
    return sum / count;
  };
  assert.ok(Math.abs(ring(0) - ring(8)) < 0.35 * ring(8), `the border is sheltered ${ring(0)} in the mean, the texels eight in from it ${ring(8)}`);
  // One surface on two levels of the ladder: at shared vertices the two agree within 3 % of the standard deviation.
  const coarse = await occlusionOf(sampled(N, hills), N, 0.05);
  let mean = 0;
  for (const v of coarse) mean += v / coarse.length;
  let variance = 0, squares = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      variance += (coarse[y * N + x]! - mean) ** 2;
      squares += (coarse[y * N + x]! - out[2 * y * n + 2 * x]!) ** 2;
    }
  }
  assert.ok(Math.sqrt(squares / variance) < 0.03, `129 against 257: ${Math.sqrt(squares / variance)} of the standard deviation`);
});
