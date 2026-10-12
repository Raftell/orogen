// CPU tasks (engine.md 4.11, runtime.md 6.3): the table defineCpuTask fills, the worker side on a message
// channel, and the Node runner with a real worker thread.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MessageChannel, threadId } from 'node:worker_threads';
import { encode } from 'fast-png';
import { NodeDefError, decodeImage, decodeRaw, defineCpuTask } from '../../src/core/api.ts';
import type { DecodedImage } from '../../src/core/api.ts';
import { findCpuTask } from '../../src/core/cpu/tasks.ts';
import { serveCpuTasks } from '../../src/core/runtime.ts';
import type { CpuRunner, CpuTaskReply, CpuTaskRequest } from '../../src/core/runtime.ts';
import { createNodeCpuRunner } from '../../src/platform/node/cpu.ts';
import { buildTiff, exportExr } from './image-builders.ts';

const TEST_WORKER = new URL('./cpu-runner.worker.ts', import.meta.url);
const never = new AbortController().signal;
const quiet = { signal: never, onProgress(): void {} };

// ---- defineCpuTask -----------------------------------------------------------------------------------------

test('defineCpuTask records a task under its name', () => {
  const task = defineCpuTask({ name: 'test/define.sum', run: (args: { a: number; b: number }) => args.a + args.b });
  assert.equal(task.name, 'test/define.sum');
  assert.equal(task.run({ a: 2, b: 3 }, { progress(): void {} }), 5);
  assert.equal(findCpuTask('test/define.sum'), task);
  assert.equal(findCpuTask('test/define.other'), undefined);
  assert.ok(Object.isFrozen(task));
});

test('defineCpuTask throws NodeDefError for a second, different task with a name already defined', () => {
  const def = { name: 'test/define.twice', run: (): number => 1 };
  const task = defineCpuTask(def);
  assert.equal(defineCpuTask(def), task);
  assert.throws(() => defineCpuTask({ name: 'test/define.twice', run: (): number => 2 }), (error: unknown) => {
    assert.ok(error instanceof NodeDefError);
    assert.equal(error.message, 'task "test/define.twice": a different task with this name is already defined');
    return true;
  });
  assert.equal(findCpuTask('test/define.twice'), task);
});

test('defineCpuTask throws NodeDefError for a name that is not <category>/<name>[.<task>]', () => {
  for (const name of ['', 'route', 'Simulate/route', 'simulate/Route', 'simulate/route.', 'simulate/route.a.b', 'simulate/route#x', 'simulate/ route']) {
    assert.throws(() => defineCpuTask({ name, run: (): number => 0 }), NodeDefError, name);
  }
  assert.throws(() => defineCpuTask({ name: 'test/define.norun', run: 1 as unknown as () => number }), NodeDefError);
});

test('the core tasks are defined under their names', () => {
  assert.equal(findCpuTask('core/decode-image'), decodeImage);
  assert.equal(findCpuTask('core/decode-raw'), decodeRaw);
});

// ---- serveCpuTasks -----------------------------------------------------------------------------------------

/** Serves the tasks of this thread on one end of a channel and returns what arrives at the other end. */
function serveHere(): { post(request: CpuTaskRequest, transfer?: ArrayBuffer[]): void; reply(): Promise<CpuTaskReply>; close(): void } {
  const { port1, port2 } = new MessageChannel();
  serveCpuTasks(port1);
  const arrived: CpuTaskReply[] = [];
  const waiting: ((reply: CpuTaskReply) => void)[] = [];
  port2.on('message', (reply: CpuTaskReply) => {
    const next = waiting.shift();
    if (next) next(reply);
    else arrived.push(reply);
  });
  return {
    post: (request, transfer = []) => { port2.postMessage(request, transfer); },
    reply: () => new Promise((resolve) => {
      const reply = arrived.shift();
      if (reply) resolve(reply);
      else waiting.push(resolve);
    }),
    close: () => { port1.close(); },
  };
}

