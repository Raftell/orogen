// src/core/nodes/select/exposure.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { invert } from './_params.ts';
import { selectShape } from './_wgsl.ts';

/** Half the height of the sun's disc at a softness of 1, in degrees: what the edge of a cast shadow is blurred over. */
const MAX_HALF_DISC = 15;

const light = defineKernel({
  name: 'select/exposure',
  inputs: { height: 'field' },
  // seen: the share of the sun's disc the texel sees; it becomes the mask.
  inPlace: { seen: 'field' },
  // sun: the unit vector towards the sun.
  params: { sun: 'vec3f', invert: 'u32' },
  includes: [selectShape],
  cost: 6,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  // The light a surface receives is the cosine between its normal and the direction of the sun, from physical slopes.
  let g = slopeAt(height, px);
  let facing = dot(normalize(vec3f(-g.x, -g.y, 1.0)), P.sun);
  var lit = 0.0;
  if (facing > 0.0) { lit = facing * selectShape_ease(cur.seen); }
  return Out(selectShape_flip(lit, P.invert));
}`,
});

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

export default defineNode({
  type: 'select/exposure',
  title: 'Exposure',
  category: 'select',
  description: 'Selects the ground a sun at a given direction and elevation lights, by how squarely it is lit and with cast shadows.',
  keywords: ['sunlight', 'insolation', 'shadow', 'shade', 'light', 'sun', 'illumination', 'hillshade'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }],
  params: [
    param.angle({ default: 180, help: 'The direction from the terrain towards the sun, as seen from above: 0 is +X, and larger values turn clockwise.' }),
    {
      kind: 'float', name: 'elevation', label: 'Elevation', unit: 'angle', default: 30, min: 0, max: 90,
      help: 'The height of the sun above the horizon: larger values shorten the shadows and light level ground more.',
    },
    {
      kind: 'float', name: 'softness', label: 'Softness', unit: 'ratio', default: 0.2, min: 0, max: 1,
      help: 'Larger values blur the edges of cast shadows more, as a wider sun does, and more the farther the shadow falls.',
    },
    param.radius({ help: 'Smooths the terrain before it is lit: larger values light the broad shape and ignore small detail.' }),
    invert,
  ],
  kernels: [light],
  async evaluate(ctx) {
    const { angle, elevation, softness, radius } = ctx.params;
    const direction = radians(angle);
    const high = radians(elevation);
    const height = ops.smooth(ctx, ctx.input('in'), Math.max(radius, 0));   // soft: any finite number can arrive
    // The share of the sun's disc every texel sees over the terrain towards the sun; it becomes the mask.
    const out = await ops.shadow(ctx, height, { angle, elevation, disc: softness * MAX_HALF_DISC });
    ctx.run(light, {
      in: { height },
      rw: { seen: out },
      params: { sun: [Math.cos(high) * Math.cos(direction), Math.cos(high) * Math.sin(direction), Math.sin(high)], invert: ctx.params.invert },
    });
    ctx.release(height);
    ctx.output('out', out);
  },
});
