// src/core/nodes/filter/twirl.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { CUBIC_LOADS, filterSample } from './_sample.ts';

const READ = {
  field: 'return filterSample_cubic(src, pos, 0u, vec4f(0.0)).r;',
  color: 'return filterSample_cubic(src, pos, 0u, vec4f(0.0));',
} as const;

const twist = (kind: 'field' | 'color') => defineKernel({
  name: `filter/twirl#${kind}`,
  inputs: { src: kind },
  outputs: { out: kind },
  params: { centre: 'vec2f', radius: 'f32', angle: 'f32' },   // texels, texels, radians: positive is clockwise in the top view
  includes: [filterSample],
  cost: CUBIC_LOADS,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let q = vec2f(px) - P.centre;
  let r = length(q);
  var pos = vec2f(px);            // outside the radius the picture is read at its own vertices: untouched
  if (r < P.radius) {
    // The turn falls from the full angle at the centre to none at the radius, and levels out there, so that the
    // twisted part joins the rest without a crease. The source lies turned back by what the picture is turned.
    let rest = 1.0 - r / P.radius;
    let a = -P.angle * rest * rest;
    let c = cos(a);
    let s = sin(a);
    pos = P.centre + vec2f(c * q.x - s * q.y, s * q.x + c * q.y);
  }
  ${READ[kind]}
}`,
});
const kernels = { field: twist('field'), color: twist('color') };

export default defineNode({
  type: 'filter/twirl',
  title: 'Twirl',
  category: 'filter',
  description: 'Twists a terrain or a color map around a point, most at the point and not at all beyond a radius.',
  keywords: ['twist', 'swirl', 'spiral', 'vortex', 'whirl'],
  inputs: [{ name: 'in', type: 'any' }],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    param.angle({ label: 'Angle', default: 120, help: 'How far the picture is turned at the center. Larger values wind the spiral tighter.' }),
    param.radius({ default: 0.4, min: 0.01, max: 1, help: 'Larger values twist a wider area around the center.' }),
    {
      kind: 'vec2', name: 'center', label: 'Center', unit: 'length', default: [0.5, 0.5], min: 0, max: 1, soft: true,
      help: 'The point the picture is twisted around, from the left and from the top of the terrain.',
    },
    {
      kind: 'enum', name: 'mode', label: 'Direction', default: 'clockwise',
      options: [
        { value: 'clockwise', label: 'Clockwise' },
        { value: 'counterclockwise', label: 'Counterclockwise' },
      ],
      help: 'The way the picture is turned, as seen in the top view.',
    },
  ],
  kernels: [kernels.field, kernels.color],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const { angle, center, mode } = ctx.params;
    const radius = ctx.lengthToPx(Math.min(Math.max(ctx.params.radius, 0), 8));   // soft: any finite number can arrive
    // Nothing is turned, or nothing lies within the radius: the input itself is the output.
    if (angle === 0 || radius <= 0) {
      ctx.output('out', src);
      return;
    }
    const last = ctx.res - 1;
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], {
      in: { src },
      out: { out },
      params: {
        centre: [center[0] * last, center[1] * last],
        radius,
        angle: (mode === 'clockwise' ? 1 : -1) * (angle * Math.PI) / 180,
      },
    });
    ctx.output('out', out);
  },
});
