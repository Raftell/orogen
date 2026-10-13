// src/core/nodes/generate/gradient.ts
import { defineKernel, defineNode, param } from '../../api.ts';

const gradient = defineKernel({
  name: 'generate/gradient',
  outputs: { out: 'field' },
  params: { origin: 'vec2f', dir: 'vec2f', perLength: 'f32', mode: 'u32' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  // 0 at the start of the ramp and 1 at its end; the ramp is centred on the origin.
  let t = dot(uv - P.origin, P.dir) * P.perLength + 0.5;
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { return saturate(1.0 - abs(2.0 * t - 1.0)); }
    case 2u: { let s = saturate(t); return s * s * (3.0 - 2.0 * s); }
    default: { return saturate(t); }
  }
}`,
});

export default defineNode({
  type: 'generate/gradient',
  title: 'Gradient',
  category: 'generate',
  description: 'Generates a straight ramp that rises across the terrain in one direction.',
  keywords: ['ramp', 'linear', 'slope', 'tilt', 'incline', 'falloff'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'linear',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'mirrored', label: 'Mirrored' },
        { value: 'smooth', label: 'Smooth' },
      ],
      help: 'Linear rises evenly, Mirrored rises to the middle of the ramp and falls again, Smooth eases in and out.',
    },
    param.angle({ help: 'The direction in which the ramp rises. Larger values turn it clockwise in the top view.' }),
    param.size({ label: 'Length', default: 1, help: 'Larger values stretch the ramp over a longer distance.' }),
    {
      kind: 'vec2', name: 'offset', label: 'Offset', unit: 'length', default: [0, 0], min: -1, max: 1, soft: true,
      help: 'Moves the ramp away from the center of the terrain.',
    },
  ],
  kernels: [gradient],
  evaluate(ctx) {
    const { angle, size, offset } = ctx.params;
    const r = (angle * Math.PI) / 180;
    const out = ctx.alloc('field');
    ctx.run(gradient, {
      out: { out },
      params: {
        origin: [0.5 + offset[0], 0.5 + offset[1]],
        dir: [Math.cos(r), Math.sin(r)],
        perLength: 1 / Math.max(size, 1e-6),   // size is soft: 0 and negative values arrive, and make the hardest ramp
        mode: ctx.enumIndex('mode'),
      },
    });
    ctx.output('out', out);
  },
});
