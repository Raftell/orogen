// src/core/nodes/surface/strata.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { surfaceBeds } from './_beds.ts';
import { surfaceNoise } from './_noise.ts';
import { slopeBand, surfaceSlope } from './_slope.ts';

/** The constants of the kernel, which the tests read. */
export const STRATA = {
  /** The part of a bed's thickness its cliff takes where the grid can draw it: the hard rock at the foot of the bed. */
  cliff: 0.25,
  /** How far the softest bed stands out, as a part of what the hardest does. */
  softest: 0.1,
  /** The narrowest a cliff is drawn, in texels. */
  cliffTexels: 2,
  /** How uneven the beds are in thickness: the irregularity of the bed sequence. */
  uneven: 1,
  /** The angle over which the beds come to show, above the slope they begin at. */
  feather: 15,
  /** The octaves of the noise that folds the beds. */
  octaves: 3,
  /** The slope of a fold's flank at full warp strength, as a tangent, where the noise is steepest. */
  fold: 0.4,
  /** How far the edge of a bed strays from its line at full warp strength, in beds, and the size of that raggedness, in bed thicknesses as lengths. */
  ragged: [0.35, 2],
} as const;

const strata = defineKernel({
  name: 'surface/strata',
  // src: the terrain. shape: the terrain smoothed over the radius, on which the beds are laid out.
  inputs: { src: 'field', shape: 'field' },
  outputs: { out: 'field' },
  // thickness: a height. dip: what a bed falls per terrain width, along x and y, in heights. band: the slopes over
  // which the beds come to show. warp: a height. cells: lattice cells of the warp across the terrain. ragged: a
  // height. raggedCells: lattice cells of the raggedness across the terrain.
  params: { thickness: 'f32', dip: 'vec2f', strength: 'f32', band: 'vec4f', warp: 'f32', cells: 'f32', texel: 'f32', ragged: 'f32', raggedCells: 'f32' },
  includes: [surfaceBeds, surfaceNoise, surfaceSlope],
  cost: 6 + 16 * STRATA.octaves,
  code: /* wgsl */ `
const CLIFF = ${STRATA.cliff};
const CLIFF_TEXELS = ${STRATA.cliffTexels}.0;
const UNEVEN = ${STRATA.uneven}.0;
const OCTAVES = ${STRATA.octaves};
const SOFTEST = ${STRATA.softest};

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let z = src_at(px);
  let slope = slopeAt(shape, px);
  // Rock shows on steep ground. Gentle ground is covered, and stays as it is.
  let show = P.strength * surfaceSlope_above(length(slope), P.band);
  if (show <= 0.0) { return z; }

  // The level of the terrain in the pile of beds, counted in beds: its height above the bedding plane through
  // the terrain's first corner, which falls towards the dip, and above the folds a broad noise bends the pile into.
  // A finer noise makes the edges of the beds ragged, as far as the grid holds it.
  let fold = surfaceNoise_fbmD(uv * P.cells, seedFor(1u), OCTAVES, 0.5, 1.0e6);
  let rag = surfaceNoise_fbmD(uv * P.raggedCells, seedFor(2u), OCTAVES, 0.5, 1.0 / (P.raggedCells * P.texel));
  let s = (shape_at(px) + dot(P.dip, uv) + P.warp * fold.x + P.ragged * rag.x) / P.thickness;
  // How far that level changes from one texel to the next.
  let g = length(slope * (frame.cellSize / frame.heightRange) + (P.dip + P.warp * P.cells * fold.yz + P.ragged * P.raggedCells * rag.yz) * P.texel) / P.thickness;

  let seed = seedFor(0u);
  let bed = surfaceBeds_find(s, UNEVEN, seed);
  let own = bed.hi - bed.lo;
  let t = saturate((s - bed.lo) / own);
  // Every bed is a ledge of hard rock under soft rock, and how hard the ledge is differs from bed to bed. A hard
  // one stands out of the slope as a cliff, with the soft rock above it lying back as a bench; a soft one wears
  // with its bed, and the slope runs through. The ground is only ever raised, by less than the bed is thick. A
  // cliff narrower than the grid can draw takes more of its bed, and a bed too thin to hold one is left as it is.
  let hard = hash_unit(hash_cell(vec2i(bed.index, 1), seed));
  let stand = show * (SOFTEST + (1.0 - SOFTEST) * hard);
  let cliff = clamp(CLIFF_TEXELS * g / own, CLIFF, 1.0);
  var stood = 1.0 - (1.0 - stand) * (1.0 - t);
  if (t < cliff) { stood = (1.0 + (1.0 - cliff) * stand / cliff) * t; }
  return z + P.thickness * own * (stood - t);
}`,
});

