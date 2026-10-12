// The GPU layer assembled without an evaluator, for the tests of this folder: a device, a stream, a pool, the
// pipeline cache, the default textures and the readback, wired as createEngine wires them, with the field
// handles and the RunEnv a node invocation would supply. Not a test file.

import { after } from 'node:test';

import type { AnyRunBindings, Lut, RunBindings } from '../../../src/core/gpu/bindings.ts';
import { createDefaultTextures, type DefaultTextures } from '../../../src/core/gpu/defaults.ts';
import type { GpuContext, GpuProfile } from '../../../src/core/gpu/device.ts';
import type { Field, FieldKind, Rgba } from '../../../src/core/gpu/field.ts';
import { CHANNELS } from '../../../src/core/gpu/field.ts';
import { mixSeed } from '../../../src/core/gpu/hash.ts';
import type { AnyKernel, Kernel } from '../../../src/core/gpu/kernel.ts';
import { createLutBuffer } from '../../../src/core/gpu/lut.ts';
import { createPipelineCache, type PipelineCache } from '../../../src/core/gpu/pipelines.ts';
import { createPool, type ManagedPool, type PoolCacheHooks, type PoolOptions, type PoolTexture } from '../../../src/core/gpu/pool.ts';
import { createReadback, type Readback } from '../../../src/core/gpu/readback.ts';
import { encodeRun, type RunEnv } from '../../../src/core/gpu/run.ts';
import {
  createStream, type CommandStream, type OwnerOptions, type SliceReport, type StreamHooks, type StreamOwner,
} from '../../../src/core/gpu/stream.ts';
import { createNodeGpu } from '../../../src/platform/node/gpu.ts';

export const TERRAIN_SIZE = 4096;
export const HEIGHT_RANGE = 1024;
export const SEED = mixSeed(1, 0);

let context: Promise<GpuContext> | null = null;
const live = new Set<Rig>();

/** The process's device: profile `core` unless OROGEN_GPU_PROFILE says otherwise, as the harness chooses it (testing.md 2.1). */
export function testGpu(): Promise<GpuContext> {
  context ??= createNodeGpu({ profile: (process.env.OROGEN_GPU_PROFILE as GpuProfile | undefined) || 'core' });
  return context;
}

after(async () => {
  for (const rig of [...live]) rig.dispose();
  if (context) (await context).destroy();
});

export interface RigOptions {
  readonly hooks?: StreamHooks & NonNullable<PoolOptions['hooks']>;
  readonly budgetBytes?: number;
  readonly cache?: PoolCacheHooks;
  readonly stripBytes?: number;
  readonly onOverrun?: (slice: SliceReport) => void;
}

export interface RunOverrides {
  readonly nodeId?: string;
  readonly nodeType?: string;
  readonly seed?: number;
  readonly iteration?: number;
  readonly terrainSize?: number;
  readonly heightRange?: number;
  readonly listed?: boolean;
}

export interface Rig {
  readonly gpu: GpuContext;
  readonly stream: CommandStream;
  readonly pool: ManagedPool;
  readonly pipelines: PipelineCache;
  readonly defaults: DefaultTextures;
  readonly readback: Readback;
  /** Every slice that has completed, in order. */
  readonly slices: SliceReport[];
  /** The owner the rig opened and made current. */
  readonly owner: StreamOwner;

  compile(...kernels: readonly AnyKernel[]): Promise<void>;
  /** Opens an owner and makes it current. */
  use(opts?: Partial<OwnerOptions>): StreamOwner;
  /** A writable field on a WORKING texture; `fill` clears it, or uploads it when it is an array. */
  field<K extends FieldKind>(kind: K, size?: number | readonly [number, number], fill?: number | Rgba | Float32Array): Field<K>;
  /** The same field as a read-only handle, as a node sees an input. */
  readOnly<K extends FieldKind>(field: Field<K>): Field<K>;
  release(field: Field): void;
  texture(field: Field): PoolTexture;
  lut<T extends 'f32' | 'vec4f'>(data: Float32Array, type: T): Lut<T>;
  run<KI, KO, KW, KU, KP, KL>(kernel: Kernel<KI, KO, KW, KU, KP, KL>, bindings: NoInfer<RunBindings<KI, KO, KW, KU, KP, KL>>, env?: RunOverrides): void;
  /** encodeRun with bindings the types would reject, for the run-time checks. */
  runUntyped(kernel: AnyKernel, bindings: unknown, env?: RunOverrides): void;
  read(field: Field, rows?: readonly [number, number]): Promise<Float32Array<ArrayBuffer>>;
  write(field: Field, data: Float32Array, rows?: readonly [number, number]): void;
  dispose(): void;
}

