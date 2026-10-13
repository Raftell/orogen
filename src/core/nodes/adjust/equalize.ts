// src/core/nodes/adjust/equalize.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { adjust } from './_wgsl.ts';

// The heights are ranked on a sample of the field: every texel of a field up to SAMPLE_MAX a side, and of a
// larger one every 2nd, 4th, ... texel of each row and column, which on the ladder is a coarser level. A preview
// and its build therefore rank the same points of the terrain. Only the sample is read back: 264 kB at most.
// Stated tolerance: against the ranks of every texel the sample moves the result by 0.1 % of the range of the
// heights on fractal noise at 513, where it is a quarter of the field (0.14 % at 2049, a 64th);
// tests/nodes/adjust/equalize.test.ts holds it to 0.3 %.
const SAMPLE_MAX = 257;
/**
 * The curve from height to rank goes through at most this many knots a constant share of the terrain apart,
 * through closer ones at its two ends, and through three more for every level that holds such a share by itself.
 * The knots lie where the heights are, so a terrain that is a plain with one mountain, or has one texel far
 * above the rest, is ranked as finely as any other.
 */
const KNOTS_MAX = 128;
/** Halvings that find a knot: enough for 1024 knots; a table holds fewer than 4 * KNOTS_MAX + 24. */
const SEARCH = 10;

