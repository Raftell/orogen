# Runtime contract: device, pool, evaluator, session and application

This document is the contract for everything that runs a graph: how the GPU
device is created, how textures are pooled and budgeted, how GPU work is
submitted, how the evaluator plans, caches, reports and recovers, how files are
read and written, the `EngineSession` facade the application talks to, and how
the application is structured.

It builds on `engine.md`. Every name used here without a definition (`Field`,
`FieldKind`, `FieldStats`, `NodeDef`, `Kernel`, `EvalContext`, `CpuTask`,
`KernelBindingError`, `FieldAccessError`, the ladder, the units) is defined
there and means exactly what it means there.

| Document | Owns |
| --- | --- |
| `engine.md` | fields, kinds, kernels, WGSL, nodes, params, `EvalContext`, shared ops |
| `export-unreal.md` | export nodes, `buildProject`, `buildToFolder`, `BuildResult`, `BuildEvent`, `BuildPlan`, `BuildProblem`, encoders, the manifest, Unreal conventions |
| `simulation.md` | simulation algorithms and the coarse-to-fine driver's behaviour |
| `testing.md` | the test harness, conformance, CI, file ownership for core and node work, UI testing, the application's test mode |

**Imports.** `src/core/runtime.ts` re-exports every type, function and constant
named in sections 1 to 7, with these exceptions:

| Not re-exported by `runtime.ts` | Exported by |
| --- | --- |
| `createNodeGpu`, `NodeFileSource`, `NodeFileSink`, `createNodeCpuRunner` | their modules in `src/platform/node/` |
| `createWebCpuRunner` | `src/platform/electron/worker/cpu.ts` |
| `nodes` (5.1) | `src/core/nodes/index.ts` |

`runtime.ts` also re-exports the build types that `export-unreal.md` defines
and `src/core/export-decl.ts` declares (`BuildResult`, `BuildEvent`,
`BuildPlan`, `BuildProblem` and the types they are made of), because the
session and the interface name them and may not import `src/export/` (8.4).

Code outside `src/core/` imports the engine from `runtime.ts`, node metadata
from `api.ts`, the product's node list from `src/core/nodes/index.ts`, and
nothing deeper. `runtime.ts` and `api.ts` do not import `src/core/nodes/`:
importing either of them loads no node.

**Conventions.** MiB is 2^20 bytes. Times are milliseconds unless a unit is
given. A constant marked *to calibrate* is a starting value: it is defined in
one place, `src/core/gpu/tuning.ts`, and is changed only with a measurement on
the target machine (Windows 11, RTX 3080).

---

## 1. Device

### 1.1 The factory

```ts
type GpuProfile = 'max' | 'core';

interface GpuLostInfo { readonly reason: 'destroyed' | 'unknown'; readonly message: string }

interface GpuContext {
  readonly device: GPUDevice;
  readonly profile: GpuProfile;
  readonly caps: GpuCaps;                       // 1.3
  /** True once device.lost has resolved for any reason other than destroy(). Never false again. */
  readonly lost: boolean;
  readonly lostInfo: GpuLostInfo | null;
  onLost(listener: (info: GpuLostInfo) => void): () => void;
  /** Destroys the device. In Node it also drops the Dawn instance. Idempotent. */
  destroy(): void;
}

declare class GpuUnavailableError extends Error {}    // no adapter, or the device fails the checks of 1.4
declare class DeviceLostError extends Error {}        // thrown by every engine call on a lost device

/** src/core/gpu/device.ts. The only code that calls requestAdapter() or requestDevice(). */
declare function openGpu(gpu: GPU, opts: { profile: GpuProfile }): Promise<GpuContext>;

/** src/platform/node/gpu.ts, which exports it; core does not. The only code that imports the `webgpu` package. */
declare function createNodeGpu(opts?: { profile?: GpuProfile; adapter?: string }): Promise<GpuContext>;
```

1. Nothing else creates a device: not a node, not a panel, not a test, not the viewport. Tests take the device from the harness (`testing.md`).
2. `openGpu` calls `gpu.requestAdapter({ powerPreference: 'high-performance' })`, then `adapter.requestDevice()` with the profile's features and limits (1.2). It requests a new adapter for every device: an adapter is consumed by `requestDevice`, and a reused one returns a device that is already lost.
3. `openGpu` rejects with `GpuUnavailableError` when `requestAdapter` returns `null` or when a check of 1.4 fails. The message names the missing item.
4. `openGpu` installs the `device.lost` handler that sets `lost` and `lostInfo` and calls the listeners, and an `uncapturederror` listener (5.8).
5. In the application the engine worker calls `openGpu(navigator.gpu, { profile: 'max' })`. The environment variable `OROGEN_GPU_PROFILE=core`, read by the main process and passed to the worker, forces `core` for debugging.
6. `createNodeGpu` defaults: `profile` from `OROGEN_GPU_PROFILE`, else `'max'`; `adapter` from `OROGEN_GPU_ADAPTER`, else none.

### 1.2 Profiles

| | `core` | `max` |
| --- | --- | --- |
| `requiredFeatures` | none | each of `texture-formats-tier1` and `timestamp-query` that the adapter has |
| `requiredLimits` | none: every limit is the WebGPU default | the adapter's value for `maxTextureDimension2D`, `maxBufferSize`, `maxStorageBufferBindingSize`, `maxStorageTexturesPerShaderStage`; every other limit is the default |
| Used by | tests on CI; tests locally | the application; the command line; tests locally, as a second run |

A device has only the features and limits that were requested, whatever the
adapter offers. The defaults of the four limits are 8192, 268 435 456,
134 217 728 and 4.

What a feature changes:

| Feature | Effect when enabled | Without it |
| --- | --- | --- |
| `texture-formats-tier1` | the kinds `half`, `half2`, `mask8` use `r16float`, `rg16float`, `r8unorm` | they use `r32float`, `rg32float`, `r32float` (`engine.md` 1.2) |
| `timestamp-query` | slices are timed on the GPU and two may be in flight (3.5, 3.6) | slices are timed by wall clock and one is in flight |

No profile requests `float32-filterable`, `float32-blendable`,
`texture-formats-tier2`, `shader-f16`, `subgroups` or any other feature, and no
engine, viewport or export code may depend on one. In particular nothing binds a
field with a filtering sampler, and nothing uses `read_write` storage access on a
format other than `r32float`.

No code path requires a limit above the default. The raised limits of `max`
exist so that a local run exercises a device that differs from `core`; code that
uses a value above the default reads it from `caps.limits`, has a path for the
default, and that path is the one CI runs.

### 1.3 The capability probe

```ts
interface GpuCaps {
  readonly adapter: {
    readonly vendor: string; readonly architecture: string; readonly device: string; readonly description: string;
    readonly isFallbackAdapter: boolean;
    readonly backend: string | null;            // exposed by Chromium with developer features, else null
  };
  /** A CPU rasteriser: isFallbackAdapter, or device + description matches /llvmpipe|SwiftShader|Basic Render/i. */
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
```

`caps` is filled by `openGpu` from the adapter and the created device. It is
the only source of capability facts: no code hard-codes a limit, a feature or an
adapter name. Every process that opens a device logs `caps` once as a single
JSON line prefixed `[orogen] gpu `. The application shows a permanent warning
when `caps.software` is true.

### 1.4 What the engine may assume

`openGpu` verifies rows 1 to 3 on the created device and rejects otherwise. Row
4 is guaranteed by the WebGPU specification; its storage-access part was
confirmed on a device without optional features. Everything else must be read
from `caps`.

| # | Guarantee on every device | Used for |
| --- | --- | --- |
| 1 | Every limit is at least its WebGPU default. In particular `maxTextureDimension2D ≥ 8192`, `maxStorageTexturesPerShaderStage ≥ 4`, `maxSampledTexturesPerShaderStage ≥ 16`, `maxStorageBuffersPerShaderStage ≥ 8`, `maxBufferSize ≥ 268 435 456`, `maxComputeInvocationsPerWorkgroup ≥ 256`, `maxDynamicUniformBuffersPerPipelineLayout ≥ 2` | the kernel limits of `engine.md` 3.12; 8129² fields |
| 2 | `minUniformBufferOffsetAlignment` divides 256 | the uniform arena's 256-byte slots (3.2) |
| 3 | `wgslLanguageFeatures` contains `readonly_and_readwrite_storage_textures` | in-place `field` targets |
| 4 | `r32float` supports `read_write` storage access. `r32float`, `rg32float`, `rgba16float`, `rgba32float` and `rgba8unorm` support write-only storage access and are colour-renderable. All of them bind to a `sampleType: 'unfilterable-float'` texture entry | every field kind in its fallback format; the thumbnail atlas |

Engine WGSL uses only the language features `engine.md` 3.12 lists. The headless
Dawn build is newer than the one inside Electron and accepts more; a shader that
compiles in Node is not thereby known to compile in the application.

### 1.5 Dawn in Node

The headless engine runs on the `webgpu` package (Dawn), version 0.6.2 exactly.
Earlier versions compile shaders with the unoptimised FXC compiler on Windows.

1. `createNodeGpu` calls `create(flags)` once per device and keeps the returned object in a module-level set until `GpuContext.destroy()`. If that object becomes unreachable while the device is in use, the process hangs or crashes at the next asynchronous GPU callback. Keeping the adapter or the device alive does not prevent it.
2. `create()` flags are `key=value` strings. `createNodeGpu` passes `adapter=<opts.adapter>` when given (a case-sensitive substring of the adapter's device name: `NVIDIA`, `Microsoft` for the Windows software adapter, `llvmpipe` for Mesa's). It never uses `forceFallbackAdapter`, which does not select a software adapter under Dawn.
3. `createNodeGpu` assigns the package's `globals` (`GPUBufferUsage`, `GPUTextureUsage`, `GPUMapMode`, `GPUShaderStage`) to `globalThis` once. It never stores the GPU object on `globalThis`.
4. One device per process. A second `createNodeGpu` call while a context is alive throws.
5. Shutdown order: `engine.dispose()` (destroys textures and buffers), then `gpu.destroy()`. A command-line tool then ends with `process.exit(code)` once its output is flushed. Garbage collection is never relied on to free GPU memory.
6. While a GPU promise is pending the binding busy-polls: one CPU core spins. This is expected. It makes wall-clock timing noisy when several GPU processes run at once (`testing.md` sets the concurrency).
7. Dawn reports the adapter's raw limits; Chromium reports them in buckets. Limits are never compared between the two.

Measured on the development machine (GTX 1660 Ti, Linux, Vulkan), Dawn in Node:
adapter `maxTextureDimension2D` 32768, 8 storage textures per stage, features
including `texture-formats-tier1`, `texture-formats-tier2`,
`float32-filterable`, `timestamp-query`; a `core` device reports 8192,
268 435 456, 134 217 728 and 4 for the four limits of 1.2. Electron 44 on the
same machine reports 16384 for `maxTextureDimension2D`.

### 1.6 Electron launch switches

Set in `src/platform/electron/main/switches.ts` with
`app.commandLine.appendSwitch`, before `app.whenReady()`. `enable-features` is
appended exactly once with the full comma-separated list: a second call
replaces the first.

| Platform | Switch | Reason |
| --- | --- | --- |
| all | `enable-webgpu-developer-features` | timestamp queries are not quantised; `adapter.info.memoryHeaps` is exposed (`caps.vramBytes`). To verify on the target machine; nothing fails without it |
| all | `disable-renderer-backgrounding` | the engine keeps its speed when the window is not focused |
| Linux | `enable-unsafe-webgpu` | WebGPU is off by default under X11 |
| Linux | `enable-features=Vulkan` | measured: without it the adapter is SwiftShader, a software rasteriser, with no error. Not appended when `OROGEN_ELECTRON_GPU=software` (8.2): that is how a test asks for the software adapter |
| Windows | `force_high_performance_gpu` and `force-high-performance-gpu` | selects the discrete GPU on a machine with two. Both spellings are appended; which one Electron 44 honours is not verified. No effect on the target machine, which has one GPU |

Windows needs no switch for WebGPU itself: it is on by default with the D3D12
backend.

If `caps.software` is true on Linux with the switches above, the documented
alternative set is `enable-unsafe-webgpu`, `ozone-platform=x11`,
`use-angle=vulkan`, `enable-features=Vulkan,VulkanFromANGLE`. It is not tested
on the development machine.

The Windows package keeps `dxcompiler.dll`, `dxil.dll` and `d3dcompiler_47.dll`
from the Electron distribution. Electron is 44.7.0; versions below 44.1.0 must
not be used.

---

## 2. The texture pool

Every texture behind a field comes from one pool, `src/core/gpu/pool.ts`. WebGPU
cannot report free video memory, so the pool keeps its own ledger and enforces a
byte budget. Measured: the ledger's sum equals the driver's per-process figure
exactly for `r32float`, `rgba32float`, `r16float` and `r8unorm`.

### 2.1 Keys and states

A pool texture is identified by its **shape** `(format, width, height)`, where
`format = caps.formats[kind]`. Usage, mip count and sample count are the same
for all (`engine.md` 1.3) and are not part of the key. Two kinds with one format
share free lists.

| State | Meaning | Contents |
| --- | --- | --- |
| WORKING | acquired by exactly one owner: a running node invocation, or an engine service (conversion, mask blend, thumbnails, constants) | written by its owner only |
| PUBLISHED | a finished result with a reference count ≥ 1 | immutable |
| FREE | in the free list of its shape | leftovers of the previous owner |

```
create ──► WORKING ──publish──► PUBLISHED ──last reference dropped──► FREE ──acquire(same shape)──► WORKING
              │                                                         │
              └──────────────release──────────────────────────────────► └──destroy──► gone
```

1. Published content never changes. Binding a published texture to a writable slot is rejected by `ctx.run()` before anything is encoded (`engine.md` 3.13).
2. A texture is destroyed only from FREE. The pool never calls `destroy()` on a WORKING or PUBLISHED texture, except when the engine is disposed.
3. A FREE texture is handed out again without being cleared. Its contents are undefined to the new owner (`engine.md` 1.4).
4. A texture may return to FREE, and be acquired again, while submitted work that writes it is still running: queue order keeps the results correct.

### 2.2 References

A published texture is kept alive by references. These are all the holders:

| Holder | Takes | Drops |
| --- | --- | --- |
| a cache entry (5.4) | one reference per output it holds | when the entry is evicted or replaced |
| the running evaluation (5.3) | one reference per published texture that the running node reads, that a node not yet run will read, or that an undelivered target needs | when the last such reader has settled and the target is delivered, or the evaluation settles |
| a `FieldHandle` | one reference per handle | `release()` |

A published texture is **pinned** when at least one of its references is not a
cache entry's. Evicting a cache entry never frees a pinned texture.

```ts
/** A reference to published content, for code outside the evaluator: the session, the viewport, the build pipeline. */
interface FieldHandle<K extends 'field' | 'color' = 'field' | 'color'> {
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
type AnyFieldHandle = FieldHandle<'field'> | FieldHandle<'color'>;
```

- Reading `texture` or `view` after `release()` throws `FieldAccessError`; after the device of its epoch is lost it throws `DeviceLostError`.
- A second `release()` throws `FieldAccessError`. `release()` on a handle of a lost epoch does nothing.
- Handles never leave the engine thread (7.2).
- A holder of a handle reads the texture; it never writes it, never destroys it and never keeps the `GPUTexture` beyond `release()`.

### 2.3 The pool as the runtime sees it

```ts
interface PoolTexture {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly kind: FieldKind;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

interface TexturePool {
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

interface MemoryReport {
  readonly budgetBytes: number;
  readonly workingBytes: number;
  readonly cacheBytes: number;       // published and not pinned: evictable
  readonly pinnedBytes: number;      // published and pinned
  readonly freeBytes: number;
  readonly reservedBytes: number;
  readonly drainingBytes: number;
}

declare class BudgetExceededError extends Error {
  readonly requestedBytes: number;
  readonly kind: FieldKind;
  readonly width: number;
  readonly height: number;
  readonly report: MemoryReport;
}
```

`ctx.alloc`, `ctx.clone` and the shared ops call `acquire`; `ctx.release` calls
`release`. Only the evaluator calls `publish`, `retain` and `drop`. A wrong
state for any call is a programming error and throws.

### 2.4 The ledger and the budget

```
bytes(texture) = width × height × bytesPerTexel(format)
                 r8unorm 1, r16float 2, r32float 4, rg16float 4, rg32float 8, rgba16float 8, rgba32float 16

working    = Σ bytes of WORKING textures
published  = Σ bytes of PUBLISHED textures, each counted once whatever its reference count
             = cacheBytes + pinnedBytes
free       = Σ bytes of FREE textures
reserved   = Σ of live reserve() registrations
draining   = Σ bytes of destroyed textures whose memory the driver has not yet returned (2.6)

committed  = working + published + free + reserved
```

**Invariant.** After every successful `acquire`, `committed ≤ budget`.
`draining` is outside the invariant: it is transient and bounded (2.6).

`reserved` holds everything the engine allocates outside the pool, each
registered with `reserve()`: the uniform arena (1 MiB), the readback staging
buffer (at most 64 MiB), LUT buffers, the thumbnail atlas (16 MiB), the
statistics buffers, the 1 × 1 default and sink textures, and every texture and
buffer of the viewport renderer.

**Budget.**

