// src/core/nodes/filter/grow-shrink.ts
import { defineKernel, defineNode, param, type Field, type Lut } from '../../api.ts';

/** The widest disc one pass of the disc kernel holds, in texels: its rim is read between lattice points up to 4.4 texels out, 61 loads. */
const MAX_STEP = 3;
const REACH = 4;
const SIDE = 2 * REACH + 1;
const RIM = 32;

// The directions of the rim, every 11.25 degrees: a set that is its own mirror image and its own transpose.
const snap = (v: number): string => (Math.abs(v) < 1e-12 ? 0 : v).toFixed(9);
const RIM_DIRECTIONS = Array.from({ length: RIM }, (_, k) => `vec2f(${snap(Math.cos((2 * Math.PI * k) / RIM))}, ${snap(Math.sin((2 * Math.PI * k) / RIM))})`).join(', ');

// One dilation by a disc of up to 3 texels: the highest point within a radius. The terrain between texels is its
// bilinear surface, whose highest point in a disc is a texel inside it or lies on its rim; so the lattice points
// within the radius and 32 points on the rim are looked at, and a radius of a fraction of a texel works as well
// as a whole one. An erosion is the dilation of the terrain turned upside down (sign -1). Reads clamp to the border.
const disc = defineKernel({
  name: 'filter/grow-shrink.disc',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { radius: 'f32', sign: 'f32' },
  cost: 61 + RIM,
  code: /* wgsl */ `
const REACH = ${REACH};
const SIDE = ${SIDE};
const RIM = ${RIM};
const RIM_DIRECTIONS = array<vec2f, RIM>(${RIM_DIRECTIONS});

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let radius = clamp(P.radius, 0.0, ${MAX_STEP}.0);
  let centre = P.sign * src_at(px);
  // What the rim reads lies within the radius and a texel's diagonal: 61 lattice points at most.
  let loaded = min((radius + 1.5) * (radius + 1.5), 19.4);
  // Heights are kept as differences from the centre: a flat terrain stays flat bit for bit.
  var rise: array<f32, ${SIDE * SIDE}>;
  var best = 0.0;
  for (var j = -REACH; j <= REACH; j++) {
    for (var i = -REACH; i <= REACH; i++) {
      let d2 = f32(i * i + j * j);
      if (d2 > loaded) { continue; }
      let r = P.sign * src_at(px + vec2i(i, j)) - centre;
      rise[(j + REACH) * SIDE + i + REACH] = r;
      if (d2 <= radius * radius) { best = max(best, r); }
    }
  }
  for (var k = 0; k < RIM; k++) {
    let q = radius * RIM_DIRECTIONS[k];
    let cell = floor(q);
    let f = q - cell;
    let at = (i32(cell.y) + REACH) * SIDE + i32(cell.x) + REACH;
    best = max(best, mix(mix(rise[at], rise[at + 1], f.x), mix(rise[at + SIDE], rise[at + SIDE + 1], f.x), f.y));
  }
  return P.sign * (centre + best);
}`,
});

/** The texels one pass of the points kernel reads beside the centre: 61 loads, within the 64 of engine.md 3.15. */
const MAX_POINTS = 60;

// One dilation by a set of texels: the highest of the texels at the given offsets, and of the centre. It reads
// texels only, so that a sharp edge stays as sharp as it was, and serves two shapes. A small disc of texels
// widens the disc before it by its own radius. A ring of radius r widens a disc of radius a >= r to the disc
// of radius a + r: every such pass doubles the radius, so that any radius is a handful of passes.
const points = defineKernel({
  name: 'filter/grow-shrink.points',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { sign: 'f32' },
  luts: { offsets: 'vec4f' },      // xy: the offset of a texel of the set
  cost: MAX_POINTS + 1,
  code: /* wgsl */ `
const MAX_POINTS = ${MAX_POINTS}u;

fn compute(px: vec2i, uv: vec2f) -> f32 {
  var best = P.sign * src_at(px);
  let count = min(offsets_len(), MAX_POINTS);
  for (var k = 0u; k < count; k++) {
    best = max(best, P.sign * src_at(px + vec2i(offsets_item(k).xy)));
  }
  return P.sign * best;
}`,
});

/** The loads of one texel of the disc kernel at a radius of `radius` texels. */
function discLoads(radius: number): number {
  const loaded = Math.min((radius + 1.5) ** 2, 19.4);
  let n = 0;
  for (let j = -REACH; j <= REACH; j++) for (let i = -REACH; i <= REACH; i++) if (i * i + j * j <= loaded) n++;
  return n;
}

