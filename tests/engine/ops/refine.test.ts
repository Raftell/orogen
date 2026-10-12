// The refine module of the simulate category (simulation.md 2.4, 2.5): levelInput, refineHeight, refinePlane and
// levelBudget, which every node that runs through ops.coarseToFine uses. coarse-to-fine.test.ts runs them inside
// the driver; this file holds each to what simulation.md states of it.
//
// Sizes: a coarse grid of 33 x 33 and a fine one of 65 x 65 floats; no list is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { hashCell, hashUnit, hashU32, mixSeed, ops, type LadderLevel } from '../../../src/core/api.ts';
import { DETAIL_SLOPE, JITTER_HALF_WIDTH } from '../../../src/core/nodes/simulate/_constants.ts';
import {
  levelBudget, levelInput, refineHeight, refineHeightKernel, refineKernels, refinePlane, refinePlaneKernel,
} from '../../../src/core/nodes/simulate/_refine.ts';
import { assertClose, assertIdentical, grid, hills, sampled, SETTINGS, speckle, startOps, upload, worstOf } from './rig.ts';

const rig = await startOps({ kernels: refineKernels });
after(() => rig.dispose());

const COARSE = 33, FINE = 65;
const level = (res: number, index: number): LadderLevel => ({ res, cellSize: SETTINGS.terrainSize / (res - 1), index, count: 2, progress: [0, 1] });

/** The input of a node at the two levels, and what a coarse level made of it: a dent, zero on the border ring. */
const fineBase = sampled(FINE, hills);
const coarseBase = sampled(COARSE, (u, v) => hills(u, v) + 0.01 * Math.sin(40 * u));
const dent = (x: number, y: number): number => -0.2 * Math.fround(Math.sin((Math.PI * x) / (COARSE - 1)) * Math.sin((Math.PI * y) / (COARSE - 1)) * (0.5 + 0.5 * speckle(x, y, 3)));
const coarse = grid(COARSE, COARSE, (x, y) => coarseBase[y * COARSE + x]! + dent(x, y));
/** The change the coarse level made, as the kernel forms it: a float32 difference of the two planes. */
const delta = grid(COARSE, COARSE, (x, y) => coarse[y * COARSE + x]! - coarseBase[y * COARSE + x]!);
const onRing = (x: number, y: number, n: number): boolean => x === 0 || y === 0 || x === n - 1 || y === n - 1;

/** refineHeight on the planes above, read back. */
async function refined(o: { jitter: boolean; salt: number; detail: number; coarse?: Float32Array }): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const result = refineHeight(ctx, {
      coarse: upload(ctx, 'field', COARSE, o.coarse ?? coarse), coarseBase: upload(ctx, 'field', COARSE, coarseBase),
      fineBase: upload(ctx, 'field', FINE, fineBase), jitter: o.jitter, salt: o.salt, detail: o.detail,
    });
    assert.deepEqual([result.kind, result.width, result.height, result.readOnly], ['field', FINE, FINE, false]);
    out = await ctx.read(result);
  }, { res: FINE });
  return out!;
}

/** refinePlane of a coarse plane, read back. */
async function plane(data: Float32Array, o: Parameters<typeof refinePlane>[2]): Promise<Float32Array> {
  let out: Float32Array | null = null;
  await rig.run(async (ctx) => {
    const result = refinePlane(ctx, upload(ctx, 'field', COARSE, data), o);
    assert.deepEqual([result.kind, result.width, result.height], ['field', o.size, o.size]);
    out = await ctx.read(result);
  }, { res: FINE });
  return out!;
}

