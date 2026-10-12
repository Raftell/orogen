import { deviceLostError, type GpuContext } from './device.ts';
import { CHANNELS, type Rgba } from './field.ts';
import { createGroup0Layout, type CompiledKernel } from './pipelines.ts';
import type { PoolTexture } from './pool.ts';
import { guarded, type ScopeResult } from './scopes.ts';
import { kernelShape } from './shape.ts';
import { packTexels, TEXEL_ENCODING } from './texels.ts';
import { nextRate, rowsPerTile } from './throughput.ts';
import { HARD_CEILING_MS, LATENCY_REMEASURE_MS, RATE_INITIAL, SLICE_TARGET_BUILD_MS, SLICE_TARGET_PREVIEW_MS } from './tuning.ts';
import { UNIFORM_SLOT_BYTES, writeFrame, writeParams, type FrameValues } from './uniforms.ts';

/** The engine services that own slices when no node does (runtime.md 5.14). */
export type SliceService = 'convert' | 'mask' | 'constant' | 'thumbnail' | 'stats' | 'read';

/** What EngineTestHooks.onSlice receives (runtime.md 5.14). */
export interface SliceReport {
  readonly nodeId: string | null;
  readonly service: string | null;
  readonly kernels: readonly string[];
  readonly work: number;
  readonly estimateMs: number;
  readonly measuredMs: number;
}

/** The members of EngineTestHooks the stream obeys. */
export interface StreamHooks {
  readonly sliceTargetMs?: number;
  readonly inFlightLimit?: 1 | 2;
  readonly maxTileRows?: number;
  readonly onSlice?: (s: SliceReport) => void;
}

export interface StreamOptions {
  readonly gpu: GpuContext;
  /** The ledger (runtime.md 2.4), for the uniform arena. */
  readonly reserve: (bytes: number, label: string) => { release(): void };
  readonly hooks?: StreamHooks;
  /** A slice was measured above the hard ceiling (3.5). */
  readonly onOverrun?: (slice: SliceReport) => void;
}

/** One node invocation or one engine service call: the owner of slices, bind groups and error scopes (3.1, 5.8). */
export interface OwnerOptions {
  /** Exactly one of nodeId and service is not null. */
  readonly nodeId: string | null;
  readonly service: SliceService | null;
  /** Selects the slice target (3.5). */
  readonly mode: 'preview' | 'build';
  /** Checked before every submit and when a wait ends (3.7). */
  readonly signal?: AbortSignal;
  /** Scales the slice target and the hard ceiling for this owner: 0.5 after a device loss (5.9 rule 6). Default 1. */
  readonly limitScale?: number;
}

export interface OwnerResult {
  /**
   * Sum of the measured GPU time of the owner's slices; null without timestamp-query (5.10 rule 4). An owner
   * with more than sixteen slices in flight at once had the excess submitted untimed, and the sum is without them.
   */
  readonly gpuMs: number | null;
  /** Slices of the owner that have completed. */
  readonly slices: number;
}

/** A validation error captured in a scope of an owner (5.8 rule 4). The message is the first line of the GPU message. */
export class GpuValidationError extends Error {
  override name = 'GpuValidationError';
  /** The full GPU message. */
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.detail = detail;
  }
}

/** A scope of an owner reported out of memory (5.8, Memory). It takes precedence over the owner's validation errors. */
export class GpuOutOfMemoryError extends Error {
  override name = 'GpuOutOfMemoryError';
}

export interface StreamOwner {
  readonly nodeId: string | null;
  readonly service: SliceService | null;
  /**
   * Step 2 of 5.5: submits the open slice when it is this owner's, then resolves when every slice of the owner
   * has completed and every scope tracked for it has reported. Rejects with GpuOutOfMemoryError or
   * GpuValidationError when a scope reported one, with the abort reason, or with DeviceLostError.
   */
  settle(): Promise<OwnerResult>;
  /** Ends the owner: discards its unsubmitted work and drops its bind groups (3.1 rule 3). Idempotent; never waits. */
  close(): void;
}

