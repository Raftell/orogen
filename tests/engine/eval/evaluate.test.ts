// Engine.evaluate as a caller sees it (runtime.md 5.1, 5.2, 5.3, 5.10): the promise, the result and who owns it,
// malformed calls, the plan, the events, and one evaluation at a time.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { FieldAccessError } from '../../../src/core/api.ts';
import type { AnyFieldHandle, EvalEvent } from '../../../src/core/runtime.ts';
import {
  assertUniform, calls, constantNode, endings, eventsOf, gainNode, rampNode, startEngine, sumNode, target, tintNode, worst,
} from './rig.ts';

const t = await startEngine([constantNode, rampNode, gainNode, sumNode, tintNode]);
after(() => t.dispose());

const chain = t.doc({
  ramp: { type: 'ref/ramp', params: { gainX: 1, gainY: 2, base: 0.25 } },
  gain: { type: 'ref/gain', params: { gain: 3 }, inputs: { in: 'ramp.out' } },
  lone: { type: 'ref/constant', params: { value: 7 } },
});

test('a target is delivered as a handle on published content, which the caller releases once', async () => {
  const { result } = await t.evaluate(chain, ['gain.out']);
  assert.equal(result.status, 'ok');
  assert.equal(result.fields.length, 1);
  const field = result.fields[0]!;
  assert.deepEqual([field.kind, field.width, field.height, field.epoch], ['field', 65, 65, 1]);
  assert.ok(field.texture && field.view);
  assert.ok(t.engine.memory().pinnedBytes >= 65 * 65 * 4, 'content behind a handle is pinned');

  const data = await t.engine.read(field);
  assert.equal(data.length, 65 * 65);
  // gain * (u + 2 v + 0.25) on vertices: uv = px / (res - 1).
  const w = worst(data, (i) => 3 * ((i % 65) / 64 + 2 * Math.floor(i / 65) / 64 + 0.25));
  assert.ok(w.difference < 1e-5, `largest difference ${w.difference} at ${w.index}`);

  const second = field.retain();
  field.release();
  assert.throws(() => field.release(), FieldAccessError);
  assert.throws(() => field.texture, FieldAccessError);
  assert.ok(second.view, 'a retained handle is independent');
  second.release();
  t.noLeaks();
});

test('the plan is the depth-first post-order from the targets; nodes no target needs are not in it', async () => {
  const { events, result } = await t.evaluate(chain, ['gain.out'], { resolution: 33 });
  const start = eventsOf(events, 'eval-start')[0]!;
  assert.deepEqual(start.plan.map((p) => p.nodeId), ['ramp', 'gain']);
  assert.deepEqual([start.resolution, start.mode, start.outputPeakBytes], [33, 'preview', null]);
  result.fields[0]!.release();

  const both = await t.evaluate(chain, ['lone.out', 'gain.out', 'ramp.out'], { resolution: 33 });
  assert.deepEqual(eventsOf(both.events, 'eval-start')[0]!.plan.map((p) => p.nodeId), ['lone', 'ramp', 'gain']);
  for (const field of both.result.fields) field!.release();
  t.noLeaks();
});

test('events arrive in order: eval-start, one final event per node, eval-end, none after the promise settles', async () => {
  const doc = t.doc({ a: { type: 'ref/constant', params: { value: 1.5 } }, b: { type: 'ref/gain', inputs: { in: 'a.out' } } });
  const seen: EvalEvent[] = [];
  const { result, events } = await t.evaluate(doc, ['b.out'], { resolution: 33, onEvent: (e) => seen.push(e) });
  const settledWith = seen.length;
  assert.deepEqual(
    events.filter((e) => e.type !== 'node-progress' && e.type !== 'eval-progress').map((e) => e.type),
    ['eval-start', 'node-start', 'node-done', 'node-start', 'node-done', 'eval-end'],
  );
  assert.ok(events.every((e) => e.requestId === result.requestId));
  const done = eventsOf(events, 'node-done');
  assert.deepEqual(done.map((e) => [e.nodeId, e.cached, e.resolution]), [['a', false, 33], ['b', false, 33]], 'each says at which resolution its figures were measured');
  for (const e of done) {
    assert.ok(e.wallMs >= 0 && e.peakBytes >= 33 * 33 * 4, `${e.nodeId}: ${JSON.stringify(e)}`);
    assert.equal(e.gpuMs === null, !t.gpu.caps.timestampQuery, 'gpuMs is null without timestamp-query');
  }
  // Two nodes without a timing weigh the same: the first one done is half of the evaluation.
  const progress = eventsOf(events, 'eval-progress');
  assert.ok(progress.length >= 1 && progress.length <= 2, `${progress.length} eval-progress events within 250 ms`);
  assert.equal(progress[0]!.fraction, 0.5);
  assert.ok(progress.every((e, i) => e.fraction <= 1 && (i === 0 || e.fraction >= progress[i - 1]!.fraction)));
  const end = eventsOf(events, 'eval-end')[0]!;
  // No estimate within the first second of an evaluation (5.10). How long this one took is the machine's to say.
  if (end.wallMs < 1000) assert.equal(progress[0]!.etaMs, null);
  assert.deepEqual([end.status, result.status], ['ok', 'ok']);
  assert.deepEqual([result.timing.nodesRun, result.timing.nodesCached], [2, 0]);
  assert.deepEqual(result.errors, []);
  structuredClone(events);                                       // every event is plain data
  assert.deepEqual(t.engine.lastTiming('b')?.resolution, 33);
  assert.equal(t.engine.lastTiming('nobody'), null);
  result.fields[0]!.release();
  // The same document at another resolution, and again where it is cached: the resolution is the evaluation's.
  const finer = await t.evaluate(doc, ['b.out'], { resolution: 65 });
  assert.deepEqual(eventsOf(finer.events, 'node-done').map((e) => [e.nodeId, e.cached, e.resolution]), [['a', false, 65], ['b', false, 65]]);
  finer.result.fields[0]!.release();
  const again = await t.evaluate(doc, ['b.out'], { resolution: 33 });
  assert.deepEqual(eventsOf(again.events, 'node-done').map((e) => [e.nodeId, e.cached, e.resolution, e.wallMs]), [['a', true, 33, 0], ['b', true, 33, 0]]);
  again.result.fields[0]!.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.length, settledWith, 'no event after the promise has settled');
  t.noLeaks();
});

