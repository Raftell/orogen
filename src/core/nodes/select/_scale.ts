// src/core/nodes/select/_scale.ts
// How the nodes of this category look at the terrain at a scale: slope, aspect, curvature, peaks and roughness
// take a radius and measure the ground smoothed by a Gaussian of that standard deviation, or its derivatives.
//
// It differs from ops.blur at the terrain's border, and only there. A blur that clamps continues the terrain
// level beyond its border, so ground that slopes towards the border comes out higher or lower than it is by
// 0.4 of the slope times the radius: more than the relief a node measures at that radius, and every node here
// would select a frame along the border. Each pass instead fits a polynomial through the samples the terrain
// has, weighted by the Gaussian, and takes its value, its slope or its bend at the texel. Away from the border
// the weights are symmetric and these are the Gaussian and its first two derivatives; at the border a plane
// stays the plane it is, and a paraboloid keeps its slope and its bend.
import { defineKernel, ops, type Field, type OpContext } from '../../api.ts';

const MAX_TAPS = 30;               // on each side of the centre: 61 loads per pass, within the 64 of engine.md 3.15
/**
 * How many standard deviations the taps reach, where they can. Cut at 3 a Gaussian has 2.7 % less than its
 * variance and at 3.5 it has 0.6 % less, and how much less depends on where the cut falls between two texels:
 * a quantity that is all variance, such as what a smooth terrain stands above its smoothed surface, would
 * then differ by that much between two levels of the ladder.
 */
const REACH = 4;
/** The widest Gaussian one pass holds, in texels: its taps still reach 3.5 standard deviations. */
const MAX_SIGMA = MAX_TAPS / 3.5;
/** Below this many texels no neighbour has a weight that matters: a smoothed terrain is the terrain. */
const MIN_SIGMA = 0.25;
/** The narrowest Gaussian a derivative is fitted with, in texels: below it the fit is the difference of neighbours. */
export const MIN_FIT_SIGMA = 0.7;

const fit = defineKernel({
  name: 'select/scale.fit',
  inputs: { src: 'field' },
  // value: the line through the samples, at the texel. slope and bend: the first and second derivative of the
  // parabola through them, per texel and per texel squared.
  outputs: { value: 'field', slope: 'field', bend: 'field' },
  // margin: how many texels at each end of a row or column are not samples of the terrain but texels to fill.
  // perSigma: 1 / sigma, in texels. level: 1 takes the value as the mean of the samples, not from the line.
  params: { dir: 'vec2i', taps: 'i32', perSigma: 'f32', margin: 'i32', level: 'u32' },
  cost: 2 * MAX_TAPS + 2,
  code: /* wgsl */ `
const MAX_TAPS = ${MAX_TAPS};

fn compute(px: vec2i, uv: vec2f) -> Out {
  let taps = clamp(P.taps, 0, MAX_TAPS);
  let last = dot(vec2i(src_res()) - vec2i(1), P.dir);
  let lo = min(max(P.margin, 0), last);
  let hi = max(last - max(P.margin, 0), lo);
  let at = dot(px, P.dir);
  let row = px - at * P.dir;
  // Sums are taken of differences from one sample of the terrain: a constant stays that constant.
  let base = src_at(row + clamp(at, lo, hi) * P.dir);
  // The moments of the weights over the samples there are, with offsets counted in sigmas so that the fourth
  // moment stays near the zeroth, and the moments of the weighted differences.
  var m0 = 0.0;
  var m1 = 0.0;
  var m2 = 0.0;
  var m3 = 0.0;
  var m4 = 0.0;
  var t0 = 0.0;
  var t1 = 0.0;
  var t2 = 0.0;
  for (var i = -taps; i <= taps; i++) {
    let j = at + i;
    if (j < lo || j > hi) { continue; }
    let x = f32(i) * P.perSigma;
    let xx = x * x;
    let w = exp(-0.5 * xx);
    let d = src_at(row + j * P.dir) - base;
    m0 += w;
    m1 += w * x;
    m2 += w * xx;
    m3 += w * xx * x;
    m4 += w * xx * xx;
    t0 += w * d;
    t1 += w * x * d;
    t2 += w * xx * d;
  }
  // The line through the samples. With samples on both sides alike m1 is 0 and its value is the mean. Samples
  // at a single offset fix no line: there the mean is taken, and the slope is 0.
  var value = base;
  var slope = 0.0;
  var bend = 0.0;
  let spread = m0 * m2 - m1 * m1;
  let line = spread > 1e-4 * m0 * m2;
  if (line && P.level == 0u) {
    value = base + (m2 * t0 - m1 * t1) / spread;
  } else if (m0 > 0.0) {
    value = base + t0 / m0;
  }
  if (line) { slope = (m0 * t1 - m1 * t0) / spread; }
  // The parabola, by Cramer's rule. Samples at fewer than three offsets fix none: the slope stays the line's.
  let a = m2 * m4 - m3 * m3;
  let b = m1 * m4 - m2 * m3;
  let c = m1 * m3 - m2 * m2;
  let det = m0 * a - m1 * b + m2 * c;
  if (line && det > 1e-4 * m0 * m2 * m4) {
    slope = (m0 * (t1 * m4 - m3 * t2) - t0 * b + m2 * (m1 * t2 - m2 * t1)) / det;
    bend = 2.0 * (m0 * (m2 * t2 - m3 * t1) - m1 * (m1 * t2 - m2 * t1) + t0 * c) / det;
  }
  return Out(value, slope * P.perSigma, bend * P.perSigma * P.perSigma);
}`,
});

