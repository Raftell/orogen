// src/core/nodes/select/roughness.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { invert } from './_params.ts';
import { selectShape } from './_wgsl.ts';

/**
 * The roughness that is fully selected at a strength of 0.5: the relief within a radius, as the root mean
 * square of the height about its smoothed surface in metres, over the radius in metres. To calibrate:
 * ref/fbm at the test scale, which is rough everywhere, has between 0.26 and 0.47 of it at the default
 * radius, with a median of 0.35, and comes out half selected.
 */
const FULL_ROUGHNESS = 0.55;
/**
 * The share of the full roughness up to which ground is not selected at all; the mask is a smooth step from
 * there to all of it. A step from nearer the full roughness is a narrower one: from 0.7 the whole of ref/fbm
 * went from unselected to selected between the strengths 0.42 and 0.58, and of a terrain with smooth valleys
 * and rough heights only the roughest tops were selected at the default. From 0 smooth ground keeps a haze.
 */
const SMOOTH_SHARE = 0.25;

/**
 * How many radii the mean of the squares is taken over. Over one radius it is the size of the one bump at
 * hand, and a terrain that is rough throughout comes out mottled; over three the mask is a blur that no
 * longer follows the ground it selects.
 */
const PATCH = 2;
/** How many radii from the border the squares are not counted: there the smoothed surface has samples on one side only. */
const MARGIN = 3;

// The square of what the terrain stands above or below its smoothed surface.
const deviation = defineKernel({
  name: 'select/roughness.deviation',
  inputs: { height: 'field', around: 'field' },
  outputs: { out: 'field' },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let d = height_at(px) - around_at(px);
  return d * d;
}`,
});

const mask = defineKernel({
  name: 'select/roughness',
  inputs: { variance: 'field' },
  outputs: { out: 'field' },
  // gain: what turns a root mean square in height units into a share of the roughness that is fully selected.
  params: { gain: 'f32', invert: 'u32' },
  includes: [selectShape],
  cost: 1,
  code: /* wgsl */ `
const SMOOTH_SHARE = ${SMOOTH_SHARE};

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let share = sqrt(max(variance_at(px), 0.0)) * P.gain;
  return selectShape_flip(selectShape_ease((share - SMOOTH_SHARE) / (1.0 - SMOOTH_SHARE)), P.invert);
}`,
});

export default defineNode({
  type: 'select/roughness',
  title: 'Roughness',
  category: 'select',
  description: 'Selects rough ground against smooth: where the height varies within a radius about its smoothed surface.',
  keywords: ['rugged', 'ruggedness', 'variation', 'deviation', 'texture', 'relief', 'bumpy', 'smooth'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.radius({ default: 0.01, help: 'The scale of the roughness: relief narrower than this counts and broader shapes do not.' }),
    param.strength({ default: 0.5, help: 'Larger values count gentler ground as rough, until every unevenness is fully selected.' }),
    invert,
  ],
  kernels: [deviation, mask],
  evaluate(ctx) {
    const { strength } = ctx.params;
    const radius = Math.max(ctx.params.radius, 0);   // soft: any finite number can arrive
    const src = ctx.input('in');

    // What stands above or below the terrain smoothed over the radius, squared, and the mean of that over a
    // patch of a few radii. Below a quarter of a texel nothing is smoothed and nothing stands out: the mask is empty.
    const around = ops.smooth(ctx, src, radius);
    const squares = ctx.alloc('field');
    ctx.run(deviation, { in: { height: src, around }, out: { out: squares } });
    ctx.release(around);
    // Near the border the smoothed surface has fewer samples on one side and lies closer to the terrain than
    // it does inside: the squares there are too small, and are not counted.
    const variance = ops.smooth(ctx, squares, PATCH * radius, { mean: true, skip: MARGIN * radius });
    ctx.release(squares);

    // Relief in metres over the radius in metres. The strength acts as its cube: 0 selects nothing.
    const perRadius = ctx.heightRange / Math.max(ctx.lengthToMetres(radius), 1e-6 * ctx.terrainSize);
    const out = ctx.alloc('field');
    ctx.run(mask, {
      in: { variance },
      out: { out },
      params: { gain: (perRadius * (2 * strength) ** 3) / FULL_ROUGHNESS, invert: ctx.params.invert },
    });
    ctx.release(variance);
    ctx.output('out', out);
  },
});
