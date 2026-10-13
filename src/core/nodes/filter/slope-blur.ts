// src/core/nodes/filter/slope-blur.ts
import { convert, defineKernel, defineNode, ops, param, type Field } from '../../api.ts';
import { filterFlow } from './_flow.ts';

/** The points of one pass along a path beside the texel itself: 6 readings between texels and up to 4 steps to each, 49 loads, within the 64 of engine.md 3.15. */
const TAPS = 6;
const MAX_SUBSTEPS = 4;
/** Each pass reads the result of the one before at points this many times as far apart. */
const NEST = TAPS + 1;

type Img = 'field' | 'color';

// The step uphill at every texel of the smoothed guide, in texels per texel of path: a direction with a length
// that grows from 0 on level ground to 1 on steep ground (_flow.ts). Made once, so that a path costs one load a step.
const flowOf = defineKernel({
  name: 'filter/slope-blur.flow',
  inputs: { guide: 'field' },
  outputs: { out: 'vec2' },
  includes: [filterFlow],
  cost: 4,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> vec2f {
  return filterFlow_at(guide, px);
}`,
});

// One pass along the path that leads from the texel up the slope of the guide (way 1) or down it (way -1): TAPS
// points P.stride texels apart, each reached by a few steps along the flow of the texel the path is over.
//
// The passes of a long path are nested: the first has points a texel or less apart, and each further one reads
// the result of the one before at points seven times as far apart, so that together they cover 7, 49, 343 ...
// points of the whole path. A point counts for less the farther up the path it lies (P.fade a point): what is
// smeared thins out down the slope and does not end in a step.
//
// P.lowest 0: the weighted mean of the points. P.lowest 1: the lowest of them, each pulled towards the texel's
// own value by what it does not count for.
const trace = (kind: Img) => defineKernel({
  name: `filter/slope-blur.trace#${kind}`,
  inputs: { src: kind, flow: 'vec2' },
  outputs: { out: kind },
  params: { stride: 'f32', way: 'f32', substeps: 'i32', fade: 'f32', lowest: 'u32' },
  cost: 1 + TAPS * (MAX_SUBSTEPS + 4),
  code: /* wgsl */ `
const TAPS = ${TAPS};
const MAX_SUBSTEPS = ${MAX_SUBSTEPS};

fn compute(px: vec2i, uv: vec2f) -> out_t {
  let last = vec2f(frame.res) - vec2f(1.0);
  let substeps = clamp(P.substeps, 1, MAX_SUBSTEPS);
  let step = P.way * P.stride / f32(substeps);
  let own = src_at(px);
  var at = vec2f(px);
  // Both are kept as differences from the texel: a flat picture stays flat and an opaque color opaque, bit for bit.
  var sum = out_t(0.0);
  var drop = out_t(0.0);
  var weight = 1.0;
  for (var i = 1; i <= TAPS; i++) {
    for (var j = 0; j < substeps; j++) {
      // On level ground the flow has no length and the path stays where it is; at the border it stops.
      at = clamp(at + step * flow_at(vec2i(round(at))), vec2f(0.0), last);
    }
    let w = max(1.0 - f32(i) * P.fade, 0.0);
    let d = w * (src_lerp(at) - own);
    sum += d;
    drop = min(drop, d);
    weight += w;
  }
  if (P.lowest != 0u) { return own + drop; }
  return own + sum / weight;
}`,
});
const traces = { field: trace('field'), color: trace('color') };

