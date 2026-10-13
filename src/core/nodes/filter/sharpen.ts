// src/core/nodes/filter/sharpen.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';

const unsharp = (kind: 'field' | 'color') => defineKernel({
  name: `filter/sharpen#${kind}`,
  inputs: { src: kind, low: kind },
  outputs: { out: kind },
  params: { gain: 'f32' },
  cost: 2,
  code: /* wgsl */ `
// The unsharp mask: of what the blur took away, the share P.gain is added once more. An opaque color stays opaque: its alpha and
// the alpha of its blur are both 1.
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let s = src_at(px);
  return s + P.gain * (s - low_at(px));
}`,
});
const kernels = { field: unsharp('field'), color: unsharp('color') };

export default defineNode({
  type: 'filter/sharpen',
  title: 'Sharpen',
  category: 'filter',
  description: 'Sharpens a terrain or a color map by exaggerating the detail finer than a radius.',
  keywords: ['unsharp mask', 'crisp', 'detail', 'enhance'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    param.radius({ default: 0.01, help: 'Detail finer than this is exaggerated; larger values sharpen broader features.' }),
    param.strength({ help: 'Larger values exaggerate the detail more.' }),
  ],
  kernels: [kernels.field, kernels.color],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const radius = Math.min(Math.max(ctx.params.radius, 0), 4);
    const { strength } = ctx.params;
    // A blur with no neighbour within three standard deviations takes nothing away: there is nothing to add.
    if (strength <= 0 || Math.floor(3 * ctx.lengthToPx(radius)) < 1) {
      ctx.output('out', src);
      return;
    }
    const low = ops.blur(ctx, src, radius);
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], { in: { src, low }, out: { out }, params: { gain: strength } });
    ctx.release(low);
    ctx.output('out', out);
  },
});
