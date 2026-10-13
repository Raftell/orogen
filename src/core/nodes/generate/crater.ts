// src/core/nodes/generate/crater.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateLandCrater, groundAt, levelGround, readCoarse } from './_land-crater.ts';

const crater = defineKernel({
  name: 'generate/crater',
  inputs: { src: { kind: 'field', default: 0 } },
  outputs: { out: 'field' },
  params: {
    center: 'vec2f', invRadius: 'f32', level: 'f32', ground: 'f32', tilt: 'vec2f', flatten: 'f32', depth: 'f32', rim: 'f32', peak: 'f32', ejecta: 'f32',
  },
  includes: [generateLandCrater],
  cost: 112,
  code: /* wgsl */ `
// Beyond this many radii the ejecta has thinned to nothing.
const REACH = 8.0;

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // Without a terrain to stamp into, the ground is level.
  let terrain = select(P.level, src_at(px), src_bound());
  let d = (uv - P.center) * P.invRadius;
  let r0 = length(d);
  if (r0 >= REACH) { return terrain; }
  let ray = d / max(r0, 1.0e-6);
  // The rim is no perfect circle: noise read around the centre moves it in and out.
  let r = r0 * (1.0 + 0.06 * noise_fbm(ray * 1.9 + vec2f(7.1, 3.3), seedFor(1u), 2, 2.0, 0.5));
  // The slumped terraces of the wall lie higher on one side of the crater than on another.
  let uneven = 0.35 * noise_fbm(ray * 1.3 + vec2f(21.7, 5.9), seedFor(4u), 2, 2.0, 0.5);
  var h = generateLandCrater_profile(r, P.rim, P.peak, REACH, uneven) + generateLandCrater_mound(r0, P.peak);
  // The floor of a large crater is hummocky, and its central peak is no smooth cone. The very middle stays as
  // it is, so that the peak tops where the parameters put it.
  let rough = noise_fbm(d * 5.3 + vec2f(11.9, 2.7), seedFor(5u), 4, 2.0, 0.55);
  h += saturate(P.peak * 2.5) * rough * saturate(8.0 * r0) * (0.02 * (1.0 - smoothstep(0.5, 0.9, r)) + 0.35 * generateLandCrater_mound(r0, P.peak));
  // Ejecta: streaks that run outwards from the rim, and hummocks. Noise read on a circle that widens slowly with
  // the distance is nearly the same along a ray, so it draws streaks, without a seam at any angle.
  let x = max(r, 1.0);
  let outside = smoothstep(0.95, 1.25, r) * (1.0 - smoothstep(0.6 * REACH, REACH, r));
  let streaks = noise_fbm(ray * 6.5 * (1.0 + 0.12 * log(x)) + vec2f(1.7, 9.2), seedFor(2u), 3, 2.0, 0.6);
  let hummocks = noise_fbm(d * 3.1 + vec2f(4.4, 8.8), seedFor(3u), 3, 2.0, 0.5);
  h += P.ejecta * P.rim * outside * ((0.9 * streaks + 0.5 * hummocks) / (x * x * x) + 0.5 * max(streaks, 0.0) * max(streaks, 0.0) / (x * sqrt(x)));
  // The impact wipes out what stood inside the rim: there the old terrain gives way to the plane of the ground
  // the impact struck, and the crater is cut into that.
  let plane = P.ground + dot(P.tilt, uv - P.center);
  return generateLandCrater_strike(terrain, plane, P.depth, generateLandCrater_keep(r), P.flatten) + P.depth * h;
}`,
});

export default defineNode({
  type: 'generate/crater',
  title: 'Crater',
  category: 'generate',
  description: 'Stamps one impact crater into the terrain: a bowl with a raised rim, terraced walls, a central peak and a blanket of ejecta.',
  keywords: ['impact', 'meteor', 'bowl', 'rim', 'ejecta', 'moon'],
  inputs: [{ name: 'in', type: 'field', optional: true }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'vec2', name: 'center', label: 'Center', unit: 'length', default: [0.5, 0.5], min: 0, max: 1, soft: true,
      help: 'Where the impact struck.',
    },
    param.radius({ default: 0.25, min: 0.005, max: 1, help: 'Larger values widen the crater; the rim lies this far from the center.' }),
    param.height({ name: 'depth', label: 'Depth', default: 0.2, help: 'Larger values sink the floor further below the ground the impact struck.' }),
    param.height({ name: 'rim', label: 'Rim height', default: 0.07, max: 0.25, help: 'Larger values raise the rim further above the ground around the crater.' }),
    {
      kind: 'float', name: 'peak', label: 'Central peak', unit: 'ratio', default: 0.4, min: 0, max: 1,
      help: 'Larger values raise a taller peak in the middle, flatten the floor around it and step the walls, as in large craters; 0 leaves a plain bowl.',
    },
    {
      kind: 'float', name: 'ejecta', label: 'Ejecta', unit: 'ratio', default: 0.5, min: 0, max: 1,
      help: 'Larger values throw rougher streaks and hummocks of debris out around the rim.',
    },
    param.height({ default: 0.5, label: 'Ground level', help: 'The height of the level ground the crater is cut into when no terrain is connected.' }),
    param.strength({
      name: 'flatten', label: 'Flatten',
      help: 'Larger values wipe out more of a connected terrain inside the rim, down to the slope the crater lies on; 0 only adds the crater to it.',
    }),
    param.seed(),
  ],
  kernels: [crater],
  async evaluate(ctx) {
    const { center, peak, ejecta, height, flatten } = ctx.params;
    const radius = Math.max(ctx.params.radius, 1e-4);
    const depth = Math.max(ctx.params.depth, 0);
    const src = ctx.input('in');
    // The ground the impact struck. On a connected terrain it is the plane that fits the terrain under the crater.
    const ground = src && flatten > 0 ? groundAt(await readCoarse(ctx, src), center[0], center[1], radius, 1.5 * depth) : levelGround(height);
    const out = ctx.alloc('field');
    ctx.run(crater, {
      in: { src },
      out: { out },
      params: {
        center,
        invRadius: 1 / radius,
        level: height,
        ground: ground.height,
        tilt: [ground.slopeX, ground.slopeY],
        flatten: flatten * ground.known,
        // The profile is that of a crater of depth 1; the rim is a part of the depth. Without depth only a rim is left.
        depth: Math.max(depth, 1e-4),
        rim: Math.max(ctx.params.rim, 0) / Math.max(depth, 1e-4),
        peak: depth > 0 ? peak : 0,
        ejecta,
      },
    });
    ctx.output('out', out);
  },
});
