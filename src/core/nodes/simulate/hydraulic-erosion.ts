// src/core/nodes/simulate/hydraulic-erosion.ts
import { MASK_INPUT, defineKernel, defineNode, hash, mixSeed, ops, param, type Field } from '../../api.ts';
import {
  CARRY, CUT_SHARE, CUT_SLOPE, DETAIL_ITERATIONS_HYDRAULIC, D_MIN, ERODIBILITY_JITTER, FAN_ANGLE, FEATURE_CELLS, G, GATHER_MAX, HEAD_RAIN, H_REF, KE, NOMINAL_SPEED, PICKUP,
  PIPE_SAFETY, RAIN_MAX, SETTLE, SIN_MIN, wgsl,
} from './_constants.ts';
import { diff } from './_diff.ts';
import { levelBudget, levelInput, refineHeight, refineKernels, refinePlane } from './_refine.ts';
import { talusStep } from './_talus.ts';

/** The feature size a typed value is held to: the base level needs a texel to work with, and the terrain is the largest feature. */
const SIZE_MIN = 1e-4, SIZE_MAX = 1;
/** The wave of the model travels this many texels per iteration (simulation.md 4.7). */
const WAVE_CELLS = PIPE_SAFETY / Math.SQRT2;
/** Seconds of simulated time per iteration and metre of cell size: the gravity-wave bound with its safety factor. */
const DT_PER_METRE = PIPE_SAFETY / Math.sqrt(2 * G * H_REF);

// Pass 1 (Mei07 eq. 2 to 5): the four pipes of every texel are accelerated by the difference of the water
// surfaces and scaled so that the texel gives away no more water than it holds. E, N, W, S are the N4 directions
// 0..3 of simulation.md 1.3: +x, +y, -x, -y.
const flux = defineKernel({
  name: 'simulate/hydraulic-erosion.flux',
  inputs: { b: 'field', d: 'field' },
  inPlace: { fluxE: 'field', fluxN: 'field', fluxW: 'field', fluxS: 'field' },
  params: { dt: 'f32', sea: 'f32' },
  cost: 14,
  code: /* wgsl */ `
const PIPE = ${wgsl(G * H_REF)};      // G * H_REF: the pipe's cross-section over its length, times gravity

// Metres by which this texel's water surface stands above that of neighbour q. Outside the grid lies dry ground at this texel's height.
fn head(bp: f32, dp: f32, q: vec2i) -> f32 {
  if (!inGrid(q)) { return frame.heightRange * dp; }
  return frame.heightRange * ((bp - b_at(q)) + (dp - d_at(q)));
}

fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let bp = b_at(px);
  let dp = d_at(px);
  if (bp <= P.sea) { return Out(0.0, 0.0, 0.0, 0.0); }
  let toE = max(0.0, cur.fluxE + P.dt * PIPE * head(bp, dp, px + vec2i(1, 0)));
  let toN = max(0.0, cur.fluxN + P.dt * PIPE * head(bp, dp, px + vec2i(0, 1)));
  let toW = max(0.0, cur.fluxW + P.dt * PIPE * head(bp, dp, px - vec2i(1, 0)));
  let toS = max(0.0, cur.fluxS + P.dt * PIPE * head(bp, dp, px - vec2i(0, 1)));
  let k = min(1.0, frame.heightRange * dp * frame.cellSize * frame.cellSize / max(P.dt * (toE + toN + toW + toS), 1e-30));
  return Out(k * toE, k * toN, k * toW, k * toS);
}`,
});

