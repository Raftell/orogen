// src/core/nodes/generate/canyon.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateLand, landRandom, SegmentList } from './_land.ts';

/** Drainage nodes per side of the lattice the network is grown on: at most this many, whatever the size. */
const MAX_SIDE = 14;
/** The constant bound of the kernel's loop over the canyon reaches: a tree on the lattice has one less than its nodes. */
const MAX_SEGMENTS = MAX_SIDE * MAX_SIDE;
/** The hard maximum of `levels`. */
const MAX_LEVELS = 16;

const canyon = defineKernel({
  name: 'generate/canyon',
  outputs: { out: 'field' },
  params: { size: 'f32', plateau: 'f32', depth: 'f32', levels: 'f32' },
  luts: { reaches: 'vec4f' },
  includes: [generateLand],
  code: /* wgsl */ `
const MAX_SEGMENTS = ${MAX_SEGMENTS}u;
// The flat floor takes this part of a canyon's width; the walls climb over the rest.
const FLOOR = 0.3;
// Of each wall terrace, this part of the climb is bench and the rest cliff; and how far the wall is stepped at all.
const BENCH = 0.62;
const STEPPED = 0.9;

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // The reaches of the network are straight; warping the plane makes the canyons wind, broadly and in small bends.
  let broad = generateLand_warp(uv / (1.7 * P.size) + vec2f(2.3, 6.1), seedFor(1u), 2);
  let fine = generateLand_warp(uv / (0.45 * P.size) + vec2f(8.9, 1.2), seedFor(2u), 2);
  let p = uv + P.size * (0.55 * broad + 0.12 * fine);
  // Alcoves and side gullies: the rim swings in and out along the walls.
  let scallop = 1.0 + 0.3 * noise_fbm(p / (0.22 * P.size) + vec2f(5.5, 3.1), seedFor(3u), 3, 2.0, 0.55);

  // How deep the canyons cut here, as a part of the depth: 0 on the plateau, 1 on the floor of the main canyon.
  // Each reach has a flat floor and walls that climb straight to the rim; where reaches meet the deepest cut wins.
  let n = min(reaches_len() / 2u, MAX_SEGMENTS);
  var cut = 0.0;
  var wall = 0.0;    // how far up the wall of that deepest cut: 0 at the rim and beyond, 1 on the floor
  for (var i = 0u; i < MAX_SEGMENTS; i++) {
    if (i >= n) { break; }
    let ends = reaches_item(2u * i);
    let form = reaches_item(2u * i + 1u);      // half width at either end, depth at either end
    let near = generateLand_segment(p, ends.xy, ends.zw);
    let x = near.x / (mix(form.x, form.y, near.y) * scallop);
    let down = saturate((1.0 - x) / (1.0 - FLOOR));
    let c = mix(form.z, form.w, near.y) * down;
    if (c > cut) {
      cut = c;
      wall = down;
    }
  }

  // The walls climb in terraces: benches on the soft beds, cliffs in the hard ones. The beds lie level under the
  // whole plateau, so every canyon steps at the same heights, and a shallow side canyon floors on a bench.
  // The edges of the beds are ragged: on the walls, and only there, fine noise moves each step back and forth.
  let ragged = noise_fbm(uv / (0.06 * P.size) + vec2f(7.4, 2.8), seedFor(5u), 4, 2.0, 0.55);
  let climb = clamp(cut * P.levels + 0.5 * ragged * wall * (1.0 - wall), 0.0, P.levels);
  let bed = floor(climb);
  let stepped = (bed + smoothstep(BENCH, 1.0, climb - bed)) / P.levels;
  let carved = mix(cut, stepped, STEPPED);

  // The plateau is not quite level: it rolls gently, and less so near a rim.
  let roll = 0.035 * noise_fbm(uv / (1.3 * P.size) + vec2f(9.7, 4.2), seedFor(4u), 4, 2.0, 0.5);
  return P.plateau - P.depth * carved + roll * (1.0 - 0.7 * saturate(carved * 4.0));
}`,
});

