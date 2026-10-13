// How a node looks at a field at a scale: smoothed by a Gaussian of a standard deviation, or by its derivatives.
//
// It differs from ops.blur at the border, and only there. A blur that clamps continues the source level beyond
// its border, so ground that slopes towards the border comes out higher or lower than it is by 0.4 of the slope
// times the standard deviation: more than the relief a node measures at that scale, and a node that subtracts
// the blur from the source, or differentiates it, draws a frame along the border. Each pass here instead fits a
// polynomial through the samples the source has, weighted by the Gaussian, and takes its value, its slope or
// its bend at the texel. Away from the border the weights are symmetric and these are the Gaussian and its
// first two derivatives; at the border a plane stays the plane it is, and a paraboloid keeps its slope and its
// bend.
import type { OpContext } from '../eval/context.ts';
import { byContext } from '../eval/errors.ts';
import type { Field } from '../gpu/field.ts';
import { borderKernels, FIT_MAX_TAPS, fitKernels, requireImage, requireSquare } from './kernels.ts';
import { resample } from './resample.ts';
import type { Img } from './types.ts';

/**
 * How many standard deviations the taps reach, where they can. Cut at 3 a Gaussian has 2.7 % less than its
 * variance and at 3.5 it has 0.6 % less, and how much less depends on where the cut falls between two texels:
 * a quantity that is all variance, such as what a smooth terrain stands above its smoothed surface, would
 * then differ by that much between two levels of the ladder.
 */
const REACH = 4;
/** The widest Gaussian one pass holds, in texels: its taps still reach 3.5 standard deviations. */
export const SMOOTH_MAX_SIGMA = FIT_MAX_TAPS / 3.5;
/** Below this many texels no neighbour has a weight that matters: a smoothed field is the field. */
export const SMOOTH_MIN_SIGMA = 0.25;
/** The narrowest Gaussian a derivative is fitted with, in texels: below it the fit is the difference of neighbours. */
export const FIT_MIN_SIGMA = 0.7;

/** How far inside the border a triangle of reduction `r` leaves the border vertices of a slope, in steps of the reduced grid. */
const inset = (r: number): number => (r * r - 1) / (6 * r * r);

/** The grid a Gaussian of some standard deviation is evaluated on: the source's own, or a coarser one with a ring (engine.md section 5). */
export interface Scale<K extends Img = Img> {
  /** The source on that grid. */
  readonly field: Field<K>;
  /** Whether the caller releases `field`: it is the source itself when the grid is its own. */
  readonly owned: boolean;
  /** The standard deviation of the Gaussian still to apply, in texels of the grid. */
  readonly sigma: number;
  /** Metres between two texels of the grid. */
  readonly cell: number;
  /** Whether the grid is a coarser one: it then has a ring of one texel, which is no sample of the source. */
  readonly ring: boolean;
  /** How far from the border, in texels of the grid, samples are left out and filled from those inside. */
  readonly skip: number;
  /** Whether a smoothed value is the mean of the samples and not the value of the line through them. */
  readonly mean: boolean;
  /** The side of the source's own grid, to bring a result back to. */
  readonly full: number;
}

export interface SmoothOptions {
  /**
   * For a quantity that is never below 0, such as a mean of squares: a smoothed value is the mean of the samples.
   * At the border the line through the samples continues a trend, and can continue it below 0.
   */
  readonly mean?: boolean;
  /** A length: the samples this close to the border are not trusted. They are left out and filled from those inside. */
  readonly skip?: number;
}

export interface FitWants { readonly value?: boolean; readonly slope?: boolean; readonly bend?: boolean }
export interface Fitted<K extends Img = Img> { readonly value: Field<K> | null; readonly slope: Field<K> | null; readonly bend: Field<K> | null }

function checkSigma(op: string, sigma: number): void {
  if (typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma < 0) {
    throw byContext(new RangeError(`${op}: sigma is ${String(sigma)}; it is a length of at least 0`));
  }
}

/**
 * The grid on which a Gaussian of standard deviation `sigma` (a length) fits the taps of one pass. Too wide a
 * Gaussian goes down to a coarser grid with a triangle and comes back up with the cubic B-spline (`restore`).
 * Variances add: in texels of `src` the triangle of a reduction r has (r * r - 1) / 6 and the B-spline r * r / 3,
 * and the Gaussian between them supplies the rest. The grid is the finest of the halvings of `src` on which
 * that Gaussian fits.
 */
