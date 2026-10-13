// src/core/nodes/simulate/_water-jump.ts
// The nearest site of every texel by jump flooding (RT06), for simulate/rivers and simulate/sea
// (simulation.md 8.5). A site plane holds, per texel, the coordinates of a site as floats, or (-1, -1) for none;
// coordinates are exact up to 2^24.
import { defineKernel, type Field, type OpContext } from '../../api.ts';
import { RIVER_WIDTH_EXPONENT } from './_water-constants.ts';

/** What a texel of a site plane holds that has no site. */
export const NO_SITE = -1;

/** `simulate/water-jump.step`: of the sites the nine texels at `stride` hold, the one nearest to the texel. */
export const jumpStep = defineKernel({
  name: 'simulate/water-jump.step',
  inputs: { site: 'vec2' },
  outputs: { next: 'vec2' },
  params: { stride: 'i32' },
  cost: 9,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec2f {
  let here = vec2f(px);
  var best = vec2f(-1.0);
  var nearest = 1.0e30;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = px + vec2i(i, j) * P.stride;
      if (!inGrid(q)) { continue; }
      let s = site_at(q);
      if (s.x < 0.0) { continue; }
      let d = dot(s - here, s - here);
      // Of two sites at one distance the one with the smaller y, then the smaller x: the choice depends on
      // nothing but the sites.
      if (d < nearest || (d == nearest && (s.y < best.y || (s.y == best.y && s.x < best.x)))) {
        nearest = d;
        best = s;
      }
    }
  }
  return best;
}`,
});

/**
 * `simulate/water-jump.rivers`: the same flood for sites that are rivers of different widths. A texel takes
 * the river whose edge is nearest, or deepest inside whose channel it lies: the site with the least distance
 * less half the river's width. The nearest site alone would hand the texels of a wide river to every small
 * tributary that joins it. `share` is, at the texel a site lies in, the share of the terrain a river of its
 * width drains.
 */
export const jumpRivers = defineKernel({
  name: 'simulate/water-jump.rivers',
  inputs: { site: 'vec2', share: 'field' },
  outputs: { next: 'vec2' },
  // half: half the width, in texels, of a river that drains the whole terrain.
  params: { stride: 'i32', half: 'f32' },
  cost: 18,
  code: /* wgsl */ `
const WIDTH_EXPONENT = ${RIVER_WIDTH_EXPONENT};

fn compute(px: vec2i, uv: vec2f) -> vec2f {
  let here = vec2f(px);
  var best = vec2f(-1.0);
  var nearest = 1.0e30;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = px + vec2i(i, j) * P.stride;
      if (!inGrid(q)) { continue; }
      let s = site_at(q);
      if (s.x < 0.0) { continue; }
      // A site lies in the texel that holds what is known of it.
      let a = clamp(share_at(vec2i(round(s))), 0.0, 1.0);
      let d = length(s - here) - P.half * pow(a, WIDTH_EXPONENT);
      if (d < nearest || (d == nearest && (s.y < best.y || (s.y == best.y && s.x < best.x)))) {
        nearest = d;
        best = s;
      }
    }
  }
  return best;
}`,
});

/** The kernels of this module: a node that calls `nearestSites` lists them. */
export const jumpKernels = [jumpStep, jumpRivers] as const;

/** The strides of a flood that must be right up to `reach` texels: 1, then 2^(K-1), ..., 2, 1 with K = ceil(log2(reach)). */
export function jumpStrides(reach: number): number[] {
  const strides = [1];
  if (!(reach > 1)) return strides;
  const top = Math.min(Math.ceil(Math.log2(reach)), 14);   // 2^13 is half the widest field there is
  for (let k = top - 1; k >= 0; k--) strides.push(2 ** k);
  return strides;
}

/**
 * Floods a site plane: the first plane it returns holds for every texel the nearest site within `reach` texels
 * (beyond that, a site or none). `sites` and `spare`, a second plane of its size with any contents, are both
 * used: the result is one of them, and the other comes back second, for the caller to use or to release.
 * `progress` is the flood's share of the node's progress.
 * With `rivers`, the sites are rivers and a texel takes the one whose edge is nearest (`simulate/water-jump.rivers`).
 */
export async function nearestSites(
  ctx: OpContext, sites: Field<'vec2'>, spare: Field<'vec2'>, reach: number, progress: readonly [number, number], label: string,
  rivers?: { readonly share: Field<'field'>; readonly half: number },
): Promise<[nearest: Field<'vec2'>, spare: Field<'vec2'>]> {
  let site = sites, next = spare;
  const strides = jumpStrides(reach);
  await ctx.loop(strides.length, (i) => {
    if (rivers) ctx.run(jumpRivers, { in: { site, share: rivers.share }, out: { next }, params: { stride: strides[i]!, half: rivers.half } });
    else ctx.run(jumpStep, { in: { site }, out: { next }, params: { stride: strides[i]! } });
    [site, next] = [next, site];
  }, { progress, label });
  return [site, next];
}
