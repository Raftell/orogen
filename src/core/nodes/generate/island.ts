// src/core/nodes/generate/island.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateLand, landRandom, SegmentList } from './_land.ts';
import { GULLY_OCTAVES, MASSIF_PARAMS, massifCost, massifValues, massifWgsl } from './_land-massif.ts';

const TAU = 2 * Math.PI;

const island = defineKernel({
  name: 'generate/island',
  outputs: { out: 'field', water: 'field' },
  params: { invRadius: 'f32', axis: 'vec2f', coast: 'f32', height: 'f32', sea: 'f32', erosion: 'f32', ...MASSIF_PARAMS },
  luts: { crest: 'vec4f' },
  includes: [generateLand],
  code: /* wgsl */ `
const GULLY_OCTAVES = ${GULLY_OCTAVES};
// How far from the terrain's border the land must end, and how fast it is pushed under towards the border.
const BORDER = 0.04;
const BORDER_PUSH = 6.0;
const LOBE_SIZE = 0.8;
const LOBES = 3.6;
const COVE_SIZE = 3.1;
const COVES = 0.36;
// How far the high ground pushes the shore out and the valleys between its ridges let the sea in.
const HEADLANDS = 1.3;
// With an irregular coast the island is longer along its divide than across it, by this much at the most.
const STRETCH = 0.4;
// The height of the lowland behind the shore, the distance inland over which it rises to that, and the distance
// over which the ground comes up from the waterline: a beach before low ground, a cliff before a ridge.
const LOWLAND = 0.1;
const LOWLAND_REACH = 0.45;
const BEACH = 0.07;
// The least that any land stands above the waterline once it is behind its beach, a skerry included.
const DRY = 0.004;
const HILL_SIZE = 2.3;
// The sea deepens over this distance from the shore.
const SHELF = 0.5;
${massifWgsl}
fn compute(px: vec2i, uv: vec2f) -> Out {
  // The island's own frame: the middle of the terrain at the origin, the unbroken shore 1 away.
  let q = (uv - vec2f(0.5)) * P.invRadius;
  let m = massifAt(q);

  // The shore is where a field that is positive on land and negative in the sea passes 0. It falls with the
  // distance from the middle; broad noise pushes it in and out, into bays and headlands; the high ground holds
  // the sea off and the valleys between its ridges let it in, so that bays lie at the mouths of valleys; and
  // fine noise near the shore adds coves and points.
  let lobes = generateLand_fbmD(q * LOBE_SIZE + vec2f(3.7, 9.1), seedFor(6u), 3, 0.5);
  let coves = generateLand_fbmD(q * COVE_SIZE + vec2f(13.1, 2.3), seedFor(7u), 4, 0.55);
  let stretch = 1.0 + STRETCH * P.coast;
  let along = dot(q, P.axis) / stretch;
  let across = dot(q, vec2f(-P.axis.y, P.axis.x)) * stretch;
  let r = length(vec2f(along, across));
  let dr = (along / stretch * P.axis + across * stretch * vec2f(-P.axis.y, P.axis.x)) / max(r, 1.0e-6);
  // Past the unbroken shore the land gives way faster, so that headlands stay headlands.
  let beyond = max(r - 1.0, 0.0);
  let dome = 1.0 - r - 0.6 * beyond * beyond;
  let ddome = -(1.0 + 1.2 * beyond) * dr;
  // Low ground already tells a ridge from a valley, and a summit holds the sea off no more than a ridge does.
  let high = m.x / (m.x + 0.07);
  let dhigh = 0.07 / ((m.x + 0.07) * (m.x + 0.07)) * m.yz;
  let broad = dome + P.coast * (LOBES * lobes.x + HEADLANDS * (high - 0.45));
  let dbroad = ddome + P.coast * (LOBES * LOBE_SIZE * lobes.yz + HEADLANDS * dhigh);
  // The fine detail belongs to the shore: inland it fades, and out at sea sooner, where the seabed is smooth.
  // It moves the shore by a distance, however steeply the broad field passes 0 there: the field is measured
  // in distances by its own slope. That slope's own change is left out of the slope of the detail.
  let steep = clamp(length(dbroad), 0.6, 6.0);
  let away = broad / steep;
  let width = select(0.16, 0.03, broad < 0.0);
  let near = exp(-away * away / width);
  let shore = broad + P.coast * COVES * near * steep * coves.x;
  let dshore = dbroad + P.coast * COVES * near * steep * COVE_SIZE * coves.yz;
  // No land reaches the border of the terrain: towards it the sea always wins.
  let side = min(uv, vec2f(1.0) - uv);
  let border = min(side.x, side.y);
  let inward = select(vec2f(0.0, select(-1.0, 1.0, uv.y < 0.5)), vec2f(select(-1.0, 1.0, uv.x < 0.5), 0.0), side.x < side.y) / P.invRadius;
  let edge = BORDER_PUSH * (border - BORDER);
  let blend = max(0.3 - abs(shore - edge), 0.0) / 0.3;
  let f = min(shore, edge) - 0.075 * blend * blend;
  let share = select(0.5 * blend, 1.0 - 0.5 * blend, shore < edge);   // the part of f's slope that is the land's
  let df = share * dshore + (1.0 - share) * BORDER_PUSH * inward;

  var land = 0.0;
  if (f > 0.0) {
    // Behind the shore the ground rises to a rolling lowland, and the massif stands on that.
    let inland = max(broad, 0.0);
    let reach = exp(-inland / LOWLAND_REACH);
    let hills = generateLand_fbmD(q * HILL_SIZE + vec2f(41.3, 7.9), seedFor(8u), 5, 0.5);
    let low = LOWLAND * (1.0 - reach) * (1.0 + 0.45 * hills.x);
    let dlow = LOWLAND * (reach / LOWLAND_REACH * (1.0 + 0.45 * hills.x) * select(vec2f(0.0), dbroad, broad > 0.0) + (1.0 - reach) * 0.45 * HILL_SIZE * hills.yz);
    let body = low + (1.0 - 1.6 * LOWLAND) * m.x + DRY;
    let dbody = dlow + (1.0 - 1.6 * LOWLAND) * m.yz;
    // The ground comes up from the waterline: where the lowland meets the sea that is a beach, and where a
    // ridge does, a cliff.
    let dry = exp(-f / BEACH);
    let h = body * (1.0 - dry);
    let g = dbody * (1.0 - dry) + body * dry / BEACH * df;
    // On the lowland the slopes are faint and turn every way: gullies begin where the ground has a fall to follow.
    let fall = smoothstep(0.02, 0.3, length(g));
    let carved = generateLand_erode(q, h, g, 0.3, P.erosion * m.w * fall, GULLY_OCTAVES, 0.3, 0.5, seedFor(5u));
    // A gully is never cut down to the sea: what is cut below the ground is taken as a part of its height.
    let cut = carved.x - h;
    land = min(select(h * exp(cut / max(h, 1.0e-9)), h + cut, cut >= 0.0), 1.0);
  }
  // The seabed: a shelf that deepens away from the shore, never below height 0. A texel of the sea lies below
  // the sea level by a part of it that float32 can tell from none, so that the mask and the heights agree.
  let depth = P.sea * max(1.0 - exp(min(f, 0.0) / SHELF), 2.0e-7);
  return Out(select(P.sea + P.height * land, P.sea - depth, f < 0.0), select(0.0, 1.0, f < 0.0));
}`,
});

