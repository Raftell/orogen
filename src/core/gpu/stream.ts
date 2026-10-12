import { deviceLostError, type GpuContext } from './device.ts';
import { CHANNELS, type Rgba } from './field.ts';
import { createGroup0Layout, type CompiledKernel } from './pipelines.ts';
import type { PoolTexture } from './pool.ts';
import { guarded, type ScopeResult } from './scopes.ts';
import { kernelShape } from './shape.ts';
import { packTexels, TEXEL_ENCODING } from './texels.ts';
import { nextRate, rowsPerTile } from './throughput.ts';
import {
  HARD_CEILING_MS, LATENCY_REMEASURE_MS, RATE_INITIAL, SLICE_MAX_RUNS, SLICE_TARGET_BUILD_MS, SLICE_TARGET_PREVIEW_MS, THREAD_STALL_MS,
  UNMEASURED_SLICE_TEXELS,
} from './tuning.ts';
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
  /** The measured duration (3.5) when `resolved`; otherwise the time from the submit to its completion, which the duration does not exceed. */
  readonly measuredMs: number;
  readonly resolved: boolean;
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
  /** A slice was measured above the hard ceiling of its owner (3.5), which is `ceilingMs`. */
  readonly onOverrun?: (slice: SliceReport, ceilingMs: number) => void;
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
  /** Sum of the measured GPU time of the owner's slices; null without timestamp-query, and when one of them could not be timed (5.10 rule 4). */
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
  /** When a completion was last seen (performance.now()): the thread has been through the event loop since then at the latest. */
  readonly observed: number;
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
 * the arena has slots, so that is at most its last pass. Every slice writes the same queries from index 0:
 * it resolves them in its own command buffer, before the next slice writes them again.
 */
const TIMING_QUERIES = 4096;
const TIMED_PASSES = TIMING_QUERIES - 1;
/**
 * The resolved timestamps of a slice are copied to a buffer of its own, which it holds until they are read
 * back. A node that submits slices without waiting (3.6 rule 4) holds one per slice: a tile in a slice of its
 * own needs 16 bytes, and the smallest buffer is 256. Beyond this many bytes a slice is not timed.
 */
const TIMING_READ_BYTES = 2 * 1048576;
const TIMING_READ_MIN = 256;