```
budget = floor(vram × fraction)
vram     = the preference `gpu.vramBytes` when set, else caps.vramBytes, else 4 × 2^30
fraction = the preference `gpu.budgetFraction`, default 0.6, allowed 0.3 .. 0.85
```

The fraction leaves room for the desktop, for the Unreal editor on the same
card, and for `draining`. On the target machine (10 GB) the default budget is
about 6 GB. Headless, `budgetBytes` is an explicit option of `createEngine`
(5.1).

Measured: Dawn in Node reports no `memoryHeaps`, so `caps.vramBytes` is `null`
there and the formula gives 4 GiB × 0.6 = 2.4 GiB. That is less than the state
of the largest simulations at 8129 (`simulation.md` 1.5). A headless caller
that builds at 8129 passes the budget of its machine (`--budget-mb`,
`export-unreal.md` 3.11 and `testing.md` 8.6); without one it gets 2.4 GiB.

### 2.5 `acquire`

`acquire(kind, w, h)` is synchronous. With `need = bytes` of the requested
shape, it repeats these steps until one returns:

1. If the free list of the exact shape is not empty, take its most recently freed texture. Return it.
2. If `committed + need ≤ budget`, create the texture (below). Return it.
3. If any FREE texture exists, destroy the largest one (ties: the least recently freed) by the procedure of 2.6. Repeat.
4. If an evictable cache entry exists, evict the first in eviction order (2.7). Repeat.
5. Throw `BudgetExceededError`.

A texture is reused only for its exact shape. There are no size classes.

Creation is one synchronous block:

```ts
device.pushErrorScope('out-of-memory');
const texture = device.createTexture(descriptor);
const pending = device.popErrorScope();          // awaited later, never here
```

`pending` is recorded against the owner. The evaluator awaits it before the
owner publishes (5.5); a non-null result is a GPU out-of-memory failure (5.8).

`acquire` rejects a side outside 1..8192 with `RangeError` before any of the
steps.

### 2.6 Destroying a texture

Measured on Dawn: after `destroy()` the driver keeps the memory until one
further submission has completed; a texture created in between is held in
addition.

1. Before the pool destroys a texture it submits the open slice (3.1), so that no unsubmitted command refers to a destroyed texture.
2. `destroy()` moves the texture's bytes from `free` to `draining`.
3. After the last destroy of one `acquire` or `trim` call the pool submits an empty command buffer (a **barrier**). When that submission's `onSubmittedWorkDone()` resolves, the bytes destroyed before it leave `draining`.
4. `committed + draining` may therefore exceed the budget between a destroy and the completion of its barrier, by at most the bytes destroyed in that interval. The evaluator bounds the interval: it awaits a completed submission after every node (5.5), and it calls `trim`, which awaits its barrier, at the points of 2.8 where gigabytes change shape.

### 2.7 Eviction order

Cache entries are evicted in this order:

1. transient entries (5.4), oldest generation first;
2. the remaining entries, least recently used first.

An entry is **evictable** when dropping it would move at least one texture to
FREE, that is when at least one of its textures has no reference but the
entry's. Entries the running evaluation still needs hold a second reference
(2.2) and are therefore skipped without a separate rule. Eviction drops the
entry's references and removes the entry; a texture that reaches zero becomes
FREE and is then reused or destroyed by the loop of 2.5.

Entries that name one texture (a pass-through, 5.6) keep each other from being
evictable alone. When no entry is evictable and such a texture has no
reference but cache entries', its entries are evicted in order until it is
FREE.

### 2.8 Preview and build

| | Preview evaluation (`mode: 'preview'`) | Build evaluation (`mode: 'build'`) |
| --- | --- | --- |
| Cache | reads and writes the cache (5.4) | neither reads nor writes it |
| A node's outputs live | until evicted, and at least as long as pinned | until the last node that reads them has run and their targets are delivered; then FREE |
| Peak memory | bounded by the budget through eviction | the widest cut of the plan, checked before the first node runs, plus the running node's working set, checked when the node allocates it (5.3) |
| FREE textures | kept for reuse; destroyed on demand (2.5) | the same |

`trim({ keepResolution })` destroys every FREE texture whose width differs from
`keepResolution` (all of them when it is omitted), submits a barrier and
resolves when it has completed. `Engine.trim` (5.1) first evicts every cache
entry of another resolution (all entries when omitted), then calls it.

The session calls `Engine.trim`:

| When | `keepResolution` |
| --- | --- |
| the preview resolution changes (`buildResolution` or `previewLevel` edited) | the new preview resolution |
| a build starts | none: the cache is emptied; only pinned content survives |
| a build ends | the preview resolution |

---

## 3. The command stream

`src/core/gpu/stream.ts` owns the one `GPUCommandEncoder` through which all
compute work on pool textures reaches the device. Nodes, ops, conversions, mask
blends, thumbnails, statistics and readback copies encode into it. Nobody else
holds an encoder, with one exception: the viewport renderer has its own (7.5),
which reads pool textures and never writes one.

### 3.1 Slices

A **slice** is one `queue.submit()` of the stream: one command buffer and the
uniform bytes it uses. The **open slice** is the one being encoded.

1. A slice holds the work of one **owner**: one node invocation, or one engine service call. A change of owner closes the open slice.
2. Consecutive runs in a slice share one compute pass. A clear (a render pass with `loadOp: 'clear'`) or a texture copy ends the pass; the next run begins a new one.
3. A texture view is created once per pool texture. Group-1 bind groups are cached for the duration of one `evaluate()` call of a node, keyed by kernel name and the identities of the bound textures and LUTs in declaration order; the cache is dropped when that call settles.
4. Every run and every tile contributes a **work estimate** (3.3) to the slice.

The open slice is closed and submitted when any of these happens:

- its estimated time reaches the slice target (3.5);
- the owner changes;
- the uniform arena is full (3.2);
- an operation that acts on the queue must keep its place in the order: `ctx.write`, a readback mapping, the pool destroying a texture (`engine.md` 3.11);
- a caller waits: `ctx.flush`, a `ctx.loop` batch boundary, `ctx.read`, `ctx.stats`, the end of `evaluate()` (3.6).

Submission is one synchronous block, and no error scope is ever open across an
`await` (5.8):

```ts
device.pushErrorScope('validation');
device.pushErrorScope('out-of-memory');
queue.writeBuffer(arena, 0, staging, 0, usedBytes);
queue.submit([encoder.finish()]);
const oom = device.popErrorScope();              // both awaited later, attributed to the slice's owner
const validation = device.popErrorScope();
```

### 3.2 The uniform arena

`engine.md` 3.11 fixes the binding model: group 0 holds `frame` and `P` as
256-byte slots of one buffer, bound with dynamic offsets. The stream implements
it as follows.

1. The arena is one `GPUBuffer` of 1 MiB with usage `UNIFORM | COPY_DST`, and a CPU-side `ArrayBuffer` of the same size (the staging copy).
2. A run takes one slot for its `Params` (when the kernel has params) and one `Frame` slot per tile. Slots are taken in order from offset 0. `run()` writes into the staging copy and never calls `queue.writeBuffer`.
3. The staging copy is uploaded once per slice, in the submission block, and the slot cursor returns to 0. The arena may be rewritten for the next slice while earlier slices are still running: the upload and the submit keep their order on the queue.
4. When a run does not fit in the remaining slots, the open slice is submitted first.
5. A buffer referenced by an unsubmitted command is never written by any other route. LUT buffers are created with their contents (`mappedAtCreation`) and never rewritten.

### 3.3 Work estimates and learned throughput

```
work(dispatch) = texels written by the dispatch × cost         cost: engine.md 3.15 rule 4
estimate(dispatch) = work × rate[kernel]                        milliseconds
```

`rate[kernel]` is the stream's estimate of GPU milliseconds per unit of work for
that kernel name, kept per device epoch.

1. A kernel that has not run on this device starts at `RATE_INITIAL = 1e-7` ms per unit (*to calibrate*). The value is pessimistic on purpose: measured costs on the GTX 1660 Ti are 6e-9 to 1.5e-8 ms per unit. A pessimistic start produces small first tiles, which cost nothing measurable.
2. When a slice completes with measured duration `dt` (3.5) and estimate `est`, the rate of every kernel in the slice becomes the rate its dispatches in that slice were estimated with, multiplied by `clamp(dt / est, 0.5, 2)`. The factor applies to the rate behind `est`, not to the current one: with two slices in flight (3.6) the second is estimated before the first completes, and multiplying the current rate would apply one correction twice.
3. When `dt` exceeds the hard ceiling (3.5), the clamp's upper bound does not apply for that update.
4. The first slice that uses a new pipeline or a new texture measures several times too long. The clamp absorbs it; no sample is treated specially.
5. Rates are not persisted and are reset when the device is replaced.
6. `rate[kernel]` never exceeds `100 × RATE_INITIAL` except through rule 3 (*to calibrate*). The cap keeps a duration that is not the kernel's own (the completion latency of 3.5) from shrinking slices without bound.
7. `rate[kernel]` never falls below `0.01 × RATE_INITIAL` (*to calibrate*). The floor keeps slices too short to be measured (a timestamp difference of zero, a node that waits after every small run) from halving a rate towards zero, which would let a later long run of the same kernel through as one slice.

### 3.4 Tiles

A run whose estimate exceeds the slice target is split into **tiles**:
horizontal bands of the written grid, each its own dispatch with its own
`Frame` slot, differing only in `frame.tileOrigin`.

```
rowsPerTile = clamp(floor(target / (width × cost × rate) / wgY) × wgY, wgY, height)
tile t covers rows [t × rowsPerTile, min((t + 1) × rowsPerTile, height)),  tileOrigin = (0, t × rowsPerTile)
dispatchWorkgroups(ceil(width / wgX), ceil(rowsInTile / wgY))
```

`wgX`, `wgY` are the kernel's workgroup size and `target` the slice target.

1. Tiles are encoded in order of increasing row. Each adds its estimate to the open slice, so a long run spans several slices.
2. Tiling never changes a result (`engine.md` 3.14). Measured: output is bit-identical for 1 to 65 bands and the overhead per band is below measurement noise.
3. A kernel declared `tiled: false` is always one dispatch. When its estimate exceeds the hard ceiling, `ctx.run()` throws and the node fails with kind `'watchdog'` (5.8): `kernel "<name>" cannot be tiled and one dispatch is estimated at <n> ms; the limit is 500 ms`.
4. The texture copies and clears the stream encodes are not tiled.

### 3.5 Slice targets and the hard ceiling

| Evaluation | Slice target | Estimated time of a submitted slice |
| --- | --- | --- |
| `mode: 'preview'` (previews, drafts, thumbnails) | 8 ms | 8 to 16 ms |
| `mode: 'build'` | 75 ms | 75 to 150 ms |

Both targets are *to calibrate*. A slice is closed as soon as its estimate
reaches the target and no tile is estimated above the target, so a slice is
estimated below twice the target.

**Hard ceiling: 500 ms.** No dispatch is encoded whose estimate exceeds it
(3.4 rule 3), and a measured slice above it corrects the rates at once (3.3
rule 3) and raises an `engine-error` event that is not fatal (7.7). The ceiling
exists because Windows resets a GPU that cannot be pre-empted for about two
seconds, and such a reset also resets every other program on the card.

**Measured duration of a slice.** With `caps.timestampQuery`, the GPU time
between the beginning and the end of the slice's compute passes, from
`timestampWrites`. Otherwise the wall time from the submit to the resolution of
`onSubmittedWorkDone()`, which is meaningful only with one slice in flight.

The wall time includes the latency with which a completion is reported, and
that latency can exceed the slice. Measured in Electron with the viewport
drawing every frame: completions were reported 16 to 50 ms late for more than
6 s, and one 0.7 ms pass was reported as 39 to 50 ms. Uncorrected, an 8 ms
target then raises every rate on every slice. Without `caps.timestampQuery`
therefore (both rules *to calibrate* on the target machine):

1. `dt` is the wall time minus `latency`, floored at 0. `latency` is the completion time of the most recent barrier (2.6) or empty submission; the stream measures it again with an empty submission whenever it has been idle for 250 ms.
2. A slice whose wall time is below `2 × latency` is not resolved: its `dt` is unknown but at most its wall time. Such a slice never raises a rate, and lowers one by `clamp(wall / est, 0.5, 1)` in place of the factor of 3.3 rule 2. Measured on Dawn in Node: with `dt` floored at 0 for these slices, every kernel that runs in short slices fell to the floor of 3.3 rule 7 within seven slices.

### 3.6 Waiting

`run()` never waits. Waiting happens only in the calls below. The **in-flight
limit** is the number of submitted slices that may be unfinished at once:

```
inFlightLimit = caps.timestampQuery ? 2 : 1
```

| Call | Submits the open slice, then resolves when |
| --- | --- |
| `ctx.flush()`, `ctx.read`, `ctx.stats`, the end of `evaluate()` | every submitted slice has completed (`onSubmittedWorkDone()` after the last submit) |
| a `ctx.loop` batch boundary | fewer than `inFlightLimit` slices are unfinished; after the last iteration, when all have completed |

`ctx.loop(iterations, body)` proceeds as follows:

```
for i = 0 .. iterations − 1:
    check cancellation (3.7)
    body(i)                                   // encodes; slices that fill up are submitted on the way
    if a slice was submitted since the last boundary, or i is the last iteration:
        batch boundary:
            submit the open slice
            refresh preview loans (5.11)
            wait as the table says
            check cancellation, device loss, and the error scopes of completed slices
            report progress (5.10)
```

1. This is the wait `engine.md` 4.7 describes for `ctx.loop`. With a limit of 2 the loop goes on encoding while one slice runs and waits only when a second is submitted; the queue never holds more than two slices, and a batch still ends with a real wait. With slices of 8 ms, waiting for each one before encoding the next was measured in Electron to cost 1.2 to 1.6 ms per iteration against 0.8 with two in flight.
2. The number of iterations per batch is not computed separately: it is however many iterations fill one slice at the current rate. Because a rate changes by at most a factor of two per slice, so does the batch.
3. At a batch boundary nothing is left unsubmitted. Whatever is drawn or read at a boundary therefore sees complete iterations.
4. The in-flight limit holds wherever the stream can wait. Outside a loop a node encodes without waiting, and slices that fill up are submitted as they do. The work queued that way is bounded by the authoring rules of `engine.md` 3.15 (a bounded number of runs, a bounded cost per run), not by the stream. It is submitted in slices of the target size, so the GPU remains pre-emptible, but it cannot be cancelled once submitted.
5. Yielding is always an awaited GPU completion, never a timer.

### 3.7 Cancellation points

The abort signal of an evaluation, and the device-lost flag, are checked:

| Where | Effect when set |
| --- | --- |
| before each node starts | the node and everything after it is skipped |
| on entry to every `EvalContext` method | the method throws (`engine.md` 4.7) |
| before `body(i)` and at every batch boundary of `ctx.loop` | `loop` rejects |
| before every submit | the open slice is discarded; an encoder may be dropped without `finish()` |
| when any awaited runtime promise resolves: slice completion, readback, statistics, pipeline compilation, `ctx.cpu`, `ctx.readFile`, `externalKey` | the caller rejects |

Submitted slices cannot be recalled. After an abort the evaluation settles
within `inFlightLimit` slices plus the synchronous section in progress; it does
not wait for the cancelled node's fields, which return to the pool at once
(2.1 rule 4).

---

## 4. The document

### 4.1 Types

```ts
interface PortRef { readonly node: string; readonly port: string }

interface ProjectSettings {
  readonly terrainSize: number;        // metres across the terrain
  readonly heightRange: number;        // metres represented by height 1.0
  readonly seed: number;               // project seed, integer 0 .. 2^32 − 1
  readonly buildResolution: number;    // vertices per side of a build (engine.md 1.5)
  readonly previewLevel: number;       // ladder level of buildResolution used for previews
  readonly seaLevel: number;           // normalised height
}

interface NodeInstance {
  readonly id: string;
  readonly type: string;               // NodeDef.type
  readonly version: number;            // NodeDef.version the params were stored with
  readonly position: { readonly x: number; readonly y: number };
  readonly params: Readonly<Record<string, unknown>>;
  readonly title?: string;             // user's label; default NodeDef.title
  readonly bypass?: boolean;           // default false
  readonly collapsed?: boolean;        // default false
}

interface Edge { readonly id: string; readonly from: PortRef; readonly to: PortRef }   // from an output, to an input

/** A visual group of nodes in the graph editor. It has no effect on evaluation. */
interface NodeGroup {
  readonly id: string;
  readonly title: string;
  readonly color?: string;             // '#rrggbb'
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

interface ViewBinding {
  readonly height?: PortRef;           // the terrain shown; absent: a flat plane
  readonly overlay?: { readonly ref: PortRef; readonly as: 'color' | 'mask' | 'heat'; readonly opacity: number };
  readonly locked?: boolean;           // true: selecting a node does not change the view
}

interface GraphDoc {
  readonly format: 'orogen';
  readonly version: 1;                 // version of this schema
  readonly settings: ProjectSettings;
  readonly nodes: Readonly<Record<string, NodeInstance>>;
  readonly edges: Readonly<Record<string, Edge>>;
  readonly groups: Readonly<Record<string, NodeGroup>>;
  readonly ui: {
    readonly view?: ViewBinding;       // 7.4
    readonly graphViewport?: { readonly x: number; readonly y: number; readonly zoom: number };
  };
}
```

