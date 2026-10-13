// src/core/nodes/filter/flip.ts
import { defineKernel, defineNode } from '../../api.ts';

const flip = (kind: 'field' | 'color') => defineKernel({
  name: `filter/flip#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { mode: 'u32' },
  cost: 1,
  code: /* wgsl */ `
// Every texel is moved whole: nothing is interpolated, and the output holds the values of the input bit for bit.
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let last = vec2i(frame.res) - vec2i(1);
  var p = px.yx;                                        // 5: transpose
  switch (P.mode) {                                     // the index of the option, in the order the node lists them
    case 0u: { p = vec2i(last.x - px.x, px.y); }       // horizontal: left and right change places
    case 1u: { p = vec2i(px.x, last.y - px.y); }       // vertical: top and bottom change places
    case 2u: { p = last - px; }                        // both: a half turn
    case 3u: { p = vec2i(px.y, last.y - px.x); }       // turn-90: what was at +X is now at +Y
    case 4u: { p = vec2i(last.x - px.y, px.x); }       // turn-270: what was at +Y is now at +X
    default: {}
  }
  return src_at(p);
}`,
});
const kernels = { field: flip('field'), color: flip('color') };

export default defineNode({
  type: 'filter/flip',
  title: 'Flip',
  category: 'filter',
  description: 'Mirrors a terrain or a color map, or turns it by quarter turns, without resampling it.',
  keywords: ['mirror', 'rotate', 'turn', 'transpose', 'reflect'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'horizontal',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'horizontal', label: 'Horizontal' },
        { value: 'vertical', label: 'Vertical' },
        { value: 'both', label: 'Both' },
        { value: 'turn-90', label: 'Turn 90°' },
        { value: 'turn-270', label: 'Turn 270°' },
        { value: 'transpose', label: 'Transpose' },
      ],
      help: 'Horizontal swaps left and right, vertical top and bottom, both is a half turn. The turns are clockwise in the top view; transpose swaps the two axes.',
    },
  ],
  kernels: [kernels.field, kernels.color],
  evaluate(ctx) {
    const src = ctx.input('in');
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], { in: { src }, out: { out }, params: { mode: ctx.enumIndex('mode') } });
    ctx.output('out', out);
  },
});
