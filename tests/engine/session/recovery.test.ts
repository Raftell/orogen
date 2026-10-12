// Device loss through the session (runtime.md 7.8, 5.9, 7.6 rule 8, 7.7): the loss is announced, the viewport
// draws nothing, a new device is opened and the engine moved onto it, and the same view is evaluated and shown
// again; when recovery gives up, and how it is restarted. device.destroy() is the one portable way to lose a
// device. This file makes its own contexts, one after another, because each loss needs a new one.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { GpuContext, GpuProfile, ViewportContent } from '../../../src/core/runtime.ts';
import { createRecovery, LOSS_LIMIT, LOSS_WINDOW_MS, RETRY_DELAYS_MS } from '../../../src/core/session/recovery.ts';
import { createNodeGpu } from '../../../src/platform/node/gpu.ts';
import { doc, endings, PREVIEW, resetSlow, slow, startSession } from './rig.ts';

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
after(() => {
  for (const gpu of contexts) gpu.destroy();
});

const VIEW = { height: { node: 'out', port: 'out' } };
const graph = (value: number, iterations = 200) => doc({
  level: { type: 'ref/constant', params: { value } },
  walk: { type: 'ref/slow', params: { iterations }, inputs: { in: 'level.out' } },
  out: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'walk.out' } },
}, VIEW);
const OUT = { node: 'out', port: 'out' };
const FIELD_BYTES = PREVIEW * PREVIEW * 4;

test('a device lost in the middle of an evaluation is recovered, and the same view is evaluated and bound again', async () => {
  resetSlow();
  const first = await nextGpu();
  let reopened = 0;
  const t = await startSession({ gpu: first, reopenGpu: () => { reopened++; return nextGpu(); } });
  try {
    /** Read through a call: the compiler takes what an assertion saw of it for what it still is. */
    const content = (): ViewportContent | null => t.renderer.content;
    t.session.setDocument(graph(0.25), 1);
    await t.next('view-updated');
    await t.idle();
    assert.ok(content()?.height);

    // Revision 2 loses its device inside the slow node.
    const from = t.mark();
    const calls = t.renderer.calls.length;
    slow.at = (i) => { if (i === 100 && !first.lost) lose(first); };
    t.session.setDocument(graph(0.5), 2);
    const lost = await t.next('device-lost');
    assert.deepEqual({ ...lost }, { type: 'device-lost', reason: 'destroyed', message: lost.message, nodeId: 'walk' });
    assert.equal(content(), null, 'rule 1: the viewport draws nothing of a lost device');
    assert.equal(await t.session.inspect(OUT), null, 'and there is nothing to inspect');

    const ready = await t.next('device-ready');
    const second = contexts.at(-1)!;
    assert.deepEqual({ ...ready }, { type: 'device-ready', epoch: 2, caps: second.caps, budgetBytes: t.memory().budgetBytes });
    assert.deepEqual([reopened, t.engine.epoch, t.engine.gpu === second, second.lost], [1, 2, true, false]);

    const shown = await t.next('view-updated');
    await t.idle();
    assert.deepEqual([shown.revision, shown.resolution, shown.draft, shown.height], [2, PREVIEW, false, true], 'rule 2: a full evaluation of the latest document');
    const bound = content()?.height;
    assert.deepEqual([bound?.kind, bound?.width], ['field', PREVIEW], 'the view is bound again, to content of the new device');
    assert.deepEqual(await t.session.inspect(OUT), { min: 2 * 200.5, max: 2 * 200.5, mean: 2 * 200.5, nonFinite: 0 });
    assert.equal(t.memory().pinnedBytes, FIELD_BYTES, 'only the new result is held: the handles of the lost device were dropped');

    // What the renderer was told, in order: nothing to draw, the new device, the new result.
    assert.deepEqual(t.renderer.calls.slice(calls).map((c) => c.call), ['setContent', 'init', 'setContent']);
    assert.equal((t.renderer.calls[calls + 1] as { gpu: unknown }).gpu, second);
    // The evaluation that was running settled as lost, and the stream says so in order.
    const events = t.events.slice(from);
    const interrupted = t.of('request-start', from)[0]!;
    assert.deepEqual(endings(events, interrupted.requestId), { level: 'run', walk: 'skipped:device-lost', out: 'skipped:device-lost' });
    const outline = events.filter((e) => ['request-start', 'device-lost', 'eval-end', 'device-ready', 'view-updated'].includes(e.type))
      .map((e) => (e.type === 'eval-end' ? `eval-end ${e.status}` : e.type === 'request-start' ? `request-start ${e.purpose} ${e.revision}` : e.type));
    assert.deepEqual(outline, [
      'request-start view 2', 'device-lost', 'eval-end device-lost', 'device-ready', 'request-start view 2', 'eval-end ok', 'view-updated',
    ]);
    assert.deepEqual(endings(events, shown.requestId), { level: 'run', walk: 'run', out: 'run' }, 'nothing of the lost device was kept');

    // A loss while nothing runs: no node is named, and what was shown is shown again.
    slow.at = undefined;
    const idle = t.mark();
    lose(second);
    const again = await t.next('device-lost');
    assert.equal('nodeId' in again, false);
    assert.equal((await t.next('device-ready')).epoch, 3);
    assert.equal((await t.next('view-updated')).revision, 2);
    assert.equal((await t.session.inspect(OUT))?.mean, 2 * 200.5);
    assert.equal(t.of('engine-error', idle).length, 0);
  } finally {
    await t.dispose();
  }
});

