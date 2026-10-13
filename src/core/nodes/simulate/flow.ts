// src/core/nodes/simulate/flow.ts
import { defineKernel, defineNode, mixSeed, param } from '../../api.ts';
import { route, routeEps, routeWeight, routeWeightKernels } from './_route.ts';
import { WETNESS_AREA_MIN, WETNESS_SLOPE_MIN } from './_water-constants.ts';

const wetness = defineKernel({
  name: 'simulate/flow.wetness',
  inputs: { height: 'field', area: 'field' },
  outputs: { out: 'field' },
  cost: 6,
  code: /* wgsl */ `
// Slopes gentler than this count as this: level ground has no index otherwise.
const SLOPE_MIN = ${WETNESS_SLOPE_MIN};
// A texel that precipitation leaves without any area counts as draining this part of one cell: the index stays finite.
const AREA_MIN = ${WETNESS_AREA_MIN};

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // The area drained per metre of contour: the drained area over the width of one cell.
  let contour = area_at(px) * frame.terrainSize * frame.terrainSize / frame.cellSize;
  let slope = length(slopeAt(height, px));
  return log(max(contour, AREA_MIN * frame.cellSize) / max(slope, SLOPE_MIN));
}`,
});

export default defineNode({
  type: 'simulate/flow',
  title: 'Flow',
  category: 'simulate',
  description: 'Maps where water gathers: the share of the terrain that drains through each point, and how wet the ground there is.',
  keywords: ['flow map', 'accumulation', 'drainage', 'catchment', 'stream', 'watershed', 'wetness', 'twi'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'precipitation', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [
    { name: 'out', type: 'field', role: 'data' },
    { name: 'wetness', type: 'field', role: 'data' },
  ],
  params: [
    {
      kind: 'enum', name: 'routing', label: 'Routing', default: 'single',
      // Stored in documents: values are never renamed or reordered, and new ones are appended.
      options: [
        { value: 'single', label: 'Single' },
        { value: 'multiple', label: 'Multiple' },
      ],
      help: 'Single sends all water of a point to one lower neighbor and gives crisp stream lines; multiple shares it among all lower neighbors and gives soft ones.',
    },
    param.seed({ help: 'Changes which lower neighbor each point drains to, and with it the course of the small streams.' }),
  ],
  kernels: [wetness, ...routeWeightKernels],
  cpuTasks: [route],
  uses: ['seaLevel'],
  async evaluate(ctx) {
    const input = ctx.input('in');
    const precipitation = ctx.input('precipitation');
    const weight = precipitation ? await routeWeight(ctx, precipitation) : undefined;
    // Before the CPU works: a node that does not fit the budget fails here.
    const out = ctx.alloc('field');
    const height = await ctx.read(input);
    const routed = await ctx.cpu(route, {
      height, res: ctx.res, eps: routeEps(ctx.heightRange), seaLevel: ctx.setting('seaLevel'),
      routing: ctx.params.routing, seed: mixSeed(ctx.seed, 0), weight,
    }, weight ? [height.buffer, weight.buffer] : [height.buffer]);
    ctx.write(out, routed.area!);
    ctx.output('out', out);
    if (ctx.wants('wetness')) {
      const index = ctx.alloc('field');
      ctx.run(wetness, { in: { height: input, area: out }, out: { out: index } });
      ctx.output('wetness', index);
    }
  },
});
