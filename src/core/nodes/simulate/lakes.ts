// src/core/nodes/simulate/lakes.ts
import { defineCpuTask, defineKernel, defineNode, type CpuEnv } from '../../api.ts';
import { route } from './_route.ts';

interface PruneArgs {
  readonly height: Float32Array;     // res × res: the terrain
  readonly filled: Float32Array;     // its routing surface with level lakes; consumed, and returned as `level`
  readonly res: number;
  readonly minDepth: number;         // normalised height: a lake whose deepest point is shallower is dropped
  readonly minArea: number;          // fraction of the terrain: a smaller lake is dropped
}

// The lakes of a filled terrain are its N4-connected sets of texels with filled > height; with level lakes every
// such set has one level. Each is walked once, breadth first, and a lake that fails a threshold is given its
// terrain back. Pure: the result depends on the arguments only.
const prune = defineCpuTask({
  name: 'simulate/lakes.prune',
  run({ height, filled, res, minDepth, minArea }: PruneArgs, env: CpuEnv): { level: Float32Array } {
    const n = res * res;
    if (height.length !== n || filled.length !== n) throw new Error(`simulate/lakes.prune: the fields are not ${res} x ${res}`);
    // A texel covers one cell of the terrain: (res - 1)^2 of them make the whole.
    const minTexels = minArea * Math.max(res - 1, 1) ** 2;
    const seen = new Uint8Array(n);
    // The texels of the lake being walked, in the order they were reached. A lake never touches the border
    // ring, whose texels are outlets, so every one of its texels has four neighbours.
    let lake = new Int32Array(1 << 12);
    for (let start = 0; start < n; start++) {
      if ((start & 0xfffff) === 0) env.progress(start / n);
      if (seen[start] !== 0 || !(filled[start] > height[start])) continue;
      let count = 1, deepest = 0;
      lake[0] = start;
      seen[start] = 1;
      for (let at = 0; at < count; at++) {
        const i = lake[at];
        deepest = Math.max(deepest, filled[i] - height[i]);
        for (const q of [i + 1, i + res, i - 1, i - res]) {
          if (seen[q] !== 0 || !(filled[q] > height[q])) continue;
          seen[q] = 1;
          if (count === lake.length) { const grown = new Int32Array(count * 2); grown.set(lake); lake = grown; }
          lake[count++] = q;
        }
      }
      if (deepest < minDepth || count < minTexels) for (let at = 0; at < count; at++) filled[lake[at]] = height[lake[at]];
    }
    return { level: filled };
  },
});

const maps = defineKernel({
  name: 'simulate/lakes.maps',
  inputs: { height: 'field', level: 'field' },
  outputs: { water: 'field', depth: 'field' },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> Out {
  let h = height_at(px);
  let l = level_at(px);
  return Out(select(0.0, 1.0, l > h), max(l - h, 0.0));
}`,
});

export default defineNode({
  type: 'simulate/lakes',
  title: 'Lakes',
  category: 'simulate',
  description: 'Finds the hollows that hold water up to where they spill: a mask of the lakes, their depth and their surface, with the terrain unchanged.',
  keywords: ['lake', 'pond', 'water', 'depression', 'basin', 'tarn', 'priority flood'],
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'water', type: 'field', role: 'mask' },
    { name: 'depth', type: 'field', role: 'data', label: 'Water depth' },
    { name: 'surface', type: 'field', label: 'Water surface' },
  ],
  params: [
    {
      kind: 'float', name: 'minDepth', label: 'Minimum depth', unit: 'height', default: 0.003, min: 0, max: 0.1, soft: true,
      help: 'Lakes whose deepest point is shallower than this are left out: larger values keep only the deep ones.',
    },
    {
      kind: 'float', name: 'minSize', label: 'Minimum size', unit: 'length', default: 0.02, min: 0, max: 0.25, soft: true,
      help: 'Lakes that cover less than a square of this side are left out: larger values remove ponds and puddles.',
    },
  ],
  kernels: [maps],
  cpuTasks: [route, prune],
  uses: ['seaLevel'],
  async evaluate(ctx) {
    const input = ctx.input('in');
    // The terrain is not changed: out is the input itself.
    ctx.output('out', input);
    const wants = { water: ctx.wants('water'), depth: ctx.wants('depth'), surface: ctx.wants('surface') };
    if (!wants.water && !wants.depth && !wants.surface) return;

    // First: a node that does not fit the budget fails before the CPU works.
    const level = ctx.alloc('field');
    const water = wants.water ? ctx.alloc('field') : null;
    const depth = wants.depth ? ctx.alloc('field') : null;
    const { minDepth, minSize } = ctx.params;
    // Level lakes: eps 0. Ground at or below the sea level is an outlet, so the sea is no lake.
    const terrain = await ctx.read(input);
    const routed = await ctx.cpu(route, {
      height: terrain, res: ctx.res, eps: 0, seaLevel: ctx.setting('seaLevel'), routing: 'none', seed: 0,
    }, [terrain.buffer]);
    // The router consumed its copy of the terrain: the input is read a second time.
    const height = await ctx.read(input);
    const kept = await ctx.cpu(prune, {
      height, filled: routed.filled, res: ctx.res,
      // Soft parameters: any finite number can arrive.
      minDepth: Math.max(minDepth, 0), minArea: Math.max(minSize, 0) ** 2,
      // What a task returns arrives in a buffer of its own, which moves on to the next task.
    }, [height.buffer, routed.filled.buffer as ArrayBuffer]);
    ctx.write(level, kept.level);
    if (water || depth) ctx.run(maps, { in: { height: input, level }, out: { water, depth } });
    if (water) ctx.output('water', water);
    if (depth) ctx.output('depth', depth);
    // The surface is the level itself: the lake's level inside a lake, the terrain elsewhere.
    if (wants.surface) ctx.output('surface', level);
    else ctx.release(level);
  },
});