export interface RunRequest {
  readonly kernel: CompiledKernel;
  /** The group-1 resources in binding order. Their identities key the bind-group cache (3.1 rule 3). */
  readonly resources: readonly (GPUTextureView | GPUBuffer)[];
  /** `res` is the size of the written grid; the stream supplies tileOrigin per tile (3.4). */
  readonly frame: Omit<FrameValues, 'tileOrigin'>;
  /** Checked values of the kernel's params; null when it declares none. */
  readonly params: Readonly<Record<string, number | boolean | readonly number[]>> | null;
  /** Texture loads per texel of this run (engine.md 3.15 rule 4). */
  readonly cost: number;
}

/** Thrown by run() for a kernel declared `tiled: false` whose one dispatch is estimated above the hard ceiling (3.4 rule 3). */
export class WatchdogError extends Error {
  override name = 'WatchdogError';
}

/**
 * The one command encoder of the engine (runtime.md section 3). Everything encoded, tracked or waited for
 * belongs to the current owner: a caller makes its owner current with use() at the start of every synchronous
 * section and again after every await.
 */
export interface CommandStream {
  /** 3.6. */
  readonly inFlightLimit: 1 | 2;
  /** Slices submitted so far. ctx.loop compares two readings to learn whether a batch boundary is due (3.6). */
  readonly submitted: number;
  /** The owner made current by the last use(); null before the first and after that owner's close(). */
  readonly current: StreamOwner | null;

  open(opts: OwnerOptions): StreamOwner;
  /** Makes `owner` current. A change of owner submits the open slice (3.1). */
  use(owner: StreamOwner): void;

  /** Encodes one run as one dispatch per tile, with its Params slot and one Frame slot per tile (3.2, 3.4). Never waits. */
  run(run: RunRequest): void;
  /** A render pass with loadOp 'clear'. `value` gives all four channels. */
  clear(texture: PoolTexture, value: Rgba): void;
  /** A whole-texture copy between two textures of one shape. */
  copy(src: PoolTexture, dst: PoolTexture): void;
  /** Work that is not a kernel run: copies to the staging buffer, the thumbnail passes. Ends the open compute pass. */
  encode(work: (encoder: GPUCommandEncoder) => void, estimateMs?: number): void;
  /** ctx.write: submits the open slice, then writes rows [y0, y1) on the queue (3.1). `data` is in the layout of ctx.read. */
  write(texture: PoolTexture, data: Float32Array, rows: readonly [y0: number, y1: number]): void;
  /** Records the pops of a guarded call against the current owner (5.8 rule 3). */
  track(scopes: ScopeResult): void;

  /** Closes and submits the open slice; discards it when the owner's signal has aborted or the device is lost (3.7). */
  submit(): void;
  /** Submits, then resolves when every submitted slice has completed (3.6). Rejects with the abort reason or DeviceLostError. */
  flush(): Promise<void>;
  /**
   * A ctx.loop batch boundary (3.6): submits, then resolves when fewer than inFlightLimit slices are unfinished,
   * or, with `last`, when all have completed. Rejects as flush() does, and as StreamOwner.settle() does for the
   * scopes of the current owner that have reported.
   */
  boundary(last: boolean): Promise<void>;
  /** An empty submission (2.6 rule 3). Resolves when it has completed; also refreshes the completion latency (3.5). */
  barrier(): Promise<void>;

  /** Destroys the arena and the query resources. Not called for a lost device. */
  dispose(): void;
}

/** runtime.md 3.2 rule 1. */
const ARENA_BYTES = 1 << 20;
/**
 * Timestamps of one slice: the beginning of its first compute pass and the end of every pass, in a query set
 * of the largest size WebGPU allows. Passes beyond these are not timed; a slice cannot hold more runs than
 * the arena has slots, so that is at most its last pass.
 */
const TIMING_QUERIES = 4096;
const TIMED_PASSES = TIMING_QUERIES - 1;
/**
 * The most query sets the stream makes. A slice holds one from its first compute pass until its timestamps
 * are read back: three are in use with two slices in flight. A node that submits slices without waiting
 * (3.6 rule 4) holds one per slice; beyond this many its slices are not timed, and its gpuMs leaves them out.
 */
const TIMING_SLOTS = 16;

interface TimingSlot {
  readonly querySet: GPUQuerySet;
  readonly resolve: GPUBuffer;
  readonly read: GPUBuffer;
  readonly reservation: { release(): void };
}

