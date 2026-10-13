// The rules of runtime.md 6.3 for the application's CpuRunner, on a worker made of plain objects: the queue
// that src/platform/electron/worker/cpu.ts gives a Web Worker. No window and no worker thread.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CpuTaskRequest } from '../../../../src/core/runtime.ts';
import { createCpuRunner, type CpuWorker } from '../../../../src/platform/electron/worker/cpu-queue.ts';

/** One started worker: what it was posted, and the two ways it speaks. */
interface Fake extends CpuWorker {
  readonly posted: { readonly request: CpuTaskRequest; readonly transfer: ArrayBuffer[] }[];
  stopped: boolean;
  reply(message: unknown): void;
  fail(reason: string): void;
}

/** A runner and every worker it has started, in order. `refuse` makes the next start throw. */
function rig(): { runner: ReturnType<typeof createCpuRunner>; workers: Fake[]; refuse(reason: string): void } {
  const workers: Fake[] = [];
  let refusal: string | null = null;
  const runner = createCpuRunner((onReply, onFailure) => {
    if (refusal !== null) {
      const reason = refusal;
      refusal = null;
      throw new Error(reason);
    }
    const worker: Fake = {
      posted: [],
      stopped: false,
      post(request, transfer) { this.posted.push({ request, transfer }); },
      stop() { this.stopped = true; },
      reply: onReply,
      fail: onFailure,
    };
    workers.push(worker);
    return worker;
  });
  return { runner, workers, refuse: (reason) => { refusal = reason; } };
}

