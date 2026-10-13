// src/core/nodes/select/peaks.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { scaleKernels, smoothed } from './_scale.ts';
import { selectShape } from './_wgsl.ts';

/**
 * A height above the surroundings that counts as none. A plane smoothed is that plane up to the rounding of
 * float32 sums, a few parts in ten million of a height near 1, and without this a slope would be selected in
 * speckles wherever the rounding came out above it.
 */
const LEVEL = 2e-6;

const rise = defineKernel({
  name: 'select/peaks',
  inputs: { height: 'field', around: 'field' },
  outputs: { out: 'field' },
  // side: 1 selects ground above its surroundings, -1 ground below them.
  params: { side: 'f32', level: 'f32', feather: 'f32' },
  includes: [selectShape],
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let above = (height_at(px) - around_at(px)) * P.side - P.level;
  if (above <= 0.0) { return 0.0; }
  // A feather of 0 is a hard edge; nothing is divided by it.
  if (above >= P.feather) { return 1.0; }
  return selectShape_ease(above / P.feather);
}`,
});

export default defineNode({
  type: 'select/peaks',
  title: 'Peaks',
  category: 'select',
  description: 'Selects ground that stands above its surroundings within a radius, such as summits and ridge tops, or below them when inverted.',
  keywords: ['summit', 'ridge', 'prominence', 'relative height', 'valley', 'hollow', 'tpi'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.radius({
      default: 0.04,
      help: 'The size of the surroundings a point is compared with: larger values select whole massifs, smaller ones every knoll.',
    }),
    {
      kind: 'float', name: 'feather', label: 'Feather', unit: 'height', default: 0.05, min: 0, max: 0.5, soft: true,
      help: 'How far above its surroundings ground stands before it is fully selected: larger values keep only the most prominent tops.',
    },
    {
      kind: 'bool', name: 'invert', label: 'Invert', default: false,
      help: 'Selects ground that lies below its surroundings instead: valley floors and hollows.',
    },
  ],
  kernels: [rise, ...scaleKernels],
  evaluate(ctx) {
    const { radius, feather } = ctx.params;
    const src = ctx.input('in');
    // The surroundings of a point are the terrain smoothed over the radius: their mean, weighted by distance.
    const around = smoothed(ctx, src, radius);
    const out = ctx.alloc('field');
    ctx.run(rise, {
      in: { height: src, around: around.field },
      out: { out },
      params: { side: ctx.params.invert ? -1 : 1, level: LEVEL, feather: Math.max(feather, 0) },
    });
    if (around.owned) ctx.release(around.field);
    ctx.output('out', out);
  },
});
