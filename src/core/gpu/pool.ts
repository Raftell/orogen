import type { GpuContext } from './device.ts';
import type { FieldKind, Rgba } from './field.ts';
import { guarded, type ScopeResult } from './scopes.ts';
import type { CommandStream } from './stream.ts';
import { TEXEL_ENCODING } from './texels.ts';

/** A reference to published content, for code outside the evaluator: the session, the viewport, the build pipeline. */
export interface FieldHandle<K extends 'field' | 'color' = 'field' | 'color'> {
  readonly kind: K;
  readonly width: number;
  readonly height: number;
  readonly epoch: number;                 // device epoch in which it was created (5.9)
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;          // the texture's one cached default view
  retain(): FieldHandle<K>;               // a new, independent handle on the same content
  release(): void;                        // exactly once per handle
}

/** What the evaluator delivers: a union of the two handle types, so a test of `kind` narrows it. */
export type AnyFieldHandle = FieldHandle<'field'> | FieldHandle<'color'>;

export interface PoolTexture {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly kind: FieldKind;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface TexturePool {
  acquire(kind: FieldKind, width: number, height: number): PoolTexture;   // WORKING; may throw BudgetExceededError (2.5)
  release(t: PoolTexture): void;                                         // WORKING → FREE
  publish(t: PoolTexture): void;                                         // WORKING → PUBLISHED with one reference, owned by the caller
  retain(t: PoolTexture): void;                                          // PUBLISHED: one more reference
  drop(t: PoolTexture): void;                                            // PUBLISHED: one reference fewer; at zero → FREE
  reserve(bytes: number, label: string): { release(): void };            // registers memory that is not a pool texture
  trim(opts?: { keepResolution?: number }): Promise<void>;               // 2.8
  drained(): Promise<void>;                                              // resolves when `draining` is zero
  report(): MemoryReport;
  setBudget(bytes: number): void;
}

export interface MemoryReport {
  readonly budgetBytes: number;
  readonly workingBytes: number;
  readonly cacheBytes: number;       // published and not pinned: evictable
  readonly pinnedBytes: number;      // published and pinned
  readonly freeBytes: number;
  readonly reservedBytes: number;
  readonly drainingBytes: number;
}

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  readonly requestedBytes: number;
  readonly kind: FieldKind;
  readonly width: number;
  readonly height: number;
  readonly report: MemoryReport;

  constructor(message: string, info: {
    readonly requestedBytes: number; readonly kind: FieldKind; readonly width: number; readonly height: number;
    readonly report: MemoryReport;
  }) {
    super(message);
    this.requestedBytes = info.requestedBytes;
    this.kind = info.kind;
    this.width = info.width;
    this.height = info.height;
    this.report = info.report;
  }
}

/** Bytes per texel of every format a field kind resolves to (runtime.md 2.4). */
export const BYTES_PER_TEXEL = {
  r8unorm: 1, r16float: 2, r32float: 4, rg16float: 4, rg32float: 8, rgba16float: 8, rgba32float: 16,
} as const;

/** What the pool asks of the result cache, which holds some of the references on published textures. */
export interface PoolCacheHooks {
  /** Evicts the first evictable entry in eviction order (2.7). False when no entry is evictable. */
  evictOne(): boolean;
  /** How many of the references on `t` are held by cache entries. `t` is pinned when it has more (2.2). */
  cacheReferences(t: PoolTexture): number;
}

export interface PoolOptions {
  readonly gpu: GpuContext;
  readonly budgetBytes: number;
  /**
   * submit: before a texture is destroyed (2.6 rule 1). barrier: after the last destroy of an acquire or trim (2.6 rule 3).
   * track: the pops of every texture creation, recorded against the stream's current owner (2.5).
   * clear: fills a recycled texture when `poisonRecycled` is set.
   */
  readonly stream: Pick<CommandStream, 'submit' | 'barrier' | 'track' | 'clear'>;
  readonly cache: PoolCacheHooks;
  /** runtime.md 5.14. */
  readonly hooks?: { readonly failAllocAfter?: number; readonly poisonRecycled?: boolean };
}

