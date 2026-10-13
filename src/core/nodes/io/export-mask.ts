// src/core/nodes/io/export-mask.ts
import { defineNode } from '../../api.ts';
import { dimension, sizeOf } from './_texture.ts';

export default defineNode({
  type: 'io/export-mask',
  title: 'Mask Texture',
  category: 'io',
  description: 'Exports a mask as a grayscale texture that covers the landscape, for use in its material.',
  keywords: ['unreal', 'texture', 'grayscale', 'data', 'png'],
  inputs: [{ name: 'in', type: 'field', role: 'mask' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    {
      kind: 'text', name: 'name', label: 'Name', default: 'Mask', maxLength: 64,
      help: 'Names the texture file. Only its letters and digits are used.',
    },
    dimension,
    {
      kind: 'enum', name: 'bits', label: 'Bit depth', default: '8',
      options: [
        { value: '8', label: '8 bits' },
        { value: '16', label: '16 bits' },
      ],
      help: 'Bits of the texture. Sixteen keeps smooth gradients free of steps and makes the file larger.',
    },
  ],
  kernels: [],
  evaluate() {},
  export(ctx) {
    return [{
      kind: 'texture', source: ctx.source('in'), name: ctx.params.name, content: 'mask', size: sizeOf(ctx.params.dimension),
      bits: ctx.params.bits === '16' ? 16 : 8,
    }];
  },
});
