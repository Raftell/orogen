// src/core/nodes/color/hillshade.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';

/** Half the height of the sun's disc, in degrees: what the edge of a cast shadow is blurred over. */
const HALF_DISC = 2.5;
/** The distance at which higher ground shelters a point most, a length: the width of a gully or a small valley. */
const SHELTER_RADIUS = 0.02;

const shade = defineKernel({
  name: 'color/hillshade',
  // seen: the share of the sun's disc the texel sees. shelter: how sheltered it is by the ground around it.
  // An unconnected base is white: the picture is then the light alone.
  inputs: { height: 'field', seen: 'field', shelter: 'field', base: { kind: 'color', default: [1, 1, 1, 1] } },
  outputs: { out: 'color' },
  // sun: the unit vector towards the sun.
  params: { sun: 'vec3f', strength: 'f32' },
  cost: 8,
  code: /* wgsl */ `
const STEEPEST = 1e6;   // a slope as a tangent beyond which a normal lies level anyway: its square stays a float
const SKY = 0.3;        // the share of the light that comes from the whole sky; the rest comes from the sun
const CLOSING = 3.0;    // how fast shelter closes the sky: an occlusion of 0.3, a valley floor, leaves 0.4 of it
const CREASE = 0.3;     // how much of the sun's light full shelter takes as well, so that a lit hollow still reads as one

fn compute(px: vec2i, uv: vec2f) -> vec4f {
  // The surface is physical: its slope in metres per metre, from the terrain size and the height range.
  let g = clamp(slopeAt(height, px), vec2f(-STEEPEST), vec2f(STEEPEST));
  let n = normalize(vec3f(-g.x, -g.y, 1.0));
  let open = exp(-CLOSING * max(shelter_at(px), 0.0));
  // The sun lights a surface by the cosine between its normal and the direction of the sun, as far as the sun
  // is seen over the terrain; the sky lights it by how much of the sky it faces and sees. Together they are 1
  // at the most: no surface is brighter than its base color.
  let direct = max(dot(n, P.sun), 0.0) * saturate(seen_at(px)) * (1.0 - CREASE * (1.0 - open));
  let ambient = (0.5 + 0.5 * n.z) * open;
  let light = (1.0 - SKY) * direct + SKY * ambient;
  let base = base_at(px).rgb;
  // No strength leaves the base as it is, bit for bit.
  let lit = base * select(mix(1.0, light, P.strength), light, P.strength >= 1.0);
  return vec4f(select(lit, base, P.strength <= 0.0), 1.0);
}`,
});

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

export default defineNode({
  type: 'color/hillshade',
  title: 'Hillshade',
  category: 'color',
  description: 'Renders a terrain lit by a sun, with cast shadows and darkened hollows, over a base color or in white.',
  keywords: ['relief', 'shading', 'shaded relief', 'lighting', 'shadow', 'minimap', 'overview', 'sun', 'ambient occlusion'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'base', type: 'color', optional: true },
  ],
  outputs: [{ name: 'out', type: 'color' }],
  params: [
    param.angle({ default: 225, help: 'The direction from the terrain towards the sun, as seen from above: 0 is +X, and larger values turn clockwise.' }),
    {
      kind: 'float', name: 'elevation', label: 'Elevation', unit: 'angle', default: 40, min: 0, max: 90,
      help: 'The height of the sun above the horizon: larger values shorten the shadows and light level ground more.',
    },
    param.strength({ help: 'How strongly the light and the shadows show over the base color: 0 leaves the base as it is.' }),
  ],
  kernels: [shade],
  async evaluate(ctx) {
    const { angle, elevation, strength } = ctx.params;
    const height = ctx.input('in');
    const direction = radians(angle);
    const high = radians(elevation);
    // The march of the shadows holds the most memory: it runs first, and alone.
    const seen = await ops.shadow(ctx, height, { angle, elevation, disc: HALF_DISC, progress: [0, 0.6] });
    const shelter = await ops.occlusion(ctx, height, SHELTER_RADIUS, { progress: [0.6, 0.95] });
    const out = ctx.alloc('color');
    ctx.run(shade, {
      in: { height, seen, shelter, base: ctx.input('base') },
      out: { out },
      params: { sun: [Math.cos(high) * Math.cos(direction), Math.cos(high) * Math.sin(direction), Math.sin(high)], strength },
    });
    ctx.release(seen);
    ctx.release(shelter);
    ctx.output('out', out);
  },
});