interface TimingRead {
  readonly buffer: GPUBuffer;
  readonly size: number;
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
  /** A slice with compute passes completed without timestamps: the sum above is not the owner's GPU time. */
  untimed: boolean;
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
  /** The rate key of the open pass. With timestamps a pass holds runs of one key, so that each is timed on its own (3.3). */
  passKey: string | null;
  passes: number;
  /** With timestamps: the rate key of each timed pass, in order. */
  readonly timed: string[];
  estimateMs: number;
  work: number;
  runs: number;
  /** Texels written by kernels the device has not measured at their level (3.4 rule 5). */
  unmeasuredTexels: number;
  /** Per rate key (a kernel at a level, 3.3), the work of its dispatches in this slice and what they were estimated at. */
  readonly kernels: Map<string, { readonly name: string; work: number; estimateMs: number }>;
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
  /** When a completion of any kind was last observed, for the idle rule of 3.5. */
  let lastActivity = -Infinity;
  /** When the completion of the slice submitted before was observed, and whether that was when it happened: a slice queued behind it began then. */
  let lastDone = { at: -Infinity, prompt: false };
  /**
   * Without timestamps a completion is timed by when the thread sees it, which is when it happened only while
   * the thread keeps returning to the event loop. While slices are in flight a timer notes each return; a gap
   * between two of them is a stall, and what is seen in one or just after it was seen late (3.5).
   */
  let beat = { at: -Infinity, stalledUntil: -Infinity, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  let latency = 0;
  /** Settles when the slice submitted last has been learned from and reported: slices report in the order of their submission. */
  let lastReport: Promise<void> = Promise.resolve();
  /** What an onSlice hook threw; the next wait rethrows it, so that an assertion made in a hook fails its test. */
  let hookFailure: { readonly error: unknown } | null = null;

  /** 3.3: per rate key, `<kernel name>@<level>`. A kernel is faster per texel on a small grid than on a large one, so each level learns its own. */
  const rates = new Map<string, number>();
  /** Rate keys whose last measurement was at most twice its estimate: their tiles and slices are sized by estimate alone (3.4 rule 5). */
  const measured = new Set<string>();
  /** Without timestamps: rate keys that have completed a resolved slice of their own (3.3 rule 2). */
  const alone = new Set<string>();
  let timing: { readonly querySet: GPUQuerySet; readonly resolve: GPUBuffer; readonly reservation: { release(): void } } | null = null;
  const timingReads: TimingRead[] = [];
  const freeTimingReads = new Map<number, TimingRead[]>();
  let timingReadBytes = 0;
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

  function ensureTiming(): NonNullable<typeof timing> {
    if (!timing) {
      const bytes = TIMING_QUERIES * 8;
      const made = guarded(device, () => ({
        querySet: device.createQuerySet({ label: 'orogen slice timing', type: 'timestamp', count: TIMING_QUERIES }),
        resolve: device.createBuffer({ label: 'orogen slice timing', size: bytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      }));
      if (current) observe(current, made.scopes);
      timing = { ...made.value, reservation: opts.reserve(bytes * 2, 'slice timing') };
    }
    return timing;
  }

  /** A buffer for `bytes` of resolved timestamps; null when the stream holds as many as it may. */
  function takeTimingRead(bytes: number): TimingRead | null {
    let size = TIMING_READ_MIN;
    while (size < bytes) size *= 2;
    const free = freeTimingReads.get(size)?.pop();
    if (free) return free;
    if (timingReadBytes + size > TIMING_READ_BYTES) return null;
    const made = guarded(device, () => device.createBuffer({ label: 'orogen slice timing', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    if (current) observe(current, made.scopes);
    const read: TimingRead = { buffer: made.value, size, reservation: opts.reserve(size, 'slice timing') };
    timingReads.push(read);
    timingReadBytes += size;
    return read;
  }

  /**
   * The timestamps of a slice, in milliseconds from the beginning of its first compute pass: entry k is the end
   * of timed pass k, never below the entry before it. Null when they cannot be read.
   */
  async function readTiming(read: TimingRead, timed: number): Promise<Float64Array | null> {
    const bytes = (timed + 1) * 8;
    // A stream disposed with slices in flight has destroyed the buffer; mapping it would raise an uncaptured error.
    if (disposed || gpu.lost) return null;
    try {
      await read.buffer.mapAsync(GPUMapMode.READ, 0, bytes);
    } catch {
      return null;
    }
    if (disposed) return null;
    const stamps = new BigUint64Array(read.buffer.getMappedRange(0, bytes).slice(0));
    read.buffer.unmap();
    const free = freeTimingReads.get(read.size);
    if (free) free.push(read);
    else freeTimingReads.set(read.size, [read]);
    const ends = new Float64Array(timed + 1);
    let top = stamps[0]!;
    for (let k = 1; k <= timed; k++) {
      if (stamps[k]! > top) top = stamps[k]!;
      ends[k] = Number(top - stamps[0]!) / 1e6;
    }
    return ends;
  }

  function openSlice(owner: Owner): Slice {
    slice ??= {
      owner, encoder: device.createCommandEncoder(), pass: null, pipeline: null, group1: null, passKey: null, passes: 0, timed: [],
      estimateMs: 0, work: 0, runs: 0, unmeasuredTexels: 0, kernels: new Map(),
    };
    return slice;
  }

  function endPass(s: Slice): void {
    if (s.pass) {
      s.pass.end();
      s.pass = null;
      s.pipeline = null;
      s.group1 = null;
      s.passKey = null;
    }
  }

  /** 3.3 rule 1: the rate of a kernel at a level it has not run at. */
  function firstRate(name: string, level: number): number {
    // The nearest level at which it has run: below first, where the rate is the lower one. 16 levels cover every grid.
    for (const direction of [-1, 1]) {
      for (let distance = 1; distance <= 16; distance++) {
        const near = rates.get(`${name}@${level + direction * distance}`);
        if (near !== undefined) return Math.max(near, RATE_INITIAL);
      }
    }
    return RATE_INITIAL;
  }

  /** The open compute pass of the open slice for a run with rate key `kernel`, begun when there is none it can join. */
  function computePass(owner: Owner, kernel: string): { readonly s: Slice; readonly pass: GPUComputePassEncoder } {
    const s = openSlice(owner);
    if (s.pass && timestamps && s.passKey !== kernel) endPass(s);
    if (!s.pass) {
      if (timestamps && s.passes < TIMED_PASSES) {
        const querySet = ensureTiming().querySet;
        s.pass = s.encoder.beginComputePass({
          timestampWrites: s.passes === 0 ? { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : { querySet, endOfPassWriteIndex: s.passes + 1 },
        });
        s.timed.push(kernel);
      } else {
        s.pass = s.encoder.beginComputePass();
      }
      s.passes++;
      s.passKey = kernel;
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

  /** 3.4 rule 5: a kernel is measured at a level while its last measurement there was at most twice its estimate. */
  function judge(key: string, estimateMs: number, dt: number): void {
    if (dt <= 2 * estimateMs) measured.add(key);
    else measured.delete(key);
  }

  /**
   * 3.3 rule 2 with timestamps: every kernel of the slice follows the time of its own passes. The factor applies
   * to the rate the slice was estimated with: with two slices in flight the second is estimated before the first
   * completes, and a factor applied to the current rate would correct one error twice.
   */
  function learnTimed(s: Slice, ends: Float64Array): void {
    const times = new Map<string, number>();
    s.timed.forEach((key, k) => times.set(key, (times.get(key) ?? 0) + ends[k + 1]! - ends[k]!));
    const over = ends[ends.length - 1]! > s.owner.ceiling;
    for (const [key, share] of s.kernels) {
      const dt = times.get(key);
      // A kernel whose only pass is the one beyond the last timestamp has no time of its own.
      if (dt === undefined || !(share.work > 0)) continue;
      rates.set(key, nextRate(share.estimateMs / share.work, share.estimateMs, dt, true, s.owner.ceiling, over));
      judge(key, share.estimateMs, dt);
    }
  }

  /**
   * 3.3 rule 2 by wall clock: one duration for the whole slice. `resolved` is false for a duration that is only
   * known not to exceed `dt` (3.5 rule 2): it may lower a rate and never raises one.
   */
  function learnWall(s: Slice, dt: number, resolved: boolean): void {
    const names = [...s.kernels.keys()].filter((key) => s.kernels.get(key)!.work > 0);
    const fresh = names.filter((key) => !alone.has(key));
    // A slice of several kernels teaches those the device has not measured on their own, and leaves the others
    // their rates: a kernel that is estimated well does not take the correction of one that is not.
    const some = fresh.length > 0 && fresh.length < names.length;
    let estimate = s.estimateMs, duration = dt;
    if (some) {
      estimate = 0;
      for (const name of fresh) estimate += s.kernels.get(name)!.estimateMs;
      duration = Math.max(0, dt - (s.estimateMs - estimate));
    }
    for (const name of some ? fresh : names) {
      const share = s.kernels.get(name)!;
      const next = nextRate(share.estimateMs / share.work, estimate, duration, resolved, s.owner.ceiling, resolved && dt > s.owner.ceiling);
      if (resolved) rates.set(name, next);
      // A bound teaches "at most this", and only when it is below the estimate. It never takes back what a
      // measured slice of the same burst has taught since this one was estimated.
      else if (duration < estimate) rates.set(name, Math.min(next, rates.get(name) ?? Infinity));
    }
    if (names.length === 1 && resolved) alone.add(names[0]!);
    if (dt <= 2 * s.estimateMs) for (const name of names) measured.add(name);
    else if (resolved) for (const name of names) measured.delete(name);
  }

  function tick(): void {
    const now = performance.now();
    if (now - beat.at > THREAD_STALL_MS) beat.stalledUntil = now;
    beat.at = now;
    beat.timer = unfinished > 0 && !disposed ? setTimeout(tick, THREAD_STALL_MS / 3) : undefined;
  }

  /** Whether what the thread sees now, it sees as it happens. */
  function prompt(now: number): boolean {
    return now - beat.at <= THREAD_STALL_MS && now - beat.stalledUntil > THREAD_STALL_MS;
  }

  function completed(): void {
    lastActivity = performance.now();
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
    if (gpu.lost || owner.closed || owner.signal?.aborted) return;
    if (!timestamps && unfinished === 0 && performance.now() - lastActivity >= LATENCY_REMEASURE_MS) void barrier();

    const timed = s.timed.length;
    const read = timed > 0 ? takeTimingRead(8 * (timed + 1)) : null;
    if (read) {
      const { querySet, resolve } = ensureTiming();
      s.encoder.resolveQuerySet(querySet, 0, timed + 1, resolve, 0);
      s.encoder.copyBufferToBuffer(resolve, 0, read.buffer, 0, 8 * (timed + 1));
    }
    const made = guarded(device, () => {
      if (usedBytes > 0) queue.writeBuffer(ensureArena().buffer, 0, staging, 0, usedBytes);
      queue.submit([s.encoder.finish()]);
    });
    observe(owner, made.scopes);
    submitted++;
    // By wall clock a slice submitted behind another starts when that one ends (3.5).
    const solo = unfinished === 0;
    unfinished++;
    const submittedAt = performance.now();
    const previous = lastReport;
    if (!timestamps && beat.timer === undefined) {
      beat.at = submittedAt;
      beat.timer = setTimeout(tick, THREAD_STALL_MS / 3);
    }

    const measure = async (): Promise<void> => {
      await queue.onSubmittedWorkDone().catch(none);
      const now = performance.now();
      const awaited = prompt(now);
      const before = lastDone;
      lastDone = { at: now, prompt: awaited };
      const began = solo ? submittedAt : before.prompt ? Math.max(submittedAt, before.at) : null;
      // No longer than the slice took: from its beginning when that was observed, else from its submit.
      const wall = now - (began ?? submittedAt);
      // 3.6: the scopes of a completed slice have reported before whoever waited for it goes on.
      await Promise.all([made.scopes.validation, made.scopes.outOfMemory]);
      unfinished--;
      completed();
      const ends = read ? await readTiming(read, timed) : null;
      // A slice whose timestamps take longer to read back does not report after a later one.
      await previous;
      if (!gpu.lost && !disposed) {
        let dt = wall;
        let resolved = false;
        if (timestamps) {
          if (ends) {
            dt = ends[timed]!;
            resolved = true;
            learnTimed(s, ends);
            owner.gpuMs += dt;
          } else if (s.passes > 0) {
            owner.untimed = true;
          }
        } else {
          // 3.5: the wall time is the slice's own only when its beginning and its end were both observed as
          // they happened, and it is resolved only above twice the completion latency. Otherwise it is an upper
          // bound of the duration: it may lower a rate, to that bound, and never raises one.
          resolved = awaited && began !== null && wall >= 2 * latency;
          // The latency is in one end of a slice that began at its submit, and in both ends of one that began at a completion.
          if (resolved && solo) dt = wall - latency;
          learnWall(s, dt, resolved);
        }
        owner.slices++;
        const report: SliceReport = {
          nodeId: owner.nodeId, service: owner.service, kernels: [...new Set([...s.kernels.values()].map((share) => share.name))],
          work: s.work, estimateMs: s.estimateMs, measuredMs: dt, resolved,
        };
        try {
          // Only a measured duration is held against the ceiling: not the wall time of an unresolved or untimed slice.
          if (resolved && dt > owner.ceiling) opts.onOverrun?.(report, owner.ceiling);
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
    get observed() { return lastActivity; },
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
        untimed: false,
        slices: 0,
        closed: false,
        async settle() {
          if (slice?.owner === owner) submit();
          while (owner.outstanding.size > 0) await Promise.all([...owner.outstanding]);
          checkAlive(owner);
          const error = scopeError(owner);
          if (error) throw error;
          return { gpuMs: timestamps && !owner.untimed ? owner.gpuMs : null, slices: owner.slices };
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
      // 3.3: one level per factor of two in resolution, which for a square grid is its ladder level.
      const level = Math.floor(Math.log2(width * height) / 2);
      const key = `${name}@${level}`;
      const rate = rates.get(key) ?? firstRate(name, level);
      // 3.4 rule 5. The hook that replaces the slice targets replaces this bound with them.
      const unmeasured = hooks.sliceTargetMs === undefined && !measured.has(key);
      let tileRows = height;
      if (!shape.tiled) {
        const estimate = width * height * run.cost * rate;
        if (estimate > owner.ceiling) {
          throw new WatchdogError(`kernel "${name}" cannot be tiled and one dispatch is estimated at ${Math.round(estimate)} ms; the limit is ${owner.ceiling} ms`);
        }
      } else {
        tileRows = rowsPerTile(owner.target, width, height, run.cost, rate, wgY, hooks.maxTileRows);
        if (unmeasured) tileRows = Math.min(tileRows, Math.max(wgY, Math.floor(UNMEASURED_SLICE_TEXELS / width / wgY) * wgY));
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
        const { s, pass } = computePass(owner, key);
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
        const share = s.kernels.get(key);
        if (share) {
          share.work += work;
          share.estimateMs += work * rate;
        } else {
          s.kernels.set(key, { name, work, estimateMs: work * rate });
        }
        if (unmeasured) s.unmeasuredTexels += width * rows;
        if (s.estimateMs >= owner.target || s.unmeasuredTexels >= UNMEASURED_SLICE_TEXELS) submit();
      }
      // 3.1: on a small grid the estimate alone would let a slice hold thousands of runs.
      if (slice && hooks.sliceTargetMs === undefined && ++slice.runs >= SLICE_MAX_RUNS) submit();
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
      clearTimeout(beat.timer);
      beat.timer = undefined;
      if (arena) {
        arena.buffer.destroy();
        arena.reservation.release();
        arena = null;
      }
      if (timing) {
        timing.querySet.destroy();
        timing.resolve.destroy();
        timing.reservation.release();
        timing = null;
      }
      for (const read of timingReads) {
        read.buffer.destroy();
        read.reservation.release();
      }
      timingReads.length = 0;
      freeTimingReads.clear();
      timingReadBytes = 0;
    },
  };
  return stream;
}
