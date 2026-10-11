# Orogen architecture

Orogen is a node-based procedural terrain generator. A graph of nodes produces
heightfields, masks and colour maps on the GPU; an export step writes them in the
formats Unreal Engine's Landscape system imports.

This document is the contract between the engine, the nodes and the UI. If code
and this document disagree, fix one of them in the same change.

## 1. Stack and verified platform facts

| Piece | Choice |
| --- | --- |
| Language | TypeScript 7, ES modules, erasable syntax only (no enums, no namespaces, no parameter properties) so Node runs sources directly |
| GPU | WebGPU compute shaders in WGSL |
| Desktop shell | Electron 44 (Chromium WebGPU: D3D12 on Windows, Vulkan on Linux) |
| Headless | Node 24+ with the `webgpu` package (Google Dawn bindings); same engine code |
| Tests | `node --test`, running `.ts` directly |

Measured on the dev box (GTX 1660 Ti 6 GB, Linux, Vulkan), October 2026:

- Dawn in Node: adapter limits `maxTextureDimension2D` 32768, `maxStorageBufferBindingSize` 2 GiB − 4, 8 storage textures per stage. Features include `float32-filterable`, `texture-formats-tier1`, `texture-formats-tier2`, `timestamp-query`.
- `r32float` works as a `read_write` storage texture; `rgba32float` works write-only. 10-octave noise at 8129² runs in about 1.2 s; reading back 264 MB takes about 0.3 s.
- Electron on Linux only exposes the real GPU with `--enable-unsafe-webgpu --enable-features=Vulkan`. With the first switch alone it silently falls back to SwiftShader (software). Limits there: 16384 max texture dimension, 4 GiB buffers.
- A hidden `BrowserWindow` (`show: false`) on the real X display can be captured with `webContents.capturePage()` including WebGPU canvases. Under Xvfb the canvas does not present. UI tests therefore use hidden windows, not Xvfb.

Never rely on a feature without checking `device.features`; the engine must run on
a core-only adapter (software D3D12 on CI) with reduced speed, not reduced correctness.

## 2. Source layout

```
src/
  core/        Engine. Imports nothing from DOM, Node or Electron. WebGPU + standard JS only.
    gpu/       device context, texture pool, kernel compiler/runner, readback, statistics
    wgsl/      shared WGSL libraries exported as TS strings
    graph/     document model, node registry, evaluator, serialisation
    nodes/     node definitions, one folder per category
    io/        pure-TS image encoders/decoders
    export/    build pipeline and Unreal packaging
    preview/   offline 2D/3D preview renders (also used for thumbnails and tests)
  platform/
    node/      Dawn device creation, file sink on fs, CLI
    electron/  main process, preload bridge
  app/         renderer UI (React)
tests/         node:test suites and the visual test helpers
```

WGSL lives in `.ts` files as template strings (`/* wgsl */ \`...\``). No loader is
needed in any environment.

Imports use explicit `.ts` extensions.

## 3. Data model

### 3.1 Fields

A **field** is a 2D GPU texture at the evaluation resolution.

| Kind | Format | Meaning |
| --- | --- | --- |
| `field` | `r32float` | scalar: a height or a mask |
| `color` | `rgba16float` | linear RGB colour + alpha |
| `aux` | `rgba32float` | simulation state; never crosses a port |

Heights are normalised: `1.0` equals `heightRange` metres. Values outside 0..1 are
legal inside the graph and are clamped only at export. Masks are 0..1.

All field textures are created with
`STORAGE_BINDING | TEXTURE_BINDING | COPY_SRC | COPY_DST`.

### 3.2 Sampling convention

Samples sit on grid vertices, matching Unreal landscape vertices:

```
uv       = vec2f(px) / vec2f(res - 1)            // 0 and 1 land exactly on the borders
worldUV  = frame.regionOrigin + uv * frame.regionSize
worldPos = worldUV * frame.terrainSize           // metres
cellSize = terrainSize * regionSize / (res - 1)  // metres per texel
```

A full evaluation has `regionOrigin = (0,0)`, `regionSize = (1,1)`. The region
exists so a later tiled evaluator can render a window of the world; generators
must use `worldUV`, never `px`, to position features.

### 3.3 Resolution independence

The same graph is evaluated at 512–2048 for preview and up to 8129 for builds.
A node must look alike at every resolution. Rules:

