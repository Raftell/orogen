// src/core/nodes/filter/warp.ts
import { defineKernel, defineNode, noise, ops, param } from '../../api.ts';
import { filterFlow } from './_flow.ts';
import { CUBIC_LOADS, filterSample } from './_sample.ts';

const CHANNELS = { field: '.r', color: '' } as const;
const MAX_OCTAVES = 8;

const displace = (kind: 'field' | 'color') => defineKernel({
  name: `filter/warp#${kind}`,
  inputs: { src: kind, guide: { kind: 'field', default: 0 } },
  outputs: { out: kind },
  params: { reach: 'f32', cells: 'f32', octaves: 'i32' },      // texels; lattice cells of the noise across the terrain
  includes: [noise, filterFlow, filterSample],
  cost: CUBIC_LOADS + 4 + 16 * MAX_OCTAVES,
  code: /* wgsl */ `
const SPREAD = 1.6;   // fractal noise of several octaves stays within -1 / 1.6 .. 1 / 1.6 almost everywhere

// How far, as a share of the distance, and which way the picture is read from: up the slope of the guide when
// one is connected, in proportion to the slope, so that the picture moves down it; else by two noises of the
// place on the terrain.
fn offset(px: vec2i, uv: vec2f) -> vec2f {
  if (guide_bound()) { return filterFlow_push(slopeAt(guide, px)); }
  let octaves = clamp(P.octaves, 1, ${MAX_OCTAVES});
  let p = uv * P.cells;
  return SPREAD * vec2f(noise_fbm(p, seedFor(0u), octaves, 2.0, 0.5), noise_fbm(p, seedFor(1u), octaves, 2.0, 0.5));
}

fn compute(px: vec2i, uv: vec2f) -> out_t {
  let pos = vec2f(px) + P.reach * offset(px, uv);
  return filterSample_cubic(src, pos, 0u, vec4f(0.0))${CHANNELS[kind]};
}`,
});
const kernels = { field: displace('field'), color: displace('color') };

export default defineNode({
  type: 'filter/warp',
  title: 'Warp',
  category: 'filter',
  description: 'Distorts a terrain or a color map by pushing it about, along a noise or down the slopes of a guide.',
  keywords: ['distort', 'displace', 'domain warp', 'turbulence', 'perturb'],
  inputs: [
    { name: 'in', type: 'any' },
    { name: 'guide', type: 'field', optional: true },
  ],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    {
      kind: 'float', name: 'distance', label: 'Distance', unit: 'length', default: 0.04, min: 0.0005, max: 0.25, scale: 'log', soft: true,
      help: 'How far the picture is pushed where the push is strongest: where the noise peaks, or where the guide is steep. Larger values distort it more.',
    },
    param.size({ default: 0.2, help: 'Larger values bend the picture in broader sweeps of the noise. Unused with a guide.' }),
    param.octaves({ default: 3, max: MAX_OCTAVES, help: 'Larger values add finer wrinkles to the distortion. Unused with a guide.' }),
    param.radius({
      name: 'guideRadius', label: 'Guide smoothing', default: 0.03,
      help: 'Features of the guide smaller than this do not push the picture. Larger values follow its broad shape; smaller than the distance, they tear the picture.',
    }),
    param.seed(),
  ],
  kernels: [kernels.field, kernels.color],
  maskable: true,
  evaluate(ctx) {
    const src = ctx.input('in');
    const connected = ctx.input('guide');
    const { octaves } = ctx.params;
    const reach = ctx.lengthToPx(Math.min(Math.max(ctx.params.distance, 0), 4));   // soft: any finite number can arrive
    if (reach <= 0) {
      ctx.output('out', src);
      return;
    }
    // The guide is smoothed over a length, so that it pushes the same way at every resolution.
    const smoothing = Math.min(Math.max(ctx.params.guideRadius, 0), 4);
    const smooth = connected && Math.floor(3 * ctx.lengthToPx(smoothing)) >= 1 ? ops.blur(ctx, connected, smoothing) : null;
    const out = ctx.alloc(src.kind);
    ctx.run(kernels[src.kind], {
      in: { src, guide: smooth ?? connected },
      out: { out },
      // The size is a length: 1 / size lattice cells across the terrain. Soft as well.
      params: { reach, cells: 1 / Math.min(Math.max(ctx.params.size, 0.001), 1000), octaves },
      cost: CUBIC_LOADS + (connected ? 4 : 16 * octaves),
    });
    if (smooth) ctx.release(smooth);
    ctx.output('out', out);
  },
});
