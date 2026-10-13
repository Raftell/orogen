// src/core/nodes/adjust/levels.ts
import { defineKernel, defineNode } from '../../api.ts';
import { adjust, perChannel, type Kind } from './_wgsl.ts';

const levels = (kind: Kind) => defineKernel({
  name: `adjust/levels#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { inMin: 'f32', inMax: 'f32', invGamma: 'f32', outMin: 'f32', outMax: 'f32', limit: 'u32' },
  includes: [adjust],
  cost: 1,
  code: /* wgsl */ `
fn shape(x: f32) -> f32 {
  let width = P.inMax - P.inMin;
  // The place of x between the two points: 0 at the black point, 1 at the white point. A white point below
  // the black point turns the picture over; the two on one value are a threshold.
  var t = select(0.0, 1.0, x >= P.inMin);
  if (width != 0.0) { t = (x - P.inMin) / width; }
  let s = saturate(t);
  // The two ends are returned, not computed: pow(0, y) is exp2(y * log2(0)) on a device that implements it so.
  // Nor is a gamma of 1 computed: pow(s, 1) is not s to the last bit everywhere.
  var g = s;
  if (s > 0.0 && s < 1.0 && P.invGamma != 1.0) { g = pow(s, P.invGamma); }
  // Without the limit, what lies beyond the two points continues in a straight line. Kept a float: an input far
  // beyond two points that lie close together is so many widths away that their number is none, and an
  // output range of no width must still give its one value.
  if (P.limit == 0u) { g = adjust_field(g + (t - s)); }
  if (g == 0.0) { return P.outMin; }
  if (g == 1.0) { return P.outMax; }
  return P.outMin + g * (P.outMax - P.outMin);
}
${perChannel(kind)}`,
});
const kernels = { field: levels('field'), color: levels('color') };

export default defineNode({
  type: 'adjust/levels',
  title: 'Levels',
  category: 'adjust',
  description: 'Stretches the values between a black point and a white point onto an output range, with a gamma for the values between.',
  keywords: ['contrast', 'remap', 'range', 'gamma', 'black point', 'white point', 'brightness'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    {
      kind: 'float', name: 'inMin', label: 'Black point', unit: 'height', default: 0.25, min: 0, max: 1, soft: true,
      help: 'Values at this level become the output minimum. Larger values turn more of the low ground into a flat floor.',
    },
    {
      kind: 'float', name: 'inMax', label: 'White point', unit: 'height', default: 0.75, min: 0, max: 1, soft: true,
      help: 'Values at this level become the output maximum. Smaller values turn more of the high ground into a flat top.',
    },
    {
      kind: 'float', name: 'gamma', label: 'Gamma', unit: 'none', default: 1, min: 0.1, max: 10, scale: 'log',
      help: 'Larger values lift what lies between the two points; smaller values press it down.',
    },
    {
      kind: 'float', name: 'outMin', label: 'Output minimum', unit: 'height', default: 0, min: 0, max: 1, soft: true,
      help: 'The level the black point is moved to. Larger values raise the low end of the result.',
    },
    {
      kind: 'float', name: 'outMax', label: 'Output maximum', unit: 'height', default: 1, min: 0, max: 1, soft: true,
      help: 'The level the white point is moved to. Smaller values lower the high end of the result.',
    },
    {
      kind: 'bool', name: 'clamp', label: 'Clamp', default: true,
      help: 'Keeps the result within the output range. When off, values beyond the two points continue in a straight line.',
    },
  ],
  kernels: [kernels.field, kernels.color],
  maskable: true,
  evaluate(ctx) {
    const { inMin, inMax, gamma, outMin, outMax, clamp } = ctx.params;
    const src = ctx.input('in');
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], {
      in: { src },
      out: { out },
      params: { inMin, inMax, invGamma: 1 / gamma, outMin, outMax, limit: clamp },
    });
    ctx.output('out', out);
  },
});