1. Generators evaluate functions of `worldUV`. Feature size is a parameter in
   world terms (fraction of terrain or metres), never in pixels.
2. Neighbourhood sizes are parameters in metres or percent of terrain width and
   are converted with `cellSize`.
3. Slopes use world units: `(dh * heightRange) / cellSize`.
4. Simulations scale step sizes and iteration counts with `cellSize` as section 9
   prescribes for each algorithm.
5. Randomness comes from integer hashes of world-space lattice coordinates and
   the seed, never from `px` or from `fract(sin())`.

### 3.4 Frame uniform

Bound at `@group(0) @binding(0)` in every kernel:

```wgsl
struct Frame {
  res: vec2u,           // output resolution in texels
  regionOrigin: vec2f,
  regionSize: vec2f,
  terrainSize: vec2f,   // metres
  cellSize: vec2f,      // metres per texel
  heightRange: f32,     // metres represented by height 1.0
  seed: u32,            // project seed mixed with the node's seed
  iteration: u32,       // loop counter for simulations, else 0
  _pad: u32,
};
```

## 4. Kernels

A kernel is one compute pipeline plus the metadata needed to bind it. Authors
declare resources; the framework generates the WGSL declarations, an explicit
bind group layout (never `layout: 'auto'`, which drops unused bindings), the
uniform packing and the dispatch.

```ts
type ScalarType = 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec3f' | 'vec4f';
type FieldKind = 'field' | 'color' | 'aux';

interface KernelDef {
  name: string;                                   // unique; cache key and debug label
  inputs?: Record<string, FieldKind>;             // texture_2d<f32>, read with textureLoad
  outputs?: Record<string, FieldKind>;            // texture_storage_2d<fmt, write>
  readWrite?: Record<string, 'field'>;            // texture_storage_2d<r32float, read_write>
  params?: Record<string, ScalarType>;            // packed into `struct Params`, bound as `p`
  luts?: Record<string, 'f32' | 'vec4f'>;         // read-only storage buffers (curves, gradients)
  includes?: string[];                            // WGSL library strings
  workgroup?: [number, number];                   // default [8, 8]
  code: string;
  mode?: 'map' | 'raw';                           // default 'map'
}
```

`map` mode covers most nodes. The author writes one function and the framework
generates the entry point, bounds check and store:

```wgsl
// one output of kind `field`
fn compute(px: vec2i, uv: vec2f, wuv: vec2f) -> f32 { ... }
// one output of kind `color` or `aux`
fn compute(px: vec2i, uv: vec2f, wuv: vec2f) -> vec4f { ... }
```

`raw` mode gets the generated declarations only and writes its own
`@compute fn main`. Simulations with several outputs use it.

Declared inputs are plain texture variables named as declared. The standard
library (always included) provides clamped access, so a 1×1 texture behaves as a
constant:

```wgsl
fn ld(t: texture_2d<f32>, p: vec2i) -> f32          // clamped scalar load
fn ld4(t: texture_2d<f32>, p: vec2i) -> vec4f
fn bilinear(t: texture_2d<f32>, uv: vec2f) -> f32   // uv in buffer space, clamped
fn bilinear4(t: texture_2d<f32>, uv: vec2f) -> vec4f
fn slopeAt(t: texture_2d<f32>, p: vec2i) -> vec2f   // world-unit gradient (dz/dx, dz/dy)
fn normalAt(t: texture_2d<f32>, p: vec2i) -> vec3f
```

An input left unbound at run time is bound to a 1×1 texture holding that input's
default (masks default to 1, everything else to 0).

Running:

```ts
ctx.run(kernel, {
  in:  { src: a, mask: m },        // omitted optional inputs get the 1×1 default
  out: { out: dst },
  rw:  { h: height },
  params: { strength: 0.5, offset: [0.1, 0.2] },
  luts: { curve: Float32Array },
  iteration: i,                    // optional override of frame.iteration
});
```

`run` only encodes. Work reaches the GPU when the evaluator flushes; see 6.3.

Compilation errors must be reported with the kernel name, the WGSL line and the
surrounding source lines (from `getCompilationInfo()`), because most engine bugs
will be shader typos.

## 5. Nodes