export async function createRig(opts: RigOptions = {}): Promise<Rig> {
  const gpu = await testGpu();
  const slices: SliceReport[] = [];
  const late: { pool?: ManagedPool } = {};
  const reserve = (bytes: number, label: string): { release(): void } => late.pool!.reserve(bytes, label);
  const stream = createStream({
    gpu, reserve, onOverrun: opts.onOverrun,
    hooks: { ...opts.hooks, onSlice: (s) => { slices.push(s); opts.hooks?.onSlice?.(s); } },
  });
  const cache: PoolCacheHooks = opts.cache ?? { evictOne: () => false, cacheReferences: () => 0 };
  const pool = createPool({ gpu, budgetBytes: opts.budgetBytes ?? 1_073_741_824, stream, cache, hooks: opts.hooks });
  late.pool = pool;
  const pipelines = createPipelineCache(gpu);
  const defaults = createDefaultTextures(gpu, reserve);
  const readback = createReadback({ gpu, stream, reserve, stripBytes: opts.stripBytes });

  const textures = new Map<number, PoolTexture>();
  const luts = new Map<Lut, GPUBuffer>();
  let nextId = 1;
  let disposed = false;

  const use = (o: Partial<OwnerOptions> = {}): StreamOwner => {
    const owner = stream.open({ nodeId: o.service ? null : 'n1', service: null, mode: 'preview', ...o });
    stream.use(owner);
    return owner;
  };
  const owner = use();

  const textureOf = (field: Field): PoolTexture => {
    const texture = textures.get(field.id);
    if (!texture) throw new Error(`field #${field.id} is not held by the rig`);
    return texture;
  };
  const env = (o: RunOverrides = {}): RunEnv => ({
    nodeId: o.nodeId ?? 'n1',
    nodeType: o.nodeType ?? 'test/node',
    listed: () => o.listed ?? true,
    released: (field) => !textures.has(field.id),
    ownsLut: (lut) => luts.has(lut),
    terrainSize: o.terrainSize ?? TERRAIN_SIZE,
    heightRange: o.heightRange ?? HEIGHT_RANGE,
    seed: o.seed ?? SEED,
    iteration: o.iteration ?? 0,
    texture: textureOf,
    lutBuffer: (lut) => luts.get(lut)!,
  });

  const rig: Rig = {
    gpu, stream, pool, pipelines, defaults, readback, slices, owner,
    async compile(...kernels) {
      await Promise.all(kernels.map((kernel) => pipelines.compile(kernel)));
    },
    use,
    field(kind, size = 64, fill) {
      const [width, height] = typeof size === 'number' ? [size, size] : size;
      const texture = pool.acquire(kind, width, height);
      const field: Field<typeof kind> = { kind, width, height, readOnly: false, id: nextId++ };
      textures.set(field.id, texture);
      if (fill instanceof Float32Array) stream.write(texture, fill, [0, height]);
      else if (fill !== undefined) stream.clear(texture, typeof fill === 'number' ? [fill, fill, fill, fill] : fill);
      return field;
    },
    readOnly(field) {
      const view: Field<typeof field.kind> = { ...field, readOnly: true, id: nextId++ };
      textures.set(view.id, textureOf(field));
      return view;
    },
    release(field) {
      pool.release(textureOf(field));
      textures.delete(field.id);
    },
    texture: textureOf,
    lut(data, type) {
      const made = createLutBuffer(gpu.device, data, type);
      stream.track(made.scopes);
      const lut: Lut<typeof type> = { type, length: type === 'vec4f' ? data.length / 4 : data.length };
      luts.set(lut, made.buffer);
      return lut;
    },
    run(kernel, bindings, o) {
      encodeRun({ stream, pipelines, defaults }, kernel, bindings as AnyRunBindings, env(o));
    },
    runUntyped(kernel, bindings, o) {
      encodeRun({ stream, pipelines, defaults }, kernel, bindings as AnyRunBindings, env(o));
    },
    read(field, rows) {
      return readback.read(textureOf(field), rows);
    },
    write(field, data, rows) {
      stream.write(textureOf(field), data, rows ?? [0, field.height]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      live.delete(rig);
      for (const buffer of luts.values()) buffer.destroy();
      readback.dispose();
      defaults.dispose();
      pool.dispose();
      stream.dispose();
    },
  };
  live.add(rig);
  return rig;
}

/** Floats per texel of a field. */
export const channels = (field: Field): number => CHANNELS[field.kind];

/** Compares two readbacks bit for bit; returns the index of the first difference, or -1. */
export function firstDifference(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i;
  return -1;
}

/** Row-major texel data: `value(x, y)` gives one number, or one array of the texel's channels. */
export function texels(width: number, height: number, value: (x: number, y: number) => number | readonly number[]): Float32Array {
  const first = value(0, 0);
  const count = typeof first === 'number' ? 1 : first.length;
  const out = new Float32Array(width * height * count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = value(x, y);
      if (typeof v === 'number') out[y * width + x] = v;
      else out.set(v, (y * width + x) * count);
    }
  }
  return out;
}

/** The texel (x, y) of a readback of `width` texels per row with `count` channels. */
export function texel(data: Float32Array, width: number, x: number, y: number, count = 1): number[] {
  return [...data.subarray((y * width + x) * count, (y * width + x + 1) * count)];
}

/** Largest absolute difference between two arrays of equal length. */
export function maxDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (!(d <= worst)) worst = d;
  }
  return worst;
}
