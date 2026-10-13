// src/core/nodes/simulate/sediment.ts
import { MASK_INPUT, defineKernel, defineNode, ops, param, type Field } from '../../api.ts';
import { DETAIL_ITERATIONS_RELAX, FEATURE_CELLS_RELAX, RELAX } from './_constants.ts';
import { layerLimit, layerMove } from './_layer.ts';
import { levelBudget, levelInput, refineKernels, refinePlane } from './_refine.ts';

/** The reach a typed value is held to: below it no level has a texel to move material over, above it lies the whole terrain. */
const SIZE_MIN = 1e-4, SIZE_MAX = 1;

// The layer as it is laid down: the same thickness wherever the mask is 1.
const lay = defineKernel({
  name: 'simulate/sediment.lay',
  inputs: { mask: MASK_INPUT },
  outputs: { layer: 'field' },
  params: { thickness: 'f32' },
  cost: 1,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 { return P.thickness * mask_at(px); }`,
});

const finish = defineKernel({
  name: 'simulate/sediment.finish',
  inputs: { bed: 'field', layer: 'field' },
  outputs: { out: 'field' },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 { return bed_at(px) + layer_at(px); }`,
});

interface State { bed: Field<'field'>; layer: Field<'field'>; next: Field<'field'>; lim: Field<'field'> }

export default defineNode({
  type: 'simulate/sediment',
  title: 'Sediment',
  category: 'simulate',
  description: 'Lays loose material on the terrain and lets it slide off the slopes into the hollows; depth is the thickness that came to rest.',
  keywords: ['fill', 'deposit', 'sand', 'soil', 'silt', 'debris', 'scree', 'settle', 'repose'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'depth', type: 'field', role: 'data' },
  ],
  params: [
    {
      kind: 'float', name: 'thickness', label: 'Thickness', unit: 'height', default: 0.02, min: 0, max: 0.1, soft: true,
      help: 'Thickness of the layer laid down before it slides. More material fills the hollows higher and buries more of the relief.',
    },
    param.slope('repose', {
      label: 'Angle of repose', default: 33, min: 5, max: 89,
      help: 'The steepest slope the material rests on. A lower angle lets it run further and settle flatter.',
    }),
    param.size({
      label: 'Reach', default: 0.02, min: 0.001, max: 0.25,
      help: 'How far the material can slide. A longer reach empties longer slopes and fills wider hollows.',
    }),
  ],
  kernels: [lay, finish, layerLimit, layerMove, ...refineKernels],
  async evaluate(ctx) {
    const thickness = Math.min(Math.max(ctx.params.thickness, 0), 1);
    const size = Math.min(Math.max(ctx.params.size, SIZE_MIN), SIZE_MAX);
    const input = ctx.input('in');
    const mask = ctx.input('mask');
    // The material only slides: it does not creep on a slope it can rest on.
    const params = { repose: Math.tan((ctx.params.repose * Math.PI) / 180), creep: 0, full: 1 };
    let budget: readonly number[] = [];

    const state = await ops.coarseToFine<State>(ctx, {
      coarsestCell: size / FEATURE_CELLS_RELAX,
      begin(level) {
        const cells = size * (level.res - 1);
        budget = levelBudget(RELAX * cells * cells, level.count, DETAIL_ITERATIONS_RELAX, 0.25).iterations;
        const bed = levelInput(ctx, input, level);
        const layer = ctx.alloc('field', { like: bed });
        const next = ctx.alloc('field', { like: bed });
        const lim = ctx.alloc('field', { like: bed });
        const where = mask ? levelInput(ctx, mask, level) : null;
        ctx.run(lay, { in: { mask: where }, out: { layer }, params: { thickness } });
        if (where && where !== mask) ctx.release(where);
        return { bed, layer, next, lim };
      },
      async simulate(level, s) {
        await ctx.loop(budget[level.index]!, () => {
          ctx.run(layerLimit, { in: { bed: s.bed, layer: s.layer }, out: { lim: s.lim }, params });
          ctx.run(layerMove, { in: { bed: s.bed, layer: s.layer, lim: s.lim }, out: { next: s.next }, params });
          [s.layer, s.next] = [s.next, s.layer];
        }, { label: 'Settling sediment', progress: level.progress });
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

    ctx.release(state.lim);
    // The spare plane of the ping-pong holds the terrain with its layer: bed + layer, as one float32 sum.
    ctx.run(finish, { in: { bed: input, layer: state.layer }, out: { out: state.next } });
    ctx.output('out', state.next);
    if (ctx.wants('depth')) ctx.output('depth', state.layer);
    else ctx.release(state.layer);
  },
});
