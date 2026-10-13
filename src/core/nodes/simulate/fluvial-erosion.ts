// src/core/nodes/simulate/fluvial-erosion.ts
import { MASK_INPUT, defineKernel, defineLib, defineNode, hash, mixSeed, ops, param, type Field } from '../../api.ts';
import { CELERITY_CAP, COURANT, DETAIL_ITERATIONS_FLUVIAL, FEATURE_CELLS, FILL_SWEEPS, FLOW_JITTER, FLOW_SPREAD, FRESH_BOOST, FRESH_CELLS, TALUS_RATE, wgsl } from './_constants.ts';
import { diff } from './_diff.ts';
import { levelBudget, levelInput, refineHeight, refineKernels } from './_refine.ts';
import { fillSweep, route, routeEps } from './_route.ts';

/** The feature size a typed value is held to: the base level needs a texel to work with, and the terrain is the largest catchment. */
const SIZE_MIN = 1e-3, SIZE_MAX = 1;
/** Base iterations per feature size of incision and per texel of the feature: the front moves STEP * CELERITY_CAP texels per iteration at the most (simulation.md 3.7). */
const ITERATIONS_PER_CELL = (CELERITY_CAP + TALUS_RATE) / COURANT;

// How a texel shares its water among the lower of its eight neighbours: by the fall to each, per unit of run, to
// the power FLOW_SPREAD, times a random factor of its own for each neighbour, which is constant over a level.
// Both the texel that gives and the one that takes compute a share with this function.
const simulateFluvial = defineLib({
  name: 'simulateFluvial',
  deps: [hash],
  code: /* wgsl */ `
const simulateFluvial_SPREAD = ${wgsl(FLOW_SPREAD)};
const simulateFluvial_JITTER = ${wgsl(FLOW_JITTER)};

// The weight of the fall of drop, a height, from texel giver to its neighbour at the offset to.
fn simulateFluvial_weight(giver: vec2i, to: vec2i, drop: f32, seed: u32) -> f32 {
  if (drop <= 0.0) { return 0.0; }
  let chance = hash_unit(hash_cell(3 * giver + to, seed));
  return pow(drop / length(vec2f(to)), simulateFluvial_SPREAD) * (1.0 + simulateFluvial_JITTER * (2.0 * chance - 1.0));
}`,
});

// Pass 1 of simulation.md 3.5: the sum of the weights of a texel's falls on the routing surface, by which its
// neighbours divide what it gives them. 0 for an outlet, which passes nothing on.
const spread = defineKernel({
  name: 'simulate/fluvial-erosion.spread',
  inputs: { z: 'field', w: 'field' },
  outputs: { tot: 'field' },
  params: { sea: 'f32' },
  includes: [simulateFluvial],
  cost: 12,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let last = vec2i(frame.res) - vec2i(1);
  if (any(px == vec2i(0)) || any(px == last) || z_at(px) <= P.sea) { return 0.0; }
  let wp = w_at(px);
  let seed = seedFor(2u);
  var total = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) { continue; }
      total += simulateFluvial_weight(px, vec2i(i, j), wp - w_at(px + vec2i(i, j)), seed);
    }
  }
  return total;
}`,
});

// Pass 2 of simulation.md 3.5: one step of the stream-power law, and one sweep of the drainage area. A texel is
// lowered by the slope of the routing surface at the speed of its catchment, never below its lowest neighbour;
// an outlet, a pit and the bed of a lake stay.
const erode = defineKernel({
  name: 'simulate/fluvial-erosion.erode',
  inputs: { z: 'field', w: 'field', area: 'field', tot: 'field', mask: MASK_INPUT, upliftMask: MASK_INPUT },
  outputs: { zNext: 'field', areaNext: 'field' },
  // land: the lowest height ground above the sea may take. size2: the square of the feature size. talus: the
  // tangent of the angle. lift: the uplift of this iteration, as a height. boost, fresh: a catchment up to the
  // area fresh, which the coarser level could not hold, cuts boost times as fast, and a larger one less so.
  params: { sea: 'f32', land: 'f32', size2: 'f32', concavity: 'f32', talus: 'f32', lift: 'f32', boost: 'f32', fresh: 'f32' },
  includes: [simulateFluvial],
  cost: 34,
  code: /* wgsl */ `
