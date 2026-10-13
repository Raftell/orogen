// src/core/nodes/generate/radial-gradient.ts
import { defineKernel, defineNode, param } from '../../api.ts';

const radial = defineKernel({
  name: 'generate/radial-gradient',
  outputs: { out: 'field' },
  params: { center: 'vec2f', perRadius: 'f32', crest: 'f32', perHalfWidth: 'f32', mode: 'u32' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let d = length(uv - P.center);
  let r = d * P.perRadius;              // 0 at the center, 1 at the radius
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { return sqrt(saturate(1.0 - r * r)); }
    case 2u: { let s = saturate(r); return 1.0 - s * s * (3.0 - 2.0 * s); }
    case 3u: { return saturate(1.0 - abs(d - P.crest) * P.perHalfWidth); }
    default: { return saturate(1.0 - r); }
  }
}`,
});

export default defineNode({
  type: 'generate/radial-gradient',
  title: 'Radial Gradient',
  category: 'generate',
  description: 'Generates a round hill that falls from a center point to its radius, or a ring around that point.',
  keywords: ['cone', 'dome', 'bell', 'ring', 'circle', 'falloff', 'hill', 'radial'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'cone',
      options: [
        { value: 'cone', label: 'Cone' },
        { value: 'dome', label: 'Dome' },
        { value: 'bell', label: 'Bell' },
        { value: 'ring', label: 'Ring' },
      ],
      help: 'The profile from the center outwards: a straight cone, a half sphere, a bell that eases in and out, or a ring.',
    },
    {
      kind: 'vec2', name: 'center', label: 'Center', unit: 'length', default: [0.5, 0.5], min: 0, max: 1, soft: true,
      help: 'Where the middle of the shape lies on the terrain.',
    },
    param.radius({ default: 0.5, min: 0.001, max: 2, help: 'Larger values make the shape reach further from its center.' }),
    {
      kind: 'float', name: 'width', label: 'Ring width', unit: 'length', default: 0.2, min: 0.001, max: 1, scale: 'log', soft: true,
      visibleWhen: { param: 'mode', equals: 'ring' },
      help: 'Larger values make the ring broader, inwards from the radius.',
    },
  ],
  kernels: [radial],
  evaluate(ctx) {
    const { center, width } = ctx.params;
    // Both lengths are soft: 0 and negative values arrive. The ring lies inside the radius, so it is never wider.
    const radius = Math.max(ctx.params.radius, 1e-6);
    const band = Math.min(Math.max(width, 1e-6), radius);
    const out = ctx.alloc('field');
    ctx.run(radial, {
      out: { out },
      params: { center, perRadius: 1 / radius, crest: radius - band / 2, perHalfWidth: 2 / band, mode: ctx.enumIndex('mode') },
    });
    ctx.output('out', out);
  },
});
