import type { GpuContext } from '../gpu/device.ts';

/** The outcome of one recovery after a device loss (runtime.md 7.8). */
export type RecoveryOutcome =
  | { readonly ok: true; readonly gpu: GpuContext }
  | { readonly ok: false; readonly message: string };     // automatic recovery has ended: engine-error with fatal true

/**
 * 7.8 rules 2 and 3: reopenGpu at once, again after 1 s, again after 5 s; three failures in a row, or a third
 * device loss within 120 s, end automatic recovery until retry() is called.
 */
export interface DeviceRecovery {
  /** A device was lost: starts the attempts. Resolves with the new context, or with the failure. */
  lost(): Promise<RecoveryOutcome>;
  /** EngineSession.retryDevice: starts the attempts again after a failure. */
  retry(): Promise<RecoveryOutcome>;
  /** Stops waiting between attempts; pending promises resolve with a failure. */
  dispose(): void;
}

/** The wait before each attempt of one recovery (7.8 rule 2). */
export const RETRY_DELAYS_MS: readonly number[] = [0, 1000, 5000];
/** This many losses within the window end automatic recovery (7.8 rule 3). */
export const LOSS_LIMIT = 3;
export const LOSS_WINDOW_MS = 120_000;

/** For tests of the policy: other waits, another clock. The session passes none. */
export interface RecoveryOptions {
  readonly delaysMs?: readonly number[];
  readonly now?: () => number;
}

const describe = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown)).split('\n')[0]!;

export function createRecovery(reopenGpu: () => Promise<GpuContext>, options: RecoveryOptions = {}): DeviceRecovery {
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  const now = options.now ?? (() => performance.now());
  /** When each loss of the window happened. */
  let losses: number[] = [];
  let attempts: Promise<RecoveryOutcome> | null = null;
  let disposed = false;
  /** Ends the wait under way. */
  let wake: (() => void) | null = null;

  function wait(ms: number): Promise<void> {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  async function run(): Promise<RecoveryOutcome> {
    let last = 'no attempt was made';
    for (const delay of delays) {
      await wait(delay);
      if (disposed) break;
      let gpu: GpuContext;
      try {
        gpu = await reopenGpu();
      } catch (thrown) {
        last = describe(thrown);
        continue;
      }
      // Nobody else knows this context: one that cannot be used is destroyed here.
      if (disposed) {
        gpu.destroy();
        break;
      }
      if (gpu.lost) {
        last = `the new device was lost at once${gpu.lostInfo?.message ? `: ${gpu.lostInfo.message}` : ''}`;
        gpu.destroy();
        continue;
      }
      return { ok: true, gpu };
    }
    if (disposed) return { ok: false, message: 'The session was disposed while the GPU device was being reopened' };
    return { ok: false, message: `No GPU device could be opened in ${delays.length} attempts: ${last}` };
  }

  function start(): Promise<RecoveryOutcome> {
    if (disposed) return Promise.resolve({ ok: false, message: 'The session is disposed' });
    attempts ??= run().finally(() => {
      attempts = null;
    });
    return attempts;
  }

  return {
    lost() {
      const at = now();
      losses = losses.filter((earlier) => at - earlier < LOSS_WINDOW_MS);
      losses.push(at);
      if (losses.length >= LOSS_LIMIT && !disposed) {
        return Promise.resolve({
          ok: false,
          message: `The GPU device was lost ${losses.length} times within ${LOSS_WINDOW_MS / 1000} seconds; it is not reopened automatically`,
        });
      }
      return start();
    },

    retry: start,

    dispose() {
      disposed = true;
      wake?.();
    },
  };
}

/**
 * The first device of an engine (8.3 step 1), where there is no session yet to recover a loss: `open` is tried on
 * the schedule of 7.8 rule 2, and a device that arrives lost is destroyed and counts as a failure. Rejects with
 * what the last attempt failed with. An adapter that is missing for a moment (a GPU process that is starting
 * again) is thus not final.
 */
export async function openFirstDevice(open: () => Promise<GpuContext>, options: RecoveryOptions = {}): Promise<GpuContext> {
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  let last: unknown = new Error('no attempt was made');
  for (const delay of delays) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    let gpu: GpuContext;
    try {
      gpu = await open();
    } catch (thrown) {
      last = thrown;
      continue;
    }
    if (!gpu.lost) return gpu;
    last = new Error(`The new GPU device was lost at once${gpu.lostInfo?.message ? `: ${gpu.lostInfo.message}` : ''}`);
    gpu.destroy();
  }
  throw last;
}
