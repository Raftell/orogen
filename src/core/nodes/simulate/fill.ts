// src/core/nodes/simulate/fill.ts
import { defineKernel, defineNode, param } from '../../api.ts';
import { ROUTE_EPS_FLOOR, route } from './_route.ts';

const depth = defineKernel({
  name: 'simulate/fill.depth',
  inputs: { src: 'field', filled: 'field' },
  outputs: { out: 'field' },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 { return max(filled_at(px) - src_at(px), 0.0); }`,
});

export default defineNode({
  type: 'simulate/fill',
  title: 'Fill Depressions',
  category: 'simulate',
  description: 'Fills every pit and hollow up to its rim, so that all ground drains to the border or the sea; depth is the height added.',
  keywords: ['pit', 'sink', 'depression', 'basin', 'pond', 'drain', 'priority flood'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'depth', type: 'field', role: 'data', label: 'Fill depth' },
  ],
  params: [
    param.slope('tilt', {
      label: 'Tilt', default: 0, min: 0, max: 10,
      help: 'Slope of the filled ground towards its outlet: 0 leaves it level, larger values let water run off it.',
    }),
  ],
  kernels: [depth],
  cpuTasks: [route],
  uses: ['seaLevel'],
  async evaluate(ctx) {
    const { tilt } = ctx.params;
    const input = ctx.input('in');
    // First: a node that does not fit the budget fails before the CPU works.
    const out = ctx.alloc('field');
    // The tilt is a physical slope, so the fall per texel follows the cell: the same ground at every resolution.
    const eps = tilt > 0 ? Math.max((Math.tan((tilt * Math.PI) / 180) * ctx.cellSize) / ctx.heightRange, ROUTE_EPS_FLOOR) : 0;
    const height = await ctx.read(input);
    const routed = await ctx.cpu(route, { height, res: ctx.res, eps, seaLevel: ctx.setting('seaLevel'), routing: 'none', seed: 0 }, [height.buffer]);
    ctx.write(out, routed.filled);
    ctx.output('out', out);
    if (ctx.wants('depth')) {
      const added = ctx.alloc('field');
      ctx.run(depth, { in: { src: input, filled: out }, out: { out: added } });
      ctx.output('depth', added);
    }
  },
});
