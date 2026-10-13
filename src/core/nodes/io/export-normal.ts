// src/core/nodes/io/export-normal.ts
import { defineNode } from '../../api.ts';
import { dimension, sizeOf } from './_texture.ts';

export default defineNode({
  type: 'io/export-normal',
  title: 'Normal Texture',
  category: 'io',
  description: 'Exports the surface normals of a terrain as a texture that covers the landscape, for use in its material.',
  keywords: ['unreal', 'texture', 'normal map', 'macro normal', 'png'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    {
      kind: 'text', name: 'name', label: 'Name', default: 'Normal', maxLength: 64,
      help: 'Names the texture file. Only its letters and digits are used.',
    },
    dimension,
  ],
  kernels: [],
  evaluate() {},
  export(ctx) {
    return [{ kind: 'texture', source: ctx.source('in'), name: ctx.params.name, content: 'normal', size: sizeOf(ctx.params.dimension), bits: 8 }];
  },
});
