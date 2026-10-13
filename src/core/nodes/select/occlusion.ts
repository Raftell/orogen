// src/core/nodes/select/occlusion.ts
import { defineKernel, defineNode, ops, param, type Field } from '../../api.ts';
import { invert } from './_params.ts';
import { halved, scaleKernels } from './_scale.ts';
import { selectShape } from './_wgsl.ts';

/** The most distances a texel looks out to: 1, 2, 4, ... texels, which reaches across 8129. */
const MAX_REACHES = 13;
/** How many doublings of the distance count: the ground from a quarter of the radius out to four times the radius. */
const OCTAVES = 4;
/** How many radii out the farthest ground lies that counts. */
const OUTER = 4;
/**
 * The occlusion that is fully selected at a strength of 0.5: the sine of the angle by which the ground on both
 * sides stands above a point, as a mean over four axes and over the distances within the radius. To calibrate:
 * on ref/fbm at the test scale the floors of the valleys reach it and open slopes stay near 0.
 */
const FULL_OCCLUSION = 0.3;

// How sheltered a point is, at one distance. Along each of four axes it looks that far to both sides; the two
// heights there, against its own, are a hollow when their mean lies above it, and the angle of that hollow is
// what the ground on both sides hides of the sky above the lie of the land between them. A plane is no hollow
// at any tilt, so a slope is not sheltered by being steep; the foot of a cliff, a valley floor and a pit are.
//
// The march is bounded by doubling the distance, on a level of the terrain reduced as far: reach k looks 2^k
// texels out, which on the terrain reduced 2^(k - 1) times is two texels, and writes what it finds at that
// level. One texel there is the ground between this reach and the next, so the hollows found at a distance are
// hollows of that size, and ground rough at the scale of a texel does not come out as a speckle of pits. The
// distances that count are those from a quarter of the radius out to four times the radius, most at the
// radius itself: at most six reaches of ten loads, each on its own small grid, where a march texel by texel
// across a radius of a quarter of 8129 texels would take thousands of loads on the full one.
const reach = defineKernel({
  name: 'select/occlusion.reach',
  // level: the terrain on the grid this reach writes. carry: the sum of the farther reaches, on the same grid.
  inputs: { level: 'field', carry: { kind: 'field', default: 0 } },
  outputs: { out: 'field' },
  // stride: the distance of this reach in texels of that grid, 1 or 2. outer: the farthest distance that
  // counts, in the same texels.
  params: { stride: 'i32', outer: 'f32' },
  cost: 10,
  code: /* wgsl */ `
const OCTAVES = ${OCTAVES}.0;
const PI = 3.14159265358979;

// How many texels there are from p to the border along one component of an axis, either way.
fn room(p: i32, last: i32, along: i32) -> i32 {
  if (along == 0) { return 1 << 20; }
  return min(p, last - p);
}

// The sine of the angle by which the ground at both ends of one axis stands above the texel, weighted by how
// near the radius this reach lies; 0 where the ground does not.
fn hollow(px: vec2i, z: f32, axis: vec2i) -> f32 {
  // The weight over the doublings below the farthest distance, most in their middle, which is the radius: the
  // weights of all the reaches add up to 2.
  let below = -log2(length(vec2f(axis)) * f32(P.stride) / P.outer);
  if (below <= 0.0 || below >= OCTAVES) { return 0.0; }
  // Near the border the reach is as long as the terrain is on both sides: nothing is known of the ground
  // beyond it, and a hollow fades out towards the border without a step.
  let last = vec2i(level_res()) - vec2i(1);
  let steps = min(P.stride, min(room(px.x, last.x, axis.x), room(px.y, last.y, axis.y)));
  if (steps < 1) { return 0.0; }
  let span = length(vec2f(axis)) * f32(steps) * frame.cellSize;
  // Heights in metres over the distance in metres: a tangent.
  let rise = (level_at(px + axis * steps) + level_at(px - axis * steps) - 2.0 * z) * frame.heightRange / (2.0 * span);
  if (rise <= 0.0) { return 0.0; }
  let weight = sin(PI * below / OCTAVES) * sin(PI * below / OCTAVES);
  return weight * rise / sqrt(1.0 + rise * rise);
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let z = level_at(px);
  let sheltered = 0.25 * (hollow(px, z, vec2i(1, 0)) + hollow(px, z, vec2i(1, 1)) + hollow(px, z, vec2i(0, 1)) + hollow(px, z, vec2i(-1, 1)));
  return carry_at(px) + 0.5 * sheltered;
}`,
});