test('a malformed call rejects with TypeError and evaluates nothing', async () => {
  const opts = { resolution: 33, mode: 'preview' as const };
  const call = (targets: string[], o: object) => t.engine.evaluate(chain, targets.map(target), { ...opts, requestId: t.nextRequestId(), ...o } as never);
  await assert.rejects(call(['gain.out'], { resolution: 1 }), TypeError);
  await assert.rejects(call(['gain.out'], { resolution: 8193 }), TypeError);
  await assert.rejects(call(['gain.out'], { resolution: 64.5 }), TypeError);
  await assert.rejects(call(['gain.out'], { mode: 'draft' }), TypeError);
  await assert.rejects(call(['nobody.out'], {}), /names the node "nobody"/);
  await assert.rejects(call(['nobody'], {}), TypeError);
  await assert.rejects(call(['gain.flow'], {}), /names the output "flow"/);
  await assert.rejects(call(['gain.out:grey'], {}), TypeError);

  const used = t.nextRequestId();
  const ok = await t.engine.evaluate(chain, [target('lone.out')], { ...opts, requestId: used + 5 });
  ok.fields[0]!.release();
  await assert.rejects(t.engine.evaluate(chain, [target('lone.out')], { ...opts, requestId: used + 5 }), /requestId/);
  await assert.rejects(t.engine.evaluate(chain, [target('lone.out')], { ...opts, requestId: used + 1 }), TypeError);
  for (let i = 0; i < 5; i++) t.nextRequestId();
  t.noLeaks();
});

test('a node target runs the node and delivers no field; a failed target is null', async () => {
  const doc = t.doc({ a: { type: 'ref/constant' }, broken: { type: 'ref/gain' } });
  const { result, events } = await t.evaluate(doc, ['a', 'a.out', 'broken.out'], { resolution: 33 });
  assert.equal(result.status, 'errors');
  assert.deepEqual(result.fields.map((f) => f === null), [true, false, true]);
  assert.deepEqual(endings(events), { a: 'run', broken: 'error:missing-input' });
  assert.deepEqual(result.errors.map((e) => [e.nodeId, e.nodeType, e.kind, e.message]), [['broken', 'ref/gain', 'missing-input', 'missing input "in"']]);
  result.fields[1]!.release();
  t.noLeaks();
});

test('one evaluation runs at a time: a call made while another runs starts when that one has settled', async () => {
  const order: string[] = [];
  const doc = t.doc({ a: { type: 'ref/constant', params: { value: 2 } }, b: { type: 'ref/gain', inputs: { in: 'a.out' } } });
  const note = (name: string) => (e: EvalEvent): void => { if (e.type === 'eval-start' || e.type === 'eval-end') order.push(`${name}:${e.type}`); };
  const first = t.evaluate(doc, ['b.out'], { resolution: 33, mode: 'build', onEvent: note('first') });
  const second = t.evaluate(doc, ['b.out'], { resolution: 33, mode: 'build', onEvent: note('second') });
  const results = await Promise.all([first, second]);
  assert.deepEqual(order, ['first:eval-start', 'first:eval-end', 'second:eval-start', 'second:eval-end']);
  for (const { result } of results) {
    assertUniform(await t.engine.read(result.fields[0]!), 4, 'b.out');
    result.fields[0]!.release();
  }
  t.noLeaks();
});

