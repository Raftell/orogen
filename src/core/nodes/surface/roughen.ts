// src/core/nodes/surface/roughen.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { surfaceNoise } from './_noise.ts';
import { slopeBand, surfaceSlope } from './_slope.ts';

/** The constants of the kernel, which the tests read. */
export const ROUGHEN = {
  /** The layers of roughness: the first as broad as the size, each further one half as broad. */
  octaves: 6,
  /** What each layer keeps of the height of the one before: at a half every layer is as steep as the one before, and the ground is as rough close up as from afar. */
  gain: 0.5,
  /** The most the ground is moved at full strength, in falls of a slope of 1 across the size. */
  relief: 0.4,
  /** The slopes, in degrees, between which ground counts from level to steep for the slope bias. */
  steep: [10, 45],
  /** The slope is that of the terrain smoothed over this part of the size. */
  ground: 0.5,
} as const;

const roughen = defineKernel({
  name: 'surface/roughen',
  // src: the terrain. ground: the terrain smoothed, whose slope says how rough the ground is to be.
  inputs: { src: 'field', ground: 'field' },
  outputs: { out: 'field' },
  // cells: lattice cells of the first layer across the terrain. relief: the most the ground is moved, a height.
  // bias: how much of the roughness is kept for steep ground. band: level to steep. texels: the width of a cell.
  params: { cells: 'f32', relief: 'f32', bias: 'f32', band: 'vec4f', texels: 'f32' },
  includes: [surfaceNoise, surfaceSlope],
  cost: 6 + 8 * ROUGHEN.octaves,
  code: /* wgsl */ `
const OCTAVES = ${ROUGHEN.octaves};
const GAIN = ${ROUGHEN.gain};

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // Every layer the grid can hold. A finer grid holds more of them, and what both hold is the same on both.
  let rough = surfaceNoise_fbmD(uv * P.cells, seedFor(0u), OCTAVES, GAIN, P.texels).x;
  let steep = surfaceSlope_above(length(slopeAt(ground, px)), P.band);
  return src_at(px) + P.relief * mix(1.0, steep, P.bias) * rough;
}`,
});

export default defineNode({
  type: 'surface/roughen',
  title: 'Roughen',
  category: 'surface',
  description: 'Adds fine roughness in several layers of detail, more of it on steep ground than on level ground.',
  keywords: ['detail', 'noise', 'bumps', 'grain', 'texture', 'rugged', 'displace', 'microdetail'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.size({ default: 0.05, help: 'How broad the broadest bumps are. Finer layers of detail are added below it, and the bumps grow taller with it.' }),
    param.strength({ help: 'Larger values make the bumps taller and the surface rougher.' }),
    {
      kind: 'float', name: 'slopeBias', label: 'Slope bias', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Larger values keep the roughness for steep ground and leave gentle ground smoother. At 0 all ground is equally rough.',
    },
    param.seed(),
  ],
  kernels: [roughen],
  maskable: true,
  evaluate(ctx) {
    const { strength, slopeBias } = ctx.params;
    const src = ctx.input('in');
    const size = Math.min(Math.max(ctx.params.size, 1e-4), 4);   // soft: any finite number can arrive
    if (strength <= 0) {
      ctx.output('out', src);
      return;
    }
    // How steep the ground is, without what is smaller than the bumps. Smoothed without anything assumed
    // beyond the border, so the ground keeps its slope there.
    const ground = ops.smooth(ctx, src, ROUGHEN.ground * size);
    const out = ctx.alloc('field');
    ctx.run(roughen, {
      in: { src, ground },
      out: { out },
      params: {
        cells: 1 / size,
        // A height as tall as the size is broad at a slope of 1, times the relief.
        relief: (strength * ROUGHEN.relief * size * ctx.terrainSize) / ctx.heightRange,
        bias: slopeBias,
        band: slopeBand(ROUGHEN.steep[0], ROUGHEN.steep[1]),
        texels: ctx.lengthToPx(size),
      },
    });
    ctx.release(ground);
    ctx.output('out', out);
  },
});
