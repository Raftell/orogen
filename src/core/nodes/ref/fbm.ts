// src/core/nodes/ref/fbm.ts
import { defineKernel, defineNode, noise, param } from '../../api.ts';

const fbm = defineKernel({
  name: 'ref/fbm',
  outputs: { out: 'field' },
  params: { cells: 'f32', octaves: 'i32', gain: 'f32' },
  includes: [noise],
  code: /* wgsl */ `
const SPREAD = 1.6;   // fixed normalisation constant; to calibrate against the generator range rule (1.7)

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let n = noise_fbm(uv * P.cells, seedFor(0u), clamp(P.octaves, 1, 16), 2.0, P.gain);
  return 0.5 + 0.5 * SPREAD * n;
}`,
});

export default defineNode({
  type: 'ref/fbm',
  title: 'Fractal Noise (Reference)',
  category: 'ref',
  description: 'Generates fractal gradient noise; the reference node for generators.',
  keywords: ['perlin', 'fbm', 'noise'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.seed(),
    param.size(),
    param.octaves(),
    param.gain(),
  ],
  kernels: [fbm],
  evaluate(ctx) {
    const { size, octaves, gain } = ctx.params;
    const out = ctx.alloc('field');
    ctx.run(fbm, {
      out: { out },
      params: { cells: 1 / Math.max(size, 0.001), octaves, gain },   // size is a length: 1 / size lattice cells across the terrain
      cost: 8 * octaves,
    });
    ctx.output('out', out);
  },
});