A `GraphDoc` is plain JSON: no typed arrays, no class instances, no functions.
Collections are records keyed by id, never arrays. A document object is never
mutated; a change produces a new object that shares what did not change.

The member name `NodeInstance.post` is reserved for a later per-node
post-process stack. Nothing reads or writes it in this version.

### 4.2 Settings

| Setting | Default | Valid | Enters cache keys |
| --- | --- | --- | --- |
| `terrainSize` | 5000 | 1 .. 1 000 000 | every node |
| `heightRange` | 2500 | 1 .. 100 000 | every node |
| `seed` | 0 | integer 0 .. 2^32 − 1 | nodes with a `seed` param |
| `buildResolution` | 4033 | 1009, 2017, 4033, 8129, or a custom value valid by `engine.md` 1.5 | never |
| `previewLevel` | 2 | integer `k ≥ 0` for which level `k` of `buildResolution` is defined | never |
| `seaLevel` | 0 | finite | nodes that declare `uses: ['seaLevel']` |

```
previewResolution = (buildResolution − 1) / 2^previewLevel + 1
```

When `buildResolution` changes and `previewLevel` is no longer a defined level,
`setSettings` (4.6) lowers `previewLevel` to the largest defined one. Resolution
is not part of any key (5.4): it selects which cache a result lives in.

**Sea level.** Every texel whose height is at or below `seaLevel` is sea: an
outlet for routing and a sink for erosion (`simulation.md` 1.3). The viewport
draws its sea plane at this height (7.5), and by default an export places this
height at Unreal world Z = 0 (`export-unreal.md` 5.5). The default 0 puts the
sea at the bottom of the height range, so a terrain that touches height 0 has
sea there. A value below the terrain's lowest height, for example −1, means no
sea for the nodes that declare `uses: ['seaLevel']`.

### 4.3 Graph validity

```ts
/** null when the connection is legal, else a one-sentence reason. src/core/graph/validate.ts */
declare function validateConnection(doc: GraphDoc, registry: NodeRegistry, from: PortRef, to: PortRef): string | null;
/** The kind an output carries: resolves `sameAs` through the connections. null: not determinable (unconnected `any` input, unknown type). */
declare function outputKind(doc: GraphDoc, registry: NodeRegistry, ref: PortRef): 'field' | 'color' | null;
```

1. `from` names an output of an existing node of a known type; `to` names an input of another. A `maskable` node also has the input `mask` (`engine.md` 4.13).
2. An input has at most one edge. An output may have any number.
3. The graph has no cycle.
4. `field` and `color` ports connect in every combination; the evaluator converts (5.6).
5. A document may contain what these rules forbid (a file edited by hand, a node type removed from the product). The evaluator ignores an edge that breaks rule 1; where an input has several edges it uses the first in record order; and it reports a cycle on every node in it (5.8). Nothing is deleted.
6. `ui.view` may name a node or port that does not exist. Such a reference is ignored (7.4).

The graph editor and the evaluator both use `validateConnection`; neither has
rules of its own.

### 4.4 Parameter normalisation

```ts
/** src/core/graph/params.ts. Pure. */
declare function normalizeParams(def: NodeDef, stored: Readonly<Record<string, unknown>>): {
  readonly values: Readonly<Record<string, ParamValue>>;   // every declared name, in declaration order
  readonly problems: readonly string[];                    // one sentence per value that was changed
  readonly error: string | null;                           // non-null: the node cannot be evaluated
};
```

| Kind | A stored value is accepted when | Then | Otherwise |
| --- | --- | --- | --- |
| `float` | a finite number | clamped to `min..max` unless `soft` | default |
| `int` | a finite number | rounded to the nearest integer, clamped | default |
| `bool` | a boolean | | default |
| `enum` | one of the option values | | `error`: `param "<name>": unknown value "<value>"` |
| `seed` | a finite number | `Math.floor(v)` modulo 2^32, as an unsigned integer | default |
| `vec2` | an array of 2 finite numbers | each clamped unless `soft` | default |
| `color` | an array of 3 finite numbers | each clamped to 0..1 | default |
| `curve` | an array of points with finite `x`, `y` | clamped to 0..1, sorted by `x`, later points with an equal `x` dropped; default when fewer than 2 remain | default |
| `gradient` | an array of stops with finite `t` and colour | clamped to 0..1, stably sorted by `t`; default when fewer than 2 remain | default |
| `file` | a string | | `''` |
| `text` | a string | truncated to `maxLength` | default |

A missing name gives the default without a problem. A stored name the node does
not declare is ignored and kept in the document. Normalisation never changes
the document; it produces `ctx.params` and the `P` of the cache key.
`normalizeParams` is the only implementation of these rules: the loader,
`setParam` and the evaluator call it.

### 4.5 Files

Project files have the extension `.orogen` and hold UTF-8 JSON.

```ts
interface DocProblem { readonly nodeId?: string; readonly edgeId?: string; readonly message: string }
declare class DocFormatError extends Error {}

/** src/core/graph/serialize.ts */
declare function parseDoc(text: string, registry: NodeRegistry): { readonly doc: GraphDoc; readonly problems: readonly DocProblem[] };
declare function serializeDoc(doc: GraphDoc): string;
declare function newDoc(): GraphDoc;       // the settings defaults of 4.2, no nodes
declare function newId(): string;          // 10 characters of base 36 from crypto.getRandomValues; the only source of the ids the commands create
```

An id is any non-empty string except `__proto__`: `parseDoc` accepts the ids a
file holds (`fbm`, `talus`), and the record key of a node, edge or group equals
its `id`.

`parseDoc` throws `DocFormatError` when the text is not JSON, when `format` is
not `'orogen'`, or when `version` is greater than 1 (`written by a newer version
of Orogen`). Otherwise it returns a document and a list of problems:

| Found in the file | In the returned document | Problem reported |
| --- | --- | --- |
| a setting missing or invalid | the default, or the value clamped | yes |
| a node of an unknown type | unchanged, every member kept | yes |
| a node with `version` lower than `NodeDef.version` | `migrate` applied once per step (`engine.md` 4.6), `version` raised; unchanged when `migrate` throws | when `migrate` throws |
| a node with `version` higher than `NodeDef.version` | unchanged | yes |
| a param outside its hard limits | the normalised value | yes |
| an edge that breaks 4.3 | unchanged | yes |
| a collection (`nodes`, `edges`, `groups`, `ui`) missing or not an object | an empty one | yes |
| an entry that is not an object of its collection's shape, or whose key cannot be an id | removed | yes |
| a member of the wrong type in the document (`version`), a node, a group or `ui`; an `id` that differs from its record key | `version` 1, `position` (0, 0), `params` empty, a group's `title` empty, an optional member removed; the key | yes |

`serializeDoc` returns `JSON.stringify(doc, null, 2)` plus a newline. Members
keep the order in which the document holds them, so a node the loader left
unchanged is written back exactly as it was read: a file from a newer build of
a node, or with a node type this build lacks, is never damaged by opening and
saving it.

### 4.6 Commands

Every change to a document is made by one of these functions, in
`src/core/graph/commands.ts`. Each is a recipe: it mutates the draft it is
given and touches nothing else. The application runs recipes inside a
transaction (8.5); tests run them on a `structuredClone`. No other code changes
a `GraphDoc`.

```ts
/** T with every `readonly` removed, at every depth. Mutually assignable with immer's Draft<T>, which the recipes of 8.5 receive. */
type Mutable<T> =
  T extends readonly (infer E)[] ? Mutable<E>[]
  : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T;
type DocDraft = Mutable<GraphDoc>;
interface DocFragment { readonly nodes: readonly NodeInstance[]; readonly edges: readonly Edge[] }   // clipboard content

declare function addNode(doc: DocDraft, registry: NodeRegistry, type: string, position: { x: number; y: number }): string;   // returns the id
declare function removeNodes(doc: DocDraft, ids: readonly string[]): void;                 // also removes their edges
declare function connect(doc: DocDraft, registry: NodeRegistry, from: PortRef, to: PortRef): string;   // replaces the edge into `to`; throws when validateConnection fails
declare function disconnect(doc: DocDraft, edgeIds: readonly string[]): void;
declare function setParam(doc: DocDraft, registry: NodeRegistry, nodeId: string, name: string, value: unknown): void;   // stores the normalised value
declare function resetParam(doc: DocDraft, registry: NodeRegistry, nodeId: string, name: string): void;
declare function setNodeFlags(doc: DocDraft, nodeId: string, flags: { bypass?: boolean; collapsed?: boolean; title?: string | null }): void;
declare function moveNodes(doc: DocDraft, ids: readonly string[], delta: { x: number; y: number }): void;
declare function copyNodes(doc: GraphDoc, ids: readonly string[]): DocFragment;             // the nodes and the edges between them
declare function pasteNodes(doc: DocDraft, registry: NodeRegistry, fragment: DocFragment, at: { x: number; y: number }): string[];   // new ids
declare function setGroup(doc: DocDraft, group: NodeGroup): void;
declare function removeGroups(doc: DocDraft, ids: readonly string[]): void;
declare function setSettings(doc: DocDraft, patch: Partial<ProjectSettings>): void;         // validates; fixes previewLevel
declare function setView(doc: DocDraft, view: ViewBinding | null): void;
declare function setGraphViewport(doc: DocDraft, viewport: { x: number; y: number; zoom: number }): void;
```

`removeNodes` leaves `ui.view` alone, even when it names a removed node. Only
`setView` and `setGraphViewport` write under `ui`.

---

## 5. The evaluator

### 5.1 The engine

```ts
interface NodeRegistry {
  get(type: string): NodeDef | undefined;
  list(): readonly NodeDef[];            // in the order of the list the registry was made from
}

/** src/core/graph/registry.ts; re-exported by runtime.ts and api.ts. Pure. Throws NodeDefError for two definitions of one type. */
declare function createRegistry(defs: readonly NodeDef[]): NodeRegistry;

/** src/core/nodes/index.ts, which exports it: every NodeDef of the nine categories, sorted by type. Importing the module runs every defineNode, defineKernel and defineCpuTask of the product. */
declare const nodes: readonly NodeDef[];

interface EngineOptions {
  readonly gpu: GpuContext;
  readonly registry: NodeRegistry;
  readonly files: FileSource;            // 6.1
  readonly cpu: CpuRunner;               // 6.3
  readonly budgetBytes: number;          // 2.4
  readonly test?: EngineTestHooks;       // 5.14
}

/** src/core/engine.ts. Resolves when the engine's own kernels are compiled; rejects when one fails.
 *  The first call seals defineLib, defineKernel, defineCpuTask and defineNode (engine.md, Module scope). */
declare function createEngine(opts: EngineOptions): Promise<Engine>;

interface Engine {
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

  memory(): MemoryReport;
  trim(opts?: { keepResolution?: number }): Promise<void>;       // 2.8
  setBudget(bytes: number): void;
  setFiles(files: FileSource): void;
  replaceDevice(gpu: GpuContext): Promise<void>;                 // 5.9
  dispose(): Promise<void>;
}
```

The engine owns the pool, the stream, the pipeline cache, the result cache and
the evaluator. It is the whole headless product: the command line, the tests
and the session (section 7) all drive this one object.

`read` and `stats` may be called at any time, also from `onTarget` (5.2); they
are engine services and take their place in the stream. `trim`, `setFiles`,
`replaceDevice` and `dispose` wait until the running evaluation has settled.
After `dispose()` has resolved, a new engine may be created on the same
`GpuContext`. `dispose()` also disposes the `CpuRunner` the engine was given
(6.3): the runner belongs to its engine.

**Where a registry comes from.** There is one explicit model: a program builds
its registry from a list of definitions with `createRegistry` and passes it to
whatever needs it. Nothing collects nodes implicitly.

| Program | Registry |
| --- | --- |
| the engine worker (8.3), the command line (`src/cli/`, `src/export/cli.ts`), the interface (`src/app/main.tsx`) | `createRegistry(nodes)`, each once at start-up |
| both CPU-worker entry files (6.3) | none: they import `src/core/nodes/index.ts` so that every CPU task is defined in their thread |
| the test harness | `createRegistry` of the reference nodes, its own source node and the definitions the test file hands it (`testing.md` 2.1) |

The session and a build read the registry from `Engine.registry`. The functions
of section 4 take it as an argument; panels read it from `CommandContext` (8.8).

### 5.2 `evaluate()`

```ts
type EvalTarget =
  | { readonly ref: PortRef; readonly as?: 'field' | 'color' }   // an output port, optionally converted (5.6)
  | { readonly node: string };                                   // run this node; no field is returned

interface EvaluateOptions {
  readonly resolution: number;
  readonly mode: 'preview' | 'build';
  readonly requestId: number;
  readonly signal?: AbortSignal;
  readonly outputs?: 'all' | 'needed';
  readonly cache?: 'keep' | 'transient';
  readonly thumbnails?: boolean;
  readonly onEvent?: (e: EvalEvent) => void;                     // 5.10
  readonly onTarget?: (index: number, field: AnyFieldHandle | null) => Promise<void>;
  readonly onLoans?: (nodeId: string, loans: Readonly<Record<string, TextureRef>> | null) => void;   // 5.11
}

/** A texture as a viewer binds it: a loan (5.11) or published content (7.5). */
interface TextureRef { readonly view: GPUTextureView; readonly width: number; readonly height: number; readonly kind: 'field' | 'color' }

interface EvaluateResult {
  readonly requestId: number;
  readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  readonly fields: readonly (AnyFieldHandle | null)[];           // fields[i] belongs to targets[i]
  readonly errors: readonly NodeError[];                         // 5.8; one per failed node, in plan order
  readonly timing: { readonly wallMs: number; readonly nodesRun: number; readonly nodesCached: number };
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `resolution` | required | Vertices per side of every field that crosses a port: `ctx.res`. An integer 2 .. 8192. The session passes ladder levels only |
| `mode` | required | Selects the slice target (3.5) and the memory policy (2.8). A node cannot observe it and it is in no key |
| `requestId` | required | An integer greater than that of every earlier call on this engine. Echoed in every event and in the result |
| `signal` | none | Cancels the evaluation (3.7) |
| `outputs` | `'all'` in preview, `'needed'` in build | `'needed'`: an output is wanted when a node of the plan reads it or a target names it. `'all'`: every output of every node of the plan is treated as a target, so `ctx.wants()` is true everywhere and viewing another port of an evaluated node never re-runs it |
| `cache` | `'keep'` | Preview only. `'transient'` marks the entries this evaluation creates or hits (5.4) |
| `thumbnails` | `true` in preview, `false` in build | 5.12 |
| `onEvent` | none | Called synchronously, in order. It must not throw |
| `onTarget` | none | Staged delivery, below |
| `onLoans` | none | Called synchronously at a batch boundary when the running node's loans begin or change, with the lent textures by output port, and with `null` when they are withdrawn (5.11). It must not throw |

**The promise.**

1. `evaluate()` never rejects because a node failed, the signal aborted or the device was lost: `status` says which. It rejects with `TypeError` for a malformed call: a resolution out of range, a `requestId` that does not increase, a target naming a node or an output the document lacks.
2. One evaluation runs at a time. A call made while another runs starts when that one has settled. Pre-empting is the caller's job: abort, then call.
3. `status`: `'device-lost'` when the device was lost; else `'aborted'` when the signal aborted before the last node finished; else `'errors'` when at least one node failed; else `'ok'`.
4. The document is not retained after the promise settles.
5. `timing.nodesRun` counts the nodes whose `evaluate()` ran and ended `node-done`, `timing.nodesCached` the nodes that were cache hits. A bypassed node is in neither.

**Ownership of the result.** `fields[i]` is a handle retained for the caller,
who calls `release()` on it exactly once, or `null`. It is `null` for a node
target, for a target whose node failed or was skipped, for every target when
`onTarget` is given, and for every target when the status is `'aborted'` or
`'device-lost'`. A target with `as` yields the converted field. Content behind a
returned handle is pinned (2.2) until the handle is released; nothing the
evaluator does later can recycle it.

**Staged delivery.** With `onTarget`, the evaluator calls
`onTarget(i, field)` once for each target, as soon as that target is published,
and waits for the returned promise before it runs another node. The handle is
valid until the promise settles; the evaluator releases it. For a node target
`field` is `null`. Targets that fail are not delivered. When the promise
rejects, the evaluation stops as if aborted and `evaluate()` rejects with the
same reason. In build mode a target's memory is therefore held only while it is
being consumed.

### 5.3 The plan

`evaluate()` works in this order:

1. **Order.** The plan is the depth-first post-order from the targets, in the order given, visiting each node's connected inputs in declaration order (the `mask` input of a `maskable` node last). Each node appears once. Nodes no target depends on are not in the plan. A bypassed node (5.6) is in the plan but is never run.
2. **Blocked nodes.** Before any GPU work, each node of the plan is checked: unknown type, version newer than the build, cycle, unconnected required input, parameter error (5.8). A node that fails a check, and every node with an input connected to a failed or skipped node, will not run. This includes optional inputs: a node is never evaluated as if a failing input were unconnected. An edge that 4.3 rule 5 makes the evaluator ignore counts as no connection: its consumer is checked as unconnected, so a required input reports `missing-input` and the consumer is not skipped as downstream of the edge's source.
3. **Keys.** For every remaining node the key is computed (5.4), awaiting its `externalKey` at most once per call.
4. **Wanted outputs**, by the `outputs` option.
5. **Cache lookup** (preview). A node whose entry holds every wanted output is `cached`. The evaluation takes its references (2.2) on every published texture the plan will read.
6. **Memory check** (build). The evaluator computes `outputPeakBytes`: the largest sum, over the steps of the plan, of the bytes of all wanted outputs, conversions and mask blends that are alive at that step, with each one alive from the step that produces it to the step of its last reader or its delivery. Aliases are counted as textures. When `outputPeakBytes + reservedBytes + pinnedBytes > budget`, no node runs, every target fails, and the node at whose step the peak occurs gets an error of kind `'budget'`. Every other node of the plan that could have run is skipped with reason `'upstream'`, naming that node, also when it is not downstream of it: the reason says which node stopped the build. A node's own working memory is not in this sum. A node whose working state does not fit fails with kind `'budget'` when it allocates that state: before its first loop (`engine.md` 1.4), or, for a coarse-to-fine node, at its last refinement (`simulation.md` 1.5). The nodes before it in the plan have run by then.
7. **Compilation.** The kernels of all nodes that will run are compiled in parallel with `createComputePipelineAsync`, each once per device epoch. A node one of whose kernels fails joins the blocked nodes.
8. `eval-start` is emitted, then the nodes run one at a time in plan order (5.5).

### 5.4 Keys and the cache

A key is a canonical string. Keys are compared as whole strings; a truncated
hash is never a key. Wherever a key or an `O` stands inside another key, its
**token** stands for it: a number the engine gives to that string and to no
other. Without tokens a key would repeat the keys of everything upstream, and
double at every node that reads one source twice. Tokens belong to one engine
and are not persisted, so a key is compared only with keys of the same engine.

```
K(n)  = JSON.stringify([ KEY_VERSION, def.type, def.version, P, I, S, X ])          the node key