interface Owner extends StreamOwner {
  readonly signal: AbortSignal | undefined;
  /** Slice target and hard ceiling of this owner, in milliseconds. */
  readonly target: number;
  readonly ceiling: number;
  readonly bindGroups: Map<string, GPUBindGroup>;
  /** Scope pops that have not reported and slices that have not finished. */
  readonly outstanding: Set<Promise<void>>;
  /** Scope pops alone. */
  readonly scopes: Set<Promise<void>>;
  outOfMemory: GPUError | null;
  validation: GPUError | null;
  gpuMs: number;
  slices: number;
  closed: boolean;
}

interface Slice {
  readonly owner: Owner;
  readonly encoder: GPUCommandEncoder;
  pass: GPUComputePassEncoder | null;
  /** What the open pass has set, so that consecutive tiles and runs do not set it again. */
  pipeline: GPUComputePipeline | null;
  group1: GPUBindGroup | null;
  passes: number;
  timing: TimingSlot | null;
  estimateMs: number;
  work: number;
  /** Per kernel name, the work of its dispatches in this slice and what they were estimated at. */
  readonly kernels: Map<string, { work: number; estimateMs: number }>;
}

const none = (): null => null;
const firstLine = (text: string): string => text.split('\n')[0]!;

export function createStream(opts: StreamOptions): CommandStream {
  const { gpu } = opts;
  const device = gpu.device;
  const queue = device.queue;
  const hooks = opts.hooks ?? {};
  const timestamps = gpu.caps.timestampQuery;
  if (hooks.inFlightLimit === 2 && !timestamps) {
    throw new RangeError('inFlightLimit 2 requires the timestamp-query feature (runtime.md 3.6)');
  }
  const inFlightLimit: 1 | 2 = hooks.inFlightLimit ?? (timestamps ? 2 : 1);

  // ---- the uniform arena (3.2): made on first use, because the ledger may not exist when the stream is made ----
  const staging = new ArrayBuffer(ARENA_BYTES);
  const stagingView = new DataView(staging);
  let arena: { readonly buffer: GPUBuffer; readonly group0: GPUBindGroup; readonly reservation: { release(): void } } | null = null;
  let cursor = 0;

  let current: Owner | null = null;
  let slice: Slice | null = null;
  let submitted = 0;
  let disposed = false;

  // ---- completion ------------------------------------------------------------------------------------------------
  /** Slices whose onSubmittedWorkDone() has not resolved. */
  let unfinished = 0;
  let completionWaiters: (() => void)[] = [];
  /** Submitted slices whose measurement has not been processed. */
  const inFlight = new Set<Promise<void>>();
  /** When the last slice completed: a slice submitted behind another starts then, not when it was submitted. */
  let lastSliceDone = -Infinity;
  /** When a completion of any kind was last observed, for the idle rule of 3.5. */
  let lastActivity = -Infinity;
  let latency = 0;
  /** Settles when the slice submitted last has been learned from and reported: slices report in the order of their submission. */
  let lastReport: Promise<void> = Promise.resolve();
  /** What an onSlice hook threw; the next wait rethrows it, so that an assertion made in a hook fails its test. */
  let hookFailure: { readonly error: unknown } | null = null;

  const rates = new Map<string, number>();
  const freeTimingSlots: TimingSlot[] = [];
  const timingSlots: TimingSlot[] = [];
  const resourceIds = new WeakMap<object, number>();
  let nextResourceId = 1;

  function requireOwner(): Owner {
    if (!current) throw new Error('No stream owner is current: call use(owner) at the start of every synchronous section');
    return current;
  }

  function observe(owner: Owner, scopes: ScopeResult): void {
    const watch = (pop: Promise<GPUError | null>, record: (error: GPUError) => void): void => {
      const reported: Promise<void> = pop.then((error) => {
        if (error) record(error);
        owner.outstanding.delete(reported);
        owner.scopes.delete(reported);
      });
      owner.outstanding.add(reported);
      owner.scopes.add(reported);
    };
    watch(scopes.outOfMemory, (error) => { owner.outOfMemory ??= error; });
    watch(scopes.validation, (error) => { owner.validation ??= error; });
  }

  function ensureArena(): NonNullable<typeof arena> {
    if (!arena) {
      const made = guarded(device, () => {
        const buffer = device.createBuffer({ label: 'orogen uniform arena', size: ARENA_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const slot = { buffer, offset: 0, size: UNIFORM_SLOT_BYTES };
        const group0 = device.createBindGroup({
          label: 'orogen group 0',
          layout: createGroup0Layout(device),
          entries: [{ binding: 0, resource: slot }, { binding: 1, resource: slot }],
        });
        return { buffer, group0 };
      });
      if (current) observe(current, made.scopes);
      arena = { ...made.value, reservation: opts.reserve(ARENA_BYTES, 'uniform arena') };
    }
    return arena;
  }

  function takeTimingSlot(): TimingSlot | null {
    const free = freeTimingSlots.pop();
    if (free) return free;
    if (timingSlots.length >= TIMING_SLOTS) return null;
    const bytes = TIMING_QUERIES * 8;
    const made = guarded(device, () => ({
      querySet: device.createQuerySet({ label: 'orogen slice timing', type: 'timestamp', count: TIMING_QUERIES }),
      resolve: device.createBuffer({ label: 'orogen slice timing', size: bytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      read: device.createBuffer({ label: 'orogen slice timing', size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    }));
    if (current) observe(current, made.scopes);
    const slot: TimingSlot = { ...made.value, reservation: opts.reserve(bytes * 3, 'slice timing') };
    timingSlots.push(slot);
    return slot;
  }

  /** GPU milliseconds from the first compute pass's beginning to the last timed one's end; null when the slot cannot be read. */
  async function readTiming(slot: TimingSlot, timed: number): Promise<number | null> {
    const bytes = (timed + 1) * 8;
    // A stream disposed with slices in flight has destroyed the buffer; mapping it would raise an uncaptured error.
    if (disposed || gpu.lost) return null;
    try {
      await slot.read.mapAsync(GPUMapMode.READ, 0, bytes);
    } catch {
      return null;
    }
    if (disposed) return null;
    const stamps = new BigUint64Array(slot.read.getMappedRange(0, bytes).slice(0));
    slot.read.unmap();
    freeTimingSlots.push(slot);
    const begin = stamps[0]!;
    let end = stamps[1]!;
    for (let k = 2; k <= timed; k++) {
      if (stamps[k]! > end) end = stamps[k]!;
    }
    return end >= begin ? Number(end - begin) / 1e6 : null;
  }

  function openSlice(owner: Owner): Slice {
    slice ??= {
      owner, encoder: device.createCommandEncoder(), pass: null, pipeline: null, group1: null, passes: 0, timing: null,
      estimateMs: 0, work: 0, kernels: new Map(),
    };
    return slice;
  }

  function endPass(s: Slice): void {
    if (s.pass) {
      s.pass.end();
      s.pass = null;
      s.pipeline = null;
      s.group1 = null;
    }
  }

  /** The open compute pass of the open slice, begun when there is none. */
  function computePass(owner: Owner): { readonly s: Slice; readonly pass: GPUComputePassEncoder } {
    const s = openSlice(owner);
    if (!s.pass) {
      // A slice is timed from its first compute pass or not at all.
      if (timestamps && s.passes === 0) s.timing = takeTimingSlot();
      if (s.timing && s.passes < TIMED_PASSES) {
        const querySet = s.timing.querySet;
        s.pass = s.encoder.beginComputePass({
          timestampWrites: s.passes === 0 ? { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : { querySet, endOfPassWriteIndex: s.passes + 1 },
        });
      } else {
        s.pass = s.encoder.beginComputePass();
      }
      s.passes++;
    }
    return { s, pass: s.pass };
  }

  function bindGroup(owner: Owner, run: RunRequest): GPUBindGroup {
    let key = run.kernel.kernel.name;
    for (const resource of run.resources) {
      let id = resourceIds.get(resource);
      if (id === undefined) {
        id = nextResourceId++;
        resourceIds.set(resource, id);
      }
      key += `|${id}`;
    }
    let group = owner.bindGroups.get(key);
    if (!group) {
      const made = guarded(device, () => device.createBindGroup({
        label: run.kernel.kernel.name,
        layout: run.kernel.group1Layout,
        entries: run.resources.map((resource, binding) => ({
          binding,
          resource: run.kernel.module.group1[binding]!.role === 'lut' ? { buffer: resource as GPUBuffer } : (resource as GPUTextureView),
        })),
      }));
      observe(owner, made.scopes);
      group = made.value;
      owner.bindGroups.set(key, group);
    }
    return group;
  }

  /**
   * 3.3: the rate of every kernel of a completed slice follows the measurement. The factor applies to the rate
   * the slice was estimated with: with two slices in flight the second is estimated before the first completes,
   * and a factor applied to the current rate would correct one error twice.
   */
  function learn(s: Slice, dt: number, mayRaise: boolean): void {
    for (const [name, share] of s.kernels) {
      if (share.work > 0) rates.set(name, nextRate(share.estimateMs / share.work, s.estimateMs, dt, mayRaise, s.owner.ceiling));
    }
  }

  function completed(): void {
    lastSliceDone = lastActivity = performance.now();
    const waiters = completionWaiters;
    completionWaiters = [];
    for (const wake of waiters) wake();
  }

  /** An empty submission; its completion time is the latency with which completions are reported (3.5 rule 1). */
  function barrier(): Promise<void> {
    if (gpu.lost || disposed) return Promise.resolve();
    const idle = unfinished === 0;
    const start = performance.now();
    const made = guarded(device, () => queue.submit([device.createCommandEncoder().finish()]));
    if (current) observe(current, made.scopes);
    return queue.onSubmittedWorkDone().then(() => {
      lastActivity = performance.now();
      if (idle) latency = lastActivity - start;
    }, () => undefined);
  }

  function submit(): void {
    const s = slice;
    if (!s) return;
    slice = null;
    const usedBytes = cursor;
    cursor = 0;
    endPass(s);
    const owner = s.owner;
    // 3.7: a cancelled or dead slice is dropped; the encoder is never finished.
    if (gpu.lost || owner.closed || owner.signal?.aborted) {
      if (s.timing) freeTimingSlots.push(s.timing);
      return;
    }
    if (!timestamps && unfinished === 0 && performance.now() - lastActivity >= LATENCY_REMEASURE_MS) void barrier();

    const timing = s.timing;
    const timed = Math.min(s.passes, TIMED_PASSES);
    if (timing) {
      s.encoder.resolveQuerySet(timing.querySet, 0, timed + 1, timing.resolve, 0);
      s.encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 8 * (timed + 1));
    }
    const made = guarded(device, () => {
      if (usedBytes > 0) queue.writeBuffer(ensureArena().buffer, 0, staging, 0, usedBytes);
      queue.submit([s.encoder.finish()]);
    });
    observe(owner, made.scopes);
    submitted++;
    unfinished++;
    const submittedAt = performance.now();
    const previous = lastReport;

    const measure = async (): Promise<void> => {
      await queue.onSubmittedWorkDone().catch(none);
      const now = performance.now();
      const wall = now - Math.max(submittedAt, lastSliceDone);
      // 3.6: the scopes of a completed slice have reported before whoever waited for it goes on.
      await Promise.all([made.scopes.validation, made.scopes.outOfMemory]);
      unfinished--;
      completed();
      let measured: number | null = null;
      if (timing) {
        measured = await readTiming(timing, timed);
      }
      // A slice whose timestamps take longer to read back does not report after a later one.
      await previous;
      if (!gpu.lost && !disposed) {
        // 3.5: by wall clock a slice shorter than twice the completion latency is not resolved. Its wall time
        // is then an upper bound of its duration: it may lower a rate, to that bound, and never raises one.
        const resolved = timestamps || wall >= 2 * latency;
        const dt = timestamps ? measured : resolved ? wall - latency : wall;
        if (dt !== null) learn(s, dt, resolved);
        owner.slices++;
        if (measured !== null) owner.gpuMs += measured;
        const report: SliceReport = {
          nodeId: owner.nodeId, service: owner.service, kernels: [...s.kernels.keys()], work: s.work, estimateMs: s.estimateMs,
          measuredMs: dt ?? wall,
        };
        try {
          // Only a measured duration is held against the ceiling: not the wall time of an unresolved or untimed slice.
          if (dt !== null && resolved && dt > owner.ceiling) opts.onOverrun?.(report);
          hooks.onSlice?.(report);
        } catch (error) {
          hookFailure ??= { error };
        }
      }
    };
    const finished: Promise<void> = measure().finally(() => {
      inFlight.delete(finished);
      owner.outstanding.delete(finished);
    });
    lastReport = finished.then(none, none).then(() => undefined);
    inFlight.add(finished);
    owner.outstanding.add(finished);
  }

  async function allCompleted(): Promise<void> {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  }

  /** 3.7: the device, then the signal of the owner that waited. */
  function checkAlive(owner: Owner | null): void {
    if (hookFailure) {
      const { error } = hookFailure;
      hookFailure = null;
      throw error;
    }
    if (gpu.lost) throw deviceLostError(gpu);
    if (owner?.signal?.aborted) throw owner.signal.reason;
  }

  /** 5.8 rule 4: out of memory takes precedence over the validation errors that follow from it. */
  function scopeError(owner: Owner): Error | null {
    if (owner.outOfMemory) return new GpuOutOfMemoryError(`The GPU reported out of memory: ${firstLine(owner.outOfMemory.message)}`);
    if (owner.validation) return new GpuValidationError(firstLine(owner.validation.message), owner.validation.message);
    return null;
  }

  const stream: CommandStream = {
    inFlightLimit,
    get submitted() { return submitted; },
    get current() { return current; },

    open(o) {
      if ((o.nodeId === null) === (o.service === null)) throw new TypeError('A stream owner is a node or a service: exactly one of nodeId and service is not null');
      const scale = o.limitScale ?? 1;
      const target = (hooks.sliceTargetMs ?? (o.mode === 'build' ? SLICE_TARGET_BUILD_MS : SLICE_TARGET_PREVIEW_MS)) * scale;
      const owner: Owner = {
        nodeId: o.nodeId,
        service: o.service,
        signal: o.signal,
        target,
        ceiling: HARD_CEILING_MS * scale,
        bindGroups: new Map(),
        outstanding: new Set(),
        scopes: new Set(),
        outOfMemory: null,
        validation: null,
        gpuMs: 0,
        slices: 0,
        closed: false,
        async settle() {
          if (slice?.owner === owner) submit();
          while (owner.outstanding.size > 0) await Promise.all([...owner.outstanding]);
          checkAlive(owner);
          const error = scopeError(owner);
          if (error) throw error;
          return { gpuMs: timestamps ? owner.gpuMs : null, slices: owner.slices };
        },
        close() {
          if (owner.closed) return;
          owner.closed = true;
          if (slice?.owner === owner) submit();
          if (current === owner) current = null;
          owner.bindGroups.clear();
        },
      };
      return owner;
    },

    use(owner) {
      const next = owner as Owner;
      if (next.closed) throw new Error('This stream owner is closed');
      if (current !== next) {
        submit();
        current = next;
      }
    },

    run(run) {
      const owner = requireOwner();
      const name = run.kernel.kernel.name;
      const shape = kernelShape(run.kernel.kernel.def);
      const [wgX, wgY] = shape.workgroup;
      const [width, height] = run.frame.res;
      const rate = rates.get(name) ?? RATE_INITIAL;
      let tileRows = height;
      if (!shape.tiled) {
        const estimate = width * height * run.cost * rate;
        if (estimate > owner.ceiling) {
          throw new WatchdogError(`kernel "${name}" cannot be tiled and one dispatch is estimated at ${Math.round(estimate)} ms; the limit is ${owner.ceiling} ms`);
        }
      } else {
        tileRows = rowsPerTile(owner.target, width, height, run.cost, rate, wgY, hooks.maxTileRows);
      }
      const { group0 } = ensureArena();
      const group1 = bindGroup(owner, run);
      const layout = run.kernel.paramsLayout;

      let paramsSlice: Slice | null = null;
      let paramsOffset = 0;
      for (let y = 0; y < height; y += tileRows) {
        const rows = Math.min(tileRows, height - y);
        // 3.2 rule 4: a Frame slot, and a Params slot when the open slice does not hold this run's yet.
        const slots = layout && (paramsSlice === null || paramsSlice !== slice) ? 2 : 1;
        if (slice && cursor + slots * UNIFORM_SLOT_BYTES > ARENA_BYTES) submit();
        const { s, pass } = computePass(owner);
        if (layout && run.params && paramsSlice !== s) {
          paramsOffset = cursor;
          cursor += UNIFORM_SLOT_BYTES;
          writeParams(layout, run.params, stagingView, paramsOffset);
          paramsSlice = s;
        }
        const frameOffset = cursor;
        cursor += UNIFORM_SLOT_BYTES;
        writeFrame({ ...run.frame, tileOrigin: [0, y] }, stagingView, frameOffset);
        if (s.pipeline !== run.kernel.pipeline) {
          pass.setPipeline(run.kernel.pipeline);
          s.pipeline = run.kernel.pipeline;
        }
        if (s.group1 !== group1) {
          pass.setBindGroup(1, group1);
          s.group1 = group1;
        }
        pass.setBindGroup(0, group0, [frameOffset, layout ? paramsOffset : frameOffset]);
        pass.dispatchWorkgroups(Math.ceil(width / wgX), Math.ceil(rows / wgY));
        const work = width * rows * run.cost;
        s.work += work;
        s.estimateMs += work * rate;
        const share = s.kernels.get(name);
        if (share) {
          share.work += work;
          share.estimateMs += work * rate;
        } else {
          s.kernels.set(name, { work, estimateMs: work * rate });
        }
        if (s.estimateMs >= owner.target) submit();
      }
    },

    clear(texture, value) {
      const s = openSlice(requireOwner());
      endPass(s);
      s.encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.view, loadOp: 'clear', storeOp: 'store',
          clearValue: { r: value[0], g: value[1], b: value[2], a: value[3] },
        }],
      }).end();
    },

    copy(src, dst) {
      if (src.format !== dst.format || src.width !== dst.width || src.height !== dst.height) {
        throw new Error(`A copy needs two textures of one shape: ${src.format} ${src.width}x${src.height} and ${dst.format} ${dst.width}x${dst.height}`);
      }
      const s = openSlice(requireOwner());
      endPass(s);
      s.encoder.copyTextureToTexture({ texture: src.texture }, { texture: dst.texture }, [src.width, src.height, 1]);
    },

    encode(work, estimateMs = 0) {
      const owner = requireOwner();
      const s = openSlice(owner);
      endPass(s);
      work(s.encoder);
      s.estimateMs += estimateMs;
      if (s.estimateMs >= owner.target) submit();
    },

    write(texture, data, rows) {
      const owner = requireOwner();
      const [y0, y1] = rows;
      if (!Number.isInteger(y0) || !Number.isInteger(y1) || y0 < 0 || y1 > texture.height || y0 >= y1) {
        throw new RangeError(`rows [${y0}, ${y1}) are not rows of a texture ${texture.height} high`);
      }
      const channels = CHANNELS[texture.kind];
      const expected = texture.width * (y1 - y0) * channels;
      if (data.length !== expected) {
        throw new RangeError(`The data has ${data.length} floats; ${texture.width} x ${y1 - y0} texels of "${texture.kind}" need ${expected}`);
      }
      // 3.1: an operation on the queue keeps its place in the order of the calls.
      submit();
      if (gpu.lost || owner.signal?.aborted) return;
      const packed = packTexels(TEXEL_ENCODING[texture.format]!, data);
      const bytesPerRow = texture.width * channels * packed.BYTES_PER_ELEMENT;
      const made = guarded(device, () => queue.writeTexture(
        { texture: texture.texture, origin: [0, y0, 0] }, packed, { bytesPerRow, rowsPerImage: y1 - y0 }, [texture.width, y1 - y0, 1],
      ));
      observe(owner, made.scopes);
    },

    track(scopes) {
      observe(requireOwner(), scopes);
    },

    submit,

    async flush() {
      const owner = current;
      submit();
      await allCompleted();
      checkAlive(owner);
    },

    async boundary(last) {
      const owner = current;
      submit();
      if (last) {
        await allCompleted();
      } else {
        while (unfinished >= inFlightLimit) await new Promise<void>((wake) => completionWaiters.push(wake));
      }
      checkAlive(owner);
      if (owner && (owner.outOfMemory || owner.validation)) {
        // The pops of one call report together; waiting for those already made lets out of memory take precedence.
        await Promise.all([...owner.scopes]);
        throw scopeError(owner)!;
      }
    },

    barrier,

    dispose() {
      if (disposed) return;
      disposed = true;
      slice = null;
      current = null;
      cursor = 0;
      if (arena) {
        arena.buffer.destroy();
        arena.reservation.release();
        arena = null;
      }
      for (const slot of timingSlots) {
        slot.querySet.destroy();
        slot.resolve.destroy();
        slot.read.destroy();
        slot.reservation.release();
      }
      timingSlots.length = 0;
      freeTimingSlots.length = 0;
    },
  };
  return stream;
}