export function scale<K extends Img>(ctx: OpContext, src: Field<K>, sigma: number, opts: SmoothOptions = {}): Scale<K> {
  requireImage('ops.scale', 'the source', src);
  requireSquare('ops.scale', 'the source', src);
  checkSigma('ops.scale', sigma);
  const given = opts.skip ?? 0;
  if (typeof given !== 'number' || !Number.isFinite(given) || given < 0) {
    throw byContext(new RangeError(`ops.scale: skip is ${String(given)}; it is a length of at least 0`));
  }
  const texels = ctx.lengthToPx(sigma, src);
  const mean = opts.mean === true;
  const skip = ctx.lengthToPx(given, src);
  const last = src.width - 1;
  const metres = ctx.terrainSize / Math.max(last, 1);
  // What is left out never reaches the middle of the grid: a sample is always left.
  const within = (count: number, vertices: number): number => Math.max(Math.min(count, (vertices - 1) / 2 - 1), 0);
  if (texels <= SMOOTH_MAX_SIGMA) {
    return { field: src, owned: false, sigma: texels, cell: metres, ring: false, skip: within(skip, src.width), mean, full: src.width };
  }

  // The coarsest grid has three vertices a side. On two, both are border vertices and neither tells how far the
  // triangle has drawn the other in: a plane would not stay the plane it is. A Gaussian still too wide there, of
  // more than four terrain widths, is cut to the widest a pass holds: either way the result is all but the
  // plane that fits the whole field best.
  let size = src.width;
  let coarse = texels;
  for (let halvings = 1; coarse > SMOOTH_MAX_SIGMA && size > 3; halvings++) {
    size = Math.ceil(last / 2 ** halvings) + 1;
    const r = last / (size - 1);
    coarse = Math.sqrt(Math.max((texels * texels - (r * r - 1) / 6 - (r * r) / 3) / (r * r), 0));
  }
  // The triangle clamps at the border. Its ring holds the source continued level, which is no sample of the
  // source: the fits fill the ring themselves. Its border vertices are taken back to the border.
  const reduced = resample(ctx, src, { size, filter: 'tent', ring: { out: true } });
  const ratio = last / (size - 1);
  const made = {
    owned: true, sigma: Math.min(coarse, SMOOTH_MAX_SIGMA), cell: metres * ratio, ring: true, mean, full: src.width,
    // The cut is at the same place as on the source's own grid, so that two levels of the ladder agree
    // along the border too. A vertex just inside it is a triangle over one coarse step to either side and
    // holds a little of what lies beyond the cut: a caller leaves out a margin that allows for that.
    skip: within(skip / ratio, size),
  } as const;
  // A mean of the samples wants them as the triangle left them: taken back to the border, a quantity that is
  // never below 0 could come out below it.
  if (mean) return { field: reduced, ...made };
  const field = ctx.alloc(src.kind, { like: reduced });
  ctx.run(borderKernels[src.kind], { in: { src: reduced }, out: { out: field }, params: { beta: inset(ratio), ring: 1 } });
  ctx.release(reduced);
  return { field, ...made };
}

/**
 * `src` on the grid of `size` vertices a side, about half its own, through a triangle as wide as the reduction:
 * one level of a pyramid. Its border vertices are taken back to the border, so that a slope is the same slope
 * at every level, up to the border.
 */
export function halved(ctx: OpContext, src: Field<'field'>, size: number): Field<'field'> {
  const reduced = resample(ctx, src, { size, filter: 'tent' });
  const out = ctx.alloc('field', { like: reduced });
  ctx.run(borderKernels.field, { in: { src: reduced }, out: { out }, params: { beta: inset((src.width - 1) / Math.max(size - 1, 1)), ring: 0 } });
  ctx.release(reduced);
  return out;
}

/**
 * One pass of the fit along x (`axis` 0) or y (`axis` 1) over a field of the scale's grid; an output not asked
 * for is not computed into a field.
 */
export function fit<K extends Img>(ctx: OpContext, at: Scale<K>, src: Field<NoInfer<K>>, axis: 0 | 1, want: FitWants): Fitted<K> {
  requireImage('ops.fit', 'the field', src);
  requireSquare('ops.fit', 'the field', src);
  if (axis !== 0 && axis !== 1) throw byContext(new RangeError(`ops.fit: the axis is ${String(axis)}; it is 0 for x or 1 for y`));
  if (!want.value && !want.slope && !want.bend) throw byContext(new TypeError('ops.fit: nothing is wanted; ask for the value, the slope or the bend'));
  const derivative = want.slope === true || want.bend === true;
  // A derivative needs neighbours whatever the standard deviation: three samples fix a parabola, and at the
  // border the third is two texels away.
  const sigma = derivative ? Math.max(at.sigma, FIT_MIN_SIGMA) : Math.max(at.sigma, SMOOTH_MIN_SIGMA);
  const taps = Math.min(Math.max(Math.ceil(REACH * sigma), derivative ? 2 : 0), FIT_MAX_TAPS);
  const out = {
    value: want.value ? ctx.alloc(src.kind, { like: src }) : null,
    slope: want.slope ? ctx.alloc(src.kind, { like: src }) : null,
    bend: want.bend ? ctx.alloc(src.kind, { like: src }) : null,
  };
  ctx.run(fitKernels[src.kind], {
    in: { src }, out,
    params: { dir: axis === 0 ? [1, 0] : [0, 1], taps, perSigma: 1 / sigma, ring: at.ring ? 1 : 0, skip: at.skip, level: at.mean },
    cost: 2 * taps + 2,
  });
  return out as Fitted<K>;
}

/**
 * A field of the scale's grid on the source's own grid. On the source's own grid that is `field` itself;
 * otherwise a new field, and the caller releases the one it gave.
 */
export function restore<K extends Img>(ctx: OpContext, at: Scale<K>, field: Field<NoInfer<K>>): Field<K> {
  requireImage('ops.restore', 'the field', field);
  if (!at.ring) return field;
  return resample(ctx, field, { size: at.full, filter: 'bspline', ring: { src: true } });
}

/** `src` smoothed by a Gaussian whose standard deviation is `sigma`, a length: a new field. Below a quarter of a texel it is a copy. */
export function smooth<K extends Img>(ctx: OpContext, src: Field<K>, sigma: number, opts: SmoothOptions = {}): Field<K> {
  requireImage('ops.smooth', 'the source', src);
  requireSquare('ops.smooth', 'the source', src);
  checkSigma('ops.smooth', sigma);
  const at = scale(ctx, src, sigma, opts);
  if (!at.ring && at.sigma < SMOOTH_MIN_SIGMA) return ctx.clone(src);
  const rows = fit(ctx, at, at.field, 0, { value: true }).value!;
  if (at.owned) ctx.release(at.field);
  const both = fit(ctx, at, rows, 1, { value: true }).value!;
  ctx.release(rows);
  const out = restore(ctx, at, both);
  if (out !== both) ctx.release(both);
  return out;
}
