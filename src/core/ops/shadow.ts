// Cast shadows: how much of the sun's disc every texel sees over the terrain around it (kernels.ts says how).
import type { OpContext } from '../eval/context.ts';
import { byContext } from '../eval/errors.ts';
import type { Field } from '../gpu/field.ts';
import { requireChannels, requireSquare, shadowGatherKernel, shadowMarchKernel, shadowStartKernel } from './kernels.ts';

/** The steepest ray the march counts with, as a tangent: beyond 89.99994 degrees nothing casts a shadow anyway. */
const STEEPEST = 1e6;
/**
 * The strips a disc with a height is marched in. Whether the horizon lies below a strip, above it or inside it
 * is exact; where inside is an estimate that is too low when the ground nearest the strip's lower edge is not
 * the ground that makes the horizon, and a strip is as much of the result as it is of the disc. Against the
 * horizon found texel by texel on ref/fbm, the result of one strip is off by more than 0.1 on 0.2 to 11 % of
 * the texels, the more the taller the disc, and by up to 0.9; that of four on 0.14 % at most, and by up to 0.26.
 */
const STRIPS = 4;

export interface ShadowOptions {
  /** Degrees: the direction from the terrain towards the sun, as seen from above (engine.md 1.8). */
  readonly angle: number;
  /** Degrees: the height of the sun's centre above the horizon, 0..90. */
  readonly elevation: number;
  /** Degrees: half the height of the sun's disc, which the edge of a shadow is blurred over. Default 0, a point. */
  readonly disc?: number;
  /** The share of the node's progress the march takes. Default [0, 1]. */
  readonly progress?: readonly [from: number, to: number];
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;
const tangent = (angle: number): number => (angle >= Math.PI / 2 ? STEEPEST : Math.max(Math.min(Math.tan(angle), STEEPEST), -STEEPEST));

export async function shadow(ctx: OpContext, height: Field<'field'>, opts: ShadowOptions): Promise<Field<'field'>> {
  requireChannels('ops.shadow', 'the height', height, 1);
  requireSquare('ops.shadow', 'the height', height);
  const { angle, elevation } = opts ?? ({} as ShadowOptions);
  const softness = opts?.disc ?? 0;
  for (const [name, value, min, max] of [['angle', angle, -Infinity, Infinity], ['elevation', elevation, 0, 90], ['disc', softness, 0, 90]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw byContext(new RangeError(`ops.shadow: ${name} is ${String(value)}; it is ${name === 'angle' ? 'a direction in degrees' : `${min} to ${max} degrees`}`));
    }
  }
  const direction = radians(angle);
  const high = radians(elevation);
  const disc = radians(softness);
  const lo = high - disc, hi = high + disc;
  // The part of the disc below the horizontal is never seen: the rays start at the horizontal at the lowest.
  const from = Math.max(lo, 0);
  const strips = hi > from ? STRIPS : 1;
  const edge = (strip: number): number => from + ((hi - from) * strip) / strips;

  // One step towards the sun is a whole texel along the axis the direction mostly runs along. Along an axis the
  // other component is 0: the cosine of 270 degrees is -1.8e-16, and a step that far towards -X would leave the
  // terrain from its first column, which would then see the sun through any mountain.
  const exact = (component: number): number => (Math.abs(component) < 1e-12 ? 0 : component);
  const toSun = [exact(Math.cos(direction)), exact(Math.sin(direction))] as const;
  const major = Math.max(Math.abs(toSun[0]), Math.abs(toSun[1]));
  const step = [toSun[0] / major, toSun[1] / major] as const;
  const run = ctx.terrainSize / Math.max(height.width - 1, 1) / major;

  // All state is allocated before the loop. The result's own field collects the shares of the strips.
  let ray = ctx.alloc('vec2', { like: height }), rayNext = ctx.alloc('vec2', { like: height });
  let top = ctx.alloc('field', { like: height }), topNext = ctx.alloc('field', { like: height });
  const seen = ctx.alloc('field', { like: height, clear: 0 });

  // Pass k of a strip looks 2^k steps ahead: together its passes cover every step across the terrain.
  const passes = Math.max(Math.ceil(Math.log2(height.width)), 1);
  await ctx.loop(strips * passes, (i) => {
    const strip = Math.floor(i / passes), k = i % passes;
    const below = edge(strip), above = edge(strip + 1);
    if (k === 0) ctx.run(shadowStartKernel, { in: { height }, out: { ray, top } });
    ctx.run(shadowMarchKernel, {
      in: { ray, top },
      out: { rayNext, topNext },
      params: { step, jump: 2 ** k, run, dropLo: run * tangent(below), dropHi: run * tangent(above) },
    });
    [ray, rayNext] = [rayNext, ray];
    [top, topNext] = [topNext, top];
    if (k === passes - 1) {
      ctx.run(shadowGatherKernel, {
        in: { height, ray, top },
        rw: { seen },
        // A disc of no height is one strip of no height, which is all of it.
        params: { tanLo: tangent(below), lo: below, hi: above, weight: hi > lo ? (above - below) / (hi - lo) : 1 },
      });
    }
  }, opts.progress ? { progress: opts.progress } : {});
  ctx.release(ray);
  ctx.release(rayNext);
  ctx.release(top);
  ctx.release(topNext);
  return seen;
}
