// src/core/nodes/filter/high-pass.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';

// The detail around 0.5. A color keeps its alpha: only its three channels have detail to keep.
const DETAIL = {
  field: 'return 0.5 + (s - l);',
  color: 'return vec4f(vec3f(0.5) + (s.rgb - l.rgb), s.a);',
} as const;

const detail = (kind: 'field' | 'color') => defineKernel({
  name: `filter/high-pass#${kind}`,
  inputs: { src: kind, low: kind },
  outputs: { out: kind },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let s = src_at(px);
  let l = low_at(px);
  ${DETAIL[kind]}
}`,
});
const kernels = { field: detail('field'), color: detail('color') };

export default defineNode({
  type: 'filter/high-pass',
  title: 'High Pass',
  category: 'filter',
  description: 'Keeps the detail finer than a radius and flattens everything broader to the level 0.5.',
  keywords: ['detail', 'frequency', 'flatten', 'extract'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [param.radius({ default: 0.02, help: 'Features broader than this are flattened; larger values keep more of the shape.' })],
  kernels: [kernels.field, kernels.color],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const radius = Math.min(Math.max(ctx.params.radius, 0), 4);
    // Below a quarter of a texel the blur is the picture itself, and what is left of it is the level 0.5.
    const low = ops.blur(ctx, src, radius);
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], { in: { src, low }, out: { out } });
    ctx.release(low);
    ctx.output('out', out);
  },
});
