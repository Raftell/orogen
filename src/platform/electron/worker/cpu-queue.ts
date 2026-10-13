// The CpuRunner of runtime.md 6.3 over any worker that speaks the protocol of src/core/cpu/protocol.ts. cpu.ts
// gives it a Web Worker; the queue itself touches no worker API, so its rules are tested without a browser.

import type { CpuRunner, CpuTaskReply, CpuTaskRequest } from '../../../core/runtime.ts';

/** One started worker, as the queue uses it. */
export interface CpuWorker {
  post(request: CpuTaskRequest, transfer: ArrayBuffer[]): void;
  /** Stops the worker whatever it is doing. Nothing is delivered afterwards. */
  stop(): void;
}

/**
 * Starts a worker. `onReply` gets every message it posts; `onFailure` is called when it cannot start, dies, or
 * posts what cannot be read, with the reason. Throwing means it could not start.
 */
export type StartCpuWorker = (onReply: (reply: unknown) => void, onFailure: (reason: string) => void) => CpuWorker;

interface Job {
  readonly request: CpuTaskRequest;
  readonly transfer: ArrayBuffer[];
  readonly signal: AbortSignal;
  readonly onProgress: (fraction: number) => void;
  /** Settles the promise of run() and stops listening to the signal. */
  readonly settle: (outcome: { readonly value: unknown } | { readonly error: unknown }) => void;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isReply(reply: unknown): reply is CpuTaskReply {
  return typeof reply === 'object' && reply !== null && typeof (reply as { id?: unknown }).id === 'number';
}

/** One worker, started at the first run(). Tasks run one at a time, in call order. */
export function createCpuRunner(start: StartCpuWorker): CpuRunner {
  let worker: CpuWorker | null = null;
  /** Identifies the worker whose events count: the one in `worker`, or the one being started. */
  let current: object | null = null;
  // A request is posted only when it is its turn: a task that waits here survives the end of the worker.
  let active: Job | null = null;
  const queue: Job[] = [];
  let nextId = 1;
  let disposed = false;

  /** Stops the current worker. The next task starts a new one. */
  function retire(): void {
    const w = worker;
    worker = null;
    current = null;
    w?.stop();
  }

  function finish(job: Job, outcome: { readonly value: unknown } | { readonly error: unknown }): void {
    active = null;
    job.settle(outcome);
    pump();
  }

  function onReply(reply: unknown): void {
    const job = active;
    if (job === null || !isReply(reply) || reply.id !== job.request.id) return;
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

  function onFailure(reason: string): void {
    retire();
    const job = active;
    if (job !== null) finish(job, { error: new Error(`The CPU worker failed: ${reason}`) });
  }

  function pump(): void {
    while (active === null && queue.length > 0) {
      const job = queue.shift()!;
      if (worker === null) {
        // A worker that was replaced may still deliver events: they are not about the current task.
        const token = {};
        const early: { reason: string | null } = { reason: null };
        current = token;
        try {
          const started = start(
            (reply) => { if (current === token) onReply(reply); },
            (reason) => {
              if (current !== token) return;
              // Before start() has returned there is no worker to retire and no task in progress.
              if (worker === null) early.reason = reason;
              else onFailure(reason);
            },
          );
          if (early.reason !== null) {
            started.stop();
            throw new Error(early.reason);
          }
          worker = started;
        } catch (error) {
          // Rule 6: a worker that cannot start fails this task only; the next one tries again.
          current = null;
          job.settle({ error: new Error(`The CPU worker failed: ${reasonOf(error)}`) });
          continue;
        }
      }
      active = job;
      try {
        worker.post(job.request, job.transfer);
      } catch (error) {
        // The arguments cannot be cloned, or a buffer of the transfer list is already detached.
        active = null;
        job.settle({ error });
      }
    }
  }

  function onAbort(job: Job): void {
    if (job === active) {
      // Rule 5: the task may be executing, so its worker is stopped.
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

    dispose(): Promise<void> {
      if (!disposed) {
        disposed = true;
        const pending = active === null ? [...queue] : [active, ...queue];
        active = null;
        queue.length = 0;
        retire();
        const error = new Error('The CPU runner was disposed');
        for (const job of pending) job.settle({ error });
      }
      return Promise.resolve();
    },
  };
}
