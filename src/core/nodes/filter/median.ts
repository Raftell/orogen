// src/core/nodes/filter/median.ts
import { defineKernel, defineNode, hash, param, type Field } from '../../api.ts';

/** How many samples a window holds: the loads of one texel, within the 64 of engine.md 3.15. */
const SAMPLES = 61;
/** Up to this radius, in texels, the window is the texels of the disc themselves, the outermost with part of their weight. */
const MAX_RADIUS = 3.9;
const REACH = 4;
/** A wide window is followed by one a quarter as wide, down to the texels themselves. */
const NARROWING = 4;

/** The texels a window of up to MAX_RADIUS can hold: those within MAX_RADIUS + 0.5 of the centre, 61 of them. */
const DISC: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let j = -REACH; j <= REACH; j++) for (let i = -REACH; i <= REACH; i++) if (Math.hypot(i, j) < MAX_RADIUS + 0.5) out.push([i, j]);
  return out;
})();

/**
 * Where a window wider than MAX_RADIUS looks, as shares of its radius: 30 points spread evenly over the unit disc
 * along the golden-angle spiral. Each is read on both sides of the centre, which makes 61 samples with the centre.
 * Unlike the points of a grid they have no spacing in common: a pattern of any period is met at all its phases.
 */
const SPIRAL: readonly (readonly [number, number])[] = Array.from({ length: (SAMPLES - 1) / 2 }, (_, k) => {
  const r = Math.sqrt((k + 0.5) / ((SAMPLES - 1) / 2));
  const angle = k * Math.PI * (3 - Math.sqrt(5));
  return [r * Math.cos(angle), r * Math.sin(angle)] as const;
});

/** How often the interval that holds the median is halved: to the last bit of a float32. */
const HALVINGS = 24;
/** What ranking the samples costs beside reading them, in loads: measured, 7.4 ms for a 2049 field whatever the radius. */
const ARITHMETIC = 122;

// Both kernels are written out sample by sample: 61 values and weights that stay in registers. Held in an array
// and indexed in a loop, the same samples take fifty times as long to rank.
const each = (line: (k: number) => string, joint = '\n  '): string => Array.from({ length: SAMPLES }, (_, k) => line(k)).join(joint);
/** The weight of the samples at or below `t`. Always summed in this order, so that equal sets give equal sums. */
const atMost = (t: string): string => each((k) => `select(0.0, w${k}, v${k} <= ${t})`, ' + ');

/**
 * The weighted median of the samples v0..v60 with the weights w0..w60, as WGSL statements that end by returning
 * it: the smallest sample with half the weight at or below it; and where exactly half lies at or below it, the
 * mean of it and the next one up, which has the other half at or above it, so that the median of a terrain turned
 * upside down is the median turned upside down.
 */
const RANK = /* wgsl */ `
  let half = 0.5 * (${each((k) => `w${k}`, ' + ')});
  var lo = BIG;
  var hi = -BIG;
  ${each((k) => `if (w${k} > 0.0) { lo = min(lo, v${k}); hi = max(hi, v${k}); }`)}
  // The median lies in lo..hi, at or below hi; the interval is halved until nothing but that sample is left in it.
  if (${atMost('lo')} >= half) { hi = lo; }
  for (var i = 0; i < ${HALVINGS}; i++) {
    let mid = 0.5 * lo + 0.5 * hi;
    if (${atMost('mid')} >= half) { hi = mid; } else { lo = mid; }
  }
  var lower = -BIG;
  ${each((k) => `if (w${k} > 0.0 && v${k} <= hi) { lower = max(lower, v${k}); }`)}
  var upper = lower;
  if (${atMost('lower')} == half) {
    upper = BIG;
    ${each((k) => `if (w${k} > 0.0 && v${k} > lower) { upper = min(upper, v${k}); }`, '\n    ')}
  }
  return 0.5 * lower + 0.5 * upper;`;

