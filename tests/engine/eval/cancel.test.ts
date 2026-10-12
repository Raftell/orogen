// Cancellation (runtime.md 3.7, 5.2, 5.5, 5.13; engine.md 4.7): where the signal is checked, what a cancelled
// evaluation leaves in the pool and in the cache, and that the engine goes on afterwards.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, defineNode, type EvalContext } from '../../../src/core/api.ts';
import { assertUniform, calls, constantNode, endings, eventsOf, gainNode, startEngine } from './rig.ts';

const stepKernel = defineKernel({
  name: 'test/step',
  inputs: { h: 'field' },
  outputs: { next: 'field' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return h_at(px) + 1.0; }',
});

/** What the node under test does at iteration i, and what it saw when its loop ended. */
const hooks: { at?: (i: number, ctx: EvalContext) => void; rejection?: unknown; after?: (ctx: EvalContext) => Promise<void> | void } = {};

/** Adds 1 per iteration, for `iterations` iterations, with scratch state it never releases itself. */
const walkNode = defineNode({
  type: 'ref/walk',
  title: 'Walk (Test)',
  category: 'ref',
  description: 'Counts iterations into a field.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'int', name: 'iterations', default: 8, min: 0, max: 1_000_000, help: 'How often to add 1.' }],
  kernels: [stepKernel],
  async evaluate(ctx) {
    calls.set('ref/walk', (calls.get('ref/walk') ?? 0) + 1);
    let a = ctx.clone(ctx.input('in'));
    let b = ctx.alloc('field');
    ctx.alloc('aux', { size: 33 });
    ctx.lut(new Float32Array(64), 'f32');
    try {
      await ctx.loop(ctx.params.iterations, (i) => {
        hooks.at?.(i, ctx);
        ctx.run(stepKernel, { in: { h: a }, out: { next: b } });
        [a, b] = [b, a];
      });
    } catch (thrown) {
      hooks.rejection = thrown;
      throw thrown;
    }
    await hooks.after?.(ctx);
    ctx.output('out', a);
  },
});

/** Passes its input on: an alias, with nothing encoded. */
const passNode = defineNode({
  type: 'ref/pass',
  title: 'Pass (Test)',
  category: 'ref',
  description: 'Passes its input on.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'int', name: 'tag', default: 0, min: 0, max: 100_000, help: 'Tells instances apart.' }],
  kernels: [],
  evaluate: (ctx) => ctx.output('out', ctx.input('in')),
});

// Every iteration is a batch boundary: the loop awaits the GPU after each one, as under testing.md's 'small' slices.
const t = await startEngine([constantNode, gainNode, walkNode], { hooks: { sliceTargetMs: 1e-6 } });
after(() => t.dispose());

const graph = (iterations: number) => t.doc({
  level: { type: 'ref/constant', params: { value: 10 } },
  walk: { type: 'ref/walk', params: { iterations }, inputs: { in: 'level.out' } },
  reader: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'walk.out' } },
});
const reset = (): void => {
  delete hooks.at;
  delete hooks.after;
  delete hooks.rejection;
  calls.clear();
};

test('a signal that is aborted before the call: no node runs, every node is skipped as "aborted"', async () => {
  await t.engine.trim();
  reset();
  const out = await t.run(graph(4), ['reader.out'], { signal: AbortSignal.abort() });
  assert.equal(out.result.status, 'aborted');
  assert.deepEqual(out.result.fields, [null]);
  assert.deepEqual(endings(out.events), { level: 'skipped:aborted', walk: 'skipped:aborted', reader: 'skipped:aborted' });
  assert.equal(eventsOf(out.events, 'eval-end')[0]!.status, 'aborted');
  assert.deepEqual(out.result.errors, []);
  assert.equal(calls.size, 0);
  t.noLeaks();
});

test('aborting in the middle of a loop: the loop rejects with the reason, nothing of the node is published or cached', async () => {
  await t.engine.trim();
  reset();
  const controller = new AbortController();
  const seen: number[] = [];
  hooks.at = (i) => {
    seen.push(i);
    if (i === 5) controller.abort();
  };
  const out = await t.run(graph(200), ['reader.out'], { signal: controller.signal });
  assert.equal(out.result.status, 'aborted');
  assert.deepEqual(out.result.fields, [null]);
  assert.deepEqual(endings(out.events), { level: 'run', walk: 'skipped:aborted', reader: 'skipped:aborted' });
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5], 'body is not called again once the signal has aborted');
  assert.ok(hooks.rejection instanceof DOMException && hooks.rejection.name === 'AbortError', String(hooks.rejection));
  assert.equal(hooks.rejection, controller.signal.reason);
  assert.equal(t.engine.lastTiming('walk'), null, 'a cancelled node has no timing');

  // The pool and the cache are consistent: nothing is WORKING or pinned, and only what completed is cached.
  t.noLeaks();
  const memory = t.engine.memory();
  assert.equal(memory.cacheBytes, 65 * 65 * 4, 'level, which completed before the abort, stays cached');

  // The same document evaluates afterwards: the cancelled node runs again, the completed one is a hit.
  reset();
  const again = await t.run(graph(200), ['reader.out']);
  assert.equal(again.result.status, 'ok', JSON.stringify(again.result.errors));
  assert.deepEqual(endings(again.events), { level: 'cached', walk: 'run', reader: 'run' });
  assertUniform(again.data[0], 2 * (10 + 200), 'reader.out');
  assert.equal(calls.get('ref/walk'), 1);
  t.noLeaks();
});

