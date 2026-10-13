// src/core/nodes/adjust/autolevel.ts
import { defineNode, ops } from '../../api.ts';

export default defineNode({
  type: 'adjust/autolevel',
  title: 'Auto Level',
  category: 'adjust',
  description: 'Stretches a terrain so that its lowest point is at 0 and its highest at 1, whatever range it had.',
  keywords: ['normalize', 'levels', 'stretch', 'range', 'fit', 'full range'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  maskable: true,
  // The lowest and the highest point of a preview are not those of the build.
  resolutionDependent: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const range = ops.minMax(ctx, src);                  // a 1 x 1 field on the GPU: nothing is read back
    const out = ops.remap(ctx, src, { from: range });    // onto 0..1; a flat input, which has no range to stretch, becomes 0
    ctx.release(range);
    ctx.output('out', out);
  },
});
