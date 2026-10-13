// src/core/nodes/adjust/bias-gain.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { adjust, perChannel, type Kind } from './_wgsl.ts';

const biasGain = (kind: Kind) => defineKernel({
  name: `adjust/bias-gain#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { bias: 'f32', gain: 'f32' },
  includes: [adjust],
  cost: 1,
  code: /* wgsl */ `
// Schlick's bias: 0 stays 0, 1 stays 1 and one half becomes b. Written without a division by b, and with the
// two ends returned: between them the divisor is above 0 for every b from 0 to 1.
fn lean(t: f32, b: f32) -> f32 {
  if (t <= 0.0) { return 0.0; }
  if (t >= 1.0) { return 1.0; }
  return t * b / (t * b + (1.0 - t) * (1.0 - b));
}

fn shape(x: f32) -> f32 {
  let s = saturate(x);
  let t = lean(s, P.bias);
  // Schlick's gain: the bias of each half towards its own end of the range.
  var g = 1.0 - 0.5 * lean(2.0 - 2.0 * t, 1.0 - P.gain);
  if (t < 0.5) { g = 0.5 * lean(2.0 * t, 1.0 - P.gain); }
  // The two curves are defined from 0 to 1. What lies beyond keeps its distance from that end.
  return g + (x - s);
}
${perChannel(kind)}`,
});
const kernels = { field: biasGain('field'), color: biasGain('color') };

export default defineNode({
  type: 'adjust/bias-gain',
  title: 'Bias and Gain',
  category: 'adjust',
  description: 'Pushes the values between 0 and 1 toward one end of that range, and toward or away from its middle.',
  keywords: ['schlick', 'midtones', 'contrast', 'gamma', 'shape', 'remap'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    {
      kind: 'float', name: 'bias', label: 'Bias', unit: 'ratio', default: 0.25, min: 0, max: 1,
      help: 'The level a value of one half is moved to. Larger values lift the ground toward the top; smaller values press it toward the bottom and leave sharp peaks.',
    },
    param.gain({
      label: 'Gain', default: 0.5,
      help: 'Larger values push values away from the middle, toward the two ends; smaller values gather them around the middle. One half changes nothing.',
    }),
  ],
  kernels: [kernels.field, kernels.color],
  maskable: true,
  evaluate(ctx) {
    const { bias, gain } = ctx.params;
    const src = ctx.input('in');
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], { in: { src }, out: { out }, params: { bias, gain } });
    ctx.output('out', out);
  },
});
