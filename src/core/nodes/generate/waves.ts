// src/core/nodes/generate/waves.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { generateNoise, warpReach } from './_noise.ts';

const waves = defineKernel({
  name: 'generate/waves',
  outputs: { out: 'field' },
  params: { offset: 'vec2f', dir: 'vec2f', perSize: 'f32', warpCells: 'f32', warpReach: 'f32', mode: 'u32' },
  includes: [generateNoise],
  cost: 1,
  code: /* wgsl */ `
// The node has no seed (nodes.md): its warp is one fixed pattern, which moves with the offset.
const WARP_SEED = 1u;

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let w = generateNoise_warp(uv - P.offset, P.warpCells, P.warpReach, WARP_SEED);
  // Position within the wave, 0..1. A crest of the sine and of the triangle runs through the terrain's center.
  let along = dot(w - vec2f(0.5), P.dir) * P.perSize + 0.5;
  let t = along - floor(along);
  switch (P.mode) {                     // the index of the option, in the order the node lists them
    case 1u: { return 1.0 - abs(2.0 * t - 1.0); }
    case 2u: { return t; }
    case 3u: { return select(0.0, 1.0, t >= 0.25 && t < 0.75); }
    default: { return 0.5 - 0.5 * cos(6.283185307 * t); }
  }
}`,
});

export default defineNode({
  type: 'generate/waves',
  title: 'Waves',
  category: 'generate',
  description: 'Generates parallel waves that repeat one profile along a direction, straight or bent by a warp.',
  keywords: ['sine', 'stripes', 'ripples', 'bands', 'periodic', 'sawtooth', 'triangle', 'square', 'furrows'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'sine',
      options: [
        { value: 'sine', label: 'Sine' },
        { value: 'triangle', label: 'Triangle' },
        { value: 'saw', label: 'Saw' },
        { value: 'square', label: 'Square' },
      ],
      help: 'The profile of one wave: a smooth sine, straight flanks, a ramp with a cliff, or flat steps.',
    },
    param.size({ label: 'Wavelength', help: 'Larger values put the crests further apart.' }),
    param.angle({ help: 'The direction across the crests. Larger values turn the waves clockwise in the top view.' }),
    {
      kind: 'vec2', name: 'offset', label: 'Offset', unit: 'length', default: [0, 0], min: -1, max: 1, soft: true,
      help: 'Moves the waves, and the pattern that warps them, across the terrain.',
    },
    param.strength({ name: 'warpStrength', label: 'Warp', default: 0, group: 'Warp', help: 'Larger values bend the crests further out of line.' }),
    param.size({ name: 'warpSize', label: 'Warp size', default: 0.5, group: 'Warp', help: 'Larger values bend the crests in broader curves and move them further.' }),
  ],
  kernels: [waves],
  evaluate(ctx) {
    const { size, angle, offset, warpStrength, warpSize } = ctx.params;
    const r = (angle * Math.PI) / 180;
    const out = ctx.alloc('field');
    ctx.run(waves, {
      out: { out },
      params: {
        offset,
        dir: [Math.cos(r), Math.sin(r)],
        perSize: 1 / Math.max(size, 0.001),          // both sizes are soft: 0 and negative values arrive
        warpCells: 1 / Math.max(warpSize, 0.001),
        warpReach: warpReach(warpStrength, warpSize),
        mode: ctx.enumIndex('mode'),
      },
      cost: warpStrength > 0 ? 32 : 1,
    });
    ctx.output('out', out);
  },
});
