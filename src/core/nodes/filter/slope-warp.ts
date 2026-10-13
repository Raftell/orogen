// src/core/nodes/filter/slope-warp.ts
import { defineKernel, defineNode, ops, param } from '../../api.ts';
import { filterFlow } from './_flow.ts';
import { CUBIC_LOADS, filterSample } from './_sample.ts';

/** The steps of the path a point is read along: 4 loads each and 16 for the reading, 60 in all, within the 64 of engine.md 3.15. */
const STEPS = 11;

const push = defineKernel({
  name: 'filter/slope-warp',
  inputs: { src: 'field', shape: 'field' },
  outputs: { out: 'field' },
  params: { reach: 'f32' },      // texels; positive reads uphill, which moves the terrain downhill
  includes: [filterFlow, filterSample],
  cost: CUBIC_LOADS + 4 * STEPS,
  code: /* wgsl */ `
const STEPS = ${STEPS};

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // The place a texel is read from is found by following the slope of the smoothed terrain, not by one stride
  // along the slope at the texel: a stride would carry it across a crest and read the far side. The pace of the
  // path is in proportion to the slope, up to 45 degrees: it slows down towards a crest or a hollow and does not
  // reach it, so that the ground around a summit is not all read from the summit. On level ground the path does
  // not leave the texel, and the terrain is read at its own vertex.
  let last = vec2f(frame.res) - vec2f(1.0);
  let step = P.reach / f32(STEPS);
  var at = vec2f(px);
  var pace = filterFlow_push(slopeAt(shape, px));
  for (var i = 0; i < STEPS; i++) {
    at = clamp(at + step * pace, vec2f(0.0), last);
    if (i + 1 < STEPS) { pace = filterFlow_push(filterFlow_slope(shape, at)); }
  }
  return filterSample_cubic(src, at, 0u, vec4f(0.0)).r;
}`,
});

export default defineNode({
  type: 'filter/slope-warp',
  title: 'Slope Warp',
  category: 'filter',
  description: 'Pushes the features of a terrain down or up its own slopes, which swells ridges and pinches valleys or the reverse.',
  keywords: ['displace', 'inflate', 'pinch', 'push', 'distort'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    {
      kind: 'float', name: 'distance', label: 'Distance', unit: 'length', default: 0.02, min: 0.0005, max: 0.25, scale: 'log', soft: true,
      help: 'How far the features are pushed on steep ground. Larger values swell or pinch them more.',
    },
    {
      kind: 'enum', name: 'mode', label: 'Direction', default: 'downhill',
      options: [
        { value: 'downhill', label: 'Downhill' },
        { value: 'uphill', label: 'Uphill' },
      ],
      help: 'Downhill spreads the heights down the slopes: ridges and peaks swell, valleys narrow to creases. Uphill does the reverse.',
    },
    param.radius({ label: 'Slope smoothing', default: 0.01, help: 'The slope is measured on the terrain smoothed by this much. Larger values follow the broad shape and ignore small bumps.' }),
  ],
  kernels: [push],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const reach = ctx.lengthToPx(Math.min(Math.max(ctx.params.distance, 0), 4));   // soft: any finite number can arrive
    if (reach <= 0) {
      ctx.output('out', src);
      return;
    }
    const radius = Math.min(Math.max(ctx.params.radius, 0), 4);
    // Its slope is what pushes: smoothed as ops.smooth does it, the terrain keeps its slope up to the border.
    const smooth = Math.floor(3 * ctx.lengthToPx(radius)) >= 1 ? ops.smooth(ctx, src, radius) : null;
    const out = ctx.alloc('field');
    ctx.run(push, { in: { src, shape: smooth ?? src }, out: { out }, params: { reach: ctx.params.mode === 'downhill' ? reach : -reach } });
    if (smooth) ctx.release(smooth);
    ctx.output('out', out);
  },
});