export interface ManagedPool extends TexturePool {
  /** The references on a PUBLISHED texture, whoever holds them. The result cache compares them with its own to find what an eviction would free (2.7). */
  references(t: PoolTexture): number;
  /** Destroys every texture whatever its state. For Engine.dispose only (2.1 rule 2). */
  dispose(): void;
}

/** engine.md 3.12. */
const MAX_SIDE = 8192;

type State = 'working' | 'published' | 'free' | 'destroyed';

/** One GPU texture of the pool. A PoolTexture is one tenancy of it: every acquire hands out a new one. */
interface Slot {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  state: State;
  references: number;
  /** Order in which textures became FREE. */
  freedAt: number;
  tenant: PoolTexture | null;
  /** The pops of the creation, until both have reported. Whoever is handed the texture before then hears of them too. */
  creation: ScopeResult | null;
  /** The creation reported an error: the texture is not a texture. It is never handed out again (2.5). */
  invalid: boolean;
}

/** What a recycled texture is filled with under `poisonRecycled`: −1e30, or the nearest value its format holds that a new texture's zeros differ from. */
function poison(format: GPUTextureFormat): Rgba {
  const encoding = TEXEL_ENCODING[format];
  const v = encoding === 'f32' ? -1e30 : encoding === 'f16' ? -65504 : 1;
  return [v, v, v, v];
}

const megabytes = (bytes: number): string => (bytes / 1048576).toFixed(1);

