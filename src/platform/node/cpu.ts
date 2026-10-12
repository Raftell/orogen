import { Worker } from 'node:worker_threads';
import type { CpuRunner, CpuTaskReply, CpuTaskRequest } from '../../core/runtime.ts';

interface Job {
  readonly request: CpuTaskRequest;
  readonly transfer: ArrayBuffer[];
  readonly signal: AbortSignal;
  readonly onProgress: (fraction: number) => void;
  /** Settles the promise of run() and stops listening to the signal. */
  readonly settle: (outcome: { readonly value: unknown } | { readonly error: unknown }) => void;
}

/**
 * runtime.md 6.3: one node:worker_threads worker, started at the first run(). `entry` is the worker's entry file;
 * the default is the product's, cpu-worker.ts, and only a test of the runner itself passes another.
 */
export function createNodeCpuRunner(entry: URL = new URL('./cpu-worker.ts', import.meta.url)): CpuRunner {
  let worker: Worker | null = null;
  // A request is posted only when it is its turn: a task that waits here survives the termination of the worker.
  let active: Job | null = null;
  const queue: Job[] = [];
  const stopping = new Set<Promise<unknown>>();
  let nextId = 1;
  let disposed = false;

  function start(): Worker {
    // workerData is an object on purpose. geotiff imports the package web-worker, whose Node build, when it is
    // loaded in a worker thread, reads workerData.mod and throws a TypeError when workerData is undefined.
    const w = new Worker(entry, { name: 'orogen-cpu', workerData: {} });
    // A worker that was replaced may still deliver events: they are not about the current task.
    w.on('message', (reply: CpuTaskReply) => { if (w === worker) onReply(reply); });
    w.on('messageerror', (error) => { if (w === worker) onWorkerFailure(`a reply could not be read (${reasonOf(error)})`); });
    w.on('error', (error) => { if (w === worker) onWorkerFailure(reasonOf(error)); });
    w.on('exit', (code) => { if (w === worker) onWorkerFailure(`it exited with code ${code}`); });
    return w;
  }

  /** Stops the current worker, whatever it is doing. The next task starts a new one. */
  function retire(): void {
    const w = worker;
    if (w === null) return;
    worker = null;
    const stopped: Promise<unknown> = w.terminate().catch(() => {}).finally(() => { stopping.delete(stopped); });
    stopping.add(stopped);
  }

  /** Ends the task in progress and starts the next. An idle worker does not keep the process alive. */
  function finish(job: Job, outcome: { readonly value: unknown } | { readonly error: unknown }): void {
    active = null;
    worker?.unref();
    job.settle(outcome);
    pump();
  }

  function pump(): void {
    while (active === null && queue.length > 0) {
      const job = queue.shift()!;
      active = job;
      try {
        worker ??= start();
        worker.ref();
        worker.postMessage(job.request, job.transfer);
      } catch (error) {
        // The arguments cannot be cloned, or a buffer of the transfer list is already detached.
        active = null;
        worker?.unref();
        job.settle({ error });
      }
    }
  }

  function onReply(reply: CpuTaskReply): void {
    const job = active;
    if (job === null || typeof reply !== 'object' || reply === null || reply.id !== job.request.id) return;
    if (reply.type === 'progress') {
      try {
        job.onProgress(reply.fraction);
      } catch (error) {
        // The task is still executing and nobody waits for it any more.
        retire();
        finish(job, { error });
      }
    } else if (reply.type === 'result') finish(job, { value: reply.value });
    else finish(job, { error: new Error(reply.message) });
  }

  function onWorkerFailure(reason: string): void {
    retire();
    const job = active;
    if (job !== null) finish(job, { error: new Error(`The CPU worker failed: ${reason}`) });
  }

  function onAbort(job: Job): void {
    if (job === active) {
      // Rule 5: the task may be executing, so its thread is stopped.
      retire();
      finish(job, { error: job.signal.reason });
      return;
    }
    const index = queue.indexOf(job);
    if (index < 0) return;
    queue.splice(index, 1);
    job.settle({ error: job.signal.reason });
  }

  return {
    run(taskName, args, transfer, opts): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        if (disposed) {
          reject(new Error('The CPU runner was disposed'));
          return;
        }
        const { signal, onProgress } = opts;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const abort = (): void => onAbort(job);
        const job: Job = {
          request: { id: nextId++, task: taskName, args },
          transfer: [...transfer],
          signal,
          onProgress,
          settle(outcome): void {
            signal.removeEventListener('abort', abort);
            if ('error' in outcome) reject(outcome.error);
            else resolve(outcome.value);
          },
        };
        signal.addEventListener('abort', abort, { once: true });
        queue.push(job);
        pump();
      });
    },

    async dispose(): Promise<void> {
      if (!disposed) {
        disposed = true;
        const pending = active === null ? [...queue] : [active, ...queue];
        active = null;
        queue.length = 0;
        retire();
        const error = new Error('The CPU runner was disposed');
        for (const job of pending) job.settle({ error });
      }
      await Promise.all([...stopping]);
    },
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