P  = normalizeParams(def, instance.params).values, as an array in declaration order
I  = for each input in def.inputs, in order: null when unconnected, else C(edge)
S  = [ settings.terrainSize, settings.heightRange,
       def has a `seed` param ? settings.seed : null,
       ...def.uses in declaration order → the setting's value ]
X  = the string returned by the node's externalKey (engine.md 4.12); '' when it has none

C(edge)     = [ O(source node, source port), conversion ]       conversion: '' | 'grey' | 'luma' (5.6)

O(n, port)  = the content of an output; the first line that applies:
    n bypassed (5.6), port is outputs[0]            C(edge into inputs[0]);  [ 'const', kind ] when unconnected
    n bypassed, any other port                      [ 'const', kind of the port ]
    n maskable with `mask` connected, outputs[0]    [ 'mask', K(n), C(edge into mask), C(edge into inputs[0]) ]
    otherwise                                       [ K(n), port ]

contentKey(n) = JSON.stringify(O(n, outputs[0]))    for a node with outputs;  K(n) for a node without
```

Inside `C`, `O(...)` is the token of `JSON.stringify(O(...))`; inside `O`,
`K(n)` is the token of `K(n)`. The engine never forgets a token of the
document it is keying; beyond 32 768 strings it forgets the least recently
used of the others. A string whose token it has forgotten gets a new one,
never one another string had: that costs cache misses downstream of it and
nothing else.

`KEY_VERSION` is an engine constant, raised when a change to the core alters
the result of unchanged nodes.

That list is exhaustive. In particular these are **not** in any key:

| Not in a key | Consequence |
| --- | --- |
| the resolution | it is the second half of the cache address: an entry lives at `(key, resolution)` |
| the node's id, position, title, `collapsed` | two nodes with the same type, params and inputs share one entry; a copied node is a cache hit |
| `mode`, `requestId`, `outputs`, `cache` | a result does not depend on how it was requested |
| `buildResolution`, `previewLevel`, groups, `ui` | editing them recomputes nothing |
| `settings.seed` for a node without a `seed` param; settings a node does not declare in `uses` | changing the sea level re-runs only nodes that read it |
| which outputs are wanted | an entry records the outputs it holds |
| the `mask` input of a `maskable` node | it is in `O`, not in `K`: a changed mask re-blends and does not re-run the node |
| whether `evaluate()` passed an input through (5.6) | keys are a function of the document and of file identities only |

`Engine.keys(doc)` returns `contentKey` for every node that is not blocked by
rule 2 of 5.3. Computing all keys of a 150-node document was measured at 4 to
8 ms.

**Entries.** The cache maps `(content, resolution)` to published textures.

| Entry | Content | Holds |
| --- | --- | --- |
| node | `K(n)` | the outputs one run of the node produced: per output a texture |
| conversion | a `C` with a non-empty conversion | one texture |
| mask blend | `['mask', ...]` | one texture |
| constant | `['const', kind]` | one texture, cleared to the constant |

1. The cache is per node, not per output. A node entry is created by one run, holds every output that run produced, and is evicted as a unit.
2. A node entry is a **hit** when it holds every output this evaluation wants. Otherwise the node runs again, with every output wanted that this evaluation wants or the old entry held, and the new entry replaces the old one.
3. An entry is **used** when it is created or hit. Recency is the order of last use.
4. Nothing from a node that failed or was cancelled is cached.
5. The cache lives in GPU memory only. It is not written to disk, and it is emptied when the device is lost.
6. A build evaluation keeps the same four kinds of content in a table of its own that lives for that evaluation; it neither reads nor writes the cache.
7. The cache holds at most 8192 entries. Beyond that the first in eviction order (2.7) go, whether or not that frees a texture: the budget bounds the bytes of the cache, and an entry that only shares textures (5.6, pass-through) has none of its own.

**Transient entries.** While a control is dragged the session evaluates with
`cache: 'transient'` (7.3), and every tick would otherwise fill the cache with
results nobody will ask for again.

1. An entry created by a transient evaluation is a **transient entry** and takes that evaluation's `requestId` as its **generation**. A transient entry hit by a later transient evaluation takes the later `requestId`. An ordinary entry that a transient evaluation hits, or replaces (rule 2 above), stays ordinary.
2. When a transient evaluation settles with status `'ok'` or `'errors'`, every transient entry whose generation is lower than its `requestId` is dropped at once. Entries upstream of the edit are hit on every tick and so survive.
3. An evaluation with `cache: 'keep'` turns every transient entry it hits into an ordinary one.
4. Remaining transient entries are the first to be evicted (2.7).

Undo and redo need no cache interface. They restore parameters; restored
parameters reproduce the old keys; whatever is still cached is a hit.

### 5.5 Running a node

For a node that is not cached and not blocked:

1. The evaluator builds the `EvalContext`: read-only `Field`s over the published textures of the connected inputs (converted where needed), `ctx.params`, `ctx.wants`. It emits `node-start` and calls `def.evaluate(ctx)`.
2. When `evaluate()` has resolved, the evaluator checks that every wanted output was given (otherwise the node fails: `output "<name>" was not produced`), submits the open slice, and waits until every slice of the node has completed and every error scope and texture creation of the node has reported (5.8). It then checks the signal and the device.
3. **Publication** is atomic and happens only now. Every field given to `ctx.output()` becomes PUBLISHED; an output that is one of the node's inputs takes one more reference on that input's texture instead; every other field the node allocated returns to FREE; its LUT buffers are destroyed and its bind groups dropped. In preview the entry is stored.
4. It applies the mask blend when the node is `maskable`, `mask` is connected and `outputs[0]` is wanted (5.6), and makes the conversions of the targets that name the node (5.2). Then `node-done` is emitted. When the blend or a conversion fails, the node fails with kind `'internal'` (5.8) and what step 3 published stays in its entry: it is the node's own result, and correct.
5. When anything fails before step 3 (an exception, a rejected promise, a missing output, an error scope, an abort, a lost device), every field the node allocated returns to FREE, including those given to `ctx.output()`, nothing is published, preview loans are withdrawn (5.11), and `node-error` or `node-skipped` is emitted.

After `evaluate()` has settled, every method of its context throws.

### 5.6 Conversion, bypass, masks, pass-through

**Conversion.** An input of type `'field'` or `'color'` that is connected to an
output of the other kind receives a converted field; so does a target with
`as`. An input of type `'any'` is never converted.

| From → to | Name | Result |
| --- | --- | --- |
| `field` → `color` | `'grey'` | `vec4f(v, v, v, 1)` |
| `color` → `field` | `'luma'` | `0.2126 r + 0.7152 g + 0.0722 b` of the linear RGB; alpha is ignored |

A conversion is content of its own (5.4): it is computed once per source and
resolution by a core kernel, shared by every reader, cached and evicted like a
node's output.

**Bypass.** `bypass: true` takes effect when the node's `inputs[0]` and
`outputs[0]` exist with the same type (`engine.md` 4.14) and is ignored
otherwise. A bypassed node's `evaluate()` is not called and it has no entry:

- `outputs[0]` is the field connected to `inputs[0]`, converted as that input would be. When `inputs[0]` is unconnected, `outputs[0]` is the constant.
- Every other output is the constant of its kind: 0 for a `field`, `(0, 0, 0, 1)` for a `color`, at `res × res`.
- Its other inputs, its params and its `mask` input are not read and not checked: a bypassed node has no missing input and no parameter error.

**Masks.** For a `maskable` node whose `mask` input is connected, after
`evaluate()` the evaluator computes `mix(inputs[0], outputs[0], saturate(mask))`
per channel into a new field, with a core kernel of the output's kind. That
field is the node's `outputs[0]` for every reader, for the viewer and for the
thumbnail. It is content of its own, so in preview the unblended result stays in
the node's entry: a change of the mask repeats the blend and not the node. In a
build the unblended result is released as soon as the blend has run. A connected
`mask` of kind `color` is converted with `'luma'`. When `inputs[0]` is optional
and unconnected, the blend uses the constant of its kind in its place. Other
outputs are untouched.

**Pass-through.** When `evaluate()` gives one of its input fields to
`ctx.output()`, that output is an alias: no texture is allocated and the
entry holds one more reference on the input's texture. When `outputs[0]`
aliases `inputs[0]`, the mask blend is skipped and the blended content aliases
the same texture, because `mix(x, x, m)` is `x`. Aliasing changes memory and
work only. It never changes a key: a node that passes its input through still
has its own `K`, and nodes downstream are keyed by it.

### 5.7 Readback and statistics

`ctx.read`, `Engine.read`, `ctx.stats` and `Engine.stats` share one
implementation.

1. A read copies the texture to the staging buffer in strips of whole rows of at most 64 MiB: `rows = floor(67 108 864 / align256(width × bytesPerTexel))`, where `align256` rounds up to a multiple of 256, as texture-to-buffer copies require. An 8129² `field` is read in 4 strips of 2048 rows.
2. One staging buffer of at most 64 MiB exists per engine, with usage `MAP_READ | COPY_DST`, created on first use and registered with the ledger. Reads are serialised. No read needs a buffer above the default `maxBufferSize`, and no read holds a second full-size copy on the GPU side.
3. The returned `Float32Array` is tightly packed without row padding; `rgba16float` and `r8unorm` data are converted to float32.
4. Statistics are reduced on the GPU to one record per 32 × 32 block and combined on the CPU in float64. The readback is about 1 MiB at 8129². A texel is non-finite when `(bitcast<u32>(v) & 0x7f800000u) == 0x7f800000u`.

### 5.8 Errors

```ts
type NodeErrorKind =
  | 'unknown-type' | 'version' | 'param' | 'missing-input' | 'cycle'
  | 'shader-compile' | 'binding' | 'validation' | 'budget' | 'out-of-memory' | 'watchdog'
  | 'io' | 'node-exception' | 'device-lost' | 'internal';

interface WgslDiagnostic {
  readonly origin: 'code' | 'generated' | `library:${string}`;   // author code, generated code, or a library by name
  readonly line: number;                                          // 1-based, within the origin
  readonly column: number;
  readonly length: number;
  readonly message: string;
  readonly excerpt: readonly string[];                            // the line and up to two lines either side
}

interface NodeError {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly kind: NodeErrorKind;
  readonly message: string;            // one sentence, shown on the node
  readonly detail?: string;            // full GPU message, or a stack
  readonly kernel?: string;            // kernel name, when one is involved
  readonly wgsl?: WgslDiagnostic;      // for 'shader-compile'
}
```

| Kind | Raised when | Message |
| --- | --- | --- |
| `unknown-type` | the registry has no such type | `Unknown node type "<type>"` |
| `version` | the instance's version differs from the definition's: it is newer than this build, or its migration failed on load (4.5) | `Saved with version <a> of this node; this build has version <b>` |
| `param` | `normalizeParams` returns an error | its text |
| `missing-input` | a required input is unconnected | `missing input "<name>"` |
| `cycle` | the node lies on a cycle | `Part of a cycle` |
| `shader-compile` | a kernel in `NodeDef.kernels` does not compile | `kernel "<name>": <first error>` |
| `binding` | `KernelBindingError` or `FieldAccessError` is thrown, an output is missing, or another rule of the context is broken | the error's message |
| `validation` | a GPU validation error is captured in a scope of the node | the first line of the GPU message |
| `budget` | `BudgetExceededError`, or the memory check of 5.3 | `Needs <n> MB more GPU memory at <res> × <res>: budget <b> MB, <w> MB in use by this node, <p> MB pinned` |
| `out-of-memory` | the GPU reports out of memory twice (below) | `Out of GPU memory at <res> × <res> (budget <b> MB). Lower the resolution or raise the GPU memory budget` |
| `watchdog` | one dispatch of a kernel that cannot be tiled is estimated above the hard ceiling (3.4) | as given there |
| `io` | `ctx.readFile` or `externalKey` fails with a `FileError` (6.1) | the error's message |
| `node-exception` | `evaluate()` or `externalKey` throws or rejects with anything else | the error's message |
| `device-lost` | the node was running at two device losses in a row (5.9) | `The GPU was reset twice while this node was running` |
| `internal` | a conversion, a mask blend or a constant fails. It is reported on the node it was made for: the reader of a converted input, the node whose output is blended, the node a converted target names | the error's message |

**Isolation.** A failed node fails alone. Every node that reads it, directly or
not, is skipped with `node-skipped`, reason `'upstream'`, naming the failed
node. Branches that do not depend on it evaluate normally.

**Compilation.** A kernel is compiled with `createShaderModule`,
`getCompilationInfo()` and `createComputePipelineAsync`; the synchronous
`createComputePipeline` is never used. The generator records where each segment
of the assembled module begins (generated declarations, the standard library,
each included library, the author's code, the generated entry point), and a
diagnostic is mapped to a segment and a line within it. An error in the
author's code reports `origin: 'code'` with the line of `KernelDef.code`.
Pipelines are cached by kernel name per device epoch. The engine's own kernels
(ops, conversions, blends, clears, statistics, thumbnails) are compiled by
`createEngine`.

**Error scopes.** WebGPU keeps one scope stack per device, not per task.

1. No scope is ever open across an `await`, by any code, the viewport renderer included.
2. Each of these is wrapped in its own synchronous pair of `pushErrorScope('validation')` and `pushErrorScope('out-of-memory')` with both pops in the same block: creating a texture or a buffer, creating a bind group, creating a pipeline, and the submission block of a slice (3.1).
3. The pop promises belong to the owner for which the call was made and are awaited before that owner publishes (5.5).
4. A validation error fails the owning node with kind `'validation'`. When any scope of the same invocation reports out of memory, its validation errors are ignored: they follow from the invalid texture.
5. An `uncapturederror` event is reported as a non-fatal `engine-error` (7.7) and is never attributed to a node.

**Memory.** The budgeted pool is the defence against exhausting video memory;
the GPU's own out-of-memory report is the second line. On Windows the driver
pages video memory instead of failing, so that report is rare there and the
symptom of an over-large budget is slowness.

1. `BudgetExceededError` is not retried: the loop of 2.5 has already reclaimed everything that could be. The node fails with kind `'budget'`.
2. A GPU out-of-memory report for a node makes the evaluator return the node's fields to FREE, destroy every FREE texture, evict every evictable cache entry (2.7) and destroy what that frees, await `pool.drained()`, and run the node once more.
3. A second out-of-memory report, or a `BudgetExceededError` in the second run, fails the node with kind `'out-of-memory'`.

### 5.9 Device loss

Measured on Dawn: after a device is lost, `onSubmittedWorkDone()` still
resolves, `popErrorScope()` resolves with `null`, `createTexture` returns an
object and `submit` does not throw. Only `mapAsync` rejects. An evaluator that
did not check would finish the graph, cache dead textures and report success.

1. `gpu.lost` is checked at every cancellation point (3.7). When it is set the context method or runtime call in progress throws `DeviceLostError`.
2. The evaluation settles with status `'device-lost'`. Nothing from the running node is published. Unfinished nodes get `node-skipped` with reason `'device-lost'`.
3. The engine then forgets everything that lived on the device, without calling into it: the cache, the pool's textures and ledger (all byte counts return to zero), pipelines, learned rates, the arena, the staging buffer and the thumbnail atlas. Existing `FieldHandle`s are dead (2.2).
4. Until `replaceDevice`, `evaluate()` settles at once with `'device-lost'`; `read`, `stats`, `reserve` and `trim` throw or reject with `DeviceLostError`; `memory()` reports the forgotten ledger, every byte count zero. `keys`, `lastTiming`, `onThumbnail`, `setBudget` and `setFiles` need no device and work as before, and `dispose()` ends the engine without calling into the lost device.
5. `replaceDevice(gpu)` takes a context from a new `openGpu` call, increments `epoch`, compiles the engine's kernels and resolves. The document was never on the GPU, so nothing is lost but time.
6. The engine records the node that was running when the device was lost. If the same node, with the same key, is running at the next loss as well, it is not run a third time: it fails with kind `'device-lost'` until its key changes. Before that second attempt its slice target and the hard ceiling are halved for that node. A loss at which another node, or none, was running ends the row.

Recovery in the application (who opens the new device, how often) is in 7.8.

### 5.10 Events, progress and estimates

```ts
type EvalEvent =
  | { readonly type: 'eval-start'; readonly requestId: number; readonly resolution: number; readonly mode: 'preview' | 'build';
      readonly plan: readonly { readonly nodeId: string; readonly state: 'cached' | 'run' | 'bypassed' | 'blocked' }[];
      readonly outputPeakBytes: number | null }                                 // build only
  | { readonly type: 'node-start'; readonly requestId: number; readonly nodeId: string }
  | { readonly type: 'node-progress'; readonly requestId: number; readonly nodeId: string;
      readonly fraction: number; readonly label?: string; readonly etaMs: number | null }
  | { readonly type: 'node-preview'; readonly requestId: number; readonly nodeId: string; readonly ports: readonly string[] }
  | { readonly type: 'node-done'; readonly requestId: number; readonly nodeId: string; readonly cached: boolean;
      readonly wallMs: number; readonly gpuMs: number | null; readonly peakBytes: number }
  | { readonly type: 'node-error'; readonly requestId: number; readonly error: NodeError }
  | { readonly type: 'node-skipped'; readonly requestId: number; readonly nodeId: string;
      readonly reason: 'upstream' | 'aborted' | 'device-lost'; readonly upstream?: string }
  | { readonly type: 'eval-progress'; readonly requestId: number; readonly fraction: number; readonly etaMs: number | null }
  | { readonly type: 'eval-end'; readonly requestId: number; readonly status: EvaluateResult['status']; readonly wallMs: number };
```

1. Events of one request arrive in order, begin with `eval-start`, end with `eval-end`, and none arrives after the promise has settled.
2. Every node of the plan gets exactly one final event: `node-done`, `node-error` or `node-skipped`. Cached and bypassed nodes get `node-done` with `cached: true` and `wallMs: 0`. In `eval-start`, `blocked` is a node that will not run: it failed a check of 5.3, reads one that did, or the evaluation cannot start at all (the memory check of a build, a lost device, a signal that has already aborted).
3. `node-progress` is emitted at most 10 times per second per node, `eval-progress` at most 4 times per second. Fractions are in 0..1 and do not decrease.
4. `wallMs` runs from `node-start` to `node-done`. `gpuMs` is the sum of the measured GPU time of the node's slices, `null` without `timestamp-query`. `peakBytes` is the most pool memory the invocation held as WORKING.
5. Every event is plain data and can be structured-cloned.

**Estimates.** There is no declared cost per node. All estimates come from
measurements made in the session, and all are approximate.

| Estimate | Definition |
| --- | --- |
| a node's remaining time, `node-progress.etaMs` | `elapsed × (1 − f) / f` once `f ≥ 0.05` and `elapsed ≥ 500`; else `null` |
| a node's weight in an evaluation | for a cached, bypassed or blocked node, 0. Otherwise `lastTiming(node).wallMs × (resolution / lastTiming(node).resolution)²`; without a timing, the median weight of the plan's nodes that have one; when none has, 1 |
| `eval-progress.fraction` | `(Σ weight of finished nodes + weight × fraction of the running node) / Σ weight` |
| `eval-progress.etaMs` | `elapsed × (1 − F) / F` once `F ≥ 0.05` and `elapsed ≥ 1000`; else `null` |
| the predicted time of an evaluation, used for draft levels (7.3) | the sum of the weights of its nodes that are not cached |

Scaling by texel count understates a simulation whose iteration count also
grows with the resolution, so the remaining time of a build falls more slowly
than the clock at first. It is shown as an estimate.

### 5.11 Progressive previews

A node inside `ctx.loop` can lend its working state to the viewer through
`LoopOptions.preview` (`engine.md` 4.7).

1. At every batch boundary (3.6), once the open slice is submitted and before the boundary waits, the evaluator calls `preview()` and records the returned fields as the node's **loans**, by output port. A loan is valid from then until the next call of `body`, which is the time the boundary waits and the viewer draws (7.5): everything encoded is submitted, so in queue order the lent texture holds a complete iteration. A key that is not an output port of the node fails the node with kind `'binding'`.
2. When the loans changed, the evaluator calls `EvaluateOptions.onLoans(nodeId, loans)` (5.2) before it waits, with one `TextureRef` per lent port. When at least 100 ms have also passed since the last one, `node-preview` is emitted with the ports that have a loan.
3. A viewer may draw a lent texture in frames it submits while the loan is valid. It reads by `uv`, so a loan of any size works: the coarse levels of a coarse-to-fine run are shown as they are.
4. Loans end when the node settles, or earlier when it releases a field it has lent. The evaluator withdraws them synchronously, with `onLoans(nodeId, null)`, before the fields return to the pool; the viewer is on the same thread and switches in that call (7.5).
5. Lent content is never cached, never gets a thumbnail and is not in the result. After an abort or an error the viewer shows what it showed before.

### 5.12 Thumbnails

```ts
interface Thumbnail {
  readonly nodeId: string;
  readonly contentKey: string;           // 5.4
  readonly resolution: number;           // of the field it was made from
  readonly rgba: Uint8ClampedArray;      // 128 × 128 × 4, row-major, first row = row 0 of the field
}
```

1. Thumbnails are a by-product. With `thumbnails: true`, for every node of the plan whose `outputs[0]` is available in this evaluation (cached or just published), a thumbnail is made when it would be better than the last one delivered for that node id: a different `contentKey`, or the same key at a higher resolution. An evaluation never runs a node only to make a thumbnail.
2. A thumbnail is 128 × 128. Texel `(i, j)` takes the source texel nearest to `uv = (i, j) / 127`. The source is sampled once per thumbnail texel into a 128² scratch field and shaded from that; it is never box-filtered. Measured: 150 thumbnails from 2048² sources with one readback take 24 ms this way and about 1 s with a box filter.
3. Shading, by `outputs[0]`:

| Output | Pixel |
| --- | --- |
| `field`, role `height` | grey `saturate(dot(n, L))`, with `n` the normal from central differences of the 128² samples in metres (cell `terrainSize / 127`, heights times `heightRange`) and `L = normalize(vec3f(-0.5, -0.5, 0.7))`, the direction towards the light |
| `field`, role `mask` | grey `saturate(v)` |
| `field`, role `data` | grey `(v − min) / (max − min)` over the 128² samples; 0.5 when they are equal |
| `color` | `rgb` clamped to 0..1 and encoded to sRGB; alpha ignored |

4. Thumbnails are written to cells of one `rgba8unorm` atlas of 2048 × 2048 (256 cells), which only stages them. The atlas is read back when an evaluation has ended and at most every 250 ms during one, or earlier when all cells are in use. The readback does not delay the evaluation's result. A row of 128 RGBA texels is 512 bytes, which needs no padding. The atlas is made with the first thumbnail; under a budget it does not fit beside what is reserved, working and pinned, no thumbnail is made and the evaluation is not disturbed.
5. Each thumbnail read back is delivered once to `onThumbnail` listeners, per node id. The engine keeps no pixels afterwards.

### 5.13 Guarantees in one place

| Situation | What the evaluator does |
| --- | --- |
| A required input is unconnected | `node-error`, kind `missing-input`; `evaluate()` is not called |
| An optional input is connected to a failed node | the node is skipped, reason `upstream` |
| The same field is given to two outputs | published once, referenced twice |
| A wanted output is not given | the node fails, kind `binding` |
| An unwanted output is given | it is published and stored in the entry |
| Two nodes have the same key | the second is a cache hit; in a build it reads the first one's content |
| The signal aborts during a node | the node publishes nothing; nodes that completed stay cached |
| A cached output is evicted while a viewer holds its handle | the handle stays valid; the texture is freed when the handle is released |
| `evaluate()` is called during a build | it waits, like any second call |

### 5.14 Test hooks

```ts
interface EngineTestHooks {
  readonly sliceTargetMs?: number;        // replaces both slice targets
  readonly inFlightLimit?: 1 | 2;         // 2 requires timestamp-query
  readonly maxTileRows?: number;          // no tile has more rows: forces tiling at any size
  readonly failAllocAfter?: number;       // the nth texture creation from now reports GPU out of memory, once
  readonly poisonRecycled?: boolean;      // a recycled texture is filled with −1e30 before it is handed out
  readonly onSlice?: (s: { readonly nodeId: string | null; readonly service: string | null;
                           readonly kernels: readonly string[];
                           readonly work: number; readonly estimateMs: number; readonly measuredMs: number }) => void;
}
```

`onSlice` is called when a slice completes. `nodeId` is the node whose
invocation owns the slice (3.1). `service` names the engine service when no
node does: `'convert'`, `'mask'`, `'constant'`, `'thumbnail'`, `'stats'` or
`'read'`. Exactly one of the two is not `null`.

The hooks exist so that policy is testable on any machine: tiling and batching
independence without a slow kernel, the out-of-memory retry without exhausting
a GPU, eviction and build-mode release with a `budgetBytes` of a few megabytes,
and reliance on undefined texture contents. `testing.md` says which tests use
them. They change no result that a correct kernel produces.

---

## 6. Files and CPU tasks

The interfaces live in `src/core/io/files.ts` and `src/core/cpu/runner.ts`. The
core defines them and never implements them: the platform supplies the
implementations through `EngineOptions`.

### 6.1 `FileSource`

```ts
declare class FileError extends Error {
  readonly path: string;
  readonly code: 'not-found' | 'denied' | 'invalid-path' | 'io';
}

interface FileSource {
  /** The absolute path. A relative path is taken from the folder of the project file. */
  resolve(path: string): string;
  /** null when there is no such file. */
  stat(path: string): Promise<{ readonly size: number; readonly mtimeMs: number } | null>;
  read(path: string, range?: { readonly offset: number; readonly length: number }): Promise<Uint8Array<ArrayBuffer>>;
  /** Calls onChange after the file changed. Returns a function that stops watching. */
  watch?(path: string, onChange: () => void): () => void;
}
```

1. `stat`, `read` and `watch` accept a relative or an absolute path and resolve it as `resolve` does.
2. A document stores a path relative to the project file, with `/` separators, when the file lies under the project's folder, and absolute otherwise. `resolve` throws `FileError` with code `'invalid-path'` for a relative path when the project has never been saved.
3. `read` rejects with `FileError`: `'not-found'`, `'denied'`, or `'io'` for anything else. The array it returns owns its whole buffer (`byteOffset` 0, `byteLength === buffer.byteLength`), so it can be transferred to a CPU task.
4. `ctx.readFile(path)` is `files.read(path)`. `ExternalKeyContext.stat(path)` is `files.stat(path)`. The default `externalKey` (`engine.md` 4.12) is, for each `file` param in order, `[resolve(path), size, mtimeMs]`, or `[resolve(path), null]` for a missing file, joined into one string.
5. The identity of a file is its resolved path, size and modification time. Contents are never hashed: hashing a 132 MB file was measured at 0.14 to 0.34 s, on every evaluation.
6. When the source has `watch`, the session watches the resolved path of every non-empty `file` param of the current document and re-evaluates when one changes (7.3). The engine itself never watches: it compares file identities at each evaluation.
7. Implementations: `NodeFileSource(projectFolder: string | null): FileSource` in `src/platform/node/files.ts`, a function called without `new`, on `node:fs`, used by the command line and by the engine worker; a memory-backed one for tests (`testing.md`).

### 6.2 `FileSink`

```ts
interface FileWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<{ readonly bytes: number }>;
  abort(): Promise<void>;
}

