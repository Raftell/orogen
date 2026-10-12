// src/core/nodes/ref/slope-mask.ts
import { defineKernel, defineNode, param } from '../../api.ts';

const slopeMask = defineKernel({
  name: 'ref/slope-mask',
  inputs: { height: 'field' },
  outputs: { out: 'field' },
  params: { lo: 'f32', hi: 'f32' },   // radians
  cost: 4,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  // slopeAt is physical: metres per metre, from the terrain size and the height range.
  let angle = atan(length(slopeAt(height, px)));
  // The two ends are returned, not computed: a device may divide a number by itself to just below 1,
  // and a mask is 0 and 1 exactly where it says so.
  if (angle <= P.lo) { return 0.0; }
  if (angle >= P.hi) { return 1.0; }
  return saturate((angle - P.lo) / (P.hi - P.lo));
}`,
});

export default defineNode({
  type: 'ref/slope-mask',
  title: 'Slope Mask (Reference)',
  category: 'ref',
  description: 'Selects terrain by its slope, from 0 at the lower angle to 1 at the upper; the reference node for mask producers.',
  keywords: ['steepness', 'angle', 'cliff', 'select'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.slope('slopeMin', { label: 'Lower slope', default: 20, help: 'Terrain no steeper than this is left out.' }),
    param.slope('slopeMax', { label: 'Upper slope', default: 45, help: 'Terrain at least this steep is fully selected.' }),
  ],
  kernels: [slopeMask],
  evaluate(ctx) {
    const { slopeMin, slopeMax } = ctx.params;
    // The mask is linear in the angle, so the thresholds stay angles: tan(90 degrees) never appears.
    const lo = (slopeMin * Math.PI) / 180;
    const hi = (Math.max(slopeMax, slopeMin) * Math.PI) / 180;   // an upper angle below the lower one makes a hard edge at the lower
    const out = ctx.alloc('field');
    ctx.run(slopeMask, { in: { height: ctx.input('in') }, out: { out }, params: { lo, hi } });
    ctx.output('out', out);
  },
});
