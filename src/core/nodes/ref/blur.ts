// src/core/nodes/ref/blur.ts
// The pattern of a separable filter. A node that only needs a Gaussian calls ops.blur instead of copying this one.
import { defineKernel, defineNode, ops, param, type Field, type OpContext } from '../../api.ts';

const MAX_TAPS = 30;               // on each side of the centre: 61 loads per pass, within the 64 of engine.md 3.15
const MAX_SIGMA = MAX_TAPS / 3;    // weights beyond 3 sigma are dropped: the widest Gaussian one pass holds, in texels

// One kernel per kind the node accepts; the alias out_t lets one body serve both.
const pass = (kind: 'field' | 'color') => defineKernel({
  name: `ref/blur.pass#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { dir: 'vec2i', taps: 'i32', falloff: 'f32' },
  cost: 2 * MAX_TAPS + 1,
  code: /* wgsl */ `
const MAX_TAPS = ${MAX_TAPS};

// One axis of the Gaussian: the weights exp(-falloff * i * i) of the taps, renormalised. Reads clamp to the border.
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let taps = clamp(P.taps, 0, MAX_TAPS);
  let centre = src_at(px);
  // Summed as differences from the centre: a constant field stays that constant, and the alpha of an opaque
  // color stays 1, bit for bit. A sum divided by its own weight does not come out exact on every device.
  var sum = out_t(0.0);
  var weight = 1.0;
  for (var i = 1; i <= taps; i++) {
    let w = exp(-P.falloff * f32(i * i));
    sum += w * ((src_at(px - i * P.dir) - centre) + (src_at(px + i * P.dir) - centre));
    weight += 2.0 * w;
  }
  return centre + sum / weight;
}`,
});
const passes = { field: pass('field'), color: pass('color') };

/** The Gaussian of `sigma` texels of `src`'s own grid: rows, then columns. */
function gaussian<K extends 'field' | 'color'>(ctx: OpContext, src: Field<K>, sigma: number): Field<K> {
  const taps = Math.min(Math.floor(3 * sigma), MAX_TAPS);
  const params = { taps, falloff: 1 / (2 * sigma * sigma) };
  const cost = 2 * taps + 1;   // the loads of this run, not of the widest one: tiles and batches are sized from it
  const rows = ctx.alloc(src.kind, { like: src });
  ctx.run(passes[src.kind], { in: { src }, out: { out: rows }, params: { dir: [1, 0], ...params }, cost });
  const out = ctx.alloc(src.kind, { like: src });
  ctx.run(passes[src.kind], { in: { src: rows }, out: { out }, params: { dir: [0, 1], ...params }, cost });
  ctx.release(rows);           // dead once the second pass is encoded: returned to the pool now, not when evaluate() settles
  return out;
}

export default defineNode({
  type: 'ref/blur',
  title: 'Blur (Reference)',
  category: 'ref',
  description: 'Blurs a terrain or a color map with a Gaussian of the given radius; the reference node for separable filters.',
  keywords: ['gaussian', 'smooth', 'soften'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [param.radius()],
  kernels: [passes.field, passes.color],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const radius = Math.max(ctx.params.radius, 0);   // soft: any finite number can arrive, a negative one included

    // The radius is a length; a kernel counts texels. With no neighbour within 3 sigma, which a sigma below a
    // quarter of a texel never has, the blur changes nothing: the input itself is the output, at no cost.
    if (Math.floor(3 * ctx.lengthToPx(radius)) < 1) {
      ctx.output('out', src);
      return;
    }

    // A Gaussian too wide for the taps of one pass belongs on a coarser grid, and that is not this node's to
    // write: a grid made with ops.resample ends at the terrain's border, so the clamped reads of a blur on it
    // read a border texel the reduction has already mixed with its neighbours. ops.blur continues its coarse
    // grid past the border as the field's own grid continues, and is the same Gaussian up to the border.
    const sigma = ctx.lengthToPx(radius);
    ctx.output('out', sigma <= MAX_SIGMA ? gaussian(ctx, src, sigma) : ops.blur(ctx, src, radius));
  },
});