const CELERITY_CAP = ${wgsl(CELERITY_CAP)};
const TALUS_RATE = ${wgsl(TALUS_RATE)};
const STEP = ${wgsl(COURANT / (CELERITY_CAP + TALUS_RATE))};

// The area the neighbour at the offset back passes to texel p, whose routing surface stands at wp.
fn donated(p: vec2i, back: vec2i, wp: f32, seed: u32) -> f32 {
  let q = p + back;
  if (!inGrid(q)) { return 0.0; }
  let total = tot_at(q);
  if (total <= 0.0) { return 0.0; }
  return area_at(q) * min(simulateFluvial_weight(q, -back, w_at(q) - wp, seed) / total, 1.0);
}

fn compute(px: vec2i, uv: vec2f) -> Out {
  let qe = px + vec2i(1, 0);
  let qn = px + vec2i(0, 1);
  let qw = px - vec2i(1, 0);
  let qs = px - vec2i(0, 1);
  let wp = w_at(px);
  let texels = vec2f(frame.res);
  let seed = seedFor(2u);
  var gathered = 1.0 / (texels.x * texels.y);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) { continue; }
      gathered += donated(px, vec2i(i, j), wp, seed);
    }
  }

  let zp = z_at(px);
  let last = vec2i(frame.res) - vec2i(1);
  if (any(px == vec2i(0)) || any(px == last) || zp <= P.sea) { return Out(zp, gathered); }
  let lift = P.lift * upliftMask_at(px);
  if (tot_at(px) <= 0.0 || wp > zp) { return Out(zp + lift, gathered); }

  let we = w_at(qe);
  let wn = w_at(qn);
  let ww = w_at(qw);
  let ws = w_at(qs);
  // The upwind slope of the routing surface (Jain24 eq. 18), in metres per metre.
  let g = frame.heightRange * vec2f(max(0.0, max(wp - we, wp - ww)), max(0.0, max(wp - wn, wp - ws))) / frame.cellSize;
  let slope = length(g);
  let drained = max(area_at(px), 1e-12);
  let law = min(pow(drained / P.size2, P.concavity), CELERITY_CAP);
  let speed = max(law, min(law * P.boost * min(P.fresh / drained, 1.0), CELERITY_CAP));
  let cut = STEP * frame.cellSize * (speed * slope + TALUS_RATE * max(slope - P.talus, 0.0)) / frame.heightRange;
  // Never below the lowest of the four neighbours, and never down to the sea, which is the base level.
  let below = min(min(we, wn), min(ww, ws));
  return Out(max(zp - mask_at(px) * cut, min(zp, max(below, P.land))) + lift, gathered);
}`,
});

// After a refinement the sea takes no part in what the coarser level did: ground at or below the sea level is
// the input there, and ground above it is not drawn below it by the lowering of a coarse texel beside it.
const settle = defineKernel({
  name: 'simulate/fluvial-erosion.settle',
  inputs: { refined: 'field', base: 'field' },
  outputs: { z: 'field' },
  params: { sea: 'f32', land: 'f32' },
  cost: 2,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let before = base_at(px);
  if (before <= P.sea) { return before; }
  return max(refined_at(px), min(before, P.land));
}`,
});

