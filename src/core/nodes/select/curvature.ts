// src/core/nodes/select/curvature.ts
import { FIT_MIN_SIGMA, defineKernel, defineNode, ops, param } from '../../api.ts';
import { invert } from './_params.ts';
import { selectShape } from './_wgsl.ts';

/**
 * The bend that is fully selected at a strength of 0.5: the mean curvature times the radius, which is half the
 * change of slope across one radius, as a tangent. To calibrate: on ref/fbm at the test scale the crests of
 * the ridges reach it and their flanks do not.
 */
const FULL_BEND = 0.2;

// The five derivatives of the smoothed terrain, per texel, into the mean curvature of the physical surface.
const measure = defineKernel({
  name: 'select/curvature.measure',
  inputs: { zx: 'field', zy: 'field', zxx: 'field', zxy: 'field', zyy: 'field' },
  outputs: { out: 'field' },
  // rise: metres of height per metre of ground, for a derivative of 1 per texel. reach: the radius, in texels.
  params: { rise: 'f32', reach: 'f32' },
  cost: 5,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  // Slopes in metres per metre; second derivatives per metre, times the radius in metres.
  let gx = zx_at(px) * P.rise;
  let gy = zy_at(px) * P.rise;
  let hxx = zxx_at(px) * P.rise * P.reach;
  let hxy = zxy_at(px) * P.rise * P.reach;
  let hyy = zyy_at(px) * P.rise * P.reach;
  // The mean curvature of the surface z(x, y), positive where it is hollow. On a slope the same bend of the
  // ground is a smaller second derivative of the height, which the terms in the slope account for.
  let w = 1.0 + gx * gx + gy * gy;
  let mean = ((1.0 + gy * gy) * hxx - 2.0 * gx * gy * hxy + (1.0 + gx * gx) * hyy) / (2.0 * w * sqrt(w));
  return -mean;
}`,
});

const mask = defineKernel({
  name: 'select/curvature',
  inputs: { bend: 'field' },
  outputs: { out: 'field' },
  params: { gain: 'f32', mode: 'u32', invert: 'u32' },
  includes: [selectShape],
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let convex = bend_at(px) * P.gain;
  var v = convex;                       // 0: convex
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { v = -convex; }
    case 2u: { v = abs(convex); }
    default: {}
  }
  return selectShape_flip(v, P.invert);
}`,
});

export default defineNode({
  type: 'select/curvature',
  title: 'Curvature',
  category: 'select',
  description: 'Selects convex ground such as ridges and crests, or concave ground such as gullies and hollows, at the scale of a radius.',
  keywords: ['convex', 'concave', 'ridge', 'crest', 'gully', 'crease', 'cavity', 'laplacian'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'convex',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'convex', label: 'Convex' },
        { value: 'concave', label: 'Concave' },
        { value: 'both', label: 'Both' },
      ],
      help: 'Convex selects ridges and crests, concave selects gullies and hollows, both selects every bend of the ground.',
    },
    param.radius({ default: 0.01, help: 'The scale the bend is measured at: larger values pick out broader ridges and valleys and ignore small detail.' }),
    param.strength({ default: 0.5, help: 'Larger values select gentler bends, until every bend of the chosen kind is fully selected.' }),
    invert,
  ],
  kernels: [measure, mask],
  evaluate(ctx) {
    const { strength } = ctx.params;
    const radius = Math.max(ctx.params.radius, 0);   // soft: any finite number can arrive
    const scale = ops.scale(ctx, ctx.input('in'), radius);

    // Along x: the smoothed terrain, its slope and its bend. Along y, of each of them, what the surface needs.
    const x = ops.fit(ctx, scale, scale.field, 0, { value: true, slope: true, bend: true });
    if (scale.owned) ctx.release(scale.field);
    const zxx = ops.fit(ctx, scale, x.bend!, 1, { value: true }).value!;
    ctx.release(x.bend!);
    const acrossSlope = ops.fit(ctx, scale, x.slope!, 1, { value: true, slope: true });
    ctx.release(x.slope!);
    const acrossValue = ops.fit(ctx, scale, x.value!, 1, { slope: true, bend: true });
    ctx.release(x.value!);

    // The radius the bend is counted over is never below the Gaussian the derivatives are fitted with.
    const reach = Math.max(ctx.lengthToMetres(radius), FIT_MIN_SIGMA * ctx.cellSize) / scale.cell;
    const bend = ctx.alloc('field', { like: zxx });
    const derivatives = { zx: acrossSlope.value!, zy: acrossValue.slope!, zxx, zxy: acrossSlope.slope!, zyy: acrossValue.bend! };
    ctx.run(measure, { in: derivatives, out: { out: bend }, params: { rise: ctx.heightRange / scale.cell, reach } });
    for (const field of Object.values(derivatives)) ctx.release(field);

    const full = ops.restore(ctx, scale, bend);
    if (full !== bend) ctx.release(bend);
    const out = ctx.alloc('field');
    // The strength acts as its cube: half of it asks for eight times the bend, and 0 selects nothing.
    ctx.run(mask, {
      in: { bend: full },
      out: { out },
      params: { gain: (2 * strength) ** 3 / FULL_BEND, mode: ctx.enumIndex('mode'), invert: ctx.params.invert },
    });
    ctx.release(full);
    ctx.output('out', out);
  },
});