let handedBack: { data: Float32Array; parts: { bytes: Uint8Array }[]; view: DataView; shared: Float32Array } | null = null;
defineCpuTask({
  name: 'test/serve.arrays',
  run(args: { data: Float32Array }, env) {
    env.progress(-3);
    env.progress(0.25);
    env.progress(NaN);
    env.progress(7);
    const buffer = new ArrayBuffer(16);
    // Two arrays on one buffer: the buffer is moved once.
    handedBack = { data: args.data, parts: [{ bytes: Uint8Array.of(1, 2, 3) }], view: new DataView(buffer), shared: new Float32Array(buffer) };
    return { ...handedBack, count: args.data.length, text: 'done' };
  },
});
const order: string[] = [];
defineCpuTask({
  name: 'test/serve.slow',
  async run(args: { tag: string; ms: number }) {
    order.push(`start ${args.tag}`);
    await new Promise((resolve) => { setTimeout(resolve, args.ms); });
    order.push(`end ${args.tag}`);
    return args.tag;
  },
});
defineCpuTask({ name: 'test/serve.throw', run(): never { throw new RangeError('the grid is 0 x 0'); } });
defineCpuTask({ name: 'test/serve.reject', run: (): Promise<never> => Promise.reject('a plain reason') });
defineCpuTask({ name: 'test/serve.function', run: (): unknown => ({ call(): void {} }) });
// Neither the ES library nor Node's types declare this global.
declare const WebAssembly: { readonly Memory: new (descriptor: { initial: number }) => { readonly buffer: ArrayBuffer } };
const memory = new WebAssembly.Memory({ initial: 1 });
defineCpuTask({
  name: 'test/serve.wasm',
  run(): { fixed: Uint8Array; free: Float32Array } {
    const fixed = new Uint8Array(memory.buffer, 8, 4);
    fixed.set([9, 8, 7, 6]);
    return { fixed, free: Float32Array.of(1.5, 2.5) };
  },
});

test('serveCpuTasks posts progress, then the result, and moves the buffer of every typed array back', async () => {
  const channel = serveHere();
  const data = Float32Array.of(1, 2, 3, 4);
  channel.post({ id: 7, task: 'test/serve.arrays', args: { data } }, [data.buffer]);
  assert.equal(data.byteLength, 0);

  assert.deepEqual(await channel.reply(), { id: 7, type: 'progress', fraction: 0 });
  assert.deepEqual(await channel.reply(), { id: 7, type: 'progress', fraction: 0.25 });
  assert.deepEqual(await channel.reply(), { id: 7, type: 'progress', fraction: 1 });
  const reply = await channel.reply();
  assert.equal(reply.type, 'result');
  assert.equal(reply.id, 7);
  const value = (reply as { value: { data: Float32Array; parts: { bytes: Uint8Array }[]; view: DataView; shared: Float32Array; count: number; text: string } }).value;
  assert.deepEqual(value.data, Float32Array.of(1, 2, 3, 4));
  assert.deepEqual(value.parts[0]!.bytes, Uint8Array.of(1, 2, 3));
  assert.equal(value.view.buffer, value.shared.buffer);
  assert.equal(value.count, 4);
  assert.equal(value.text, 'done');
  // The arrays the task returned are empty in the serving thread: their buffers were moved, not copied.
  assert.ok(handedBack);
  assert.equal(handedBack.data.byteLength, 0);
  assert.equal(handedBack.parts[0]!.bytes.byteLength, 0);
  assert.equal(handedBack.view.buffer.byteLength, 0);
  channel.close();
});

