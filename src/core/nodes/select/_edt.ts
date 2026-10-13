// src/core/nodes/select/_edt.ts
// The distance from every texel to the edge of a mask, for select/distance and select/edge.
//
// The edge is where the mask crosses 0.5, and it lies between texels: on the line from a texel on one side to
// its neighbour on the other, where the two values, taken as a straight line, are 0.5; and from one such
// crossing straight to the next, through the cell of four texels they lie around. A mask with a soft edge
// places it there to a fraction of a texel, and a hard one half-way between the texels of its two sides.
//
// Each texel beside the edge starts with the nearest crossing, and a jump flood carries the crossings across
// the grid: in pass after pass every texel takes, of the points its eight neighbours at a halving distance
// hold, the one nearest to itself. A last pass measures from each texel to the edge itself, in the cells around
// the crossing it was given.
//
// Why a flood on the GPU and not the exact transform of ref/distance on the CPU. Correct: the transform is
// exact for an edge that runs through texels, which moves by up to a cell between a preview and a build and
// puts steps of a texel into every soft band laid along it; this measures to the edge between them, and the
// tests hold it to the distance from every piece of that edge, tried one by one: it is that distance on all
// but a texel in 200, and there an eighth of a texel too long at most. Affordable: at 8129 the
// transform is 66 million texels through one thread, twice for the two sides of the edge, with 264 MB read
// back and written again, seconds in which a preview does not follow the hand; the flood is 16 passes of 9
// loads and stays on the GPU. Its state is two fields of two channels, 1.06 GB at 8129.
import { defineKernel, type Field, type OpContext } from '../../api.ts';

/** What a texel holds that has no point of the edge yet: far outside any terrain. */
const NONE = -1e6;
/** The distance of a texel when the mask has no edge at all. */
export const NO_EDGE = -1;

const seed = defineKernel({
  name: 'select/edt.seed',
  inputs: { src: { kind: 'field', saturate: true } },
  outputs: { out: 'vec2' },
  cost: 5,
  code: /* wgsl */ `
const NONE = ${NONE};

// How far along the line from the texel to its neighbour q the mask crosses 0.5, 0 to 1; 2 where it does not.
fn crossing(m: f32, q: vec2i) -> f32 {
  if (!inGrid(q)) { return 2.0; }
  let n = src_at(q);
  if ((m >= 0.5) == (n >= 0.5)) { return 2.0; }
  // The two values lie on different sides of 0.5, so they differ.
  return saturate((0.5 - m) / (n - m));
}

fn compute(px: vec2i, uv: vec2f) -> vec2f {
  let m = src_at(px);
  var best = 2.0;
  var towards = vec2i(0);
  var offsets = array<vec2i, 4>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1));
  for (var i = 0; i < 4; i++) {
    let t = crossing(m, px + offsets[i]);
    if (t < best) {
      best = t;
      towards = offsets[i];
    }
  }
  if (best > 1.0) { return vec2f(NONE); }
  return vec2f(px) + best * vec2f(towards);
}`,
});

const flood = defineKernel({
  name: 'select/edt.flood',
  inputs: { src: 'vec2' },
  outputs: { out: 'vec2' },
  params: { jump: 'i32' },
  cost: 9,
  code: /* wgsl */ `
const NONE = ${NONE};

fn compute(px: vec2i, uv: vec2f) -> vec2f {
  let here = vec2f(px);
  var best = src_at(px);
  var nearest = 1e30;
  if (best.x > 0.5 * NONE) { nearest = dot(best - here, best - here); }
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = px + vec2i(i, j) * P.jump;
      if ((i == 0 && j == 0) || !inGrid(q)) { continue; }
      let point = src_at(q);
      if (point.x <= 0.5 * NONE) { continue; }
      let d = dot(point - here, point - here);
      if (d < nearest) {
        nearest = d;
        best = point;
      }
    }
  }
  return best;
}`,
});

