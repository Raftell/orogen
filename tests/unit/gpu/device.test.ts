// openGpu against a stand-in for the WebGPU entry object (runtime.md 1.1 to 1.4): what it asks of the adapter
// for each profile, the capability probe, the checks it rejects on, loss and uncaptured errors. No device is needed.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DeviceLostError, deviceLostError, GpuUnavailableError, onUncapturedError, openGpu, type GpuContext, type GpuLostInfo } from '../../../src/core/gpu/device.ts';

const DEFAULTS = {
  maxTextureDimension2D: 8192,
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
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
  minUniformBufferOffsetAlignment: 256,
};
const ADAPTER_LIMITS = { ...DEFAULTS, maxTextureDimension2D: 32768, maxBufferSize: 4294967296, maxStorageBufferBindingSize: 2147483644, maxStorageTexturesPerShaderStage: 8 };
const LANGUAGE = ['packed_4x8_integer_dot_product', 'readonly_and_readwrite_storage_textures'];

interface FakeOptions {
  adapter?: boolean;
  adapterFeatures?: string[];
  info?: Record<string, unknown>;
  deviceLimits?: Partial<typeof DEFAULTS>;
  language?: string[];
  requestDeviceFails?: string;
}

/** A GPU whose adapter gives devices that have exactly what was required of them. */
function fakeGpu(o: FakeOptions = {}) {
  const calls = { adapterOptions: [] as unknown[], descriptors: [] as GPUDeviceDescriptor[], destroyed: 0 };
  let loseDevice: (info: { reason: string; message: string }) => void = () => undefined;
  const listeners: ((event: { error: { message: string } }) => void)[] = [];
  const gpu = {
    wgslLanguageFeatures: new Set(o.language ?? LANGUAGE),
    async requestAdapter(options: unknown) {
      calls.adapterOptions.push(options);
      if (o.adapter === false) return null;
      return {
        features: new Set(o.adapterFeatures ?? ['float32-filterable', 'texture-formats-tier1', 'timestamp-query', 'texture-formats-tier2']),
        limits: ADAPTER_LIMITS,
        info: { vendor: 'nvidia', architecture: 'turing', device: 'gtx-1660', description: 'NVIDIA 595', ...o.info },
        async requestDevice(descriptor: GPUDeviceDescriptor) {
          calls.descriptors.push(descriptor);
          if (o.requestDeviceFails) throw new Error(o.requestDeviceFails);
          return {
            features: new Set(descriptor.requiredFeatures ?? []),
            limits: { ...DEFAULTS, ...descriptor.requiredLimits, ...o.deviceLimits },
            lost: new Promise((resolve) => { loseDevice = resolve; }),
            addEventListener(type: string, listener: (event: { error: { message: string } }) => void) {
              assert.equal(type, 'uncapturederror');
              listeners.push(listener);
            },
            destroy() {
              calls.destroyed++;
              loseDevice({ reason: 'destroyed', message: 'Device was destroyed.' });
            },
          };
        },
      };
    },
  };
  return {
    gpu: gpu as unknown as GPU,
    calls,
    lose: (reason: string, message: string) => loseDevice({ reason, message }),
    raise: (message: string) => { for (const listener of listeners) listener({ error: { message } }); },
  };
}