interface Reach { readonly from: number; readonly to: number }

/**
 * A drainage network as the kernel's table: reaches (ax, ay, bx, by) with (half width at a, at b, depth at a,
 * at b), widths as fractions of the terrain and depths as parts of the full depth.
 *
 * Nodes stand on a jittered lattice of the given spacing that extends past the terrain. The network is the tree
 * of cheapest paths from every node to an outlet on the lattice's border, over edges of random cost: paths
 * share their lower courses, which makes it dendritic, and no two reaches cross. A reach carries the number
 * of nodes that drain through it; the more it carries, the wider and deeper its canyon. `branching` sets how
 * little a reach may carry and still be a canyon: 0 keeps the main canyon alone, 1 every reach.
 */
function network(seed: number, spacing: number, width: number, branching: number): SegmentList {
  const random = landRandom(seed, 1);
  const margin = 0.2;
  const side = Math.min(Math.max(Math.ceil((1 + 2 * margin) / spacing) + 1, 3), MAX_SIDE);
  const step = (1 + 2 * margin) / (side - 1);
  const count = side * side;

  const xs = new Float64Array(count), ys = new Float64Array(count);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      xs[j * side + i] = -margin + (i + 0.7 * (random() - 0.5)) * step;
      ys[j * side + i] = -margin + (j + 0.7 * (random() - 0.5)) * step;
    }
  }

  // Edges: along the rows and columns, and one diagonal in every cell, so that no two edges cross.
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  const costs: number[][] = Array.from({ length: count }, () => []);
  const link = (a: number, b: number): void => {
    const cost = Math.hypot(xs[a]! - xs[b]!, ys[a]! - ys[b]!) * (0.5 + random());
    neighbours[a]!.push(b);
    costs[a]!.push(cost);
    neighbours[b]!.push(a);
    costs[b]!.push(cost);
  };
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const at = j * side + i;
      if (i + 1 < side) link(at, at + 1);
      if (j + 1 < side) link(at, at + side);
      if (i + 1 < side && j + 1 < side) {
        if (random() < 0.5) link(at, at + side + 1);
        else link(at + 1, at + side);
      }
    }
  }

  // The outlet: a node in the middle part of one border of the lattice.
  const along = 1 + Math.floor(random() * (side - 2));
  const border = Math.floor(random() * 4);
  const outlet = border === 0 ? along : border === 1 ? (side - 1) * side + along : border === 2 ? along * side : along * side + side - 1;

  // Cheapest paths to the outlet (Dijkstra over at most MAX_SIDE^2 nodes, by scanning).
  const far = new Float64Array(count).fill(Infinity);
  const next = new Int32Array(count).fill(-1);
  const settled = new Uint8Array(count);
  const order: number[] = [];
  far[outlet] = 0;
  for (let round = 0; round < count; round++) {
    let best = -1;
    for (let k = 0; k < count; k++) if (!settled[k] && (best < 0 || far[k]! < far[best]!)) best = k;
    if (best < 0 || far[best] === Infinity) break;
    settled[best] = 1;
    order.push(best);
    const around = neighbours[best]!;
    for (let e = 0; e < around.length; e++) {
      const other = around[e]!;
      const through = far[best]! + costs[best]![e]!;
      if (!settled[other] && through < far[other]!) {
        far[other] = through;
        next[other] = best;
      }
    }
  }

  // What drains through each node: itself and everything upstream. Nodes are visited from the farthest inwards.
  const carries = new Float64Array(count).fill(1);
  for (let k = order.length - 1; k > 0; k--) carries[next[order[k]!]!]! += carries[order[k]!]!;

  // The main canyon: from the outlet upstream, always into the tributary that carries the most.
  const main = new Uint8Array(count);
  const upstream: number[][] = Array.from({ length: count }, () => []);
  for (let k = 1; k < order.length; k++) upstream[next[order[k]!]!]!.push(order[k]!);
  for (let at = outlet, guard = 0; guard < count; guard++) {
    main[at] = 1;
    let most = -1;
    for (const up of upstream[at]!) if (most < 0 || carries[up]! > carries[most]!) most = up;
    if (most < 0) break;
    at = most;
  }

  // A reach is a canyon when enough drains through its upper end.
  const least = Math.max(1, Math.round(count ** ((1 - Math.min(Math.max(branching, 0), 1)) ** 2)));
  const reaches: Reach[] = [];
  for (let k = 1; k < order.length; k++) {
    const from = order[k]!;
    if (main[from] || carries[from]! >= least) reaches.push({ from, to: next[from]! });
  }

  // Width and depth grow with what a canyon carries, and a canyon begins at its head with a part of both.
  // The measure is the most that any canyon carries on the terrain itself: the outlet lies beyond its border.
  let most = 1;
  for (const { from } of reaches) {
    if (xs[from]! >= 0 && xs[from]! <= 1 && ys[from]! >= 0 && ys[from]! <= 1) most = Math.max(most, carries[from]!);
  }
  const share = (node: number): number => Math.min(carries[node]! / (0.5 * most), 1);
  const halfWidth = (node: number): number => 0.5 * width * (0.3 + 0.7 * share(node) ** 0.5);
  const depth = (node: number): number => 0.4 + 0.6 * share(node) ** 0.45;
  const list = new SegmentList();
  for (const { from, to } of reaches) list.add(xs[from]!, ys[from]!, xs[to]!, ys[to]!, halfWidth(from), halfWidth(to), depth(from), depth(to));
  return list;
}

