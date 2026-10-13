// tests/nodes/simulate/_route-probe.ts
// A node that exists in test processes only: it runs the two kernels of the routing module, which no node of the
// hydrology owner runs on the GPU, beside the router task, so that route.test.ts can hold them to
// simulation.md 6.5.
import { defineNode, mixSeed, param } from '../../../src/core/api.ts';
import { fillSweep, receivers, route, routeEps } from '../../../src/core/nodes/simulate/_route.ts';

export default defineNode({
  type: 'simulate/route-probe',
  title: 'Route Probe',
  category: 'simulate',
  description: 'Runs the router task and the sweep and receiver kernels of the routing module for their tests.',
  inputs: [
    { name: 'in', type: 'field' },
    // The surface the sweeps start from; unconnected, the router's.
    { name: 'start', type: 'field', optional: true },
  ],
  outputs: [
    { name: 'out', type: 'field' },                    // the router's surface
    { name: 'swept', type: 'field' },                  // the start after `count` sweeps
    { name: 'rcv', type: 'field', role: 'data' },      // simulate/route.receivers on the router's surface
    { name: 'area', type: 'field', role: 'data' },     // the router's area
  ],
  params: [
    { kind: 'int', name: 'count', label: 'Sweeps', default: 1, min: 0, max: 64, help: 'How many sweeps run.' },
    { kind: 'float', name: 'lift', label: 'Lift', unit: 'height', default: 0, min: 0, max: 1, help: 'The lift of the first sweep.' },
    param.seed(),
  ],
  kernels: [fillSweep, receivers],
  cpuTasks: [route],
  uses: ['seaLevel'],
  async evaluate(ctx) {
    const z = ctx.input('in');
    const sea = ctx.setting('seaLevel'), eps = routeEps(ctx.heightRange);
    const out = ctx.alloc('field');
    const area = ctx.alloc('field');
    const height = await ctx.read(z);
    const routed = await ctx.cpu(route, { height, res: ctx.res, eps, seaLevel: sea, routing: 'single', seed: mixSeed(ctx.seed, 0) }, [height.buffer]);
    ctx.write(out, routed.filled);
    ctx.write(area, routed.area!);

    let w = ctx.clone(ctx.input('start') ?? out);
    let next = ctx.alloc('field');
    await ctx.loop(ctx.params.count, (i) => {
      ctx.run(fillSweep, { in: { z, w }, out: { next }, params: { eps, lift: i === 0 ? ctx.params.lift : 0, sea } });
      [w, next] = [next, w];
    });
    ctx.release(next);
    const rcv = ctx.alloc('field');
    ctx.run(receivers, { in: { z, w: out }, out: { rcv }, params: { sea } });
    ctx.output('out', out);
    ctx.output('swept', w);
    ctx.output('rcv', rcv);
    ctx.output('area', area);
  },
});
