// src/core/nodes/color/gradient-map.ts
import { bakeGradient, defineKernel, defineNode } from '../../api.ts';

/**
 * The samples of the baked gradient. A stop that lies between two samples is rounded over the cell it lies in;
 * with 1025 samples a stop at any multiple of 1/1024 lies on one and is kept as it is.
 */
const SAMPLES = 1025;
/** The widest range the two ends of the input are taken at: any finite number can be typed, and a kernel param is a float32. */
const FAR = 1e30;

const map = defineKernel({
  name: 'color/gradient-map',
  inputs: { src: 'field' },
  outputs: { out: 'color' },
  params: { inMin: 'f32', inMax: 'f32' },
  luts: { ramp: 'vec4f' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec4f {
  let v = src_at(px);
  // The place of the value between the two ends: 0 at the minimum and before it, 1 at the maximum and beyond.
  // A maximum below the minimum turns the gradient over, and two ends on one value are a threshold. Only a
  // value between the ends is divided: one far beyond a narrow range would overflow.
  let lo = min(P.inMin, P.inMax);
  let hi = max(P.inMin, P.inMax);
  var t = select(0.0, 1.0, v >= P.inMin);
  if (v > lo && v < hi) {
    t = (v - P.inMin) / (P.inMax - P.inMin);
  } else if (hi > lo) {
    t = select(0.0, 1.0, (v >= hi) == (P.inMax > P.inMin));
  }
  return vec4f(ramp_at(t).rgb, 1.0);
}`,
});

export default defineNode({
  type: 'color/gradient-map',
  title: 'Gradient Map',
  category: 'color',
  description: 'Colors a field through a gradient: the input minimum gets the left end, the input maximum the right end.',
  keywords: ['ramp', 'colorize', 'palette', 'lut', 'clut', 'tint', 'hypsometric', 'false color'],
  inputs: [{ name: 'in', type: 'field', role: 'data' }],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    {
      kind: 'gradient', name: 'gradient', label: 'Gradient',
      // Linear RGB, as every color in the graph is: lowland green over meadow, sand and rock to snow.
      default: [
        { t: 0, color: [0.015, 0.05, 0.027] },
        { t: 0.125, color: [0.05, 0.147, 0.042] },
        { t: 0.25, color: [0.195, 0.323, 0.078] },
        { t: 0.375, color: [0.539, 0.479, 0.144] },
        { t: 0.5, color: [0.479, 0.323, 0.122] },
        { t: 0.625, color: [0.275, 0.156, 0.072] },
        { t: 0.75, color: [0.205, 0.144, 0.112] },
        { t: 0.875, color: [0.451, 0.413, 0.381] },
        { t: 1, color: [0.905, 0.905, 0.888] },
      ],
      help: 'The colors of the field, from the input minimum on the left to the input maximum on the right.',
    },
    {
      kind: 'float', name: 'inMin', label: 'Input minimum', unit: 'none', default: 0, min: 0, max: 1, soft: true,
      help: 'The value that gets the left end of the gradient. Larger values move every color towards higher values.',
    },
    {
      kind: 'float', name: 'inMax', label: 'Input maximum', unit: 'none', default: 1, min: 0, max: 1, soft: true,
      help: 'The value that gets the right end of the gradient. Smaller values press the colors into a narrower range.',
    },
  ],
  kernels: [map],
  evaluate(ctx) {
    const { gradient, inMin, inMax } = ctx.params;
    const ramp = ctx.lut(bakeGradient(gradient, SAMPLES), 'vec4f');
    const out = ctx.alloc('color');
    ctx.run(map, {
      in: { src: ctx.input('in') },
      out: { out },
      // Soft: any finite number can arrive.
      params: { inMin: Math.min(Math.max(inMin, -FAR), FAR), inMax: Math.min(Math.max(inMax, -FAR), FAR) },
      luts: { ramp },
    });
    ctx.output('out', out);
  },
});