export default defineNode({
  type: 'surface/strata',
  title: 'Strata',
  category: 'surface',
  description: 'Lays tilted rock layers of varying hardness into steep ground: hard beds stand out as cliffs and soft ones lie back as benches.',
  keywords: ['layers', 'beds', 'sediment', 'stratify', 'cliffs', 'ledges', 'rock', 'cuesta', 'geology'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'float', name: 'thickness', label: 'Thickness', unit: 'height', default: 0.1, min: 0.002, max: 0.5, scale: 'log', soft: true,
      help: 'How thick a layer is, measured upwards. Larger values give fewer, taller cliffs.',
    },
    param.angle({ label: 'Dip direction', help: 'The direction in which the layers slope down. Larger values turn it clockwise in the top view.' }),
    param.slope('tilt', { label: 'Tilt', default: 15, max: 80, help: 'How steeply the layers slope down. At 0 they lie level.' }),
    param.strength({ help: 'Larger values let the hard beds stand further out of the slope, which makes taller cliffs and flatter benches.' }),
    param.slope('slopeMin', { label: 'Lower slope', default: 15, help: 'The layers show on ground steeper than this, and in full a little above it. Gentler ground stays as it is.' }),
    param.strength({ name: 'warpStrength', label: 'Warp strength', default: 0.4, help: 'Larger values fold the layers into deeper waves and make their edges more ragged.' }),
    param.size({ name: 'warpSize', label: 'Warp size', default: 0.3, help: 'Larger values fold the layers in broader waves.' }),
    param.radius({
      label: 'Edge smoothing', default: 0.004,
      help: 'Features of the terrain smaller than this do not shape the edges of the layers. Larger values draw them in cleaner lines.',
    }),
    param.seed(),
  ],
  kernels: [strata],
  maskable: true,
  evaluate(ctx) {
    const { strength, warpStrength } = ctx.params;
    const src = ctx.input('in');
    if (strength <= 0) {
      ctx.output('out', src);
      return;
    }
    // Soft parameters: any finite number can arrive.
    const thickness = Math.min(Math.max(ctx.params.thickness, 1e-4), 4);
    const warpSize = Math.min(Math.max(ctx.params.warpSize, 1e-3), 1000);
    const turn = (ctx.params.angle * Math.PI) / 180;
    // The tilt is a physical angle: a bed falls its tangent in metres per metre, which is this many heights per terrain width.
    const fall = (Math.tan((ctx.params.tilt * Math.PI) / 180) * ctx.terrainSize) / ctx.heightRange;
    // Folds finer than the grid holds would move the beds from texel to texel: they are faded out before that.
    const held = Math.min(Math.max(ctx.lengthToPx(warpSize) / 8 - 1, 0), 1);
    // The beds follow the terrain smoothed over the radius: the contour lines of a rough terrain turn at every
    // texel, and a cliff drawn along them is ragged. Smoothed without anything assumed beyond the border.
    const shape = ops.smooth(ctx, src, Math.min(Math.max(ctx.params.radius, 0), 4));
    const out = ctx.alloc('field');
    ctx.run(strata, {
      in: { src, shape },
      out: { out },
      params: {
        thickness,
        // The level of a point in the pile rises towards the dip: the beds fall away under it.
        dip: [fall * Math.cos(turn), fall * Math.sin(turn)],
        strength,
        band: slopeBand(ctx.params.slopeMin, ctx.params.slopeMin + STRATA.feather),
        // A fold of the warp size whose flanks have the slope of STRATA.fold where the noise is steepest (about 2 a lattice cell).
        warp: (warpStrength * held * STRATA.fold * warpSize * ctx.terrainSize) / (2 * ctx.heightRange),
        cells: 1 / warpSize,
        texel: 1 / Math.max(ctx.res - 1, 1),
        ragged: warpStrength * STRATA.ragged[0] * thickness,
        // As broad as a few beds are thick: a thickness is a height, which is this long at a slope of 1.
        raggedCells: Math.min(ctx.terrainSize / (STRATA.ragged[1] * thickness * ctx.heightRange), 1e6),
      },
    });
    ctx.release(shape);
    ctx.output('out', out);
  },
});