test('serveCpuTasks runs one task at a time, in the order of the requests', async () => {
  const channel = serveHere();
  channel.post({ id: 1, task: 'test/serve.slow', args: { tag: 'a', ms: 40 } });
  channel.post({ id: 2, task: 'test/serve.slow', args: { tag: 'b', ms: 1 } });
  channel.post({ id: 3, task: 'test/serve.slow', args: { tag: 'c', ms: 1 } });
  assert.deepEqual(await channel.reply(), { id: 1, type: 'result', value: 'a' });
  assert.deepEqual(await channel.reply(), { id: 2, type: 'result', value: 'b' });
  assert.deepEqual(await channel.reply(), { id: 3, type: 'result', value: 'c' });
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  channel.close();
});

test('serveCpuTasks answers a thrown error, an unknown name and an unclonable result with an error, and serves on', async () => {
  const channel = serveHere();
  channel.post({ id: 1, task: 'test/serve.throw', args: null });
  channel.post({ id: 2, task: 'test/serve.reject', args: null });
  channel.post({ id: 3, task: 'test/serve.unknown', args: null });
  channel.post({ id: 4, task: 'test/serve.function', args: null });
  channel.post({ id: 5, task: 'test/serve.slow', args: { tag: 'after', ms: 1 } });
  assert.deepEqual(await channel.reply(), { id: 1, type: 'error', message: 'the grid is 0 x 0' });
  assert.deepEqual(await channel.reply(), { id: 2, type: 'error', message: 'a plain reason' });
  assert.deepEqual(await channel.reply(), { id: 3, type: 'error', message: 'CPU task "test/serve.unknown" is not defined in the CPU worker' });
  const unclonable = await channel.reply();
  assert.equal(unclonable.id, 4);
  assert.equal(unclonable.type, 'error');
  assert.deepEqual(await channel.reply(), { id: 5, type: 'result', value: 'after' });
  channel.close();
});

test('serveCpuTasks copies a result whose buffer cannot be moved', async () => {
  const channel = serveHere();
  channel.post({ id: 1, task: 'test/serve.wasm', args: null });
  const reply = await channel.reply();
  assert.equal(reply.type, 'result');
  const value = (reply as { value: { fixed: Uint8Array; free: Float32Array } }).value;
  assert.deepEqual([...value.fixed], [9, 8, 7, 6]);
  assert.deepEqual([...value.free], [1.5, 2.5]);
  assert.equal(memory.buffer.byteLength, 65536);
  channel.close();
});

// ---- The Node runner ---------------------------------------------------------------------------------------

/** One runner for a test, disposed when the test ends: dispose resolves only when every worker thread has stopped. */
async function withRunner(body: (runner: CpuRunner) => Promise<void>, entry: URL | undefined = TEST_WORKER): Promise<void> {
  const runner = createNodeCpuRunner(entry);
  try {
    await body(runner);
  } finally {
    await runner.dispose();
  }
}
const thread = async (runner: CpuRunner): Promise<{ threadId: number; served: number }> =>
  await runner.run('test/thread', null, [], quiet) as { threadId: number; served: number };

test('runner: a registered task executes in a worker thread, which is started once', async () => {
  await withRunner(async (runner) => {
    const first = await thread(runner);
    assert.notEqual(first.threadId, threadId);
    assert.equal(first.served, 1);
    assert.deepEqual(await thread(runner), { threadId: first.threadId, served: 2 });
  });
});

test('runner: an ArrayBuffer is transferred to the task and the result\'s buffer back', async () => {
  await withRunner(async (runner) => {
    const data = Float32Array.from({ length: 1000 }, (_, i) => i);
    const progress: number[] = [];
    const result = await runner.run('test/double', { data }, [data.buffer], { signal: never, onProgress: (f) => { progress.push(f); } }) as
      { data: Float32Array; sum: number; inputBytes: number };
    // There: the caller's array is empty, and the task saw all of it.
    assert.equal(data.byteLength, 0);
    assert.equal(result.inputBytes, 4000);
    // And back: the result holds the task's values, and the task's own array is empty afterwards.
    assert.ok(result.data instanceof Float32Array);
    assert.equal(result.data.length, 1000);
    assert.equal(result.data[999], 1998);
    assert.equal(result.sum, 999 * 1000);
    assert.equal(await runner.run('test/returned-bytes', null, [], quiet), 0);
    assert.deepEqual(progress, [0.5, 1]);
  });
});