/** A spur: two segments that leave (x, y) at `angle` and descend from `height` towards the shore, with a side branch. */
function spur(list: SegmentList, random: () => number, x: number, y: number, height: number, angle: number, length: number): void {
  const bend = angle + 0.8 * (random() - 0.5);
  const mx = x + Math.cos(angle) * length * 0.5, my = y + Math.sin(angle) * length * 0.5;
  const ex = mx + Math.cos(bend) * length * 0.5, ey = my + Math.sin(bend) * length * 0.5;
  const mid = height * (0.45 + 0.15 * random());
  list.add(x, y, mx, my, height, mid);
  list.add(mx, my, ex, ey, mid, height * 0.12);
  const fork = angle + (bend > angle ? -1 : 1) * (0.7 + 0.5 * random());
  const reach = length * (0.3 + 0.25 * random());
  list.add(mx, my, mx + Math.cos(fork) * reach, my + Math.sin(fork) * reach, mid, mid * 0.2);
}

/**
 * The crests of an island's high ground in the island's own frame, where the unbroken shore is 1 from the
 * origin: a divide that winds across the middle through three to five peaks, the highest at height 1, with
 * spurs that run down towards the shore on both sides.
 */
function crests(seed: number): { list: SegmentList; turn: number } {
  const random = landRandom(seed, 1);
  const list = new SegmentList();
  const count = 3 + Math.floor(random() * 3);
  const turn = random() * TAU;
  const ax = Math.cos(turn), ay = Math.sin(turn);
  const half = 0.42 + 0.14 * random();
  const spacing = (2 * half) / count;

  const peaks: { x: number; y: number; h: number }[] = [];
  let highest = 0;
  for (let i = 0; i < count; i++) {
    const along = -half + (i + 0.5 + 0.5 * (random() - 0.5)) * spacing;
    const across = 0.3 * (random() - 0.5);
    const h = (0.6 + 0.4 * Math.sin(Math.PI * (i + 0.5) / count)) * (0.65 + 0.35 * random());
    highest = Math.max(highest, h);
    peaks.push({ x: ax * along - ay * across, y: ay * along + ax * across, h });
  }
  for (const peak of peaks) peak.h /= highest;

  // Beyond its last peaks the divide runs down towards the shore.
  const first = peaks[0]!, last = peaks[count - 1]!;
  for (const [end, way] of [[first, turn + Math.PI], [last, turn]] as const) {
    spur(list, random, end.x, end.y, end.h, way + 0.7 * (random() - 0.5), 0.5 + 0.25 * random());
  }
  for (let i = 0; i < count; i++) {
    const peak = peaks[i]!;
    for (const side of [1, -1]) {
      const angle = turn + side * (Math.PI / 2 + 0.9 * (random() - 0.5));
      spur(list, random, peak.x, peak.y, peak.h, angle, 0.6 + 0.35 * random());
    }
    if (i + 1 === count) break;
    const next = peaks[i + 1]!;
    const t = 0.35 + 0.3 * random();
    const bow = 0.2 * (random() - 0.5);
    const saddle = {
      x: peak.x + (next.x - peak.x) * t - ay * bow,
      y: peak.y + (next.y - peak.y) * t + ax * bow,
      h: Math.min(peak.h, next.h) * (0.6 + 0.25 * random()),
    };
    list.add(peak.x, peak.y, saddle.x, saddle.y, peak.h, saddle.h);
    list.add(saddle.x, saddle.y, next.x, next.y, saddle.h, next.h);
    const side = random() < 0.5 ? 1 : -1;
    spur(list, random, saddle.x, saddle.y, saddle.h, turn + side * (Math.PI / 2 + 0.6 * (random() - 0.5)), 0.5 + 0.3 * random());
  }
  return { list, turn };
}

