// src/core/nodes/generate/constant.ts
import { defineNode, param } from '../../api.ts';

export default defineNode({
  type: 'generate/constant',
  title: 'Constant',
  category: 'generate',
  description: 'Generates a flat terrain at one height.',
  keywords: ['flat', 'plane', 'level', 'fill', 'uniform', 'solid'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.height({ default: 0.5, help: 'Larger values raise the whole terrain.' }),
  ],
  kernels: [],
  evaluate(ctx) {
    // No pass: the field is cleared to the height on the GPU. A typed height beyond the slider is stored as it is.
    ctx.output('out', ctx.alloc('field', { clear: ctx.params.height }));
  },
});
