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

export function createRecovery(reopenGpu: () => Promise<GpuContext>): DeviceRecovery {
  throw new Error('not implemented: createRecovery');
}
