// The refine module of simulation.md section 2: the standard refinement step of the coarse-to-fine driver (2.4)
// and the iteration-budget rule (2.5), for every node that runs through ops.coarseToFine.

import { defineKernel, hash, mixSeed, noise, ops, type Field, type LadderLevel, type OpContext } from '../../api.ts';
import { DETAIL_SLOPE, JITTER_HALF_WIDTH } from './_constants.ts';

/** `simulate/refine.height`: the fine input plus the change the coarse level made, interpolated at the jittered position. */
export const refineHeightKernel = defineKernel({
  name: 'simulate/refine.height',
  inputs: {
    fineBase: 'field',
    coarse: { kind: 'field', size: 'any' },
    coarseBase: { kind: 'field', size: 'any' },
  },
  outputs: { out: 'field' },
  params: { jitter: 'f32', salt: 'u32', detail: 'f32', noiseSeed: 'u32' },
  includes: [hash, noise],
  cost: 17,
  code: /* wgsl */ `
// Change made at coarse texel c. Exactly 0 where the coarse level changed nothing.
fn delta(c: vec2i) -> f32 { return coarse_at(c) - coarseBase_at(c); }

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let last = vec2i(frame.res) - vec2i(1);
  let onBorder = any(px == vec2i(0)) || any(px == last);
  var t = vec2f(px) * 0.5;                                   // position in coarse texels
  if (!onBorder) { t += (hash_unit2(hash_cell(px, P.salt)) - vec2f(0.5)) * P.jitter; }
  let c = clamp(t, vec2f(0.0), vec2f(coarse_res()) - vec2f(1.0));
  let i = vec2i(floor(c));
  let f = c - floor(c);
  let d = mix(mix(delta(i), delta(i + vec2i(1, 0)), f.x), mix(delta(i + vec2i(0, 1)), delta(i + vec2i(1, 1)), f.x), f.y);
  var v = fineBase_at(px) + d;
  if (P.detail > 0.0 && !onBorder) { v += P.detail * noise_gradient(vec2f(px) * 0.5, P.noiseSeed); }
  return v;
}`,
});

