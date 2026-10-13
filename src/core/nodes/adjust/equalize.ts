// src/core/nodes/adjust/equalize.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { adjust } from './_wgsl.ts';

// The histogram is built on the GPU and never read back. It is counted on a sample of the field: every texel of
// a field up to SAMPLE_MAX a side, and of a larger one every 2nd, 4th, ... texel of each row and column: on the
// ladder, a coarser level. A preview and its build therefore count the same texels of the terrain.
// Against the histogram of every texel the sample moves the result by 0.1 % of the range of the heights on
// fractal noise at 513, where it is a quarter of the field; tests/nodes/adjust/equalize.test.ts holds it to 0.3 %.
const SAMPLE_MAX = 257;
/** The bins of the histogram lie in a square of this side: 256 bins between the lowest and the highest height. */
const GRID = 16;
/** A pass reduces 8 x 8 blocks to one: 64 loads per texel. */
const BLOCK = 8;

const LAYOUT = /* wgsl */ `
const GRID = ${GRID};
const BINS = ${GRID * GRID};
const BLOCK = ${BLOCK};
`;

// Texel (x, y) of the result belongs to block (x / GRID, y / GRID) of the sample and to bin
// x % GRID + GRID * (y % GRID). It holds how many of the 64 samples of the block lie at or below the upper edge
// of the bin: the counts are cumulative from the start, and the last bin of a block counts all its samples.
const count = defineKernel({
  name: 'adjust/equalize.count',
  inputs: { src: { kind: 'field', size: 'any' }, range: 'vec2' },
  outputs: { out: 'field' },
  params: { stride: 'i32', side: 'i32' },   // sample (i, j) is texel (i, j) * stride of the source; `side` samples a side
  cost: BLOCK * BLOCK + 1,
  code: /* wgsl */ `${LAYOUT}
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let block = px / GRID;
  let cell = px - block * GRID;
  let bin = cell.x + GRID * cell.y;
  let span = range_at(vec2i(0));
  let edge = span.x + (span.y - span.x) * (f32(bin + 1) / f32(BINS));
  var n = 0.0;
  for (var j = 0; j < BLOCK; j++) {
    for (var i = 0; i < BLOCK; i++) {
      let s = block * BLOCK + vec2i(i, j);
      if (s.x < P.side && s.y < P.side && (bin == BINS - 1 || src_at(s * P.stride) <= edge)) { n += 1.0; }
    }
  }
  return n;
}`,
});

// The counts of 8 x 8 blocks added bin by bin. Counts are whole numbers below 2^24, which a float adds exactly.
const sum = defineKernel({
  name: 'adjust/equalize.sum',
  inputs: { src: { kind: 'field', size: 'any' } },
  outputs: { out: 'field' },
  cost: BLOCK * BLOCK,
  code: /* wgsl */ `${LAYOUT}
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let block = px / GRID;
  let cell = px - block * GRID;
  let blocks = vec2i(src_res()) / GRID;
  var n = 0.0;
  for (var j = 0; j < BLOCK; j++) {
    for (var i = 0; i < BLOCK; i++) {
      let s = block * BLOCK + vec2i(i, j);
      if (s.x < blocks.x && s.y < blocks.y) { n += src_at(s * GRID + cell); }
    }
  }
  return n;
}`,
});

const apply = defineKernel({
  name: 'adjust/equalize.apply',
  inputs: { src: 'field', cdf: { kind: 'field', size: 'any' }, range: 'vec2' },
  outputs: { out: 'field' },
  params: { strength: 'f32' },
  includes: [adjust],
  cost: 7,
  code: /* wgsl */ `${LAYOUT}
// Control point k of the cumulative count, for k from -1 to BINS + 1: point k is the count at or below the
// upper edge of bin k - 1, and point 0, at the lowest height, is 0. One point beyond each end continues the
// counts through the end point, so that the curve starts at 0 and ends at the full count.
fn point(k: i32) -> f32 {
  if (k == 0) { return 0.0; }
  if (k < 0) { return -cdf_at(vec2i(0, 0)); }
  if (k > BINS) { return 2.0 * cdf_at(vec2i(GRID - 1, GRID - 1)) - cdf_at(vec2i(GRID - 2, GRID - 1)); }
  return cdf_at(vec2i((k - 1) % GRID, (k - 1) / GRID));
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let v = src_at(px);
  let span = range_at(vec2i(0));
  let width = span.y - span.x;
  let total = cdf_at(vec2i(GRID - 1, GRID - 1));
  // A flat field has no heights to redistribute.
  if (width <= 0.0 || total <= 0.0) { return v; }
  let t = clamp((v - span.x) / width, 0.0, 1.0) * f32(BINS);
  let k = min(i32(t), BINS - 1);
  let f = t - f32(k);
  // The share of the terrain at or below v: the uniform cubic B-spline of the cumulative counts. It rises
  // wherever they rise and has no step in slope or in curvature, which a table read in straight lines has at
  // every bin: such steps show as contour lines in the slopes of the result.
  let g = 1.0 - f;
  let share = (g * g * g * point(k - 1)
    + (3.0 * f * f * f - 6.0 * f * f + 4.0) * point(k)
    + (3.0 * g * g * g - 6.0 * g * g + 4.0) * point(k + 1)
    + f * f * f * point(k + 2)) / (6.0 * total);
  // Equal shares of the terrain get equal bands of height, between the lowest and the highest point as they were.
  let level = span.x + width * saturate(share);
  return adjust_blend(v, level, P.strength);
}`,
});

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
  kernels: [count, sum, apply],
  maskable: true,
  // The histogram is that of the level evaluated: a finer level holds heights a coarser one never sees.
  resolutionDependent: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    // Without strength nothing moves: the input itself is the output, and no histogram is built.
    if (ctx.params.strength <= 0) {
      ctx.output('out', src);
      return;
    }
    const range = ops.minMax(ctx, src);   // of every texel, on the GPU

    // The stride doubles until the sample fits: at most 5 times for a field of 8192.
    let stride = 1;
    while (stride < 8192 && Math.floor((ctx.res - 1) / stride) + 1 > SAMPLE_MAX) stride *= 2;
    const side = Math.floor((ctx.res - 1) / stride) + 1;

    let blocks = Math.ceil(side / BLOCK);
    let counts = ctx.alloc('field', { size: blocks * GRID });
    ctx.run(count, { in: { src, range }, out: { out: counts }, params: { stride, side } });
    // 33 blocks a side become 5 and then 1: the histogram of the whole sample, 16 x 16 texels.
    while (blocks > 1) {
      blocks = Math.ceil(blocks / BLOCK);
      const next = ctx.alloc('field', { size: blocks * GRID });
      ctx.run(sum, { in: { src: counts }, out: { out: next } });
      ctx.release(counts);
      counts = next;
    }

    const out = ctx.alloc('field');
    ctx.run(apply, { in: { src, cdf: counts, range }, out: { out }, params: { strength: ctx.params.strength } });
    ctx.release(counts);
    ctx.release(range);
    ctx.output('out', out);
  },
});
