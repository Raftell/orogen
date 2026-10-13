// src/core/nodes/color/extract-channel.ts
import { convert, defineKernel, defineNode } from '../../api.ts';

const extract = defineKernel({
  name: 'color/extract-channel',
  inputs: { src: 'color' },
  outputs: { out: 'field' },
  // channel: the index of the option, red, green, blue, alpha, luminance.
  params: { channel: 'u32' },
  includes: [convert],
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let c = src_at(px);
  switch (P.channel) {
    case 0u: { return c.r; }
    case 1u: { return c.g; }
    case 2u: { return c.b; }
    case 3u: { return c.a; }
    default: { return convert_luma(c); }
  }
}`,
});

export default defineNode({
  type: 'color/extract-channel',
  title: 'Extract Channel',
  category: 'color',
  description: 'Takes one channel of a color, or its luminance, as a field.',
  keywords: ['split', 'separate', 'red', 'green', 'blue', 'alpha', 'luma', 'grayscale', 'unpack'],
  inputs: [{ name: 'in', type: 'color' }],
  outputs: [{ name: 'out', type: 'field', role: 'data' }],
  params: [
    {
      kind: 'enum', name: 'channel', label: 'Channel', default: 'red',
      options: [
        { value: 'red', label: 'Red' },
        { value: 'green', label: 'Green' },
        { value: 'blue', label: 'Blue' },
        { value: 'alpha', label: 'Alpha' },
        { value: 'luminance', label: 'Luminance' },
      ],
      help: 'Which channel of the color becomes the field. Luminance is the brightness of the color as the eye weighs red, green and blue.',
    },
  ],
  kernels: [extract],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.run(extract, { in: { src: ctx.input('in') }, out: { out }, params: { channel: ctx.enumIndex('channel') } });
    ctx.output('out', out);
  },
});
