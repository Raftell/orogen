// src/core/nodes/io/export-field.ts
import { defineNode } from '../../api.ts';

export default defineNode({
  type: 'io/export-field',
  title: 'Image File',
  category: 'io',
  description: 'Exports a terrain, a mask or a data map as a one-channel image at build resolution, for other tools.',
  keywords: ['save', 'write', 'heightmap', 'exr', 'tiff', 'png', 'raw', 'r16', 'r32'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    {
      kind: 'text', name: 'name', label: 'Name', default: 'Field', maxLength: 64,
      help: 'Names the image file. Only its letters and digits are used.',
    },
    {
      kind: 'enum', name: 'format', label: 'Format', default: 'exr',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'png8', label: 'PNG, 8 bits' },
        { value: 'png16', label: 'PNG, 16 bits' },
        { value: 'r16', label: 'Raw, 16 bits' },
        { value: 'r32', label: 'Raw, 32-bit float' },
        { value: 'exr', label: 'OpenEXR, 32-bit float' },
        { value: 'tiff16', label: 'TIFF, 16 bits' },
        { value: 'tiff32', label: 'TIFF, 32-bit float' },
      ],
      help: 'The file format. The float formats store the values as they are; the others store whole numbers of 8 or 16 bits.',
    },
    {
      kind: 'enum', name: 'rangeMode', label: 'Value range', default: 'unit',
      options: [
        { value: 'unit', label: 'Zero to one' },
        { value: 'measured', label: 'Measured' },
      ],
      help: 'Which values the whole-number formats store as black and white: zero and one, or the lowest and highest value found.',
    },
  ],
  kernels: [],
  evaluate() {},
  export(ctx) {
    return [{ kind: 'image', source: ctx.source('in'), name: ctx.params.name, format: ctx.params.format, map: ctx.params.rangeMode }];
  },
});