interface FileSink {
  /** Opens a file for streaming. */
  create(relPath: string): Promise<FileWriter>;
  /** Writes a whole small file: create, write, close. For files under 16 MiB. A string is written as UTF-8. */
  write(relPath: string, data: Uint8Array | string): Promise<void>;
  /** Aborts every writer that is open. */
  abortAll(): Promise<void>;
}
```

1. **Paths.** A sink is rooted at one output folder. `relPath` uses `/`, is relative, and has no empty, `.` or `..` segment, no backslash and no colon. Anything else rejects with `FileError` code `'invalid-path'`. Missing parent folders are created.
2. **Streaming.** `write(chunk)` appends exactly the bytes `[byteOffset, byteOffset + byteLength)` of the chunk and resolves when the operating system has accepted them. The caller may then reuse the buffer. A caller awaits each `write` before the next; that is the back-pressure. Producers use chunks of at most 64 MiB.
3. **Atomic.** A writer writes to `<relPath>.partial`. `close()` flushes it and renames it to `relPath`, replacing an existing file. Until `close()` has resolved, `relPath` is either the previous file or absent, never a part. `abort()` deletes the partial file; it is idempotent and does nothing after `close()`. A `write` or a `close` that fails rejects with a `FileError`, deletes the partial file as `abort()` does, and every later `write` and `close` of that writer rejects with the same error.
4. **One writer per path.** `create` for a path that this sink has open, or has already closed, rejects: two exporters that would write the same file are caught, and nothing is overwritten within one build. A path whose writer was aborted or has failed may be created again.
5. **Cancellation.** A build that is cancelled or fails calls `abortAll()`. No partial file and no half-written set of files is left under a final name that the build had not completed. A `create` that is still under way when `abortAll()` is called resolves with a writer that is already aborted, and `abortAll()` resolves only when that writer's partial file is gone as well.
6. Implementations: `NodeFileSink(rootFolder: string): FileSink` in `src/platform/node/files.ts`, a function called without `new`, on `node:fs`; a memory-backed one for tests. No implementation crosses a process boundary, and file contents never travel through inter-process messages. Measured in Electron for 250 MB: 0.1 s written from the engine worker with `node:fs`; 0.9 s as one message through the preload bridge with a 0.5 s stall of the interface; 25 s as 8 MiB views of one buffer, because each view drags the whole buffer along.

Which files a build writes, and their encoders, are in `export-unreal.md`.
Together with the strip-wise reads of 5.7, a streaming writer means that no
export holds more than one strip of an image on the CPU side.

### 6.3 `CpuRunner` and the CPU worker

`ctx.cpu(task, args, transfer)` (`engine.md` 4.11) is carried out by the
platform's `CpuRunner`.

```ts
interface CpuRunner {
  run(taskName: string, args: unknown, transfer: readonly ArrayBuffer[],
      opts: { readonly signal: AbortSignal; readonly onProgress: (fraction: number) => void }): Promise<unknown>;
  dispose(): Promise<void>;
}

/** The port a CPU worker serves on. Satisfied by node:worker_threads' parentPort, by a Web Worker's global scope and by a MessagePort. */
interface CpuTaskPort {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  /** A Web MessagePort delivers nothing until start() is called; the other two have no such method. */
  start?(): void;
}

/** src/core/cpu/serve.ts. The whole worker side: receives task messages on `port`, runs the tasks defined in this thread, posts results. */
declare function serveCpuTasks(port: CpuTaskPort): void;

/** src/core/cpu/protocol.ts. What a CpuRunner posts on that port, and what serveCpuTasks posts back. */
interface CpuTaskRequest {
  readonly id: number;
  readonly task: string;       // CpuTask.name
  readonly args: unknown;
}
type CpuTaskReply =
  | { readonly id: number; readonly type: 'progress'; readonly fraction: number }
  | { readonly id: number; readonly type: 'result'; readonly value: unknown }   // the buffers of its typed arrays are transferred
  | { readonly id: number; readonly type: 'error'; readonly message: string };  // the task threw, or its name is unknown
