// Feasibility spike: Dawn node bindings -> compute into r32float -> readback -> 16-bit PNG.
import { create, globals } from 'webgpu';
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

Object.assign(globalThis, globals);
const flags = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const size = Number(process.argv.find((a) => a.startsWith('--size='))?.slice(7) ?? 1024);
const gpu = create(flags);

// Machines without a GPU (CI) only have a software adapter, which Dawn hides unless asked for.
let adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
let how = 'hardware';
if (!adapter) { adapter = await gpu.requestAdapter({ forceFallbackAdapter: true }); how = 'fallback'; }
if (!adapter) throw new Error('no adapter');
console.log('adapter path:', how);
const info = adapter.info;
console.log('adapter:', info.vendor, '|', info.architecture, '|', info.device, '|', info.description);
console.log('features:', [...adapter.features].sort().join(', '));
const L = adapter.limits;
console.log('limits:', {
  maxTextureDimension2D: L.maxTextureDimension2D,
  maxBufferSize: L.maxBufferSize,
  maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
  maxComputeWorkgroupsPerDimension: L.maxComputeWorkgroupsPerDimension,
  maxStorageTexturesPerShaderStage: L.maxStorageTexturesPerShaderStage,
  maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
});

const wanted = ['float32-filterable', 'timestamp-query', 'texture-formats-tier1', 'texture-formats-tier2', 'shader-f16'];
const requiredFeatures = wanted.filter((f) => adapter.features.has(f)) as GPUFeatureName[];
const device = await adapter.requestDevice({
  requiredFeatures,
  requiredLimits: {
    maxTextureDimension2D: L.maxTextureDimension2D,
    maxBufferSize: L.maxBufferSize,
    maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
    maxStorageTexturesPerShaderStage: L.maxStorageTexturesPerShaderStage,
  },
});
device.addEventListener('uncapturederror', (e) => console.error('GPU ERROR:', (e as GPUUncapturedErrorEvent).error.message));
console.log('device ok, wgsl features:', [...gpu.wgslLanguageFeatures].join(', '));

const noiseWgsl = /* wgsl */ `
@group(0) @binding(0) var dst: texture_storage_2d<r32float, write>;
struct P { size: vec2f, seed: f32, freq: f32 };
@group(0) @binding(1) var<uniform> p: P;

fn hash2(q: vec2f) -> vec2f {
  var x = vec2u(vec2i(floor(q))) + vec2u(u32(p.seed) * 7919u);
  x = (x ^ (x.yx >> vec2u(16u))) * vec2u(0x45d9f3bu);
  x = (x ^ (x.yx >> vec2u(15u))) * vec2u(0x846ca68bu);
  x = x ^ (x.yx >> vec2u(16u));
  let a = f32(x.x ^ (x.y * 1664525u)) * (6.2831853 / 4294967296.0);
  return vec2f(cos(a), sin(a));
}
fn gnoise(q: vec2f) -> f32 {
  let i = floor(q); let f = fract(q);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(hash2(i), f);
  let b = dot(hash2(i + vec2f(1, 0)), f - vec2f(1, 0));
  let c = dot(hash2(i + vec2f(0, 1)), f - vec2f(0, 1));
  let d = dot(hash2(i + vec2f(1, 1)), f - vec2f(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= p.size.x || f32(id.y) >= p.size.y) { return; }
  var uv = (vec2f(id.xy) + 0.5) / p.size * p.freq;
  var amp = 0.5; var sum = 0.0;
  for (var o = 0; o < 10; o++) {
    sum += amp * (1.0 - abs(gnoise(uv)));
    uv = mat2x2f(1.6, 1.2, -1.2, 1.6) * uv; amp *= 0.5;
  }
  textureStore(dst, id.xy, vec4f(sum, 0, 0, 1));
}`;

// read_write r32float in-place pass + rgba32float write, to confirm format support.
const rwWgsl = /* wgsl */ `
@group(0) @binding(0) var h: texture_storage_2d<r32float, read_write>;
@group(0) @binding(1) var aux: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dim = textureDimensions(h);
  if (id.x >= dim.x || id.y >= dim.y) { return; }
  let v = textureLoad(h, id.xy).r;
  textureStore(h, id.xy, vec4f(v * v, 0, 0, 1));
  textureStore(aux, id.xy, vec4f(v, 1.0 - v, 0.5, 1));
}`;

const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
const tex = device.createTexture({ size: [size, size], format: 'r32float', usage });
const aux = device.createTexture({ size: [size, size], format: 'rgba32float', usage });
const ubo = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(ubo, 0, new Float32Array([size, size, 3, 5]));

let t0 = performance.now();
const p1 = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: noiseWgsl }), entryPoint: 'main' } });
const p2 = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: rwWgsl }), entryPoint: 'main' } });
console.log('pipelines compiled in', (performance.now() - t0).toFixed(1), 'ms');

t0 = performance.now();
const enc = device.createCommandEncoder();
{
  const pass = enc.beginComputePass();
  pass.setPipeline(p1);
  pass.setBindGroup(0, device.createBindGroup({ layout: p1.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: { buffer: ubo } }] }));
  pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
  pass.setPipeline(p2);
  pass.setBindGroup(0, device.createBindGroup({ layout: p2.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: aux.createView() }] }));
  pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
  pass.end();
}
const bytesPerRow = Math.ceil((size * 4) / 256) * 256;
const rb = device.createBuffer({ size: bytesPerRow * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
enc.copyTextureToBuffer({ texture: tex }, { buffer: rb, bytesPerRow }, [size, size]);
device.queue.submit([enc.finish()]);
await device.queue.onSubmittedWorkDone();
console.log('compute done in', (performance.now() - t0).toFixed(1), 'ms');
t0 = performance.now();
await rb.mapAsync(GPUMapMode.READ);
const raw = new Float32Array(rb.getMappedRange());
const stride = bytesPerRow / 4;
let lo = Infinity, hi = -Infinity;
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const v = raw[y * stride + x]; if (v < lo) lo = v; if (v > hi) hi = v; }
console.log('readback in', (performance.now() - t0).toFixed(1), 'ms  range', lo.toFixed(4), hi.toFixed(4));

// 16-bit grayscale PNG (big-endian samples, filter 0).
const row = 1 + size * 2;
const img = Buffer.alloc(row * size);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const v = Math.round(((raw[y * stride + x] - lo) / (hi - lo)) * 65535);
    img.writeUInt16BE(v, y * row + 1 + x * 2);
  }
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 16; ihdr[9] = 0;
mkdirSync('test-output', { recursive: true });
writeFileSync('test-output/spike.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(img, { level: 3 })), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote test-output/spike.png');
rb.unmap();
device.destroy();
