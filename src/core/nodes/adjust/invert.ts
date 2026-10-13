// src/core/nodes/adjust/invert.ts
import { defineKernel, defineNode } from '../../api.ts';
import { adjust, perChannel, type Kind } from './_wgsl.ts';

const invert = (kind: Kind) => defineKernel({
  name: `adjust/invert#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { pivot: 'f32' },
  includes: [adjust],
  cost: 1,
  code: /* wgsl */ `
fn shape(x: f32) -> f32 {
  return 2.0 * P.pivot - x;
}
${perChannel(kind)}`,
});
const kernels = { field: invert('field'), color: invert('color') };

export default defineNode({
  type: 'adjust/invert',
  title: 'Invert',
  category: 'adjust',
  description: 'Mirrors values around a pivot level, so that peaks become pits and valleys become ridges.',
  keywords: ['negate', 'flip', 'negative', 'mirror', 'upside down'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    {
      kind: 'float', name: 'pivot', label: 'Pivot', unit: 'height', default: 0.5, min: 0, max: 1, soft: true,
      help: 'The level that stays where it is. Larger values raise the whole mirrored result.',
    },
  ],
  kernels: [kernels.field, kernels.color],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], { in: { src }, out: { out }, params: { pivot: ctx.params.pivot } });
    ctx.output('out', out);
  },
});
