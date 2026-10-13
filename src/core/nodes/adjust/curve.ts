// src/core/nodes/adjust/curve.ts
import { bakeCurve, defineKernel, defineNode } from '../../api.ts';
import { adjust, perChannel, type Kind } from './_wgsl.ts';

// The table is read between its samples in straight lines. With 4096 samples a curve that bends as sharply as a
// second derivative of 100 is met within 1e-6; with the 1024 of the default table, within 1e-5.
const SAMPLES = 4096;

const curve = (kind: Kind) => defineKernel({
  name: `adjust/curve#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  luts: { ramp: 'f32' },
  includes: [adjust],
  cost: kind === 'field' ? 3 : 7,   // the texel, and two samples of the table for each value remapped
  code: /* wgsl */ `
// ramp_at saturates its argument: below 0 and above 1 the curve keeps the value of its end, as evalCurve does.
fn shape(x: f32) -> f32 {
  return ramp_at(x);
}
${perChannel(kind)}`,
});
const kernels = { field: curve('field'), color: curve('color') };

export default defineNode({
  type: 'adjust/curve',
  title: 'Curve',
  category: 'adjust',
  description: 'Remaps values through a curve, which reshapes the profile of a terrain: flat valley floors, steeper flanks, rounded tops.',
  keywords: ['remap', 'profile', 'tone', 'spline', 'transfer', 'contrast'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    {
      kind: 'curve', name: 'curve', label: 'Curve',
      // Flat below a quarter and above three quarters, steep between: valleys widen into floors and summits into
      // shoulders, and the flanks between them steepen.
      default: [{ x: 0, y: 0 }, { x: 0.3, y: 0.06 }, { x: 0.7, y: 0.94 }, { x: 1, y: 1 }],
      help: 'The new value for every value, from 0 on the left to 1 on the right. Values outside that range take the value of the nearer end of the curve.',
    },
  ],
  kernels: [kernels.field, kernels.color],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const ramp = ctx.lut(bakeCurve(ctx.params.curve, SAMPLES), 'f32');
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], { in: { src }, out: { out }, luts: { ramp } });
    ctx.output('out', out);
  },
});
