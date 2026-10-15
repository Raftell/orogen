// createNodeGpu and openGpu on the real adapter (runtime.md 1.1 to 1.5): the profile, the capability probe,
// one device per process, destruction, and loss. This file creates and destroys its own contexts, one after
// another, because that is what it tests; every other file takes the process's device from the rig.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { adapterNamed } from '../../../src/core/gpu/caps.ts';
import { DeviceLostError, GpuUnavailableError, type GpuContext, type GpuLostInfo, type GpuProfile } from '../../../src/core/gpu/device.ts';
import { createNodeGpu } from '../../../src/platform/node/gpu.ts';

const profile: GpuProfile = (process.env.OROGEN_GPU_PROFILE as GpuProfile | undefined) || 'core';
const requested = process.env.OROGEN_GPU_ADAPTER || undefined;
const environment = { profile: process.env.OROGEN_GPU_PROFILE, log: process.env.OROGEN_GPU_LOG };
const contexts: GpuContext[] = [];
const logged: string[] = [];

/** Opens a context with console.info captured, so that the line of runtime.md 1.3 can be read. */
async function openContext(opts?: Parameters<typeof createNodeGpu>[0]): Promise<GpuContext> {
  const original = console.info;
  console.info = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try {
    const gpu = await createNodeGpu(opts);
    contexts.push(gpu);
    return gpu;
  } finally {
    console.info = original;
  }
}

after(() => {
  for (const gpu of contexts) gpu.destroy();
  if (environment.profile === undefined) delete process.env.OROGEN_GPU_PROFILE;
  else process.env.OROGEN_GPU_PROFILE = environment.profile;
  if (environment.log === undefined) delete process.env.OROGEN_GPU_LOG;
  else process.env.OROGEN_GPU_LOG = environment.log;
});

const DEFAULT_LIMITS = [8192, 268435456, 134217728, 4];
const limitsOf = (gpu: GpuContext): number[] => {
  const l = gpu.caps.limits;
  return [l.maxTextureDimension2D, l.maxBufferSize, l.maxStorageBufferBindingSize, l.maxStorageTexturesPerShaderStage];
};

let gpu: GpuContext;

test('an adapter name that matches nothing fails with GpuUnavailableError; nothing falls back', async () => {
  await assert.rejects(createNodeGpu({ profile, adapter: 'no-adapter-has-this-name' }), (thrown: unknown) => {
    assert.ok(thrown instanceof GpuUnavailableError, String(thrown));
    assert.match(thrown.message, /No WebGPU adapter is available/);
    assert.match(thrown.message, /adapter "no-adapter-has-this-name" was asked for/);
    return true;
  });
});

test('createNodeGpu opens a device of the profile it is asked for, and logs its caps once when OROGEN_GPU_LOG is 1', async () => {
  // Without the variable nothing is printed: the line would bury test output and break a tool's JSON (runtime.md 1.3).
  delete process.env.OROGEN_GPU_LOG;
  const silent = await openContext({ profile });
  silent.destroy();
  assert.deepEqual(logged.filter((line) => line.startsWith('[orogen] gpu ')), []);

  process.env.OROGEN_GPU_LOG = '1';
  gpu = await openContext({ profile });
  delete process.env.OROGEN_GPU_LOG;
  assert.equal(gpu.profile, profile);
  assert.deepEqual([gpu.lost, gpu.lostInfo], [false, null]);
  assert.ok(gpu.device.queue);
  const lines = logged.filter((line) => line.startsWith('[orogen] gpu '));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!.slice('[orogen] gpu '.length)), gpu.caps);
});

test('caps are read from the adapter and the device', () => {
  const caps = gpu.caps;
  for (const text of [caps.adapter.vendor, caps.adapter.architecture, caps.adapter.device, caps.adapter.description]) assert.equal(typeof text, 'string');
  assert.equal(typeof caps.adapter.isFallbackAdapter, 'boolean');
  assert.equal(typeof caps.software, 'boolean');
  if (requested) assert.ok(adapterNamed(caps.adapter, requested), JSON.stringify(caps.adapter));
  // The adapters CI selects by these names compute on the CPU (testing.md 9.3), and the probe has to say so.
  if (requested === 'llvmpipe' || requested === 'Microsoft') assert.equal(caps.software, true, JSON.stringify(caps.adapter));
  for (const list of [caps.adapterFeatures, caps.features, caps.wgslLanguageFeatures]) assert.deepEqual(list, [...list].sort());
  for (const feature of caps.features) assert.ok(caps.adapterFeatures.includes(feature), `the device has ${feature}, which the adapter does not offer`);
  assert.ok(caps.wgslLanguageFeatures.includes('readonly_and_readwrite_storage_textures'));
  assert.equal(256 % caps.limits.minUniformBufferOffsetAlignment, 0);
  assert.equal(caps.compactFormats, caps.features.includes('texture-formats-tier1'));
  assert.equal(caps.timestampQuery, caps.features.includes('timestamp-query'));
  // Dawn in Node reports no memory heaps: the figure is nvidia-smi's, in whole MiB, or there is none (runtime.md 1.3).
  assert.ok(caps.vramSource === null || caps.vramSource === 'nvidia-smi', `vramSource ${String(caps.vramSource)}`);
  assert.equal(caps.vramBytes === null, caps.vramSource === null, `vramBytes ${caps.vramBytes} from ${String(caps.vramSource)}`);
  if (caps.vramBytes !== null) assert.ok(caps.vramBytes > 0 && Number.isSafeInteger(caps.vramBytes / 2 ** 20), `vramBytes ${caps.vramBytes}`);
  assert.equal(caps.adapter.backend, null);
  assert.deepEqual(
    caps.formats,
    caps.compactFormats
      ? { field: 'r32float', vec2: 'rg32float', color: 'rgba16float', aux: 'rgba32float', half: 'r16float', half2: 'rg16float', mask8: 'r8unorm' }
      : { field: 'r32float', vec2: 'rg32float', color: 'rgba16float', aux: 'rgba32float', half: 'r32float', half2: 'rg32float', mask8: 'r32float' },
  );
  // No profile requests these, whatever the adapter offers.
  for (const feature of ['float32-filterable', 'float32-blendable', 'texture-formats-tier2', 'shader-f16', 'subgroups']) {
    assert.ok(!caps.features.includes(feature), feature);
  }
});