// A triangle that clamps at the border leaves the border vertices of the grid it reduces to a little inside the
// terrain: by `beta` of the step to the next vertex, where the terrain is a slope. This takes that back, along
// each axis, from the vertex and its neighbour alone. With `ring` 1 the grid has a ring and its vertices are
// the texels 1 to last - 1; with 0 they are all its texels.
const border = defineKernel({
  name: 'select/scale.border',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { beta: 'f32', ring: 'i32' },
  cost: 4,
  code: /* wgsl */ `
// The vertex taken back, from itself and its neighbour: (v - beta * n) / (1 - beta), written so that a
// constant stays that constant.
fn back(v: f32, n: f32) -> f32 {
  return v + (v - n) * P.beta / (1.0 - P.beta);
}

fn alongX(p: vec2i, last: vec2i) -> f32 {
  let v = src_at(p);
  if (last.x - 2 * P.ring < 1) { return v; }
  if (p.x == P.ring) { return back(v, src_at(p + vec2i(1, 0))); }
  if (p.x == last.x - P.ring) { return back(v, src_at(p - vec2i(1, 0))); }
  return v;
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let last = vec2i(src_res()) - vec2i(1);
  let v = alongX(px, last);
  if (last.y - 2 * P.ring < 1) { return v; }
  if (px.y == P.ring) { return back(v, alongX(px + vec2i(0, 1), last)); }
  if (px.y == last.y - P.ring) { return back(v, alongX(px - vec2i(0, 1), last)); }
  return v;
}`,
});

/** How far inside the border a triangle of reduction `r` leaves the border vertices of a slope, in steps of the reduced grid. */
const inset = (r: number): number => (r * r - 1) / (6 * r * r);

/** The kernels of this module; a node that calls any of its functions lists them. */
export const scaleKernels = [fit, border] as const;

/** The grid a Gaussian of some radius is evaluated on: the terrain's own, or a coarser one with a ring. */
export interface Scale {
  /** The terrain on that grid. */
  readonly field: Field<'field'>;
  /** Whether the caller releases `field`: it is the terrain itself when the grid is its own. */
  readonly owned: boolean;
  /** The standard deviation of the Gaussian still to apply, in texels of the grid. */
  readonly sigma: number;
  /** Metres between two texels of the grid. */
  readonly cell: number;
  /** Whether the grid is a coarser one: it then has a ring of one texel, which is no sample of the terrain. */
  readonly ring: boolean;
  /** How many texels at each end of a row or column are no samples and are filled from those inside: the ring, and what the caller leaves out. */
  readonly margin: number;
  /** Whether a smoothed value is the mean of the samples and not the value of the line through them. */
  readonly level: boolean;
  /** The side of the terrain's own grid, to bring a result back to. */
  readonly full: number;
}

export interface ScaleOptions {
  /**
   * For a quantity that is never below 0, such as a mean of squares: a smoothed value is the mean of the samples.
   * At the border the line through the samples continues a trend, and can continue it below 0.
   */
  readonly level?: boolean;
  /** A length: the samples this close to the border are not trusted. They are left out and filled from those inside. */
  readonly skip?: number;
}

/**
 * The grid on which a Gaussian of standard deviation `radius` (a length) fits the taps of one pass. Too wide a
 * Gaussian goes down to a coarser grid with a triangle and comes back up with the cubic B-spline (`restore`).
 * Variances add: in texels of `src` the triangle of a reduction r has (r * r - 1) / 6 and the B-spline r * r / 3,
 * and the Gaussian between them supplies the rest. The grid is the finest of the halvings of `src` on which
 * that Gaussian fits.
 */
