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
 * sides stands above a point, as a mean over four axes and over the distances around the radius. To calibrate:
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

// How many texels there are from p to the border along one component of an axis, the way that component points.
fn room(p: i32, last: i32, along: i32) -> i32 {
  if (along == 0) { return 1 << 20; }
  return select(p, last - p, along > 0);
}

// .x: the sine of the angle by which the ground at both ends of one axis stands above the texel at p, weighted
// by how near the radius this reach lies; 0 where the ground does not. .y: 1 where the axis has ground at both
// ends and so says something, else 0.
fn hollow(p: vec2i, z: f32, axis: vec2i) -> vec2f {
  // Near the border an end is as far out as the terrain goes. With the border at the texel itself the axis has
  // one end only, and one end says nothing: a slope would count as a hollow by the way it happens to face.
  let last = vec2i(level_res()) - vec2i(1);
  let ahead = min(P.stride, min(room(p.x, last.x, axis.x), room(p.y, last.y, axis.y)));
  let behind = min(P.stride, min(room(p.x, last.x, -axis.x), room(p.y, last.y, -axis.y)));
  if (ahead < 1 || behind < 1) { return vec2f(0.0, 0.0); }
  // The weight over the doublings below the farthest distance, most in their middle, which is the radius: the
  // weights of all the reaches add up to 2.
  let below = -log2(length(vec2f(axis)) * f32(P.stride) / P.outer);
  if (below <= 0.0 || below >= OCTAVES) { return vec2f(0.0, 1.0); }
  // Heights in metres over the distance in metres: the tangent to each end, and their mean. A plane has
  // tangents that cancel at any tilt, with its ends at different distances too.
  let up = (level_at(p + axis * ahead) - z) / f32(ahead) + (level_at(p - axis * behind) - z) / f32(behind);
  let rise = 0.5 * up * frame.heightRange / (length(vec2f(axis)) * frame.cellSize);
  if (rise <= 0.0) { return vec2f(0.0, 1.0); }
  let weight = sin(PI * below / OCTAVES) * sin(PI * below / OCTAVES);
  return vec2f(weight * rise / sqrt(1.0 + rise * rise), 1.0);
}

// The hollows of the four axes at p, added up, and how many of the axes said something.
fn hollows(p: vec2i) -> vec2f {
  let z = level_at(p);
  return hollow(p, z, vec2i(1, 0)) + hollow(p, z, vec2i(1, 1)) + hollow(p, z, vec2i(0, 1)) + hollow(p, z, vec2i(-1, 1));
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // What is found is the mean over the axes that said something: on the border, the axis that runs along it.
  // A valley that runs out of the terrain is sheltered up to the border as it is inside, and the mask has no
  // frame along it. Measured on ref/fbm against the same ground with more of it beyond the border, the
  // texels of the border are sheltered a twentieth more in the mean; faded out with the room there is, half as much.
  var found = hollows(px);
  if (found.y < 0.5) {
    // A corner has the border at one end of every axis: it takes what the texel diagonally inside it finds.
    let last = vec2i(level_res()) - vec2i(1);
    let nearest = min(vec2i(1), last / 2);
    found = hollows(clamp(px, nearest, max(last - vec2i(1), nearest)));
  }
  // On a grid too small for an axis to have two ends nothing is found.
  var sheltered = 0.0;
  if (found.y > 0.5) { sheltered = found.x / found.y; }
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
  description: 'Selects sheltered ground: hollows, valley floors and the feet of cliffs, where the ground about a radius away stands higher.',
  keywords: ['ambient occlusion', 'ao', 'cavity', 'sheltered', 'hollow', 'valley', 'crevice', 'shade'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.radius({ default: 0.04, help: 'The distance at which higher ground shelters a point most: larger values find whole valleys, smaller ones only creases.' }),
    param.strength({ default: 0.5, help: 'Larger values count shallower hollows as sheltered, until every hollow is fully selected.' }),
    invert,
  ],
  kernels: [reach, mask, ...scaleKernels],
  async evaluate(ctx) {
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
    // 2^(k - 1) times, two texels out. The levels are built down to the farthest reach: each a quarter of the
    // one before it, a third of the terrain together.
    const levelOf = (k: number): number => Math.max(k - 1, 0);
    const levels: Field<'field'>[] = [src];
    await ctx.loop(levelOf(reaches.at(-1)!), (i) => {
      levels.push(halved(ctx, levels[i]!, Math.ceil((ctx.res - 1) / 2 ** (i + 1)) + 1));
    }, { progress: [0, 0.5] });

    // From the farthest reach to the nearest: each adds what it finds to the sum of the farther ones, which
    // is brought onto its grid first. The cubic B-spline leaves no trace of the coarser grid in the sum.
    let sum: Field<'field'> | null = null;
    await ctx.loop(reaches.length, (i) => {
      const k = reaches[reaches.length - 1 - i]!;
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
    }, { progress: [0.5, 1] });
    for (const level of levels.slice(1)) ctx.release(level);
    let total: Field<'field'> = sum!;
    if (total.width !== ctx.res) {
      const full = ops.resample(ctx, total, { size: ctx.res, filter: 'bspline' });
      ctx.release(total);
      total = full;
    }

    // The strength acts as its cube: half of it asks for eight times the occlusion, and 0 selects nothing.
    ctx.run(mask, { in: { sum: total }, out: { out }, params: { gain: (2 * strength) ** 3 / FULL_OCCLUSION, invert: ctx.params.invert } });
    ctx.release(total);
    ctx.output('out', out);
  },
});
