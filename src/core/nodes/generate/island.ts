// src/core/nodes/generate/island.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateLand } from './_land.ts';

const GULLY_OCTAVES = 7;

const island = defineKernel({
  name: 'generate/island',
  outputs: { out: 'field', water: 'field' },
  params: { invRadius: 'f32', coast: 'f32', height: 'f32', sea: 'f32', erosion: 'f32' },
  includes: [generateLand],
  code: /* wgsl */ `
const GULLY_OCTAVES = ${GULLY_OCTAVES};
// How far from the terrain's border the land must end, and how fast it is pushed under towards the border.
const BORDER = 0.04;
const BORDER_PUSH = 6.0;
// Inland the ground rises as (s / (s + RISE_REACH))^RISE_POWER of the distance s from the smooth shore.
const RISE_REACH = 0.5;
const RISE_POWER = 1.5;
const LOBE_SIZE = 0.85;
const COVE_SIZE = 3.3;
const RELIEF_SIZE = 1.5;
const LOWLAND = 0.04;

fn compute(px: vec2i, uv: vec2f) -> Out {
  // The island's own frame: the middle of the terrain at the origin, the unbroken shore 1 away.
  let q = (uv - vec2f(0.5)) * P.invRadius;
  let r = length(q);

  // Two fields that are positive on land and negative in the sea. The smooth one falls with the distance from
  // the middle while broad noise pushes it in and out, into bays and headlands; the land's height follows it.
  // The shore itself follows the detailed one, which adds coves, points and skerries.
  let lobes = generateLand_fbmD(q * LOBE_SIZE + vec2f(3.7, 9.1), seedFor(1u), 3, 0.5);
  let coves = generateLand_fbmD(q * COVE_SIZE + vec2f(13.1, 2.3), seedFor(4u), 4, 0.5);
  let side = min(uv, vec2f(1.0) - uv);
  let border = min(side.x, side.y);
  let inward = select(vec2f(0.0, select(-1.0, 1.0, uv.y < 0.5)), vec2f(select(-1.0, 1.0, uv.x < 0.5), 0.0), side.x < side.y) / P.invRadius;
  // Past the unbroken shore the land gives way faster, so that headlands stay headlands.
  let beyond = max(r - 1.0, 0.0);
  let smoothLand = 1.0 - r - 0.6 * beyond * beyond + P.coast * 2.4 * lobes.x;
  let dsmooth = -(1.0 + 1.2 * beyond) * q / max(r, 1.0e-6) + P.coast * 2.4 * LOBE_SIZE * lobes.yz;
  // The detail belongs to the shore: out at sea it fades, and the seabed is smooth.
  let t = saturate((smoothLand + 0.55) / 0.4);
  let inshore = t * t * (3.0 - 2.0 * t);
  let detailed = smoothLand + P.coast * 0.45 * inshore * coves.x;
  let ddetailed = dsmooth * (1.0 + P.coast * 0.45 * coves.x * 6.0 * t * (1.0 - t) / 0.4) + P.coast * 0.45 * inshore * COVE_SIZE * coves.yz;
  // No land reaches the border of the terrain: towards it the sea always wins.
  let edge = BORDER_PUSH * (border - BORDER);
  let dedge = BORDER_PUSH * inward;
  let blend = max(0.3 - abs(detailed - edge), 0.0) / 0.3;
  let f = min(detailed, edge) - 0.075 * blend * blend;
  let share = select(0.5 * blend, 1.0 - 0.5 * blend, detailed < edge);   // the part of f's slope that is the land's
  let df = share * ddetailed + (1.0 - share) * dedge;

  var land = 0.0;
  if (f > 0.0) {
    // The rise from the smooth shore, which starts a little out to sea so that points and near skerries share it.
    let inland = max(smoothLand + 0.1, 0.0);
    let ratio = max(inland / (inland + RISE_REACH), 1.0e-6);
    let rise = pow(ratio, RISE_POWER) / 0.6;
    let drise = RISE_POWER * pow(ratio, RISE_POWER - 1.0) * RISE_REACH / ((inland + RISE_REACH) * (inland + RISE_REACH)) / 0.6;
    // The high ground, which a third noise gathers into a few massifs.
    let relief = generateLand_fbmD(q * RELIEF_SIZE + vec2f(41.3, 7.9), seedFor(2u), 2, 0.5);
    let m = 1.7 * relief.x;
    let peak = 0.5 + 0.5 * m / sqrt(1.0 + m * m);
    let dpeak = (0.5 * 1.7 * RELIEF_SIZE / pow(1.0 + m * m, 1.5)) * relief.yz;
    let high = 0.2 + 0.8 * peak * peak;
    // The beach: the height comes up from the waterline of the detailed shore, and a little way inland the
    // shore's detail no longer shows in it.
    let dry = exp(-f / 0.09);
    let beach = 1.0 - dry;
    let dbeach = dry / 0.09;
    // LOWLAND is the height every piece of land comes up to, a skerry far from the smooth shore included.
    let h = (rise * high + LOWLAND) * beach;
    let g = drise * high * beach * dsmooth + rise * 1.6 * peak * beach * dpeak + (rise * high + LOWLAND) * dbeach * df;
    let carved = generateLand_erode(q, h, g, 0.26, P.erosion, GULLY_OCTAVES, 0.3, 0.5, seedFor(3u));
    land = clamp(carved.x, 0.0, 1.0);
  }
  // The seabed: a shelf that deepens away from the shore, never below height 0.
  let depth = P.sea * (1.0 - exp(min(f, 0.0) / 0.55));
  return Out(P.sea + P.height * land - depth, select(0.0, 1.0, f < 0.0));
}`,
});

export default defineNode({
  type: 'generate/island',
  title: 'Island',
  category: 'generate',
  description: 'Generates an island with bays and headlands whose shore lies at sea level, and marks the sea around it.',
  keywords: ['coast', 'shore', 'archipelago', 'atoll', 'landmass', 'sea'],
  inputs: [],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'water', type: 'field', role: 'mask' },
  ],
  params: [
    param.size({ label: 'Island width', default: 0.6, min: 0.05, max: 2, help: 'Larger values spread the land over more of the terrain; the borders stay under water.' }),
    {
      kind: 'float', name: 'coast', label: 'Coast irregularity', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values cut deeper bays, push out longer headlands and break off small islands.',
    },
    param.height({ default: 0.65, help: 'Larger values raise the high ground further above sea level.' }),
    {
      kind: 'float', name: 'erosion', label: 'Erosion', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values cut deeper valleys from the high ground down to the shore.',
    },
    param.seed(),
  ],
  kernels: [island],
  uses: ['seaLevel'],
  evaluate(ctx) {
    const { size, coast, height, erosion } = ctx.params;
    const out = ctx.alloc('field');
    const water = ctx.wants('water') ? ctx.alloc('field') : null;
    ctx.run(island, {
      out: { out, water },
      params: {
        invRadius: 2 / Math.max(size, 0.001),
        coast,
        // Land never lies below the sea: the water mask and the heights must agree.
        height: Math.max(height, 0),
        // The seabed lies between the sea level and height 0: a sea level outside 0..1 is taken at the nearer end.
        sea: Math.min(Math.max(ctx.setting('seaLevel'), 0), 1),
        erosion,
      },
      cost: 64 + 30 * GULLY_OCTAVES,
    });
    ctx.output('out', out);
    if (water) ctx.output('water', water);
  },
});
