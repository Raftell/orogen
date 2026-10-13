// src/core/nodes/io/export-layer.ts
import { defineNode } from '../../api.ts';

export default defineNode({
  type: 'io/export-layer',
  title: 'Landscape Layer',
  category: 'io',
  description: 'Exports a mask as an Unreal landscape target layer.',
  keywords: ['unreal', 'weightmap', 'splat', 'paint layer'],
  inputs: [{ name: 'in', type: 'field', role: 'mask' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    {
      kind: 'text', name: 'layer', label: 'Layer name', default: 'Layer', maxLength: 63,
      help: 'Name of the landscape target layer. It must equal the layer name used in the landscape material.',
    },
    {
      kind: 'bool', name: 'weightBlended', label: 'Weight-blended', default: true,
      help: 'On: the layer shares the total weight with the other weight-blended layers. Off: an independent mask.',
    },
  ],
  kernels: [],
  evaluate() {},
  export(ctx) {
    return [{ kind: 'layer', source: ctx.source('in'), layer: ctx.params.layer, weightBlended: ctx.params.weightBlended }];
  },
});