// Pass 2 (Mei07 eq. 6 to 10, JT11 eq. 12, 13; the capacity is this engine's): the new water depth, the speed of
// the water, how much sediment it can carry, and from that the change of the terrain in this iteration.
// g = (that change, the depth before the flow).
const water = defineKernel({
  name: 'simulate/hydraulic-erosion.water',
  inputs: {
    b: 'field', s: 'field', rest: 'field', mask: MASK_INPUT,
    fluxE: 'field', fluxN: 'field', fluxW: 'field', fluxS: 'field',
  },
  outputs: { g: 'vec2' },
  inPlace: { d: 'field', flow: 'field' },
  // perHead: one over the discharge of a channel head per metre of its width, s/m2. deepest: the depth of the deepest gully, in metres.
  params: { dt: 'f32', sea: 'f32', capacity: 'f32', downcutting: 'f32', deposition: 'f32', perHead: 'f32', deepest: 'f32' },
  includes: [hash],
  cost: 23,
  code: /* wgsl */ `
const V_MAX = ${wgsl(Math.sqrt(2 * G * H_REF))};      // the fastest speed the time step resolves
const D_MIN = ${wgsl(D_MIN)};
const CUT_SLOPE = ${wgsl(CUT_SLOPE)};
const PICKUP = ${wgsl(PICKUP)};
const SETTLE = ${wgsl(SETTLE)};
const GATHER_MAX = ${wgsl(GATHER_MAX)};
const CARRY = ${wgsl(CARRY)};
const SIN_MIN = ${wgsl(SIN_MIN)};
const JITTER = ${wgsl(ERODIBILITY_JITTER)};
const QUANTUM = 1.1920928955078125e-7;      // 2^-23: one float32 step of a height between 1 and 2

// The lowest terrain among the N4 neighbours inside the grid.
fn lowest(px: vec2i) -> f32 {
  var low = 1e30;
  if (inGrid(px + vec2i(1, 0))) { low = min(low, b_at(px + vec2i(1, 0))); }
  if (inGrid(px + vec2i(0, 1))) { low = min(low, b_at(px + vec2i(0, 1))); }
  if (inGrid(px - vec2i(1, 0))) { low = min(low, b_at(px - vec2i(1, 0))); }
  if (inGrid(px - vec2i(0, 1))) { low = min(low, b_at(px - vec2i(0, 1))); }
  return low;
}

fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let bp = b_at(px);
  if (bp <= P.sea) { return Out(vec2f(0.0), 0.0, cur.flow); }
  let hr = frame.heightRange;
  let dx = frame.cellSize;
  let outE = fluxE_at(px);
  let outN = fluxN_at(px);
  let outW = fluxW_at(px);
  let outS = fluxS_at(px);
  // What the four neighbours send here; nothing comes from outside the grid.
  let inE = select(0.0, fluxW_at(px + vec2i(1, 0)), inGrid(px + vec2i(1, 0)));
  let inN = select(0.0, fluxS_at(px + vec2i(0, 1)), inGrid(px + vec2i(0, 1)));
  let inW = select(0.0, fluxE_at(px - vec2i(1, 0)), inGrid(px - vec2i(1, 0)));
  let inS = select(0.0, fluxN_at(px - vec2i(0, 1)), inGrid(px - vec2i(0, 1)));

  let d1 = hr * cur.d;
  let dNew = max(0.0, cur.d + P.dt * ((inE + inN + inW + inS) - (outE + outN + outW + outS)) / (dx * dx * hr));
  let d2 = hr * dNew;
  let through = 0.5 * vec2f(inW - outW + outE - inE, inS - outS + outN - inN);
  let dMean = 0.5 * (d1 + d2);
  var speed = 0.0;
  if (dMean > D_MIN) { speed = min(length(through) / (dx * dMean), V_MAX); }

  let slope = slopeAt(rest, px);
  let steep = dot(slope, slope);
  let sinA = sqrt(steep / (1.0 + steep));
  // Water carries once a channel head's worth of it has gathered, and more the more there is, up to a limit: the
  // film on a slope carves nothing. gathered: the water beyond one channel head, in channel heads.
  let gathered = clamp(speed * dMean * P.perHead - 1.0, 0.0, GATHER_MAX);
  let carry = P.capacity * CARRY * max(sinA, SIN_MIN) * (speed / V_MAX) * gathered;     // metres of sediment
  // The deeper a channel has cut below the ground it found, the harder the ground. The depth at which it cuts no
  // further grows with its water, up to P.deepest: a rill stays shallow and a gully cuts deep. On gentle ground,
  // which has little fall to cut into, it is a share of that.
  let cut = hr * (rest_at(px) - bp);
  let deepest = max(P.deepest * min(max(sinA, SIN_MIN) / CUT_SLOPE, 1.0) * gathered / GATHER_MAX, 1e-6);
  let erodible = mask_at(px) * (1.0 - JITTER * hash_unit(hash_cell(px, seedFor(1u)))) * saturate(1.0 - cut / deepest);
  let held = hr * s_at(px);

  var change = 0.0;      // metres: positive erodes, negative lays down
  if (carry > held) {
    change = min(min(min(P.dt * P.downcutting * PICKUP, 1.0) * erodible * (carry - held), d2), hr * max(bp - lowest(px), 0.0));
  } else {
    change = -min(P.dt * P.deposition * SETTLE, 1.0) * (held - carry);
  }
  // In whole steps of the terrain plane, so that the terrain and the sediment change by the same number: the
  // subtraction of the next pass is then exact for every height below 2. (b - (b - x) would say the same, but a
  // compiler may shorten it to x.) No more is laid down than is suspended.
  var delta = round(change / hr / QUANTUM) * QUANTUM;
  if (delta < 0.0) { delta = -min(-delta, floor(s_at(px) / QUANTUM) * QUANTUM); }
  return Out(vec2f(delta, cur.d), dNew, cur.flow + speed * dMean * P.dt);
}`,
});

