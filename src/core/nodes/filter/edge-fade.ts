// src/core/nodes/filter/edge-fade.ts
import { defineKernel, defineNode, param } from '../../api.ts';

const fade = defineKernel({
  name: 'filter/edge-fade',
  inputs: { src: 'field' },
  outputs: { out: 'field' },
  params: { width: 'f32', level: 'f32', round: 'u32' },
  cost: 1,
  code: /* wgsl */ `
// How much of the terrain is left at a distance d inside the outer edge of the fading band: none on the edge,
// all of it from the width inwards, and level at both ends.
fn kept(d: f32) -> f32 {
  return smoothstep(0.0, 1.0, saturate(d / max(P.width, 1.0e-6)));
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // Square: the product of the fades from the two pairs of borders, which meets in the corners without the
  // crease along the diagonals that the distance to the nearest border has. Round: the distance from the circle
  // that touches the four borders; outside it, in the corners, nothing is left.
  var t = kept(min(uv.x, 1.0 - uv.x)) * kept(min(uv.y, 1.0 - uv.y));
  if (P.round != 0u) { t = kept(0.5 - length(uv - vec2f(0.5))); }
  let s = src_at(px);
  // The two ends are selected: beyond the band the terrain is untouched, and on the edge it is the level, bit for bit.
  return select(select(mix(P.level, s, t), s, t >= 1.0), P.level, t <= 0.0);
}`,
});

export default defineNode({
  type: 'filter/edge-fade',
  title: 'Edge Fade',
  category: 'filter',
  description: 'Fades a terrain to one level toward its borders, so that it ends in a plain, a seabed or a plateau.',
  keywords: ['border', 'falloff', 'vignette', 'island', 'frame'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'float', name: 'width', label: 'Width', unit: 'length', default: 0.15, min: 0.001, max: 0.5, scale: 'log', soft: true,
      help: 'How far in from the borders the fade reaches. Larger values leave less of the terrain untouched.',
    },
    param.height({ label: 'Level', default: 0, help: 'The height the terrain has at its borders. Larger values end it on higher ground.' }),
    {
      kind: 'enum', name: 'mode', label: 'Shape', default: 'square',
      options: [
        { value: 'square', label: 'Square' },
        { value: 'round', label: 'Round' },
      ],
      help: 'Square fades along the four borders; round fades outside a circle that touches them, corners included.',
    },
  ],
  kernels: [fade],
  maskable: true,
  evaluate(ctx) {
    const { width, height } = ctx.params;
    const out = ctx.alloc('field');
    ctx.run(fade, {
      in: { src: ctx.input('in') },
      out: { out },
      // Soft: a width of nothing or less is a hard edge on the border itself.
      params: { width: Math.max(width, 0), level: height, round: ctx.enumIndex('mode') === 1 },
    });
    ctx.output('out', out);
  },
});