export function createPool(opts: PoolOptions): ManagedPool {
  const { gpu, stream, cache } = opts;
  const device = gpu.device;
  const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;

  let budget = opts.budgetBytes;
  let working = 0, published = 0, free = 0, reserved = 0, draining = 0;
  let clock = 0;
  let failAfter = opts.hooks?.failAllocAfter ?? 0;
  const tenants = new Map<PoolTexture, Slot>();
  const slots = new Set<Slot>();
  /** FREE textures by shape, least recently freed first. */
  const freeLists = new Map<string, Slot[]>();
  const barriers = new Set<Promise<void>>();

  const shapeKey = (format: GPUTextureFormat, width: number, height: number): string => `${format}/${width}/${height}`;

  function slotOf(t: PoolTexture, expected: State, call: string): Slot {
    const slot = tenants.get(t);
    if (!slot) throw new Error(`pool.${call}: the texture is not held; it was released, dropped to zero or belongs to another pool`);
    if (slot.state !== expected) throw new Error(`pool.${call}: the texture is ${slot.state.toUpperCase()}, not ${expected.toUpperCase()}`);
    return slot;
  }

  function tenantOf(slot: Slot, kind: FieldKind): PoolTexture {
    const tenant: PoolTexture = Object.freeze({
      texture: slot.texture, view: slot.view, kind, format: slot.format, width: slot.width, height: slot.height, bytes: slot.bytes,
    });
    slot.tenant = tenant;
    tenants.set(tenant, slot);
    return tenant;
  }

  function toFree(slot: Slot): void {
    tenants.delete(slot.tenant!);
    slot.tenant = null;
    slot.state = 'free';
    slot.references = 0;
    slot.freedAt = ++clock;
    free += slot.bytes;
    const key = shapeKey(slot.format, slot.width, slot.height);
    const list = freeLists.get(key);
    if (list) list.push(slot);
    else freeLists.set(key, [slot]);
  }

  function takeFree(slot: Slot): void {
    const key = shapeKey(slot.format, slot.width, slot.height);
    const list = freeLists.get(key)!;
    list.splice(list.indexOf(slot), 1);
    if (list.length === 0) freeLists.delete(key);
    free -= slot.bytes;
  }

  /** 2.6 rules 1 and 2. The caller submits the barrier of rule 3 after its last destroy. */
  function destroy(slot: Slot): void {
    stream.submit();
    takeFree(slot);
    slot.state = 'destroyed';
    slot.texture.destroy();
    slots.delete(slot);
    draining += slot.bytes;
  }

  /** A texture leaves WORKING or PUBLISHED: to its free list, or, when its creation reported an error, out of the pool. */
  function retire(slot: Slot): void {
    toFree(slot);
    if (slot.invalid) discard(slot);
  }

  /** Destroys a FREE texture whose creation reported an error, with a barrier of its own. */
  function discard(slot: Slot): void {
    if (gpu.lost) return;
    destroy(slot);
    void barrier(slot.bytes);
  }

  /** 2.5: a texture whose creation reports an error is never handed out again. */
  function watchCreation(slot: Slot, scopes: ScopeResult): void {
    slot.creation = scopes;
    void Promise.all([scopes.validation, scopes.outOfMemory]).then(([validation, outOfMemory]) => {
      slot.creation = null;
      if (!validation && !outOfMemory) return;
      slot.invalid = true;
      if (slot.state === 'free') discard(slot);
    });
  }

  /**
   * 2.6 rule 3: the bytes destroyed before the barrier leave `draining` when it has completed. A barrier is two
   * empty submissions, the second made when the first has completed: measured, the driver now and then still
   * holds a destroyed texture after one.
   */
  function barrier(bytes: number): Promise<void> {
    const done: Promise<void> = stream.barrier().then(() => stream.barrier()).then(() => {
      draining -= bytes;
      barriers.delete(done);
    });
    barriers.add(done);
    return done;
  }

  function report(): MemoryReport {
    let pinned = 0;
    for (const slot of slots) {
      if (slot.state === 'published' && slot.references > cache.cacheReferences(slot.tenant!)) pinned += slot.bytes;
    }
    return {
      budgetBytes: budget,
      workingBytes: working,
      cacheBytes: published - pinned,
      pinnedBytes: pinned,
      freeBytes: free,
      reservedBytes: reserved,
      drainingBytes: draining,
    };
  }

  function acquire(kind: FieldKind, width: number, height: number): PoolTexture {
    for (const side of [width, height]) {
      if (!Number.isInteger(side) || side < 1 || side > MAX_SIDE) {
        throw new RangeError(`A field side is 1 to ${MAX_SIDE} texels; ${width} x ${height} was requested`);
      }
    }
    const format = gpu.caps.formats[kind];
    const need = width * height * BYTES_PER_TEXEL[format as keyof typeof BYTES_PER_TEXEL];
    const key = shapeKey(format, width, height);
    let destroyed = 0;
    try {
      for (;;) {
        // 1. The most recently freed texture of the exact shape.
        const list = freeLists.get(key);
        if (list) {
          const slot = list[list.length - 1]!;
          takeFree(slot);
          slot.state = 'working';
          working += slot.bytes;
          const tenant = tenantOf(slot, kind);
          try {
            // Freed before its creation had reported: an error of the creation is this owner's now (5.8 rule 3).
            if (slot.creation) stream.track(slot.creation);
            if (opts.hooks?.poisonRecycled) stream.clear(tenant, poison(format));
          } catch (thrown) {
            // No owner is current: the texture goes back, or it would stay WORKING with nobody to release it.
            working -= slot.bytes;
            toFree(slot);
            throw thrown;
          }
          return tenant;
        }
        // 2. A new texture, when it fits.
        if (working + published + free + reserved + need <= budget) {
          const made = guarded(device, () => {
            const texture = device.createTexture({ label: `field ${format} ${width}x${height}`, size: [width, height], format, usage, dimension: '2d', mipLevelCount: 1, sampleCount: 1 });
            return { texture, view: texture.createView() };
          });
          const fails = failAfter > 0 && --failAfter === 0;
          const scopes: ScopeResult = fails
            ? { validation: made.scopes.validation, outOfMemory: Promise.resolve({ message: 'Out of memory (EngineTestHooks.failAllocAfter)' } as GPUError) }
            : made.scopes;
          const slot: Slot = {
            ...made.value, format, width, height, bytes: need, state: 'working', references: 0, freedAt: 0, tenant: null, creation: null, invalid: false,
          };
          // Before the owner hears of them: when the owner's wait ends on a report, the pool knows the texture is invalid.
          watchCreation(slot, scopes);
          try {
            stream.track(scopes);
          } catch (thrown) {
            // No owner is current: the new texture is in no list yet and would never be destroyed.
            slot.state = 'destroyed';
            made.value.texture.destroy();
            throw thrown;
          }
          slots.add(slot);
          working += need;
          return tenantOf(slot, kind);
        }
        // 3. Destroy the largest FREE texture; of equals, the least recently freed.
        let victim: Slot | null = null;
        for (const candidates of freeLists.values()) {
          for (const slot of candidates) {
            if (!victim || slot.bytes > victim.bytes || (slot.bytes === victim.bytes && slot.freedAt < victim.freedAt)) victim = slot;
          }
        }
        if (victim) {
          destroy(victim);
          destroyed += victim.bytes;
          continue;
        }
        // 4. Evict; a texture that reaches zero references becomes FREE and the loop goes round again.
        const freeBefore = free;
        if (cache.evictOne()) {
          // An evictable entry frees at least one texture (2.7). Without this check a cache that claims an
          // eviction and frees nothing would keep this loop going for ever.
          if (free <= freeBefore) throw new Error('pool.acquire: the cache evicted an entry and no texture became FREE');
          continue;
        }
        // 5.
        const state = report();
        throw new BudgetExceededError(
          `A ${width} x ${height} "${kind}" field needs ${megabytes(need)} MB, which does not fit the GPU memory budget of ${megabytes(budget)} MB`
          + ` (${megabytes(state.workingBytes)} MB working, ${megabytes(state.pinnedBytes)} MB pinned, ${megabytes(state.reservedBytes)} MB reserved)`,
          { requestedBytes: need, kind, width, height, report: state },
        );
      }
    } finally {
      if (destroyed > 0) void barrier(destroyed);
    }
  }

  return {
    acquire,
    release(t) {
      const slot = slotOf(t, 'working', 'release');
      working -= slot.bytes;
      retire(slot);
    },
    publish(t) {
      const slot = slotOf(t, 'working', 'publish');
      working -= slot.bytes;
      published += slot.bytes;
      slot.state = 'published';
      slot.references = 1;
    },
    retain(t) {
      slotOf(t, 'published', 'retain').references++;
    },
    drop(t) {
      const slot = slotOf(t, 'published', 'drop');
      if (--slot.references === 0) {
        published -= slot.bytes;
        retire(slot);
      }
    },
    reserve(bytes, label) {
      if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`pool.reserve("${label}"): ${bytes} is not a byte count`);
      reserved += bytes;
      let live = true;
      return {
        release() {
          if (!live) return;
          live = false;
          reserved -= bytes;
        },
      };
    },
    async trim(trimOpts) {
      const keep = trimOpts?.keepResolution;
      let destroyed = 0;
      for (const list of [...freeLists.values()]) {
        for (const slot of [...list]) {
          if (keep !== undefined && slot.width === keep) continue;
          destroy(slot);
          destroyed += slot.bytes;
        }
      }
      await barrier(destroyed);
    },
    async drained() {
      while (barriers.size > 0) await Promise.all([...barriers]);
    },
    report,
    references(t) {
      return slotOf(t, 'published', 'references').references;
    },
    setBudget(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`pool.setBudget: ${bytes} is not a byte count`);
      budget = bytes;
    },
    dispose() {
      for (const slot of slots) {
        slot.state = 'destroyed';
        slot.texture.destroy();
      }
      slots.clear();
      tenants.clear();
      freeLists.clear();
      working = published = free = 0;
    },
  };
}
