// Device loss and recovery (runtime.md 5.9, 2.2): what an evaluation does when its device goes, what the engine
// forgets, replaceDevice, and the node that was running at two losses in a row. device.destroy() is the one
// portable way to lose a device. This file makes its own contexts, one after another, because each loss needs a new one.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { defineKernel, defineNode, DeviceLostError, type EvalContext } from '../../../src/core/api.ts';
import type { GpuContext, GpuProfile } from '../../../src/core/runtime.ts';
import { createNodeGpu } from '../../../src/platform/node/gpu.ts';
import { assertUniform, calls, constantNode, endings, eventsOf, gainNode, MIB, startEngine, type TestEngine } from './rig.ts';

const stepKernel = defineKernel({
  name: 'test/step',
  inputs: { h: 'field' },
  outputs: { next: 'field' },
  cost: 1,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return h_at(px) + 1.0; }',
});
const untiled = defineKernel({
  name: 'test/untiled',
  outputs: { out: 'field' },
  tiled: false,
  code: 'fn compute(px: vec2i, uv: vec2f) -> f32 { return 1.0; }',
});

const hooks: { at?: (i: number, ctx: EvalContext) => void; rejection?: unknown } = {};
const fragileNode = defineNode({
  type: 'ref/fragile',
  title: 'Fragile (Test)',
  category: 'ref',
  description: 'Counts iterations into a field; a test loses the device under it.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [{ name: 'out', type: 'field' }],
  params: [{ kind: 'int', name: 'iterations', default: 6, min: 0, max: 1000, help: 'How often to add 1.' }],
  kernels: [stepKernel, untiled],
  async evaluate(ctx) {
    calls.set('ref/fragile', (calls.get('ref/fragile') ?? 0) + 1);
    let a = ctx.clone(ctx.input('in'));
    let b = ctx.alloc('field');
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
    ctx.output('out', a);
  },
});

const DEFS = [constantNode, gainNode, fragileNode];
const profile: GpuProfile = (process.env.OROGEN_GPU_PROFILE as GpuProfile | undefined) || 'core';
const contexts: GpuContext[] = [];
/** A new context, once the one before it is destroyed: there is one device per process. */
async function nextGpu(): Promise<GpuContext> {
  contexts.at(-1)?.destroy();
  const gpu = await createNodeGpu({ profile });
  contexts.push(gpu);
  return gpu;
}
/** Loses the device as a driver reset would, without telling the context. */
const lose = (gpu: GpuContext): void => gpu.device.destroy();

let t: TestEngine;
// A wait after every iteration, so that a loss is noticed inside the loop.
t = await startEngine(DEFS, { gpu: await nextGpu(), hooks: { sliceTargetMs: 1e-6 }, budgetBytes: 64 * MIB });
after(async () => {
  await t.dispose();
  for (const gpu of contexts) gpu.destroy();
});

const graph = (iterations = 6) => t.doc({
  level: { type: 'ref/constant', params: { value: 10 } },
  walk: { type: 'ref/fragile', params: { iterations }, inputs: { in: 'level.out' } },
  reader: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'walk.out' } },
});
const reset = (): void => {
  delete hooks.at;
  delete hooks.rejection;
  calls.clear();
};
const recover = async (): Promise<GpuContext> => {
  const gpu = await nextGpu();
  await t.engine.replaceDevice(gpu);
  return gpu;
};

