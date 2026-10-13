// src/core/nodes/color/constant.ts
import { defineNode } from '../../api.ts';

export default defineNode({
  type: 'color/constant',
  title: 'Solid Color',
  category: 'color',
  description: 'Fills the whole terrain with one opaque color.',
  keywords: ['constant', 'fill', 'flat', 'uniform', 'tint', 'swatch'],
  inputs: [],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    {
      kind: 'color', name: 'color', label: 'Color',
      // Linear RGB, as every color in the graph is: a warm earth.
      default: [0.3, 0.2, 0.11],
      help: 'The color every point of the terrain gets.',
    },
  ],
  kernels: [],
  evaluate(ctx) {
    const [red, green, blue] = ctx.params.color;
    // No pass: the field is cleared to the color on the GPU.
    ctx.output('out', ctx.alloc('color', { clear: [red, green, blue, 1] }));
  },
});