/** U(plane) at fine texel (x, y) without jitter: bilinear at px / 2, in float64. */
function upsampled(data: Float32Array, x: number, y: number): number {
  const x0 = Math.floor(x / 2), y0 = Math.floor(y / 2);
  const x1 = Math.min(x0 + 1, COARSE - 1), y1 = Math.min(y0 + 1, COARSE - 1);
  const fx = x / 2 - x0, fy = y / 2 - y0;
  const top = data[y0 * COARSE + x0]! * (1 - fx) + data[y0 * COARSE + x1]! * fx;
  const bottom = data[y1 * COARSE + x0]! * (1 - fx) + data[y1 * COARSE + x1]! * fx;
  return top * (1 - fy) + bottom * fy;
}

test('the kernels are named for their module, and the module lists both', () => {
  assert.deepEqual(refineKernels.map((kernel) => kernel.name), ['simulate/refine.height', 'simulate/refine.plane']);
  assert.deepEqual([refineHeightKernel.def.cost, Object.keys(refineHeightKernel.def.params ?? {})], [17, ['jitter', 'salt', 'detail', 'noiseSeed']]);
  assert.deepEqual(Object.keys(refinePlaneKernel.def.params ?? {}), ['jitter', 'salt', 'gain']);
  // Neither reads frame.seed: a node without a seed param can run them (simulation.md 1.4).
  for (const kernel of refineKernels) assert.ok(!/frame\.seed|seedFor\(/.test(kernel.def.code), kernel.name);
});

test('levelInput: the input itself on its own grid, otherwise ops.resample onto the grid of the level', async () => {
  await rig.run(async (ctx) => {
    const input = upload(ctx, 'field', FINE, fineBase);
    assert.equal(levelInput(ctx, input, level(FINE, 1)), input, 'at its own size the input is returned, not copied');
    const brought = levelInput(ctx, input, level(COARSE, 0));
    assert.notEqual(brought.id, input.id);
    assert.deepEqual([brought.width, brought.height, brought.readOnly], [COARSE, COARSE, false]);
    assertIdentical(await ctx.read(brought), await ctx.read(ops.resample(ctx, input, { size: COARSE })), 'levelInput against ops.resample');
    // The caller owns and releases what it was given.
    ctx.release(brought);
  }, { res: FINE });
});

test('refineHeight: a terrain the coarse level did not change is the fine input, bit for bit', async () => {
  for (const o of [{ jitter: false, salt: 0, detail: 0 }, { jitter: true, salt: 12345, detail: 0 }]) {
    assertIdentical(await refined({ ...o, coarse: coarseBase }), fineBase, `jitter ${o.jitter}`);
  }
});

test('refineHeight without jitter: the fine input plus the change of the coarse level, interpolated at px / 2', async () => {
  const out = await refined({ jitter: false, salt: 0, detail: 0 });
  assertClose(out, (i) => fineBase[i]! + upsampled(delta, i % FINE, Math.floor(i / FINE)), 1e-6, 'fineBase + U(coarse - coarseBase)');
  // An even fine texel coincides with a coarse texel: there the change is that texel's own, exactly.
  const shared = grid(COARSE, COARSE, (x, y) => out[2 * y * FINE + 2 * x]!);
  assertIdentical(shared, grid(COARSE, COARSE, (x, y) => fineBase[2 * y * FINE + 2 * x]! + delta[y * COARSE + x]!), 'the shared vertices');
  // The interpolation is of the differences: a plane that only went down gives a change of at most 0.
  assert.equal(worstOf(out, (i) => Math.min(out[i]!, fineBase[i]!)).difference, 0, 'no texel rose');
  assert.ok(worstOf(out, fineBase).difference > 0.05, 'the dent is there');
});

test('refineHeight with jitter: the position moves by at most a quarter of a coarse texel, never on the border ring', async () => {
  const salt = mixSeed(SETTINGS.seed, FINE);
  const plain = await refined({ jitter: false, salt: 0, detail: 0 });
  const jittered = await refined({ jitter: true, salt, detail: 0 });
  assertIdentical(await refined({ jitter: true, salt, detail: 0 }), jittered, 'the same salt gives the same field');
  assert.ok(worstOf(await refined({ jitter: true, salt: salt + 1, detail: 0 }), jittered).difference > 1e-4, 'another salt gives another field');

  // The position the kernel takes, from the TypeScript twins of its hashes (engine.md 4.8).
  let moved = 0;
  const expected = grid(FINE, FINE, (x, y) => {
    if (onRing(x, y, FINE)) return plain[y * FINE + x]!;
    const h = hashCell(x, y, salt);
    const tx = Math.min(Math.max(x / 2 + (hashUnit(h) - 0.5) * 2 * JITTER_HALF_WIDTH, 0), COARSE - 1);
    const ty = Math.min(Math.max(y / 2 + (hashUnit(hashU32(h)) - 0.5) * 2 * JITTER_HALF_WIDTH, 0), COARSE - 1);
    assert.ok(Math.abs(tx - x / 2) <= JITTER_HALF_WIDTH && Math.abs(ty - y / 2) <= JITTER_HALF_WIDTH);
    const x0 = Math.floor(tx), y0 = Math.floor(ty), fx = tx - x0, fy = ty - y0;
    const at = (cx: number, cy: number): number => delta[Math.min(cy, COARSE - 1) * COARSE + Math.min(cx, COARSE - 1)]!;
    const d = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    if (Math.abs(d - (plain[y * FINE + x]! - fineBase[y * FINE + x]!)) > 1e-5) moved++;
    return fineBase[y * FINE + x]! + d;
  });
  assertClose(jittered, expected, 2e-6, 'the jittered refinement against the position computed on the CPU');
  assert.ok(moved > 0.5 * FINE * FINE, `the jitter moves most texels (${moved})`);
  const ring = (data: Float32Array): Float32Array => grid(FINE, FINE, (x, y) => (onRing(x, y, FINE) ? data[y * FINE + x]! : 0));
  assertIdentical(ring(jittered), ring(plain), 'the border ring has no jitter');
});

test('refineHeight with detail: noise of at most DETAIL_SLOPE of the fine cell, none on the border ring and none at 0', async () => {
  const salt = mixSeed(SETTINGS.seed, FINE);
  const plain = await refined({ jitter: false, salt, detail: 0 });
  const full = await refined({ jitter: false, salt, detail: 1 });
  const half = await refined({ jitter: false, salt, detail: 0.5 });
  // P.detail = detail * DETAIL_SLOPE * dx_fine / R, and gradient noise lies in -1..1.
  const amplitude = (DETAIL_SLOPE * (SETTINGS.terrainSize / (FINE - 1))) / SETTINGS.heightRange;
  const added = grid(FINE, FINE, (x, y) => full[y * FINE + x]! - plain[y * FINE + x]!);
  const range = worstOf(added, () => 0);
  assert.ok(range.difference <= amplitude * (1 + 1e-3) + 1e-7, `the noise reaches ${range.difference}; its amplitude is ${amplitude}`);
  assert.ok(range.difference > 0.2 * amplitude, `the noise is there: it reaches ${range.difference} of ${amplitude}`);
  assertClose(grid(FINE, FINE, (x, y) => half[y * FINE + x]! - plain[y * FINE + x]!), (i) => 0.5 * added[i]!, 1e-6, 'half the detail is half the noise');
  let onBorder = 0;
  for (let y = 0; y < FINE; y++) for (let x = 0; x < FINE; x++) if (onRing(x, y, FINE) && full[y * FINE + x] !== plain[y * FINE + x]) onBorder++;
  assert.equal(onBorder, 0, 'the border ring receives no noise');
  // The lattice cell of the noise is two fine texels: it is 0 on the vertices shared with the coarse level.
  assert.ok(worstOf(grid(COARSE, COARSE, (x, y) => added[2 * y * FINE + 2 * x]!), () => 0).difference <= 1e-6, 'no noise on the shared vertices');
  assert.ok(worstOf(await refined({ jitter: false, salt: salt + 1, detail: 1 }), full).difference > 0.1 * amplitude, 'another salt gives other noise');
});

test('refinePlane: gain * U(coarse), with the position of the matching refineHeight', async () => {
  const data = grid(COARSE, COARSE, (x, y) => speckle(x, y, 9));
  const up = await plane(data, { size: FINE });
  assertIdentical(grid(COARSE, COARSE, (x, y) => up[2 * y * FINE + 2 * x]!), data, 'the shared vertices keep their values');
  assertClose(up, (i) => upsampled(data, i % FINE, Math.floor(i / FINE)), 1e-6, 'bilinear at px / 2');
  assertClose(await plane(data, { size: FINE, gain: 0.25 }), (i) => 0.25 * up[i]!, 1e-6, 'gain');
  assertIdentical(await plane(data, { size: FINE, jitter: false, gain: 1 }), up, 'the defaults are no jitter and a gain of 1');

  // The same t as refineHeight: a plane refined with the terrain's jitter and salt follows the terrain's texels.
  const salt = mixSeed(SETTINGS.seed, FINE);
  const withJitter = await plane(delta, { size: FINE, jitter: true, salt });
  const terrain = await refined({ jitter: true, salt, detail: 0 });
  assertClose(withJitter, (i) => terrain[i]! - fineBase[i]!, 1e-6, 'refinePlane of the change against the change refineHeight made');
  assert.ok(worstOf(withJitter, await plane(delta, { size: FINE })).difference > 1e-4, 'the jitter is applied');
});

test('what the helpers refuse: a detail outside 0..1, a salt that is no u32, jitter without a salt, a gain that is no number', async () => {
  const fails = async (work: Parameters<typeof rig.fail>[0], message: RegExp): Promise<void> => {
    const error = await rig.fail(work, { res: FINE });
    assert.match(error.message, message);
  };
  const planes = (ctx: Parameters<Parameters<typeof rig.fail>[0]>[0]) => ({
    coarse: upload(ctx, 'field', COARSE, coarse), coarseBase: upload(ctx, 'field', COARSE, coarseBase), fineBase: upload(ctx, 'field', FINE, fineBase),
  });
  await fails((ctx) => { refineHeight(ctx, { ...planes(ctx), jitter: false, salt: 0, detail: 1.5 }); }, /refineHeight: detail is 1\.5; it is within 0\.\.1/);
  await fails((ctx) => { refineHeight(ctx, { ...planes(ctx), jitter: true, salt: -1, detail: 0 }); }, /refineHeight: salt is -1/);
  await fails((ctx) => { refinePlane(ctx, upload(ctx, 'field', COARSE, coarse), { size: FINE, jitter: true }); }, /refinePlane: with jitter, salt is the salt of the matching refineHeight/);
  await fails((ctx) => { refinePlane(ctx, upload(ctx, 'field', COARSE, coarse), { size: FINE, gain: Number.NaN }); }, /refinePlane: gain is NaN/);
  // Without jitter and detail the salt is ignored, whatever it is.
  await rig.run((ctx) => { refineHeight(ctx, { ...planes(ctx), jitter: false, salt: Number.NaN, detail: 0 }); }, { res: FINE });
});

test('levelBudget refuses what is no budget', () => {
  assert.throws(() => levelBudget(-1, 3, 96, 0.5), /levelBudget: total is -1/);
  assert.throws(() => levelBudget(Number.NaN, 3, 96, 0.5), /levelBudget: total is NaN/);
  assert.throws(() => levelBudget(10, 0, 96, 0.5), /levelBudget: levels is 0/);
  assert.throws(() => levelBudget(10, 3, 1.5, 0.5), /levelBudget: perLevel is 1\.5/);
  assert.throws(() => levelBudget(10, 3, 96, 0.3 as 0.5), /levelBudget: ratio is 0\.3/);
  assert.deepEqual(levelBudget(0.4, 3, 96, 0.25), { iterations: [0, 0, 0], equivalent: 0 });
});
