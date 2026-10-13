// src/core/nodes/generate/volcano.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateLand } from './_land.ts';

const GULLY_OCTAVES = 7;
/** How far the noise can move the rim in or out, as a part of the crater's radius. */
const RIM_WANDER = 0.14;
/** The exponent of the flank profile: above 1 the cone is concave, steep under the rim and gentle at the foot. */
const FLANK_POWER = 1.8;

const volcano = defineKernel({
  name: 'generate/volcano',
  outputs: { out: 'field' },
  params: { center: 'vec2f', invRadius: 'f32', height: 'f32', rim: 'f32', depth: 'f32', top: 'f32', erosion: 'f32' },
  includes: [generateLand],
  code: /* wgsl */ `
const GULLY_OCTAVES = ${GULLY_OCTAVES};
const RIM_WANDER = ${RIM_WANDER};
const FLANK_POWER = ${FLANK_POWER};
// The step of the finite difference that gives the slope the gullies follow, in units of the base radius.
const STEP = 0.003;

// (height, distance from the axis as a multiple of the local rim radius) of the cone before erosion, in its own
// frame: the axis at the origin, the foot 1 away. The flank is a concave cone; the crater is a bowl that hangs
// from the flank's height at the rim, so a rim that wanders inwards stands higher. P.top is the highest the rim
// can stand, which makes the highest possible point 1.
fn cone(q0: vec2f) -> vec2f {
  // The warp makes the foot and the crater irregular; it weakens towards the axis, which keeps the crater whole.
  let r0 = dot(q0, q0);
  let q = q0 + 0.1 * (r0 / (r0 + 0.02)) * generateLand_warp(q0 * 1.7, seedFor(1u), 3);
  let r = length(q);
  let rim = P.rim * (1.0 + RIM_WANDER * noise_fbm(q * 2.6 + vec2f(17.3, 4.1), seedFor(2u), 2, 2.0, 0.5));
  let flank = select(0.0, pow(max(1.0 - r, 1.0e-6), FLANK_POWER), r < 1.0);   // exactly 0 beyond the foot
  let lip = pow(max(1.0 - rim, 1.0e-6), FLANK_POWER);
  let bowl = lip - P.depth * P.top * smoothstep(0.0, 0.7, 1.0 - r / rim);
  // The smooth minimum rounds the rim, so the slope turns across it instead of flipping.
  return vec2f(generateLand_smin(flank, bowl, 0.05 * P.top) / P.top, r / rim);
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let q = (uv - P.center) * P.invRadius;
  let c = cone(q);
  let g = vec2f(
    cone(q + vec2f(STEP, 0.0)).x - cone(q - vec2f(STEP, 0.0)).x,
    cone(q + vec2f(0.0, STEP)).x - cone(q - vec2f(0.0, STEP)).x,
  ) / (2.0 * STEP);
  // Gullies start below the rim and die out with the slope at the foot. Inside the crater the walls stay smooth.
  let outside = smoothstep(1.03, 1.4, c.y);
  let carved = generateLand_erode(q, c.x, g, 0.2, P.erosion * outside, GULLY_OCTAVES, -0.6, 0.5, seedFor(3u));
  return P.height * clamp(carved.x, 0.0, 1.0);
}`,
});

export default defineNode({
  type: 'generate/volcano',
  title: 'Volcano',
  category: 'generate',
  description: 'Generates a volcanic cone with a summit crater and gullies that run down its flanks.',
  keywords: ['cone', 'crater', 'stratovolcano', 'caldera', 'cinder cone'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'vec2', name: 'center', label: 'Center', unit: 'length', default: [0.5, 0.5], min: 0, max: 1, soft: true,
      help: 'Where the crater lies on the terrain.',
    },
    param.size({ label: 'Base width', default: 0.9, min: 0.05, max: 2, help: 'Larger values spread the cone over more of the terrain.' }),
    param.height({ default: 0.8, help: 'Larger values raise the rim of the crater.' }),
    param.size({
      name: 'craterSize', label: 'Crater width', default: 0.16, min: 0.005, max: 1,
      help: 'Larger values open a wider crater, up to a caldera that takes most of the cone.',
    }),
    param.height({ name: 'craterDepth', label: 'Crater depth', default: 0.16, help: 'Larger values sink the crater floor further below the rim.' }),
    {
      kind: 'float', name: 'erosion', label: 'Erosion', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values cut deeper gullies into the flanks.',
    },
    param.seed(),
  ],
  kernels: [volcano],
  evaluate(ctx) {
    const { center, size, height, craterSize, craterDepth, erosion } = ctx.params;
    const base = Math.max(size, 0.001);
    // The rim as a part of the base radius. A crater as wide as the cone leaves no flank: it stops short of that.
    const rim = Math.min(Math.max(craterSize, 0) / base, 0.8);
    const top = (1 - rim * (1 - RIM_WANDER)) ** FLANK_POWER;
    // The depth below the rim as a part of the height; the floor is never below the ground the cone stands on.
    const depth = height > 0 ? Math.min(Math.max(craterDepth, 0) / height, 1) : 0;
    const out = ctx.alloc('field');
    ctx.run(volcano, {
      out: { out },
      params: { center, invRadius: 2 / base, height, rim: Math.max(rim, 1e-4), depth, top, erosion },
      // Five evaluations of the cone, each a three-octave warp and a two-octave noise, and the gullies.
      cost: 5 * 64 + 30 * GULLY_OCTAVES,
    });
    ctx.output('out', out);
  },
});
