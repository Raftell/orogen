// src/core/nodes/ref/autolevel.ts
import { defineNode, ops } from '../../api.ts';

export default defineNode({
  type: 'ref/autolevel',
  title: 'Auto Level (Reference)',
  category: 'ref',
  description: 'Stretches a terrain so that its lowest point is 0 and its highest is 1; the reference node for whole-field statistics.',
  keywords: ['normalize', 'levels', 'stretch', 'range'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  // The extremes of a preview are not those of the build: only a node that says so may let them shape its output.
  resolutionDependent: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const range = ops.minMax(ctx, src);                  // a 1 x 1 field on the GPU: nothing is read back
    const out = ops.remap(ctx, src, { from: range });    // onto 0..1; a flat input becomes 0
    ctx.release(range);
    ctx.output('out', out);
  },
});
