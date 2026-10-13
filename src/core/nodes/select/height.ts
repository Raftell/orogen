// src/core/nodes/select/height.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { invert } from './_params.ts';
import { selectShape } from './_wgsl.ts';

const band = defineKernel({
  name: 'select/height',
  inputs: { height: 'field' },
  outputs: { out: 'field' },
  params: { lo: 'f32', hi: 'f32', feather: 'f32', invert: 'u32' },
  includes: [selectShape],
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return selectShape_flip(selectShape_band(height_at(px), P.lo, P.hi, P.feather), P.invert);
}`,
});

export default defineNode({
  type: 'select/height',
  title: 'Height',
  category: 'select',
  description: 'Selects the terrain between two heights, fading out over a feather below and above the band.',
  keywords: ['altitude', 'elevation', 'band', 'range', 'snow line', 'level'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.height({ name: 'heightMin', label: 'Lower height', default: 0.5, help: 'Terrain from this height upwards is fully selected.' }),
    param.height({ name: 'heightMax', label: 'Upper height', default: 0.75, help: 'Terrain up to this height is fully selected.' }),
    {
      kind: 'float', name: 'feather', label: 'Feather', unit: 'height', default: 0.05, min: 0, max: 0.5, soft: true,
      help: 'Larger values fade the selection out over a taller margin below and above the band.',
    },
    invert,
  ],
  kernels: [band],
  evaluate(ctx) {
    const { heightMin, heightMax, feather } = ctx.params;
    const out = ctx.alloc('field');
    ctx.run(band, {
      in: { height: ctx.input('in') },
      out: { out },
      // An upper height below the lower one leaves a band of no width at the lower, which the feather still surrounds.
      params: { lo: heightMin, hi: Math.max(heightMax, heightMin), feather: Math.max(feather, 0), invert: ctx.params.invert },
    });
    ctx.output('out', out);
  },
});