test('runner: without a transfer list the arguments are copied', async () => {
  await withRunner(async (runner) => {
    const data = Float32Array.of(1, 2, 3);
    const result = await runner.run('test/double', { data }, [], quiet) as { data: Float32Array };
    assert.deepEqual(data, Float32Array.of(1, 2, 3));
    assert.deepEqual(result.data, Float32Array.of(2, 4, 6));
  });
});

test('runner: a task that throws rejects run with an Error carrying its message, and the worker survives', async () => {
  await withRunner(async (runner) => {
    const before = await thread(runner);
    await assert.rejects(runner.run('test/throw', { message: 'no outlet found' }, [], quiet), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'no outlet found');
      return true;
    });
    assert.equal((await thread(runner)).threadId, before.threadId);
  });
});

test('runner: a task that is defined in the calling thread only cannot run', async () => {
  defineCpuTask({ name: 'test/runner.here', run: (): number => 1 });
  await withRunner(async (runner) => {
    await assert.rejects(runner.run('test/runner.here', null, [], quiet), { message: 'CPU task "test/runner.here" is not defined in the CPU worker' });
    assert.equal((await thread(runner)).served, 1);
  });
});

test('runner: arguments that cannot be cloned reject run and leave the queue intact', async () => {
  await withRunner(async (runner) => {
    const failed = runner.run('test/thread', { call(): void {} }, [], quiet);
    const next = thread(runner);
    await assert.rejects(failed, { name: 'DataCloneError' });
    assert.equal((await next).served, 1);
  });
});

test('runner: tasks run one at a time, in call order', async () => {
  await withRunner(async (runner) => {
    const sleep = (tag: string, ms: number): Promise<unknown> => runner.run('test/sleep', { tag, ms }, [], quiet);
    const results = await Promise.all([sleep('a', 60), sleep('b', 1), thread(runner), sleep('c', 1)]);
    assert.deepEqual(results.map((r) => (r as { served: number }).served), [1, 2, 3, 4]);
  });
});

test('runner: an aborted signal rejects run at once and starts no task', async () => {
  await withRunner(async (runner) => {
    const reason = new Error('the evaluation was replaced');
    await assert.rejects(runner.run('test/thread', null, [], { signal: AbortSignal.abort(reason), onProgress(): void {} }), (error) => error === reason);
    assert.equal((await thread(runner)).served, 1);
  });
});

test('runner: aborting an executing task rejects at once, terminates the worker and starts a new one on the next call', async () => {
  await withRunner(async (runner) => {
    const first = await thread(runner);
    const abort = new AbortController();
    const rejected: unknown[] = [];
    const spinning = runner.run('test/spin', null, [], { signal: abort.signal, onProgress(): void {} });
    spinning.catch((error: unknown) => { rejected.push(error); });
    // Long enough for the task to have begun: it never returns by itself.
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    assert.equal(rejected.length, 0);

    abort.abort();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(rejected.length, 1);
    const reason = rejected[0];
    assert.ok(reason instanceof DOMException);
    assert.equal(reason.name, 'AbortError');
    assert.equal(reason, abort.signal.reason);

    // A thread that still spun could serve nothing: this answer comes from a new worker.
    const second = await thread(runner);
    assert.notEqual(second.threadId, first.threadId);
    assert.notEqual(second.threadId, threadId);
    assert.equal(second.served, 1);
  });
});

