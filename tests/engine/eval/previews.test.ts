// Progressive previews (runtime.md 5.11, 3.6; engine.md 4.7 loop rule 6): a node inside ctx.loop lends its
// working state at batch boundaries, and the loans end when it settles.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, defineNode, type EvalContext, type Field } from '../../../src/core/api.ts';
import type { EvalEvent, TextureRef } from '../../../src/core/runtime.ts';
import { assertUniform, constantNode, endings, eventsOf, startEngine } from './rig.ts';

const stepKernel = defineKernel({
  name: 'test/step',
  inputs: { h: 'field' },
  outputs: { next: 'field' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return h_at(px) + 1.0; }',
});

/** What preview() of the node under test returns, given the field that holds the latest state. */
const lend: {
  before?: (ctx: EvalContext) => void;
  at?: (i: number) => void;
  preview?: (latest: Field<'field'>, ctx: EvalContext) => Record<string, Field>;
  afterLoop?: (latest: Field<'field'>, ctx: EvalContext) => void;
} = {};

const relaxNode = defineNode({
  type: 'ref/relax',
  title: 'Relax (Test)',
  category: 'ref',
  description: 'A ping-pong loop that lends its state.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'int', name: 'iterations', default: 6, min: 0, max: 100_000, help: 'How often to add 1.' }],
  kernels: [stepKernel],
  async evaluate(ctx) {
    let a = ctx.clone(ctx.input('in'));
    let b = ctx.alloc('field');
    lend.before?.(ctx);
    const loop = ctx.loop(ctx.params.iterations, (i) => {
      lend.at?.(i);
      ctx.run(stepKernel, { in: { h: a }, out: { next: b } });
      [a, b] = [b, a];
    }, { preview: () => (lend.preview ? lend.preview(a, ctx) : { out: a }) as { out: Field } });
    await loop;
    lend.afterLoop?.(a, ctx);
    ctx.output('out', a);
  },
});

// Every iteration is a batch boundary.
const t = await startEngine([constantNode, relaxNode], { hooks: { sliceTargetMs: 1e-6 } });
after(() => t.dispose());

const graph = (iterations = 6) => t.doc({
  level: { type: 'ref/constant', params: { value: 1 } },
  relax: { type: 'ref/relax', params: { iterations }, inputs: { in: 'level.out' } },
});
type Loan = readonly [nodeId: string, loans: Readonly<Record<string, TextureRef>> | null];
const reset = (): void => {
  delete lend.before;
  delete lend.preview;
  delete lend.afterLoop;
  delete lend.at;
};

test('loans begin at a batch boundary, follow the field that holds the latest state, and end when the node settles', async () => {
  reset();
  const loans: Loan[] = [];
  const order: string[] = [];
  lend.at = (i) => order.push(`body ${i}`);
  const events: EvalEvent[] = [];
  const out = await t.run(graph(6), ['relax.out'], {
    onLoans: (nodeId, lent) => {
      loans.push([nodeId, lent]);
      order.push(lent ? 'loans' : 'withdrawn');
    },
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'node-done' && e.nodeId === 'relax') order.push('done');
    },
  });
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assertUniform(out.data[0], 7, 'relax.out');

  // One report per boundary, because the state alternates between the two fields of the pair; then the withdrawal.
  assert.equal(loans.length, 7);
  assert.deepEqual(order, [
    'body 0', 'loans', 'body 1', 'loans', 'body 2', 'loans', 'body 3', 'loans', 'body 4', 'loans', 'body 5', 'loans', 'withdrawn', 'done',
  ], 'a change is reported before the next call of body; the loans are withdrawn before node-done');
  assert.ok(loans.every(([nodeId]) => nodeId === 'relax'));
  assert.equal(loans[6]![1], null);
  const refs = loans.slice(0, 6).map(([, lent]) => lent!.out!);
  for (const ref of refs) assert.deepEqual([ref.width, ref.height, ref.kind, Object.keys(ref).sort()], [65, 65, 'field', ['height', 'kind', 'view', 'width']]);
  assert.deepEqual(loans.slice(0, 6).map(([, lent]) => Object.keys(lent!)), Array(6).fill(['out']));
  assert.equal(new Set(refs.map((r) => r.view)).size, 2, 'the two halves of the ping-pong pair');
  assert.notEqual(refs[0]!.view, refs[1]!.view);
  assert.equal(refs[0]!.view, refs[2]!.view);

  const previews = eventsOf(events, 'node-preview');
  assert.ok(previews.length >= 1 && previews.length <= 6, `${previews.length} node-preview events`);
  assert.deepEqual([previews[0]!.nodeId, previews[0]!.ports], ['relax', ['out']]);
  t.noLeaks();

  // Lent content is not cached: only the published result is.
  assert.deepEqual(endings((await t.run(graph(6), ['relax.out'])).events), { level: 'cached', relax: 'cached' });
});