const never = new AbortController().signal;
const opts = (signal: AbortSignal = never, onProgress: (fraction: number) => void = () => {}) => ({ signal, onProgress });
/** Lets the continuations of settled promises run. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('cpu queue: no worker exists before the first task, and one serves them all', async () => {
  const { runner, workers } = rig();
  assert.equal(workers.length, 0);
  const first = runner.run('a', 1, [], opts());
  assert.equal(workers.length, 1);
  workers[0]!.reply({ id: workers[0]!.posted[0]!.request.id, type: 'result', value: 'one' });
  assert.equal(await first, 'one');
  const second = runner.run('b', 2, [], opts());
  workers[0]!.reply({ id: workers[0]!.posted[1]!.request.id, type: 'result', value: 'two' });
  assert.equal(await second, 'two');
  assert.equal(workers.length, 1);
});

test('cpu queue: a request is posted only when the one before it is answered, in call order', async () => {
  const { runner, workers } = rig();
  const buffer = new ArrayBuffer(8);
  const results = [runner.run('a', 'x', [buffer], opts()), runner.run('b', 'y', [], opts()), runner.run('c', 'z', [], opts())];
  const worker = workers[0]!;
  assert.deepEqual(worker.posted.map((p) => p.request.task), ['a']);
  assert.ok(worker.posted[0]!.transfer[0] === buffer, "the caller's transfer list goes with the request");
  worker.reply({ id: worker.posted[0]!.request.id, type: 'result', value: 1 });
  await turn();
  assert.deepEqual(worker.posted.map((p) => p.request.task), ['a', 'b']);
  worker.reply({ id: worker.posted[1]!.request.id, type: 'result', value: 2 });
  await turn();
  worker.reply({ id: worker.posted[2]!.request.id, type: 'result', value: 3 });
  assert.deepEqual(await Promise.all(results), [1, 2, 3]);
  assert.equal(new Set(worker.posted.map((p) => p.request.id)).size, 3);
});

test('cpu queue: progress reaches the task it belongs to, and a reply for another id is ignored', async () => {
  const { runner, workers } = rig();
  const seen: number[] = [];
  const result = runner.run('a', null, [], opts(never, (fraction) => void seen.push(fraction)));
  const worker = workers[0]!;
  const id = worker.posted[0]!.request.id;
  worker.reply({ id, type: 'progress', fraction: 0.25 });
  worker.reply({ id: id + 100, type: 'result', value: 'not mine' });
  worker.reply('noise');
  worker.reply({ id, type: 'progress', fraction: 0.75 });
  worker.reply({ id, type: 'result', value: 'mine' });
  assert.equal(await result, 'mine');
  assert.deepEqual(seen, [0.25, 0.75]);
});

test('cpu queue: a task that throws rejects with its message, and the worker survives', async () => {
  const { runner, workers } = rig();
  const failing = runner.run('a', null, [], opts());
  workers[0]!.reply({ id: workers[0]!.posted[0]!.request.id, type: 'error', message: 'The image is not a PNG' });
  await assert.rejects(failing, { message: 'The image is not a PNG' });
  const next = runner.run('b', null, [], opts());
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.stopped, false);
  workers[0]!.reply({ id: workers[0]!.posted[1]!.request.id, type: 'result', value: 'ok' });
  assert.equal(await next, 'ok');
});

test('cpu queue: a worker that dies fails the task in progress, and the next task starts a new one', async () => {
  const { runner, workers } = rig();
  const running = runner.run('a', null, [], opts());
  const waiting = runner.run('b', null, [], opts());
  workers[0]!.fail('it ran out of memory');
  await assert.rejects(running, { message: 'The CPU worker failed: it ran out of memory' });
  // The task that waited lost nothing: it runs on the new worker.
  assert.equal(workers.length, 2);
  assert.equal(workers[0]!.stopped, true);
  assert.deepEqual(workers[1]!.posted.map((p) => p.request.task), ['b']);
  workers[0]!.reply({ id: workers[1]!.posted[0]!.request.id, type: 'result', value: 'from the dead worker' });
  workers[1]!.reply({ id: workers[1]!.posted[0]!.request.id, type: 'result', value: 'fresh' });
  assert.equal(await waiting, 'fresh');
});

test('cpu queue: a worker that cannot start fails that task only', async () => {
  const { runner, workers, refuse } = rig();
  refuse('the script is missing');
  await assert.rejects(runner.run('a', null, [], opts()), { message: 'The CPU worker failed: the script is missing' });
  const next = runner.run('b', null, [], opts());
  assert.equal(workers.length, 1);
  workers[0]!.reply({ id: workers[0]!.posted[0]!.request.id, type: 'result', value: 'ok' });
  assert.equal(await next, 'ok');
});

test('cpu queue: a worker that fails while it starts is stopped, and its task fails with the reason', async () => {
  const stopped: boolean[] = [];
  const runner = createCpuRunner((_onReply, onFailure) => {
    onFailure('its script threw');
    return { post() { throw new Error('nothing is posted to a worker that failed'); }, stop() { stopped.push(true); } };
  });
  await assert.rejects(runner.run('a', null, [], opts()), { message: 'The CPU worker failed: its script threw' });
  assert.deepEqual(stopped, [true]);
});

test('cpu queue: aborting the task in progress rejects at once and stops the worker', async () => {
  const { runner, workers } = rig();
  const controller = new AbortController();
  const running = runner.run('a', null, [], opts(controller.signal));
  const waiting = runner.run('b', null, [], opts());
  const reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(running, (thrown) => thrown === reason);
  assert.equal(workers[0]!.stopped, true);
  assert.equal(workers.length, 2, 'the waiting task has a worker of its own now');
  workers[1]!.reply({ id: workers[1]!.posted[0]!.request.id, type: 'result', value: 'b' });
  assert.equal(await waiting, 'b');
});

test('cpu queue: aborting a task that waits does not touch the worker', async () => {
  const { runner, workers } = rig();
  const controller = new AbortController();
  const running = runner.run('a', null, [], opts());
  const waiting = runner.run('b', null, [], opts(controller.signal));
  controller.abort(new Error('not needed'));
  await assert.rejects(waiting, { message: 'not needed' });
  assert.equal(workers[0]!.stopped, false);
  assert.equal(workers[0]!.posted.length, 1);
  workers[0]!.reply({ id: workers[0]!.posted[0]!.request.id, type: 'result', value: 'a' });
  assert.equal(await running, 'a');
  assert.equal(workers.length, 1);
});

test('cpu queue: a signal that is aborted already starts nothing', async () => {
  const { runner, workers } = rig();
  await assert.rejects(runner.run('a', null, [], opts(AbortSignal.abort(new Error('too late')))), { message: 'too late' });
  assert.equal(workers.length, 0);
});

test('cpu queue: a request that cannot be posted fails its task and leaves the worker to the next', async () => {
  const posted: string[] = [];
  const runner = createCpuRunner(() => ({
    post(request) {
      if (request.task === 'bad') throw new Error('The value could not be cloned');
      posted.push(request.task);
    },
    stop() {},
  }));
  await assert.rejects(runner.run('bad', null, [], opts()), { message: 'The value could not be cloned' });
  void runner.run('good', null, [], opts()).catch(() => {});
  assert.deepEqual(posted, ['good']);
  await runner.dispose();
});

test('cpu queue: dispose rejects what is pending, stops the worker and refuses what comes after', async () => {
  const { runner, workers } = rig();
  const running = runner.run('a', null, [], opts());
  const waiting = runner.run('b', null, [], opts());
  await runner.dispose();
  await assert.rejects(running, { message: 'The CPU runner was disposed' });
  await assert.rejects(waiting, { message: 'The CPU runner was disposed' });
  assert.equal(workers[0]!.stopped, true);
  await assert.rejects(runner.run('c', null, [], opts()), { message: 'The CPU runner was disposed' });
  await runner.dispose();
  assert.equal(workers.length, 1);
});