test('aborting from outside while the node awaits the GPU: the evaluation settles within the slices in flight', async () => {
  await t.engine.trim();
  reset();
  const controller = new AbortController();
  let reached = 0;
  hooks.at = (i) => {
    reached = i;
    // From a timer, as the session aborts: the loop is waiting at a batch boundary when it fires.
    if (i === 3) setTimeout(() => controller.abort(new DOMException('a newer request', 'AbortError')), 1);
  };
  const out = await t.run(graph(5_000), ['reader.out'], { signal: controller.signal });
  assert.equal(out.result.status, 'aborted');
  assert.ok(reached >= 3 && reached < 5_000 - 1, `the loop stopped at iteration ${reached}`);
  assert.equal((hooks.rejection as DOMException).message, 'a newer request');
  assert.deepEqual(endings(out.events), { level: 'run', walk: 'skipped:aborted', reader: 'skipped:aborted' });
  t.noLeaks();
  assert.equal((await t.run(graph(3), ['reader.out'])).data[0]![0], 26);
});

test('after the abort every context method throws the reason; an abort after the last node changes nothing', async () => {
  await t.engine.trim();
  reset();
  const controller = new AbortController();
  let after: unknown[] = [];
  hooks.after = (ctx) => {
    controller.abort();
    const attempt = (call: () => unknown): unknown => {
      try {
        call();
        return 'returned';
      } catch (thrown) {
        return thrown;
      }
    };
    after = [
      attempt(() => ctx.alloc('field')), attempt(() => ctx.input('in')), attempt(() => ctx.flush()), attempt(() => ctx.progress(0.5)),
      attempt(() => ctx.loop(1, () => undefined)), attempt(() => ctx.readFile('x')),
    ];
  };
  const out = await t.run(graph(2), ['reader.out'], { signal: controller.signal });
  assert.equal(out.result.status, 'aborted');
  assert.deepEqual(after.map((thrown) => thrown === controller.signal.reason), Array(6).fill(true));
  assert.deepEqual(endings(out.events), { level: 'run', walk: 'skipped:aborted', reader: 'skipped:aborted' }, 'a node that finishes after the abort publishes nothing');
  t.noLeaks();

  reset();
  const late = new AbortController();
  const done = await t.run(graph(2), ['reader.out'], { signal: late.signal, onEvent: (e) => { if (e.type === 'eval-end') late.abort(); } });
  assert.equal(done.result.status, 'ok');
  assertUniform(done.data[0], 24, 'reader.out');
  t.noLeaks();
});

test('an aborted transient evaluation drops nothing, and a cancelled build leaves no content behind', async () => {
  await t.engine.trim();
  reset();
  const first = await t.run(graph(2), ['reader.out'], { cache: 'transient' });
  assert.equal(first.result.status, 'ok');
  const aborted = await t.run(graph(3), ['reader.out'], { cache: 'transient', signal: AbortSignal.abort() });
  assert.equal(aborted.result.status, 'aborted');
  assert.deepEqual(endings((await t.run(graph(2), ['reader.out'], { cache: 'transient' })).events), { level: 'cached', walk: 'cached', reader: 'cached' });

  await t.engine.trim();
  reset();
  const controller = new AbortController();
  hooks.at = (i) => { if (i === 2) controller.abort(); };
  const build = await t.run(graph(50), ['reader.out', 'level.out'], { mode: 'build', signal: controller.signal });
  assert.equal(build.result.status, 'aborted');
  assert.deepEqual(build.result.fields, [null, null], 'no target is delivered by an aborted evaluation');
  const memory = t.engine.memory();
  assert.deepEqual([memory.workingBytes, memory.pinnedBytes, memory.cacheBytes], [0, 0, 0]);
});

test('an abort reaches an evaluation whose nodes need no GPU wait: the plan is not walked as one task', async () => {
  // A node that passes its input on publishes an alias: nothing is encoded, and nothing it awaits takes a turn
  // of the event loop. An abort is delivered through that loop, as every message to the engine's thread is.
  const own = await startEngine([constantNode, passNode]);
  try {
    const length = 2000;
    const nodes: Record<string, { type: string; params?: Record<string, unknown>; inputs?: Record<string, string> }> = { n0: { type: 'ref/constant', params: { value: 1 } } };
    for (let i = 1; i <= length; i++) nodes[`n${i}`] = { type: 'ref/pass', params: { tag: i }, inputs: { in: `n${i - 1}.out` } };
    const doc = own.doc(nodes);

    // The abort is asked for by a timer that is set once the chain is under way: it can only fire when the
    // thread returns to the event loop.
    const controller = new AbortController();
    const reason = new Error('the user moved on');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = await own.run(doc, [`n${length}.out`], {
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'node-done' && e.nodeId === 'n20') timer = setTimeout(() => controller.abort(reason), 0);
      },
    });
    clearTimeout(timer);
    assert.equal(out.result.status, 'aborted', `the chain ran ${out.result.timing.nodesRun} of ${length + 1} nodes`);
    assert.ok(out.result.timing.nodesRun > 20 && out.result.timing.nodesRun < length / 2, `${out.result.timing.nodesRun} nodes ran`);
    assert.ok(eventsOf(out.events, 'node-skipped').some((e) => e.reason === 'aborted'));
    own.noLeaks();
  } finally {
    await own.dispose();
  }
});