test('the outputs option decides what ctx.wants() answers; a result does not depend on it', async () => {
  const doc = t.doc({ a: { type: 'ref/constant', params: { value: 3 } }, b: { type: 'ref/gain', inputs: { in: 'a.out' } } });
  await t.engine.trim();
  calls.clear();
  const needed = await t.run(doc, ['b.out'], { resolution: 33, outputs: 'needed' });
  const all = await t.run(doc, ['b.out'], { resolution: 33, outputs: 'all' });
  assertUniform(needed.data[0], 6, 'needed');
  assertUniform(all.data[0], 6, 'all');
  assert.deepEqual(endings(all.events), { a: 'cached', b: 'cached' }, 'the same content, however it was asked for');
  assert.equal(calls.get('ref/gain'), 1);
  t.noLeaks();
});

test('read and stats are engine services: they work on any handle, at any time, and reject for a dead one', async () => {
  const doc = t.doc({ ramp: { type: 'ref/ramp', params: { gainX: 2, gainY: 0, base: -1 } }, tint: { type: 'ref/tint' } });
  const { result } = await t.evaluate(doc, ['ramp.out', 'tint.out'], { resolution: 65 });
  const [ramp, tint] = result.fields as [AnyFieldHandle, AnyFieldHandle];
  const rows = await t.engine.read(ramp, [3, 5]);
  assert.equal(rows.length, 2 * 65);
  assert.ok(Math.abs(rows[64]! - 1) < 1e-6 && Math.abs(rows[65]! + 1) < 1e-6, 'two whole rows of u * 2 - 1');
  assert.equal((await t.engine.read(tint)).length, 65 * 65 * 4, 'four floats per texel of a colour');
  await assert.rejects(t.engine.read(ramp, [5, 3]), RangeError);

  assert.equal(ramp.kind, 'field');
  if (ramp.kind === 'field') {
    const s = await t.engine.stats(ramp);
    assert.ok(Math.abs(s.min + 1) < 1e-6 && Math.abs(s.max - 1) < 1e-6 && Math.abs(s.mean) < 1e-6, JSON.stringify(s));
    assert.equal(s.nonFinite, 0);
  }
  await assert.rejects(t.engine.stats(tint as never), FieldAccessError);
  ramp.release();
  tint.release();
  await assert.rejects(t.engine.read(ramp), FieldAccessError);
  t.noLeaks();
});

test('dispose waits for a read and for statistics that are under way: both end with their result, and no GPU error escapes', async () => {
  for (const call of ['read', 'stats'] as const) {
    const own = await startEngine([constantNode, rampNode, gainNode, sumNode, tintNode]);
    const escaped: string[] = [];
    const listen = (event: Event): void => void escaped.push((event as GPUUncapturedErrorEvent).error.message);
    own.gpu.device.addEventListener('uncapturederror', listen);
    try {
      const { result } = await own.evaluate(own.doc({ ramp: { type: 'ref/ramp', params: { gainX: 2, gainY: 0, base: -1 } } }), ['ramp.out']);
      const ramp = result.fields[0]!;
      assert.equal(ramp.kind, 'field');
      // Not awaited: the staging buffer is being mapped, or the scratch texture read, when dispose is called.
      const pending = (call === 'read' ? own.engine.read(ramp) : own.engine.stats(ramp as never)).then((value) => ({ value }), (error: unknown) => ({ error }));
      const disposing = own.engine.dispose();
      await assert.rejects(own.engine.read(ramp), /disposed/, 'no call begins once the engine is being disposed');
      await disposing;
      const outcome = await pending;
      assert.ok('value' in outcome, `Engine.${call} under way at dispose: ${String((outcome as { error?: unknown }).error)}`);
      if (call === 'read') {
        const data = outcome.value as Float32Array;
        assert.equal(data.length, 65 * 65);
        assert.ok(Math.abs(data[0]! + 1) < 1e-6 && Math.abs(data[64]! - 1) < 1e-6);
      } else {
        const stats = outcome.value as { min: number; max: number };
        assert.ok(Math.abs(stats.min + 1) < 1e-6 && Math.abs(stats.max - 1) < 1e-6, JSON.stringify(stats));
      }
      // An uncaptured error is dispatched from the device's own turn: give it one.
      await own.gpu.device.queue.onSubmittedWorkDone();
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      assert.deepEqual(escaped, [], `Engine.${call}`);
    } finally {
      own.gpu.device.removeEventListener('uncapturederror', listen);
      await own.dispose();
    }
  }
});

test('createEngine refuses a budget that is no byte count', async () => {
  for (const budgetBytes of [-1, NaN, Infinity]) {
    await assert.rejects(startEngine([constantNode], { budgetBytes }), RangeError, `a budget of ${budgetBytes}`);
  }
});