```ts
type PortType = 'field' | 'color';

interface PortDef {
  name: string;
  type: PortType;
  label?: string;
  optional?: boolean;       // inputs only
}

type ParamDef =
  | { kind: 'float'; name: string; label?: string; default: number; min: number; max: number;
      step?: number; unit?: 'm' | '%' | 'deg' | 'x' | ''; scale?: 'linear' | 'log'; soft?: boolean }
  | { kind: 'int'; name: string; label?: string; default: number; min: number; max: number }
  | { kind: 'bool'; name: string; label?: string; default: boolean }
  | { kind: 'enum'; name: string; label?: string; default: string; options: { value: string; label: string }[] }
  | { kind: 'seed'; name: string; label?: string; default: number }
  | { kind: 'vec2'; name: string; label?: string; default: [number, number]; min?: number; max?: number }
  | { kind: 'color'; name: string; label?: string; default: [number, number, number] }
  | { kind: 'curve'; name: string; label?: string; default: CurvePoint[] }      // 0..1 → 0..1
  | { kind: 'gradient'; name: string; label?: string; default: GradientStop[] }
  | { kind: 'file'; name: string; label?: string; filters?: string[] }
  | { kind: 'text'; name: string; label?: string; default: string };
// every ParamDef may also carry: group?: string; help?: string; visibleWhen?: (params) => boolean

interface NodeDef {
  type: string;             // stable id, 'category/name', never renamed once shipped
  title: string;
  category: Category;
  description: string;
  keywords?: string[];
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  maskable?: boolean;       // evaluator adds a `mask` input and blends result over inputs[0]
  cost?: 'light' | 'medium' | 'heavy';
  version?: number;
  migrate?(params: Record<string, unknown>, from: number): Record<string, unknown>;
  evaluate(ctx: EvalContext): Promise<void> | void;
}
```

The evaluation context:

```ts
interface EvalContext {
  readonly res: [number, number];
  readonly cellSize: [number, number];     // metres
  readonly terrainSize: [number, number];  // metres
  readonly heightRange: number;            // metres
  readonly mode: 'preview' | 'build';
  readonly signal: AbortSignal;
  readonly params: Readonly<Record<string, any>>;   // validated, defaults filled in

  input(name: string): Field | null;       // null when an optional input is unconnected
  alloc(kind: FieldKind): Field;           // owned by the node until passed to output()
  temp(kind: FieldKind): Field;            // released automatically when evaluate() returns
  output(name: string, field: Field): void;

  run(kernel: Kernel, bindings: RunBindings): void;
  loop(iterations: number, body: (i: number) => void): Promise<void>;  // flushes, yields, reports progress, honours signal
  flush(): Promise<void>;

  stats(field: Field): Promise<{ min: number; max: number; mean: number }>;
  read(field: Field): Promise<Float32Array>;                 // tightly packed, row-major
  write(field: Field, data: Float32Array): void;
  readFile(path: string): Promise<Uint8Array>;               // for import nodes
  progress(fraction: number, label?: string): void;
}
```

Rules for node authors:

- A node never keeps state between evaluations and never touches the device
  directly. Everything goes through the context so caching, budgeting and
  cancellation keep working.
- Passing an input straight to `output()` is allowed (the pool reference-counts).
- A node that needs many iterations uses `ctx.loop`, never a bare `for` around
  `ctx.run`, so long simulations cannot trip the Windows GPU watchdog and can be
  cancelled.
- Parameters are stored in the document exactly as the user set them. Conversion
  to pixels or iterations happens inside `evaluate`.

Each category folder exports `nodes: NodeDef[]` from its `index.ts`;
`src/core/nodes/index.ts` concatenates them into the registry.

## 6. Graph and evaluation

### 6.1 Document

```ts
interface GraphDoc {
  format: 'orogen';
  version: number;
  settings: {
    terrainSize: number;        // metres, square in v1
    heightRange: number;        // metres
    seed: number;
    previewResolution: number;
    buildResolution: number;
    seaLevel: number;           // normalised height, used by viewport and coastal nodes
  };
  nodes: Record<string, NodeInstance>;
  edges: Edge[];
  frames: Frame[];              // visual groups
  ui: { viewNode?: PortRef; pinNode?: PortRef; graphViewport?: { x: number; y: number; zoom: number } };
}
interface NodeInstance {
  id: string; type: string; version: number;
  position: { x: number; y: number };
  params: Record<string, unknown>;
  title?: string; bypass?: boolean; collapsed?: boolean;
}
interface Edge { id: string; from: PortRef; to: PortRef }
interface PortRef { node: string; port: string }
```