test('a device lost while a node runs: nothing of the node is published and the evaluation settles "device-lost"', async () => {
  reset();
  const first = await t.evaluate(graph(), ['level.out']);
  assert.equal(first.result.status, 'ok');
  const handle = first.result.fields[0]!;
  const budget = t.engine.memory().budgetBytes;

  hooks.at = (i) => { if (i === 2) lose(t.gpu); };
  const out = await t.run(graph(), ['reader.out']);
  assert.equal(out.result.status, 'device-lost');
  assert.deepEqual(out.result.fields, [null]);
  assert.deepEqual(out.result.errors, []);
  assert.deepEqual(endings(out.events), { level: 'cached', walk: 'skipped:device-lost', reader: 'skipped:device-lost' });
  assert.equal(eventsOf(out.events, 'eval-end')[0]!.status, 'device-lost');
  assert.ok(hooks.rejection instanceof DeviceLostError, `the loop rejected with ${String(hooks.rejection)}`);
  assert.equal(t.gpu.lost, true);

  // 5.9 rules 3 and 4: the engine has forgotten what lived on the device, and says so until it gets another.
  assert.deepEqual(t.engine.memory(), { budgetBytes: budget, workingBytes: 0, cacheBytes: 0, pinnedBytes: 0, freeBytes: 0, reservedBytes: 0, drainingBytes: 0 });
  assert.throws(() => handle.texture, DeviceLostError);
  assert.throws(() => handle.view, DeviceLostError);
  await assert.rejects(t.engine.read(handle), DeviceLostError);
  await assert.rejects(t.engine.trim(), DeviceLostError);
  assert.throws(() => t.engine.reserve(16, 'viewport'), DeviceLostError);
  handle.release();                                                     // a handle of a lost epoch: nothing to do
  assert.equal((await t.engine.keys(graph())).size, 3, 'keys need no device');

  reset();
  const dead = await t.run(graph(), ['reader.out']);
  assert.equal(dead.result.status, 'device-lost');
  assert.deepEqual(endings(dead.events), { level: 'skipped:device-lost', walk: 'skipped:device-lost', reader: 'skipped:device-lost' });
  assert.equal(calls.size, 0, 'no node runs on a lost device');
});

test('replaceDevice: a new epoch on a new device; the document evaluates again from nothing', async () => {
  reset();
  const gpu = await recover();
  assert.deepEqual([t.engine.epoch, t.engine.gpu === gpu, gpu.lost], [2, true, false]);
  const out = await t.evaluate(graph(), ['reader.out']);
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assert.deepEqual(endings(out.events), { level: 'run', walk: 'run', reader: 'run' }, 'the cache was emptied with the device');
  const field = out.result.fields[0]!;
  assert.equal(field.epoch, 2);
  assertUniform(await t.engine.read(field), 2 * (10 + 6), 'reader.out on the new device');
  field.release();
  t.noLeaks();
  assert.deepEqual(endings((await t.run(graph(), ['reader.out'])).events), { level: 'cached', walk: 'cached', reader: 'cached' });
});

test('the node that was running at a loss runs once more with halved limits; at a second loss in a row it is not run again', async () => {
  // Loss 1, with "walk" running at these parameters.
  await t.engine.trim();
  reset();
  hooks.at = (i) => { if (i === 1) lose(t.engine.gpu); };
  assert.equal((await t.run(graph(9), ['reader.out'])).result.status, 'device-lost');
  await recover();

  // The attempt after it: the hard ceiling is halved for that node, and for that node only.
  reset();
  hooks.at = (i, ctx) => { if (i === 0) ctx.run(untiled, { out: { out: ctx.alloc('field') }, cost: 1e9 }); };
  const halved = await t.run(graph(9), ['reader.out']);
  assert.match(halved.result.errors[0]!.message, /the limit is 250 ms$/);
  const other = await t.run(graph(11), ['reader.out']);
  assert.match(other.result.errors[0]!.message, /the limit is 500 ms$/);

  // Loss 2, the same node with the same key running.
  reset();
  hooks.at = (i) => { if (i === 1) lose(t.engine.gpu); };
  assert.equal((await t.run(graph(9), ['reader.out'])).result.status, 'device-lost');
  await recover();

  reset();
  const banned = await t.run(graph(9), ['reader.out']);
  assert.equal(banned.result.status, 'errors');
  assert.deepEqual(endings(banned.events), { level: 'run', walk: 'error:device-lost', reader: 'skipped:upstream' });
  assert.deepEqual(banned.result.errors.map((e) => [e.nodeId, e.message]), [['walk', 'The GPU was reset twice while this node was running']]);
  assert.equal(calls.get('ref/fragile'), undefined, 'it is not run a third time');
  assert.equal(eventsOf(banned.events, 'eval-start')[0]!.plan.find((p) => p.nodeId === 'walk')!.state, 'blocked');

  // Until its key changes.
  const changed = await t.run(graph(10), ['reader.out']);
  assert.equal(changed.result.status, 'ok', JSON.stringify(changed.result.errors));
  assertUniform(changed.data[0], 40, 'reader.out');
  assert.equal((await t.run(graph(9), ['reader.out'])).result.status, 'ok', 'and with its old key afterwards, because the key did change');
  t.noLeaks();
});

