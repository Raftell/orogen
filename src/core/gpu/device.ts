import { deviceDescriptor, missingGuarantee, probeCaps, type GpuCaps } from './caps.ts';

export type GpuProfile = 'max' | 'core';

export interface GpuLostInfo { readonly reason: 'destroyed' | 'unknown'; readonly message: string }

export interface GpuContext {
  readonly device: GPUDevice;
  readonly profile: GpuProfile;
  readonly caps: GpuCaps;                       // 1.3
  /** True once device.lost has resolved for any reason other than destroy(). Never false again. */
  readonly lost: boolean;
  readonly lostInfo: GpuLostInfo | null;
  onLost(listener: (info: GpuLostInfo) => void): () => void;
  /** Destroys the device. In Node it also drops the Dawn instance. Idempotent. */
  destroy(): void;
}

export class GpuUnavailableError extends Error {    // no adapter, or the device fails the checks of 1.4
  override name = 'GpuUnavailableError';
}
export class DeviceLostError extends Error {        // thrown by every engine call on a lost device
  override name = 'DeviceLostError';
}

/** What every engine call throws on a lost device. */
export function deviceLostError(gpu: GpuContext): DeviceLostError {
  return new DeviceLostError(`The GPU device was lost${gpu.lostInfo?.message ? `: ${gpu.lostInfo.message}` : ''}`);
}

type UncapturedListener = (error: GPUError) => void;
const uncaptured = new WeakMap<GPUDevice, Set<UncapturedListener>>();

/**
 * Subscribes to the GPU errors no error scope captured (runtime.md 5.8 rule 5). They belong to no node; the
 * session reports them as non-fatal engine errors. Without a listener openGpu logs them. Returns the unsubscribe.
 */
export function onUncapturedError(gpu: GpuContext, listener: UncapturedListener): () => void {
  const listeners = uncaptured.get(gpu.device);
  listeners?.add(listener);
  return () => void listeners?.delete(listener);
}

const describe = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown)).split('\n')[0]!;

/** The only code that calls requestAdapter() or requestDevice(). */
export async function openGpu(gpu: GPU, opts: { profile: GpuProfile }): Promise<GpuContext> {
  const profile = opts.profile;
  if (profile !== 'core' && profile !== 'max') throw new TypeError(`Unknown GPU profile "${String(profile)}"; it is "core" or "max"`);

  // A new adapter for every device: requestDevice consumes it.
  let adapter: GPUAdapter | null;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (thrown) {
    throw new GpuUnavailableError(`No WebGPU adapter is available: ${describe(thrown)}`);
  }
  if (!adapter) throw new GpuUnavailableError('No WebGPU adapter is available');

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice(deviceDescriptor(adapter, profile));
  } catch (thrown) {
    throw new GpuUnavailableError(`The adapter gave no device for profile "${profile}": ${describe(thrown)}`);
  }
  const caps = probeCaps(gpu, adapter, device);
  const missing = missingGuarantee(caps, device);
  if (missing !== null) {
    device.destroy();
    throw new GpuUnavailableError(`The GPU device lacks ${missing}`);
  }

  let lost = false;
  let lostInfo: GpuLostInfo | null = null;
  let destroyed = false;
  const lostListeners = new Set<(info: GpuLostInfo) => void>();
  void device.lost.then((info) => {
    if (destroyed) return;
    lost = true;
    lostInfo = { reason: info.reason === 'destroyed' ? 'destroyed' : 'unknown', message: info.message };
    for (const listener of [...lostListeners]) listener(lostInfo);
  });

  const errorListeners = new Set<UncapturedListener>();
  uncaptured.set(device, errorListeners);
  device.addEventListener('uncapturederror', (event) => {
    const error = (event as GPUUncapturedErrorEvent).error;
    if (errorListeners.size === 0) console.error(`[orogen] uncaptured GPU error: ${error.message}`);
    for (const listener of [...errorListeners]) listener(error);
  });

  console.info(`[orogen] gpu ${JSON.stringify(caps)}`);

  return {
    device,
    profile,
    caps,
    get lost() { return lost; },
    get lostInfo() { return lostInfo; },
    onLost(listener) {
      lostListeners.add(listener);
      return () => void lostListeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      device.destroy();
    },
  };
}