```

A runner posts one `CpuTaskRequest` per task, with the caller's transfer list, and
receives any number of `progress` replies followed by one `result` or `error`
with the same `id`. There is no cancel message: a runner cancels by terminating
its worker (rule 5).

A transfer list is `ArrayBuffer[]`: a `SharedArrayBuffer` is not transferable,
so no `postMessage` accepts `ArrayBufferLike[]`. The arrays the engine hands out
are therefore typed over `ArrayBuffer` (`Float32Array<ArrayBuffer>` from
`ctx.read` and `Engine.read`, `Uint8Array<ArrayBuffer>` from `FileSource.read`),
which makes `[data.buffer]` a transfer list without a cast.

| Platform | Worker | Entry file | Runner |
| --- | --- | --- | --- |
| Node: command line, tests | a `node:worker_threads` worker | `src/platform/node/cpu-worker.ts` | `createNodeCpuRunner()` in `src/platform/node/cpu.ts` |
| Application | a dedicated Web Worker created by the engine worker; it needs and has no Node integration | `src/platform/electron/worker/cpu-worker.ts` | `createWebCpuRunner()` in `src/platform/electron/worker/cpu.ts` |

1. Both entry files import `src/core/nodes/index.ts`, which runs every `defineCpuTask` of the product in that thread, and call `serveCpuTasks`. `serve.ts` itself imports the core's own tasks (`decodeImage`, `decodeRaw`), so they are defined in every thread that serves. A task is found by name in the table `defineCpuTask` fills (`engine.md`, Module scope); an unknown name rejects. A task that is defined only in the calling thread, for instance in a test file, therefore cannot run. `createNodeCpuRunner(entry?: URL)` takes another entry file than the product's; only a test of the runner itself passes one.
2. One CPU worker exists per engine. It is started at the first `ctx.cpu` call. Tasks run one at a time, in call order.
3. `args` are structured-cloned; buffers in `transfer` are moved. In the result, the buffer of every typed array reachable through plain objects and arrays is moved back. A result that holds a buffer which cannot be moved, the memory of a WebAssembly module for one, is copied whole instead.
4. `env.progress(f)` reaches `onProgress`, which the evaluator maps onto the node's progress.
5. **Cancellation.** When the signal aborts, `run` rejects at once with the abort reason. If the task is executing, the worker is terminated and a new one is started on the next call. A task therefore holds no state that outlives it. A runner posts a request only when the one before it is answered: a task that still waits for its turn is cancelled without touching the worker, and terminating the worker loses no waiting task or its buffers.
6. A task that throws rejects `run` with an `Error` carrying its message; the worker survives. A worker that cannot start or that dies rejects the task in progress with an `Error` that begins `The CPU worker failed: `, and the next call starts a new one.
7. In the application a single `ArrayBuffer` is limited to 2 145 386 496 bytes (measured). A full read of an 8129² four-channel field is 1 057 290 256 bytes and fits.
8. The Node runner starts its worker with `workerData: {}`, which the TIFF decoder's library needs in a worker thread (`export-unreal.md` 4.7), and keeps the process alive only while a task is in progress: an idle worker does not hold a command-line program or a test open. `dispose()` rejects what is pending and resolves when every worker thread has stopped.

A Web Worker created from inside a worker is standard in Chromium but is not
yet verified in this project's Electron build. Should it fail, the page creates
the CPU worker and hands the engine worker one end of a `MessageChannel`;
`serveCpuTasks` and `CpuRunner` are unchanged by that.

---

## 7. `EngineSession`

The session is the application's only door to the engine. It lives on the
engine thread, in `src/core/session/`. It owns scheduling, the view, the
viewport host, builds and device recovery. The interface is asynchronous
message passing by design: every argument and result is plain data.

### 7.1 The facade

```ts
interface EnginePreferences {
  readonly vramBytes: number | null;        // null: use caps.vramBytes, else 4 GiB (2.4)
  readonly budgetFraction: number;          // 0.3 .. 0.85
}

interface BuildRequest {
  readonly doc: GraphDoc;                   // built at doc.settings.buildResolution
  readonly outDir: string;                  // absolute folder; created when missing. It belongs to the build: export-unreal.md 3.8
}

interface EngineSession {
  setProject(project: { readonly path: string | null }): void;
  setDocument(doc: GraphDoc, revision: number): void;
  beginGesture(): void;
  endGesture(): void;
  setPaused(paused: boolean): void;
  requestThumbnails(nodeIds: readonly string[]): void;
  inspect(ref: PortRef): Promise<FieldStats | null>;
  build(request: BuildRequest): Promise<BuildResult>;
  cancelBuild(): void;
  setPreferences(prefs: EnginePreferences): void;
  retryDevice(): void;
  subscribe(listener: (e: EngineEvent) => void): () => void;
  readonly viewport: ViewportHost;          // 7.5
  dispose(): Promise<void>;
}

/** What the session passes to the build function it was given (7.6). */
interface SessionBuildOptions {
  readonly doc: GraphDoc;
  readonly outDir: string;
  readonly requestId: number;
  readonly signal: AbortSignal;
  readonly onEvent: (e: EvalEvent | BuildEvent) => void;
}

/** src/core/session/session.ts */
declare function createSession(opts: {
  readonly engine: Engine;
  readonly reopenGpu: () => Promise<GpuContext>;                         // a new openGpu call, for recovery (7.8)
  readonly createFiles: (projectPath: string | null) => FileSource;
  readonly build: (engine: Engine, opts: SessionBuildOptions) => Promise<BuildResult>;   // 7.6; never rejects for a failed build
  readonly renderer: ViewportRenderer | null;                            // null: no viewport; `viewport` then ignores calls and `pick` resolves null
}): EngineSession;
```

The session is core code and imports nothing from `src/export/` (8.4), so the
build pipeline is handed to it. The caller of `createSession` may import both:

```ts
// src/platform/electron/worker/engine-worker.ts
build: (engine, o) => buildToFolder(engine, { ...o, createSink: NodeFileSink }),
```

`buildToFolder` is `export-unreal.md` 3.1 and 3.8: it replaces the folder
`outDir` with the new build when the build succeeds. A test of the session
passes a function that calls `buildProject` with a memory sink instead.

| Method | Semantics |
| --- | --- |
| `setProject` | The path of the project file, or `null` for an unsaved project. Replaces the engine's `FileSource`. Call it before the first `setDocument` and after every save under a new name |
| `setDocument` | The current document. `revision` is an integer greater than every earlier one. The session keeps the latest only and schedules an evaluation (7.3). The view is read from `doc.ui.view` |
| `beginGesture`, `endGesture` | Bracket a continuous edit: a slider scrub, a curve or colour drag. Evaluations in between are drafts (7.3). Calls do not nest; a second `beginGesture` is ignored |
| `setPaused` | `true` aborts the running preview and starts no other until `false`. Documents are still recorded. Default `false` |
| `requestThumbnails` | The node ids whose thumbnails the graph currently shows. Replaces the previous list. The session refreshes stale ones when idle (7.3) |
| `inspect` | Statistics of a port's content in the shown result, at its resolution. `null` when that port is not a `field`, is not cached at that resolution, or a build is running. Runs between evaluations |
| `build` | 7.6 |
| `cancelBuild` | Aborts the running build. Does nothing when none runs |
| `setPreferences` | Recomputes the budget (2.4) and applies it |
| `retryDevice` | Restarts device recovery after it gave up (7.8) |
| `subscribe` | Every `EngineEvent` (7.7), in order |
| `dispose` | Aborts everything, releases all handles, disposes the engine |

### 7.2 The thread boundary

In the application the session runs in the engine worker and the interface
talks to it through `EngineClient` (`src/app/engine/client.ts`), which
implements `EngineSession` over `postMessage`. Headless code uses the session,
or the engine, directly.

```ts
/** src/core/session/protocol.ts */
type ClientMessage = { readonly id: number; readonly method: string; readonly args: readonly unknown[] };
type WorkerMessage =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: { readonly name: string; readonly message: string } }
  | { readonly event: EngineEvent };
```

`method` is the member's name, with the prefix `viewport.` for `ViewportHost`.
Messages are handled in the order sent. Methods that return a promise get one
reply; the others get none.

| Crosses the boundary | How |
| --- | --- |
| a `GraphDoc` | structured clone of the whole document per `setDocument`. Measured at 3 ms for 150 nodes. There is one path: no incremental protocol |
| the viewport canvas | `canvas.transferControlToOffscreen()`, transferred once per `attach` |
| camera, display, size, preferences, the project path, node ids | plain values |
| `EngineEvent`s: status, progress, errors, keys, memory | plain values |
| thumbnail pixels | the `Uint8ClampedArray`'s buffer is transferred (65 536 bytes each) |
| `inspect` and `pick` results, `BuildResult` | plain values |

| Never crosses | Instead |
| --- | --- |
| `GPUDevice`, textures, `FieldHandle`, `Field`, pipelines | the interface thread has no device and never calls `navigator.gpu` |
| field data | nothing but thumbnails and statistics is read back for the interface |
| file contents | the engine worker reads and writes heavy files itself (6.1, 6.2) |
| `NodeDef.evaluate`, kernels, CPU tasks | both threads build the same registry with `createRegistry(nodes)` (5.1); the interface uses it for metadata only (titles, ports, params) and never calls `evaluate` |
| functions, class instances, `AbortSignal` | cancellation is a method: `cancelBuild`, `endGesture`, a newer `setDocument` |

### 7.3 Scheduling

The session holds the latest document and revision, at most one running
evaluation and at most one pending request. A new request replaces the pending
one.

| Request | Resolution | `cache` | `outputs` | Aborted while running by |
| --- | --- | --- | --- | --- |
| full | the preview resolution (4.2) | `keep` | `all` | any newer request; a build; `setPaused(true)` |
| draft | a coarser ladder level, below | `transient` | `all` | `endGesture`; a build; `setPaused(true)` |
| thumbnails | the thumbnail resolution, below | `keep` | `needed` | any full or draft request; a build; `setPaused(true)` |

All three use `mode: 'preview'`. A full or draft request evaluates the view
targets (7.4). It is made when:

| Cause | Request |
| --- | --- |
| `setDocument` outside a gesture | full |
| `setDocument` during a gesture | draft |
| `endGesture`, unless the shown result is already a full result of the latest revision | full |
| the preview resolution changed | `Engine.trim` (2.8), then full |
| a file watched through `FileSource.watch` changed; `setPaused(false)`; a build ended; the device was replaced | full |

1. **No debounce.** A request made while nothing runs starts in the same task.
2. **Latest wins.** While an evaluation runs, only the newest request waits. Intermediate revisions are never evaluated.
3. **A running draft is not aborted by a newer edit.** It finishes, is shown, and the newest revision runs next. Measured for a 3 s drag at 30 edits per second upstream of a 1.75 s node at 2048²: aborting on every edit started 60 evaluations, aborted 59 and updated the viewport 0 times; drafts at 512² updated it 68 times.
4. **Draft level.** A draft is evaluated at ladder level `previewLevel + d` with `d` 1 or 2. The first draft of a gesture uses `d = 2`. After a draft that took `t` ms: with `d = 2` and `4t ≤ 50`, the next uses `d = 1`; with `d = 1` and `t > 50`, the next uses `d = 2`. When the ladder has no such level, the coarsest defined level is used. The threshold of 50 ms is *to calibrate*.
5. **Refinement.** `endGesture` aborts a running draft and requests a full evaluation of the latest revision.
6. **What is shown.** An evaluation that completes with status `'ok'` or `'errors'` and delivered every view target replaces the shown content, and `view-updated` is emitted. Evaluations complete in the order requested, so the shown revision never goes backwards. An aborted evaluation shows nothing, and so does one in which a view target failed: the failed node's error says why. While a newer revision is being evaluated the viewport keeps the last shown content, which the session holds by its handles; it is stale but never blank and never another node's data.
7. **Draft and updating states.** The interface knows the document's revision and receives the shown revision and level in `view-updated`: shown revision behind means *updating*; `draft: true` means the shown result is coarser than the preview resolution.
8. **Keys.** After every `setDocument` the session computes `Engine.keys` and emits `keys` (7.7). A thumbnail is stale when its `contentKey` differs from the node's key.
9. **Idle thumbnails.** When nothing runs or waits and no gesture is active, the session evaluates `outputs[0]` of the requested nodes whose last delivered thumbnail is stale, at the **thumbnail resolution**: the coarsest ladder level of `buildResolution` that is at least 128, or level 0 when none is. A node whose predicted time at that resolution (5.10) exceeds 100 ms is left out unless it is cached; its thumbnail stays stale until a view evaluation runs it.

### 7.4 The view

`doc.ui.view` (4.1) says what the viewport shows. It is part of the document,
saved with it, and not an undo step (8.5).

1. The view targets are `{ ref: view.height, as: 'field' }` and, with an overlay, `{ ref: view.overlay.ref, as: 'color' }` for `as: 'color'` or `as: 'field'` for `'mask'` and `'heat'`. A reference to a node or port that does not exist is left out. Conversion (5.6) makes any port usable in either place.
2. Both targets come from one evaluation: the same revision and the same resolution. The viewport switches to both in one call.
3. **Pinning.** The session keeps the handles of the shown result until the next result is shown, then releases them. That content is pinned (2.2): no eviction, budget pressure or build can recycle what is on screen.
4. `locked: true` keeps the view when the selection changes. It is the user's "pin to this node".
5. Without `height` the viewport draws the overlay on a flat plane. Without a view it draws nothing and no view evaluation is made.

```ts
/** src/core/graph/view.ts. The view after the user selects an output; selecting a node selects its outputs[0]. */
declare function viewAfterSelect(doc: GraphDoc, registry: NodeRegistry, ref: PortRef): ViewBinding | undefined;
```

| Selected output (`outputKind`, role) | Returned view |
| --- | --- |
| any, while the view is `locked` | the current view |
| `field`, role `height` | `height` is the selection; no overlay |
| `field`, role `mask` | `height` unchanged; overlay `{ ref, as: 'mask', opacity: 1 }` |
| `field`, role `data` | `height` unchanged; overlay `{ ref, as: 'heat', opacity: 1 }` |
| `color` | `height` unchanged; overlay `{ ref, as: 'color', opacity: 1 }` |
| kind not determinable, or the node has no outputs | the current view |

Overlay meanings: `'color'` draws the colour over the terrain; `'mask'` draws
`saturate(v)` as a tint; `'heat'` maps the field's own minimum..maximum through
a colour ramp.

### 7.5 The viewport

```ts
interface ViewportSize { readonly width: number; readonly height: number; readonly dpr: number }   // CSS pixels, device pixel ratio

type CameraState =
  | { readonly kind: 'orbit';
      readonly target: readonly [number, number, number];   // metres, in the frame of engine.md 1.8
      readonly yaw: number;                                  // degrees; the viewing direction, by the direction convention of engine.md 1.8
      readonly pitch: number;                                // degrees the camera looks down, 0 .. 89.9
      readonly distance: number;                             // metres from the target
      readonly fovY: number }                                // degrees
  | { readonly kind: 'top';
      readonly center: readonly [number, number];            // uv
      readonly span: number };                               // uv width visible across the canvas

interface ViewportDisplay {
  readonly verticalScale: number;     // display only; default 1
  readonly showSea: boolean;          // draw the plane at the document's seaLevel
  readonly sunAzimuth: number;        // degrees, direction towards the sun, engine.md 1.8
  readonly sunElevation: number;      // degrees above the horizon
}

interface PickResult {
  readonly uv: readonly [number, number];
  readonly height: number;                                   // normalised
  readonly position: readonly [number, number, number];      // metres
}

/** What the interface calls. */
interface ViewportHost {
  attach(canvas: OffscreenCanvas, size: ViewportSize): void;   // may be called again with a new canvas
  detach(): void;
  resize(size: ViewportSize): void;
  setCamera(camera: CameraState): void;
  setDisplay(display: ViewportDisplay): void;
  pick(x: number, y: number): Promise<PickResult | null>;      // CSS pixels from the canvas's top-left; null: no terrain there
}

/** What the session drives. Implemented in src/viewport/. `TextureRef` is declared in 5.2. */
interface ViewportContent {
  readonly height: TextureRef | null;
  readonly overlay: { readonly texture: TextureRef; readonly as: 'color' | 'mask' | 'heat'; readonly opacity: number } | null;
  readonly terrainSize: number;
  readonly heightRange: number;
  readonly seaLevel: number;
}