// The median of the texels of a disc of up to 3.9 texels.
const dense = defineKernel({
  name: 'filter/median.dense',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { radius: 'f32' },     // texels
  cost: SAMPLES + ARITHMETIC,
  code: /* wgsl */ `
const BIG = 3.4028234e38;

// A sample of the window: its value where it has a weight, and nothing read where it has none.
fn sample(px: vec2i, offset: vec2i, w: f32) -> f32 {
  if (w <= 0.0) { return 0.0; }
  return src_at(px + offset);
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let radius = clamp(P.radius, 0.0, ${MAX_RADIUS});
  // A texel counts in full inside the disc, and in part where the disc's edge crosses its cell, so that the
  // window grows evenly with the radius and not by a ring of texels at a time.
  ${each((k) => `let w${k} = saturate(radius + 0.5 - ${Math.hypot(...DISC[k]!).toFixed(7)});`)}
  ${each((k) => `let v${k} = sample(px, vec2i(${DISC[k]![0]}, ${DISC[k]![1]}), w${k});`)}
  ${RANK}
}`,
});

// The median of 61 texels spread over a disc of any radius: the centre, and the texels nearest to 30 points of
// the spiral and to their mirror images. A window that is its own mirror image gives a slope its own height and
// keeps a straight cliff where it is, to the texel.
//
// Its samples are a sixth of the disc's texels or fewer. With one window for every texel, the sample that is the
// median changes along lines, and smooth ground comes out in facets that follow its contours. So the spiral is
// turned by an angle of its own at every place: the facets become a grain from texel to texel, which the
// narrower windows that follow rank away (the node below). The angle is hashed from the place on the terrain,
// on a lattice finer than any grid, and is the same at a vertex two levels of the ladder share.
const sparse = defineKernel({
  name: 'filter/median.sparse',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { radius: 'f32' },     // texels
  includes: [hash],
  cost: SAMPLES + ARITHMETIC,
  code: /* wgsl */ `
const BIG = 3.4028234e38;
const LATTICE = 65536.0;

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let turn = 6.2831853 * hash_unit(hash_cell(vec2i(round(uv * LATTICE)), 0x6d656469u));
  let across = P.radius * vec2f(cos(turn), sin(turn));
  let up = vec2f(-across.y, across.x);
  ${each((k) => `let w${k} = 1.0;`)}
  let v0 = src_at(px);
  ${SPIRAL.map(([x, y], k) => `let o${k} = vec2i(round(${x.toFixed(7)} * across + ${y.toFixed(7)} * up));
  let v${2 * k + 1} = src_at(px + o${k});
  let v${2 * k + 2} = src_at(px - o${k});`).join('\n  ')}
  ${RANK}
}`,
});

/** How many texels of the disc have a weight at a radius of `radius` texels: the loads of one texel. */
function samples(radius: number): number {
  return DISC.filter(([i, j]) => radius + 0.5 - Math.hypot(i, j) > 0).length;
}

/**
 * The windows of a median of `texels` texels, widest first: spread ones a quarter as wide each time while they
 * are wider than the texels of a disc can fill, then one of those texels themselves.
 */
function windows(texels: number): { readonly spread: readonly number[]; readonly last: number } {
  const spread: number[] = [];
  let radius = texels;
  for (let guard = 0; radius > MAX_RADIUS && guard < 16; guard++) {
    spread.push(radius);
    radius /= NARROWING;
  }
  return { spread, last: radius };
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
    // Hard limits: a window holds 61 samples whatever its radius. Up to 3.9 texels they are the texels of the
    // disc; beyond, 61 of them spread over it, followed by narrower windows: five passes at this maximum at 8129.
    param.radius({
      default: 0.012, min: 0.0005, max: 0.05, soft: false,
      help: 'Spikes, pits and ridges narrower than this are removed. Larger values also round off broader features.',
    }),
  ],
  kernels: [dense, sparse],
  maskable: true,
  async evaluate(ctx) {
    const src = ctx.input('in');
    const texels = ctx.lengthToPx(ctx.params.radius);
    // Up to here the centre outweighs every neighbour that counts in part: the median is the texel itself.
    if (texels <= 0.75) {
      ctx.output('out', src);
      return;
    }
    const { spread, last } = windows(texels);
    const count = spread.length + 1;
    const targets = [ctx.alloc('field'), count > 1 ? ctx.alloc('field') : null];
    let current: Field<'field'> = src;
    await ctx.loop(count, (i) => {
      const out = targets[i % 2]!;
      if (i < spread.length) ctx.run(sparse, { in: { src: current }, out: { out }, params: { radius: spread[i]! } });
      else ctx.run(dense, { in: { src: current }, out: { out }, params: { radius: last }, cost: samples(last) + ARITHMETIC });
      current = out;
    }, { preview: () => ({ out: current }) });
    for (const target of targets) if (target && target !== current) ctx.release(target);
    ctx.output('out', current);
  },
});
