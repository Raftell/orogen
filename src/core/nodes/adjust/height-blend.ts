// src/core/nodes/adjust/height-blend.ts
import { MASK_INPUT, defineKernel, defineNode } from '../../api.ts';
import { adjust } from './_wgsl.ts';

/** Half the band of heights over which the two terrains blend at no contrast; at full contrast there is none. */
const BAND_MAX = 0.5;

const heightBlend = defineKernel({
  name: 'adjust/height-blend',
  inputs: { a: 'field', b: 'field', mask: MASK_INPUT },   // the node's own mask: reads 1 when unconnected, saturated on read
  outputs: { out: 'field', weight: 'field' },
  params: { band: 'f32', offset: 'f32' },
  includes: [adjust],
  cost: 3,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let va = a_at(px);
  let vb = b_at(px) + P.offset;
  // How far the second terrain stands above the first. Within the band the weight of the second rises along a
  // smoothstep, whose slope is 0 at both ends: the blended surface leaves each terrain without a crease.
  let d = vb - va;
  var w = select(select(0.5, 1.0, d > 0.0), 0.0, d < 0.0);
  if (P.band > 0.0) { w = smoothstep(-P.band, P.band, d); }
  let t = saturate(w * mask_at(px));
  return Out(adjust_field(adjust_blend(va, vb, t)), t);
}`,
});

export default defineNode({
  type: 'adjust/height-blend',
  title: 'Height Blend',
  category: 'adjust',
  description: 'Merges two terrains so that the higher one wins, with a soft transition where they cross, and outputs where the second one shows.',
  keywords: ['height lerp', 'material blend', 'merge', 'union', 'layer', 'max'],
  inputs: [
    { name: 'a', type: 'field' },
    { name: 'b', type: 'field' },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'weight', type: 'field', role: 'mask' },
  ],
  params: [
    {
      kind: 'float', name: 'contrast', label: 'Contrast', unit: 'ratio', default: 0.8, min: 0, max: 1,
      help: 'Larger values narrow the band of heights in which the two terrains blend. At the top of the slider the higher terrain wins outright.',
    },
    {
      kind: 'float', name: 'offset', label: 'Offset', unit: 'height', default: 0, min: -1, max: 1, soft: true,
      help: 'Raises the second terrain before the two are compared. Larger values let more of it show; negative values sink it below the first.',
    },
  ],
  kernels: [heightBlend],
  evaluate(ctx) {
    const { contrast, offset } = ctx.params;
    const out = ctx.alloc('field');
    const weight = ctx.wants('weight') ? ctx.alloc('field') : null;
    ctx.run(heightBlend, {
      in: { a: ctx.input('a'), b: ctx.input('b'), mask: ctx.input('mask') },
      out: { out, weight },
      params: { band: BAND_MAX * (1 - contrast), offset },
    });
    ctx.output('out', out);
    if (weight) ctx.output('weight', weight);
  },
});