/** `simulate/refine.plane`: gain * U(coarse), with the position of `simulate/refine.height`. */
export const refinePlaneKernel = defineKernel({
  name: 'simulate/refine.plane',
  inputs: { coarse: { kind: 'field', size: 'any' } },
  outputs: { out: 'field' },
  params: { jitter: 'f32', salt: 'u32', gain: 'f32' },
  includes: [hash],
  cost: 5,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let last = vec2i(frame.res) - vec2i(1);
  let onBorder = any(px == vec2i(0)) || any(px == last);
  var t = vec2f(px) * 0.5;                                   // position in coarse texels
  if (!onBorder) { t += (hash_unit2(hash_cell(px, P.salt)) - vec2f(0.5)) * P.jitter; }
  return P.gain * coarse_lerp(t);
}`,
});

/** The kernels of this module: a node that calls refineHeight or refinePlane lists them in NodeDef.kernels. */
export const refineKernels = [refineHeightKernel, refinePlaneKernel] as const;

const isSalt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
/** P.jitter spans the whole jitter: (hash - 0.5) * P.jitter is uniform in the half-width either way. */
const jitterOf = (on: boolean): number => (on ? 2 * JITTER_HALF_WIDTH : 0);

/**
 * The node input on the grid of `level`: `input` itself when it already has that size; otherwise a new field,
 * ops.resample(ctx, input, { size: level.res }), which the caller owns and releases.
 */
export function levelInput(ctx: OpContext, input: Field<'field'>, level: LadderLevel): Field<'field'> {
  return input.width === level.res && input.height === level.res ? input : ops.resample(ctx, input, { size: level.res });
}

export interface RefineHeightOptions {
  readonly coarse: Field<'field'>;        // terrain plane of the coarse level
  readonly coarseBase: Field<'field'>;    // levelInput(...) of the coarse level
  readonly fineBase: Field<'field'>;      // levelInput(...) of the fine level
  readonly jitter: boolean;
  readonly salt: number;                  // u32; ignored when jitter is false and detail is 0
  readonly detail: number;                // 0..1; 0 injects nothing
}

/** A new field of fineBase's size holding the refined terrain: fineBase + U(coarse - coarseBase) + detail noise. */
export function refineHeight(ctx: OpContext, o: RefineHeightOptions): Field<'field'> {
  const detail = o.detail;
  if (typeof detail !== 'number' || !(detail >= 0 && detail <= 1)) throw new RangeError(`refineHeight: detail is ${String(detail)}; it is within 0..1`);
  const used = o.jitter || detail > 0;
  if (used && !isSalt(o.salt)) throw new RangeError(`refineHeight: salt is ${String(o.salt)}; it is an integer 0 .. 2^32 - 1`);
  const salt = used ? o.salt : 0;
  const out = ctx.alloc('field', { like: o.fineBase });
  // The amplitude is a fixed fraction of the fine cell, so the slopes the noise adds are the same at every level.
  const cell = ctx.terrainSize / Math.max(o.fineBase.width - 1, 1);
  ctx.run(refineHeightKernel, {
    in: { fineBase: o.fineBase, coarse: o.coarse, coarseBase: o.coarseBase },
    out: { out },
    params: { jitter: jitterOf(o.jitter), salt, detail: (detail * DETAIL_SLOPE * cell) / ctx.heightRange, noiseSeed: mixSeed(salt, 1) },
  });
  return out;
}

export interface RefinePlaneOptions {
  readonly size: number;                  // res of the fine level
  readonly jitter?: boolean;              // default false
  readonly salt?: number;                 // required when jitter is true; the salt of the matching refineHeight
  readonly gain?: number;                 // default 1
}

/** A new size x size field holding gain * U(coarse). */
export function refinePlane(ctx: OpContext, coarse: Field<'field'>, o: RefinePlaneOptions): Field<'field'> {
  const jitter = o.jitter ?? false;
  const gain = o.gain ?? 1;
  if (typeof gain !== 'number' || !Number.isFinite(gain)) throw new RangeError(`refinePlane: gain is ${String(gain)}; it is a finite number`);
  if (jitter && !isSalt(o.salt)) throw new RangeError(`refinePlane: with jitter, salt is the salt of the matching refineHeight, an integer 0 .. 2^32 - 1, not ${String(o.salt)}`);
  const out = ctx.alloc('field', { size: o.size });
  ctx.run(refinePlaneKernel, { in: { coarse }, out: { out }, params: { jitter: jitterOf(jitter), salt: jitter ? o.salt! : 0, gain } });
  return out;
}

/**
 * Iterations per level, index = LadderLevel.index (simulation.md 2.5). `total` is the work as iterations on the
 * base level alone; one iteration at level i counts ratio^i of them, and a finer level takes at most `perLevel`.
 */
export function levelBudget(total: number, levels: number, perLevel: number, ratio: 0.5 | 0.25): { readonly iterations: readonly number[]; readonly equivalent: number } {
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) throw new RangeError(`levelBudget: total is ${String(total)}; it is a finite number of at least 0`);
  if (!Number.isInteger(levels) || levels < 1) throw new RangeError(`levelBudget: levels is ${String(levels)}; a run has at least one level`);
  if (!Number.isInteger(perLevel) || perLevel < 0) throw new RangeError(`levelBudget: perLevel is ${String(perLevel)}; it is a whole number of iterations`);
  if (ratio !== 0.5 && ratio !== 0.25) throw new RangeError(`levelBudget: ratio is ${String(ratio)}; it is 0.5 or 0.25`);
  const finer = levels - 1;
  // The base iterations that n iterations on each finer level amount to.
  const tail = (n: number): number => (n * ratio * (1 - ratio ** finer)) / (1 - ratio);
  const detail = finer > 0 ? Math.min(perLevel, Math.floor(total / 2)) : 0;
  const base = total < 0.5 ? 0 : Math.ceil(total - tail(detail));
  const iterations = [base];
  for (let i = 0; i < finer; i++) iterations.push(detail);
  return { iterations, equivalent: base + tail(detail) };
}
