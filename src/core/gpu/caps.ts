import type { GpuProfile } from './device.ts';
import type { FieldKind } from './field.ts';

export interface GpuCaps {
  readonly adapter: {
    readonly vendor: string; readonly architecture: string; readonly device: string; readonly description: string;
    readonly isFallbackAdapter: boolean;
    readonly backend: string | null;            // exposed by Chromium with developer features, else null
  };
  /** A CPU rasteriser: isFallbackAdapter, or architecture `warp` or `software`, or device + description names llvmpipe, SwiftShader or Basic Render. */
  readonly software: boolean;
  readonly adapterFeatures: readonly string[];  // what the adapter offers, sorted
  readonly features: readonly string[];         // what the device has, sorted
  readonly wgslLanguageFeatures: readonly string[];
  readonly limits: {
    readonly maxTextureDimension2D: number;
    readonly maxBufferSize: number;
    readonly maxStorageBufferBindingSize: number;
    readonly maxStorageTexturesPerShaderStage: number;
    readonly minUniformBufferOffsetAlignment: number;
  };
  readonly compactFormats: boolean;             // texture-formats-tier1 is enabled
  readonly timestampQuery: boolean;             // timestamp-query is enabled
  readonly formats: Readonly<Record<FieldKind, GPUTextureFormat>>;   // resolved once, engine.md 1.2
  /** Largest device-local heap of adapter.info.memoryHeaps, in bytes; null when the platform does not expose it. */
  readonly vramBytes: number | null;
}

const MAX_FEATURES: readonly GPUFeatureName[] = ['texture-formats-tier1', 'timestamp-query'];
const MAX_LIMITS = ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize', 'maxStorageTexturesPerShaderStage'] as const;

/** The WebGPU defaults of the limits the engine depends on (runtime.md 1.4 row 1). */
const DEFAULT_LIMITS = {
  maxTextureDimension2D: 8192,
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 2,
  maxSampledTexturesPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  maxBufferSize: 268435456,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupsPerDimension: 65535,
} as const;

/** What a profile asks of an adapter (runtime.md 1.2). */
export function deviceDescriptor(adapter: GPUAdapter, profile: GpuProfile): GPUDeviceDescriptor {
  if (profile === 'core') return {};
  const requiredLimits: Record<string, number> = {};
  for (const name of MAX_LIMITS) requiredLimits[name] = adapter.limits[name];
  return { requiredFeatures: MAX_FEATURES.filter((feature) => adapter.features.has(feature)), requiredLimits };
}

/** adapter.info members that only some platforms have. */
interface PlatformAdapterInfo {
  readonly isFallbackAdapter?: boolean;
  readonly backend?: string;
  readonly memoryHeaps?: readonly { readonly size: number; readonly properties: number }[];
}
const HEAP_DEVICE_LOCAL = 1;

/** A name by its letters and digits alone: WebGPU reports "microsoft-basic-render-driver" where the driver says "Microsoft Basic Render Driver". */
const letters = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Whether an adapter computes on the CPU (runtime.md 1.3). WARP under Dawn does not set isFallbackAdapter: its name has to do. */
export function isSoftwareAdapter(adapter: Pick<GpuCaps['adapter'], 'architecture' | 'device' | 'description' | 'isFallbackAdapter'>): boolean {
  return adapter.isFallbackAdapter
    || /^(warp|software)$/.test(letters(adapter.architecture))
    || /llvmpipe|swiftshader|basicrender/.test(letters(`${adapter.device} ${adapter.description}`));
}

/**
 * Whether `name`, as OROGEN_GPU_ADAPTER or --adapter gives it, names this adapter (runtime.md 1.5 rule 2). The
 * factory matches the name against the driver's own text; adapter.info gives that text respelled, in a member
 * the platform chooses.
 */
export function adapterNamed(adapter: Pick<GpuCaps['adapter'], 'vendor' | 'architecture' | 'device' | 'description'>, name: string): boolean {
  const wanted = letters(name);
  return [adapter.vendor, adapter.architecture, adapter.device, adapter.description].some((text) => letters(text).includes(wanted));
}

/** Fills GpuCaps from the adapter and the created device (runtime.md 1.3). `gpu` supplies wgslLanguageFeatures. */
export function probeCaps(gpu: GPU, adapter: GPUAdapter, device: GPUDevice): GpuCaps {
  const info = adapter.info;
  const platform: PlatformAdapterInfo = info;
  const isFallbackAdapter = platform.isFallbackAdapter === true || (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter === true;
  const compactFormats = device.features.has('texture-formats-tier1');
  const heaps = (platform.memoryHeaps ?? []).filter((heap) => (heap.properties & HEAP_DEVICE_LOCAL) !== 0).map((heap) => Number(heap.size));
  const described: GpuCaps['adapter'] = {
    vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    isFallbackAdapter,
    backend: typeof platform.backend === 'string' ? platform.backend : null,
  };
  return {
    adapter: described,
    software: isSoftwareAdapter(described),
    adapterFeatures: [...adapter.features].sort(),
    features: [...device.features].sort(),
    wgslLanguageFeatures: [...gpu.wgslLanguageFeatures].sort(),
    limits: {
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxStorageTexturesPerShaderStage: device.limits.maxStorageTexturesPerShaderStage,
      minUniformBufferOffsetAlignment: device.limits.minUniformBufferOffsetAlignment,
    },
    compactFormats,
    timestampQuery: device.features.has('timestamp-query'),
    formats: {
      field: 'r32float',
      vec2: 'rg32float',
      color: 'rgba16float',
      aux: 'rgba32float',
      half: compactFormats ? 'r16float' : 'r32float',
      half2: compactFormats ? 'rg16float' : 'rg32float',
      mask8: compactFormats ? 'r8unorm' : 'r32float',
    },
    vramBytes: heaps.length > 0 ? Math.max(...heaps) : null,
  };
}

/** The checks of runtime.md 1.4, rows 1 to 3. Returns the name of the first missing item, or null. */
export function missingGuarantee(caps: GpuCaps, device: GPUDevice): string | null {
  for (const [name, minimum] of Object.entries(DEFAULT_LIMITS) as [keyof typeof DEFAULT_LIMITS, number][]) {
    const value = device.limits[name];
    if (!(value >= minimum)) return `the limit ${name} of at least ${minimum} (it is ${value})`;
  }
  const alignment = caps.limits.minUniformBufferOffsetAlignment;
  if (!(alignment > 0) || 256 % alignment !== 0) {
    return `a minUniformBufferOffsetAlignment that divides 256 (it is ${alignment})`;
  }
  if (!caps.wgslLanguageFeatures.includes('readonly_and_readwrite_storage_textures')) {
    return 'the WGSL language feature readonly_and_readwrite_storage_textures';
  }
  return null;
}