test('a third loss within two minutes ends automatic recovery until retryDevice', async () => {
  resetSlow();
  let reopened = 0;
  const t = await startSession({ gpu: await nextGpu(), reopenGpu: () => { reopened++; return nextGpu(); } });
  try {
    t.session.setDocument(graph(0.25, 8), 1);
    await t.next('view-updated');
    for (let loss = 1; loss < LOSS_LIMIT; loss++) {
      await t.idle();
      lose(contexts.at(-1)!);
      await t.next('device-ready');
      await t.next('view-updated');
    }
    await t.idle();
    assert.equal(reopened, LOSS_LIMIT - 1);

    const from = t.mark();
    lose(contexts.at(-1)!);
    const fatal = await t.next('engine-error');
    assert.deepEqual({ ...fatal }, { type: 'engine-error', message: fatal.message, fatal: true });
    assert.match(fatal.message, /lost 3 times within 120 seconds/);
    assert.equal(reopened, LOSS_LIMIT - 1, 'rule 3: no device is opened for the third loss');

    // The session does nothing until retryDevice: a document is recorded and keyed, not evaluated.
    t.session.setDocument(graph(0.5, 8), 2);
    assert.equal((await t.next('keys')).revision, 2);
    await t.idle();
    assert.deepEqual(t.of('request-start', from), []);
    assert.deepEqual(t.of('device-ready', from), []);
    assert.equal(await t.session.inspect(OUT), null);
    assert.equal(t.renderer.content, null);

    t.session.retryDevice();
    t.session.retryDevice();                                    // recovery is under way: ignored
    const ready = await t.next('device-ready');
    assert.equal(ready.epoch, LOSS_LIMIT + 1);
    assert.equal(reopened, LOSS_LIMIT);
    const shown = await t.next('view-updated');
    assert.equal(shown.revision, 2, 'the latest document is evaluated on the new device');
    assert.equal((await t.session.inspect(OUT))?.mean, 2 * 8.5);
  } finally {
    await t.dispose();
  }
});

test('a build that loses its device ends with the status its function reports; recovery and a full evaluation follow', async () => {
  resetSlow();
  const first = await nextGpu();
  const t = await startSession({ gpu: first, reopenGpu: nextGpu });
  try {
    t.session.setDocument(graph(0.25, 8), 1);
    await t.next('view-updated');
    await t.idle();
    const from = t.mark();
    slow.at = (i, ctx) => { if (ctx.res === 513 && i === 50 && !first.lost) lose(first); };
    const result = await t.session.build({ doc: graph(0.5, 100), outDir: '/out/terrain' });
    assert.equal(result.status, 'device-lost');
    assert.deepEqual(t.of('build-end', from).map((e) => e.status), ['device-lost']);
    assert.equal(t.of('device-lost', from)[0]!.nodeId, 'walk');
    const shown = await t.next('view-updated');
    await t.idle();
    assert.equal(shown.revision, 1);
    assert.deepEqual(t.of('build-start', from).length, 1, 'rule 8: the build is not restarted');
    const order = t.events.slice(from).filter((e) => ['device-lost', 'build-end', 'device-ready', 'view-updated'].includes(e.type)).map((e) => e.type);
    assert.deepEqual(order.slice(0, 1), ['device-lost']);
    assert.deepEqual(order.slice().sort(), ['build-end', 'device-lost', 'device-ready', 'view-updated']);
    assert.ok(order.indexOf('view-updated') > order.indexOf('device-ready') && order.indexOf('view-updated') > order.indexOf('build-end'));
  } finally {
    await t.dispose();
  }
});