export default defineNode({
  type: 'generate/canyon',
  title: 'Canyon',
  category: 'generate',
  description: 'Generates a plateau cut by winding canyons that branch upstream, with flat floors and terraced walls.',
  keywords: ['gorge', 'ravine', 'mesa', 'plateau', 'badlands', 'drainage'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.size({ label: 'Spacing', default: 0.22, min: 0.1, max: 1, help: 'Larger values set the canyons further apart and make their bends broader.' }),
    param.height({ name: 'depth', label: 'Depth', default: 0.55, help: 'Larger values cut the main canyon deeper below the plateau.' }),
    {
      kind: 'float', name: 'width', label: 'Width', unit: 'length', default: 0.15, min: 0.01, max: 0.5, soft: true,
      help: 'Larger values widen the canyons from rim to rim; side canyons are narrower than the main one.',
    },
    {
      kind: 'float', name: 'branching', label: 'Branching', unit: 'ratio', default: 0.55, min: 0, max: 1,
      help: 'Larger values let smaller side canyons cut back into the plateau; 0 leaves the main canyon alone.',
    },
    {
      kind: 'int', name: 'levels', label: 'Terraces', default: 4, min: 1, max: MAX_LEVELS,
      help: 'How many benches the walls of the main canyon climb in.',
    },
    param.seed(),
  ],
  kernels: [canyon],
  evaluate(ctx) {
    const { branching, levels } = ctx.params;
    const size = Math.min(Math.max(ctx.params.size, 0.02), 4);
    const depth = Math.min(Math.max(ctx.params.depth, 0), 1);
    const list = network(ctx.seed, size, Math.min(Math.max(ctx.params.width, 0.001), 2), branching);
    const out = ctx.alloc('field');
    ctx.run(canyon, {
      out: { out },
      // The plateau and the floor of the main canyon lie the same distance above and below the middle height.
      params: { size, plateau: 0.5 + 0.5 * depth, depth, levels },
      luts: { reaches: ctx.lut(list.table(), 'vec4f') },
      // Two table reads a reach, and nineteen octaves of noise for the warps, the scallops, the beds and the plateau.
      cost: 2 * Math.min(list.count, MAX_SEGMENTS) + 152,
    });
    ctx.output('out', out);
  },
});