// What of the picture is finer than the smoothing: only this is carved in the mode "gullies".
const detailOf = (kind: Img) => defineKernel({
  name: `filter/slope-blur.detail#${kind}`,
  inputs: { src: kind, low: kind },
  outputs: { out: kind },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  return src_at(px) - low_at(px);
}`,
});
const details = { field: detailOf('field'), color: detailOf('color') };

const OPAQUE = { field: 'v', color: 'vec4f(v.rgb, s.a)' } as const;

// The result, and of it the share P.strength. A smear is the result as the passes made it. Gullies (P.carve): the
// picture, lowered by what the passes cut from its detail, but never to the base level: the cut wears off as it
// uses up the room between the picture and the lowest ground downhill of it, so that the foot of a mountain, a
// valley floor and a plain stay at their level and no gully ends on a flat bed. A color keeps its alpha.
const finish = (kind: Img) => defineKernel({
  name: `filter/slope-blur.finish#${kind}`,
  inputs: { src: kind, part: kind, low: { kind, default: 0 }, base: { kind, default: 0 } },
  outputs: { out: kind },
  params: { strength: 'f32', carve: 'u32' },
  cost: 4,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let s = src_at(px);
  var made = part_at(px);
  if (P.carve != 0u) {
    // The detail is computed again as the pass before the first made it: where nothing was cut the two are the
    // same number, the cut is 0 and the result the picture itself, bit for bit.
    let cut = min(made - (s - low_at(px)), out_t(0.0));
    let room = max(s - base_at(px), out_t(0.0));
    made = s - room * (out_t(1.0) - exp(cut / max(room, out_t(1.0e-12))));
  }
  // The two ends are selected: at full strength the result is what was made, bit for bit.
  let v = select(s + P.strength * (made - s), made, P.strength >= 1.0);
  return ${OPAQUE[kind]};
}`,
});
const finishes = { field: finish('field'), color: finish('color') };

// A color has no height: without a guide, its brightness stands in for one.
const brightness = defineKernel({
  name: 'filter/slope-blur.brightness',
  inputs: { src: 'color' },
  outputs: { out: 'field' },
  includes: [convert],
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  return convert_luma(src_at(px));
}`,
});

interface Pass { readonly stride: number; readonly substeps: number; readonly fade: number }

/**
 * The nested passes of a path of `reach` texels: as many as bring the stride of the first down to a texel. With
 * `fading`, a point counts for less in proportion to how far up the whole path it lies.
 */
function passes(reach: number, fading: boolean): Pass[] {
  const count = Math.max(1, Math.ceil(Math.log(reach) / Math.log(NEST) - 1e-9));
  const finest = reach / NEST ** count;
  return Array.from({ length: count }, (_, i) => {
    const stride = finest * NEST ** i;
    // A step of the path is a texel at most, until the stride is too long for four of them.
    return { stride, substeps: Math.min(Math.max(Math.ceil(stride), 1), MAX_SUBSTEPS), fade: fading ? stride / reach : 0 };
  });
}