export function scaleOf(ctx: OpContext, src: Field<'field'>, radius: number, opts: ScaleOptions = {}): Scale {
  const sigma = ctx.lengthToPx(Math.max(radius, 0), src);   // soft: any finite number can arrive
  const level = opts.level === true;
  const skip = ctx.lengthToPx(Math.max(opts.skip ?? 0, 0), src);
  const last = src.width - 1;
  const metres = ctx.terrainSize / Math.max(last, 1);
  // What is left out never reaches the middle of the grid: a sample is always left.
  const within = (margin: number, texels: number): number => Math.max(Math.min(margin, Math.floor((texels - 1) / 2)), 0);
  if (sigma <= MAX_SIGMA) {
    return { field: src, owned: false, sigma, cell: metres, ring: false, margin: within(Math.ceil(skip), src.width), level, full: src.width };
  }

  let size = src.width;
  let coarse = sigma;
  for (let halvings = 1; coarse > MAX_SIGMA && size > 2; halvings++) {
    size = Math.ceil(last / 2 ** halvings) + 1;
    const r = last / (size - 1);
    coarse = Math.sqrt(Math.max((sigma * sigma - (r * r - 1) / 6 - (r * r) / 3) / (r * r), 0));
  }
  // The triangle clamps at the border. Its ring holds the terrain continued level, which is no sample of the
  // terrain: the fits fill the ring themselves. Its border vertices are taken back to the border.
  const reduced = ops.resample(ctx, src, { size, filter: 'tent', ring: { out: true } });
  const ratio = last / (size - 1);
  // A coarse vertex is the triangle over one coarse step to either side: what is left out is left out a step further in.
  const margin = within(1 + (skip > 0 ? Math.ceil(skip / ratio) + 1 : 0), size + 2);
  const scale = { owned: true, sigma: Math.min(coarse, MAX_SIGMA), cell: metres * ratio, ring: true, margin, level, full: src.width } as const;
  // A mean of the samples wants them as the triangle left them: taken back to the border, a quantity that is
  // never below 0 could come out below it.
  if (level) return { field: reduced, ...scale };
  const field = ctx.alloc('field', { like: reduced });
  ctx.run(border, { in: { src: reduced }, out: { out: field }, params: { beta: inset(ratio), ring: 1 } });
  ctx.release(reduced);
  return { field, ...scale };
}

/**
 * `src` on the grid of `size` vertices a side, about half its own, through a triangle as wide as the reduction:
 * one level of a pyramid. Its border vertices are taken back to the border, so that a slope is the same slope
 * at every level, up to the border.
 */
export function halved(ctx: OpContext, src: Field<'field'>, size: number): Field<'field'> {
  const reduced = ops.resample(ctx, src, { size, filter: 'tent' });
  const out = ctx.alloc('field', { like: reduced });
  ctx.run(border, { in: { src: reduced }, out: { out }, params: { beta: inset((src.width - 1) / Math.max(size - 1, 1)), ring: 0 } });
  ctx.release(reduced);
  return out;
}

/** One pass of the fit along x (`dir` 0) or y (`dir` 1) over a field of the scale's grid; an output not asked for is not computed into a field. */
export function fitPass(
  ctx: OpContext, scale: Scale, src: Field<'field'>, dir: 0 | 1, want: { readonly value?: boolean; readonly slope?: boolean; readonly bend?: boolean },
): { readonly value: Field<'field'> | null; readonly slope: Field<'field'> | null; readonly bend: Field<'field'> | null } {
  const derivative = want.slope === true || want.bend === true;
  // A derivative needs neighbours whatever the radius: three samples fix a parabola, and at the border the
  // third is two texels away.
  const sigma = derivative ? Math.max(scale.sigma, MIN_FIT_SIGMA) : Math.max(scale.sigma, MIN_SIGMA);
  const taps = Math.min(Math.max(Math.ceil(REACH * sigma), derivative ? 2 : 0), MAX_TAPS);
  const out = {
    value: want.value ? ctx.alloc('field', { like: src }) : null,
    slope: want.slope ? ctx.alloc('field', { like: src }) : null,
    bend: want.bend ? ctx.alloc('field', { like: src }) : null,
  };
  ctx.run(fit, {
    in: { src }, out,
    params: { dir: dir === 0 ? [1, 0] : [0, 1], taps, perSigma: 1 / sigma, margin: scale.margin, level: scale.level },
    cost: 2 * taps + 2,
  });
  return out;
}

/** A field of the scale's grid on the terrain's own grid. `owned` says whether it is a new field: on the terrain's own grid it is `field` itself. */
export function restore(ctx: OpContext, scale: Scale, field: Field<'field'>): { readonly field: Field<'field'>; readonly owned: boolean } {
  if (!scale.ring) return { field, owned: false };
  return { field: ops.resample(ctx, field, { size: scale.full, filter: 'bspline', ring: { src: true } }), owned: true };
}

/**
 * `src` smoothed by a Gaussian whose standard deviation is `radius`, a length. `owned` says whether the caller
 * releases the field: below a quarter of a texel nothing is smoothed and it is `src` itself.
 */
export function smoothed(ctx: OpContext, src: Field<'field'>, radius: number, opts: ScaleOptions = {}): { readonly field: Field<'field'>; readonly owned: boolean } {
  const scale = scaleOf(ctx, src, radius, opts);
  if (!scale.ring && scale.sigma < MIN_SIGMA) return { field: src, owned: false };
  const rows = fitPass(ctx, scale, scale.field, 0, { value: true }).value!;
  if (scale.owned) ctx.release(scale.field);
  const both = fitPass(ctx, scale, rows, 1, { value: true }).value!;
  ctx.release(rows);
  const out = restore(ctx, scale, both);
  if (out.owned) ctx.release(both);
  return { field: out.field, owned: true };
}
