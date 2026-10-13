// src/core/nodes/generate/canyon.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateLand, landRandom, SegmentList } from './_land.ts';

/** Drainage nodes per side of the lattice the network is grown on: at most this many, whatever the size. */
const MAX_SIDE = 14;
/** The constant bound of the kernel's loop over the canyon reaches: a tree on the lattice has one less than its nodes. */
const MAX_SEGMENTS = MAX_SIDE * MAX_SIDE;
/** The hard maximum of `levels`. */
const MAX_LEVELS = 16;
const GULLY_OCTAVES = 5;

const canyon = defineKernel({
  name: 'generate/canyon',
  outputs: { out: 'field' },
  params: { size: 'f32', plateau: 'f32', depth: 'f32', levels: 'f32', erosion: 'f32' },
  luts: { reaches: 'vec4f' },
  includes: [generateLand],
  code: /* wgsl */ `
const MAX_SEGMENTS = ${MAX_SEGMENTS}u;
const GULLY_OCTAVES = ${GULLY_OCTAVES};
// The flat floor takes this part of a canyon's half width; the walls climb over the rest.
const FLOOR = 0.22;
// The warps that make the straight reaches wind: their sizes as multiples of the spacing, and how far they move a point.
const BROAD_SIZE = 1.7;
const BROAD = 0.55;
const FINE_SIZE = 0.45;
const FINE = 0.15;
// How sharply the slopes of two canyons are told apart where their walls meet, in parts of the depth.
const CRISP = 40.0;
// How far the edge of a bed may lie from where even beds would put it, in beds.
const UNEVEN = 0.7;

// Where bed k begins, in beds below the plateau. The first begins at the rim and the last ends on the floor of
// the main canyon; the edges between are uneven, as beds of different thickness are.
fn bedTop(k: f32) -> f32 {
  if (k < 0.5 || k > P.levels - 0.5) { return k; }
  return k + UNEVEN * (hash_unit(hash_cell(vec2i(i32(k), 0), seedFor(6u))) - 0.5);
}

// The wall of a canyon, from how deep it is cut (0 at the rim, 1 on the floor of the main canyon) to the same
// with the beds in it. Each bed is a cliff of hard rock over a slope of the debris and soft rock below it, and the
// beds lie level under the whole plateau: every canyon steps at the same heights. Hard beds make tall cliffs
// and short slopes, soft ones the opposite.
fn stepped(cut: f32) -> f32 {
  let x = clamp(cut, 0.0, 1.0) * P.levels;
  var k = min(floor(x), P.levels - 1.0);
  var lo = bedTop(k);
  var hi = bedTop(k + 1.0);
  if (x < lo) {
    k -= 1.0;
    hi = lo;
    lo = bedTop(k);
  } else if (x >= hi && k < P.levels - 1.5) {
    k += 1.0;
    lo = hi;
    hi = bedTop(k + 1.0);
  }
  let t = saturate((x - lo) / max(hi - lo, 1.0e-6));
  let hard = hash_unit2(hash_cell(vec2i(i32(k), 1), seedFor(6u)));
  let run = mix(0.16, 0.3, hard.x);        // the part of the bed's width its cliff takes
  let fall = mix(0.55, 0.85, hard.y);      // the part of the bed's thickness its cliff takes
  let cliff = smoothstep(0.0, run, t);
  let slope = saturate((t - 0.5 * run) / (1.0 - 0.5 * run));
  return (lo + (hi - lo) * (fall * cliff + (1.0 - fall) * slope)) / P.levels;
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // The reaches of the network are straight; warping the plane makes the canyons wind, broadly and in small bends.
  let ax = generateLand_fbmD(uv / (BROAD_SIZE * P.size) + vec2f(2.3, 6.1), seedFor(1u), 2, 0.5);
  let ay = generateLand_fbmD(uv / (BROAD_SIZE * P.size) + vec2f(39.5, 17.8), seedFor(2u), 2, 0.5);
  let bx = generateLand_fbmD(uv / (FINE_SIZE * P.size) + vec2f(8.9, 1.2), seedFor(3u), 2, 0.5);
  let by = generateLand_fbmD(uv / (FINE_SIZE * P.size) + vec2f(14.3, 24.7), seedFor(4u), 2, 0.5);
  let p = uv + P.size * (BROAD * vec2f(ax.x, ay.x) + FINE * vec2f(bx.x, by.x));
  let shiftX = BROAD / BROAD_SIZE * ax.yz + FINE / FINE_SIZE * bx.yz;   // the gradient of the shift's x, per unit of uv
  let shiftY = BROAD / BROAD_SIZE * ay.yz + FINE / FINE_SIZE * by.yz;
  // Alcoves and buttresses: the rim swings in and out along the walls.
  let scallop = 1.0 + 0.3 * generateLand_fbmD(p / (0.22 * P.size) + vec2f(5.5, 3.1), seedFor(5u), 3, 0.55).x;

  // How deep the canyons cut here, as a part of the depth: 0 on the plateau, 1 on the floor of the main canyon.
  // Each reach has a flat floor and walls that climb straight to the rim; where reaches meet the deepest cut
  // wins. The slope of the cut is the mean of the reaches' slopes, weighted towards the deepest: where the walls
  // of two canyons meet in a divide the slopes oppose each other, and the mean says so.
  let n = min(reaches_len() / 2u, MAX_SEGMENTS);
  var cut = 0.0;
  var total = 0.0;
  var slope = vec2f(0.0);
  var steepness = 0.0;
  var wall = 0.0;
  var bottom = 0.0;
  for (var i = 0u; i < MAX_SEGMENTS; i++) {
    if (i >= n) { break; }
    let ends = reaches_item(2u * i);
    let ab = ends.zw - ends.xy;
    let ap = p - ends.xy;
    let t = saturate(dot(ap, ab) / max(dot(ab, ab), 1.0e-12));
    let off = ap - ab * t;
    let dist = length(off);
    let form = reaches_item(2u * i + 1u);      // half width at either end, depth at either end
    let half = mix(form.x, form.y, t) * scallop;
    let down = saturate((1.0 - dist / half) / (1.0 - FLOOR));
    if (down <= 0.0) { continue; }
    let deep = mix(form.z, form.w, t);
    let c = deep * down;
    if (c > cut) {
      // The weights are relative to the deepest cut so far: a deeper one rescales what was gathered.
      let rescale = exp(CRISP * (cut - c));
      total *= rescale;
      slope *= rescale;
      steepness *= rescale;
      wall *= rescale;
      bottom *= rescale;
      cut = c;
    }
    let w = exp(CRISP * (c - cut));
    let steep = select(0.0, deep / ((1.0 - FLOOR) * half), down < 1.0);
    total += w;
    slope -= w * steep * off / max(dist, 1.0e-9);
    steepness += w * steep;
    wall += w * down * (1.0 - down);
    bottom += w * smoothstep(0.8, 1.0, down);
  }

  var carved = cut;
  if (total > 0.0 && P.erosion > 0.0) {
    // Side gullies run down the walls. They are cut into the depth of the cut before the beds are laid into it,
    // so that cliffs and benches swing in and out around every gully, as they do around the alcoves.
    let dp = slope / total;                                        // per unit of p, towards the deeper cut
    let duv = dp + shiftX * dp.x + shiftY * dp.y;
    // Gullies belong to the walls: they fade towards the rim and the floor, and on a divide between two canyons.
    let oneWay = smoothstep(0.5, 0.9, length(slope) / max(steepness, 1.0e-9));
    let onWall = saturate(4.0 * wall / total);
    let cutAway = generateLand_erode(uv / P.size, -cut, -duv * P.size, 0.16, P.erosion * oneWay * onWall, GULLY_OCTAVES, -0.5, 0.5, seedFor(7u));
    carved = clamp(-cutAway.x, 0.0, 1.0);
  }
  // The beds show in the walls. A floor is smooth: where it falls along its canyon it would otherwise step too.
  let steps = mix(stepped(carved), carved, select(0.0, bottom / total, total > 0.0));

  // The plateau is not quite level: it rolls gently, and less so near a rim.
  let roll = 0.035 * generateLand_fbmD(mix(uv, p, 0.6) / (1.3 * P.size) + vec2f(9.7, 4.2), seedFor(8u), 5, 0.42).x;
  return P.plateau - P.depth * steps + roll * (1.0 - 0.7 * saturate(steps * 4.0));
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
  const fed = new Uint8Array(count);      // nodes a canyon comes down to: every other upper end is the head of its canyon
  for (let k = 1; k < order.length; k++) {
    const from = order[k]!;
    if (main[from] || carries[from]! >= least) {
      reaches.push({ from, to: next[from]! });
      fed[next[from]!] = 1;
    }
  }

  // Width and depth grow with what a canyon carries. The measure is the most that any canyon carries on the
  // terrain itself: the outlet lies beyond its border.
  let most = 1;
  for (const { from } of reaches) {
    if (xs[from]! >= 0 && xs[from]! <= 1 && ys[from]! >= 0 && ys[from]! <= 1) most = Math.max(most, carries[from]!);
  }
  const share = (node: number): number => Math.min(carries[node]! / (0.5 * most), 1);
  const halfWidth = (node: number): number => 0.5 * width * (0.35 + 0.65 * share(node) ** 0.5);
  const depth = (node: number): number => 0.3 + 0.7 * share(node) ** 0.4;
  const list = new SegmentList();
  for (const { from, to } of reaches) {
    if (fed[from]) {
      list.add(xs[from]!, ys[from]!, xs[to]!, ys[to]!, halfWidth(from), halfWidth(to), depth(from), depth(to));
      continue;
    }
    // The head of a canyon: it ends somewhere along its uppermost reach, in an alcove smaller than the canyon below.
    const reach = 0.3 + 0.6 * random(), less = 0.6 + 0.3 * random();
    list.add(
      xs[to]! + (xs[from]! - xs[to]!) * reach, ys[to]! + (ys[from]! - ys[to]!) * reach, xs[to]!, ys[to]!,
      halfWidth(from) * less, halfWidth(to), depth(from) * less, depth(to),
    );
  }
  return list;
}

export default defineNode({
  type: 'generate/canyon',
  title: 'Canyon',
  category: 'generate',
  description: 'Generates a plateau cut by winding canyons that branch upstream, with flat floors and walls of cliffs and benches.',
  keywords: ['gorge', 'ravine', 'mesa', 'plateau', 'badlands', 'drainage'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.size({ label: 'Spacing', default: 0.2, min: 0.1, max: 1, help: 'Larger values set the canyons further apart and make their bends broader.' }),
    param.height({ name: 'depth', label: 'Depth', default: 0.55, help: 'Larger values cut the main canyon deeper below the plateau.' }),
    {
      kind: 'float', name: 'width', label: 'Width', unit: 'length', default: 0.2, min: 0.01, max: 0.5, soft: true,
      help: 'Larger values widen the main canyon from rim to rim; side canyons are narrower, and narrowest at their heads.',
    },
    {
      kind: 'float', name: 'branching', label: 'Branching', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values let smaller side canyons cut back into the plateau; 0 leaves the main canyon alone.',
    },
    {
      kind: 'int', name: 'levels', label: 'Terraces', default: 4, min: 1, max: MAX_LEVELS,
      help: 'How many beds of rock the walls of the main canyon step down through, each a cliff above a bench.',
    },
    {
      kind: 'float', name: 'erosion', label: 'Erosion', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values cut deeper side gullies into the walls, which scallop the cliffs and benches.',
    },
    param.seed(),
  ],
  kernels: [canyon],
  evaluate(ctx) {
    const { branching, levels, erosion } = ctx.params;
    const size = Math.min(Math.max(ctx.params.size, 0.02), 4);
    const depth = Math.min(Math.max(ctx.params.depth, 0), 1);
    const list = network(ctx.seed, size, Math.min(Math.max(ctx.params.width, 0.001), 2), branching);
    const out = ctx.alloc('field');
    ctx.run(canyon, {
      out: { out },
      // The plateau and the floor of the main canyon lie the same distance above and below the middle height.
      params: { size, plateau: 0.5 + 0.5 * depth, depth, levels, erosion },
      luts: { reaches: ctx.lut(list.table(), 'vec4f') },
      // Two table reads and a distance a reach, sixteen octaves of noise for the warps, the alcoves and the plateau,
      // and the gullies.
      cost: 3 * Math.min(list.count, MAX_SEGMENTS) + 128 + 30 * GULLY_OCTAVES,
    });
    ctx.output('out', out);
  },
});