export default defineNode({
  type: 'generate/island',
  title: 'Island',
  category: 'generate',
  description: 'Generates an island of ridges, valleys and lowland behind a shore of bays and headlands at sea level, and marks the sea.',
  keywords: ['coast', 'shore', 'archipelago', 'atoll', 'landmass', 'sea'],
  inputs: [],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'water', type: 'field', role: 'mask' },
  ],
  params: [
    param.size({ label: 'Island width', default: 0.7, min: 0.05, max: 2, help: 'Larger values spread the land over more of the terrain; the borders stay under water.' }),
    {
      kind: 'float', name: 'coast', label: 'Coast irregularity', unit: 'ratio', default: 0.45, min: 0, max: 1,
      help: 'Larger values cut deeper bays, push out longer headlands and break off small islands; 0 gives a round island.',
    },
    param.height({ default: 0.65, help: 'Larger values raise the high ground further above sea level.' }),
    {
      kind: 'float', name: 'erosion', label: 'Erosion', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values cut deeper gullies from the ridges down to the shore.',
    },
    param.seed(),
  ],
  kernels: [island],
  uses: ['seaLevel'],
  evaluate(ctx) {
    const { size, coast, height, erosion } = ctx.params;
    const { list, turn } = crests(ctx.seed);
    const out = ctx.alloc('field');
    const water = ctx.wants('water') ? ctx.alloc('field') : null;
    ctx.run(island, {
      out: { out, water },
      params: {
        invRadius: 2 / Math.max(size, 0.001),
        axis: [Math.cos(turn), Math.sin(turn)],
        coast,
        // Land never lies below the sea: the water mask and the heights must agree.
        height: Math.max(height, 0),
        // The seabed lies between the sea level and height 0: a sea level outside 0..1 is taken at the nearer end.
        sea: Math.min(Math.max(ctx.setting('seaLevel'), 0), 1),
        erosion,
        ...massifValues({ meeting: 4, pinned: false, sharpness: 0.5, ridges: 0.8 }),
      },
      luts: { crest: ctx.lut(list.table(), 'vec4f') },
      // The massif and its gullies, and twelve octaves of noise for the shore and the lowland.
      cost: massifCost(list) + 96,
    });
    ctx.output('out', out);
    if (water) ctx.output('water', water);
  },
});
