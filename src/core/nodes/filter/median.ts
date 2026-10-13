// src/core/nodes/filter/median.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { CUBIC_LOADS, filterSample } from './_sample.ts';

/** The window is the lattice points within this many steps of the centre, the outermost of them with part of their weight. */
const MAX_RADIUS = 3.9;
/** How many lattice points lie within MAX_RADIUS + 0.5 steps: the loads of one texel, within the 64 of engine.md 3.15. */
const MAX_SAMPLES = 61;
const REACH = 4;

/** The lattice points a window can hold: those within MAX_RADIUS + 0.5 steps of the centre. */
const WINDOW: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let j = -REACH; j <= REACH; j++) for (let i = -REACH; i <= REACH; i++) if (Math.hypot(i, j) < MAX_RADIUS + 0.5) out.push([i, j]);
  return out;
})();
/** How often the interval that holds the median is halved: to the last bit of a float32. */
const HALVINGS = 24;
/** What ranking the samples costs beside reading them, in loads: measured, 7.4 ms for a 2049 field whatever the radius. */
const ARITHMETIC = 122;

// The kernel is written out sample by sample: 61 values and weights that stay in registers. Held in an array
// and indexed in a loop, the same samples take fifty times as long to rank.
const each = (line: (k: number) => string, joint = '\n  '): string => WINDOW.map((_, k) => line(k)).join(joint);
/** The weight of the samples at or below `t`. Always summed in this order, so that equal sets give equal sums. */
const atMost = (t: string): string => each((k) => `select(0.0, w${k}, v${k} <= ${t})`, ' + ');

const median = defineKernel({
  name: 'filter/median',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { radius: 'f32' },     // in texels of the grid the kernel runs on
  cost: MAX_SAMPLES + ARITHMETIC,
  code: /* wgsl */ `
const BIG = 3.4028234e38;

// A sample of the window: its value where it has a weight, and nothing read where it has none.
fn sample(px: vec2i, offset: vec2i, w: f32) -> f32 {
  if (w <= 0.0) { return 0.0; }
  return src_at(px + offset);
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let radius = clamp(P.radius, 0.0, ${MAX_RADIUS});
  // The window: a disc. A point counts in full inside it, and in part where the disc's edge crosses its cell, so
  // that the window grows evenly with the radius and not by a ring of points at a time.
  ${each((k) => `let w${k} = saturate(radius + 0.5 - ${Math.hypot(...WINDOW[k]!).toFixed(7)});`)}
  ${each((k) => `let v${k} = sample(px, vec2i(${WINDOW[k]![0]}, ${WINDOW[k]![1]}), w${k});`)}
  let half = 0.5 * (${each((k) => `w${k}`, ' + ')});
  var lo = BIG;
  var hi = -BIG;
  ${each((k) => `if (w${k} > 0.0) { lo = min(lo, v${k}); hi = max(hi, v${k}); }`)}

  // The weighted median: the smallest sample with half the weight at or below it. It lies in lo..hi, at or below
  // hi; the interval is halved until nothing but that sample is left in it.
  if (${atMost('lo')} >= half) { hi = lo; }
  for (var i = 0; i < ${HALVINGS}; i++) {
    let mid = 0.5 * lo + 0.5 * hi;
    if (${atMost('mid')} >= half) { hi = mid; } else { lo = mid; }
  }
  var lower = -BIG;
  ${each((k) => `if (w${k} > 0.0 && v${k} <= hi) { lower = max(lower, v${k}); }`)}

  // With exactly half the weight at or below it, the next sample up has the other half at or above it: the median
  // is the mean of the two, so that the median of a terrain turned upside down is the median turned upside down.
  var upper = lower;
  if (${atMost('lower')} == half) {
    upper = BIG;
    ${each((k) => `if (w${k} > 0.0 && v${k} > lower) { upper = min(upper, v${k}); }`, '\n    ')}
  }
  return 0.5 * lower + 0.5 * upper;
}`,
});

// A grid with a ring (engine.md section 5) brought onto the terrain's own grid: vertex (i, j) of it is its texel
// (i + 1, j + 1). The cubic passes through the values of the coarse grid, where a smoothing filter would blur
// what the median has just kept sharp.
const enlarge = defineKernel({
  name: 'filter/median.enlarge',
  inputs: { src: { kind: 'field', size: 'any' } },
  outputs: { out: 'field' },
  params: { cells: 'f32' },      // the cells of the coarse grid across the terrain
  includes: [filterSample],
  cost: CUBIC_LOADS,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return filterSample_cubic(src, uv * P.cells + vec2f(1.0), 0u, vec4f(0.0)).r;
}`,
});

/** How many lattice points have a weight at a radius of `radius` steps: the loads of one texel. */
function samples(radius: number): number {
  let n = 0;
  for (let j = -REACH; j <= REACH; j++) for (let i = -REACH; i <= REACH; i++) if (radius + 0.5 - Math.hypot(i, j) > 0) n++;
  return Math.min(n, MAX_SAMPLES);
}

export default defineNode({
  type: 'filter/median',
  title: 'Median',
  category: 'filter',
  description: 'Removes spikes and pits narrower than a radius by giving each point the median height of its surroundings.',
  keywords: ['despeckle', 'denoise', 'outlier', 'rank', 'clean'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    // Hard limits: the window never holds more than 61 samples, and beyond this radius they would lie too far
    // apart to stand for the heights between them.
    param.radius({
      default: 0.006, min: 0.0005, max: 0.05, soft: false,
      help: 'Spikes, pits and ridges narrower than this are removed. Larger values also round off broader features.',
    }),
  ],
  kernels: [median, enlarge],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const { radius } = ctx.params;
    const texels = ctx.lengthToPx(radius);
    // Up to here the centre outweighs every neighbour that counts in part: the median is the texel itself.
    if (texels <= 0.75) {
      ctx.output('out', src);
      return;
    }
    if (texels <= MAX_RADIUS) {
      const out = ctx.alloc('field');
      ctx.run(median, { in: { src }, out: { out }, params: { radius: texels }, cost: samples(texels) + ARITHMETIC });
      ctx.output('out', out);
      return;
    }
    // A radius the window cannot hold texel by texel: the median is taken on a coarser grid, the finest on which
    // the window holds it, and brought back smoothly. That grid depends on the radius alone, so every level of
    // the ladder that needs it uses the same one. It carries a ring: the window reads past the border what the
    // terrain's own grid would hold there. What is narrower than a cell of it, a quarter of the radius, is
    // averaged before it is ranked, and an edge the median keeps comes back a cell or two wide.
    const cells = Math.ceil(MAX_RADIUS / radius);
    const coarse = ops.resample(ctx, src, { size: cells + 1, filter: 'tent', ring: { out: true } });
    const ranked = ctx.alloc('field', { like: coarse });
    const steps = radius * cells;
    ctx.run(median, { in: { src: coarse }, out: { out: ranked }, params: { radius: steps }, cost: samples(steps) + ARITHMETIC });
    ctx.release(coarse);
    const out = ctx.alloc('field');
    ctx.run(enlarge, { in: { src: ranked }, out: { out }, params: { cells } });
    ctx.release(ranked);
    ctx.output('out', out);
  },
});
