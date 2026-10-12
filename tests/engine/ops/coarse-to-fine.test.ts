// ops.coarseToFine (engine.md section 5, simulation.md section 2): level selection, the call sequence, the share
// of progress and of work per level, determinism, cancellation, and a relaxation that converges through the
// driver where the same work at full resolution alone does not.
//
// The first tests give the driver a context that only has what it reads (the ladder, the terrain size, the
// signal, progress), which lets them state the levels of 8129 without a texture. The others run a toy node on
// the engine. Sizes there: fields of at most 513 x 513 floats (1 MiB), at most 4 000 iterations of a 5-load
// kernel, bounded loops everywhere. No list of field size is handed to an assertion.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, defineNode, ops, type Field, type LadderLevel, type OpContext } from '../../../src/core/api.ts';
import { ladder } from '../../../src/core/graph/ladder.ts';
import fbmNode from '../../../src/core/nodes/ref/fbm.ts';
import { endings, eventsOf, SETTINGS, startEngine } from '../eval/rig.ts';
import { writeGrey, writeHillshade } from '../pictures.ts';
import { assertIdentical, grid, rangeOf, worstOf } from './rig.ts';

// ---- the iteration-budget rule of simulation.md 2.5, as a reference ----------------------------------------------

/** Iterations per level, index = LadderLevel.index: one iteration at level i counts ratio^i base iterations. */
function levelBudget(total: number, levels: number, perLevel: number, ratio: 0.5 | 0.25): { iterations: number[]; equivalent: number } {
  const finer = levels - 1;
  const tail = (n: number): number => (n * ratio * (1 - ratio ** finer)) / (1 - ratio);
  const detail = finer > 0 ? Math.min(perLevel, Math.floor(total / 2)) : 0;
  const base = total < 0.5 ? 0 : Math.ceil(total - tail(detail));
  return { iterations: [base, ...Array.from({ length: finer }, () => detail)], equivalent: base + tail(detail) };
}

// ---- a toy simulation on the engine ----------------------------------------------------------------------------

/** Cells of the base level a feature of `size` spans, and the iterations a finer level may take. */
const FEATURE_CELLS = 16;
const DETAIL_ITERATIONS = 96;

