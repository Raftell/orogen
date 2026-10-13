// src/core/nodes/simulate/thermal-erosion.ts
import { defineNode, ops, param, type Field } from '../../api.ts';
import { DETAIL_ITERATIONS_RELAX, FEATURE_CELLS_RELAX, RELAX } from './_constants.ts';
import { diff } from './_diff.ts';
import { levelBudget, levelInput, refineHeight, refineKernels } from './_refine.ts';
import { talusStep } from './_talus.ts';

/** The reach a typed value is held to: below it no level has a texel to move material over, above it lies the whole terrain. */
const SIZE_MIN = 1e-4, SIZE_MAX = 1;

interface State { h: Field<'field'>; spare: Field<'field'>; base: Field<'field'> }

export default defineNode({
  type: 'simulate/thermal-erosion',
  title: 'Thermal Erosion',
  category: 'simulate',
  description: 'Collapses slopes steeper than a talus angle into even scree slopes; wear and deposit are the heights taken and laid down.',
  keywords: ['talus', 'scree', 'slump', 'thermal', 'landslide', 'rockfall', 'debris', 'collapse'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'wear', type: 'field', role: 'data' },
    { name: 'deposit', type: 'field', role: 'data' },
  ],
  params: [
    param.slope('talus', {
      label: 'Talus angle', default: 35, min: 5, max: 89,
      help: 'Slopes steeper than this collapse. A lower angle flattens more of the terrain.',
    }),
    param.size({
      label: 'Reach', default: 0.005, min: 0.001, max: 0.25,
      help: 'Width of the largest scree slope that forms completely. A longer reach lets taller cliffs collapse all the way.',
    }),
    param.strength({ help: 'How far the collapse proceeds: lower values stop it early and leave cliffs partly standing.' }),
    {
      kind: 'float', name: 'removal', label: 'Removal', unit: 'ratio', default: 0, min: 0, max: 1,
      help: 'Share of the fallen material that is carried away instead of piling up at the foot of the slope.',
    },
  ],
  kernels: [talusStep, diff, ...refineKernels],
  async evaluate(ctx) {
    const { talus, strength, removal } = ctx.params;
    const size = Math.min(Math.max(ctx.params.size, SIZE_MIN), SIZE_MAX);
    const input = ctx.input('in');
    const mask = ctx.input('mask');
    const tangent = Math.tan((talus * Math.PI) / 180);
    // Without a rest state all of the ground is loose and rests at the one angle.
    const params = { talus: tangent, fan: tangent, keep: 1 - removal, creep: 0 };
    let budget: readonly number[] = [];

    const state = await ops.coarseToFine<State>(ctx, {
      coarsestCell: size / FEATURE_CELLS_RELAX,
      begin(level) {
        const cells = size * (level.res - 1);
        budget = levelBudget(strength * RELAX * cells * cells, level.count, DETAIL_ITERATIONS_RELAX, 0.25).iterations;
        const base = levelInput(ctx, input, level);
        return { base, h: ctx.clone(base), spare: ctx.alloc('field', { like: base }) };
      },
      async simulate(level, s) {
        const gate = mask ? levelInput(ctx, mask, level) : null;
        await ctx.loop(budget[level.index]!, () => {
          // Without `rest` the step loads 18 texels, not the 27 its kernel declares.
          ctx.run(talusStep, { in: { h: s.h, mask: gate }, out: { next: s.spare }, params, cost: 18 });
          [s.h, s.spare] = [s.spare, s.h];
        }, { label: 'Thermal erosion', progress: level.progress, preview: () => ({ out: s.h }) });
        if (gate && gate !== mask) ctx.release(gate);
      },
      refine(_coarse, fine, s) {
        ctx.release(s.spare);
        const base = levelInput(ctx, input, fine);
        const h = refineHeight(ctx, { coarse: s.h, coarseBase: s.base, fineBase: base, jitter: false, salt: 0, detail: 0 });
        ctx.release(s.h);
        if (s.base !== input) ctx.release(s.base);
        return { base, h, spare: ctx.alloc('field', { like: h }) };
      },
    });

    ctx.release(state.spare);
    ctx.output('out', state.h);
    const wear = ctx.wants('wear') ? ctx.alloc('field') : null;
    const deposit = ctx.wants('deposit') ? ctx.alloc('field') : null;
    if (wear || deposit) ctx.run(diff, { in: { before: input, after: state.h }, out: { wear, deposit } });
    if (wear) ctx.output('wear', wear);
    if (deposit) ctx.output('deposit', deposit);
  },
});