test('an uncaptured GPU error is reported as an engine error that is not fatal', async () => {
  const gpu = await nextGpu();
  const t = await startSession({ gpu, reopenGpu: nextGpu });
  try {
    // Outside any error scope, as a bug in a renderer would do it. Dawn prints the error to stderr as well.
    gpu.device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE });
    const error = await t.next('engine-error');
    assert.equal(error.fatal, false);
    assert.ok(error.message.length > 0);
    // The session goes on.
    t.session.setDocument(graph(0.25, 8), 1);
    assert.equal((await t.next('view-updated')).revision, 1);
  } finally {
    await t.dispose();
  }
});

// ---- the policy of 7.8 rules 2 and 3, without a device --------------------------------------------------------------

/** A context as the recovery sees one. */
function fakeGpu(lost = false): GpuContext & { destroyed: boolean } {
  const gpu = { lost, lostInfo: lost ? { reason: 'unknown', message: 'gone' } : null, destroyed: false, destroy() { gpu.destroyed = true; } };
  return gpu as unknown as GpuContext & { destroyed: boolean };
}

test('recovery: the documented waits, the first success wins, three failures in a row end it, retry starts again', async () => {
  assert.deepEqual([...RETRY_DELAYS_MS], [0, 1000, 5000]);
  assert.deepEqual([LOSS_LIMIT, LOSS_WINDOW_MS], [3, 120_000]);

  // Short waits stand for the documented ones; the order of what happens is what is tested.
  const delaysMs = [0, 2, 4];
  let calls = 0;
  const good = fakeGpu();
  const atOnce = createRecovery(async () => { calls++; return good; }, { delaysMs });
  assert.deepEqual(await atOnce.lost(), { ok: true, gpu: good });
  assert.equal(calls, 1, 'the first success ends the attempts');

  calls = 0;
  const third = createRecovery(async () => {
    if (++calls < 3) throw new Error(`attempt ${calls} failed`);
    return good;
  }, { delaysMs });
  assert.deepEqual(await third.lost(), { ok: true, gpu: good });
  assert.equal(calls, 3);

  calls = 0;
  const never = createRecovery(async () => { throw new Error(`attempt ${++calls} failed`); }, { delaysMs });
  const failed = await never.lost();
  assert.equal(failed.ok, false);
  assert.match((failed as { message: string }).message, /3 attempts: attempt 3 failed/);
  assert.equal(calls, 3);
  assert.equal((await never.retry()).ok, false);
  assert.equal(calls, 6, 'retry makes the three attempts again');

  // A context that arrives lost is one more failure, and is destroyed: nobody else knows it.
  const dead = fakeGpu(true);
  calls = 0;
  const stillborn = createRecovery(async () => (++calls === 1 ? dead : good), { delaysMs });
  assert.deepEqual(await stillborn.lost(), { ok: true, gpu: good });
  assert.deepEqual([calls, dead.destroyed, good.destroyed], [2, true, false]);
});

test('recovery: a third loss within 120 s opens no device; losses further apart do', async () => {
  let now = 0;
  let calls = 0;
  const recovery = createRecovery(async () => { calls++; return fakeGpu(); }, { delaysMs: [0], now: () => now });
  assert.equal((await recovery.lost()).ok, true);
  now = 60_000;
  assert.equal((await recovery.lost()).ok, true);
  now = 119_999;
  const third = await recovery.lost();
  assert.equal(third.ok, false);
  assert.equal(calls, 2, 'no attempt is made for the third loss');
  // retryDevice: the attempts are made; the losses are not forgotten, so the next one within the window ends it again.
  assert.equal((await recovery.retry()).ok, true);
  now = 125_000;
  assert.equal((await recovery.lost()).ok, false);
  // Two minutes after the last but one, a loss is the first of its window again... once the earlier ones are out of it.
  now = 400_000;
  assert.equal((await recovery.lost()).ok, true);
  assert.equal(calls, 4);
});

test('recovery: dispose ends the wait, and a context that arrives afterwards is destroyed', async () => {
  let calls = 0;
  const waiting = createRecovery(async () => { calls++; throw new Error('no adapter'); }, { delaysMs: [0, 3_600_000] });
  const outcome = waiting.lost();
  // The first attempt has failed when its rejection has been handled; the hour's wait is then under way.
  for (let turn = 0; turn < 100 && calls === 0; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  waiting.dispose();
  assert.equal((await outcome).ok, false);
  assert.equal(calls, 1, 'no attempt after dispose');
  assert.equal((await waiting.lost()).ok, false);
  assert.equal(calls, 1);

  const late = fakeGpu();
  let arrive!: (gpu: GpuContext) => void;
  const opening = createRecovery(() => new Promise<GpuContext>((resolve) => { arrive = resolve; }), { delaysMs: [0] });
  const pending = opening.lost();
  await new Promise<void>((resolve) => setImmediate(resolve));
  opening.dispose();
  arrive(late);
  assert.equal((await pending).ok, false);
  assert.equal(late.destroyed, true);
});