type Point = readonly [number, number];

/** The texels within sqrt(`limit`) of the centre, without it: a disc as texels make it. */
function latticeDisc(limit: number): Point[] {
  const out: Point[] = [];
  for (let j = -REACH; j <= REACH; j++) for (let i = -REACH; i <= REACH; i++) if ((i !== 0 || j !== 0) && i * i + j * j <= limit) out.push([i, j]);
  return out;
}

/**
 * A ring: for each of 60 points spread evenly on a circle of `radius` texels, one of the texels around it, each
 * texel once. `turned`: the points lie half the angle between two further on. `byRadius`: of the four texels
 * around a point the one nearest to the circle is taken, else the one nearest to the point.
 */
function latticeRing(radius: number, turned: boolean, byRadius: boolean): Point[] {
  const seen = new Set<string>();
  const out: Point[] = [];
  for (let k = 0; k < MAX_POINTS; k++) {
    const angle = (2 * Math.PI * (k + (turned ? 0.5 : 0))) / MAX_POINTS;
    const x = radius * Math.cos(angle), y = radius * Math.sin(angle);
    let p: Point = [Math.round(x), Math.round(y)];
    if (byRadius) {
      for (const candidate of [[Math.floor(x), Math.floor(y)], [Math.ceil(x), Math.floor(y)], [Math.floor(x), Math.ceil(y)], [Math.ceil(x), Math.ceil(y)]] as const) {
        if (Math.abs(Math.hypot(...candidate) - radius) < Math.abs(Math.hypot(...p) - radius) - 1e-9) p = candidate;
      }
    }
    const key = `${p[0]},${p[1]}`;
    if (seen.has(key) || (p[0] === 0 && p[1] === 0)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** How far a set of texels reaches from the centre, on average over all directions: the radius of the disc it stands for. */
function meanReach(set: readonly Point[]): number {
  const directions = 360;
  let sum = 0;
  for (let t = 0; t < directions; t++) {
    const angle = (2 * Math.PI * t) / directions;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let best = 0;
    for (const [x, y] of set) best = Math.max(best, x * ux + y * uy);
    sum += best;
  }
  return sum / directions;
}

/** How far discs of radius `inner` around the texels of a ring reach from the centre: the mean over all directions, and the spread between them. */
function ringReach(set: readonly Point[], inner: number): { mean: number; spread: number } {
  const directions = 120;
  let sum = 0, lo = Infinity, hi = -Infinity;
  for (let t = 0; t < directions; t++) {
    const angle = (2 * Math.PI * t) / directions;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let best = inner;
    for (const [x, y] of set) {
      const across = x * uy - y * ux;
      if (Math.abs(across) <= inner) best = Math.max(best, x * ux + y * uy + Math.sqrt(inner * inner - across * across));
    }
    sum += best;
    lo = Math.min(lo, best);
    hi = Math.max(hi, best);
  }
  return { mean: sum / directions, spread: hi - lo };
}

/**
 * The ring of about `radius` texels that widens a disc of `inner` texels most evenly, of the four that
 * latticeRing makes, and the radius it adds on average. Texels do not lie on a circle: the widened disc is out
 * of round by half a texel to a texel, whatever its size.
 */
function bestRing(radius: number, inner: number): { set: Point[]; adds: number } {
  let best: { set: Point[]; adds: number; spread: number } | null = null;
  for (const turned of [false, true]) {
    for (const byRadius of [false, true]) {
      const set = latticeRing(radius, turned, byRadius);
      const { mean, spread } = ringReach(set, inner);
      if (best === null || spread < best.spread) best = { set, adds: mean - inner, spread };
    }
  }
  return best!;
}

// The two discs of texels: 61 texels reaching 4.12 on average (4 along the axes, 4.24 along the diagonals), and
// 21 reaching 2.17.
const LARGE = latticeDisc(18);
const SMALL = latticeDisc(5);
const LARGE_REACH = meanReach(LARGE);
const SMALL_REACH = meanReach(SMALL);

/** Up to this radius, in texels, a disc is made without rings. */
const BASE_MAX = 12;
/** The radius of a ring as a share of the radius it completes: just under half, so that the ring lies inside the disc it widens. */
const RING_SHARE = 0.48;

interface Plan {
  readonly rim: number;                            // the radius of the one pass of the disc kernel, in texels: 0..3
  readonly sets: readonly (readonly Point[])[];    // then the passes of the points kernel, smallest first
}

/**
 * The passes that make a disc of `total` texels. Sets of texels have the radii texels allow, so they are chosen
 * first, from the widest inwards, and each takes off the radius what it adds on average: the rings, each just
 * under half of what is still to make, down to 12 texels; then discs of texels. What is left, up to 3 texels and
 * a fraction, is the disc kernel's, which is exact to the fraction. It is the only pass that reads between
 * texels: an edge that was sharp is one texel softer afterwards, whatever the radius.
 */
function plan(total: number): Plan {
  const sets: Point[][] = [];
  let left = total;
  for (let guard = 0; left > BASE_MAX && guard < 16; guard++) {
    const ring = bestRing(RING_SHARE * left, (1 - RING_SHARE) * left);
    sets.unshift(ring.set);
    left -= ring.adds;
  }
  const large = Math.max(0, Math.floor((left - 0.5) / LARGE_REACH));
  left -= large * LARGE_REACH;
  const small = left > MAX_STEP;
  if (small) left -= SMALL_REACH;
  for (let i = 0; i < large; i++) sets.unshift(LARGE);
  if (small) sets.unshift(SMALL);
  return { rim: left, sets };
}

// Dilations (1) and erosions (-1), in the order they run.
const SEQUENCE = { grow: [1], shrink: [-1], open: [-1, 1], close: [1, -1] } as const;

export default defineNode({
  type: 'filter/grow-shrink',
  title: 'Grow / Shrink',
  category: 'filter',
  description: 'Widens the high or the low ground of a terrain or a mask by a radius, or removes what is narrower than it.',
  keywords: ['dilate', 'erode', 'morphology', 'expand', 'contract', 'inflate'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'grow',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'grow', label: 'Grow' },
        { value: 'shrink', label: 'Shrink' },
        { value: 'open', label: 'Open' },
        { value: 'close', label: 'Close' },
      ],
      help: 'Grow widens peaks and ridges, shrink widens pits and valleys. Open removes peaks narrower than the radius, close fills pits narrower than it.',
    },
    // Hard limits: the window of a pass is 61 texels, and a radius is made of one pass that is exact to a fraction
    // of a texel, up to three of a disc of texels and a ring for every doubling beyond 12 texels: ten passes at
    // this maximum at 8129.
    param.radius({
      default: 0.01, min: 0.0005, max: 0.05, soft: false,
      help: 'How far the high or the low ground is widened. In open and close, the width of what is removed.',
    }),
  ],
  kernels: [disc, points],
  maskable: true,
  async evaluate(ctx) {
    const src = ctx.input('in');
    const texels = ctx.lengthToPx(ctx.params.radius);
    // Within a quarter of a texel the highest point is the texel itself, to a quarter of its slope.
    if (texels < 0.25) {
      ctx.output('out', src);
      return;
    }
    const { rim, sets } = plan(texels);
    const signs = SEQUENCE[ctx.params.mode];
    // The disc kernel first, on the terrain as it came; with a radius of next to nothing it is left out.
    const rims = rim >= 0.05 ? 1 : 0;
    const perSign = rims + sets.length;
    const rimCost = discLoads(rim) + RIM;
    // A table cannot be made inside the loop: one for every set, before it.
    const tables: Lut<'vec4f'>[] = sets.map((set) => ctx.lut(new Float32Array(set.flatMap(([x, y]) => [x, y, 0, 0])), 'vec4f'));

    const targets = [ctx.alloc('field'), perSign * signs.length > 1 ? ctx.alloc('field') : null];
    let current: Field<'field'> = src;
    await ctx.loop(perSign * signs.length, (i) => {
      const out = targets[i % 2]!;
      const sign = signs[Math.floor(i / perSign)]!;
      const step = i % perSign;
      if (step < rims) {
        ctx.run(disc, { in: { src: current }, out: { out }, params: { radius: rim, sign }, cost: rimCost });
      } else {
        const offsets = tables[step - rims]!;
        ctx.run(points, { in: { src: current }, out: { out }, params: { sign }, luts: { offsets }, cost: offsets.length + 1 });
      }
      current = out;
    }, { preview: () => ({ out: current }) });
    for (const target of targets) if (target && target !== current) ctx.release(target);
    ctx.output('out', current);
  },
});