test(`profile "${profile}": the features and limits the profile asks for, and no others`, () => {
  const caps = gpu.caps;
  if (profile === 'core') {
    assert.deepEqual([caps.compactFormats, caps.timestampQuery], [false, false]);
    assert.deepEqual(limitsOf(gpu), DEFAULT_LIMITS, 'a device has only what was requested, whatever the adapter offers');
    assert.deepEqual([gpu.device.limits.maxTextureDimension2D, gpu.device.features.has('timestamp-query')], [8192, false]);
  } else {
    assert.equal(caps.compactFormats, caps.adapterFeatures.includes('texture-formats-tier1'));
    assert.equal(caps.timestampQuery, caps.adapterFeatures.includes('timestamp-query'));
    limitsOf(gpu).forEach((value, i) => assert.ok(value >= DEFAULT_LIMITS[i]!, `limit ${i} is ${value}`));
    assert.equal(gpu.device.limits.maxTextureDimension2D, caps.limits.maxTextureDimension2D);
  }
});

test('the package\'s constants are globals; the GPU object is not', () => {
  const globals = globalThis as Record<string, unknown>;
  for (const name of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUMapMode', 'GPUShaderStage']) assert.ok(globals[name] !== undefined && globals[name] !== null, name);
  assert.deepEqual([GPUTextureUsage.STORAGE_BINDING, GPUBufferUsage.UNIFORM, GPUMapMode.READ, GPUShaderStage.COMPUTE], [8, 64, 1, 4]);
  assert.equal(globals.gpu, undefined);
  assert.equal((globals.navigator as { gpu?: unknown } | undefined)?.gpu, undefined);
});

test('one device per process: a second context while one is alive is refused', async () => {
  await assert.rejects(createNodeGpu({ profile }), /one device per process/);
  await assert.rejects(createNodeGpu(), /one device per process/);
  assert.equal(gpu.lost, false);
});

test('destroy() is idempotent, is not a loss, and frees the process for the next context', async () => {
  const heard: GpuLostInfo[] = [];
  gpu.onLost((info) => heard.push(info));
  const lost = gpu.device.lost;
  gpu.destroy();
  gpu.destroy();
  assert.equal((await lost).reason, 'destroyed');
  assert.deepEqual([gpu.lost, gpu.lostInfo, heard], [false, null, []]);

  // The factory's own defaults: the profile from OROGEN_GPU_PROFILE, else "max".
  delete process.env.OROGEN_GPU_PROFILE;
  const byDefault = await openContext();
  assert.equal(byDefault.profile, 'max');
  assert.notEqual(byDefault.device, gpu.device, 'a new device from a new adapter');
  assert.equal(byDefault.lost, false);
  byDefault.destroy();

  process.env.OROGEN_GPU_PROFILE = 'core';
  const fromEnvironment = await openContext();
  assert.equal(fromEnvironment.profile, 'core');
  assert.deepEqual(limitsOf(fromEnvironment), DEFAULT_LIMITS);
  fromEnvironment.destroy();

  process.env.OROGEN_GPU_PROFILE = 'fastest';
  await assert.rejects(createNodeGpu(), TypeError);
  await assert.rejects(createNodeGpu({ profile: 'fastest' as never }), TypeError);
  process.env.OROGEN_GPU_PROFILE = profile;
});

test('a device lost for any other reason sets lost, and stays lost', async () => {
  const context = await openContext({ profile });
  const heard: GpuLostInfo[] = [], unheard: GpuLostInfo[] = [];
  const reported = new Promise<void>((resolve) => { context.onLost((info) => { heard.push(info); resolve(); }); });
  context.onLost((info) => unheard.push(info))();

  // Work on the live device, then the device goes away without the context being told.
  const buffer = context.device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  await context.device.queue.onSubmittedWorkDone();
  context.device.destroy();
  await reported;
  assert.equal(context.lost, true);
  assert.equal(context.lostInfo?.reason, 'destroyed');
  assert.equal(typeof context.lostInfo?.message, 'string');
  assert.deepEqual(heard, [context.lostInfo]);
  assert.deepEqual(unheard, []);

  // Measured on Dawn (runtime.md 5.9): only mapAsync rejects on a lost device, which is why the engine checks `lost`.
  await context.device.queue.onSubmittedWorkDone();
  await assert.rejects(buffer.mapAsync(GPUMapMode.READ));
  context.destroy();
  assert.equal(context.lost, true, 'never false again');
  assert.ok(new DeviceLostError('x') instanceof Error);
});
