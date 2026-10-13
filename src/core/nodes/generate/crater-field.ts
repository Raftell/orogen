// src/core/nodes/generate/crater-field.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { landRandom } from './_land.ts';
import { generateLandCrater } from './_land-crater.ts';

/** The constant bound of the kernel's loop over the craters, and the hard maximum of `count`. */
const MAX_CRATERS = 512;
/** The number of craters wider than r falls as r to the power of minus this. */
const SIZE_LAW = 1.4;

const craterField = defineKernel({
  name: 'generate/crater-field',
  inputs: { src: { kind: 'field', default: 0 } },
  outputs: { out: 'field' },
  params: { level: 'f32', flatten: 'f32' },
  luts: { craters: 'vec4f' },
  includes: [generateLandCrater],
  code: /* wgsl */ `
const MAX_CRATERS = ${MAX_CRATERS}u;
// A crater's ejecta ends this many radii from its centre: farther texels skip the crater.
const REACH = 2.5;

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // Without a terrain to stamp into, the ground is level.
  let ground = select(P.level, src_at(px), src_bound());
  let n = min(craters_len() / 2u, MAX_CRATERS);
  var added = 0.0;   // what the impacts so far have added to the ground
  var kept = 1.0;    // how much of the old terrain they have left
  // The table is in the order of the impacts, oldest first: each wipes out what the earlier ones left inside its rim.
  for (var i = 0u; i < MAX_CRATERS; i++) {
    if (i >= n) { break; }
    let place = craters_item(2u * i);          // centre, 1 / radius, depth
    let d = (uv - place.xy) * place.z;
    let r0 = length(d);
    if (r0 >= REACH) { continue; }
    let shape = craters_item(2u * i + 1u);     // rim and central peak as parts of the depth, the crater's own place in the noise
    let ray = d / max(r0, 1.0e-6);
    let r = r0 * (1.0 + 0.07 * noise_gradient(ray * 1.7 + shape.zw, seedFor(1u)));
    let keep = generateLandCrater_keep(r);
    added = added * keep + place.w * (generateLandCrater_profile(r, shape.x, shape.y, REACH) + generateLandCrater_mound(r0, shape.y));
    kept *= mix(1.0, keep, P.flatten);
  }
  return P.level + (ground - P.level) * kept + added;
}`,
});

/**
 * `count` impacts in the order they struck, as the kernel's table: (x, y, 1 / radius, depth) and
 * (rim, central peak, noise offset x, y) for each. Small craters far outnumber large ones. Large craters are deeper, though shallower for their width, and have
 * central peaks; an old crater is worn, with less depth and a lower rim.
 */
function impacts(seed: number, count: number, radiusMin: number, radiusMax: number, depth: number): Float32Array<ArrayBuffer> {
  const random = landRandom(seed, 1);
  const table = new Float32Array(count * 8);
  const span = 1 - (radiusMin / radiusMax) ** SIZE_LAW;
  for (let i = 0; i < count; i++) {
    const radius = radiusMin * (1 - random() * span) ** (-1 / SIZE_LAW);
    const size = radius / radiusMax;
    const fresh = 0.35 + 0.65 * random();
    const big = Math.min(Math.max((size - 0.45) / 0.4, 0), 1);
    table.set([
      // Centres lie a little beyond the terrain too, so that craters cross its borders.
      -0.05 + 1.1 * random(), -0.05 + 1.1 * random(), 1 / radius, depth * size ** 0.75 * fresh,
      0.3 * (0.5 + 0.5 * fresh), 0.4 * big * big * (3 - 2 * big), 64 * random(), 64 * random(),
    ], i * 8);
  }
  return table;
}

export default defineNode({
  type: 'generate/crater-field',
  title: 'Crater Field',
  category: 'generate',
  description: 'Stamps many impact craters of varied size and age into the terrain, the younger ones over the older.',
  keywords: ['impact', 'meteor', 'moon', 'lunar', 'bombardment', 'craters'],
  inputs: [{ name: 'in', type: 'field', optional: true }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'int', name: 'count', label: 'Craters', default: 160, min: 1, max: MAX_CRATERS,
      help: 'How many impacts struck the terrain.',
    },
    param.radius({ name: 'radiusMin', label: 'Smallest radius', default: 0.015, min: 0.002, max: 0.5, help: 'The radius of the smallest craters, which are the most numerous.' }),
    param.radius({ name: 'radiusMax', label: 'Largest radius', default: 0.18, min: 0.002, max: 0.5, help: 'The radius of the largest craters, which are rare.' }),
    param.height({ name: 'depth', label: 'Depth', default: 0.18, help: 'Larger values deepen every crater; this is the depth of a fresh crater of the largest radius.' }),
    param.height({
      default: 0.5, label: 'Ground level',
      help: 'The height of the ground the craters are cut into: the level of the terrain when none is connected, and the level a connected terrain is flattened to inside each rim.',
    }),
    param.strength({
      name: 'flatten', label: 'Flatten', default: 0.8,
      help: 'Larger values wipe out more of a connected terrain inside each rim; 0 only adds the craters to it.',
    }),
    param.seed(),
  ],
  kernels: [craterField],
  evaluate(ctx) {
    const { count, height, flatten } = ctx.params;
    const radiusMin = Math.min(Math.max(ctx.params.radiusMin, 1e-4), 4);
    const radiusMax = Math.min(Math.max(ctx.params.radiusMax, radiusMin), 4);
    const table = impacts(ctx.seed, count, radiusMin, radiusMax, Math.max(ctx.params.depth, 0));
    // Every crater costs a texel a table read and a distance. One that reaches the texel costs a second read, a
    // noise and its profile, and a crater reaches the part of the terrain within 2.5 of its radii.
    let reaching = 0;
    for (let i = 0; i < count; i++) reaching += Math.min(Math.PI * (2.5 / table[i * 8 + 2]!) ** 2, 1);
    const out = ctx.alloc('field');
    ctx.run(craterField, {
      in: { src: ctx.input('in') },
      out: { out },
      params: { level: height, flatten },
      luts: { craters: ctx.lut(table, 'vec4f') },
      cost: 16 + 2 * count + 24 * reaching,
    });
    ctx.output('out', out);
  },
});