// The distance from each texel to the edge, in texels, or NO_EDGE where the mask has none. The flood gave the
// texel a crossing near the nearest piece of the edge; here every piece in the nine cells around that crossing
// is measured, as the straight line it is from one crossing to the next.
const measure = defineKernel({
  name: 'select/edt.measure',
  inputs: { src: { kind: 'field', saturate: true }, points: 'vec2' },
  outputs: { out: 'field' },
  cost: 17,
  code: /* wgsl */ `
const NONE = ${NONE};
const NO_EDGE = ${NO_EDGE}.0;

// Where the mask crosses 0.5 from a corner of value a to one of value b, 0 to 1. The two lie on different sides.
fn along(a: f32, b: f32) -> f32 {
  return saturate((0.5 - a) / (b - a));
}

// The squared distance from p to the line from a to b.
fn toLine(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let t = saturate(dot(p - a, ab) / max(dot(ab, ab), 1e-12));
  let d = p - (a + t * ab);
  return dot(d, d);
}

// The squared distance from p to the edge inside the cell whose corner with the lowest coordinates is c and
// whose four corners have the values v00, v10, v01 and v11; 1e30 where no edge crosses the cell.
fn inCell(p: vec2f, c: vec2f, v00: f32, v10: f32, v01: f32, v11: f32) -> f32 {
  let i00 = v00 >= 0.5;
  let i10 = v10 >= 0.5;
  let i01 = v01 >= 0.5;
  let i11 = v11 >= 0.5;
  // The crossings on the four sides of the cell, in the order low y, high x, high y, low x.
  var side = array<vec2f, 4>();
  var crossed = array<bool, 4>(i00 != i10, i10 != i11, i01 != i11, i00 != i01);
  if (crossed[0]) { side[0] = c + vec2f(along(v00, v10), 0.0); }
  if (crossed[1]) { side[1] = c + vec2f(1.0, along(v10, v11)); }
  if (crossed[2]) { side[2] = c + vec2f(along(v01, v11), 1.0); }
  if (crossed[3]) { side[3] = c + vec2f(0.0, along(v00, v01)); }
  if (crossed[0] && crossed[1] && crossed[2] && crossed[3]) {
    // Opposite corners lie on the same side: the edge passes the cell twice. Which corners it cuts off is
    // decided by the middle of the cell, the mean of the four.
    let middle = 0.25 * (v00 + v10 + v01 + v11) >= 0.5;
    if (middle == i00) { return min(toLine(p, side[0], side[1]), toLine(p, side[2], side[3])); }
    return min(toLine(p, side[0], side[3]), toLine(p, side[1], side[2]));
  }
  // Otherwise two sides are crossed, or none.
  var first = vec2f(0.0);
  var found = 0;
  for (var i = 0; i < 4; i++) {
    if (!crossed[i]) { continue; }
    if (found == 1) { return toLine(p, first, side[i]); }
    first = side[i];
    found = 1;
  }
  return 1e30;
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let point = points_at(px);
  if (point.x <= 0.5 * NONE) { return NO_EDGE; }
  // The sixteen texels around the cell the crossing lies in, read once. Reads clamp at the border, where a
  // texel repeated has no edge between it and itself.
  let base = vec2i(floor(point)) - vec2i(1);
  var m = array<f32, 16>();
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) { m[4 * j + i] = src_at(base + vec2i(i, j)); }
  }
  let p = vec2f(px);
  var nearest = 1e30;
  for (var j = 0; j < 3; j++) {
    for (var i = 0; i < 3; i++) {
      let k = 4 * j + i;
      nearest = min(nearest, inCell(p, vec2f(base + vec2i(i, j)), m[k], m[k + 1], m[k + 4], m[k + 5]));
    }
  }
  // The crossing itself is on the edge: the edge is never farther than it.
  return sqrt(min(nearest, dot(point - p, point - p)));
}`,
});

/** The kernels `edgeDistance` runs; a node that calls it lists them. */
export const edtKernels = [seed, flood, measure] as const;

/**
 * For every texel the distance to the mask's edge, in texels: a new field the caller releases. A texel holds
 * NO_EDGE, which is below 0, when the mask has no edge at all.
 */
export async function edgeDistance(ctx: OpContext, mask: Field<'field'>): Promise<Field<'field'>> {
  // All state is allocated before the loop.
  let points = ctx.alloc('vec2');
  let next = ctx.alloc('vec2');
  const out = ctx.alloc('field');
  ctx.run(seed, { in: { src: mask }, out: { out: points } });

  // The jumps halve from half the grid down to one texel, after a first pass of one texel that gives every
  // texel beside the edge the points of its neighbours; two more passes at the end, of two texels and of one,
  // mend what the halving left to a farther point than the nearest.
  const jumps: number[] = [1];
  for (let jump = 2 ** Math.max(Math.ceil(Math.log2(Math.max(ctx.res - 1, 2))) - 1, 0); jump >= 1; jump /= 2) jumps.push(jump);
  jumps.push(2, 1);
  await ctx.loop(jumps.length, (i) => {
    ctx.run(flood, { in: { src: points }, out: { out: next }, params: { jump: jumps[i]! } });
    [points, next] = [next, points];
  });
  ctx.release(next);
  ctx.run(measure, { in: { src: mask, points }, out: { out } });
  ctx.release(points);
  return out;
}
