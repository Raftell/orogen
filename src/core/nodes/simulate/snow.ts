// src/core/nodes/simulate/snow.ts
import { MASK_INPUT, defineKernel, defineNode, ops, param, type Field } from '../../api.ts';
import { DETAIL_ITERATIONS_RELAX, FEATURE_CELLS_RELAX, RELAX, SNOW_COVER, SUN_ELEVATION } from './_constants.ts';
import { layerLimit, simulateLayer } from './_layer.ts';
import { levelBudget, levelInput, refineKernels, refinePlane } from './_refine.ts';

/** The reach a typed value is held to: below it no level has a texel to move snow over, above it lies the whole terrain. */
const SIZE_MIN = 1e-4, SIZE_MAX = 1;

// `simulate/layer.move` with the source computed here: what falls on the texel in this iteration less what thaws.
const move = defineKernel({
  name: 'simulate/snow.move',
  inputs: { bed: 'field', layer: 'field', lim: 'field', mask: MASK_INPUT },
  outputs: { next: 'field' },
  // slip: the tangent of the slip angle. fall: the snowfall of this iteration, as a height. sun: the unit vector towards the sun.
  params: { slip: 'f32', fall: 'f32', snowLine: 'f32', band: 'f32', melt: 'f32', exposure: 'f32', sun: 'vec3f' },
  includes: [simulateLayer],
  cost: 38,
  code: /* wgsl */ `
fn surface(q: vec2i) -> f32 { return bed_at(q) + layer_at(q); }

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let h = surface(px);
  let alt = smoothstep(P.snowLine - P.band, P.snowLine + P.band, h);
  // The normal of the snow surface, from its N4 neighbours; a neighbour beyond the border reads the border texel.
  let run = 2.0 * frame.cellSize;
  let gx = (surface(px + vec2i(1, 0)) - surface(px - vec2i(1, 0))) * frame.heightRange / run;
  let gy = (surface(px + vec2i(0, 1)) - surface(px - vec2i(0, 1))) * frame.heightRange / run;
  let n = normalize(vec3f(-gx, -gy, 1.0));
  let lit = 1.0 + P.exposure * (saturate(dot(n, P.sun)) - 1.0);
  let source = P.fall * (mask_at(px) * alt - P.melt * lit * (2.0 - alt));
  let net = simulateLayer_net(bed, layer, lim, px, P.slip);
  return max(0.0, layer_at(px) + net / frame.heightRange + source);
}`,
});

