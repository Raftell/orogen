// src/core/nodes/filter/blur.ts
import { defineNode, ops, param } from '../../api.ts';

export default defineNode({
  type: 'filter/blur',
  title: 'Blur',
  category: 'filter',
  description: 'Blurs a terrain or a color map with a Gaussian of the given radius.',
  keywords: ['gaussian', 'smooth', 'soften'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [param.radius({ default: 0.01, help: 'Larger values smooth away broader features.' })],
  kernels: [],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    // Soft: any finite number can arrive. Beyond a few terrain widths the result is the mean of the picture.
    const radius = Math.min(Math.max(ctx.params.radius, 0), 4);
    // The radius is the standard deviation, and weights beyond three of them are dropped: with no neighbour
    // that near the blur changes nothing, and the input itself is the output.
    if (Math.floor(3 * ctx.lengthToPx(radius)) < 1) {
      ctx.output('out', src);
      return;
    }
    ctx.output('out', ops.blur(ctx, src, radius));
  },
});