export default defineNode({
  type: 'filter/slope-blur',
  title: 'Slope Blur',
  category: 'filter',
  description: 'Smears a terrain or a color map downhill along the slopes of a guide terrain, which draws gullies and streaks into it.',
  keywords: ['smear', 'flow', 'streak', 'gully', 'erode', 'drag', 'rill'],
  inputs: [
    { name: 'in', type: 'any' },
    { name: 'guide', type: 'field', optional: true },
  ],
  outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  params: [
    param.radius({ default: 0.1, min: 0.001, max: 0.25, help: 'How far downhill a point is smeared. Larger values draw longer gullies and streaks.' }),
    param.strength({ help: 'Larger values replace more of the picture by its smear.' }),
    {
      kind: 'enum', name: 'mode', label: 'Mode', default: 'gullies',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'gullies', label: 'Gullies' },
        { value: 'smear', label: 'Smear' },
      ],
      help: 'Gullies draws every low point of the fine detail down the slope as a channel and never raises the ground. Smear averages the whole picture down the slope.',
    },
    param.radius({
      name: 'guideRadius', label: 'Guide smoothing', default: 0.03,
      help: 'Features smaller than this do not steer the smear, and gullies are cut from them. Larger values give straighter, broader streaks.',
    }),
  ],
  kernels: [flowOf, traces.field, traces.color, details.field, details.color, finishes.field, finishes.color, brightness],
  maskable: true,
  async evaluate(ctx) {
    const src = ctx.input('in');
    const kind = src.kind;
    const { strength, mode } = ctx.params;
    const reach = ctx.lengthToPx(Math.min(Math.max(ctx.params.radius, 0), 1));   // soft: any finite number can arrive
    const smoothing = Math.min(Math.max(ctx.params.guideRadius, 0), 4);
    const smoothed = Math.floor(3 * ctx.lengthToPx(smoothing)) >= 1;
    // A smear that ends within a quarter of a texel, or of which nothing is taken, leaves the picture as it is;
    // and so do gullies when nothing is finer than the smoothing.
    if (strength <= 0 || reach < 0.25 || (mode === 'gullies' && !smoothed)) {
      ctx.output('out', src);
      return;
    }

    // The guide: the one connected, else the picture itself, a color by its brightness. It is smoothed over a
    // length, so that the paths are the same at every resolution and are not caught on every bump of a rough one.
    const connected = ctx.input('guide');
    let guide: Field<'field'>;
    let own: Field<'field'> | null = null;
    if (connected) guide = connected;
    else if (src.kind === 'field') guide = src;
    else {
      own = ctx.alloc('field');
      ctx.run(brightness, { in: { src }, out: { out: own } });
      guide = own;
    }
    // The smoothed terrain is also what the gullies leave standing, when the terrain is its own guide. It is
    // smoothed without anything assumed beyond the border (ops.smooth): its slope steers and it is taken from the
    // picture, and a blur that continues the terrain level there would turn the paths and cut a frame of gullies.
    let low: Field<Img> | null = null;
    if (smoothed) {
      const smooth = ops.smooth(ctx, guide, smoothing);
      if (own) ctx.release(own);
      own = smooth;
      guide = smooth;
      if (mode === 'gullies' && !connected && src.kind === 'field') low = smooth;
    }
    const flow = ctx.alloc('vec2');
    ctx.run(flowOf, { in: { guide }, out: { out: flow } });
    if (own && own !== low) ctx.release(own);

    const run = traces[kind];
    /** The nested passes over `from`, which is overwritten unless `keep`; returns the field that holds the result. */
    const along = async (from: Field<Img>, keep: boolean, way: number, lowest: boolean, fading: boolean, progress: readonly [number, number]): Promise<Field<Img>> => {
      const plan = passes(reach, fading);
      const first = ctx.alloc(kind);
      const second = keep ? (plan.length > 1 ? ctx.alloc(kind) : null) : from;
      let current = from;
      await ctx.loop(plan.length, (i) => {
        const { stride, substeps, fade } = plan[i]!;
        const out = (i % 2 === 0 ? first : second)!;
        ctx.run(run, {
          in: { src: current, flow },
          out: { out },
          params: { stride, way, substeps, fade, lowest },
          cost: 1 + TAPS * (substeps + 4),
        });
        current = out;
      }, { progress });
      for (const target of [first, second]) if (target && target !== current) ctx.release(target);
      return current;
    };

    let part: Field<Img>;
    let floor: Field<Img> | null = null;
    if (mode === 'smear') {
      part = await along(src, true, 1, false, true, [0, 1]);
    } else {
      // No gully is cut below the lowest ground on the path that leads down from it: the foot of a mountain,
      // a valley floor and a plain stay at their level.
      floor = await along(src, true, -1, true, false, [0, 0.5]);
      low ??= ops.smooth(ctx, src, smoothing);
      const detail = ctx.alloc(kind);
      ctx.run(details[kind], { in: { src, low }, out: { out: detail } });
      part = await along(detail, false, 1, true, true, [0.5, 1]);
    }
    ctx.release(flow);

    const out = ctx.alloc(kind);
    ctx.run(finishes[kind], { in: { src, part, low, base: floor }, out: { out }, params: { strength, carve: mode === 'gullies' } });
    ctx.release(part);
    if (low) ctx.release(low);
    if (floor) ctx.release(floor);
    ctx.output('out', out);
  },
});
