// src/core/nodes/surface/terraces.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { surfaceBeds } from './_beds.ts';
import { surfaceNoise } from './_noise.ts';

/** The constants of the kernel, which the tests read. */
export const TERRACES = {
  /** The narrowest a riser is drawn, in texels from the edge of one bench to the edge of the next: a narrower one is a jagged line. */
  riserTexels: 2.5,
  /** How far the noise moves the edge of a bench off its contour line at full irregularity, in steps, where the noise is 1. */
  stray: 0.5,
  /** The octaves of that noise. */
  octaves: 2,
  /** The slope, as a tangent, from which the edges stray in full: on level ground at the height of a step the noise would raise islands. */
  level: 0.1,
} as const;

const terraces = defineKernel({
  name: 'surface/terraces',
  // src: the terrain. shape: the terrain smoothed over the radius, whose contour lines the steps follow.
  inputs: { src: 'field', shape: 'field' },
  outputs: { out: 'field' },
  // levels: steps per unit of height. riser: the part of a step's height its riser takes. stray: a height.
  // cells: lattice cells of the noise across the terrain. texel: the length of a texel.
  params: { levels: 'f32', riser: 'f32', irregularity: 'f32', stray: 'f32', cells: 'f32', texel: 'f32' },
  includes: [surfaceBeds, surfaceNoise],
  cost: 6 + 8 * TERRACES.octaves,
  code: /* wgsl */ `
const RISER_TEXELS = ${TERRACES.riserTexels};
const OCTAVES = ${TERRACES.octaves};
const LEVEL = ${TERRACES.level};

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let z = src_at(px);
  let zs = shape_at(px);
  let slope = slopeAt(shape, px);
  // The beds do not lie quite level: a broad noise moves the height a step is cut at, so the edge of a bench
  // strays from the contour line. The bench itself stays level.
  let n = surfaceNoise_fbmD(uv * P.cells, seedFor(1u), OCTAVES, 0.5, 1.0e6);
  let stray = P.stray * smoothstep(0.0, LEVEL, length(slope));
  let s = (zs + stray * n.x) * P.levels;
  // How far that level changes from one texel to the next.
  let g = length(slope * (frame.cellSize / frame.heightRange) + stray * P.cells * P.texel * n.yz) * P.levels;

  // A step is a level bench at the middle height of its bed, and half a riser at either end of it: the riser
  // climbs from one bench to the next through the base of the bed, by the same factor steeper than the terrain
  // on both sides of it. Where the terrain is so steep that the riser would be narrower than the grid can
  // draw it, the riser takes more of the step, and on ground steeper still the terrain is left as it is.
  let seed = seedFor(0u);
  let bed = surfaceBeds_find(s, P.irregularity, seed);
  let mid = 0.5 * (bed.lo + bed.hi);
  let own = bed.hi - bed.lo;
  var riser = 1.0;
  var stepped = mid;
  var across = 1.0;                     // 0 in the middle of a riser, 1 at the edge of the bench and on it
  if (s < mid) {
    let below = bed.lo - surfaceBeds_base(bed.index - 1, P.irregularity, seed);
    riser = clamp(max(P.riser, RISER_TEXELS * g / (0.5 * (own + below))), 1.0e-4, 1.0);
    stepped = min(bed.lo + (s - bed.lo) / riser, mid);
    across = saturate((s - bed.lo) / (0.5 * riser * own));
  } else {
    let above = surfaceBeds_base(bed.index + 2, P.irregularity, seed) - bed.hi;
    riser = clamp(max(P.riser, RISER_TEXELS * g / (0.5 * (own + above))), 1.0e-4, 1.0);
    stepped = max(bed.hi - (bed.hi - s) / riser, mid);
    across = saturate((bed.hi - s) / (0.5 * riser * own));
  }
  // What the smoothing took from the terrain is given back to the risers, and to ground too steep to be
  // stepped, which is then the terrain itself. A bench has none of it: it is level.
  let whole = smoothstep(0.6, 1.0, riser);
  let detail = max(1.0 - smoothstep(0.5, 1.0, across), whole);
  return stepped / P.levels + detail * (z - zs) - whole * stray * n.x;
}`,
});

export default defineNode({
  type: 'surface/terraces',
  title: 'Terraces',
  category: 'surface',
  description: 'Steps the terrain into level benches with steep risers between them, at uneven heights.',
  keywords: ['steps', 'benches', 'stairs', 'plateau', 'mesa', 'quantize', 'posterize', 'stratify'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'int', name: 'levels', label: 'Levels', default: 8, min: 1, max: 64,
      help: 'How many steps lie between the bottom and the top of the height range. Larger values give more and lower steps.',
    },
    {
      kind: 'float', name: 'sharpness', label: 'Sharpness', unit: 'ratio', default: 0.8, min: 0, max: 1,
      help: 'Larger values widen the benches and steepen the risers between them. At 0 the terrain stays as it is.',
    },
    {
      kind: 'float', name: 'irregularity', label: 'Irregularity', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values make the steps less even in height and let the edges of the benches stray further from the contour lines.',
    },
    param.size({ label: 'Irregularity size', help: 'Larger values let the edges of the benches stray from the contour lines in broader sweeps.' }),
    param.radius({
      label: 'Edge smoothing', default: 0.004,
      help: 'Features of the terrain smaller than this do not shape the edges of the benches. Larger values draw the steps in cleaner lines.',
    }),
    param.seed(),
  ],
  kernels: [terraces],
  maskable: true,
  evaluate(ctx) {
    const { levels, sharpness, irregularity } = ctx.params;
    const src = ctx.input('in');
    if (sharpness <= 0) {
      ctx.output('out', src);
      return;
    }
    const size = Math.min(Math.max(ctx.params.size, 1e-4), 1000);   // soft: any finite number can arrive
    // A noise finer than the grid holds would move the edges from texel to texel: it is faded out before that.
    const held = Math.min(Math.max(ctx.lengthToPx(size) / 4 - 1, 0), 1);
    // The steps follow the contour lines of the terrain smoothed over the radius: those of a rough terrain turn
    // at every texel, and a riser drawn along them is ragged. Smoothed without anything assumed beyond the border.
    const shape = ops.smooth(ctx, src, Math.min(Math.max(ctx.params.radius, 0), 4));
    const out = ctx.alloc('field');
    ctx.run(terraces, {
      in: { src, shape },
      out: { out },
      params: {
        levels,
        riser: 1 - sharpness,
        irregularity,
        // With no sharpness there is no bench whose edge could stray: the shift goes with it.
        stray: (TERRACES.stray * irregularity * sharpness * held) / levels,
        cells: 1 / size,
        texel: 1 / Math.max(ctx.res - 1, 1),
      },
    });
    ctx.release(shape);
    ctx.output('out', out);
  },
});