const finish = defineKernel({
  name: 'simulate/snow.finish',
  inputs: { bed: 'field', layer: 'field' },
  outputs: { out: 'field', snow: 'field' },
  params: { cover: 'f32' },      // the depth, as a height, at which the ground counts as covered: above 0
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let depth = layer_at(px);
  return Out(bed_at(px) + depth, saturate(depth / P.cover));
}`,
});

interface State { bed: Field<'field'>; layer: Field<'field'>; next: Field<'field'>; lim: Field<'field'> }

export default defineNode({
  type: 'simulate/snow',
  title: 'Snow',
  category: 'simulate',
  description: 'Covers high ground with snow that slides off steep faces, gathers in hollows and melts in the sun; snow is the cover, depth its thickness.',
  keywords: ['snowfall', 'snow cover', 'snow line', 'drift', 'avalanche', 'glacier', 'ice', 'winter', 'alpine'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'snow', type: 'field', role: 'mask' },
    { name: 'depth', type: 'field', role: 'data' },
  ],
  params: [
    {
      kind: 'float', name: 'snowfall', label: 'Snowfall', unit: 'height', default: 0.02, min: 0, max: 0.1, soft: true,
      help: 'Thickness of the snow that falls where nothing limits it. More snow buries more of the small relief.',
    },
    {
      kind: 'float', name: 'snowLine', label: 'Snow line', unit: 'height', default: 0.5, min: 0, max: 1, soft: true,
      help: 'Altitude above which snow falls. Snow that slides below it melts.',
    },
    {
      kind: 'float', name: 'band', label: 'Transition', unit: 'height', default: 0.05, min: 0.001, max: 0.5, scale: 'log',
      help: 'Half the height over which the snow line fades in. A wider band gives a ragged, gradual snow line.',
    },
    param.slope('slipAngle', {
      label: 'Slip angle', default: 50, min: 5, max: 89,
      help: 'Snow slides off surfaces steeper than this. A lower angle bares more rock and fills the hollows below it deeper.',
    }),
    {
      kind: 'float', name: 'melt', label: 'Melt', unit: 'ratio', default: 0.2, min: 0, max: 1,
      help: 'Share of the snowfall that melts on ground fully turned to the sun. More melt thins the cover and raises the snow line.',
    },
    {
      kind: 'float', name: 'exposure', label: 'Sun exposure', unit: 'ratio', default: 0.5, min: 0, max: 1,
      help: 'How much the melt depends on facing the sun: 0 melts all slopes alike, 1 leaves the shaded slopes their snow.',
    },
    param.angle({ label: 'Sun direction', help: 'Direction from the terrain towards the sun that melts the snow. Slopes facing it keep less.' }),
    param.size({
      label: 'Reach', default: 0.02, min: 0.001, max: 0.25,
      help: 'How far snow can slide. A longer reach empties longer faces and builds deeper drifts at their foot.',
    }),
  ],
  kernels: [move, finish, layerLimit, ...refineKernels],
  async evaluate(ctx) {
    const { snowLine, melt, exposure, angle } = ctx.params;
    const snowfall = Math.min(Math.max(ctx.params.snowfall, 0), 1);
    const size = Math.min(Math.max(ctx.params.size, SIZE_MIN), SIZE_MAX);
    const input = ctx.input('in');
    const mask = ctx.input('mask');
    const slip = Math.tan((ctx.params.slipAngle * Math.PI) / 180);
    const azimuth = (angle * Math.PI) / 180, elevation = (SUN_ELEVATION * Math.PI) / 180;
    const sun = [Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation)] as const;
    let budget: readonly number[] = [];
    let equivalent = 1;

    const state = await ops.coarseToFine<State>(ctx, {
      coarsestCell: size / FEATURE_CELLS_RELAX,
      begin(level) {
        const cells = size * (level.res - 1);
        // Snow falls in every run: a reach below a texel still takes one iteration, in which it falls and stays.
        const planned = levelBudget(snowfall > 0 ? Math.max(RELAX * cells * cells, 1) : 0, level.count, DETAIL_ITERATIONS_RELAX, 0.25);
        budget = planned.iterations;
        equivalent = planned.equivalent;
        const bed = levelInput(ctx, input, level);
        return { bed, layer: ctx.alloc('field', { like: bed, clear: 0 }), next: ctx.alloc('field', { like: bed }), lim: ctx.alloc('field', { like: bed }) };
      },
      async simulate(level, s) {
        const where = mask ? levelInput(ctx, mask, level) : null;
        // One iteration here counts 0.25^index iterations of the base level: it brings that share of the run's snowfall (simulation.md 2.5).
        const fall = (snowfall * 0.25 ** level.index) / Math.max(equivalent, 1);
        const params = { slip, fall, snowLine, band: ctx.params.band, melt, exposure, sun };
        await ctx.loop(budget[level.index]!, () => {
          ctx.run(layerLimit, { in: { bed: s.bed, layer: s.layer }, out: { lim: s.lim }, params: { repose: slip } });
          ctx.run(move, { in: { bed: s.bed, layer: s.layer, lim: s.lim, mask: where }, out: { next: s.next }, params });
          [s.layer, s.next] = [s.next, s.layer];
        }, { label: 'Snow', progress: level.progress });
        if (where && where !== mask) ctx.release(where);
      },
      refine(_coarse, fine, s) {
        ctx.release(s.next);
        ctx.release(s.lim);
        if (s.bed !== input) ctx.release(s.bed);
        const layer = refinePlane(ctx, s.layer, { size: fine.res });
        ctx.release(s.layer);
        const bed = levelInput(ctx, input, fine);
        return { bed, layer, next: ctx.alloc('field', { like: layer }), lim: ctx.alloc('field', { like: layer }) };
      },
    });

    // The two planes the loop is done with become the outputs: the terrain under its snow, and the cover.
    const cover = ctx.wants('snow') ? state.lim : null;
    ctx.run(finish, { in: { bed: input, layer: state.layer }, out: { out: state.next, snow: cover }, params: { cover: Math.max(SNOW_COVER * snowfall, 1e-9) } });
    ctx.output('out', state.next);
    if (cover) ctx.output('snow', cover);
    else ctx.release(state.lim);
    if (ctx.wants('depth')) ctx.output('depth', state.layer);
    else ctx.release(state.layer);
  },
});
