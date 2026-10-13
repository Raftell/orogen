// src/core/nodes/adjust/clamp.ts
import { defineKernel, defineNode } from '../../api.ts';
import { adjust, perChannel, type Kind } from './_wgsl.ts';

const clamp = (kind: Kind) => defineKernel({
  name: `adjust/clamp#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { lo: 'f32', hi: 'f32', knee: 'f32' },
  includes: [adjust],
  cost: 1,
  code: /* wgsl */ `
// The quadratic that joins the line of a limit to the line of the values within a band of the knee on either
// side of the limit: the slope runs from 0 to 1 without a step. It is 0 a knee away from the limit and beyond.
fn bend(d: f32) -> f32 {
  let r = max(P.knee - abs(d), 0.0);
  return r * r / (4.0 * P.knee);
}

fn shape(x: f32) -> f32 {
  if (P.knee <= 0.0) { return clamp(x, P.lo, P.hi); }
  // The two knees never meet: the node keeps the knee to half the range at most. A value farther than a knee
  // from both limits passes unchanged, bit for bit.
  let raised = max(x, P.lo) + bend(x - P.lo);
  let lowered = min(raised, P.hi) - bend(raised - P.hi);
  return clamp(lowered, P.lo, P.hi);
}
${perChannel(kind)}`,
});
const kernels = { field: clamp('field'), color: clamp('color') };

export default defineNode({
  type: 'adjust/clamp',
  title: 'Clamp',
  category: 'adjust',
  description: 'Limits values to a range, with a hard edge or a soft knee where they reach the limit.',
  keywords: ['limit', 'clip', 'saturate', 'range', 'plateau', 'soft clip'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    {
      kind: 'float', name: 'min', label: 'Minimum', unit: 'height', default: 0.35, min: 0, max: 1, soft: true,
      help: 'Nothing in the result lies below this level. Larger values fill more of the low ground to a flat floor.',
    },
    {
      kind: 'float', name: 'max', label: 'Maximum', unit: 'height', default: 0.65, min: 0, max: 1, soft: true,
      help: 'Nothing in the result lies above this level. Smaller values cut more of the high ground to a flat top.',
    },
    {
      kind: 'float', name: 'softness', label: 'Softness', unit: 'ratio', default: 0.25, min: 0, max: 1,
      help: 'Larger values round the edge of the floor and of the top over a wider band of heights. At 0 the edge is a crease.',
    },
  ],
  kernels: [kernels.field, kernels.color],
  maskable: true,
  evaluate(ctx) {
    const { min, max, softness } = ctx.params;
    // The two levels are the ends of the range whichever is the larger.
    const lo = Math.min(min, max), hi = Math.max(min, max);
    const src = ctx.input('in');
    const out = ctx.alloc(src.kind);
    // At full softness the two knees meet in the middle of the range.
    ctx.run(kernels[src.kind], { in: { src }, out: { out }, params: { lo, hi, knee: (softness * (hi - lo)) / 2 } });
    ctx.output('out', out);
  },
});