Files are JSON with the extension `.orogen`. Unknown node types load as
placeholder nodes that keep their data and report an error, so a file from a
newer version is never silently damaged.

### 6.2 Evaluator

```ts
evaluator.evaluate(doc, targets: PortRef[], {
  resolution, mode, signal, onNodeStatus,
}): Promise<Map<string, Field>>
```

- Evaluation is pull-based from the targets, in topological order.
- Each node output is cached under a key hashed from: node type and version,
  canonical JSON of params, the keys of its inputs, resolution, region and the
  settings that affect results. Dirty tracking falls out of hashing; there is no
  separate invalidation pass.
- An input of the wrong port type is converted (`field`→`color` as grey,
  `color`→`field` as luminance) by a built-in kernel.
- `bypass` forwards `inputs[0]` to `outputs[0]`.
- A node failure is captured with the node id and message; nodes downstream of it
  are skipped and report "upstream error". One bad node never takes down the
  evaluation of unrelated branches.
- Each node runs inside validation and out-of-memory error scopes. On
  out-of-memory the evaluator evicts every unpinned cache entry and retries the
  node once.

### 6.3 Flushing and the GPU watchdog

Windows kills a device whose single submission runs for about two seconds. The
evaluator therefore owns the command encoder:

- `run` appends a pass. The evaluator submits when the encoder holds an estimated
  quota of work (texels × passes) and after every node.
- `loop` measures the wall time of its first batches (submit, then
  `queue.onSubmittedWorkDone()`), then sizes batches to about 50 ms in preview
  mode and 250 ms in build mode. Between batches it checks the abort signal and
  reports progress.

### 6.4 Texture pool and memory budget

WebGPU cannot report free VRAM, so the pool keeps its own ledger.

- Textures are pooled by `(width, height, format)` and reference-counted.
- Budget: default 60% of a configurable VRAM figure (10 GB on the target, set in
  preferences; 4 GB assumed when unknown).
- Preview mode keeps an LRU cache of node outputs and evicts the least recently
  used unpinned entries when over budget.
- Build mode frees a node's outputs as soon as its last consumer has run, so an
  8129² build peaks at the widest cut of the graph, not its total size.
- One 8129² `field` is 264 MB, a `color` 529 MB, an `aux` 1.06 GB. Nodes must
  release temporaries promptly; simulations at that size are the budget's main
  customer.

## 7. Files and export

```ts
interface FileSink { write(relPath: string, data: Uint8Array): Promise<void> }
interface FileSource { read(path: string): Promise<Uint8Array> }
```

Node implements these on `fs`; the Electron renderer implements them through the
preload bridge; the core never imports either.

Encoders in `core/io` are pure TypeScript and take a pluggable deflate function
(`CompressionStream` by default, Node's zlib when the platform supplies it).

Export nodes describe files to write. `buildProject(doc, { resolution, sink })`
evaluates at build resolution and writes the files plus a `manifest.json`.

## 8. Unreal Engine conventions

*Completed from the research report before implementation; see section 12.*

## 9. Simulation algorithms

*Completed from the research report before implementation; see section 12.*

## 10. Application

The renderer owns one `GPUDevice`. The evaluator and the viewport share it, so
the viewport draws node outputs straight from their textures with no readback.

- State: one store holding the document, selection, the viewed and pinned ports,
  per-node status and thumbnails. Every document mutation goes through named
  actions so undo/redo is a property of the store.
- Editing a parameter triggers a debounced preview evaluation; a newer edit
  aborts the running one through its `AbortSignal`.
- Heavy nodes report progress on the node and in the status bar.
- Builds run at build resolution in the same process, in build mode, with a
  cancellable progress dialog.

## 11. Testing

- Unit tests for packing, hashing, serialisation, encoders (round-trips).
- GPU tests run each kernel through Dawn at small sizes and assert numeric
  properties (range, symmetry, conservation, determinism across resolutions).
- Visual checks: the CLI renders any node to a hillshaded PNG and a 3D preview so
  a reviewer can look at the terrain rather than at numbers.
- UI tests drive a hidden Electron window and capture screenshots.
- CI runs type-check and the test suite on Linux and Windows using software
  adapters, and packages the Windows build.

## 12. Open sections

Sections 8 and 9 and the choice of UI libraries are filled in from the research
reports (`unreal-landscape`, `erosion-algorithms`, `ui-stack`).
