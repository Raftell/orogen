// src/core/nodes/select/edge.ts
import { defineKernel, defineNode } from '../../api.ts';
import { edgeDistance, edtKernels } from './_edt.ts';
import { invert } from './_params.ts';
import { selectShape } from './_wgsl.ts';

const band = defineKernel({
  name: 'select/edge',
  // toEdge: the distance to the mask's edge in texels, below 0 where there is none.
  inputs: { toEdge: 'field' },
  outputs: { out: 'field' },
  // half: half the width of the band. feather: what it fades out over beyond that. Both in texels.
  params: { half: 'f32', feather: 'f32', invert: 'u32' },
  includes: [selectShape],
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let d = toEdge_at(px);
  var v = 0.0;
  // A mask without an edge has no band.
  if (d >= 0.0) { v = selectShape_band(d, 0.0, P.half, P.feather); }
  return selectShape_flip(v, P.invert);
}`,
});

export default defineNode({
  type: 'select/edge',
  title: 'Edge',
  category: 'select',
  description: 'Selects a band of a given width along the edge of a mask, half of it on either side, fading out over a feather.',
  keywords: ['outline', 'border', 'boundary', 'contour', 'rim', 'stroke', 'shoreline'],
  inputs: [{ name: 'in', type: 'field', role: 'mask' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    {
      kind: 'float', name: 'width', label: 'Width', unit: 'length', default: 0.01, min: 0.0005, max: 0.25, scale: 'log', soft: true,
      help: 'How wide the band is that is fully selected, across the edge of the mask: larger values give a broader band.',
    },
    {
      kind: 'float', name: 'feather', label: 'Feather', unit: 'length', default: 0.005, min: 0, max: 0.25, soft: true,
      help: 'Larger values fade the band out over a wider margin on both of its sides.',
    },
    invert,
  ],
  kernels: [band, ...edtKernels],
  async evaluate(ctx) {
    const { width, feather } = ctx.params;
    const out = ctx.alloc('field');   // first: a node that does not fit the budget fails before the flood does any work
    const toEdge = await edgeDistance(ctx, ctx.input('in'));
    ctx.run(band, {
      in: { toEdge },
      out: { out },
      // Soft: any finite number can arrive. A width of 0 leaves the feather alone, a soft line along the edge.
      params: { half: ctx.lengthToPx(Math.max(width, 0)) / 2, feather: ctx.lengthToPx(Math.max(feather, 0)), invert: ctx.params.invert },
    });
    ctx.release(toEdge);
    ctx.output('out', out);
  },
});