interface ViewportRenderer extends ViewportHost {
  /** Called once, and again after every device replacement. */
  init(gpu: GpuContext, ledger: { reserve(bytes: number, label: string): { release(): void } }): void;
  setContent(content: ViewportContent | null): void;
  dispose(): void;
}
```

The camera position of an orbit camera is
`target − distance × (cos p · cos y, cos p · sin y, −sin p)` with `y = yaw` and
`p = pitch`. The interface owns camera state and input handling and sends the
result; the renderer owns everything drawn. The session calls
`renderer.init(engine.gpu, engine)`: the ledger is `Engine.reserve` (5.1).

**Handedness.** The renderer presents the frame of `engine.md` 1.8
left-handed. A `top` camera shows the field exactly as its image: texel (0, 0)
at the top left, +X to the right, +Y down the screen. No orbit view is the
mirror image of that, so the viewport, the node thumbnails, an exported image
and the landscape in Unreal all show the same terrain (`export-unreal.md` 5.7).
An orbit camera with `yaw` 0 looks along +X and has +Y on its right, as in
Unreal, whose frame is +X forward, +Y right, +Z up.

1. **Same device, no copy.** The renderer draws from the engine's textures. Nothing is read back to display a terrain.
2. **`setContent` is synchronous.** When it returns, the renderer uses no view of the previous content, which the session may release at once. The session calls it when a result is shown; when a loan for a bound port begins, changes or ends, which the evaluator reports through `onLoans` (5.2, 5.11), with the lent texture in place of the published one; and with `null` when the device is lost. A loan is shown only for the node and port the view names and only when its kind is the kind the view asks for (7.4 rule 1); otherwise the shown content stays.
3. **Reading fields.** Fields are bound with `sampleType: 'unfilterable-float'` and read with `textureLoad`, never with a filtering sampler. A field is addressed by `uv` with the vertex-centred mapping `texel = uv × (size − 1)` and interpolated by hand, so the height and the overlay may differ in size, and a loan of any size can stand in for either.
4. **Read-only.** The renderer never writes, clears or destroys a pool texture. Whatever it derives from the content (pyramids, light maps) lives in textures of its own, registered with `ledger.reserve`.
5. **Its own encoder.** The renderer encodes and submits its frames itself. It follows the error-scope rule (5.8) and estimates no submission of its own above the preview slice target (3.5): longer work is spread over frames.
6. **On demand.** A frame is drawn when the camera, the display options, the size, the content or a loan changed, or when the renderer's own progressive work advanced. There is no free-running loop. Frames are scheduled with the worker's `requestAnimationFrame` and submitted from that callback, which runs while the evaluator awaits the GPU; frames and slices therefore alternate on the queue. Measured with 8 ms slices, two in flight: viewport frames completed in a median of 13 ms (Linux; *to calibrate* on the target).
7. **Hidden windows.** In a window that was never shown, the page's `requestAnimationFrame` fires once per second; the worker's fires at the display rate. Nothing in the viewport path waits for a page frame.
8. **Size.** The canvas's backing size is `round(width × dpr)` by `round(height × dpr)`, clamped to `caps.limits.maxTextureDimension2D`. The canvas element is transferred once; when the interface creates a new element it calls `attach` again.

### 7.6 Builds

`build(request)` runs a build in the engine thread, exclusively.

1. A second `build` while one runs rejects with `Error('A build is already running')`.
2. The running preview evaluation is aborted and no preview is scheduled until the build has ended. `setDocument` is still recorded. The viewport stays live and keeps showing the last result, which is pinned.
3. `Engine.trim()` empties the cache and the free lists (2.8).
4. The session emits `request-start` with purpose `'build'` and `build-start`, and calls `opts.build` (7.1) with the engine and a `SessionBuildOptions`: the request's document and output folder, a `requestId` from the session's sequence, an abort signal and an event listener. In the application that function is `buildToFolder` (`export-unreal.md` 3.8): it evaluates with `mode: 'build'` (2.8, 5.3), that `requestId` and staged delivery (5.2), writes through a sink (6.2) into a staging folder, and replaces `outDir` with it when the build succeeds.
5. Every `EvalEvent` and `BuildEvent` of the build is forwarded to subscribers.
6. `cancelBuild()` aborts the signal. The build settles after at most the slices in flight and the abort of the open writers.
7. When the build function settles, the session emits `build-end`, calls `Engine.trim({ keepResolution: previewResolution })`, resolves `build` with its `BuildResult`, and requests a full evaluation of the latest document. Should the function reject, the session emits `build-end` with status `'errors'` and rejects `build` with the same reason.
8. If the device is lost during a build, the build ends with the status the build function reports for it and recovery proceeds as in 7.8. A build is not restarted automatically.

A build's cost is not kept: a cancelled or failed build, and the next build,
start from nothing. A build cache that persists between builds is reserved for
a later version. The memory check of 5.3 makes a build whose outputs cannot
fit fail before it has computed anything. A node whose own working state does
not fit fails when it allocates that state: before its first loop, or for a
coarse-to-fine node at its last refinement (`simulation.md` 1.5), after the
nodes before it have run.

### 7.7 Events

```ts
type EngineEvent =
  | EvalEvent                                                    // 5.10
  | BuildEvent                                                   // export-unreal.md
  | { readonly type: 'request-start'; readonly requestId: number; readonly revision: number;
      readonly purpose: 'view' | 'draft' | 'thumbnails' | 'build' }
  | { readonly type: 'keys'; readonly revision: number; readonly keys: Readonly<Record<string, string>> }   // node id → contentKey
  | { readonly type: 'view-updated'; readonly requestId: number; readonly revision: number;
      readonly resolution: number; readonly draft: boolean; readonly height: boolean; readonly overlay: boolean }
  | { readonly type: 'thumbnail'; readonly nodeId: string; readonly contentKey: string;
      readonly resolution: number; readonly rgba: Uint8ClampedArray }
  | ({ readonly type: 'memory' } & MemoryReport)
  | { readonly type: 'build-start'; readonly requestId: number; readonly resolution: number; readonly outDir: string }
  | { readonly type: 'build-end'; readonly requestId: number; readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost' }
  | { readonly type: 'device-ready'; readonly epoch: number; readonly caps: GpuCaps; readonly budgetBytes: number }
  | { readonly type: 'device-lost'; readonly reason: 'destroyed' | 'unknown'; readonly message: string; readonly nodeId?: string }
  | { readonly type: 'engine-error'; readonly message: string; readonly fatal: boolean };
```

| Event | Emitted |
| --- | --- |
| `request-start` | before the `eval-start` of every evaluation the session makes; says what the request is for |
| `keys` | after every `setDocument` (7.3 rule 8) |
| `view-updated` | when a result is shown (7.3 rule 6). `height` and `overlay` say which parts the view has |
| `thumbnail` | for every `Thumbnail` the engine delivers (5.12) |
| `memory` | after every evaluation and every `trim` |
| `build-start`, `build-end` | 7.6 |
| `device-ready` | when the session starts, and after every recovery |
| `device-lost` | when the device is lost; `nodeId` is the node that was running |
| `engine-error` | `fatal: false`: an uncaptured GPU error, or a slice over the hard ceiling. `fatal: true`: no device can be obtained (7.8); the session does nothing until `retryDevice` |

A consumer of node events applies this rule: an event of a request older than
the newest request that has reported on that node is ignored. `requestId`s
increase, so one comparison settles it.

### 7.8 Device recovery

1. When `gpu.lost` becomes true the session emits `device-lost`, calls `renderer.setContent(null)`, drops its handles without releasing them, and lets the running evaluation settle with `'device-lost'` (5.9).
2. It then calls `reopenGpu()`: at once, again after 1 s, again after 5 s. The first success is passed to `Engine.replaceDevice` and `renderer.init`; the session emits `device-ready` and requests a full evaluation. Measured on Dawn: a replacement device is ready in about 75 ms.
3. Three failures in a row, or a third device loss within 120 s, end automatic recovery: the session emits `engine-error` with `fatal: true` and waits for `retryDevice()`. The limit is deliberate. Windows stops with a system error after five GPU resets within 60 s, and Chromium refuses a page a new adapter after repeated GPU process crashes; a loop that kept retrying would reach both.
4. A node that was running at two losses in a row is not run again (5.9 rule 6).
5. Imported files are read again from disk by their nodes. Nothing the user made is held only on the GPU.

---

## 8. The application

### 8.1 Processes and threads

| Process | Thread | Runs | Has |
| --- | --- | --- | --- |
| Electron main | main | window, native menu, dialogs, project file reading and writing, preferences, launch switches (1.6) | Node, Electron |
| renderer | interface thread | React, the stores, the panels, `EngineClient` | DOM; no Node; the preload bridge |
| renderer | engine worker | `openGpu`, `Engine`, `EngineSession`, the viewport renderer, the build pipeline (`src/export/`) | `navigator.gpu`, `OffscreenCanvas`, `node:fs`, `node:path`, `node:zlib` |
| renderer | CPU worker | `CpuTask.run` (6.3) | plain JavaScript |
| GPU process (Chromium) | | Dawn, the driver | |

The command line is one Node process: the engine on the main thread, CPU tasks
in a worker thread.

A `GPUDevice` cannot be shared between threads. Engine and viewport renderer
are therefore in one thread, and that thread is not the interface's: measured,
compressing one 126 MB image on the interface thread delivered no animation
frame for 2.3 s, and the same in a worker left the interface at 18 ms per frame
at worst.

Builds run in the engine worker. Building in a separate process is reserved for
a later version.

### 8.2 The window

```ts
// src/platform/electron/main/window.ts
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    sandbox: false,
    nodeIntegration: false,
    nodeIntegrationInWorker: true,
    backgroundThrottling: false,
    preload: /* src/platform/electron/preload/preload.ts, built */,
  },
});
```

1. `sandbox: false` with `nodeIntegrationInWorker: true` is what gives the engine worker Node's `fs` and `zlib`. Measured: with `sandbox: true`, or without `nodeIntegrationInWorker`, the worker has neither, and the preload bridge is never visible in a worker.
2. The page has no Node integration. It reaches the main process only through the bridge the preload script exposes (8.6).
3. The page loads only files packaged with the application. Navigation and `window.open` are denied.
4. The engine worker is created by the top-level frame, never by an iframe: a worker has Node integration only when the frame that creates it has it.
5. While a build runs the main process holds `powerSaveBlocker.start('prevent-app-suspension')`.

**Test mode.** `src/platform/electron/main/` implements the test mode that
`testing.md` 2.9 defines: the table there is a requirement on the main process.
It reads `OROGEN_TEST`, `OROGEN_TEST_DRIVER`, a project file as the first
argument, `OROGEN_GPU_PROFILE` (1.1) and `OROGEN_ELECTRON_GPU`; what each does
is stated there and nowhere else. The one effect on this document is the
switch that `OROGEN_ELECTRON_GPU=software` leaves out on Linux (1.6).

### 8.3 The engine worker

`src/platform/electron/worker/engine-worker.ts` is the worker's entry. It:

1. calls `openGpu(navigator.gpu, { profile })`; on `GpuUnavailableError` it posts `engine-error` with `fatal: true` and stops;
2. calls `createEngine` with `createRegistry(nodes)` (5.1), `NodeFileSource(null)`, `createWebCpuRunner()` and the default budget of 2.4;
3. creates the viewport renderer and calls `createSession`, passing as `build` a function that calls `buildToFolder` of `src/export/folder.ts` with `NodeFileSink` (7.1);
4. serves `ClientMessage`s by calling the session, and posts every `EngineEvent`.

The interface sends `setPreferences` and `setProject` before its first
`setDocument`.

The worker is built as a classic script, not a module, and obtains Node's
built-in modules with `require('node:…')`. That combination is the one
measured to work in Electron 44; a module worker with `import 'node:fs'` is not
verified and is not used. Code shared with the command line (`src/export/`,
`src/platform/node/files.ts`) is written with `import … from 'node:…'` and the
worker's bundle leaves those imports external as `require` calls. Only
`node:fs`, `node:path` and `node:zlib` are used in the worker.

### 8.4 Module boundaries

| Folder | May use | Checked by |
| --- | --- | --- |
| `src/core/` | ECMAScript, WebGPU, and the globals `console`, `performance`, `setTimeout`, `clearTimeout`, `queueMicrotask`, `structuredClone`, `AbortController`, `AbortSignal`, `DOMException`, `TextEncoder`, `TextDecoder`, `crypto.getRandomValues`, and `OffscreenCanvas` as a type only. The decoder packages of 8.9, in `src/core/io/` only | `tsconfig.core.json`: `lib: ["ES2024"]`, `types: ["@webgpu/types"]`, `skipLibCheck: true` (without DOM types `@webgpu/types` has unresolved names), plus the ambient file `src/core/globals.d.ts` that declares exactly those globals. Neither DOM nor Node types |
| `src/viewport/` | the above, plus `requestAnimationFrame` and `OffscreenCanvas`; of `src/`, the core's entry modules only | `lib: ["ES2024", "WebWorker"]` |
| `src/export/` | the core's globals, plus `node:fs`, `node:path` and `node:zlib`; of `src/`, the core's entry modules, and `src/platform/node/` from `src/export/cli.ts` alone | Node types |
| `src/platform/node/` | the core's globals, plus Node built-ins and the `webgpu` package; of `src/`, the core's entry modules | Node types |
| `src/cli/` | Node built-ins; of `src/`, the core's entry modules, `src/platform/node/` and `src/export/` | Node types |
| `src/platform/electron/worker/` | worker globals, plus `node:fs`, `node:path`, `node:zlib`; of `src/`, the core's entry modules, `src/viewport/`, `src/export/` and `src/platform/node/files.ts` | `lib: ["ES2024", "WebWorker"]`, Node types |
| `src/platform/electron/main/`, `preload/` | Node and Electron | Node types |
| `src/app/` | DOM, React; of `src/`, the core's entry modules, for types, metadata and document functions, and the types of `src/platform/electron/ipc.ts` | DOM types; no Node types |

The core's **entry modules** are `src/core/runtime.ts`, `src/core/api.ts` and
`src/core/nodes/index.ts` (the preamble says what each exports). `src/core/`
imports nothing from any other folder of `src/`. `src/app/` imports nothing
from `src/export/`, `src/viewport/` or `src/platform/`, except the types of
`src/platform/electron/ipc.ts`. The types of a build that the interface shows
(`BuildResult`, `BuildEvent`, `BuildPlan`) reach it through `runtime.ts`.

### 8.5 Stores and history

There are three stores, each a zustand vanilla store (`createStore` from
`zustand/vanilla`) in its own file under `src/app/state/`. React reads them
with `useStore(store, selector)`.

| Store | Holds | Changed by | Undoable | Saved |
| --- | --- | --- | --- | --- |
| `docStore` | the `GraphDoc`, its revision, the history | transactions only | yes | the `.orogen` file |
| `engineStore` | everything the engine reports: device state, per-node status, progress, errors and timings, keys, the shown view, memory, the build | `EngineEvent`s only | no | no |
| `uiStore` | selection, positions of nodes being dragged, open popups, focus | the panels | no | no |

Engine state changes many times per second (10 progress events per second per
running node). It is kept out of the document store so that no undo snapshot,
no document subscriber and no save ever sees it. Components subscribe to
`engineStore` per node id. Thumbnail pixels are in no store: `src/app/engine/thumbnails.ts`
keeps the last `ImageData` per node id and node components draw it into a plain
2D canvas through a ref.

```ts
import type { Patch } from 'immer';

interface HistoryEntry {
  readonly label: string;                          // shown in the history list: 'Erosion: Duration'
  readonly forward: readonly Patch[];
  readonly inverse: readonly Patch[];
  readonly mergeKey: string | null;
  readonly time: number;                           // performance.now() of the last transaction merged in
  readonly selectionBefore: readonly string[];
  readonly selectionAfter: readonly string[];
}

interface DocState {
  readonly doc: GraphDoc;
  readonly revision: number;                       // +1 on every change of `doc`
  readonly engineRevision: number;                 // the revision of the last change the evaluator can see
  readonly unsaved: boolean;
  readonly path: string | null;
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  readonly gesture: string | null;                 // the merge key of the gesture in progress

  transact(label: string, recipe: (doc: DocDraft) => void, opts?: { mergeKey?: string; undoable?: boolean }): void;
  beginGesture(mergeKey: string): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  load(doc: GraphDoc, path: string | null): void;  // replaces the document, clears the history
  markSaved(path: string): void;
}

interface NodeRuntime {
  readonly requestId: number;                      // the request that last reported on this node
  readonly state: 'idle' | 'running' | 'done' | 'error' | 'skipped';
  readonly cached: boolean;
  readonly fraction: number;                       // 0 .. 1 while running
  readonly label: string | null;
  readonly etaMs: number | null;
  readonly wallMs: number | null;
  readonly peakBytes: number | null;
  readonly error: NodeError | null;                // for 'error'
  readonly upstream: string | null;                // for 'skipped' because of a failed node: that node's id
}

interface EngineState {
  readonly device: { readonly state: 'starting' | 'ready' | 'lost' | 'failed'; readonly caps: GpuCaps | null; readonly message: string | null };
  readonly nodes: Readonly<Record<string, NodeRuntime>>;
  readonly keys: Readonly<Record<string, string>>;             // node id → contentKey of the latest document sent
  readonly thumbnailKeys: Readonly<Record<string, string>>;    // node id → contentKey of the thumbnail last received
  readonly view: { readonly revision: number; readonly resolution: number; readonly draft: boolean } | null;
  readonly evaluation: { readonly requestId: number; readonly purpose: 'view' | 'draft' | 'thumbnails' | 'build';
                         readonly fraction: number; readonly etaMs: number | null } | null;
  readonly build: {
    readonly running: boolean;                                       // build-start .. build-end
    readonly requestId: number | null;                               // build-start
    readonly plan: BuildPlan | null;                                 // build-plan
    readonly target: { readonly index: number; readonly count: number;
                       readonly nodeId: string; readonly label: string } | null;   // build-target
    readonly phase: 'targets' | 'weights' | 'commit' | null;         // build-progress
    readonly fraction: number;                                       // build-progress; 0 before the first
    readonly problems: readonly BuildProblem[];                      // build-problem, in order
    readonly result: BuildResult | null;                             // build-result
    readonly lastStatus: 'ok' | 'errors' | 'aborted' | 'device-lost' | null;   // build-end
  };
  readonly memory: MemoryReport | null;
}

