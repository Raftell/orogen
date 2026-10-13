// src/core/nodes/select/roughness.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { invert } from './_params.ts';
import { scaleKernels, smoothed } from './_scale.ts';
import { selectShape } from './_wgsl.ts';

/**
 * The roughness that is fully selected at a strength of 0.5: the relief within a radius, as the root mean
 * square of the height about its smoothed surface in metres, over the radius in metres. Half of it and less
 * is not selected, and the mask rises as a smooth step between the two. To calibrate: ref/fbm at the test
 * scale, which is rough everywhere, has between 0.2 and 0.55 at any radius, with a median of 0.33.
 */
const FULL_ROUGHNESS = 0.5;

/**
 * How many radii the mean of the squares is taken over. Over one radius it is the size of the one bump at
 * hand, and a terrain that is rough throughout comes out mottled; over three it is the roughness of a patch.
 */
const PATCH = 3;

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
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let share = sqrt(max(variance_at(px), 0.0)) * P.gain;
  // From half of the full roughness to all of it.
  return selectShape_flip(selectShape_ease(2.0 * share - 1.0), P.invert);
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
  kernels: [deviation, mask, ...scaleKernels],
  evaluate(ctx) {
    const { strength } = ctx.params;
    const radius = Math.max(ctx.params.radius, 0);   // soft: any finite number can arrive
    const src = ctx.input('in');

    // What stands above or below the terrain smoothed over the radius, squared, and the mean of that over a
    // patch of a few radii. Below a quarter of a texel nothing is smoothed and nothing stands out: the mask is empty.
    const around = smoothed(ctx, src, radius);
    const squares = ctx.alloc('field');
    ctx.run(deviation, { in: { height: src, around: around.field }, out: { out: squares } });
    if (around.owned) ctx.release(around.field);
    // Within three radii of the border the smoothed surface has fewer samples on one side and lies closer to
    // the terrain than it does inside: the squares there are too small, and are not counted.
    const variance = smoothed(ctx, squares, PATCH * radius, { level: true, skip: 3 * radius });
    if (variance.owned) ctx.release(squares);

    // Relief in metres over the radius in metres. The strength acts as its cube: 0 selects nothing.
    const perRadius = ctx.heightRange / Math.max(ctx.lengthToMetres(radius), 1e-6 * ctx.terrainSize);
    const out = ctx.alloc('field');
    ctx.run(mask, {
      in: { variance: variance.field },
      out: { out },
      params: { gain: (perRadius * (2 * strength) ** 3) / FULL_ROUGHNESS, invert: ctx.params.invert },
    });
    ctx.release(variance.field);
    ctx.output('out', out);
  },
});
