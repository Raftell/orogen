// src/core/nodes/filter/slope-blur.ts
import { defineKernel, defineNode, ops, param, type Field } from '../../api.ts';
import { filterFlow } from './_flow.ts';

/** The points of one pass along the path uphill: 7 readings between texels and 7 steps, 58 loads, within the 64 of engine.md 3.15. */
const TAPS = 7;

// One pass of the smear: the mean of the picture at TAPS points of the path that leads uphill from the texel,
// following the slope of the guide. What lies uphill of a point is thereby drawn down to it.
//
// The passes of a long smear are nested: the first averages over a seventh of the next one's step, and so on,
// so that together they are the mean over 7, 49, 343 ... points of the whole path, evenly spaced. Only the first
// begins half a step up the path, which centres the points of all of them on the same stretch.
const smear = (kind: 'field' | 'color') => defineKernel({
  name: `filter/slope-blur.smear#${kind}`,
  inputs: { src: kind, base: kind, guide: 'field' },
  outputs: { out: kind },
  params: { stride: 'f32', lead: 'f32', strength: 'f32' },     // texels along the path; the share of the smear in the result
  includes: [filterFlow],
  cost: 8 * TAPS + 2,
  code: /* wgsl */ `
const TAPS = ${TAPS};

// One step up the path from the position at. On level ground it is short; at the border the path stops.
fn uphill(at: vec2f, flow: vec2f, step: f32) -> vec2f {
  return clamp(at + step * flow, vec2f(0.0), vec2f(frame.res) - vec2f(1.0));
}

fn compute(px: vec2i, uv: vec2f) -> out_t {
  // The path starts on the texel, where the slope is that of the texel, and goes on between texels.
  var at = vec2f(px);
  var flow = filterFlow_at(guide, px);
  if (P.lead > 0.0) {
    at = uphill(at, flow, P.lead);
    flow = filterFlow_lerp(guide, at);
  }
  // Summed as differences from the texel: a flat picture stays flat and an opaque color opaque, bit for bit.
  let anchor = src_at(px);
  var sum = out_t(0.0);
  for (var i = 0; i < TAPS; i++) {
    sum += src_lerp(at) - anchor;
    if (i + 1 < TAPS) {
      at = uphill(at, flow, P.stride);
      flow = filterFlow_lerp(guide, at);
    }
  }
  let smeared = anchor + sum / f32(TAPS);
  let b = base_at(px);
  return select(select(mix(b, smeared, P.strength), smeared, P.strength >= 1.0), b, P.strength <= 0.0);
}`,
});
const smears = { field: smear('field'), color: smear('color') };

// A color has no height: without a guide, its brightness stands in for one.
const brightness = defineKernel({
  name: 'filter/slope-blur.brightness',
  inputs: { src: 'color' },
  outputs: { out: 'field' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return dot(src_at(px).rgb, vec3f(0.2126, 0.7152, 0.0722));
}`,
});

export default defineNode({
  type: 'filter/slope-blur',
  title: 'Slope Blur',
  category: 'filter',
  description: 'Smears a terrain or a color map downhill along the slopes of a guide terrain, which draws gullies and streaks into it.',
  keywords: ['smear', 'flow', 'streak', 'gully', 'erode', 'drag'],
  inputs: [
    { name: 'in', type: 'any' },
    { name: 'guide', type: 'field', optional: true },
  ],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    param.radius({ default: 0.05, min: 0.001, max: 0.25, help: 'How far downhill a point is smeared. Larger values draw longer streaks and deeper gullies.' }),
    param.strength({ help: 'Larger values replace more of the picture by its smear.' }),
    param.radius({
      name: 'guideRadius', label: 'Guide smoothing', default: 0.02,
      help: 'Features of the guide smaller than this do not steer the smear. Larger values give straighter, broader streaks.',
    }),
  ],
  kernels: [smears.field, smears.color, brightness],
  maskable: true,
  async evaluate(ctx) {
    const src = ctx.input('in');
    const { strength } = ctx.params;
    const reach = ctx.lengthToPx(Math.min(Math.max(ctx.params.radius, 0), 1));   // soft: any finite number can arrive
    // A smear that ends within a quarter of a texel, or of which nothing is taken, leaves the picture as it is.
    if (strength <= 0 || reach < 0.25) {
      ctx.output('out', src);
      return;
    }

    // The guide: the one connected, else the picture itself, a color by its brightness. It is smoothed over a
    // length, so that the paths are the same at every resolution and are not caught on every bump of a rough one.
    let guide: Field<'field'>;
    let own: Field<'field'> | null = null;
    const connected = ctx.input('guide');
    if (connected) guide = connected;
    else if (src.kind === 'field') guide = src;
    else {
      own = ctx.alloc('field');
      ctx.run(brightness, { in: { src }, out: { out: own } });
      guide = own;
    }
    const smoothing = Math.min(Math.max(ctx.params.guideRadius, 0), 4);
    if (Math.floor(3 * ctx.lengthToPx(smoothing)) >= 1) {
      const smooth = ops.blur(ctx, guide, smoothing);
      if (own) ctx.release(own);
      own = smooth;
      guide = smooth;
    }

    // As many nested passes as bring the step of the first down to a texel.
    const count = Math.max(1, Math.ceil(Math.log(reach) / Math.log(TAPS) - 1e-9));
    const finest = reach / TAPS ** count;
    const targets = [ctx.alloc(src.kind), count > 1 ? ctx.alloc(src.kind) : null];
    let current: Field<'field'> | Field<'color'> = src;
    await ctx.loop(count, (i) => {
      const out = targets[i % 2]!;
      const stride = finest * TAPS ** i;
      ctx.run(smears[src.kind], {
        in: { src: current, base: src, guide },
        out: { out },
        params: { stride, lead: i === 0 ? stride / 2 : 0, strength: i === count - 1 ? strength : 1 },
      });
      current = out;
    });
    for (const target of targets) if (target && target !== current) ctx.release(target);
    if (own) ctx.release(own);
    ctx.output('out', current);
  },
});
