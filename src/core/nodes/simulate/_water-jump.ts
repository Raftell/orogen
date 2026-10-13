// src/core/nodes/simulate/_water-jump.ts
// The nearest site of every texel by jump flooding (RT06), for simulate/rivers and simulate/sea
// (simulation.md 8.5). A site plane holds, per texel, the coordinates of a site as floats, or (-1, -1) for none;
// coordinates are exact up to 2^24.
import { defineKernel, type Field, type OpContext } from '../../api.ts';
import { COURSE_WGSL, VALLEY_WGSL } from './_water-course.ts';

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
 * `simulate/water-jump.rivers`: the same flood for sites that are rivers. A texel takes the river whose valley
 * is deepest there, or deepest inside whose channel it lies; beyond the reach of every valley, the river whose
 * edge is nearest. The nearest site alone would hand the texels of a wide river to every small tributary that
 * joins it, and two valleys would meet in a step. `share`, `place` and `course` are what the course task says
 * of a site, in the texel it lies in (`COURSE_WGSL`).
 */
export const jumpRivers = defineKernel({
  name: 'simulate/water-jump.rivers',
  inputs: { site: 'vec2', share: 'field', place: 'field', course: 'field' },
  outputs: { next: 'vec2' },
  // width, depth: metres, of a river that drains the whole terrain. rise: metres, the most a river lies below
  // the routing surface. bank: the tangent of the bank's angle.
  params: { stride: 'i32', width: 'f32', depth: 'f32', rise: 'f32', bank: 'f32' },
  cost: 27,
  code: /* wgsl */ `${COURSE_WGSL}${VALLEY_WGSL}

fn compute(px: vec2i, uv: vec2f) -> vec2f {
  let here = vec2f(px);
  var best = vec2f(-1.0);
  var deepest = -1.0;
  var nearest = 1.0e30;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = px + vec2i(i, j) * P.stride;
      if (!inGrid(q)) { continue; }
      let s = site_at(q);
      if (s.x < 0.0) { continue; }
      // A site lies in the texel that holds what is known of it.
      let home = vec2i(round(s));
      let w = P.width * pow(clamp(share_at(home), 0.0, 1.0), VALLEY_WIDTH_EXPONENT);
      let edge = length(s - here) * frame.cellSize - 0.5 * w;
      // The texel a site lies in is that river's, however thin its channel.
      var depth = 2.0e9;
      if (any(home != px)) { depth = valleyClaim(edge, channelDepth(w, P.width, P.depth) + VALLEY_BANK_RISE * P.rise * courseAt(home).rise, P.bank); }
      // Of two sites that are alike in both, the one with the smaller y, then the smaller x: the choice depends on nothing but the sites.
      if (depth > deepest || (depth == deepest && (edge < nearest || (edge == nearest && (s.y < best.y || (s.y == best.y && s.x < best.x)))))) {
        deepest = depth;
        nearest = edge;
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

/** What the flood of rivers reads of every site, and the measures of the rivers (`simulate/water-jump.rivers`). */
export interface RiverPlanes {
  readonly planes: { readonly share: Field<'field'>; readonly place: Field<'field'>; readonly course: Field<'field'> };
  readonly params: { readonly width: number; readonly depth: number; readonly rise: number; readonly bank: number };
}

/**
 * Floods a site plane: the first plane it returns holds for every texel the nearest site within `reach` texels
 * (beyond that, a site or none). `sites` and `spare`, a second plane of its size with any contents, are both
 * used: the result is one of them, and the other comes back second, for the caller to use or to release.
 * `progress` is the flood's share of the node's progress.
 * With `rivers`, the sites are rivers and a texel takes the one whose valley is deepest there (`simulate/water-jump.rivers`).
 */
export async function nearestSites(
  ctx: OpContext, sites: Field<'vec2'>, spare: Field<'vec2'>, reach: number, progress: readonly [number, number], label: string,
  rivers?: RiverPlanes,
): Promise<[nearest: Field<'vec2'>, spare: Field<'vec2'>]> {
  let site = sites, next = spare;
  const strides = jumpStrides(reach);
  await ctx.loop(strides.length, (i) => {
    if (rivers) ctx.run(jumpRivers, { in: { site, ...rivers.planes }, out: { next }, params: { stride: strides[i]!, ...rivers.params } });
    else ctx.run(jumpStep, { in: { site }, out: { next }, params: { stride: strides[i]! } });
    [site, next] = [next, site];
  }, { progress, label });
  return [site, next];
}
