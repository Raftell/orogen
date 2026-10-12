// src/core/nodes/ref/colorize.ts
import { bakeGradient, defineKernel, defineNode, param } from '../../api.ts';

const colorize = defineKernel({
  name: 'ref/colorize',
  inputs: { src: 'field', base: { kind: 'color', default: [0, 0, 0, 1] } },   // an unconnected base is black
  outputs: { out: 'color' },
  params: { strength: 'f32' },
  luts: { ramp: 'vec4f' },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  let painted = ramp_at(src_at(px)).rgb;   // ramp_at saturates its argument
  return vec4f(mix(base_at(px).rgb, painted, P.strength), 1.0);
}`,
});

export default defineNode({
  type: 'ref/colorize',
  title: 'Colorize (Reference)',
  category: 'ref',
  description: 'Colors a terrain by its height through a gradient, over an optional base color; the reference node for color nodes.',
  keywords: ['gradient', 'ramp', 'tint', 'palette'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'base', type: 'color', optional: true },
  ],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    {
      kind: 'gradient', name: 'gradient', label: 'Gradient',
      // Linear RGB, as every color in the graph is.
      default: [
        { t: 0, color: [0.05, 0.12, 0.05] },
        { t: 0.2, color: [0.15, 0.25, 0.07] },
        { t: 0.4, color: [0.35, 0.33, 0.12] },
        { t: 0.6, color: [0.3, 0.2, 0.12] },
        { t: 0.8, color: [0.3, 0.29, 0.28] },
        { t: 1, color: [0.9, 0.92, 0.95] },
      ],
      help: 'The colors of the terrain, from its lowest height on the left to its highest on the right.',
    },
    param.strength(),
  ],
  kernels: [colorize],
  evaluate(ctx) {
    const { gradient, strength } = ctx.params;
    const ramp = ctx.lut(bakeGradient(gradient), 'vec4f');   // lives until evaluate() settles
    const out = ctx.alloc('color');
    ctx.run(colorize, {
      in: { src: ctx.input('in'), base: ctx.input('base') },
      out: { out },
      params: { strength },
      luts: { ramp },
    });
    ctx.output('out', out);
  },
});
