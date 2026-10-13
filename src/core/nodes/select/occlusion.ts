// src/core/nodes/select/occlusion.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { invert } from './_params.ts';
import { selectShape } from './_wgsl.ts';

/**
 * The occlusion that is fully selected at a strength of 0.5: the sine of the angle by which the ground on both
 * sides stands above a point, as a mean over four axes and over the distances around the radius. To calibrate:
 * on ref/fbm at the test scale the floors of the valleys reach it and open slopes stay near 0.
 */
const FULL_OCCLUSION = 0.3;

const mask = defineKernel({
  name: 'select/occlusion',
  inputs: { sum: 'field' },
  outputs: { out: 'field' },
  params: { gain: 'f32', invert: 'u32' },
  includes: [selectShape],
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return selectShape_flip(sum_at(px) * P.gain, P.invert);
}`,
});

export default defineNode({
  type: 'select/occlusion',
  title: 'Occlusion',
  category: 'select',
  description: 'Selects sheltered ground: hollows, valley floors and the feet of cliffs, where the ground about a radius away stands higher.',
  keywords: ['ambient occlusion', 'ao', 'cavity', 'sheltered', 'hollow', 'valley', 'crevice', 'shade'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.radius({ default: 0.04, help: 'The distance at which higher ground shelters a point most: larger values find whole valleys, smaller ones only creases.' }),
    param.strength({ default: 0.5, help: 'Larger values count shallower hollows as sheltered, until every hollow is fully selected.' }),
    invert,
  ],
  kernels: [mask],
  async evaluate(ctx) {
    const { strength } = ctx.params;
    // How sheltered every texel is by the ground about the radius away. Soft: any finite radius can arrive.
    const total = await ops.occlusion(ctx, ctx.input('in'), Math.max(ctx.params.radius, 0));
    const out = ctx.alloc('field');

    // The strength acts as its cube: half of it asks for eight times the occlusion, and 0 selects nothing.
    ctx.run(mask, { in: { sum: total }, out: { out }, params: { gain: (2 * strength) ** 3 / FULL_OCCLUSION, invert: ctx.params.invert } });
    ctx.release(total);
    ctx.output('out', out);
  },
});
