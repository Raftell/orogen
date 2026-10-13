// src/core/nodes/select/distance.ts
import { defineKernel, defineNode } from '../../api.ts';
import { edgeDistance, edtKernels } from './_edt.ts';
import { invert } from './_params.ts';
import { selectShape } from './_wgsl.ts';

const band = defineKernel({
  name: 'select/distance',
  // toEdge: the distance to the mask's edge in texels, below 0 where there is none.
  inputs: { src: { kind: 'field', saturate: true }, toEdge: 'field' },
  outputs: { out: 'field', raw: 'field' },
  // perTexel: the length of one texel. reach: the distance the band fades over, a length.
  params: { perTexel: 'f32', reach: 'f32', mode: 'u32', invert: 'u32' },
  includes: [selectShape],
  cost: 2,
  code: /* wgsl */ `
const DIAGONAL = 1.41421356;   // of the terrain, as a length: no distance on it is longer

fn compute(px: vec2i, uv: vec2f) -> Out {
  let texels = toEdge_at(px);
  // Without an edge anywhere, the distance to it is the longest there is.
  var d = DIAGONAL;
  if (texels >= 0.0) { d = min(texels * P.perTexel, DIAGONAL); }
  let inside = src_at(px) >= 0.5;

  // The distance on the side the mode measures, and the mask: a ramp over the reach that is 1 on the selection.
  var raw = d;
  var v = 0.0;
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 0u: {                          // outside: the selection grown
      raw = select(d, 0.0, inside);
      v = select(0.0, 1.0, inside);
      if (!inside && d < P.reach) { v = 1.0 - d / P.reach; }
    }
    case 1u: {                          // inside: the selection shrunk
      raw = select(0.0, d, inside);
      v = select(0.0, 1.0, inside);
      if (inside && d < P.reach) { v = d / P.reach; }
    }
    default: {                          // both: its edge softened to either side
      v = select(0.0, 1.0, inside);
      if (d < P.reach) { v = 0.5 + select(-0.5, 0.5, inside) * d / P.reach; }
    }
  }
  return Out(selectShape_flip(v, P.invert), raw);
}`,
});

export default defineNode({
  type: 'select/distance',
  title: 'Distance',
  category: 'select',
  description: 'Fades a mask over a distance from its edge, outwards, inwards or both; raw is that distance as a fraction of the terrain width.',
  keywords: ['distance field', 'sdf', 'falloff', 'grow', 'shrink', 'feather', 'proximity', 'edt'],
  inputs: [{ name: 'in', type: 'field', role: 'mask' }],
  outputs: [
    { name: 'out', type: 'field', role: 'mask' },
    { name: 'raw', type: 'field', role: 'data', label: 'Raw distance' },
  ],
  params: [
    {
      kind: 'float', name: 'distance', label: 'Distance', unit: 'length', default: 0.02, min: 0.001, max: 0.5, scale: 'log', soft: true,
      help: 'How far from the edge of the mask the result fades: larger values give a broader, gentler ramp.',
    },
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'outside',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'outside', label: 'Outside' },
        { value: 'inside', label: 'Inside' },
        { value: 'both', label: 'Both' },
      ],
      help: 'Outside keeps the selection and fades outwards from its edge, inside fades inwards from it, both softens the edge to either side.',
    },
    invert,
  ],
  kernels: [band, ...edtKernels],
  async evaluate(ctx) {
    const src = ctx.input('in');
    // First: a node that does not fit the budget fails before the flood does any work.
    const out = ctx.alloc('field');
    const raw = ctx.wants('raw') ? ctx.alloc('field') : null;
    const toEdge = await edgeDistance(ctx, src);
    ctx.run(band, {
      in: { src, toEdge },
      out: { out, raw },
      params: {
        perTexel: 1 / Math.max(ctx.res - 1, 1),
        reach: Math.max(ctx.params.distance, 0),   // soft: any finite number can arrive; 0 leaves the mask's own hard edge
        mode: ctx.enumIndex('mode'),
        invert: ctx.params.invert,
      },
    });
    ctx.release(toEdge);
    ctx.output('out', out);
    if (raw) ctx.output('raw', raw);
  },
});