/** Runs `work` with console.info and console.error captured. */
async function captured<T>(work: () => Promise<T>): Promise<{ value: T; info: string[]; errors: string[] }> {
  const info: string[] = [], errors: string[] = [];
  const original = { info: console.info, error: console.error };
  console.info = (...args: unknown[]) => { info.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    return { value: await work(), info, errors };
  } finally {
    console.info = original.info;
    console.error = original.error;
  }
}
const open = async (fake: ReturnType<typeof fakeGpu>, profile: 'core' | 'max'): Promise<GpuContext> => (await captured(() => openGpu(fake.gpu, { profile }))).value;
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('core asks for nothing: no feature, every limit the default', async () => {
  const fake = fakeGpu();
  const gpu = await open(fake, 'core');
  assert.deepEqual(fake.calls.adapterOptions, [{ powerPreference: 'high-performance' }]);
  assert.deepEqual(fake.calls.descriptors, [{}]);
  assert.equal(gpu.profile, 'core');
  assert.deepEqual(gpu.caps.features, []);
  assert.deepEqual(gpu.caps.limits, {
    maxTextureDimension2D: 8192, maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728, maxStorageTexturesPerShaderStage: 4,
    minUniformBufferOffsetAlignment: 256,
  });
  assert.deepEqual([gpu.caps.compactFormats, gpu.caps.timestampQuery], [false, false]);
  assert.deepEqual(gpu.caps.formats, {
    field: 'r32float', vec2: 'rg32float', color: 'rgba16float', aux: 'rgba32float', half: 'r32float', half2: 'rg32float', mask8: 'r32float',
  });
});

test('max asks for the two features the adapter has and the adapter\'s value of four limits', async () => {
  const fake = fakeGpu();
  const gpu = await open(fake, 'max');
  assert.deepEqual(fake.calls.descriptors, [{
    requiredFeatures: ['texture-formats-tier1', 'timestamp-query'],
    requiredLimits: { maxTextureDimension2D: 32768, maxBufferSize: 4294967296, maxStorageBufferBindingSize: 2147483644, maxStorageTexturesPerShaderStage: 8 },
  }], 'never float32-filterable or texture-formats-tier2, and no other limit');
  assert.equal(gpu.profile, 'max');
  assert.deepEqual(gpu.caps.features, ['texture-formats-tier1', 'timestamp-query']);
  assert.deepEqual([gpu.caps.compactFormats, gpu.caps.timestampQuery], [true, true]);
  assert.deepEqual(gpu.caps.formats, {
    field: 'r32float', vec2: 'rg32float', color: 'rgba16float', aux: 'rgba32float', half: 'r16float', half2: 'rg16float', mask8: 'r8unorm',
  });
  assert.equal(gpu.caps.limits.maxTextureDimension2D, 32768);

  // An adapter without them gives a max device that differs from core in its limits only.
  const plain = fakeGpu({ adapterFeatures: ['float32-filterable', 'timestamp-query'] });
  const partial = await open(plain, 'max');
  assert.deepEqual(plain.calls.descriptors[0]!.requiredFeatures, ['timestamp-query']);
  assert.deepEqual([partial.caps.compactFormats, partial.caps.timestampQuery, partial.caps.formats.half], [false, true, 'r32float']);
});

test('caps describe the adapter and the device, and are logged as one JSON line only when asked for', async () => {
  const fake = fakeGpu({ adapterFeatures: ['timestamp-query', 'bgra8unorm-storage', 'texture-formats-tier1'] });
  const silent = await captured(() => openGpu(fake.gpu, { profile: 'max' }));
  assert.deepEqual(silent.info, [], 'nothing is printed unless `log` is set');
  const { value: gpu, info } = await captured(() => openGpu(fake.gpu, { profile: 'max', log: true }));
  const caps = gpu.caps;
  assert.deepEqual(caps.adapter, { vendor: 'nvidia', architecture: 'turing', device: 'gtx-1660', description: 'NVIDIA 595', isFallbackAdapter: false, backend: null });
  assert.equal(caps.software, false);
  assert.deepEqual(caps.adapterFeatures, ['bgra8unorm-storage', 'texture-formats-tier1', 'timestamp-query'], 'sorted');
  assert.deepEqual(caps.wgslLanguageFeatures, LANGUAGE);
  assert.equal(caps.vramBytes, null);
  assert.equal(info.length, 1);
  assert.ok(info[0]!.startsWith('[orogen] gpu {') && !info[0]!.includes('\n'));
  assert.deepEqual(JSON.parse(info[0]!.slice('[orogen] gpu '.length)), caps);
});