test('a node that completes between two losses is not banned: its completion ends the record of the first', async () => {
  // Loss 1, with "walk" running at parameters of its own.
  await t.engine.trim();
  reset();
  hooks.at = (i) => { if (i === 1) lose(t.engine.gpu); };
  assert.equal((await t.run(graph(13), ['reader.out'])).result.status, 'device-lost');
  await recover();

  // It runs again and completes: with halved limits this once, and the record ends there.
  reset();
  const completed = await t.run(graph(13), ['reader.out']);
  assert.equal(completed.result.status, 'ok', JSON.stringify(completed.result.errors));
  assert.deepEqual(endings(completed.events), { level: 'run', walk: 'run', reader: 'run' });
  await t.engine.trim();
  hooks.at = (i, ctx) => { if (i === 0) ctx.run(untiled, { out: { out: ctx.alloc('field') }, cost: 1e9 }); };
  assert.match((await t.run(graph(13), ['reader.out'])).result.errors[0]!.message, /the limit is 500 ms$/, 'the limits are whole again');

  // Loss 2 finds the same node with the same key running. That is one loss of a new row, not the second of the old.
  reset();
  hooks.at = (i) => { if (i === 1) lose(t.engine.gpu); };
  assert.equal((await t.run(graph(13), ['reader.out'])).result.status, 'device-lost');
  await recover();
  reset();
  hooks.at = (i, ctx) => { if (i === 0) ctx.run(untiled, { out: { out: ctx.alloc('field') }, cost: 1e9 }); };
  const first = await t.run(graph(13), ['reader.out']);
  assert.deepEqual(first.result.errors.map((e) => e.kind), ['watchdog'], 'the node is run, not refused');
  assert.match(first.result.errors[0]!.message, /the limit is 250 ms$/, 'with the halved limits of the attempt after a loss');
  reset();
  const again = await t.run(graph(13), ['reader.out']);
  assert.equal(again.result.status, 'ok', JSON.stringify(again.result.errors));
  assertUniform(again.data[0], 2 * (10 + 13), 'reader.out');
  assert.equal(calls.get('ref/fragile'), 1);

  // A row is still two losses with nothing completed between them: loss 3 and loss 4 here.
  for (const round of ['third', 'fourth']) {
    await t.engine.trim();
    reset();
    hooks.at = (i) => { if (i === 1) lose(t.engine.gpu); };
    assert.equal((await t.run(graph(13), ['reader.out'])).result.status, 'device-lost', `the ${round} loss`);
    await recover();
  }
  reset();
  const banned = await t.run(graph(13), ['reader.out']);
  assert.deepEqual(endings(banned.events), { level: 'run', walk: 'error:device-lost', reader: 'skipped:upstream' });
  assert.equal(calls.get('ref/fragile'), undefined);
  t.noLeaks();
});

test('a device lost while nothing runs is forgotten at once; a lost engine can be disposed and replaced by a new one', async () => {
  reset();
  const cached = await t.run(graph(), ['reader.out']);
  assert.equal(cached.result.status, 'ok');
  assert.ok(t.engine.memory().cacheBytes > 0);
  lose(t.engine.gpu);
  // The context hears of the loss in a later task; 400 rounds of 5 ms bound the wait.
  for (let rounds = 0; rounds < 400 && !t.engine.gpu.lost; rounds++) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(t.engine.gpu.lost, true);
  assert.equal(t.engine.memory().cacheBytes, 0);
  assert.equal((await t.run(graph(), ['reader.out'])).result.status, 'device-lost');

  await t.dispose();
  await assert.rejects(t.engine.evaluate(graph(), [], { resolution: 65, mode: 'preview', requestId: 1e9 }), /disposed/);
  t = await startEngine(DEFS, { gpu: await nextGpu() });
  const out = await t.run(graph(), ['reader.out']);
  assert.equal(out.result.status, 'ok', JSON.stringify(out.result.errors));
  assert.equal(t.engine.epoch, 1);
  assertUniform(out.data[0], 32, 'reader.out on the new engine');
  t.noLeaks();
});
