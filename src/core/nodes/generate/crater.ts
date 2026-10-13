// src/core/nodes/generate/crater.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateLandCrater } from './_land-crater.ts';

const crater = defineKernel({
  name: 'generate/crater',
  inputs: { src: { kind: 'field', default: 0 } },
  outputs: { out: 'field' },
  params: { center: 'vec2f', invRadius: 'f32', level: 'f32', flatten: 'f32', depth: 'f32', rim: 'f32', peak: 'f32', ejecta: 'f32' },
  includes: [generateLandCrater],
  cost: 64,
  code: /* wgsl */ `
// Beyond this many radii the ejecta has thinned to nothing.
const REACH = 8.0;

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // Without a terrain to stamp into, the ground is level.
  let ground = select(P.level, src_at(px), src_bound());
  let d = (uv - P.center) * P.invRadius;
  let r0 = length(d);
  if (r0 >= REACH) { return ground; }
  let ray = d / max(r0, 1.0e-6);
  // The rim is no perfect circle: noise read around the centre moves it in and out.
  let r = r0 * (1.0 + 0.06 * noise_fbm(ray * 1.9 + vec2f(7.1, 3.3), seedFor(1u), 2, 2.0, 0.5));
  var h = generateLandCrater_profile(r, P.rim, P.peak, REACH) + generateLandCrater_mound(r0, P.peak);
  // Ejecta: streaks that run outwards from the rim, and hummocks. Noise read on a circle that widens slowly with
  // the distance is nearly the same along a ray, so it draws streaks, without a seam at any angle.
  let x = max(r, 1.0);
  let outside = smoothstep(0.95, 1.25, r) * (1.0 - smoothstep(0.6 * REACH, REACH, r));
  let streaks = noise_fbm(ray * 6.5 * (1.0 + 0.12 * log(x)) + vec2f(1.7, 9.2), seedFor(2u), 3, 2.0, 0.6);
  let hummocks = noise_fbm(d * 3.1 + vec2f(4.4, 8.8), seedFor(3u), 3, 2.0, 0.5);
  h += P.ejecta * P.rim * outside * ((0.9 * streaks + 0.5 * hummocks) / (x * x * x) + 0.5 * max(streaks, 0.0) * max(streaks, 0.0) / (x * sqrt(x)));
  // The impact wipes out what stood inside the rim: there the old terrain gives way to the ground level.
  let kept = mix(1.0, generateLandCrater_keep(r), P.flatten);
  return P.level + (ground - P.level) * kept + P.depth * h;
}`,
});

export default defineNode({
  type: 'generate/crater',
  title: 'Crater',
  category: 'generate',
  description: 'Stamps one impact crater into the terrain: a bowl with a raised rim, a central peak and a blanket of ejecta.',
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
    param.height({ name: 'rim', label: 'Rim height', default: 0.07, help: 'Larger values raise the rim further above the ground around the crater.' }),
    {
      kind: 'float', name: 'peak', label: 'Central peak', unit: 'ratio', default: 0.4, min: 0, max: 1,
      help: 'Larger values raise a taller peak in the middle and flatten the floor around it, as in large craters; 0 leaves a plain bowl.',
    },
    {
      kind: 'float', name: 'ejecta', label: 'Ejecta', unit: 'ratio', default: 0.5, min: 0, max: 1,
      help: 'Larger values throw rougher streaks and hummocks of debris out around the rim.',
    },
    param.height({
      default: 0.5, label: 'Ground level',
      help: 'The height of the ground the crater is cut into: the level of the terrain when none is connected, and the level a connected terrain is flattened to inside the rim.',
    }),
    param.strength({
      name: 'flatten', label: 'Flatten',
      help: 'Larger values wipe out more of a connected terrain inside the rim; 0 only adds the crater to it.',
    }),
    param.seed(),
  ],
  kernels: [crater],
  evaluate(ctx) {
    const { center, radius, peak, ejecta, height, flatten } = ctx.params;
    const depth = Math.max(ctx.params.depth, 0);
    const out = ctx.alloc('field');
    ctx.run(crater, {
      in: { src: ctx.input('in') },
      out: { out },
      params: {
        center,
        invRadius: 1 / Math.max(radius, 1e-4),
        level: height,
        flatten,
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
