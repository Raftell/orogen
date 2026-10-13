// src/core/nodes/generate/crater-field.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { landRandom } from './_land.ts';
import { generateLandCrater, groundAt, levelGround, readCoarse, type CoarseTerrain } from './_land-crater.ts';

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
  var old = select(P.level, src_at(px), src_bound());   // what the impacts so far have left of the old terrain
  var added = 0.0;                                       // what they have added to it
  let n = min(craters_len() / 3u, MAX_CRATERS);
  // The table is in the order of the impacts, oldest first: each wipes out what the earlier ones left inside its rim.
  for (var i = 0u; i < MAX_CRATERS; i++) {
    if (i >= n) { break; }
    let place = craters_item(3u * i);          // centre, 1 / radius, depth
    let d = (uv - place.xy) * place.z;
    let r0 = length(d);
    if (r0 >= REACH) { continue; }
    let shape = craters_item(3u * i + 1u);     // rim and central peak as parts of the depth, the crater's own place in the noise
    let lie = craters_item(3u * i + 2u);       // the ground the impact struck: its height under the centre, its slope, how well it is known
    let ray = d / max(r0, 1.0e-6);
    let r = r0 * (1.0 + 0.07 * noise_gradient(ray * 1.7 + shape.zw, seedFor(1u)));
    let keep = generateLandCrater_keep(r);
    added = added * keep + place.w * (generateLandCrater_profile(r, shape.x, shape.y, REACH, 0.03 * shape.z) + generateLandCrater_mound(r0, shape.y));
    // Inside the rim the old terrain gives way to the plane of the ground the impact struck.
    let plane = lie.x + dot(lie.yz, uv - place.xy);
    old = generateLandCrater_strike(old, plane, place.w, keep, P.flatten * lie.w);
  }
  return old + added;
}`,
});

/**
 * `count` impacts in the order they struck, as the kernel's table: (x, y, 1 / radius, depth), (rim, central
 * peak, noise offset x, y) and (height of the ground under the centre, its slope x, y, how well it is known) for each. Small craters
 * far outnumber large ones. Large craters are deeper, though shallower for their width, and have central peaks;
 * an old crater is worn, with less depth and a lower rim. Without a terrain the ground is level.
 */
function impacts(seed: number, count: number, radiusMin: number, radiusMax: number, depth: number, level: number, terrain: CoarseTerrain | null): Float32Array<ArrayBuffer> {
  const random = landRandom(seed, 1);
  const table = new Float32Array(count * 12);
  const span = 1 - (radiusMin / radiusMax) ** SIZE_LAW;
  for (let i = 0; i < count; i++) {
    const radius = radiusMin * (1 - random() * span) ** (-1 / SIZE_LAW);
    const size = radius / radiusMax;
    const fresh = 0.35 + 0.65 * random();
    const big = Math.min(Math.max((size - 0.45) / 0.4, 0), 1);
    // Centres lie a little beyond the terrain too, so that craters cross its borders.
    const x = -0.05 + 1.1 * random(), y = -0.05 + 1.1 * random();
    const deep = depth * size ** 0.75 * fresh;
    const ground = terrain ? groundAt(terrain, x, y, radius, 1.5 * deep) : levelGround(level);
    table.set([
      x, y, 1 / radius, deep,
      0.3 * (0.5 + 0.5 * fresh), 0.4 * big * big * (3 - 2 * big), 64 * random(), 64 * random(),
      ground.height, ground.slopeX, ground.slopeY, ground.known,
    ], i * 12);
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
    param.height({ default: 0.5, label: 'Ground level', help: 'The height of the level ground the craters are cut into when no terrain is connected.' }),
    param.strength({
      name: 'flatten', label: 'Flatten',
      help: 'Larger values wipe out more of a connected terrain inside each rim, down to the slope the crater lies on; 0 only adds the craters to it.',
    }),
    param.seed(),
  ],
  kernels: [craterField],
  async evaluate(ctx) {
    const { count, height, flatten } = ctx.params;
    const radiusMin = Math.min(Math.max(ctx.params.radiusMin, 1e-4), 4);
    const radiusMax = Math.min(Math.max(ctx.params.radiusMax, radiusMin), 4);
    const src = ctx.input('in');
    const terrain = src && flatten > 0 ? await readCoarse(ctx, src) : null;
    const table = impacts(ctx.seed, count, radiusMin, radiusMax, Math.max(ctx.params.depth, 0), height, terrain);
    // Every crater costs a texel a table read and a distance. One that reaches the texel costs two more reads, a
    // noise and its profile, and a crater reaches the part of the terrain within 2.5 of its radii.
    let reaching = 0;
    for (let i = 0; i < count; i++) reaching += Math.min(Math.PI * (2.5 / table[i * 12 + 2]!) ** 2, 1);
    const out = ctx.alloc('field');
    ctx.run(craterField, {
      in: { src },
      out: { out },
      params: { level: height, flatten },
      luts: { craters: ctx.lut(table, 'vec4f') },
      cost: 16 + 2 * count + 28 * reaching,
    });
    ctx.output('out', out);
  },
});