// Step 5: what remains of the lakes is filled as far as lakeFill says, and the border ring, which stood fixed as
// the base level of the run, takes the lowering of the texel beside it, down to the sea level at the most.
const finish = defineKernel({
  name: 'simulate/fluvial-erosion.finish',
  inputs: { z: 'field', w: 'field', before: 'field' },
  outputs: { out: 'field' },
  params: { lakeFill: 'f32', sea: 'f32', land: 'f32' },
  cost: 4,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let zp = z_at(px);
  let last = vec2i(frame.res) - vec2i(1);
  // The neighbour one texel inwards: px itself in the interior, the diagonal one at a corner.
  let inward = clamp(px, vec2i(1), max(last - vec2i(1), vec2i(1)));
  if (any(inward != px)) {
    if (zp <= P.sea) { return zp; }
    return max(zp - max(before_at(inward) - z_at(inward), 0.0), min(zp, P.land));
  }
  return zp + P.lakeFill * max(w_at(px) - zp, 0.0);
}`,
});

interface State {
  base: Field<'field'>;
  z: Field<'field'>; zNext: Field<'field'>;
  area: Field<'field'>; areaNext: Field<'field'>;
  w: Field<'field'>; wNext: Field<'field'>;
  tot: Field<'field'>;
}

export default defineNode({
  type: 'simulate/fluvial-erosion',
  title: 'Fluvial Erosion',
  category: 'simulate',
  description: 'Carves branching river valleys with ridges between, as running water does over ages; wear is the height removed, flow the drained share.',
  keywords: ['river', 'valley', 'stream power', 'drainage', 'dendritic', 'canyon', 'ridge', 'uplift', 'erode'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
    { name: 'upliftMask', type: 'field', role: 'mask', optional: true, label: 'Uplift mask' },
  ],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'wear', type: 'field', role: 'data' },
    { name: 'flow', type: 'field', role: 'data' },
  ],
  params: [
    param.size({
      default: 0.125, min: 0.01, max: 1,
      help: 'Width of the catchments whose valleys are cut at the reference speed. Larger values carve fewer, broader valleys.',
    }),
    {
      kind: 'float', name: 'duration', label: 'Duration', unit: 'none', default: 1, min: 0.05, max: 8, scale: 'log',
      help: 'How long the rivers cut, as the distance their valleys work back into the terrain in feature sizes. Longer runs reach the ridges and lower them.',
    },
    {
      kind: 'float', name: 'concavity', label: 'Concavity', unit: 'none', default: 0.4, min: 0.2, max: 0.8,
      help: 'Low values erode small streams and large rivers alike; high values keep the erosion to the large rivers and leave the slopes.',
    },
    param.slope('talus', {
      label: 'Talus angle', default: 30, min: 5, max: 90,
      help: 'Valley sides steeper than this are worn back. At the largest value the rivers cut slots with standing walls.',
    }),
    {
      kind: 'float', name: 'uplift', label: 'Uplift', unit: 'height', default: 0, min: 0, max: 1, soft: true,
      help: 'Height the ground rises during the run where the uplift mask is 1, while the rivers cut into it. Grows ranges from level ground.',
    },
    {
      kind: 'float', name: 'lakeFill', label: 'Lake fill', unit: 'ratio', default: 1, min: 0, max: 1,
      help: 'How far the hollows that remain are filled with sediment: 1 leaves every valley draining, 0 leaves the pits open.',
    },
    {
      kind: 'float', name: 'detail', label: 'Detail', unit: 'ratio', default: 0, min: 0, max: 1,
      help: 'Fine roughness added each time the simulation moves to a finer grid, which seeds new small channels on smooth ground.',
    },
    param.seed({ help: 'Changes which way the small streams turn, and with them the course of every valley.' }),
  ],
  kernels: [spread, erode, settle, finish, fillSweep, diff, ...refineKernels],
  cpuTasks: [route],
  uses: ['seaLevel'],
  async evaluate(ctx) {
    const { duration, concavity, lakeFill, detail } = ctx.params;
    const size = Math.min(Math.max(ctx.params.size, SIZE_MIN), SIZE_MAX);
    const uplift = Math.min(Math.max(ctx.params.uplift, 0), 4);
    const input = ctx.input('in');
    const mask = ctx.input('mask');
    const upliftMask = ctx.input('upliftMask');
    const sea = ctx.setting('seaLevel');
    const eps = routeEps(ctx.heightRange);
    // Land stays land: one step of the routing surface above the sea, so that it still drains into it.
    const land = sea + eps;
    const talus = Math.tan((ctx.params.talus * Math.PI) / 180);
    let budget: readonly number[] = [];
    let equivalent = 1;

    /** The exact routing surface and drainage area of the terrain `z`, written into `w` and `area`. */
    const routeExactly = async (z: Field<'field'>, w: Field<'field'>, area: Field<'field'>, routing: 'single' | 'multiple'): Promise<void> => {
      const height = await ctx.read(z);
      const routed = await ctx.cpu(route, { height, res: z.width, eps, seaLevel: sea, routing, seed: mixSeed(ctx.seed, 0) }, [height.buffer]);
      ctx.write(w, routed.filled);
      ctx.write(area, routed.area!);
    };
    const scratch = (like: Field<'field'>) => ({
      zNext: ctx.alloc('field', { like }),
      area: ctx.alloc('field', { like }), areaNext: ctx.alloc('field', { like }),
      w: ctx.alloc('field', { like }), wNext: ctx.alloc('field', { like }),
      tot: ctx.alloc('field', { like }),
    });

    const state = await ops.coarseToFine<State>(ctx, {
      coarsestCell: size / FEATURE_CELLS,
      begin(level) {
        const cells = size * (level.res - 1);
        const planned = levelBudget(duration * cells * ITERATIONS_PER_CELL, level.count, DETAIL_ITERATIONS_FLUVIAL, 0.5);
        budget = planned.iterations;
        equivalent = Math.max(planned.equivalent, 1);
        const base = levelInput(ctx, input, level);
        const z = ctx.clone(base);
        return { base, z, ...scratch(z) };
      },
      async simulate(level, s) {
        const iterations = budget[level.index]!;
        if (iterations === 0) return;
        const gate = mask ? levelInput(ctx, mask, level) : null;
        const rising = upliftMask ? levelInput(ctx, upliftMask, level) : null;
        // The area starts spread over every lower neighbour, as the sweeps of the loop pass it on.
        await routeExactly(s.z, s.w, s.area, 'multiple');
        // One iteration here counts 0.5^index iterations of the base level: it brings that share of the run's uplift (simulation.md 2.5).
        const lift = (uplift * 0.5 ** level.index) / equivalent;
        // A level finer than the base is the first to hold catchments a few of its texels wide, and has a small
        // share of the run to cut them in: they cut faster by a share of what a run on this level alone would take
        // over what the level gets (simulation.md 3.6).
        const alone = duration * size * (level.res - 1) * ITERATIONS_PER_CELL;
        const boost = level.index > 0 ? Math.max((FRESH_BOOST * alone) / iterations, 1) : 1;
        const fresh = ((2 * FRESH_CELLS) / (level.res - 1)) ** 2;
        const params = { sea, land, size2: size * size, concavity, talus, lift, boost, fresh };
        await ctx.loop(iterations, () => {
          ctx.run(spread, { in: { z: s.z, w: s.w }, out: { tot: s.tot }, params: { sea } });
          ctx.run(erode, { in: { z: s.z, w: s.w, area: s.area, tot: s.tot, mask: gate, upliftMask: rising }, out: { zNext: s.zNext, areaNext: s.areaNext }, params });
          [s.z, s.zNext] = [s.zNext, s.z];
          [s.area, s.areaNext] = [s.areaNext, s.area];
          for (let sweep = 0; sweep < FILL_SWEEPS; sweep++) {
            // The first sweep allows for what the step can have raised; the others only lower (simulation.md 6.3).
            ctx.run(fillSweep, { in: { z: s.z, w: s.w }, out: { next: s.wNext }, params: { eps, lift: sweep === 0 ? lift : 0, sea } });
            [s.w, s.wNext] = [s.wNext, s.w];
          }
        }, { label: 'Fluvial erosion', progress: level.progress, preview: () => ({ out: s.z }) });
        if (gate && gate !== mask) ctx.release(gate);
        if (rising && rising !== upliftMask) ctx.release(rising);
      },
      refine(_coarse, fine, s) {
        for (const plane of [s.zNext, s.area, s.areaNext, s.w, s.wNext, s.tot]) ctx.release(plane);
        const base = levelInput(ctx, input, fine);
        const refined = refineHeight(ctx, { coarse: s.z, coarseBase: s.base, fineBase: base, jitter: true, salt: mixSeed(ctx.seed, fine.res), detail });
        ctx.release(s.z);
        if (s.base !== input) ctx.release(s.base);
        const z = ctx.alloc('field', { like: refined });
        ctx.run(settle, { in: { refined, base }, out: { z }, params: { sea, land } });
        ctx.release(refined);
        return { base, z, ...scratch(z) };
      },
    });

    const wantFlow = ctx.wants('flow');
    if (lakeFill > 0 || wantFlow) await routeExactly(state.z, state.w, state.area, 'single');
    else ctx.clear(state.w, 0);
    ctx.run(finish, { in: { z: state.z, w: state.w, before: input }, out: { out: state.zNext }, params: { lakeFill, sea, land } });
    for (const plane of [state.z, state.areaNext, state.wNext, state.tot, state.w]) ctx.release(plane);
    ctx.output('out', state.zNext);
    if (ctx.wants('wear')) {
      const wear = ctx.alloc('field');
      ctx.run(diff, { in: { before: input, after: state.zNext }, out: { wear, deposit: null } });
      ctx.output('wear', wear);
    }
    if (wantFlow) ctx.output('flow', state.area);
    else ctx.release(state.area);
  },
});
