import type { CpuRunner } from './cpu/runner.ts';
import { createCache } from './eval/cache.ts';
import type { FieldStats } from './eval/context.ts';
import { convertKernels } from './eval/convert.ts';
import { createEvaluator, type EvalTarget, type EvaluateOptions, type EvaluateResult } from './eval/evaluator.ts';
import { poolTextureOf } from './eval/handles.ts';
import type { EngineTestHooks } from './eval/hooks.ts';
import type { EngineParts } from './eval/parts.ts';
import { fieldStats, statsKernels } from './eval/stats.ts';
import { createThumbnails, thumbnailKernels, type Thumbnail } from './eval/thumbnails.ts';
import { createDefaultTextures } from './gpu/defaults.ts';
import { deviceLostError, type GpuContext } from './gpu/device.ts';
import { FieldAccessError } from './gpu/errors.ts';
import type { AnyKernel } from './gpu/kernel.ts';
import { createPipelineCache } from './gpu/pipelines.ts';
import { createPool, type FieldHandle, type ManagedPool, type MemoryReport } from './gpu/pool.ts';
import { createReadback } from './gpu/readback.ts';
import { sealDefinitions } from './gpu/seal.ts';
import { createStream, type SliceService } from './gpu/stream.ts';
import type { GraphDoc } from './graph/doc.ts';
import type { NodeRegistry } from './graph/registry.ts';
import type { FileSource } from './io/files.ts';
import { opsKernels } from './ops/kernels.ts';

export interface EngineOptions {
  readonly gpu: GpuContext;
  readonly registry: NodeRegistry;
  readonly files: FileSource;            // 6.1
  readonly cpu: CpuRunner;               // 6.3
  readonly budgetBytes: number;          // 2.4
  readonly test?: EngineTestHooks;       // 5.14
}

export interface Engine {
  readonly gpu: GpuContext;
  readonly epoch: number;                // starts at 1; +1 on every replaceDevice
  readonly registry: NodeRegistry;       // the registry of EngineOptions

  evaluate(doc: GraphDoc, targets: readonly EvalTarget[], opts: EvaluateOptions): Promise<EvaluateResult>;   // 5.2
  /** Node id → content key (5.4), for every node that has one. No GPU work. */
  keys(doc: GraphDoc): Promise<ReadonlyMap<string, string>>;

  /** As ctx.read (engine.md 4.7), for published content. */
  read(field: FieldHandle, rows?: readonly [y0: number, y1: number]): Promise<Float32Array<ArrayBuffer>>;
  /** As ctx.stats. */
  stats(field: FieldHandle<'field'>): Promise<FieldStats>;
  /** Registers GPU memory that is not a pool texture with the ledger (2.4): the viewport renderer's, for one. */
  reserve(bytes: number, label: string): { release(): void };

  /** The last measured duration of a node's evaluate() in this session, by node id. */
  lastTiming(nodeId: string): { readonly resolution: number; readonly wallMs: number } | null;
  onThumbnail(listener: (t: Thumbnail) => void): () => void;     // 5.12
  /** A slice was measured above the hard ceiling (3.5). Returns the function that removes the listener. */
  onOverrun(listener: (slice: SliceOverrun) => void): () => void;

  memory(): MemoryReport;
  trim(opts?: { keepResolution?: number }): Promise<void>;       // 2.8
  setBudget(bytes: number): void;
  setFiles(files: FileSource): void;
  replaceDevice(gpu: GpuContext): Promise<void>;                 // 5.9
  dispose(): Promise<void>;
}

/** A slice measured above the hard ceiling (3.5): whose it was, its kernels, and what it measured. */
export interface SliceOverrun {
  readonly nodeId: string | null;        // exactly one of nodeId and service is not null (5.14)
  readonly service: string | null;
  readonly kernels: readonly string[];
  readonly measuredMs: number;
  readonly ceilingMs: number;
}

/** What lives on one device. */
type DeviceParts = Omit<EngineParts, 'files'>;

/**
 * Resolves when the engine's own kernels are compiled; rejects when one fails.
 * The first call seals defineLib, defineKernel, defineCpuTask and defineNode (engine.md, Module scope).
 */
