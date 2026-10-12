import type { OpContext } from '../eval/context.ts';
import { byContext } from '../eval/errors.ts';
import type { Field } from '../gpu/field.ts';
import { requireImage, RESAMPLE_MAX_REACH, RESAMPLE_SHAPE, resampleKernels } from './kernels.ts';
import type { Img, ResampleFilter } from './types.ts';

/** engine.md 3.12. */
const MAX_SIDE = 8192;
const FILTERS: readonly ResampleFilter[] = ['auto', 'nearest', 'bilinear', 'tent', 'bspline'];

/** The largest reduction one pass evaluates: the support of the filter is then 8 source texels per axis. */
const TENT_MAX_STEP = RESAMPLE_MAX_REACH;
const BSPLINE_MAX_STEP = RESAMPLE_MAX_REACH / 2;

/** The divisor of a grid of `n` texels a side (engine.md 1.1). */
const span = (n: number): number => Math.max(n - 1, 1);

/**
 * A field with a ring has one texel more on every side than its grid has vertices: the grid continued by one
 * cell past the terrain, holding what the filter gives there when the source continues with its border texels.
 * A clamped read of such a field is a read of the grid so continued, however far out. The grids between the
 * passes of a large reduction carry a ring, so that the passes together clamp as one filter on the source would;
 * ops.blur runs a wide blur on a coarser grid with a ring for the same reason, and a node that works on a
 * coarser grid of its own asks for one with the `ring` option (engine.md section 5).
 */
export interface Rings { readonly src: 0 | 1; readonly out: 0 | 1 }
const NO_RINGS: Rings = { src: 0, out: 0 };

type PassFilter = 'nearest' | 'bilinear' | 'tent' | 'bspline';

/** One run: `src` onto a new grid of `size` vertices a side. The reduction is within what the filter evaluates in one pass. */
function pass<K extends Img>(ctx: OpContext, src: Field<K>, size: number, filter: PassFilter, rings: Rings): Field<K> {
  // Source texels per written texel, per axis. A filter is never narrower than the source's own texels.
  const scale = (side: number): number => (filter === 'tent' || filter === 'bspline' ? Math.max((side - 1 - 2 * rings.src) / span(size), 1) : 1);
  const width = [scale(src.width), scale(src.height)] as const;
  const reachOf = (w: number): number => Math.min(Math.ceil(filter === 'bspline' ? 2 * w : w), RESAMPLE_MAX_REACH);
  const reach = [reachOf(width[0]), reachOf(width[1])] as const;
  const out = ctx.alloc(src.kind, { size: size + 2 * rings.out });
  ctx.run(resampleKernels[src.kind], {
    in: { src },
    out: { out },
    params: { shape: RESAMPLE_SHAPE[filter === 'bilinear' ? 'tent' : filter], width, reach, ring: [rings.src, rings.out] },
    cost: filter === 'nearest' ? 1 : 4 * reach[0] * reach[1],
  });
  return out;
}

/** ops.resample for a source or a result with a ring. `size` counts the vertices of the result, without its ring. */
export function resampleRings<K extends Img>(ctx: OpContext, src: Field<K>, size: number, filter: PassFilter, rings: Rings): Field<K> {
  const reduction = (Math.max(src.width, src.height) - 1 - 2 * rings.src) / span(size);
  if (filter === 'nearest' || filter === 'bilinear' || reduction <= (filter === 'bspline' ? BSPLINE_MAX_STEP : TENT_MAX_STEP)) {
    return pass(ctx, src, size, filter, rings);
  }
  // A larger reduction goes down the 2:1 grids above the result. The first pass, a triangle of at most 4:1, reaches
  // the finest of them that it can; every later pass is an exact 2:1 step. A cascade of triangles of whole-number
  // reductions is the triangle of their product: when the first pass is one too, as between ladder levels, this
  // is the one wide filter, and otherwise it has its width. A B-spline is the last 2:1 step of such a chain.
  let k = 1;
  while (reduction / 2 ** k > TENT_MAX_STEP) k++;
  const last = filter === 'bspline' ? 1 : 0;
  let current = pass(ctx, src, span(size) * 2 ** k + 1, 'tent', { src: rings.src, out: 1 });
  while (k > last) {
    k--;
    const next = k === 0
      ? pass(ctx, current, size, 'tent', { src: 1, out: rings.out })
      : pass(ctx, current, span(size) * 2 ** k + 1, 'tent', { src: 1, out: 1 });
    ctx.release(current);
    current = next;
  }
  if (filter !== 'bspline') return current;
  const out = pass(ctx, current, size, 'bspline', { src: 1, out: rings.out });
  ctx.release(current);
  return out;
}

export function resample<K extends Img>(
  ctx: OpContext, src: Field<K>, opts: { size: number; filter?: ResampleFilter; ring?: { readonly src?: boolean; readonly out?: boolean } },
): Field<K> {
  requireImage('ops.resample', 'the source', src);
  const size = opts?.size;
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIDE) {
    throw byContext(new RangeError(`ops.resample: the size is ${String(size)}; it is a whole number of texels from 1 to ${MAX_SIDE}`));
  }
  const given = opts.filter ?? 'auto';
  if (!FILTERS.includes(given)) throw byContext(new TypeError(`ops.resample: unknown filter "${String(given)}"; it is one of ${FILTERS.join(', ')}`));
  const ring = opts.ring ?? {};
  if (typeof ring !== 'object' || ring === null || [ring.src, ring.out].some((flag) => flag !== undefined && typeof flag !== 'boolean')) {
    throw byContext(new TypeError('ops.resample: ring is { src?: boolean; out?: boolean }'));
  }
  const rings: Rings = { src: ring.src ? 1 : 0, out: ring.out ? 1 : 0 };
  // A ring continues a grid by one cell, and a grid has a cell from two vertices a side.
  if (rings.src === 1 && Math.min(src.width, src.height) < 4) {
    throw byContext(new RangeError(`ops.resample: ring.src says field #${src.id} has a ring, and it is ${src.width}x${src.height}; a grid with a ring has at least 4 texels a side`));
  }
  if (rings.out === 1 && (size < 2 || size + 2 > MAX_SIDE)) {
    throw byContext(new RangeError(`ops.resample: with ring.out the size is ${size}; the result has two texels more a side, so the size is from 2 to ${MAX_SIDE - 2}`));
  }
  // A triangle as wide as the reduction is, where the result is finer than the source, the bilinear interpolant.
  const filter = given === 'auto' ? 'tent' : given;
  if (rings.src === 0 && rings.out === 0 && filter !== 'bspline' && src.width === size && src.height === size) return ctx.clone(src);
  return resampleRings(ctx, src, size, filter, rings);
}