test('a loan is reported only when it changed; a loan of any size stands for the output', async () => {
  reset();
  const loans: Loan[] = [];
  let coarse: Field<'field'> | null = null;
  lend.before = (ctx) => { coarse = ctx.alloc('field', { size: 33, clear: 0 }); };
  lend.preview = () => ({ out: coarse! });
  const out = await t.run(graph(5), ['relax.out'], { mode: 'build', onLoans: (nodeId, lent) => loans.push([nodeId, lent]) });
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assert.equal(loans.length, 2, 'one loan that never changes, and its withdrawal');
  assert.deepEqual([loans[0]![1]!.out!.width, loans[0]![1]!.out!.height, loans[1]![1]], [33, 33, null]);
  t.noLeaks();
});

test('what preview() may not return: a key that is no output, a field of another kind, a released field', async () => {
  const cases: [RegExp, NonNullable<typeof lend.preview>][] = [
    [/preview\(\) returned "flow", which is not an output of ref\/relax/, (latest) => ({ flow: latest })],
    [/preview "out" is field #\d+ of kind "color"; the output is "field"/, (_latest, ctx) => ({ out: ctx.alloc('color', { size: 9 }) })],
    [/was released/, (_latest, ctx) => {
      const gone = ctx.alloc('field');
      ctx.release(gone);
      return { out: gone };
    }],
  ];
  for (const [message, preview] of cases) {
    reset();
    lend.preview = preview;
    const loans: Loan[] = [];
    const out = await t.run(graph(4), ['relax.out'], { mode: 'build', onLoans: (nodeId, lent) => loans.push([nodeId, lent]) });
    assert.deepEqual(endings(out.events), { level: 'run', relax: 'error:binding' }, String(message));
    assert.match(out.result.errors[0]!.message, message);
    assert.deepEqual(loans, [], 'nothing was lent');
    t.noLeaks();
  }
});

test('loans are withdrawn when the node is cancelled, fails, or releases what it lent', async () => {
  // Cancelled in the loop.
  reset();
  let loans: Loan[] = [];
  const controller = new AbortController();
  lend.at = (i) => { if (i === 3) controller.abort(); };
  const aborted = await t.run(graph(10), ['relax.out'], { mode: 'build', signal: controller.signal, onLoans: (nodeId, lent) => loans.push([nodeId, lent]) });
  assert.equal(aborted.result.status, 'aborted');
  assert.deepEqual(loans.map(([, lent]) => lent !== null), [true, true, true, false]);

  // Failed after the loop.
  reset();
  loans = [];
  lend.afterLoop = () => { throw new Error('gave up'); };
  const failed = await t.run(graph(3), ['relax.out'], { mode: 'build', onLoans: (nodeId, lent) => loans.push([nodeId, lent]) });
  assert.deepEqual(endings(failed.events), { level: 'run', relax: 'error:node-exception' });
  assert.deepEqual(loans.map(([, lent]) => lent !== null), [true, true, true, false]);

  // Released by the node: the texture may be another owner's before the node settles.
  reset();
  loans = [];
  const order: string[] = [];
  let scratch: Field<'field'> | null = null;
  lend.before = (ctx) => { scratch = ctx.alloc('field', { clear: 0 }); };
  lend.preview = () => ({ out: scratch! });
  lend.afterLoop = (_latest, ctx) => {
    order.push('release');
    ctx.release(scratch!);
    order.push('released');
  };
  const released = await t.run(graph(3), ['relax.out'], { mode: 'build', onLoans: (nodeId, lent) => { loans.push([nodeId, lent]); order.push(lent ? 'loans' : 'withdrawn'); } });
  assert.equal(released.result.status, 'ok', JSON.stringify(released.result.errors));
  assert.deepEqual(order, ['loans', 'release', 'withdrawn', 'released']);
  assert.equal(loans.length, 2);
  t.noLeaks();
});