const sample = defineKernel({
  name: 'adjust/equalize.sample',
  inputs: { src: { kind: 'field', size: 'any' } },
  outputs: { out: 'field' },
  params: { stride: 'i32' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return src_at(px * P.stride);
}`,
});

// A knot is (height, new height, d0, d1): d0 and d1 are the slopes of the curve at this knot and at the next,
// times the distance between the two, so that neither grows without bound where two knots are one float apart.
const apply = defineKernel({
  name: 'adjust/equalize.apply',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { strength: 'f32' },
  luts: { knots: 'vec4f' },
  includes: [adjust],
  cost: 13,   // the texel, ten reads of the table at most to find the knot and two to read it and the next
  code: /* wgsl */ `
const SEARCH = ${SEARCH};

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let v = src_at(px);
  // The last knot at or below v. The first knot is the lowest height of the field and the last its highest.
  var a = 0u;
  var b = knots_len() - 1u;
  for (var i = 0; i < SEARCH; i++) {
    if (b - a <= 1u) { break; }
    let m = (a + b) / 2u;
    if (knots_item(m).x <= v) { a = m; } else { b = m; }
  }
  let k0 = knots_item(a);
  let k1 = knots_item(a + 1u);
  // Halved where the heights are so large that their difference would not be a float.
  let s = select(1.0, 0.5, max(abs(k0.x), abs(k1.x)) > 1.0e38);
  let width = k1.x * s - k0.x * s;
  var t = 0.0;
  if (width > 0.0) { t = saturate((v * s - k0.x * s) / width); }
  // The cubic through the two knots with their slopes. It rises wherever the ranks rise, and its slope has no
  // step at a knot: a step there shows as a contour line in the slopes of the result.
  let u = 1.0 - t;
  let p = t * t * (3.0 - 2.0 * t);
  let level = clamp(k0.y * (1.0 - p) + k1.y * p + k0.z * (t * u * u) - k0.w * (t * t * u), k0.y, k1.y);
  return adjust_field(adjust_blend(v, level, P.strength));
}`,
});

/**
 * `values` in rising order, in place. Three counting passes over the bits of the floats: a comparison sort of
 * 66 049 values holds the engine thread for 6 ms, this one for 1 ms.
 */
function sortRising(values: Float32Array): void {
  const n = values.length;
  const bits = new Uint32Array(values.buffer, values.byteOffset, n);
  let from = new Uint32Array(n), to = new Uint32Array(n);
  // With the sign bit of a positive float set and every bit of a negative one flipped, floats rise as their bits do.
  for (let i = 0; i < n; i++) from[i] = (bits[i]! ^ ((bits[i]! >> 31) | 0x80000000)) >>> 0;
  const starts = new Uint32Array(2048);
  for (const shift of [0, 11, 22]) {
    starts.fill(0);
    for (let i = 0; i < n; i++) starts[(from[i]! >>> shift) & 2047]!++;
    let start = 0;
    for (let digit = 0; digit < 2048; digit++) {
      const count = starts[digit]!;
      starts[digit] = start;
      start += count;
    }
    for (let i = 0; i < n; i++) {
      const key = from[i]!;
      to[starts[(key >>> shift) & 2047]!++] = key;
    }
    [from, to] = [to, from];
  }
  for (let i = 0; i < n; i++) bits[i] = (from[i]! ^ (((from[i]! >>> 31) - 1) | 0x80000000)) >>> 0;
}

/**
 * The table of the apply kernel: the curve from a height to its new height, as knots. `heights`, the sample, is
 * sorted in place; `lo` and `hi` are the lowest and the highest height of the whole field, and lo < hi.
 *
 * The new height of a height is lo + (hi - lo) * share. The share is counted among the terrain that lies strictly
 * between the lowest and the highest height: what is below the height, and half of what is exactly at it. What
 * lies at the lowest height itself stays there and what lies at the highest stays there, however much of the
 * terrain that is: a level sea and a level plateau keep their place, the ground between them takes the whole
 * range, and neither gets a cliff at its edge. Turning the terrain over turns the result over.
 */
function knotsOf(heights: Float32Array, lo: number, hi: number): Float32Array {
  sortRising(heights);
  const n = heights.length;
  let below = 0;
  while (below < n && heights[below]! <= lo) below++;
  let top = n;
  while (top > below && heights[top - 1]! >= hi) top--;
  const between = top - below;   // the samples strictly between the two ends
  const knots = Math.min(KNOTS_MAX, Math.max(8, Math.round(Math.sqrt(n) / 2)));
  const step = Math.max(1, between / knots);
  // The counts of samples at which a knot is due: a step apart, and 1, 2, 4, ... samples from either end, where
  // the heights thin out and a knot a whole step from the end would leave the tail to one cubic.
  const dues: number[] = [];
  for (let k = 1; k <= knots; k++) dues.push(below + Math.round(k * step));
  for (let reach = 1; reach < step; reach *= 2) dues.push(below + reach, top - reach);
  dues.sort((a, b) => a - b);

  const xs: number[] = [lo], ys: number[] = [0];
  let next = 0;                    // the first of `dues` not yet reached
  let lastX = lo, lastShare = 0;   // the height before the current one, and its share
  let lastIsKnot = true, lastIsLevel = false;
  for (let i = below; i < top;) {
    const x = heights[i]!;
    let end = i + 1;
    while (end < top && heights[end] === x) end++;
    const share = (i - below + (end - i) / 2) / between;
    // A level that many texels share is a step in the ranks: the height before it, the level and the height
    // after it are all knots, so that the step lies between neighbouring heights and nowhere else.
    const level = end - i >= step;
    if (level && !lastIsKnot) {
      xs.push(lastX);
      ys.push(lastShare);
    }
    lastIsKnot = level || lastIsLevel || end === top || (next < dues.length && end >= dues[next]!);
    if (lastIsKnot) {
      xs.push(x);
      ys.push(share);
      while (next < dues.length && dues[next]! <= end) next++;
    }
    lastIsLevel = level;
    lastX = x;
    lastShare = share;
    i = end;
  }
  xs.push(hi);
  ys.push(1);

  // The slopes of a monotone cubic (Fritsch and Carlson): at a knot, the weighted harmonic mean of the slopes of
  // the two straight lines that meet there, which is at most three times the smaller. The heights rise strictly
  // from knot to knot and so do the shares, so every such line rises.
  const count = xs.length;
  const line: number[] = [];
  for (let j = 0; j + 1 < count; j++) line.push((ys[j + 1]! - ys[j]!) / (xs[j + 1]! - xs[j]!));
  const slope: number[] = [line[0]!];
  for (let j = 1; j + 1 < count; j++) {
    const before = xs[j]! - xs[j - 1]!, after = xs[j + 1]! - xs[j]!;
    const w1 = 2 * after + before, w2 = after + 2 * before;
    slope.push((w1 + w2) / (w1 / line[j - 1]! + w2 / line[j]!));
  }
  slope.push(line[count - 2]!);

  const BIG = 3.4028234e38;
  const table = new Float32Array(4 * count);
  for (let j = 0; j < count; j++) {
    table[4 * j] = xs[j]!;
    table[4 * j + 1] = lo * (1 - ys[j]!) + hi * ys[j]!;
    if (j + 1 < count) {
      const span = (xs[j + 1]! - xs[j]!) * (hi - lo);
      table[4 * j + 2] = Math.min(slope[j]! * span, BIG);
      table[4 * j + 3] = Math.min(slope[j + 1]! * span, BIG);
    }
  }
  return table;
}

export default defineNode({
  type: 'adjust/equalize',
  title: 'Equalize',
  category: 'adjust',
  description: 'Redistributes heights between the lowest and the highest point so that every band of height covers the same area of the terrain.',
  keywords: ['histogram', 'flatten', 'distribution', 'contrast', 'hypsometry', 'rank'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.strength({
      help: 'Larger values move every height further toward its place in an even distribution; at 0 the terrain is left as it is.',
    }),
  ],
  kernels: [sample, apply],
  maskable: true,
  // The heights are ranked among those of the level evaluated: a finer level holds heights a coarser one never sees.
  resolutionDependent: true,
  async evaluate(ctx) {
    const src = ctx.input('in');
    const { strength } = ctx.params;
    // Without strength nothing moves: the input itself is the output, and nothing is measured.
    if (strength <= 0) {
      ctx.output('out', src);
      return;
    }
    const { min: lo, max: hi } = await ctx.stats(src);   // of every texel, reduced on the GPU
    // A flat field has no heights to redistribute.
    if (!(hi > lo)) {
      ctx.output('out', src);
      return;
    }

    // The stride doubles until the sample fits: at most 5 times for a field of 8192.
    let stride = 1;
    while (stride < 8192 && Math.floor((ctx.res - 1) / stride) + 1 > SAMPLE_MAX) stride *= 2;
    let heights: Float32Array;
    if (stride === 1) {
      heights = await ctx.read(src);
    } else {
      const coarse = ctx.alloc('field', { size: Math.floor((ctx.res - 1) / stride) + 1 });
      ctx.run(sample, { in: { src }, out: { out: coarse }, params: { stride } });
      heights = await ctx.read(coarse);
      ctx.release(coarse);   // before the result is allocated: the node never holds more than one field
    }

    const knots = ctx.lut(knotsOf(heights, lo, hi), 'vec4f');
    const out = ctx.alloc('field');
    ctx.run(apply, { in: { src }, out: { out }, params: { strength }, luts: { knots } });
    ctx.output('out', out);
  },
});
