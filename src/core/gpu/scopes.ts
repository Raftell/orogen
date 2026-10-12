/** The pops of one guarded call. They are awaited later by whoever owns the call, never where they are made. */
export interface ScopeResult {
  readonly validation: Promise<GPUError | null>;
  readonly outOfMemory: Promise<GPUError | null>;
}

const none = (): null => null;

/**
 * runtime.md 5.8 rule 2: pushErrorScope('validation'), pushErrorScope('out-of-memory'), `work`, both pops,
 * in one synchronous block. `work` must not await.
 */
export function guarded<T>(device: GPUDevice, work: () => T): { readonly value: T; readonly scopes: ScopeResult } {
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  let outOfMemory: Promise<GPUError | null>;
  let validation: Promise<GPUError | null>;
  let value: T;
  try {
    value = work();
  } finally {
    // A pop on a lost device may reject; the loss is reported through GpuContext, not through a scope.
    outOfMemory = device.popErrorScope().catch(none);
    validation = device.popErrorScope().catch(none);
  }
  return { value, scopes: { validation, outOfMemory } };
}