export async function createEngine(opts: EngineOptions): Promise<Engine> {
  sealDefinitions();
  const { registry, cpu } = opts;
  if (!Number.isFinite(opts.budgetBytes) || opts.budgetBytes < 0) throw new RangeError(`createEngine: budgetBytes is ${String(opts.budgetBytes)}; it is a byte count`);
  const hooks = opts.test ?? {};
  const own: readonly AnyKernel[] = [...convertKernels(), ...statsKernels(), ...thumbnailKernels(), ...opsKernels()];
  const ownSet = new Set<AnyKernel>(own);

  let budgetBytes = opts.budgetBytes;
  const overrunListeners = new Set<(slice: SliceOverrun) => void>();
  let files = opts.files;
  let epoch = 1;
  let disposed = false;
  let device!: DeviceParts;
  let parts!: EngineParts;

  // The cache outlives a device; it reaches the pool of the day through this.
  const cache = createCache({
    retain: (texture) => device.pool.retain(texture),
    drop: (texture) => device.pool.drop(texture),
    references: (texture) => device.pool.references(texture),
  });

  /** One device's worth of engine, in the order the factories allow. `first` is false for a replacement device. */
  function assemble(gpu: GpuContext, first: boolean): DeviceParts {
    // The stream's ledger is the pool, and the pool needs the stream: the ledger is bound late.
    const late: { pool?: ManagedPool } = {};
    const reserve = (bytes: number, label: string): { release(): void } => late.pool!.reserve(bytes, label);
    const stream = createStream({
      gpu, reserve, hooks,
      // No node's error (3.5): told to whoever listens, and to the log when nobody does.
      onOverrun: (slice, ceilingMs) => {
        const overrun: SliceOverrun = { nodeId: slice.nodeId, service: slice.service, kernels: slice.kernels, measuredMs: slice.measuredMs, ceilingMs };
        if (overrunListeners.size === 0) {
          console.warn(`[orogen] a slice of ${slice.nodeId ?? slice.service} took ${slice.measuredMs.toFixed(0)} ms, above the hard ceiling (kernels: ${slice.kernels.join(', ')})`);
        }
        for (const listener of [...overrunListeners]) {
          try {
            listener(overrun);
          } catch (thrown) {
            console.error('[orogen] an overrun listener threw', thrown);
          }
        }
      },
    });
    // failAllocAfter counts from the creation of the engine and fires once (5.14): not again on a replacement device.
    const poolHooks = { ...(hooks.poisonRecycled ? { poisonRecycled: true } : {}), ...(first && hooks.failAllocAfter ? { failAllocAfter: hooks.failAllocAfter } : {}) };
    const pool = createPool({ gpu, budgetBytes, stream, cache, hooks: poolHooks });
    late.pool = pool;
    return {
      gpu, epoch, pool, stream, cpu,
      pipelines: createPipelineCache(gpu),
      defaults: createDefaultTextures(gpu, reserve),
      readback: createReadback({ gpu, stream, reserve }),
      device: { retired: false },
      isEngineKernel: (kernel) => ownSet.has(kernel),
    };
  }

  /** Destroys what lives on a device that is still there. A lost device is forgotten, not called (5.9 rule 3). */
  function destroy(d: DeviceParts): void {
    const alive = !d.gpu.lost;
    d.device.retired = true;
    if (!alive) return;
    d.readback.dispose();
    d.defaults.dispose();
    d.pool.dispose();
    d.stream.dispose();
  }

  device = assemble(opts.gpu, true);
  parts = { ...device, files };
  const thumbnails = createThumbnails(() => parts);

  async function compileOwn(): Promise<void> {
    try {
      await Promise.all([...own.map((kernel) => parts.pipelines.compile(kernel)), thumbnails.prepare()]);
    } catch (thrown) {
      if (parts.gpu.lost) throw deviceLostError(parts.gpu);
      throw thrown;
    }
  }

  /** 5.9 rule 3: everything that lived on the lost device is forgotten, without calling into it. */
  function forget(): void {
    if (parts.device.retired) return;
    parts.device.retired = true;
    cache.forget();
    thumbnails.forget();
  }

  const evaluator = createEvaluator({ registry, parts: () => parts, cache, thumbnails, onDeviceLost: forget });
  /** For gpu.onLost. An evaluation that was running has forgotten the device itself, and knows which node it was at. */
  const lost = (): void => void evaluator.exclusive(() => {
    if (parts.device.retired) return;
    evaluator.lostWhileIdle();
    forget();
  });
  let unsubscribe = opts.gpu.onLost(lost);

  try {
    await compileOwn();
  } catch (thrown) {
    unsubscribe();
    thumbnails.dispose();
    destroy(device);
    throw thrown;
  }

  const open = (): void => {
    if (disposed) throw new Error('The engine is disposed');
  };
  /** For the calls that need the device. */
  const live = (): EngineParts => {
    open();
    if (parts.gpu.lost || parts.device.retired) throw deviceLostError(parts.gpu);
    return parts;
  };

  /**
   * The service calls that have not settled. They run outside the evaluations' turn (5.1), with a texture of
   * the pool or the staging buffer in use: whoever takes the device away waits for them first.
   */
  const serving = new Set<Promise<void>>();
  async function served(): Promise<void> {
    while (serving.size > 0) await Promise.all([...serving]);
  }

  /** One engine service call that waits: its own owner, made current before anything is encoded. */
  function service<T>(name: SliceService, work: (p: EngineParts) => Promise<T>): Promise<T> {
    const call = (async (): Promise<T> => {
      const p = live();
      const owner = p.stream.open({ nodeId: null, service: name, mode: 'preview' });
      try {
        p.stream.use(owner);
        const value = await work(p);
        await owner.settle();
        return value;
      } catch (thrown) {
        // Whatever the call met on a device that was lost meanwhile, the loss is what happened to it.
        if (p.gpu.lost) throw deviceLostError(p.gpu);
        throw thrown;
      } finally {
        owner.close();
      }
    })();
    const settled: Promise<void> = call.then(() => undefined, () => undefined).then(() => void serving.delete(settled));
    serving.add(settled);
    return call;
  }

  const engine: Engine = {
    get gpu() { return parts.gpu; },
    get epoch() { return epoch; },
    registry,

    evaluate(doc, targets, evalOpts) {
      if (disposed) return Promise.reject(new Error('The engine is disposed'));
      return evaluator.evaluate(doc, targets, evalOpts);
    },

    keys(doc) {
      if (disposed) return Promise.reject(new Error('The engine is disposed'));
      return evaluator.keys(doc);
    },

    async read(field, rows) {
      live();
      const texture = poolTextureOf(field);
      return service('read', (p) => p.readback.read(texture, rows));
    },

    async stats(field) {
      live();
      const texture = poolTextureOf(field);
      if (field.kind !== 'field') throw new FieldAccessError(`Engine.stats: the handle is a "${String(field.kind)}"; statistics need a field`);
      return service('stats', (p) => fieldStats(p, texture));
    },

    reserve(bytes, label) {
      return live().pool.reserve(bytes, label);
    },

    lastTiming(nodeId) {
      return evaluator.lastTiming(nodeId);
    },

    onThumbnail(listener) {
      return thumbnails.onThumbnail(listener);
    },

    onOverrun(listener) {
      overrunListeners.add(listener);
      return () => void overrunListeners.delete(listener);
    },

    memory() {
      open();
      // 5.9 rule 3: the ledger of a lost device is forgotten, and all byte counts are zero.
      if (parts.gpu.lost || parts.device.retired) {
        return { budgetBytes, workingBytes: 0, cacheBytes: 0, pinnedBytes: 0, freeBytes: 0, reservedBytes: 0, drainingBytes: 0 };
      }
      return parts.pool.report();
    },

    trim(trimOpts) {
      open();
      return evaluator.exclusive(async () => {
        const p = live();
        cache.evictExcept(trimOpts?.keepResolution);
        await p.pool.trim(trimOpts);
      });
    },

    setBudget(bytes) {
      open();
      if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`Engine.setBudget: ${bytes} is not a byte count`);
      const shrank = bytes < budgetBytes;
      budgetBytes = bytes;
      if (parts.device.retired) return;
      parts.pool.setBudget(bytes);
      // 5.12 rule 4: an atlas that no longer fits is given back. In the evaluations' turn: at once when none
      // runs or waits, else when what was asked before has settled; the stream is not touched under a running node.
      if (shrank) {
        void evaluator.exclusive(() => {
          if (!disposed && !parts.device.retired && !parts.gpu.lost) thumbnails.fit();
        }).catch((thrown: unknown) => console.error('[orogen] the thumbnail atlas could not be given back', thrown));
      }
    },

    setFiles(next) {
      open();
      void evaluator.exclusive(() => {
        files = next;
        parts = { ...device, files };
      });
    },

    replaceDevice(gpu) {
      open();
      return evaluator.exclusive(async () => {
        open();
        // A read or statistics under way ends on the device it began on: it rejects when that device is lost.
        await served();
        open();
        const old = device;
        unsubscribe();
        // What the old device held is dead: a lost one is forgotten, one that still works is emptied.
        cache.forget();
        if (old.gpu.lost) thumbnails.forget();
        else thumbnails.dispose();
        destroy(old);
        epoch++;
        device = assemble(gpu, false);
        parts = { ...device, files };
        unsubscribe = gpu.onLost(lost);
        await compileOwn();
      });
    },

    dispose() {
      if (disposed) return evaluator.idle();
      return evaluator.exclusive(async () => {
        if (disposed) return;
        // From here on no call begins. Thumbnails being read back are delivered first, and reads and statistics
        // under way end: both are bounded by the work already submitted.
        disposed = true;
        await thumbnails.idle();
        await served();
        unsubscribe();
        cache.forget();
        thumbnails.dispose();
        destroy(device);
        await cpu.dispose();
      });
    },
  };
  return engine;
}
