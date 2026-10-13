// Ambient occlusion: how sheltered every texel is by the ground around it (kernels.ts says how).
import type { OpContext } from '../eval/context.ts';
import { byContext } from '../eval/errors.ts';
import type { Field } from '../gpu/field.ts';
import { OCCLUSION_OCTAVES, occlusionReachKernel, requireChannels, requireSquare } from './kernels.ts';
import { resample } from './resample.ts';
import { halved } from './smooth.ts';

/** The most distances a texel looks out to: 1, 2, 4, ... texels, which reaches across 8129. */
const MAX_REACHES = 13;
/** How many radii out the farthest ground lies that counts. */
const OUTER = 4;

export interface OcclusionOptions {
  /** The share of the node's progress the op takes. Default [0, 1]. */
  readonly progress?: readonly [from: number, to: number];
}

export async function occlusion(ctx: OpContext, height: Field<'field'>, radius: number, opts: OcclusionOptions = {}): Promise<Field<'field'>> {
  requireChannels('ops.occlusion', 'the height', height, 1);
  requireSquare('ops.occlusion', 'the height', height);
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) {
    throw byContext(new RangeError(`ops.occlusion: the radius is ${String(radius)}; it is a length of at least 0`));
  }
  const res = height.width;
  const [from, to] = opts.progress ?? [0, 1];
  const middle = from + (to - from) / 2;
  // The farthest ground that counts, in texels. Beyond twice the terrain there is none.
  const outer = OUTER * Math.min(ctx.lengthToPx(radius, height), 2 * res);

  // Reach k looks 2^k texels out along the axes and sqrt(2) times as far along the diagonals. Those count
  // whose distance lies inside the farthest and no more than OCCLUSION_OCTAVES doublings below it: six at most.
  const reaches: number[] = [];
  for (let k = 0; k < MAX_REACHES; k++) {
    if (2 ** k < outer && Math.SQRT2 * 2 ** k > outer / 2 ** OCCLUSION_OCTAVES) reaches.push(k);
  }
  // A radius of a quarter of a texel or less reaches no ground: nothing is sheltered.
  if (reaches.length === 0) return ctx.alloc('field', { like: height, clear: 0 });

  // Reaches 0 and 1 read the terrain itself, one and two texels out; reach k from 2 on reads it reduced
  // 2^(k - 1) times, two texels out. The levels are built down to the farthest reach: each a quarter of the
  // one before it, a third of the terrain together.
  const levelOf = (k: number): number => Math.max(k - 1, 0);
  const levels: Field<'field'>[] = [height];
  await ctx.loop(levelOf(reaches.at(-1)!), (i) => {
    levels.push(halved(ctx, levels[i]!, Math.ceil((res - 1) / 2 ** (i + 1)) + 1));
  }, { progress: [from, middle] });

  // From the farthest reach to the nearest: each adds what it finds to the sum of the farther ones, which
  // is brought onto its grid first. The cubic B-spline leaves no trace of the coarser grid in the sum.
  let sum: Field<'field'> | null = null;
  await ctx.loop(reaches.length, (i) => {
    const k = reaches[reaches.length - 1 - i]!;
    const level = levels[levelOf(k)]!;
    if (sum && sum.width !== level.width) {
      const finer = resample(ctx, sum, { size: level.width, filter: 'bspline' });
      ctx.release(sum);
      sum = finer;
    }
    const next = ctx.alloc('field', { like: level });
    ctx.run(occlusionReachKernel, {
      in: { level, carry: sum }, out: { out: next },
      params: { stride: k === 0 ? 1 : 2, outer: outer / 2 ** levelOf(k) },
    });
    if (sum) ctx.release(sum);
    sum = next;
  }, { progress: [middle, to] });
  for (const level of levels.slice(1)) ctx.release(level);
  let total: Field<'field'> = sum!;
  if (total.width !== res) {
    const full = resample(ctx, total, { size: res, filter: 'bspline' });
    ctx.release(total);
    total = full;
  }
  return total;
}
