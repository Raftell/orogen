// src/core/nodes/io/export-color.ts
import { defineNode } from '../../api.ts';
import { dimension, sizeOf } from './_texture.ts';

export default defineNode({
  type: 'io/export-color',
  title: 'Color Texture',
  category: 'io',
  description: 'Exports a color map as a texture that covers the landscape, for use in its material.',
  keywords: ['unreal', 'texture', 'albedo', 'diffuse', 'base color', 'png'],
  inputs: [{ name: 'in', type: 'color' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    {
      kind: 'text', name: 'name', label: 'Name', default: 'Color', maxLength: 64,
      help: 'Names the texture file. Only its letters and digits are used.',
    },
    dimension,
  ],
  kernels: [],
  evaluate() {},
  export(ctx) {
    return [{ kind: 'texture', source: ctx.source('in'), name: ctx.params.name, content: 'color', size: sizeOf(ctx.params.dimension), bits: 8 }];
  },
});