test('a software adapter is known by its flag or its name', async () => {
  const software = async (info: Record<string, unknown>): Promise<boolean> => (await open(fakeGpu({ info }), 'core')).caps.software;
  assert.equal(await software({ device: 'llvmpipe (LLVM 20.1.2, 256 bits)', description: 'Mesa 25' }), true);
  assert.equal(await software({ device: '', description: 'Microsoft Basic Render Driver' }), true);
  assert.equal(await software({ device: 'SwiftShader Device (Subzero)', description: '' }), true);
  assert.equal(await software({ isFallbackAdapter: true }), true);
  assert.equal(await software({ device: 'RTX 3080', description: 'NVIDIA' }), false);
  assert.equal((await open(fakeGpu({ info: { isFallbackAdapter: true } }), 'core')).caps.adapter.isFallbackAdapter, true);
});

test('vramBytes is the largest device-local heap, and backend what the platform exposes', async () => {
  const GiB = 2 ** 30;
  const heaps = [{ size: 10 * GiB, properties: 1 }, { size: 32 * GiB, properties: 2 }, { size: 0.25 * GiB, properties: 1 }];
  const gpu = await open(fakeGpu({ info: { memoryHeaps: heaps, backend: 'D3D12' } }), 'core');
  assert.equal(gpu.caps.vramBytes, 10 * GiB);
  assert.equal(gpu.caps.adapter.backend, 'D3D12');
  assert.equal((await open(fakeGpu({ info: { memoryHeaps: [{ size: 32 * GiB, properties: 2 }] } }), 'core')).caps.vramBytes, null, 'no device-local heap');
});

test('no adapter, no device and an unknown profile', async () => {
  const none = fakeGpu({ adapter: false });
  await assert.rejects(openGpu(none.gpu, { profile: 'core' }), (thrown: unknown) => {
    assert.ok(thrown instanceof GpuUnavailableError);
    assert.equal(thrown.name, 'GpuUnavailableError');
    assert.equal(thrown.message, 'No WebGPU adapter is available');
    return true;
  });
  await assert.rejects(openGpu(fakeGpu({ requestDeviceFails: 'limit too high\nmore' }).gpu, { profile: 'max' }), (thrown: unknown) => {
    assert.ok(thrown instanceof GpuUnavailableError);
    assert.equal(thrown.message, 'The adapter gave no device for profile "max": limit too high');
    return true;
  });
  await assert.rejects(openGpu(fakeGpu().gpu, { profile: 'fast' as never }), TypeError);
});

test('a device that fails a check of runtime.md 1.4 is refused, with the missing item named, and destroyed', async () => {
  const cases: [FakeOptions, RegExp][] = [
    [{ deviceLimits: { maxTextureDimension2D: 4096 } }, /maxTextureDimension2D of at least 8192 \(it is 4096\)/],
    [{ deviceLimits: { maxStorageTexturesPerShaderStage: 2 } }, /maxStorageTexturesPerShaderStage of at least 4/],
    [{ deviceLimits: { maxSampledTexturesPerShaderStage: 8 } }, /maxSampledTexturesPerShaderStage of at least 16/],
    [{ deviceLimits: { maxStorageBuffersPerShaderStage: 4 } }, /maxStorageBuffersPerShaderStage of at least 8/],
    [{ deviceLimits: { maxBufferSize: 134217728 } }, /maxBufferSize of at least 268435456/],
    [{ deviceLimits: { maxComputeInvocationsPerWorkgroup: 128 } }, /maxComputeInvocationsPerWorkgroup of at least 256/],
    [{ deviceLimits: { maxDynamicUniformBuffersPerPipelineLayout: 1 } }, /maxDynamicUniformBuffersPerPipelineLayout of at least 2/],
    [{ deviceLimits: { minUniformBufferOffsetAlignment: 96 } }, /minUniformBufferOffsetAlignment that divides 256 \(it is 96\)/],
    [{ deviceLimits: { minUniformBufferOffsetAlignment: 512 } }, /minUniformBufferOffsetAlignment that divides 256 \(it is 512\)/],
    [{ language: ['packed_4x8_integer_dot_product'] }, /readonly_and_readwrite_storage_textures/],
  ];
  for (const [options, expected] of cases) {
    const fake = fakeGpu(options);
    await assert.rejects(openGpu(fake.gpu, { profile: 'core' }), (thrown: unknown) => {
      assert.ok(thrown instanceof GpuUnavailableError);
      assert.match(thrown.message, expected);
      return true;
    });
    assert.equal(fake.calls.destroyed, 1);
  }
  // Alignments that divide 256 pass.
  for (const alignment of [16, 32, 64, 128, 256]) await open(fakeGpu({ deviceLimits: { minUniformBufferOffsetAlignment: alignment } }), 'core');
});