// Pass 3 (JT11 eq. 12c, 13c; the transport is this engine's): the terrain and the water take the change, the
// water evaporates and the next rain falls, and the sediment moves with the water that left each texel. Of what
// was eroded only the share P.keep is suspended: the rest is carried out of the terrain.
const erode = defineKernel({
  name: 'simulate/hydraulic-erosion.erode',
  inputs: {
    g: 'vec2', s: 'field', precipitation: MASK_INPUT,
    fluxE: 'field', fluxN: 'field', fluxW: 'field', fluxS: 'field',
  },
  outputs: { next: 'field' },
  inPlace: { b: 'field', d: 'field' },
  params: { dt: 'f32', sea: 'f32', rain: 'f32', keep: 'f32' },      // rain: metres per second. keep: the share of the eroded material that stays in the water
  cost: 21,
  code: /* wgsl */ `
const KE = ${wgsl(KE)};
const D_MIN = ${wgsl(D_MIN)};

// Sediment of texel q after its own change: what it held, plus the share of what it eroded that is not washed away, less what it laid down.
fn stirred(q: vec2i) -> f32 {
  let delta = g_at(q).x;
  return s_at(q) + select(delta, P.keep * delta, delta > 0.0);
}

// The share of texel q's water that left through a pipe carrying f. q had the depth g.y before the flow.
fn share(q: vec2i, f: f32, dt: f32) -> f32 {
  let depth = frame.heightRange * g_at(q).y;
  if (depth <= D_MIN) { return 0.0; }
  return dt * f / (frame.cellSize * frame.cellSize * depth);
}

fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  if (cur.b <= P.sea) { return Out(0.0, cur.b, 0.0); }
  let delta = g_at(px).x;
  let wet = max(0.0, cur.d + delta) * (1.0 - min(KE * P.dt, 1.0)) + P.dt * P.rain * precipitation_at(px) / frame.heightRange;

  let gone = share(px, fluxE_at(px), P.dt) + share(px, fluxN_at(px), P.dt) + share(px, fluxW_at(px), P.dt) + share(px, fluxS_at(px), P.dt);
  var held = stirred(px) * max(0.0, 1.0 - gone);
  let qe = px + vec2i(1, 0);
  let qn = px + vec2i(0, 1);
  let qw = px - vec2i(1, 0);
  let qs = px - vec2i(0, 1);
  if (inGrid(qe)) { held += share(qe, fluxW_at(qe), P.dt) * stirred(qe); }
  if (inGrid(qn)) { held += share(qn, fluxS_at(qn), P.dt) * stirred(qn); }
  if (inGrid(qw)) { held += share(qw, fluxE_at(qw), P.dt) * stirred(qw); }
  if (inGrid(qs)) { held += share(qs, fluxN_at(qs), P.dt) * stirred(qs); }
  return Out(held, cur.b - delta, wet);
}`,
});

