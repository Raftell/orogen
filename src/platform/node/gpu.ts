import { create, globals } from 'webgpu';

import { GpuUnavailableError, openGpu, type GpuContext, type GpuProfile } from '../../core/runtime.ts';

// runtime.md 1.5 rule 1: the object create() returns must stay reachable while its device is in use, or the
// process hangs or crashes at the next asynchronous GPU callback. Keeping the adapter or the device does not help.
const instances = new Set<GPU>();
let alive = false;
let globalsAssigned = false;

const GLOBAL_NAMES = ['GPUBufferUsage', 'GPUTextureUsage', 'GPUMapMode', 'GPUShaderStage'] as const;

function profileFromEnvironment(): GpuProfile {
  const value = process.env.OROGEN_GPU_PROFILE;
  if (value === undefined || value === '') return 'max';
  if (value !== 'core' && value !== 'max') throw new TypeError(`OROGEN_GPU_PROFILE is "${value}"; it is "core" or "max"`);
  return value;
}

/** The only code that imports the `webgpu` package (runtime.md 1.1, 1.5). */
export async function createNodeGpu(opts?: { profile?: GpuProfile; adapter?: string }): Promise<GpuContext> {
  if (alive) throw new Error('A GPU context is alive in this process; there is one device per process (runtime.md 1.5)');
  const profile = opts?.profile ?? profileFromEnvironment();
  const adapter = opts?.adapter ?? (process.env.OROGEN_GPU_ADAPTER || undefined);
  alive = true;

  if (!globalsAssigned) {
    const source = globals as Readonly<Record<string, unknown>>;
    for (const name of GLOBAL_NAMES) (globalThis as Record<string, unknown>)[name] = source[name];
    globalsAssigned = true;
  }
  let instance: GPU;
  let context: GpuContext;
  try {
    instance = create(adapter !== undefined ? [`adapter=${adapter}`] : []);
    instances.add(instance);
    context = await openGpu(instance, { profile });
  } catch (thrown) {
    // The instance stays in the set: a device that failed the checks of 1.4 was destroyed, and its `lost` callback is still to come.
    alive = false;
    if (adapter !== undefined && thrown instanceof GpuUnavailableError) {
      throw new GpuUnavailableError(`${thrown.message} (adapter "${adapter}" was asked for)`);
    }
    throw thrown;
  }

  let destroyed = false;
  return {
    device: context.device,
    profile: context.profile,
    caps: context.caps,
    get lost() { return context.lost; },
    get lostInfo() { return context.lostInfo; },
    onLost: (listener) => context.onLost(listener),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      context.destroy();
      alive = false;
      // The instance is dropped only when the device's last callback, the resolution of `lost`, has run.
      void context.device.lost.then(() => { instances.delete(instance); });
    },
  };
}
