// src/core/nodes/io/export-color.ts
import { defineNode } from '../../api.ts';
import { dimension, sizeOf } from './_texture.ts';

export default defineNode({
  type: 'io/export-color',
  title: 'Color Texture',
  category: 'io',
  description: 'Exports a color map, or three channels of data, as a texture that covers the landscape, for use in its material.',
  keywords: ['unreal', 'texture', 'albedo', 'diffuse', 'base color', 'packed masks', 'linear', 'srgb', 'png'],
  inputs: [{ name: 'in', type: 'color' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    {
      kind: 'text', name: 'name', label: 'Name', default: 'Color', maxLength: 64,
      help: 'Names the texture file. Only its letters and digits are used.',
    },
    dimension,
    {
      kind: 'enum', name: 'content', label: 'Content', default: 'color',
      options: [
        { value: 'color', label: 'Color' },
        { value: 'data', label: 'Data' },
      ],
      help: 'Color is stored sRGB-encoded, as a base color is. Data is stored as it is, for a normal map or packed masks: switch sRGB off for that texture in Unreal.',
    },
  ],
  kernels: [],
  evaluate() {},
  export(ctx) {
    return [{ kind: 'texture', source: ctx.source('in'), name: ctx.params.name, content: ctx.params.content, size: sizeOf(ctx.params.dimension), bits: 8 }];
  },
});
