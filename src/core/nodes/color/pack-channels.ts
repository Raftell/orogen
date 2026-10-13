// src/core/nodes/color/pack-channels.ts
import { defineKernel, defineNode } from '../../api.ts';
import { colorStore } from './_wgsl.ts';

const pack = defineKernel({
  name: 'color/pack-channels',
  // An unconnected channel is 0, and the alpha 1: the three colors are absent and the result opaque.
  inputs: {
    r: { kind: 'field', default: 0 },
    g: { kind: 'field', default: 0 },
    b: { kind: 'field', default: 0 },
    a: { kind: 'field', default: 1 },
  },
  outputs: { out: 'color' },
  includes: [colorStore],
  cost: 4,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  return colorStore_rgba(vec4f(r_at(px), g_at(px), b_at(px), a_at(px)));
}`,
});

export default defineNode({
  type: 'color/pack-channels',
  title: 'Pack Channels',
  category: 'color',
  description: 'Packs up to four fields into the red, green, blue and alpha of one color; a channel left open is 0, and the alpha 1.',
  keywords: ['combine', 'merge', 'rgba', 'splat', 'packed masks', 'channels', 'orm'],
  inputs: [
    { name: 'r', type: 'field', label: 'Red', optional: true },
    { name: 'g', type: 'field', label: 'Green', optional: true },
    { name: 'b', type: 'field', label: 'Blue', optional: true },
    { name: 'a', type: 'field', label: 'Alpha', optional: true },
  ],
  outputs: [{ name: 'out', type: 'color' }],
  params: [],
  kernels: [pack],
  evaluate(ctx) {
    const out = ctx.alloc('color');
    ctx.run(pack, {
      in: { r: ctx.input('r'), g: ctx.input('g'), b: ctx.input('b'), a: ctx.input('a') },
      out: { out },
    });
    ctx.output('out', out);
  },
});