test('every device comes from a new adapter', async () => {
  const fake = fakeGpu();
  await open(fake, 'core');
  await open(fake, 'max');
  assert.equal(fake.calls.adapterOptions.length, 2);
});

test('a lost device sets lost and lostInfo and calls the listeners', async () => {
  const fake = fakeGpu();
  const gpu = await open(fake, 'core');
  assert.deepEqual([gpu.lost, gpu.lostInfo], [false, null]);
  const heard: GpuLostInfo[] = [], unheard: GpuLostInfo[] = [];
  gpu.onLost((info) => heard.push(info));
  const unsubscribe = gpu.onLost((info) => unheard.push(info));
  unsubscribe();
  fake.lose('unknown', 'The driver was reset');
  await settled();
  assert.equal(gpu.lost, true);
  assert.deepEqual(gpu.lostInfo, { reason: 'unknown', message: 'The driver was reset' });
  assert.deepEqual(heard, [{ reason: 'unknown', message: 'The driver was reset' }]);
  assert.deepEqual(unheard, []);
  const error = deviceLostError(gpu);
  assert.ok(error instanceof DeviceLostError && error.name === 'DeviceLostError');
  assert.equal(error.message, 'The GPU device was lost: The driver was reset');
  gpu.destroy();
  assert.equal(gpu.lost, true, 'never false again');
});

test('a device destroyed behind the context\'s back is lost, with reason "destroyed"', async () => {
  const fake = fakeGpu();
  const gpu = await open(fake, 'core');
  gpu.device.destroy();
  await settled();
  assert.deepEqual([gpu.lost, gpu.lostInfo], [true, { reason: 'destroyed', message: 'Device was destroyed.' }]);
});

test('destroy() destroys the device once and is not a loss', async () => {
  const fake = fakeGpu();
  const gpu = await open(fake, 'core');
  const heard: GpuLostInfo[] = [];
  gpu.onLost((info) => heard.push(info));
  gpu.destroy();
  gpu.destroy();
  await settled();
  assert.equal(fake.calls.destroyed, 1, 'idempotent');
  assert.deepEqual([gpu.lost, gpu.lostInfo, heard], [false, null, []]);
});

test('an uncaptured error reaches its listeners, and the log when there is none', async () => {
  const fake = fakeGpu();
  const gpu = await open(fake, 'core');
  const first = await captured(async () => { fake.raise('Texture is destroyed'); });
  assert.deepEqual(first.errors, ['[orogen] uncaptured GPU error: Texture is destroyed']);

  const heard: string[] = [];
  const unsubscribe = onUncapturedError(gpu, (error) => heard.push(error.message));
  const second = await captured(async () => { fake.raise('Buffer is too small'); });
  assert.deepEqual([heard, second.errors], [['Buffer is too small'], []]);
  unsubscribe();
  const third = await captured(async () => { fake.raise('again'); });
  assert.deepEqual([heard.length, third.errors.length], [1, 1]);
});