interface UiState {
  readonly selection: readonly string[];           // node ids
  readonly focusedPanel: PanelId | null;
  readonly dragPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>> | null;
}
```

`engineStore` is a pure reduction of the event stream by the rule of 7.7. A
`node-skipped` event with reason `'aborted'` or `'device-lost'` sets the node to
`'idle'`. A node's thumbnail is stale when `keys[id] !== thumbnailKeys[id]`.
`build-start` resets every member of `build` and sets `running` and
`requestId`; the events named in the comments fill the others; `build-end`
clears `running` and sets `lastStatus`. What the last build wrote and reported
stays readable in `plan`, `problems` and `result` until the next one starts.
`EngineClient` calls `setProject` whenever `DocState.path` changes.

**Transactions.**

1. `transact` runs the recipe with immer's `produceWithPatches`. The recipe calls the commands of 4.6 and nothing else touches the draft. A recipe that changes nothing has no effect at all.
2. A transaction with patches adds a history entry, clears `future`, increments `revision` and sets `unsaved`.
3. **Merging.** A transaction is merged into the last entry instead of adding one when both have the same non-null `mergeKey` and either a gesture with that key is in progress or less than 600 ms have passed since the entry's `time`. The merged entry's forward patches are the old ones followed by the new; its inverse patches are the new ones followed by the old.
4. **Gestures.** `beginGesture(key)` on pointer down, `endGesture()` on pointer up. They also call `beginGesture` and `endGesture` of the engine (7.1). Everything transacted with that key in between is one undo step, however long the drag. Keys: `param:<nodeId>:<name>` for a parameter control, `move:<id of the drag>` for moving nodes, `group:<groupId>` for moving or resizing a group.
5. **Not undoable.** `undoable: false` adds no entry and leaves `future` intact. It is used for, and only for, `setView`, `setGraphViewport`, and `setSettings` of `buildResolution` or `previewLevel`. Such a transaction touches no other path, and no undoable transaction touches those paths; that is what keeps earlier patches applicable. Changes under `ui` do not set `unsaved`.
6. `undo` applies the last entry's inverse patches and moves it to `future`; `redo` the reverse. Both increment `revision`, restore the entry's selection and end any gesture.
7. The history holds at most 500 entries and at most 64 MiB of patches; the oldest are dropped.
8. While nodes are dragged their positions live in `uiStore`; one `moveNodes` transaction is made when the drag ends.

**Undo and the engine.** Undo and redo are ordinary document changes with a
new revision. The engine is not told that a change was an undo and has no
history interface: restored parameters produce the keys they had before, and
what is still cached is a hit (5.4).

**What the engine is sent.** `engineRevision` takes the value of `revision`
when a patch touches a path the evaluator reads: `settings`, `edges`, a node
added or removed, a node's `type`, `version`, `params` or `bypass`, or
`ui.view`. `EngineClient` subscribes to `docStore` and calls
`setDocument(doc, revision)` when `engineRevision` has changed. Moving,
renaming or collapsing a node, editing a group and panning the graph send
nothing.

### 8.6 The bridge to the main process

The preload script exposes one object, typed in
`src/platform/electron/ipc.ts`; `src/app/platform.ts` wraps it, and panels call
only that wrapper.

```ts
interface Preferences {
  readonly gpu: EnginePreferences;
  readonly keymap: Readonly<Record<string, string>>;     // command id → key, overriding defaults (8.8)
  readonly layout: unknown;                              // the dock layout
  readonly recent: readonly string[];
}

interface PlatformApi {
  readonly gpuProfile: GpuProfile;
  openProjectDialog(): Promise<string | null>;
  saveProjectDialog(suggestedPath?: string): Promise<string | null>;
  openFileDialog(extensions: readonly string[]): Promise<string | null>;
  chooseFolder(): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;        // atomic: a temporary file, then a rename
  toProjectPath(projectPath: string | null, filePath: string): string;   // the form 6.1 rule 2 stores
  getPreferences(): Promise<Preferences>;
  setPreferences(patch: Partial<Preferences>): Promise<void>;
  setBuildActive(active: boolean): void;
  showInFolder(path: string): void;
  onMenuCommand(listener: (commandId: string) => void): () => void;
  onCloseRequested(listener: () => void): () => void;
  confirmClose(): void;
}
```

Project files are small JSON and go through this bridge as text. Nothing else
does: imported images and exported files are handled in the engine worker.

### 8.7 Panels

```ts
type PanelId = 'graph' | 'viewport' | 'inspector' | 'library' | 'build';

interface PanelDef {
  readonly id: PanelId;
  readonly title: string;
  readonly component: React.ComponentType;
  readonly keepMounted: boolean;                           // true for panels that own a canvas
  readonly placement: { readonly relativeTo?: PanelId; readonly direction?: 'left' | 'right' | 'above' | 'below' | 'within' };
  readonly commands: readonly CommandDef[];                // 8.8
  readonly keys: readonly KeyBinding[];
}
```

| Panel | Contents | Reads | Writes |
| --- | --- | --- | --- |
| `graph` | the node graph, the add-node palette, groups, clipboard, node thumbnails and status | `docStore`, `engineStore` per node, thumbnails | transactions; selection |
| `viewport` | the canvas, camera control, overlays, the height readout | `engineStore` view state, `docStore` settings and view | `EngineClient.viewport`; `setView` |
| `inspector` | the parameters of the selected node, generated from its `ParamDef`s; project settings | `docStore`, selection | transactions with gestures |
| `library` | the node catalogue by category, with search | the node registry (`CommandContext.registry`, 8.8) | starts an add-node drag |
| `build` | build settings, start and cancel, progress, the plan and its problems, the list of written files, errors | `engineStore` build state (8.5) | `EngineClient.build`, `cancelBuild` |

1. Each panel is a folder `src/app/panels/<id>/` whose `index.ts` exports its `PanelDef` as `panel`. `src/app/registry.ts`, the panel registry (not the node registry of 5.1), imports the five and exports them as a list; it is written once and then frozen.
2. A panel imports from `src/app/state/`, `src/app/engine/`, `src/app/ui/`, `src/app/platform.ts` and the core's entry modules `runtime.ts` and `api.ts`; it takes the node registry from `CommandContext` (8.8). It never imports another panel or `src/app/shell/`. Panels affect each other only through the stores and through commands.
3. The shell (`src/app/shell/`) owns the window frame, docking, the menu, the command palette, key dispatch, the status bar, toasts and the theme. It mounts panels from the panel registry into `dockview-react`. Panels with `keepMounted` use dockview's `'always'` renderer: the default renderer removes a hidden panel's element from the document, which would discard a canvas whose control was transferred.
4. Colours, spacing and fonts come only from the CSS custom properties defined in `src/app/shell/theme.css`. A panel's own styles are in CSS modules inside its folder.
5. The inspector has one control per `ParamDef` kind, in `src/app/panels/inspector/controls/<kind>.tsx`. A new kind is a change to `engine.md`. The curve control draws with `evalCurve` and the gradient control with `bakeGradient` (`engine.md` 4.9), so what the user sees is what kernels get. The control of a direction (`unit: 'angle'`, range 0..360) draws 0° pointing right and 90° pointing down, as the top view shows it (`engine.md` 1.8). A control is hidden while its `visibleWhen` does not hold (`engine.md` 4.3).
6. The inspector shows a `length` or `height` value in metres beside the stored value and accepts either (`engine.md` 1.6); it stores the fraction.
7. The dock layout is saved to the preferences with a schema version. A layout that fails to load is replaced by the default from the panels' `placement`. Pop-out windows are not used: a WebGPU canvas moved to another window's document is untested.

### 8.8 Commands and keys

```ts
interface CommandContext {
  readonly doc: StoreApi<DocState>;          // StoreApi: from zustand/vanilla
  readonly engineState: StoreApi<EngineState>;
  readonly ui: StoreApi<UiState>;
  readonly engine: EngineSession;            // the EngineClient
  readonly platform: PlatformApi;
  readonly registry: NodeRegistry;           // createRegistry(nodes), made once in src/app/main.tsx (5.1)
  run(commandId: string): void;
}

interface CommandDef {
  readonly id: string;                       // '<owner>.<name>': 'graph.toggleBypass'
  readonly title: string;                    // shown in the palette and in menus
  enabled?(ctx: CommandContext): boolean;    // default: always
  run(ctx: CommandContext): void | Promise<void>;
}

interface KeyBinding {
  readonly key: string;                      // 'Mod+Shift+Z', 'Tab', 'B', 'F2', 'Backquote'
  readonly command: string;
  readonly scope: PanelId | 'global';
}
```

1. Every user action that is not direct manipulation is a command: menus, the palette, keys and buttons all call `run(commandId)`. A command's owner is the prefix of its id: a panel id, or `file`, `edit`, `view`, `engine` for the shell.
2. **Keys.** A key is written as modifiers in the order `Mod`, `Ctrl`, `Alt`, `Shift`, then a key name derived from `KeyboardEvent.code`: `KeyB` → `B`, `Digit0` → `0`, otherwise the code itself (`Tab`, `Delete`, `F2`, `Backquote`, `Home`). `Mod` is Control on Windows and Linux. Bindings are independent of the keyboard layout.
3. **Dispatch.** One listener, owned by the shell. A binding scoped to the focused panel wins over a `global` one. While a text field has focus, only bindings with `Mod` or a function key are considered, and `Mod+Z`, `Mod+Y`, `Mod+A`, `Mod+C`, `Mod+X`, `Mod+V` are left to the field. Copy, cut and paste in the graph are handled through the DOM clipboard events, not through bindings.
4. **Registration.** At start-up the shell collects commands and bindings from the panel registry and from its own list. Two commands with one id, a binding to an unknown command, or two bindings with the same key and scope stop start-up with a message naming both owners.
5. **User keys.** `Preferences.keymap` replaces the default key of a command. The palette and tooltips show the current key.

Default bindings. A panel declares the bindings of its own scope and may add
others in that scope; `global` bindings are the shell's.

| Key | Command | Scope |
| --- | --- | --- |
| `Mod+N`, `Mod+O`, `Mod+S`, `Mod+Shift+S` | `file.new`, `file.open`, `file.save`, `file.saveAs` | global |
| `Mod+Z`; `Mod+Shift+Z`, `Mod+Y` | `edit.undo`; `edit.redo` | global |
| `Mod+Shift+P`, `F1` | `view.commandPalette` | global |
| `Backquote` | `engine.togglePause` | global |
| `Mod+B` | `build.start` | global |
| `F6` | `viewport.toggleTop` | global |
| `Tab` | `graph.addNode` | graph |
| `Delete`, `Backspace` | `graph.delete` | graph |
| `Mod+D` | `graph.duplicate` | graph |
| `B` | `graph.toggleBypass` | graph |
| `F` | `graph.toggleViewLock` | graph |
| `G` | `graph.useAsTerrain` (sets `view.height` to the selection) | graph |
| `Mod+G` | `graph.group` | graph |
| `F2` | `graph.rename` | graph |
| `Mod+0`, `Home` | `graph.fit` | graph |
| `F` | `viewport.frame` | viewport |

### 8.9 Libraries

Versions are exact. Adding or upgrading a dependency is the integrator's change
(`testing.md`); panel and node owners add none.

| Package | Version | Used for | Rules |
| --- | --- | --- | --- |
| `react`, `react-dom` | 19.3.0 | the interface | |
| `@xyflow/react` | 12.12.0 | the node graph | Controlled mode: nodes and edges are derived from `docStore` and `uiStore`. Undo, clipboard, the add-node palette and groups are ours. Node and edge components are memoised; `nodeTypes` and `edgeTypes` are module constants. `deleteKeyCode={null}`: deletion is a command. Not upgraded to 13 |
| `dockview-react` | 8.5.1 | docking | The MIT package only; `dockview-enterprise` is never added |
| `zustand` | 5.0.15 | the three stores | `zustand/vanilla`. `@xyflow/react` bundles its own zustand 4; the two do not interact |
| `immer` | 11.1.21 | transactions and patches | `enablePatches()` once; used only in `src/app/state/` |
| `@base-ui/react` | 1.9.0 | popovers, menus, selects, tooltips, dialogs | Unstyled primitives. The number field with drag-to-change is our own control, in `src/app/ui/` |
| `react-colorful` | 5.8.1 | the colour picker | |
| `fuzzysort` | 4.0.2 | search in the palettes and the library | |
| `electron` | 44.7.0 | the shell | 1.6, 8.2 |
| `vite`, `@vitejs/plugin-react` | 8.3.4, 6.1.2 | building the interface and the workers | |
| `electron-builder` | 26.15.3 | the Windows package | |
| `typescript` | 7.0.2 | type-checking; erasable syntax only | |
| `@webgpu/types` | 0.1.74 | the WebGPU types of every tsconfig (8.4) | Types only |
| `webgpu` | 0.6.2 | the headless device (1.5) | Never bundled into the application |
| `fast-png` | 8.0.0 | decoding PNG in `src/core/io/` (`export-unreal.md` 4.7) | Runs in the CPU worker. On the `import-src` allow-list of `testing.md` section 4 |
| `geotiff` | 3.0.5 | decoding TIFF in `src/core/io/` | As `fast-png`. Imported by `tiff.ts` alone, with the two workarounds of `export-unreal.md` 4.7 (rules 2 and 3) and behind its predictor checks, which an upgrade re-examines |
| `parse-exr` | 1.0.2 | decoding OpenEXR in `src/core/io/` | As `fast-png`. Imported by `exr.ts` alone, behind the checks of `export-unreal.md` 4.7 |
| `ajv` | 8.20.0 | validating manifests against `MANIFEST_SCHEMA` in tests (`export-unreal.md` 6.1) | Tests only; never imported from `src/` |

### 8.10 Directory layout and ownership

One owner per row. Nobody edits a file outside their rows; a change to a frozen
file is requested from the integrator.

```
src/
  core/                          the engine: integrator, except core/nodes/<category>/ (testing.md)
    runtime.ts  api.ts           entry modules: the engine; what a node file imports
    export-decl.ts               declaration types of export nodes and builds (export-unreal.md section 1)
    globals.d.ts                 the ambient globals core may use (8.4)
    engine.ts                    createEngine
    gpu/                         device.ts caps.ts pool.ts stream.ts throughput.ts tuning.ts readback.ts texels.ts scopes.ts
                                 the kernel system (engine.md section 3): field.ts kernel.ts lib.ts uniforms.ts bindings.ts
                                 generate.ts pipelines.ts run.ts defaults.ts lut.ts hash.ts errors.ts seal.ts
                                 shape.ts scan.ts wgsl-names.ts
    wgsl/                        stdlib.ts hash.ts noise.ts (engine.md 3.8, 3.9)
    ops/                         index.ts kernels.ts types.ts and one file per shared operation (engine.md section 5)
    eval/                        evaluator.ts plan.ts keys.ts cache.ts context.ts errors.ts events.ts thumbnails.ts
                                 convert.ts stats.ts handles.ts progress.ts hooks.ts parts.ts service.ts
    graph/                       doc.ts settings.ts ladder.ts ports.ts param-types.ts canonical.ts params.ts curves.ts node.ts
                                 registry.ts commands.ts validate.ts serialize.ts migrate.ts view.ts lint.ts
    session/                     session.ts scheduler.ts protocol.ts events.ts viewport.ts budget.ts recovery.ts
    io/                          files.ts; the image decoders image.ts png.ts tiff.ts exr.ts and raw.ts (export-unreal.md 4.7)
    cpu/                         tasks.ts runner.ts serve.ts protocol.ts
    nodes/                       index.ts (entry module: `nodes`); one folder per category (testing.md section 1)
  export/                        the build pipeline, encoders and cli.ts (export-unreal.md section 1)
  cli/                           the command-line program `orogen` (testing.md 8.6)
  viewport/                      the viewport renderer (ViewportRenderer)
  platform/
    node/                        gpu.ts files.ts cpu.ts cpu-worker.ts
    electron/
      ipc.ts                     PlatformApi and the channel list
      main/                      main.ts switches.ts window.ts menu.ts preferences.ts
      preload/                   preload.ts
      worker/                    engine-worker.ts cpu-worker.ts cpu.ts
  app/
    main.tsx  registry.ts  platform.ts
    state/                       doc-store.ts engine-store.ts ui-store.ts
    engine/                      client.ts thumbnails.ts
    ui/                          shared controls: scrub field, buttons, popover wrappers
    shell/                       frame, docking, menu, palette, keys, status bar, theme.css
    panels/
      graph/  viewport/  inspector/  library/  build/
tests/
  ui/<owner>/                    the tests of one application owner (testing.md section 1, 8.5)
```

| Owner | Files | Frozen during panel work |
| --- | --- | --- |
| integrator | `package.json`, lockfile, `tsconfig*.json`, the build configuration (`npm run build`, `testing.md` 8.2) and packaging, `src/core/**` outside node categories, `src/cli/**`, `src/app/registry.ts` | yes |
| export | `src/export/**` (`testing.md` 7.1) | |
| platform | `src/platform/**` | `ipc.ts` yes |
| state | `src/app/state/**`, `src/app/engine/**`, `src/app/platform.ts` | yes |
| shell | `src/app/main.tsx`, `src/app/shell/**`, `src/app/ui/**` | `theme.css` token names and `src/app/ui/` exports: yes |
| graph panel | `src/app/panels/graph/**` | |
| viewport | `src/app/panels/viewport/**`, `src/viewport/**` | |
| inspector panel | `src/app/panels/inspector/**` | |
| library panel | `src/app/panels/library/**` | |
| build panel | `src/app/panels/build/**` | |

Each application owner also owns `tests/ui/<owner>/**` under its own name
(`testing.md` 7.1).

What makes parallel panel work safe:

1. The frozen files are complete before panel work starts: the stores with their full state shape, `EngineClient`, the protocol, `PlatformApi`, the panel registry listing all five panels, the shared controls and the theme tokens. A panel folder starts as a `PanelDef` with an empty component.
2. A panel adds a command, a key or a menu entry in its own `PanelDef`, never in a shared file.
3. A panel that needs new state in a store, a new shared control, a new bridge method or a new engine method asks the owner of that file. It does not keep a private copy of shared state.
4. Document changes are made only with the commands of 4.6. A panel that needs a new kind of change asks for a new command in `src/core/graph/commands.ts`.
5. Panels are developed against the real engine in a real window. A panel does not mock the engine; `engineStore` can be fed recorded events in a component test (`testing.md`).