const mask = defineKernel({
  name: 'select/occlusion',
  inputs: { sum: 'field' },
  outputs: { out: 'field' },
  params: { gain: 'f32', invert: 'u32' },
  includes: [selectShape],
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return selectShape_flip(sum_at(px) * P.gain, P.invert);
}`,
});

export default defineNode({
  type: 'select/occlusion',
  title: 'Occlusion',
  category: 'select',
  description: 'Selects sheltered ground: hollows, valley floors and the feet of cliffs, where higher ground within a radius stands on both sides.',
  keywords: ['ambient occlusion', 'ao', 'cavity', 'sheltered', 'hollow', 'valley', 'crevice', 'shade'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.radius({ default: 0.04, help: 'The distance at which higher ground shelters a point most: larger values find whole valleys, smaller ones only creases.' }),
    param.strength({ default: 0.5, help: 'Larger values count shallower hollows as sheltered, until every hollow is fully selected.' }),
    invert,
  ],
  kernels: [reach, mask, ...scaleKernels],
  evaluate(ctx) {
    const { strength } = ctx.params;
    const src = ctx.input('in');
    // The farthest ground that counts, in texels. Soft: any finite radius can arrive.
    const outer = OUTER * Math.min(ctx.lengthToPx(Math.max(ctx.params.radius, 0)), 2 * ctx.res);

    // Reach k looks 2^k texels out along the axes and sqrt(2) times as far along the diagonals. Those count
    // whose distance lies inside the farthest and no more than OCTAVES doublings below it: six at most.
    const reaches: number[] = [];
    for (let k = 0; k < MAX_REACHES; k++) {
      if (2 ** k < outer && Math.SQRT2 * 2 ** k > outer / 2 ** OCTAVES) reaches.push(k);
    }
    const out = ctx.alloc('field');
    if (reaches.length === 0) {
      // A radius of a quarter of a texel or less reaches no ground: nothing is sheltered.
      ctx.clear(out, ctx.params.invert ? 1 : 0);
      ctx.output('out', out);
      return;
    }

    // Reaches 0 and 1 read the terrain itself, one and two texels out; reach k from 2 on reads it reduced
    // 2^(k - 1) times, two texels out. The levels are built down to the farthest reach.
    const levelOf = (k: number): number => Math.max(k - 1, 0);
    const levels: Field<'field'>[] = [src];
    for (let level = 1; level <= levelOf(reaches.at(-1)!); level++) {
      levels.push(halved(ctx, levels[level - 1]!, Math.ceil((ctx.res - 1) / 2 ** level) + 1));
    }

    // From the farthest reach to the nearest: each adds what it finds to the sum of the farther ones, which
    // is brought onto its grid first. The cubic B-spline leaves no trace of the coarser grid in the sum.
    let sum: Field<'field'> | null = null;
    for (const k of reaches.toReversed()) {
      const level = levels[levelOf(k)]!;
      if (sum && sum.width !== level.width) {
        const finer = ops.resample(ctx, sum, { size: level.width, filter: 'bspline' });
        ctx.release(sum);
        sum = finer;
      }
      const next = ctx.alloc('field', { like: level });
      ctx.run(reach, {
        in: { level, carry: sum }, out: { out: next },
        params: { stride: k === 0 ? 1 : 2, outer: outer / 2 ** levelOf(k) },
      });
      if (sum) ctx.release(sum);
      sum = next;
    }
    for (const level of levels.slice(1)) ctx.release(level);
    if (sum!.width !== ctx.res) {
      const full = ops.resample(ctx, sum!, { size: ctx.res, filter: 'bspline' });
      ctx.release(sum!);
      sum = full;
    }

    // The strength acts as its cube: half of it asks for eight times the occlusion, and 0 selects nothing.
    ctx.run(mask, { in: { sum: sum! }, out: { out }, params: { gain: (2 * strength) ** 3 / FULL_OCCLUSION, invert: ctx.params.invert } });
    ctx.release(sum!);
    ctx.output('out', out);
  },
});