// One damped Jacobi step of the Laplace equation: a texel moves most of the way to the mean of its four
// neighbours; the border ring is held. The steady state is the harmonic surface through the border values.
const relaxStep = defineKernel({
  name: 'test/relax',
  inputs: { h: 'field' },
  outputs: { next: 'field' },
  cost: 5,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let last = vec2i(frame.res) - vec2i(1);
  let here = h_at(px);
  if (any(px == vec2i(0)) || any(px == last)) { return here; }
  let mean = 0.25 * (h_at(px + vec2i(1, 0)) + h_at(px - vec2i(1, 0)) + h_at(px + vec2i(0, 1)) + h_at(px - vec2i(0, 1)));
  return mix(here, mean, 0.8);
}`,
});

// The standard refinement of simulation.md 2.4 without jitter and detail: the fine input plus the change the
// coarse level made, interpolated at px / 2.
const refineKernel = defineKernel({
  name: 'test/refine',
  inputs: { fineBase: 'field', coarse: { kind: 'field', size: 'any' }, coarseBase: { kind: 'field', size: 'any' } },
  outputs: { out: 'field' },
  cost: 9,
  code: /* wgsl */ `
fn delta(c: vec2i) -> f32 { return coarse_at(c) - coarseBase_at(c); }

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let c = clamp(vec2f(px) * 0.5, vec2f(0.0), vec2f(coarse_res()) - vec2f(1.0));
  let i = vec2i(floor(c));
  let f = c - floor(c);
  let d = mix(mix(delta(i), delta(i + vec2i(1, 0)), f.x), mix(delta(i + vec2i(0, 1)), delta(i + vec2i(1, 1)), f.x), f.y);
  return fineBase_at(px) + d;
}`,
});

/** What the node under test did, and what a test wants done at an iteration. */
const trace: {
  levels: LadderLevel[];
  calls: string[];
  /** Calls of the loop body, by level index. */
  iterations: number[];
  budget: number[];
  equivalent: number;
  at?: (level: LadderLevel, i: number) => void;
  rejection?: unknown;
} = { levels: [], calls: [], iterations: [], budget: [], equivalent: 0 };

function resetTrace(): void {
  trace.levels = [];
  trace.calls = [];
  trace.iterations = [];
  trace.budget = [];
  trace.equivalent = 0;
  delete trace.at;
  delete trace.rejection;
}

interface State { h: Field<'field'>; spare: Field<'field'>; base: Field<'field'> }

/**
 * simulation.md 2.4: the node input on the grid of `level`; the input itself when it already has that size.
 * With `sampled` the coarser levels take the input's own values at the shared vertices instead of a filtered input.
 */
const levelInput = (ctx: OpContext, input: Field<'field'>, level: LadderLevel, sampled: boolean): Field<'field'> =>
  (input.width === level.res ? input : ops.resample(ctx, input, { size: level.res, filter: sampled ? 'nearest' : 'auto' }));

/** The skeleton of simulation.md 2.7 around the toy step. */
const relaxNode = defineNode({
  type: 'ref/relax',
  title: 'Relax (Test)',
  category: 'ref',
  description: 'Relaxes a surface towards the harmonic surface through its border, up the ladder.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    { kind: 'float', name: 'size', unit: 'length', default: 0.5, min: 1e-6, max: 4, help: 'The size of the features to relax.' },
    { kind: 'float', name: 'total', unit: 'none', default: 100, min: 0, max: 100_000, help: 'The work, as steps on the base level.' },
    { kind: 'bool', name: 'sampled', default: false, help: 'Whether a coarser level samples the input instead of filtering it.' },
  ],
  kernels: [relaxStep, refineKernel],
  async evaluate(ctx) {
    const { size, total, sampled } = ctx.params;
    const input = ctx.input('in');
    let budget: readonly number[] = [];
    const state = await ops.coarseToFine<State>(ctx, {
      coarsestCell: size / FEATURE_CELLS,
      begin(level) {
        const planned = levelBudget(total, level.count, DETAIL_ITERATIONS, 0.25);
        budget = planned.iterations;
        trace.budget = planned.iterations;
        trace.equivalent = planned.equivalent;
        trace.iterations = planned.iterations.map(() => 0);
        trace.calls.push(`begin ${level.res}`);
        trace.levels.push(level);
        const base = levelInput(ctx, input, level, sampled);
        return { base, h: ctx.clone(base), spare: ctx.alloc('field', { like: base }) };
      },
      async simulate(level, s) {
        trace.calls.push(`simulate ${level.res}`);
        try {
          await ctx.loop(budget[level.index]!, (i) => {
            trace.at?.(level, i);
            trace.iterations[level.index]!++;
            ctx.run(relaxStep, { in: { h: s.h }, out: { next: s.spare } });
            [s.h, s.spare] = [s.spare, s.h];
          }, { label: 'Relaxing', progress: level.progress, preview: () => ({ out: s.h }) });
        } catch (thrown) {
          trace.rejection = thrown;
          throw thrown;
        }
      },
      refine(coarse, fine, s) {
        trace.calls.push(`refine ${coarse.res} ${fine.res}`);
        trace.levels.push(fine);
        ctx.release(s.spare);
        const base = levelInput(ctx, input, fine, sampled);
        const h = ctx.alloc('field', { like: base });
        ctx.run(refineKernel, { in: { fineBase: base, coarse: s.h, coarseBase: s.base }, out: { out: h } });
        ctx.release(s.h);
        if (s.base !== input) ctx.release(s.base);
        return { base, h, spare: ctx.alloc('field', { like: h }) };
      },
    });
    ctx.release(state.spare);
    assert.equal(state.base, input, 'the base of the last level is the input itself');
    ctx.output('out', state.h);
  },
});

/** Test data by name, for the source node: a function of the resolution. */
const surfaces = new Map<string, (res: number) => Float32Array>();

const dataNode = defineNode({
  type: 'ref/data',
  title: 'Data (Test)',
  category: 'ref',
  description: 'Uploads the surface a test registered.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'text', name: 'surface', default: '', help: 'The registered surface.' }],
  kernels: [],
  evaluate(ctx) {
    const out = ctx.alloc('field');
    ctx.write(out, surfaces.get(ctx.params.surface)!(ctx.res));
    ctx.output('out', out);
  },
});

/** Starts the driver inside a ctx.loop body, which no asynchronous op may be (engine.md 4.7, loop rule 3). */
const misuseNode = defineNode({
  type: 'ref/misuse',
  title: 'Misuse (Test)',
  category: 'ref',
  description: 'Calls the driver where it must not be called.',
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [],
  kernels: [],
  async evaluate(ctx) {
    await ctx.loop(1, () => {
      void ops.coarseToFine(ctx, { coarsestCell: 1, begin: () => { trace.calls.push('begin'); }, simulate: async () => undefined, refine: () => undefined });
    });
    ctx.output('out', ctx.alloc('field', { clear: 0 }));
  },
});

const DEFS = [relaxNode, dataNode, fbmNode, misuseNode];
// Before the first test(): node:test runs the tests it knows, and then the hook that destroys the device, while a
// module is still waiting at a top-level await.
const t = await startEngine(DEFS);
after(() => t.dispose());

// ---- the driver alone ------------------------------------------------------------------------------------------

interface Stub { readonly ctx: OpContext; readonly progress: number[]; abort(reason?: unknown): void }

/** A context with the members the driver reads. Every other member throws: the driver allocates nothing and runs no kernel. */
function stubContext(res: number, terrainSize = 4096): Stub {
  const controller = new AbortController();
  const progress: number[] = [];
  const own: Partial<OpContext> = {
    res, terrainSize, heightRange: 1024, cellSize: terrainSize / (res - 1), ladder: ladder(res), signal: controller.signal,
    progress: (fraction) => void progress.push(fraction),
  };
  const ctx = new Proxy(own, {
    get(target, name) {
      if (name in target) return target[name as keyof OpContext];
      throw new Error(`the driver used ctx.${String(name)}`);
    },
  }) as OpContext;
  return { ctx, progress, abort: (reason) => controller.abort(reason) };
}

/** The levels a run visits, with everything the driver calls, in order. */
async function drive(res: number, coarsestCell: number): Promise<{ levels: LadderLevel[]; calls: string[]; progress: number[]; state: unknown }> {
  const stub = stubContext(res);
  const levels: LadderLevel[] = [];
  const calls: string[] = [];
  const state = await ops.coarseToFine<{ res: number }>(stub.ctx, {
    coarsestCell,
    begin(level) {
      calls.push(`begin ${level.res}`);
      levels.push(level);
      return { res: level.res };
    },
    async simulate(level, s) {
      assert.equal(s.res, level.res, 'simulate gets the state of its level');
      calls.push(`simulate ${level.res}`);
      await Promise.resolve();
    },
    refine(coarse, fine, s) {
      assert.equal(s.res, coarse.res, 'refine gets the state of the coarse level');
      calls.push(`refine ${coarse.res} ${fine.res}`);
      levels.push(fine);
      return { res: fine.res };
    },
  });
  return { levels, calls, progress: stub.progress, state };
}

test('level selection: from the coarsest ladder level whose cell is at most coarsestCell up to ctx.res (simulation.md 2.1)', async () => {
  const table: readonly (readonly [number, number, readonly number[]])[] = [
    [8129, 1 / 256, [509, 1017, 2033, 4065, 8129]],
    [1017, 1 / 256, [509, 1017]],
    [8129, 1 / 640, [1017, 2033, 4065, 8129]],
    [509, 1 / 640, [509]],
    [4033, 1 / 256, [505, 1009, 2017, 4033]],
    [8129, 1 / 50, [128, 255, 509, 1017, 2033, 4065, 8129]],
    [8129, 1 / 20000, [8129]],
    // A cell that is exactly a level's is that level; resolutions without a coarser level; any cell on a huge length.
    [513, 1 / 64, [65, 129, 257, 513]],
    [513, 1 / 63.9, [65, 129, 257, 513]],
    [513, 1 / 64.1, [129, 257, 513]],
    [128, 1 / 8, [128]],
    [100, 1, [100]],
    [2017, 1e9, [64, 127, 253, 505, 1009, 2017]],
  ];
  for (const [res, coarsestCell, expected] of table) {
    const { levels } = await drive(res, coarsestCell);
    assert.deepEqual(levels.map((l) => l.res), expected, `res ${res}, coarsestCell 1/${1 / coarsestCell}`);
    levels.forEach((level, index) => {
      assert.equal(level.index, index);
      assert.equal(level.count, expected.length);
      assert.equal(level.cellSize, 4096 / (level.res - 1));
    });
  }
});

test('the call sequence: begin at the base level, then simulate and refine in turn until simulate has run at ctx.res (2.2)', async () => {
  const run = await drive(1017, 1 / 200);
  assert.deepEqual(run.calls, [
    'begin 255', 'simulate 255', 'refine 255 509', 'simulate 509', 'refine 509 1017', 'simulate 1017',
  ]);
  assert.deepEqual(run.state, { res: 1017 }, 'the driver resolves with the state of the last level');
  const single = await drive(509, 1 / 640);
  assert.deepEqual(single.calls, ['begin 509', 'simulate 509']);
  assert.deepEqual(single.state, { res: 509 });
});

test('progress: the levels share 0..1 in proportion to their texel counts, and the driver reports the end of each (2.3)', async () => {
  const run = await drive(8129, 1 / 256);
  const ends = run.levels.map((l) => l.progress[1]);
  // simulation.md 2.3: "the ranges end at 0.003, 0.015, 0.062, 0.249 and 1".
  assert.deepEqual(ends.map((e) => Math.round(e * 1000) / 1000), [0.003, 0.015, 0.062, 0.249, 1]);
  assert.equal(ends[4], 1);
  assert.equal(run.levels[0]!.progress[0], 0);
  const total = run.levels.reduce((sum, l) => sum + l.res * l.res, 0);
  run.levels.forEach((level, i) => {
    if (i > 0) assert.equal(level.progress[0], run.levels[i - 1]!.progress[1], 'the ranges are contiguous');
    const share = level.progress[1] - level.progress[0];
    assert.ok(Math.abs(share - (level.res * level.res) / total) < 1e-12, `level ${level.res}: its share is ${share}`);
  });
  assert.deepEqual(run.progress, [0, ...ends], 'ctx.progress is called with the start of the run and the end of each level, in order');
  assert.deepEqual((await drive(509, 1 / 640)).levels[0]!.progress, [0, 1]);
});

test('coarsestCell must be a length above 0, and the three callbacks functions', async () => {
  const { ctx } = stubContext(513);
  const callbacks = { begin: () => 0, simulate: async () => undefined, refine: () => 0 };
  for (const coarsestCell of [0, -1, Number.NaN, Infinity, -Infinity, '0.1' as unknown as number, undefined as unknown as number]) {
    assert.throws(() => ops.coarseToFine(ctx, { ...callbacks, coarsestCell }), (e: Error) => e instanceof RangeError && /coarsestCell is .*; it is a length above 0/.test(e.message), String(coarsestCell));
  }
  assert.throws(() => ops.coarseToFine(ctx, { ...callbacks, coarsestCell: 0.1, refine: undefined as unknown as () => number }), TypeError);
});

test('begin and refine are synchronous: a state that is a promise rejects the run', async () => {
  const { ctx } = stubContext(513);
  await assert.rejects(ops.coarseToFine(ctx, {
    coarsestCell: 1 / 64,
    begin: (async () => 0) as unknown as () => number,
    simulate: async () => undefined,
    refine: () => 0,
  }), (e: Error) => e instanceof TypeError && /begin returned a promise/.test(e.message));
  let simulated = 0;
  await assert.rejects(ops.coarseToFine(ctx, {
    coarsestCell: 1 / 64,
    begin: () => 0,
    simulate: async () => void simulated++,
    refine: (async () => 0) as unknown as () => number,
  }), (e: Error) => e instanceof TypeError && /refine returned a promise/.test(e.message));
  assert.equal(simulated, 1, 'no level is simulated on a state that was not there yet');
});

test('the signal is checked before each call, and what a callback throws rejects the run (2.2 rule 4)', async () => {
  // Aborted before the run starts: nothing is called.
  const early = stubContext(513);
  early.abort();
  const calls: string[] = [];
  const record = {
    begin: (level: LadderLevel) => void calls.push(`begin ${level.res}`),
    simulate: async (level: LadderLevel) => void calls.push(`simulate ${level.res}`),
    refine: (coarse: LadderLevel) => void calls.push(`refine ${coarse.res}`),
  };
  await assert.rejects(async () => ops.coarseToFine(early.ctx, { coarsestCell: 1 / 64, ...record }), (e: unknown) => e === early.ctx.signal.reason);
  assert.equal(calls.length, 0);

  // Aborted while a level simulates, by a simulate that still resolves: refine is not called.
  const during = stubContext(513);
  calls.length = 0;
  const reason = new DOMException('stop', 'AbortError');
  await assert.rejects(ops.coarseToFine(during.ctx, {
    coarsestCell: 1 / 64, ...record,
    simulate: async (level) => {
      calls.push(`simulate ${level.res}`);
      if (level.res === 129) during.abort(reason);
    },
  }), (e: unknown) => e === reason);
  assert.deepEqual(calls, ['begin 65', 'simulate 65', 'refine 65', 'simulate 129']);
  assert.equal(during.progress.length, 2, 'the start and the end of the first level: nothing for the level that was cut short');

  // An error from each callback.
  for (const failing of ['begin', 'simulate', 'refine'] as const) {
    const stub = stubContext(513);
    const boom = new Error(`${failing} failed`);
    const run = ops.coarseToFine(stub.ctx, {
      coarsestCell: 1 / 64,
      begin: () => { if (failing === 'begin') throw boom; },
      simulate: async () => { if (failing === 'simulate') throw boom; },
      refine: () => { if (failing === 'refine') throw boom; },
    });
    await assert.rejects(run, (e: unknown) => e === boom, failing);
  }
});

test('iteration budgets: the starting schedules of simulation.md 2.5, and the per-level counts sum to the total', () => {
  // "Same work on 8129 alone" divided by the base iterations one iteration there counts.
  assert.deepEqual(levelBudget(8331 / 16, 5, 256, 0.5).iterations, [281, 256, 256, 256, 256]);
  assert.deepEqual(levelBudget(9196 / 8, 4, 384, 0.5).iterations, [814, 384, 384, 384]);
  assert.deepEqual(levelBudget(52852 / 256, 5, 96, 0.25).iterations, [175, 96, 96, 96, 96]);
  // The same nodes in a preview at 1017: "393 + 256, 1150, and 183 + 96".
  assert.deepEqual(levelBudget(8331 / 16, 2, 256, 0.5).iterations, [393, 256]);
  assert.deepEqual(levelBudget(9196 / 8, 1, 384, 0.5).iterations, [1150]);
  assert.deepEqual(levelBudget(52852 / 256, 2, 96, 0.25).iterations, [183, 96]);

  for (const ratio of [0.5, 0.25] as const) {
    for (const levels of [1, 2, 3, 5, 7]) {
      for (const total of [0, 0.4, 0.5, 1, 3, 17.5, 100, 206.45, 5000]) {
        const { iterations, equivalent } = levelBudget(total, levels, 96, ratio);
        assert.equal(iterations.length, levels);
        assert.ok(iterations.every((n) => Number.isInteger(n) && n >= 0), `${iterations}`);
        const sum = iterations.reduce((s, n, i) => s + n * ratio ** i, 0);
        assert.ok(Math.abs(sum - equivalent) < 1e-9, `total ${total}, ${levels} levels: the counts weigh ${sum}, equivalent is ${equivalent}`);
        // Equal to the total up to the rounding of the base count, whatever the number of levels.
        if (total < 0.5) assert.deepEqual(iterations, Array.from({ length: levels }, () => 0));
        else assert.ok(equivalent >= total && equivalent < total + 1, `total ${total}, ${levels} levels: equivalent ${equivalent}`);
        assert.ok(iterations.slice(1).every((n) => n <= 96 && n <= total / 2));
      }
    }
  }
});

// ---- the toy simulation on the engine --------------------------------------------------------------------------

/**
 * A surface whose relaxed state is known: `plane`, which the 5-point mean leaves alone on every grid, plus a
 * bump that is zero on the border ring of every level. Relaxing it removes the bump.
 */
const plane = (u: number, v: number): number => 0.5 + 0.3 * (u * u - v * v) + 0.1 * u - 0.05 * v;
const bump = (u: number, v: number): number => 8 * u * (1 - u) * v * (1 - v) * (1 + 0.5 * Math.sin(7 * u + 3 * v));
const onGrid = (res: number, fn: (u: number, v: number) => number): Float32Array => grid(res, res, (x, y) => fn(x / (res - 1), y / (res - 1)));
surfaces.set('bumped', (res) => onGrid(res, (u, v) => plane(u, v) + bump(u, v)));
surfaces.set('speckled', (res) => grid(res, res, (x, y) => 0.5 + 0.25 * Math.sin(0.37 * x) * Math.cos(0.23 * y) + ((x * 7 + y * 13) % 5) * 0.01));

interface Relaxed { readonly out: Float32Array; readonly status: string; readonly events: Awaited<ReturnType<typeof t.run>>['events'] }

async function relax(
  engine: typeof t, res: number, params: { size: number; total: number; sampled?: boolean }, opts: { surface?: string; signal?: AbortSignal; source?: 'fbm' } = {},
): Promise<Relaxed> {
  const doc = engine.doc({
    src: opts.source === 'fbm' ? { type: 'ref/fbm', params: { seed: 5 } } : { type: 'ref/data', params: { surface: opts.surface ?? 'bumped' } },
    relax: { type: 'ref/relax', params, inputs: { in: 'src.out' } },
  });
  const outcome = await engine.run(doc, ['relax.out'], { resolution: res, mode: 'build', ...(opts.signal ? { signal: opts.signal } : {}) });
  engine.noLeaks();
  if (!opts.signal) assert.equal(outcome.result.status, 'ok', JSON.stringify(outcome.result.errors));
  return { out: outcome.data[0] ?? new Float32Array(0), status: outcome.result.status, events: outcome.events };
}

test('on the engine: the level sequence, the call order and the per-level iteration counts for several resolutions', async () => {
  const cases: readonly (readonly [number, number, readonly number[]])[] = [
    // size / FEATURE_CELLS is the coarsest cell: 0.5 / 16 = 1/32.
    [513, 0.5, [33, 65, 129, 257, 513]],
    [257, 0.5, [33, 65, 129, 257]],
    [257, 0.25, [65, 129, 257]],
    [509, 0.25, [128, 255, 509]],
    [129, 0.5, [33, 65, 129]],
    [100, 0.5, [100]],
    [257, 1e-4, [257]],
  ];
  for (const [res, size, expected] of cases) {
    resetTrace();
    const total = 40;
    const run = await relax(t, res, { size, total });
    assert.deepEqual(trace.levels.map((l) => l.res), expected, `res ${res}, size ${size}`);
    const calls: string[] = [`begin ${expected[0]}`];
    expected.forEach((level, i) => {
      calls.push(`simulate ${level}`);
      if (i < expected.length - 1) calls.push(`refine ${level} ${expected[i + 1]}`);
    });
    assert.deepEqual(trace.calls, calls, `res ${res}, size ${size}`);
    trace.levels.forEach((level, i) => {
      assert.deepEqual([level.index, level.count], [i, expected.length]);
      assert.equal(level.cellSize, SETTINGS.terrainSize / (level.res - 1));
    });
    // The budget of 2.5 is what the loops ran, and it weighs the total whatever the number of levels.
    assert.deepEqual(trace.iterations, levelBudget(total, expected.length, DETAIL_ITERATIONS, 0.25).iterations);
    const weighed = trace.iterations.reduce((sum, n, i) => sum + n * 0.25 ** i, 0);
    assert.ok(weighed >= total && weighed < total + 1, `res ${res}: ${trace.iterations} weigh ${weighed}`);
    assert.equal(run.out.length, res * res);
  }
});

test('on the engine: the progress of the node follows the levels and ends at 1', async () => {
  resetTrace();
  const run = await relax(t, 257, { size: 0.5, total: 400 });
  const shares = trace.levels.map((l) => l.progress);
  const total = 33 * 33 + 65 * 65 + 129 * 129 + 257 * 257;
  assert.deepEqual(shares.map((s) => s[1]), [33 * 33 / total, (33 * 33 + 65 * 65) / total, (33 * 33 + 65 * 65 + 129 * 129) / total, 1]);
  assert.deepEqual(shares.map((s) => s[0]), [0, ...shares.slice(0, 3).map((s) => s[1])]);
  const fractions = eventsOf(run.events, 'node-progress').filter((e) => e.nodeId === 'relax').map((e) => e.fraction);
  assert.ok(fractions.length > 0, 'the node reported progress');
  assert.ok(fractions.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= fractions[i - 1]!)), `progress never goes back: ${fractions}`);
});

test('inside a ctx.loop body the driver throws at the call, before begin', async () => {
  resetTrace();
  const outcome = await t.run(t.doc({ n: { type: 'ref/misuse' } }), ['n.out'], { resolution: 65, mode: 'build' });
  t.noLeaks();
  assert.equal(outcome.result.status, 'errors');
  assert.deepEqual(outcome.result.errors.map((e) => [e.nodeId, e.kind]), [['n', 'binding']]);
  assert.match(outcome.result.errors[0]!.message, /^ops\.coarseToFine: ctx\.progress\(\) cannot be called inside a ctx\.loop body/);
  assert.deepEqual(trace.calls, []);
});

test('a budget of zero at every level returns the input bit for bit (simulation.md 1.7 rule 4)', async () => {
  resetTrace();
  const run = await relax(t, 257, { size: 0.5, total: 0.3 }, { surface: 'speckled' });
  assert.deepEqual(trace.iterations, [0, 0, 0, 0]);
  assert.equal(trace.levels.length, 4, 'every level was visited');
  assertIdentical(run.out, surfaces.get('speckled')!(257), 'four refinements of an unchanged surface');
});

test('two runs give bit-identical results, whatever the batches of ctx.loop', async () => {
  resetTrace();
  const slicesBefore = t.slices.length;
  const first = await relax(t, 257, { size: 0.5, total: 300 }, { surface: 'speckled' });
  const firstSlices = t.slices.length - slicesBefore;
  const firstCalls = trace.calls.length;
  const second = await relax(t, 257, { size: 0.5, total: 300 }, { surface: 'speckled' });
  assert.equal(trace.calls.length, 2 * firstCalls, 'the node ran both times');
  assertIdentical(second.out, first.out, 'the second run on the same engine');
  assert.ok(worstOf(first.out, surfaces.get('speckled')!(257)).difference > 0.01, 'the run changed the surface');

  // Every iteration its own batch, and tiles of at most 16 rows.
  const small = await startEngine(DEFS, { hooks: { sliceTargetMs: 1e-6, maxTileRows: 16 } });
  try {
    const sliced = await relax(small, 257, { size: 0.5, total: 300 }, { surface: 'speckled' });
    assertIdentical(sliced.out, first.out, 'small batches and tiles');
    assert.ok(small.slices.length > firstSlices, `the second engine cut the work finer: ${small.slices.length} slices against ${firstSlices}`);
  } finally {
    await small.dispose();
  }
});

test('cancelling in the middle of a level: the driver rejects with the reason, the pool is consistent and the next run is right', async () => {
  // Every iteration is a batch boundary, so the loop sees the signal at once.
  const small = await startEngine(DEFS, { hooks: { sliceTargetMs: 1e-6 } });
  try {
    resetTrace();
    const reference = await relax(small, 129, { size: 0.5, total: 200 }, { surface: 'speckled' });
    await small.engine.trim();
    const idle = small.engine.memory();

    for (const [levelIndex, iteration] of [[1, 5], [0, 0], [2, 40]] as const) {
      resetTrace();
      const controller = new AbortController();
      const seen: string[] = [];
      trace.at = (level, i) => {
        seen.push(`${level.index}:${i}`);
        if (level.index === levelIndex && i === iteration) controller.abort();
      };
      const cut = await relax(small, 129, { size: 0.5, total: 200 }, { surface: 'speckled', signal: controller.signal });
      assert.equal(cut.status, 'aborted');
      assert.equal(cut.out.length, 0, 'no field is delivered');
      assert.equal(endings(cut.events).relax, 'skipped:aborted');
      assert.equal(seen[seen.length - 1], `${levelIndex}:${iteration}`, 'the body is not called again once the signal has aborted');
      assert.equal(trace.rejection, controller.signal.reason, 'ctx.loop rejected with the reason');
      assert.equal(trace.calls[trace.calls.length - 1], `simulate ${[33, 65, 129][levelIndex]}`, 'the driver made no further call');
      // Nothing of the cancelled node is left: no WORKING texture, nothing pinned, and after a trim what was there before.
      small.noLeaks();
      await small.engine.trim();
      const memory = small.engine.memory();
      assert.deepEqual([memory.workingBytes, memory.pinnedBytes, memory.cacheBytes], [idle.workingBytes, idle.pinnedBytes, idle.cacheBytes]);
    }

    // The textures the cancelled runs gave back are recycled poisoned; a run that read one would not match.
    resetTrace();
    const again = await relax(small, 129, { size: 0.5, total: 200 }, { surface: 'speckled' });
    assertIdentical(again.out, reference.out, 'the run after three cancelled ones');
    assert.deepEqual(trace.levels.map((l) => l.res), [33, 65, 129]);
  } finally {
    await small.dispose();
  }
});

/** Largest distance of a relaxed surface from the harmonic one it tends to. */
const residual = (out: Float32Array, res: number): number => worstOf(out, onGrid(res, plane)).difference;

test('a relaxation converges through the driver where more work at full resolution alone hardly begins', async () => {
  const res = 257;
  const start = residual(surfaces.get('bumped')!(res), res);
  assert.ok(start > 0.4, `the bump is ${start} high`);

  // Through the driver: 33, 65, 129, 257. The levels sample the input, so each holds the border values the
  // relaxation tends to; a filtered input has other values on its border ring, and the coarse levels would
  // relax towards those.
  resetTrace();
  const driven = await relax(t, res, { size: 0.5, total: 1500, sampled: true });
  const drivenIterations = [...trace.iterations];
  const levels = trace.levels.map((l) => l.res);
  assert.deepEqual(levels, [33, 65, 129, 257]);
  assert.deepEqual(drivenIterations, [1469, 96, 96, 96]);
  const drivenWork = drivenIterations.reduce((sum, n, i) => sum + n * levels[i]! * levels[i]!, 0);

  // At full resolution alone, with as many iterations as the driver ran on all its levels together.
  resetTrace();
  const count = drivenIterations.reduce((sum, n) => sum + n, 0);
  const alone = await relax(t, res, { size: 1e-4, total: count });
  assert.deepEqual(trace.levels.map((l) => l.res), [res]);
  assert.deepEqual(trace.iterations, [count]);
  const aloneWork = count * res * res;

  // Measured on a GTX 1660 Ti: of a bump of 0.49 the driver leaves 0.0022, the single level 0.40 with 11.7 times the work.
  const drivenLeft = residual(driven.out, res), aloneLeft = residual(alone.out, res);
  assert.ok(drivenWork < aloneWork / 10, `the driver did ${drivenWork} texel steps, the single level ${aloneWork}`);
  assert.ok(drivenLeft < start / 100, `through the driver ${drivenLeft} of ${start} is left`);
  assert.ok(aloneLeft > start / 2, `alone ${aloneLeft} of ${start} is left`);
  assert.ok(drivenLeft < aloneLeft / 50, `the driver leaves ${drivenLeft}, the single level ${aloneLeft}`);

  // What the driver returns is a surface, not the blocks of its coarse levels: no step between neighbours stands out.
  let step = 0;
  for (let y = 0; y < res; y++) for (let x = 1; x < res; x++) step = Math.max(step, Math.abs(driven.out[y * res + x]! - driven.out[y * res + x - 1]!));
  assert.ok(step < 2 * (0.75 / (res - 1)), `the largest step between two texels is ${step}`);
  assert.equal(rangeOf(driven.out).nonFinite, 0);

  // With filtered level inputs, as a terrain simulation takes them, the same run still ends far nearer than the single level.
  const filtered = await relax(t, res, { size: 0.5, total: 1500 });
  assert.ok(residual(filtered.out, res) < aloneLeft / 10, `with filtered level inputs ${residual(filtered.out, res)} is left`);
});

test('pictures: a terrain relaxed through the driver, and by as many iterations at full resolution alone', async () => {
  const res = 513;
  resetTrace();
  const driven = await relax(t, res, { size: 0.25, total: 200 }, { source: 'fbm' });
  const levels = trace.levels.map((l) => l.res);
  assert.deepEqual(levels, [65, 129, 257, 513]);
  const count = trace.iterations.reduce((sum, n) => sum + n, 0);
  const alone = await relax(t, res, { size: 1e-4, total: count }, { source: 'fbm' });
  const input = (await t.run(t.doc({ src: { type: 'ref/fbm', params: { seed: 5 } } }), ['src.out'], { resolution: res, mode: 'build' })).data[0]!;
  writeHillshade('ops/coarse-to-fine-input-hillshade', input, res, SETTINGS.terrainSize, SETTINGS.heightRange);
  writeHillshade('ops/coarse-to-fine-driven-hillshade', driven.out, res, SETTINGS.terrainSize, SETTINGS.heightRange);
  writeHillshade('ops/coarse-to-fine-alone-hillshade', alone.out, res, SETTINGS.terrainSize, SETTINGS.heightRange);
  writeGrey('ops/coarse-to-fine-driven-grey', driven.out, res);
  writeGrey('ops/coarse-to-fine-change-grey', grid(res, res, (x, y) => driven.out[y * res + x]! - input[y * res + x]!), res, 'auto');

  // The border ring is held on every level: there the result is the input.
  const ring = (data: Float32Array): Float32Array => Float32Array.from([...data.subarray(0, res), ...data.subarray(res * (res - 1))]);
  assertIdentical(ring(driven.out), ring(input), 'the first and the last row');
  // The driver moved the terrain at the scale of its features, the single level only at the scale of a few texels.
  const moved = (out: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < out.length; i++) sum += Math.abs(out[i]! - input[i]!);
    return sum / out.length;
  };
  assert.ok(moved(driven.out) > 3 * moved(alone.out), `mean change ${moved(driven.out)} through the driver, ${moved(alone.out)} alone`);
  const range = rangeOf(driven.out);
  assert.ok(range.nonFinite === 0 && range.min >= rangeOf(input).min - 1e-6 && range.max <= rangeOf(input).max + 1e-6, 'a mean of neighbours never leaves the range of the input');
});
