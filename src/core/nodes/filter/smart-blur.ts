// src/core/nodes/filter/smart-blur.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';

const square = defineKernel({
  name: 'filter/smart-blur.square',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let s = src_at(px);
  return s * s;
}`,
});

// Around every texel the terrain is modelled as keep * terrain + rest. Where the heights within the radius vary by
// more than the threshold, keep is near 1 and the model is the terrain; where they vary by less, keep is near 0
// and the model is their mean.
const model = defineKernel({
  name: 'filter/smart-blur.model',
  inputs: { mean: 'field', meanSquare: 'field' },
  outputs: { keep: 'field', rest: 'field' },
  params: { limit: 'f32' },      // the square of the threshold
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let m = mean_at(px);
  // The variance of the heights around the texel. Both means are one positive average, so it is never below 0
  // by more than rounding.
  let variance = max(meanSquare_at(px) - m * m, 0.0);
  let keep = variance / (variance + P.limit);
  return Out(keep, (1.0 - keep) * m);
}`,
});

const apply = defineKernel({
  name: 'filter/smart-blur.apply',
  inputs: { src: 'field', keep: 'field', rest: 'field' },
  outputs: { out: 'field' },
  cost: 3,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return keep_at(px) * src_at(px) + rest_at(px);
}`,
});

export default defineNode({
  type: 'filter/smart-blur',
  title: 'Smart Blur',
  category: 'filter',
  description: 'Smooths gentle ground and keeps cliffs and ridges, where heights differ by more than a threshold.',
  keywords: ['edge preserving', 'guided', 'bilateral', 'surface blur', 'denoise'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.radius({ default: 0.01, help: 'Larger values smooth away broader features where the ground is gentle.' }),
    {
      kind: 'float', name: 'threshold', label: 'Threshold', unit: 'height', default: 0.05, min: 0.001, max: 0.5, scale: 'log', soft: true,
      help: 'Ground whose heights differ by less than this within the radius is smoothed. Larger values smooth steeper ground too.',
    },
  ],
  kernels: [square, model, apply],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const radius = Math.min(Math.max(ctx.params.radius, 0), 4);   // soft: any finite number can arrive
    // A blur with no neighbour within three standard deviations has nothing to average: the input is the output.
    if (Math.floor(3 * ctx.lengthToPx(radius)) < 1) {
      ctx.output('out', src);
      return;
    }
    // Soft as well. With no threshold at all nothing counts as gentle; the smallest one that leaves a square is kept.
    const threshold = Math.min(Math.max(ctx.params.threshold, 1e-6), 1e6);

    // The guided filter of the terrain by itself. Every average is the same Gaussian of the radius.
    const mean = ops.blur(ctx, src, radius);
    const squared = ctx.alloc('field');
    ctx.run(square, { in: { src }, out: { out: squared } });
    const meanSquare = ops.blur(ctx, squared, radius);
    ctx.release(squared);

    const keep = ctx.alloc('field');
    const rest = ctx.alloc('field');
    ctx.run(model, { in: { mean, meanSquare }, out: { keep, rest }, params: { limit: threshold * threshold } });
    ctx.release(mean);
    ctx.release(meanSquare);

    // A texel lies in the neighbourhood of every texel within the radius: it takes the average of their models.
    const keepMean = ops.blur(ctx, keep, radius);
    ctx.release(keep);
    const restMean = ops.blur(ctx, rest, radius);
    ctx.release(rest);

    const out = ctx.alloc('field');
    ctx.run(apply, { in: { src, keep: keepMean, rest: restMean }, out: { out } });
    ctx.release(keepMean);
    ctx.release(restMean);
    ctx.output('out', out);
  },
});