test('runner: aborting a task that waits rejects it alone; the executing task and the worker go on', async () => {
  await withRunner(async (runner) => {
    const first = await thread(runner);
    const abort = new AbortController();
    const running = runner.run('test/sleep', { tag: 'running', ms: 80 }, [], quiet);
    const waiting = runner.run('test/sleep', { tag: 'waiting', ms: 1 }, [], { signal: abort.signal, onProgress(): void {} });
    const behind = thread(runner);
    abort.abort(new Error('not needed any more'));
    await assert.rejects(waiting, { message: 'not needed any more' });
    assert.deepEqual(await running, { tag: 'running', served: 2 });
    // The aborted task never reached the worker, and the worker is the one from before.
    assert.deepEqual(await behind, { threadId: first.threadId, served: 3 });
  });
});

test('runner: dispose rejects what is pending, stops the worker and is idempotent', async () => {
  const runner = createNodeCpuRunner(TEST_WORKER);
  await thread(runner);
  const spinning = runner.run('test/spin', null, [], quiet);
  const waiting = thread(runner);
  const outcomes = Promise.allSettled([spinning, waiting]);
  await runner.dispose();
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, 'rejected');
    assert.equal((outcome as PromiseRejectedResult).reason.message, 'The CPU runner was disposed');
  }
  await assert.rejects(thread(runner), { message: 'The CPU runner was disposed' });
  await runner.dispose();
});

test('runner: a worker that cannot start rejects the task with the reason', async () => {
  await withRunner(async (runner) => {
    await assert.rejects(thread(runner), /^Error: The CPU worker failed: /);
    await assert.rejects(thread(runner), /^Error: The CPU worker failed: /);
  }, new URL('./no-such-worker.ts', import.meta.url));
});

test('runner: a task in progress keeps the process alive, an idle worker does not', () => {
  const script = fileURLToPath(new URL('./cpu-runner.idle.ts', import.meta.url));
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60_000 });
  // A process that ended during the await has status 13; one that the idle worker held open is killed by the timeout.
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'kept alive\n');
});

// ---- The product's worker ----------------------------------------------------------------------------------

test('product worker: the core tasks decode PNG, TIFF, OpenEXR and raw files in the CPU thread', async () => {
  await withRunner(async (runner) => {
    const values = Array.from({ length: 6 * 4 }, (_, i) => i * 2849);
    const expected = Array.from(Float32Array.from(values, (v) => v / 65535));
    const decode = async (bytes: Uint8Array<ArrayBuffer>): Promise<DecodedImage> => {
      const image = await runner.run(decodeImage.name, { bytes }, [bytes.buffer], quiet) as DecodedImage;
      assert.equal(bytes.byteLength, 0);
      return image;
    };
    const files: Uint8Array<ArrayBuffer>[] = [
      encode({ width: 6, height: 4, data: Uint16Array.from(values), depth: 16, channels: 1 }).slice(),
      buildTiff({ width: 6, height: 4, samples: 1, bits: 16, format: 1, values, compression: 8, rowsPerStrip: 3 }),
      buildTiff({ width: 6, height: 4, samples: 1, bits: 16, format: 1, values, compression: 5, littleEndian: false, rowsPerStrip: 3 }),
      exportExr(6, 4, expected),
    ];
    for (const bytes of files) {
      const image = await decode(bytes);
      assert.deepEqual({ width: image.width, height: image.height, channels: image.channels }, { width: 6, height: 4, channels: 1 });
      assert.ok(image.data instanceof Float32Array);
      assert.deepEqual(Array.from(image.data), expected);
    }

    const raw = new Uint8Array(new Uint16Array(values).buffer);
    const image = await runner.run(decodeRaw.name, { bytes: raw, sample: 'u16', width: 6, height: 4 }, [raw.buffer], quiet) as DecodedImage;
    assert.equal(raw.byteLength, 0);
    assert.deepEqual(Array.from(image.data), expected);

    await assert.rejects(runner.run(decodeImage.name, { bytes: Uint8Array.of(1, 2, 3, 4) }, [], quiet), { message: 'file is not a PNG, TIFF or OpenEXR image' });
  }, undefined);
});