// Pass 5: the sediment still in the water comes to rest where it is, and the accumulated flow becomes its time average.
const settle = defineKernel({
  name: 'simulate/hydraulic-erosion.settle',
  inputs: { s: 'field' },
  inPlace: { b: 'field', flow: 'field' },
  params: { time: 'f32' },      // simulated seconds of the run
  cost: 3,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let held = s_at(px);
  // A texel that holds nothing keeps its bits.
  return Out(select(cur.b + held, cur.b, held == 0.0), cur.flow / P.time);
}`,
});

interface State {
  base: Field<'field'>;
  b: Field<'field'>; s: Field<'field'>; spare: Field<'field'>; d: Field<'field'>;
  fluxE: Field<'field'>; fluxN: Field<'field'>; fluxW: Field<'field'>; fluxS: Field<'field'>;
  g: Field<'vec2'>;
  flow: Field<'field'> | null;
}

export default defineNode({
  type: 'simulate/hydraulic-erosion',
  title: 'Hydraulic Erosion',
  category: 'simulate',
  description: 'Lets rain run off the terrain, cutting gullies where the water is fast and laying sediment down as fans and valley floors where it slows.',
  keywords: ['rain', 'water', 'gully', 'rill', 'alluvial', 'fan', 'sediment', 'runoff', 'erode', 'virtual pipes'],
  inputs: [
    { name: 'in', type: 'field' },
    { name: 'mask', type: 'field', role: 'mask', optional: true },
    { name: 'precipitation', type: 'field', role: 'mask', optional: true },
  ],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'wear', type: 'field', role: 'data' },
    { name: 'deposit', type: 'field', role: 'data' },
    { name: 'flow', type: 'field', role: 'data' },
  ],
  params: [
    param.size({
      default: 0.05, min: 0.005, max: 0.5,
      help: 'Scale of the largest gullies. Larger values let the water gather over wider slopes and cut broader, deeper channels.',
    }),
    {
      kind: 'float', name: 'duration', label: 'Duration', unit: 'none', default: 2, min: 0.05, max: 16, scale: 'log',
      help: 'How long it rains, as the distance running water covers in feature sizes. Longer runs cut deeper and fill the valleys more.',
    },
    {
      kind: 'float', name: 'rain', label: 'Rain', unit: 'ratio', default: 0.24, min: 0, max: 1,
      help: 'How hard it rains. More water reaches further up the slopes, runs faster and moves more material.',
    },
    {
      kind: 'float', name: 'capacity', label: 'Sediment capacity', unit: 'none', default: 1, min: 0.1, max: 3,
      help: 'How much sediment running water can carry. Higher values deepen the gullies and enlarge the deposits.',
    },
    {
      kind: 'float', name: 'downcutting', label: 'Downcutting', unit: 'none', default: 0.5, min: 0.1, max: 2,
      help: 'How quickly water picks material up. Higher values cut sharper, deeper channels close to where the water gathers.',
    },
    {
      kind: 'float', name: 'deposition', label: 'Deposition', unit: 'none', default: 1, min: 0.1, max: 3,
      help: 'How quickly sediment settles when the water slows. Higher values drop it sooner, as fans at the foot of the slopes.',
    },
    {
      kind: 'float', name: 'removal', label: 'Removal', unit: 'ratio', default: 0.6, min: 0, max: 1,
      help: 'Share of the eroded material that the water carries away for good. Higher values leave the gullies and lay down smaller fans.',
    },
    param.slope('talus', {
      label: 'Talus angle', default: 45, min: 5, max: 90,
      help: 'Banks steeper than this slump while the water cuts. At the largest value nothing slumps and the channels keep their walls.',
    }),
    {
      kind: 'float', name: 'detail', label: 'Detail', unit: 'ratio', default: 0, min: 0, max: 1,
      help: 'Fine roughness added each time the simulation moves to a finer grid, which gives the water new paths to find.',
    },
    param.seed({ help: 'Changes the small differences in hardness that decide where the water starts to cut.' }),
  ],
  kernels: [flux, water, erode, settle, talusStep, diff, ...refineKernels],
  uses: ['seaLevel'],
  async evaluate(ctx) {
    const { duration, rain, capacity, downcutting, deposition, removal, detail } = ctx.params;
    const size = Math.min(Math.max(ctx.params.size, SIZE_MIN), SIZE_MAX);
    const input = ctx.input('in');
    const mask = ctx.input('mask');
    const precipitation = ctx.input('precipitation');
    const sea = ctx.setting('seaLevel');
    const talus = Math.tan((ctx.params.talus * Math.PI) / 180);
    const fan = Math.tan((FAN_ANGLE * Math.PI) / 180);
    const wantFlow = ctx.wants('flow');
    let budget: readonly number[] = [];
    let simulatedTime = 1;

    const scratch = (like: Field<'field'>) => ({
      spare: ctx.alloc('field', { like }),
      fluxE: ctx.alloc('field', { like, clear: 0 }), fluxN: ctx.alloc('field', { like, clear: 0 }),
      fluxW: ctx.alloc('field', { like, clear: 0 }), fluxS: ctx.alloc('field', { like, clear: 0 }),
      g: ctx.alloc('vec2', { like }),
    });

    const state = await ops.coarseToFine<State>(ctx, {
      coarsestCell: size / FEATURE_CELLS,
      begin(level) {
        const cells = size * (level.res - 1);
        const planned = levelBudget((duration * cells) / (WAVE_CELLS * NOMINAL_SPEED), level.count, DETAIL_ITERATIONS_HYDRAULIC, 0.5);
        budget = planned.iterations;
        simulatedTime = Math.max(DT_PER_METRE * level.cellSize * planned.equivalent, 1e-9);
        const base = levelInput(ctx, input, level);
        const b = ctx.clone(base);
        return {
          base, b,
          s: ctx.alloc('field', { like: b, clear: 0 }),
          d: ctx.alloc('field', { like: b, clear: 0 }),
          ...scratch(b),
          flow: wantFlow ? ctx.alloc('field', { like: b, clear: 0 }) : null,
        };
      },
      async simulate(level, st) {
        const gate = mask ? levelInput(ctx, mask, level) : null;
        const wet = precipitation ? levelInput(ctx, precipitation, level) : null;
        const dt = DT_PER_METRE * level.cellSize;
        const pipes = () => ({ fluxE: st.fluxE, fluxN: st.fluxN, fluxW: st.fluxW, fluxS: st.fluxS });
        await ctx.loop(budget[level.index]!, () => {
          ctx.run(flux, { in: { b: st.b, d: st.d }, rw: pipes(), params: { dt, sea } });
          ctx.run(water, {
            in: { b: st.b, s: st.s, rest: st.base, mask: gate, ...pipes() }, out: { g: st.g }, rw: { d: st.d, flow: st.flow },
            params: { dt, sea, capacity, downcutting, deposition, perHead: 1 / (HEAD_RAIN * size * ctx.terrainSize), deepest: CUT_SHARE * size * ctx.terrainSize },
          });
          ctx.run(erode, {
            in: { g: st.g, s: st.s, precipitation: wet, ...pipes() }, out: { next: st.spare }, rw: { b: st.b, d: st.d },
            params: { dt, sea, rain: rain * RAIN_MAX, keep: 1 - removal },
          });
          [st.s, st.spare] = [st.spare, st.s];
          ctx.run(talusStep, { in: { h: st.b, mask: gate, rest: st.base }, out: { next: st.spare }, params: { talus, fan, keep: 1 } });
          [st.b, st.spare] = [st.spare, st.b];
        }, { label: 'Hydraulic erosion', progress: level.progress, preview: () => ({ out: st.b }) });
        if (gate && gate !== mask) ctx.release(gate);
        if (wet && wet !== precipitation) ctx.release(wet);
      },
      refine(_coarse, fine, st) {
        for (const plane of [st.spare, st.fluxE, st.fluxN, st.fluxW, st.fluxS, st.g]) ctx.release(plane);
        const salt = mixSeed(ctx.seed, fine.res);
        const base = levelInput(ctx, input, fine);
        const b = refineHeight(ctx, { coarse: st.b, coarseBase: st.base, fineBase: base, jitter: true, salt, detail });
        ctx.release(st.b);
        if (st.base !== input) ctx.release(st.base);
        const carried = (plane: Field<'field'>): Field<'field'> => {
          const refined = refinePlane(ctx, plane, { size: fine.res });
          ctx.release(plane);
          return refined;
        };
        const s = carried(st.s);
        const d = carried(st.d);
        const flow = st.flow ? carried(st.flow) : null;
        return { base, b, s, d, ...scratch(b), flow };
      },
    });

    ctx.run(settle, { in: { s: state.s }, rw: { b: state.b, flow: state.flow }, params: { time: simulatedTime } });
    for (const plane of [state.s, state.spare, state.d, state.fluxE, state.fluxN, state.fluxW, state.fluxS, state.g]) ctx.release(plane);
    ctx.output('out', state.b);
    const wear = ctx.wants('wear') ? ctx.alloc('field') : null;
    const deposit = ctx.wants('deposit') ? ctx.alloc('field') : null;
    if (wear || deposit) ctx.run(diff, { in: { before: input, after: state.b }, out: { wear, deposit } });
    if (wear) ctx.output('wear', wear);
    if (deposit) ctx.output('deposit', deposit);
    if (state.flow) ctx.output('flow', state.flow);
  },
});
