import type { OpContext } from '../eval/context.ts';
import { byContext } from '../eval/errors.ts';
import type { Field } from '../gpu/field.ts';
import { BLUR_MAX_RADIUS, blurKernels, requireImage, requireSquare } from './kernels.ts';
import { resampleRings } from './resample.ts';
import type { Img } from './types.ts';

/** Below this many texels a blur changes nothing that matters and is a copy (engine.md section 5). */
const BLUR_MIN_SIGMA = 0.25;
/**
 * The widest Gaussian evaluated on the grid it is asked for, in texels: 3 sigma is then 30 texels, 61 loads per
 * pass. A wider one runs on a coarser grid, where its sigma is between half this and this. The larger the value,
 * the smaller the error of a wide blur; the 64 loads of a pass bound it. To calibrate.
 */
export const BLUR_DIRECT_MAX_SIGMA = 10;
/**
 * What a blur evaluated on a coarser grid may differ by from the same Gaussian evaluated on the field's own grid,
 * as a fraction of the value range of the input. Measured with BLUR_DIRECT_MAX_SIGMA = 10 over sigmas of 10 to 42
 * texels: at most 0.0014, on steps with speckle and a sigma just above the limit. What remains is that the two
 * drop their weights beyond 3 sigma on different grids. To calibrate.
 */
export const BLUR_COARSE_ERROR = 0.003;

/** The Gaussian of `sigma` texels of `src`'s own grid, as two passes. `sigma` is at most BLUR_DIRECT_MAX_SIGMA. */
function gaussian<K extends Img>(ctx: OpContext, src: Field<K>, sigma: number): Field<K> {
  // Weights beyond 3 sigma are dropped: with no neighbour inside that distance the blur is the identity.
  const radius = Math.min(Math.floor(3 * sigma), BLUR_MAX_RADIUS);
  if (radius < 1) return ctx.clone(src);
  const kernel = blurKernels[src.kind];
  const falloff = 1 / (2 * sigma * sigma);
  const cost = 2 * radius + 1;
  const rows = ctx.alloc(src.kind, { like: src });
  ctx.run(kernel, { in: { src }, out: { out: rows }, params: { dir: [1, 0], radius, falloff }, cost });
  const out = ctx.alloc(src.kind, { like: src });
  ctx.run(kernel, { in: { src: rows }, out: { out }, params: { dir: [0, 1], radius, falloff }, cost });
  ctx.release(rows);
  return out;
}

export function blur<K extends Img>(ctx: OpContext, src: Field<K>, sigma: number): Field<K> {
  requireImage('ops.blur', 'the source', src);
  requireSquare('ops.blur', 'the source', src);
  if (typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma < 0) {
    throw byContext(new RangeError(`ops.blur: sigma is ${String(sigma)}; it is a length of at least 0`));
  }
  const texels = ctx.lengthToPx(sigma, src);
  if (texels < BLUR_MIN_SIGMA) return ctx.clone(src);
  if (texels <= BLUR_DIRECT_MAX_SIGMA) return gaussian(ctx, src, texels);

  // A wide blur: down to a grid `ratio` times coarser with a triangle filter, a Gaussian there, and back up with
  // the cubic B-spline. Variances add: the triangle has (ratio^2 - 1) / 6 and the B-spline ratio^2 / 3, in texels
  // of `src`, and the Gaussian between them supplies what is missing from sigma^2. The grid is the finest of the
  // 2:1 grids below `src` on which that Gaussian fits one pass. It carries a ring (resample.ts), so the clamped
  // reads of the Gaussian are reads of `src` continued by its border texels, as on the field's own grid.
  const last = src.width - 1;
  let size = src.width;
  let coarse = texels;
  for (let k = 1; coarse > BLUR_DIRECT_MAX_SIGMA && size > 2; k++) {
    size = Math.ceil(last / 2 ** k) + 1;
    const ratio = last / (size - 1);
    coarse = Math.sqrt(Math.max((texels * texels) / (ratio * ratio) - 0.5 + 1 / (6 * ratio * ratio), 0));
  }
  const small = resampleRings(ctx, src, size, 'tent', { src: 0, out: 1 });
  // Only a sigma of more than ten terrain widths is still too wide on the 2 x 2 grid. It is cut to the limit: either way
  // the result is all but the mean of the field.
  const blurred = gaussian(ctx, small, Math.min(coarse, BLUR_DIRECT_MAX_SIGMA));
  ctx.release(small);
  const out = resampleRings(ctx, blurred, src.width, 'bspline', { src: 1, out: 0 });
  ctx.release(blurred);
  return out;
}
