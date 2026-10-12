# Testing contract: harness, conformance, conventions and parallel work

This document defines how Orogen is tested and how many people work on it at
the same time without colliding. With `engine.md` it is everything a node
author needs. It defines the test harness, the conformance suite every node
passes, the registry lint, the definition of done, the naming and text
conventions, file ownership, the test layers, the command-line program, the CI
layout and the acceptance graphs.

Other documents own what is only referred to here:

| Document | Owns |
| --- | --- |
| `engine.md` | fields, kernels, `NodeDef`, `EvalContext`, shared ops, value and unit conventions, the resolution ladder |
| `runtime.md` | `createNodeGpu`, `GpuContext`, `GpuCaps`, the profiles, the pool and `MemoryReport`, slices and tiles, `GraphDoc`, `ProjectSettings`, the document commands, `NodeRegistry`, `createRegistry`, `nodes`, `Engine`, `EvaluateOptions`, `EvalEvent`, `NodeError`, `EngineTestHooks`, `FileSource`, `FileSink`, `EngineSession`, the application, and the layout and ownership of `src/app/`, `src/platform/` and `src/viewport/` |
| `export-unreal.md` | export nodes, `buildProject`, `BuildResult`, the encoders, the manifest, the `build` and `unreal-test` subcommands, the manual Unreal import and its acceptance pattern |
| `simulation.md` | the simulation algorithms and the invariants their nodes must keep |

Vocabulary used throughout:

| Term | Meaning |
| --- | --- |
| owner | the one person or team that may change a folder (section 7) |
| integrator | the role that alone changes frozen files and applies change requests |
| hardware adapter | a physical GPU |
| software adapter | a CPU implementation of the GPU API (`caps.software`): lavapipe (`llvmpipe`) on Linux, WARP (`Microsoft Basic Render Driver`) on Windows, SwiftShader inside Electron |
| profile | `GpuProfile`: `core` (default limits, no optional features) or `max` (the adapter's values for four limits, plus `texture-formats-tier1` and `timestamp-query` where the adapter has them; `runtime.md` 1.2) |
| bit-identical | every float has the same 32 bits |

---

## 1. Layout

```
src/core/nodes/index.ts                  imports the nine category indexes; export const nodes (runtime.md 5.1)
src/core/nodes/<category>/index.ts       export const nodes: readonly NodeDef[]
src/core/nodes/<category>/<name>.ts      one node; its NodeDef is the default export
src/core/nodes/<category>/_<name>.ts     private modules of the category: libraries, shared kernels, CPU tasks, helpers; in generate
                                         and simulate also the private index module of each of the two owners (nodes.md 1 and 4)
src/cli/                                 the command-line program (8.6): main.ts probe.ts render.ts gallery.ts preview.ts, and the modules they share

tests/helpers/                           the harness (section 2)
tests/tools/                             verify.ts expect.ts ownership.ts (5.3, 10.3, 7.1)
tests/env/                               max.env lavapipe.env warp.env (8.2)
tests/unit/                              GPU-free tests of core code and of the command line (cli/); registry lint; import boundaries
tests/engine/                            GPU tests of the kernel system, evaluator, pool, shared ops and the session (session/); the command line as child processes (cli/)
tests/nodes/<category>/<name>.test.ts    GPU tests of one node (section 5)
tests/nodes/<category>/unit/*.test.ts    GPU-free tests of the category's CPU code
tests/nodes/<category>/assets/           small data files of the category's tests
tests/export/*.test.ts                   GPU tests of the build pipeline
tests/export/unit/*.test.ts              GPU-free tests of planning, encoders and the manifest
tests/graphs/                            acceptance graphs, their expectations, assets and tests (section 10)
tests/electron/                          the kernel test inside Electron; the application test driver
tests/ui/<owner>/*.test.ts               hidden-window tests of one application owner
tests/ui/<owner>/unit/*.test.ts          GPU-free, window-free tests of one application owner
test-output/                             everything tests and tools write; never committed
docs/changes/                            change requests (7.4)
```

The folder a test file is in decides its layer (section 8). A test file placed
anywhere else is never run.

---

## 2. The test harness

The harness is `tests/helpers/`. Tests import it through
`tests/helpers/index.ts` only, and node tests import nothing else from the
repository except their own category's sources:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformance, renderNode, fixtures, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/blur.ts';
```

Rules:

1. The harness creates the device, with `createNodeGpu` (`runtime.md` 1.1). No test file imports the `webgpu` package, calls `create()` or `requestAdapter()`, or destroys a device.
2. One device per process. `node --test` runs every test file in its own process, so every file has its own device and its own registry.
3. Tests in `tests/nodes/` never touch a `GPUDevice`, a texture, the `Engine` or an `EvalContext` directly. They use the functions below.
4. Every evaluation made through the harness is a call of `Engine.evaluate` on a real `Engine`: there is no second, simplified execution path.
5. The harness never compares images or hashes. It compares numbers with stated tolerances (3.4).

Types used below without a definition come from `engine.md` (`NodeDef`,
`ParamValue`, `FieldKind`) and `runtime.md` (`GpuContext`, `Engine`,
`GpuProfile`, `ProjectSettings`, `GraphDoc`, `EvalEvent`, `NodeError`,
`FileSource`, `FileSink`) and `export-unreal.md` (`BuildResult`, `BuildEvent`).

### 2.1 Engine and environment

```ts
type Slices = 'auto' | 'small' | 'one';

interface TestEngine {
  readonly gpu: GpuContext;        // gpu.profile; gpu.caps.software, .compactFormats, .adapter
  readonly engine: Engine;         // for tests/engine, tests/export and tests/graphs
}

/** The process's engine with the given slicing. Created on first use; disposed by a root-level after() hook the harness registers. */
declare function getEngine(slices?: Slices): Promise<TestEngine>;       // default 'auto'

declare const TEST_SETTINGS: ProjectSettings;
// { terrainSize: 4096, heightRange: 1024, seed: 1, buildResolution: 513, previewLevel: 1, seaLevel: 0.25 }
```

The process environment selects the device. The harness reads it once:

| Variable | Values | Harness default | Effect |
| --- | --- | --- | --- |
| `OROGEN_GPU_PROFILE` | `core`, `max` | `core` | the `profile` passed to `createNodeGpu`. The harness passes `core` explicitly when the variable is unset; the factory's own default is `max` |
| `OROGEN_GPU_ADAPTER` | case-sensitive substring of an adapter name | unset: the default adapter | the `adapter` passed to `createNodeGpu`: `llvmpipe`, `Microsoft`, `NVIDIA` |
| `OROGEN_TEST_OUTPUT` | a folder | `test-output` | where previews and reports are written |

The harness builds its engine like this:

```ts
createEngine({
  gpu,                                           // one GpuContext per process
  registry: createRegistry(defs),                // runtime.md 5.1; `defs` is defined below
  files: NodeFileSource('<repository>/tests'),
  cpu: createNodeCpuRunner(),
  budgetBytes: 1_073_741_824,
  test: HOOKS[slices],
});
```

`defs` holds the reference nodes (`src/core/nodes/ref/index.ts`), the harness's
two source nodes, `ref/harness-source` and `ref/harness-source-color`, and
every `NodeDef` the test file has handed to the harness: the argument of
`conformance`, `renderNode`, `traceNode`, `renderLadder`, `registryDoc` and
`useNodes`.

```ts
/** Adds definitions to the registry of this process's engine. For a test whose graph names nodes by type
 *  (a GraphSpec, a document, a project file): called at module scope with the definitions the file imports. */
declare function useNodes(defs: readonly NodeDef[]): void;
```

- The harness never imports `src/core/nodes/index.ts`. A test process therefore loads the reference nodes and the node files its test file imports, and nothing else: a category that fails to load breaks only the tests that import it.
- A definition handed over after the engine exists replaces the engine, as a change of `slices` does (below).
- A graph that names a type the registry lacks reports that node with kind `unknown-type`, as the application would.
- The CPU worker of a test process is the product's (`runtime.md` 6.3) and imports `src/core/nodes/index.ts`. A CPU task that is defined only in a test file therefore cannot run, and a test of a node that calls `ctx.cpu` needs every category to load.

Every engine the harness creates also gets one `onSlice` hook
(`runtime.md` 5.14). The harness forwards each call to the `onSlice` callback
of the harness call in progress (2.3, 2.4) and counts slices for the reports.

| `slices` | `EngineTestHooks` | Effect (`runtime.md` section 3) |
| --- | --- | --- |
| `'auto'` | `{ poisonRecycled: true, onSlice }` | slices and tiles as the runtime chooses |
| `'small'` | `{ poisonRecycled: true, onSlice, sliceTargetMs: 1e-6 }` | every run is cut into tiles one workgroup high, every dispatch is its own slice, and `ctx.loop` waits after every iteration |
| `'one'` | `{ poisonRecycled: true, onSlice, sliceTargetMs: 1e9 }` | no run is tiled, and a slice closes only where the stream has to wait |

- One `Engine` is alive at a time. A call that needs another `slices` value disposes the live engine and creates the next on the same `GpuContext` (`runtime.md` 5.1 allows it). Pipelines are then compiled again, so a test groups its evaluations by `slices`.
- `poisonRecycled` is always on: a texture the pool hands out a second time holds −1e30 instead of its previous owner's data, while a new one holds zeros. A kernel that reads a texel it never wrote therefore gives different results on a fresh and on a used pool (3.2, `deterministic`).
- An adapter name that matches nothing fails `getEngine()` with the factory's `GpuUnavailableError`; nothing falls back silently.
- With the test settings a cell is 16 m at resolution 257, 8 m at 513 and 32 m at 129.
- Test resolutions are 129, 257, 513, 1025 and 2049, and 33 in the `short-ladder` check (3.2). They are levels of one ladder (`engine.md` 1.5), so every vertex of a coarser one is a vertex of the finer ones. A harness function that takes `res` accepts any resolution legal under `engine.md` 1.5.
- Values a test file passes to a node come from the test process. To feed CPU data to a node's input the harness uses two private node types that upload with `ctx.write`: `ref/harness-source` for a field and `ref/harness-source-color` for a colour, because an output port has one kind (`engine.md` 4.2). They exist in test processes only.

### 2.2 Field data and fixtures

```ts
interface FieldData {
  readonly kind: 'field' | 'color';
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly data: Float32Array;              // row-major, tightly packed: the layout of ctx.read (engine.md 4.7)
}

declare function fieldOf(res: number, fn: (u: number, v: number) => number): FieldData;
declare function colorOf(res: number, fn: (u: number, v: number) => readonly [number, number, number, number]): FieldData;
declare function at(f: FieldData, x: number, y: number, channel?: number): number;      // channel defaults to 0
declare function channelOf(f: FieldData, channel: 0 | 1 | 2 | 3): FieldData;            // a 'field' holding one channel of a colour

type FixtureName =
  | 'terrain' | 'rampX' | 'rampY' | 'cone' | 'basin' | 'bowl' | 'notch'
  | 'mask' | 'zero' | 'one' | 'impulse' | 'color' | 'fbm';

declare const fixtures: {
  terrain(res: number): FieldData;
  rampX(res: number): FieldData;
  rampY(res: number): FieldData;
  cone(res: number): FieldData;
  basin(res: number): FieldData;
  bowl(res: number): FieldData;
  notch(res: number): FieldData;
  mask(res: number): FieldData;
  zero(res: number): FieldData;
  one(res: number): FieldData;
  impulse(res: number): FieldData;
  color(res: number): FieldData;
  fbm(res: number, seed?: number): Promise<FieldData>;     // seed defaults to 0
  byName(name: FixtureName, res: number): Promise<FieldData>;
};
```

`fieldOf` and `colorOf` call `fn` with `(u, v) = (x / (res − 1), y / (res − 1))`
and store `Math.fround` of the result. Every fixture except `fbm` is defined
this way, on the CPU, so a fixture at one test resolution is exactly the
decimation of the same fixture at a finer one.

| Fixture | Value at `(u, v)` | Use |
| --- | --- | --- |
| `terrain` | `0.5 + 0.22·sin(2π(u + 0.5v) + 0.3) + 0.10·sin(2π(−2u + 3v) + 1.7) + 0.05·sin(2π(5u + 4v) + 4.1) + 0.025·sin(2π(9u − 7v) + 2.9)` | the default height input. Within 0.105..0.895, with 41 interior local minima (N8) and, under the N4 filling of `simulation.md` section 6, between 26 and 30 depressions depending on the resolution and the sea level: a test asserts no count. Band-limited: its shortest wavelength is 11.2 cells at resolution 129. With the test settings its slopes reach 55° |
| `rampX`, `rampY` | `u`; `v` | exact slopes: with the test settings the physical slope is 0.25 m/m (14.04°) |
| `cone` | `max(0, 1 − 4·hypot(u − 0.5, v − 0.5))` | radial symmetry; a single peak on a flat floor. With the test settings its flank is at 45°, steeper than every talus default |
| `basin` | `0.3 + 0.4u − 0.35·exp(−((u − 0.5)² + (v − 0.5)²) / 0.0288)` | a slope with one closed depression. Its floor is at 0.147; 3 % of the field lies below the test sea level of 0.25, and that part does not touch the border |
| `bowl` | `0.3 + 0.6·(2·max(abs(u − 0.5), abs(v − 0.5)))²` | a closed bowl whose border ring is the highest part (0.9). Its lowest point, 0.3, is above the test sea level of 0.25, so it has no sink |
| `notch` | `0.75 − 0.5u − 0.05·max(0, 1 − abs(v − 0.5) / 0.1)` | a plane falling towards +X with one V-shaped channel along its centre line; no depression; nowhere steeper than 10.1° with the test settings |
| `mask` | `saturate((0.35 − hypot(u − 0.5, v − 0.5)) / 0.15)` | the default mask input: exactly 1 inside radius 0.2, exactly 0 outside 0.35 |
| `zero`, `one` | `0`; `1` | constants |
| `impulse` | 1 at the centre texel, else 0 | kernel shape and symmetry. Not band-limited: behaviour tests only |
| `color` | `(u, v, terrain(u, v), 1)` | the default colour input |
| `fbm` | output `out` of `ref/fbm` at default parameters with the given node seed and the test settings | realistic fractal input for behaviour tests. Not band-limited and computed on the GPU: never used for a ladder comparison |

### 2.3 Rendering a node

```ts
interface RenderOptions {
  readonly res?: number;                                                      // default 257
  readonly params?: Readonly<Record<string, ParamValue>>;
  readonly inputs?: Readonly<Record<string, FieldData | FixtureName | null>>;
  readonly mask?: FieldData | FixtureName;                                    // maskable nodes only
  readonly wants?: readonly string[];                                         // default: every output
  readonly settings?: Partial<ProjectSettings>;                               // merged over TEST_SETTINGS
  readonly signal?: AbortSignal;
  readonly slices?: Slices;                                                   // default 'auto'
  readonly fieldBudgetBytes?: number;                                         // default: the engine's budget is left alone
  readonly onSlice?: (s: { readonly nodeId: string | null; readonly kernels: readonly string[]; readonly measuredMs: number }) => void;
}

interface NodeReport {
  readonly nodeId: string;
  readonly state: 'done' | 'cached' | 'unused' | 'bypassed' | 'error' | 'skipped';   // 'unused': runtime.md 5.3 step 5
  readonly error: NodeError | null;            // for 'error'
  readonly skipReason: 'upstream' | 'aborted' | 'device-lost' | null;   // for 'skipped'
  readonly upstream: string | null;            // for 'skipped' because of a failed node: that node's id
  readonly wallMs: number;                     // node-done.wallMs; 0 unless 'done'
  readonly peakBytes: number;                  // node-done.peakBytes; 0 unless 'done'
  readonly progress: readonly number[];        // the fraction of every node-progress event, in order
  readonly slices: number;                     // slices completed while the node ran
}
interface EvalReport {
  readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  readonly events: readonly EvalEvent[];       // everything the evaluation emitted, in order
  readonly nodes: Readonly<Record<string, NodeReport>>;
  readonly nodesRun: number;
  readonly nodesCached: number;
  readonly slices: number;
  readonly longestSliceMs: number;             // the longest slice whose duration was measured (runtime.md 3.5); 0 when none was
}

declare class NodeFailure extends Error { readonly error: NodeError; readonly report: EvalReport }

declare function renderNode(def: NodeDef, opts?: RenderOptions): Promise<Readonly<Record<string, FieldData>>>;
declare function traceNode(def: NodeDef, opts?: RenderOptions): Promise<{
  readonly outputs: Readonly<Record<string, FieldData>>;
  readonly report: EvalReport;                 // the node under test has the id 'node'
}>;
```

`renderNode` evaluates one instance of `def` and returns the wanted outputs by
port name. `traceNode` does the same and also returns what the evaluation did.

Both build a document that holds the node, with the id `node`, and one source
node per connected input (`src0`, `src1`, … in the order of the inputs, and
`srcmask` for the mask), and evaluate it with `mode: 'build'` and one target
per wanted output. A build evaluation neither reads nor writes the cache, so
the node always runs, and `ctx.wants()` is true exactly for the targets
(`runtime.md` 2.8, 5.2).

| Option | Semantics |
| --- | --- |
| `res` | the evaluation resolution, `ctx.res` |
| `params` | merged over the node's defaults and stored with `setParam`, so they are normalised exactly like values loaded from a document; an unknown name rejects before anything runs |
| `inputs` | by input port name. A `FieldData` must be `res × res` and of a kind the port accepts. A name is the fixture at `res`. `null` leaves the input unconnected. An input not listed gets its default fixture (3.1) |
| `mask` | connects the mask the evaluator adds to a maskable node (`engine.md` 4.13). Omitted: unconnected |
| `wants` | the outputs that are targets; only these are returned |
| `settings` | project settings for this evaluation |
| `signal` | cancels the evaluation |
| `slices` | the engine used (2.1) |
| `fieldBudgetBytes` | the memory available to fields: the harness calls `Engine.setBudget(memory().reservedBytes + fieldBudgetBytes)` for this evaluation and restores the budget afterwards |
| `onSlice` | called when a slice completes, from the engine's `onSlice` hook (2.1). `nodeId` is the node whose invocation owns the slice, `null` for a slice of an engine service |

Outcome:

| The evaluation ends with | `renderNode` and `traceNode` |
| --- | --- |
| status `'ok'` | resolve |
| status `'errors'` | reject with `NodeFailure`; its message is the message of the first `NodeError`: `await assert.rejects(renderNode(def), /No file selected/)` |
| status `'aborted'` | reject with the signal's reason |
| status `'device-lost'` | reject with `DeviceLostError` |

Every call ends by reading the targets back, releasing their handles and
calling `expectNoLeaks()` (2.8), also after a failure or an abort.

### 2.4 Rendering a graph

```ts
interface GraphSpec {
  readonly settings?: Partial<ProjectSettings>;                            // merged over TEST_SETTINGS
  readonly sources?: Readonly<Record<string, FieldData | FixtureName>>;    // literal fields, addressed as '<id>.out'
  readonly nodes: Readonly<Record<string, {
    readonly type: string;
    readonly params?: Readonly<Record<string, ParamValue>>;
    readonly inputs?: Readonly<Record<string, string>>;                    // input port -> '<node or source id>.<output port>'
    readonly bypass?: boolean;
  }>>;
}
/** Builds the document with newDoc() and the commands of runtime.md 4.6. */
declare function makeDoc(spec: GraphSpec): GraphDoc;
/** A document with one instance of every given node, for whole-registry tests (8.4). */
declare function registryDoc(defs: readonly NodeDef[]): GraphDoc;

interface GraphOptions {
  readonly res?: number;                       // default: the resolution the document's settings give for `mode`
  readonly mode?: 'preview' | 'build';         // default 'preview'
  readonly outputs?: 'all' | 'needed';         // default 'needed'
  readonly files?: FileSource;                 // default: files under tests/, or under the project file's folder
  readonly signal?: AbortSignal;
  readonly slices?: Slices;
  readonly fieldBudgetBytes?: number;
  readonly onSlice?: RenderOptions['onSlice'];
}
interface GraphRender {
  readonly fields: Readonly<Record<string, FieldData>>;   // by target, for the targets that were produced
  readonly report: EvalReport;
}

/** `graph` is a document, a spec, or the path of a project file. A target is '<node id>.<output port>', or '<node id>' to run a node. */
declare function renderGraph(graph: GraphDoc | GraphSpec | string, targets: readonly string[], opts?: GraphOptions): Promise<GraphRender>;

interface GraphSession {
  readonly doc: GraphDoc;
  evaluate(targets: readonly string[], opts?: GraphOptions): Promise<GraphRender>;
  setParam(node: string, name: string, value: ParamValue): void;
  setSettings(patch: Partial<ProjectSettings>): void;
  close(): Promise<void>;
}
declare function openGraph(graph: GraphDoc | GraphSpec | string): Promise<GraphSession>;

interface MemorySource extends FileSource {
  put(path: string, bytes: Uint8Array, mtimeMs?: number): void;            // mtimeMs defaults to a counter that grows with every put
  remove(path: string): void;
}
interface MemorySink extends FileSink {
  readonly files: ReadonlyMap<string, Uint8Array>;                         // closed files, by path
  readonly open: readonly string[];                                        // paths with an unclosed writer
}
declare function memorySource(files?: Readonly<Record<string, Uint8Array>>): MemorySource;
declare function memorySink(): MemorySink;

/** buildProject (export-unreal.md 3.1) with the process's engine as host and a new MemorySink. */
declare function buildGraph(graph: GraphDoc | GraphSpec | string, opts?: {
  readonly resolution?: number;
  readonly files?: FileSource;
  readonly signal?: AbortSignal;
}): Promise<{ readonly result: BuildResult; readonly sink: MemorySink; readonly events: readonly BuildEvent[] }>;
```

- Node and source ids in a `GraphSpec` match `/^[a-z][a-z0-9]*$/`. The commands generate the document's own node ids; the harness remembers which belongs to which spec id, and targets, `setParam` and reports use the spec's ids. For a project file they use the ids in the file.
- A maskable node's mask is connected like any input, under the name `mask`.
- `registryDoc` creates, for every given node that has outputs, one instance at default parameters, with every input connected by the wiring rule below, the optional mask inputs included. A chain of `ref/combine` nodes then takes `outputs[0]` of every instance, nodes with a `file` parameter last, and `ui.view` shows the end of the chain: evaluating the view evaluates every node. The instance of `ref/fbm` is the first terrain. A wiring type the registry lacks is left out: its inputs take the terrain itself, and without `ref/combine` the document has no chain and no view, so a test names every node as a target.
- **The wiring rule.** `registryDoc`, `orogen render <type>` and `orogen gallery` (8.6) connect the inputs of a node by port, in declaration order. It is one function, `inputFeeds` of `src/cli/document.ts`:

  | Input | Fed from |
  | --- | --- |
  | type `field` of role `height` or `data`, and type `any`: the k-th of these, counted together from 0 | terrain k. Terrain 0 is `ref/fbm` at its defaults; terrain k ≥ 1 is `ref/fbm` with `seed` k and `size` 0.1, 0.5, 0.05, 0.25, … in turn. A node with two inputs is never shown one field twice |
  | type `field` of role `mask`, required: the primary input of `select/distance` and `select/edge` among them | the mask: `ref/slope-mask` with `slopeMin` 35 and `slopeMax` 50 of a `ref/fbm` with `octaves` 3, which is the broad shape of terrain 0. It selects about half the terrain, in regions; the slopes of all eight octaves are speckle at the scale of a texel, and a mask of speckle shows nothing |
  | type `field` of role `mask`, optional and not the node's first input, and the `mask` the evaluator adds to a `maskable` node | unconnected in the **plain variant**; the mask in the **masked variant**. A node has a masked variant when it has such an input. An optional mask that is `inputs[0]` is the node's subject, not a modifier, and is connected in both |
  | type `color`: the k-th of these | `ref/colorize` of terrain k |

  The plain variant shows the node's full effect and the masked one the mask acting. `registryDoc` builds the masked variant of every node.
- Every harness evaluation passes `thumbnails: false`.
- `renderGraph` is one evaluation on an emptied cache (`Engine.trim()` first). It resolves when the evaluation ends, whatever its status: a failed or skipped target is absent from `fields` and described in `report`. It rejects only for a malformed call.
- `openGraph` keeps the cache between `evaluate()` calls, for tests of cache hits and of what an edit re-evaluates. `close()` calls `Engine.trim()` and `expectNoLeaks()`.
- The default of `outputs` is `'needed'` in both modes, so that a test of `ctx.wants()` says what it means. A test of the application's behaviour passes `'all'`.
- A relative `file` parameter resolves against the folder of the project file, or against `tests/` when the graph is a spec or a document object. In `renderNode` and `conformance` it resolves against `tests/`.
- `MemorySource` and `MemorySink` implement the interfaces of `runtime.md` section 6 completely, including the path rules, `.partial` semantics, one writer per path and `abortAll`. `stat` reports the size and the `mtimeMs` given to `put`.

### 2.5 Statistics and comparisons

```ts
interface Stats {
  readonly count: number;        // finite values
  readonly nonFinite: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly std: number;          // population standard deviation
  readonly p01: number;
  readonly p50: number;
  readonly p99: number;
}
/** Over the finite values of one channel (default 0), in float64. */
declare function stats(f: FieldData, channel?: number): Stats;

type Bound = number | readonly [lo: number, hi: number];      // a number n means [n − 1e-5, n + 1e-5]
type StatName = 'min' | 'max' | 'mean' | 'std' | 'p01' | 'p50' | 'p99';
declare function expectStats(f: FieldData, expected: Partial<Record<StatName, Bound>>, channel?: number): void;
declare function expectFinite(f: FieldData): void;            // no NaN, no infinity, in any channel
declare function expectMask(f: FieldData): void;              // finite, and every value v has 0 <= v <= 1 exactly

interface Diff {
  readonly max: number;          // largest absolute difference
  readonly rms: number;
  readonly differing: number;    // values that are not bit-identical
  readonly worst: { readonly x: number; readonly y: number; readonly channel: number; readonly a: number; readonly b: number };
}
declare function diff(a: FieldData, b: FieldData): Diff;                                    // same kind and size, else throws
declare function expectClose(a: FieldData, b: FieldData, tol: { max?: number; rms?: number }): Diff;
declare function expectIdentical(a: FieldData, b: FieldData): void;                         // bit-identical
```

- Every `expect*` function throws an `AssertionError` that names the statistic or position, the value found and the bound: `mean 0.8213 is outside [0.25, 0.75]`, `max difference 3.1e-3 at (17, 204): 0.4412 vs 0.4443; allowed 1e-6`.
- `expectStats` always asserts `nonFinite === 0` as well.
- `expectClose` requires at least one of `max` and `rms`.
- For a colour field `diff` covers all four channels; `stats` covers the one channel asked for.

### 2.6 Comparing resolutions on the ladder

```ts
/** Keeps every 2^levels-th row and column. Throws unless (width − 1) is divisible by 2^levels. */
declare function decimate(f: FieldData, levels?: number): FieldData;     // levels defaults to 1

interface LadderDiff {
  readonly max: number;
  readonly rms: number;
  readonly std: number;          // standard deviation of `coarse` (RGB channels together for a colour)
  readonly rel: number;          // rms / max(std, 1e-12)
}
/** Decimates `fine` to the size of `coarse` and compares. Throws unless (fine.width − 1) / (coarse.width − 1) is a power of two. */
declare function compareLadder(coarse: FieldData, fine: FieldData): LadderDiff;
declare function expectLadder(coarse: FieldData, fine: FieldData, tol: { max?: number; rms?: number; rel?: number }): LadderDiff;

/** Renders the node at each resolution with the same options; fixture inputs are taken at each resolution. */
declare function renderLadder(
  def: NodeDef,
  opts?: RenderOptions & { readonly resolutions?: readonly number[] },   // default [257, 513]
): Promise<Readonly<Record<number, Readonly<Record<string, FieldData>>>>>;
```

`renderLadder` rejects an `inputs` entry that is a `FieldData`: an input for a
ladder comparison must exist at every resolution, so it is a fixture name other
than `fbm` and `impulse`.

### 2.7 Preview images

```ts
type PreviewStyle = 'grey' | 'hillshade' | '3d' | 'color' | 'sheet';

interface PreviewOptions {
  readonly style?: PreviewStyle;                              // default: 'sheet' for a field, 'color' for a colour
  readonly range?: readonly [number, number] | 'auto';        // 'grey': the values drawn black and white. Default [0, 1]; 'auto' is [min, max]
  readonly height?: FieldData;                                // the terrain to shade when `f` is a mask or a colour, which is drawn over it
  readonly terrainSize?: number;                              // metres; default 4096
  readonly heightRange?: number;                              // metres; default 1024
  readonly crop?: readonly [x: number, y: number, size: number];
}

/** Writes <OROGEN_TEST_OUTPUT>/<name>.png and returns its absolute path. `name` matches /^[a-z0-9][a-z0-9/_.-]*$/. */
declare function writePreview(name: string, f: FieldData, opts?: PreviewOptions): Promise<string>;
```

All styles are computed on the CPU from the data, by `src/cli/preview.ts`, which
the `render` and `gallery` subcommands use too (8.6). A picture therefore
depends on the data only, never on the adapter, and looks the same from a test
and from the command line. Files are written with the 8-bit PNG encoder of
`export-unreal.md`.

| Style | Image | Content |
| --- | --- | --- |
| `grey` | field size, RGB 8-bit | `range` mapped linearly to black..white. Below the range: blue. Above: red. Non-finite: magenta |
| `hillshade` | field size | Wrapped Lambert shading of the physical surface: gradients from central differences with `terrainSize` and `heightRange`, light direction (towards the light) `normalize(−1, −1, √2)`, intensity `0.10 + 0.80·((1 + n·L) / 2)²`: 0.68 on level ground, within 0.10..0.90 everywhere. The term is wrapped because `max(n·L, 0)` is 0 on every slope above 45° that faces away from the light, and a terrain of physical steepness is then drawn in two tones (`ref/fbm` at 513 has a mean slope of 44° with the test settings). With `height`, the shaded terrain is tinted by `f` |
| `3d` | 768 × 512 | orthographic view of the surface in true proportions, from 30° above the horizon, looking towards −Y and turned 25° about Z, so that row 0 is at the back. +X runs to the right: the view is never a mirror image of `grey` (`engine.md` 1.8). Same light; the terrain's sides are drawn down to height 0; background `#1a1a1a` |
| `color` | field size | linear RGB encoded as sRGB, clamped; alpha ignored |
| `sheet` | 1808 × 512 | `grey` and `hillshade` scaled to 512 × 512 (nearest neighbour) and `3d`, side by side |

- Pixel `(x, y)` of `grey`, `hillshade` and `color` is texel `(x, y)`. Nothing is flipped: row 0 is the top row.
- `crop` selects a square window of texels before drawing, for one-to-one views of large fields.
- The PNG bytes are not part of the contract and are never compared. A person looks at them.

### 2.8 Leaked textures

```ts
/** Throws unless Engine.memory() reports workingBytes === 0 and pinnedBytes === 0. The message carries the MemoryReport. */
declare function expectNoLeaks(): Promise<void>;
```

After an evaluation has settled and every `FieldHandle` of its result is
released, nothing is WORKING and nothing is pinned (`runtime.md` 2.2, 5.5).
`renderNode`, `traceNode`, `renderGraph`, `buildGraph` and
`GraphSession.close()` call `expectNoLeaks()` themselves. After a build
evaluation, and after `close()`, they also require `cacheBytes === 0`:
`renderNode` and `traceNode` first empty a cache that no open `GraphSession`
holds, which is what a preview `renderGraph` leaves. While a `GraphSession` is
open its entries are the cache, and a build evaluation is required to leave
`cacheBytes` no larger than it found it. A test calls `expectNoLeaks()`
directly only when it drives the `Engine` itself.

### 2.9 Driving the application

```ts
interface AppDriver {
  /** Evaluates an expression in the main window; the result is structured-cloned. */
  eval<T>(js: string): Promise<T>;
  /** Resolves when the expression is truthy. Polled from the main process every 50 ms. Default timeout 30 000 ms. */
  waitFor(js: string, timeoutMs?: number): Promise<void>;
  /** capturePage() of the main window to <OROGEN_TEST_OUTPUT>/ui/<name>.png; returns the path. */
  capture(name: string): Promise<string>;
  /** win.showInactive(): needed before anything that waits for page animation frames. */
  show(): Promise<void>;
  /** Console errors and uncaught exceptions since launch, from every process and worker of the application. */
  errors(): Promise<readonly string[]>;
  /** Quits the application. Rejects when errors() is not empty. */
  close(): Promise<void>;
}

declare function launchApp(opts?: {
  readonly open?: string;                        // a project file to open
  readonly profile?: GpuProfile;                 // default: OROGEN_GPU_PROFILE, else 'core'
  readonly gpu?: 'hardware' | 'software';        // default: OROGEN_ELECTRON_GPU, else 'hardware'
}): Promise<AppDriver>;
```

`launchApp` starts the built application (`npm run build`, 8.2) with
`electron .` from the repository root, in test mode. Test mode is what this
document requires of the application; `src/platform/electron/main/` implements
it (`runtime.md` 8.2):

| The launcher sets | The application then |
| --- | --- |
| `OROGEN_TEST=1` | creates its window with `show: false`, opens no dialog, keeps its preferences in a temporary folder, and assigns `window.orogenTest = { ctx }` in the main window, where `ctx` is the `CommandContext` of `runtime.md` 8.8 |
| a project file as the first argument (`open`) | opens that project |
| `OROGEN_TEST_DRIVER=<absolute path>` | `require`s that module in the main process once the main window has loaded and calls its default export with `{ app, win }`. The module is `tests/electron/driver.cjs`; it carries the `AppDriver` calls |
| `OROGEN_GPU_PROFILE` | creates its device with that profile (`runtime.md` 1.1) |
| `OROGEN_ELECTRON_GPU=software` | starts on the software adapter (9.3): on Linux it does not append the switch `enable-features=Vulkan` (`runtime.md` 1.6) |

Through `orogenTest.ctx` a test reaches everything a command can: the three
stores, the engine client, the registry and `run(commandId)`.

```ts
await app.eval(`orogenTest.ctx.run('graph.toggleBypass')`);
await app.waitFor(`orogenTest.ctx.engineState.getState().evaluation === null`);
const doc = await app.eval<GraphDoc>(`orogenTest.ctx.doc.getState().doc`);
```

---

## 3. The conformance suite

`conformance(def)` registers one `node:test` suite that checks a node against
the rules of `engine.md`. The node's test file calls it once, at module scope.
The author writes no code for it.

```ts
type SkippableCheck = 'generator-range' | 'resolution' | 'seed' | 'alpha' | 'budget';

interface ConformanceOptions {
  /** Merged over the node's defaults in every check. For a node whose defaults cannot run: an import node's file. */
  readonly params?: Readonly<Record<string, ParamValue>>;
  /** Replaces the default fixture of an input. A FixtureName other than 'fbm' and 'impulse'. */
  readonly inputs?: Readonly<Record<string, FixtureName>>;
  readonly settings?: Partial<ProjectSettings>;
  /** Replaces the default tolerance of the `resolution` check. 0 < value <= 0.5. */
  readonly resolutionTol?: { readonly value: number; readonly reason: string };
  /** Checks not run, each with the reason. */
  readonly skip?: Partial<Record<SkippableCheck, string>>;
}

declare function conformance(def: NodeDef, opts?: ConformanceOptions): void;
```

### 3.1 Setup

| Item | Value |
| --- | --- |
| Device | the process's engine: the profile and adapter of 2.1 |
| Evaluation | `traceNode` (2.3): a build evaluation, `slices: 'auto'` unless the check says otherwise |
| Settings | `TEST_SETTINGS`, then `opts.settings` |
| Parameters | the node's defaults, then `opts.params`. Called "defaults" below |
| Reference run R257 | resolution 257, defaults, every input connected, every output wanted |
| Reference run R129 | the same at resolution 129 |

Default fixture of an input port:

| Port | Fixture |
| --- | --- |
| type `field`, role `height` or `data`, and type `any` in the field variant | counted together in declaration order: `terrain` for the first such input, then `cone`, `rampX`, `basin`, repeating. Two inputs of one node are never the same field: a blend of a field with itself, or a guide that is the input, checks nothing |
| type `field`, role `mask` | `mask` |
| type `color`, and type `any` in the colour variant | `color` |

A node with an input of type `any` is checked in two variants: every `any`
input given a field, and every `any` input given a colour. The checks marked
"both variants" run in each; the others run in the field variant.

The mask that the evaluator adds to a maskable node is not connected by the
suite: the node cannot influence that blend. It is tested once, in
`tests/engine/` and in acceptance graph 02.

An export node (a node with the `export` hook) has no outputs and is never
evaluated. For it the suite runs `meta` only, and `meta` also requires
`checkExportNode(def)` to return no violation (`export-unreal.md` 2.3).

**The rule behind the suite.** At every legal value of every parameter, with any
finite input, a node evaluates successfully. The only errors a node raises are
the ones its description documents (no file selected, unreadable file).

### 3.2 Checks

Each check is one test case named `<type> / <check>`. "Passes the basic
assertions" means: the evaluation ends with status `'ok'`, every output is
finite, and every output of role `mask` passes `expectMask`.

| Check | Applies to | What runs | Assertion and tolerance |
| --- | --- | --- | --- |
| `meta` | every node | no GPU | the lint rules of section 4 that concern one node hold for this node |
| `finite` | every node; both variants | R257 | passes the basic assertions. Non-finite count is exactly 0. Also writes a `sheet` (or `color`) preview of every output to `nodes/<category>/<name>/<output>.png`, and to `<output>-color.png` in the colour variant |
| `mask-range` | nodes with an output of role `mask`; both variants | R257 | every value `v` of every mask output has `0 ≤ v ≤ 1`. No tolerance. Every other run of the suite asserts the same as part of the basic assertions |
| `alpha` | nodes with a `color` output; both variants | R257 | alpha is exactly 1 on every texel of every colour output |
| `generator-range` | generators (below) | resolution 257, node seeds 0, 1 and 2 (one run when the node has no `seed`), every input connected | for each seed, `outputs[0]` has `min ≥ −0.05`, `max ≤ 1.05`, `max − min ≥ 0.5` and `0.25 ≤ mean ≤ 0.75` (`engine.md` 1.7). No further tolerance |
| `deterministic` | every node; both variants | `Engine.trim()`, then R257, then R257 again without trimming | every output of the second run is bit-identical to the first. The first run receives new, zero-filled textures and the second recycled ones holding −1e30, so the check also fails a kernel that reads a texel it never wrote |
| `deterministic-large` | nodes that list a kernel with `unsafeReadWrite`; hardware adapters only | resolution 2049, twice | bit-identical. On a software adapter the case is reported as skipped |
| `resolution` | every node except `resolutionDependent` ones; both variants | resolution 513, defaults, compared with R257 through `compareLadder` | generators: `max ≤ 1e-6` on every output. Other nodes: `rms ≤ max(tol × std, 1e-6)` on every output, `tol = 0.01` unless `resolutionTol` is declared |
| `params` | every node | resolution 129; one run per value listed in 3.3 | each run passes the basic assertions |
| `optional-unbound` | nodes with optional inputs | resolution 129, every optional input unconnected | passes the basic assertions |
| `short-ladder` | every node; both variants | resolution 33, where `ctx.ladder` is `[33]`; defaults | passes the basic assertions. Thumbnails and drafts are evaluated at resolutions without a coarser level (`engine.md` 4.7), which no other test resolution is |
| `mask-neutral` | nodes that declare an input named `mask` | resolution 129, twice: `mask` unconnected, and `mask` given `one`; other inputs as in R129 | the two results agree with `max ≤ 1e-6` on every output |
| `seed` | nodes with a `seed` parameter | R129 with the node seed raised by 1 | at least one output differs from R129 in more than 1 % of its values |
| `wants` | nodes with two or more outputs | resolution 129, once per output, wanting that output alone | the output is bit-identical to the same output of R129 |
| `slicing` | every node; both variants | R129 with `slices: 'small'`, and with `slices: 'one'` | both bit-identical to R129 |
| `abort` | every node | R129 with `slices: 'small'`, aborted from `onSlice` at the first slice that completes while the node runs; then R129 again | the first run rejects with the abort reason and passes `expectNoLeaks`; the second is bit-identical to R129. Reported as skipped when the node completes without a slice |
| `budget` | every node, on a device with `caps.compactFormats` | `peakBytes` of R129 and of R257 | the node's peak memory, extrapolated to resolution 8129, is at most 3 500 000 000 bytes (3.5) |
| `leaks` | every node | after every run above | `expectNoLeaks()` passes, also after the aborted run. A leak fails the check that ran |

`meta`, `finite`, `mask-range`, `deterministic`, `deterministic-large`,
`params`, `optional-unbound`, `short-ladder`, `mask-neutral`, `wants`,
`slicing`, `abort` and `leaks` cannot be skipped. A node that cannot pass one of them is wrong.

**Generators.** For the suite a node is a generator when all three hold: it has
no required input, its `outputs[0]` is a `field` of role `height`, and it has
no `file` parameter (`engine.md` 1.7). The generator checks are `generator-range`
and the exact form of `resolution`, which takes no `resolutionTol`.

- A node without required inputs that is no generator gets the `resolution` check of every other node, tolerance included: a mask or a colour made from nothing (`generate/shape`, `color/constant`) has no height range to keep, and a node with a `file` parameter (`io/import-field`, `ref/image`) returns what the file holds, resampled.
- An optional input does not change what a node is. The checks run with every input connected (3.1), so a generator that stamps into a terrain (`generate/crater`) is held to the range and to exact agreement on the `terrain` fixture it is given; it reads that input at its own texel only.
- A generator that cannot meet one of the two checks opts out with `skip` and a reason (3.6), as any node does.

To keep engine switches to two per file (2.1), the suite runs every `'auto'`
evaluation first, then the `'small'` ones, then the `'one'` run.

Why each exists, where that is not obvious:

- `deterministic`: besides scheduling, the classic cause of a different second run is a recycled texture. A new GPU texture is zero-filled, a recycled one is not, so a kernel that reads a texel it never wrote passes on a fresh device and fails in the application.
- `deterministic-large`: a data race in a `read_write` texture is invisible at small sizes. The same racy kernel is bit-identical to its reference at 256², differs from it on 13 % of texels at 1024² and on 99.97 % at 2048². In-place targets cannot race by construction (`engine.md` 3.5); only `unsafeReadWrite` code can.
- `slicing`: long dispatches are split into tiles and loops into batches by measured time, so the split points differ from run to run and from machine to machine. A result that depends on them is not reproducible. `'small'` forces the finest split there is and `'one'` none at all.
- `abort`: a node that catches the cancellation, or keeps state outside the context, shows up as a leak or as a different result afterwards.
- `wants`: the cache holds the outputs that were asked for, and the node runs again when another is asked for later (`engine.md` 4.10).
- `resolution`: it is the only automatic evidence that a preview shows what the build will produce.
- `short-ladder`: `ctx.ladder[1]` is `undefined` at 128, 64 and 33, and the thumbnails of an 8129 project are evaluated at 128. A node that takes a coarser level without `?? ctx.res` passes every other check and fails in the application.

### 3.3 Parameter values of the `params` check

All other parameters stay at their defaults in each run.

| Parameter kind | Values tried |
| --- | --- |
| `float`, `int` | `min`, `max` |
| `float` with `soft: true` | also `min − (max − min)`, `max + (max − min)` and 0: any finite value can be typed, and the node clamps what it cannot handle. 0 is tried because a node that divides by a soft length fails there and nowhere else |
| `vec2` | `[min, min]`, `[max, max]`; with `soft`, also both beyond values |
| `bool` | the value that is not the default |
| `enum` | every option that is not the default |
| `color` | `[0, 0, 0]`, `[1, 1, 1]` |
| `curve` | flat `[(0, 0.5), (1, 0.5)]` and inverted `[(0, 1), (1, 0)]` |
| `gradient` | two stops at the same position: `[(0.5, black), (0.5, white)]` |
| `seed`, `file`, `text` | not varied |

Two more runs set every `float`, `int` and `vec2` parameter to its `min`
together, and to its `max` together.

### 3.4 Tolerances

| Comparison | Tolerance | Basis |
| --- | --- | --- |
| The same evaluation twice on one device | bit-identical | `engine.md` 3.14 |
| Small slices against one slice, a fresh pool against a used one, an output wanted alone against wanted with the others | bit-identical | `engine.md` 3.14 rules 2 and 3, 1.4, 4.10 |
| A generator at two ladder levels, at shared vertices | `max ≤ 1e-6` | a generator positioned by `uv` measures exactly 0 across 257, 513, 1025 and 2049; one positioned by `px` measures rms 1.6e-1 |
| Any other node at two ladder levels | `rms ≤ 0.01 × std` of the coarser output | between nested levels a blur whose radius is a length measures rms 4e-5, and one whose radius is a number of texels 3.7e-3 to 1.0e-2 |
| Own mask unconnected against a mask of ones | `max ≤ 1e-6` | |
| Mask outputs | `0 ≤ v ≤ 1` exactly | `engine.md` 1.7 |
| A CPU task against a GPU kernel written to perform the same float32 operations in the same order | each pair of values is equal or adjacent float32 numbers. Bit-identity is reported, not required | WGSL permits a compiler to fuse and reorder float operations (`engine.md` 3.14 rule 5); whether an adapter does is to validate per adapter (`simulation.md` 6.1) |
| Values computed on two adapters, two backends or two profiles | never bit-compared; absolute tolerance at least `1e-5` | the same kernels on NVIDIA Vulkan and on lavapipe differ by up to 4.6e-6, and only 1 to 13 % of texels are bit-identical |
| A statistic in an expectation file (10.3) | a range at least `2e-4` wide | covers the adapter differences above with margin |
| A value stored in a `color` field against a float32 computation | absolute `2e-3` | `rgba16float` keeps 11 significant bits |

No test stores or compares a hash, a raw field or an image.

### 3.5 The `budget` check

The complete state of one simulation at resolution 8129 fits in 3.5 GB
(`engine.md` 1.2). The suite holds every node to that figure and estimates it
without running at 8129, from the `peakBytes` the evaluator reports for the
node (`runtime.md` 5.10: the most pool memory the node held as its own,
outputs included, inputs excluded):

```
b129, b257   = peakBytes of the node in R129 and in R257
estimate     = b129 + (b257 − b129) × (8129² − 129²) / (257² − 129²)
assertion    = estimate ≤ 3 500 000 000
```

- The two-point fit separates memory that grows with the resolution from memory that does not (fixed-size tables).
- The check asserts only on a device with `caps.compactFormats`, because the build machine has the compact formats and a device without them counts `half`, `half2` and `mask8` at up to four times their size. Elsewhere the estimate is printed and the case is reported as skipped. The run under `max` on a hardware adapter is therefore the one that counts (5.3 step 4).
- The estimate is printed with the result: `budget: 1.32 GB at 8129`.
- A node that fails it frees temporaries earlier (`ctx.release`), ping-pongs instead of cloning, or uses compact kinds for state that tolerates them (`engine.md` 1.2 rule 4).

### 3.6 Opt-outs

An opt-out is declared in the node's test file, in the call, with its reason:

```ts
conformance(def, {
  resolutionTol: { value: 0.05, reason: 'Measures slope; finer levels resolve steeper faces of the same terrain.' },
  skip: { 'generator-range': 'Outputs a constant height by design; its span is 0.' },
});
```

| Opt-out | Effect | Legitimate when |
| --- | --- | --- |
| `resolutionTol` | replaces 0.01 in the `resolution` check | the node measures the terrain (slope, curvature, flow, erosion): finer detail legitimately changes the result. A physical slope measured on a band-limited input (shortest wavelength 8 cells of the coarser level) differs by 4 % of its standard deviation between 257 and 513 |
| `skip['generator-range']` | the check is not run | a generator (3.2) whose purpose is not a 0..1 terrain: a constant, a single shape with a small span |
| `skip['resolution']` | the check is not run | never for a node that could instead declare `resolutionDependent` or a tolerance; only where the comparison itself is meaningless and the reason says why |
| `skip['seed']` | the check is not run | the seed affects the result only at non-default parameters; the node's own tests then cover it |
| `skip['alpha']` | the check is not run | the node writes alpha on purpose, and its description says what the alpha means |
| `skip['budget']` | the check is not run | the two-point estimate does not describe the node, because what it allocates changes with the number of ladder levels. The reason states the peak memory `verify` measured at build scale (5.3) |

Rules:

1. A reason is one or two sentences of at least 20 characters that a reviewer can check. `conformance` throws at registration for a missing or shorter reason and for `resolutionTol.value` outside `(0, 0.5]`. Two unrelated fields compare at about 1.4, so a tolerance above 0.5 checks nothing.
2. A skipped check appears in the test output as skipped, with its reason. The suite also writes `conformance/<category>/<name>.json` under the output folder: the adapter and profile, the result of every check, every opt-out with its reason, the budget estimate, and the `params` of the conformance call. The gallery shows it (8.6), and the reviewer of the node approves each opt-out.
3. `resolutionDependent: true` (`engine.md` 4.6) is not an opt-out of this document: it is part of the node's definition and is shown to the user. The gallery marks every node that sets it, and the reviewer checks that depending on whole-field statistics is the node's purpose; the flag is never set to avoid the `resolution` check.
4. There is no other way to exclude a node or a check. `test.skip`, `test.todo` and `--test-skip-pattern` are not used in `tests/nodes/`, except for the blocked-test marker of 7.4.

---

## 4. Registry lint

The lint is `tests/unit/registry.test.ts` and `tests/unit/boundaries.test.ts`.
It needs no GPU. It imports each category index separately, so a category that
fails to load fails its own cases only. `defineKernel`, `defineLib`,
`defineCpuTask` and `defineNode` already reject what `engine.md` 3.13 and 4.6
list; the lint adds the rules below. Every failure message starts with the rule
id and the node type or file.

**Files and registration**

| Id | Rule |
| --- | --- |
| `file-name` | Every file `src/core/nodes/<category>/<name>.ts` whose name is not `index.ts` and does not begin with `_` default-exports a `NodeDef` of type `<category>/<name>`, and contains exactly one `defineNode(` call |
| `index` | `src/core/nodes/<category>/index.ts` exports `nodes` holding exactly the default exports of those files, sorted by type. In `generate` and `simulate`, which two owners share (`nodes.md` sections 1 and 4), each owner lists its nodes in its private index module and `index.ts` concatenates the two and sorts; the rule holds for the list `index.ts` exports |
| `test-file` | For every node there is `tests/nodes/<category>/<name>.test.ts`; it imports the node's file and contains a call `conformance(` at module scope |
| `test-location` | Every `*.test.ts` file under `tests/` is matched by exactly one layer pattern of 8.1. `node --test` reports no error for a pattern that matches nothing, so a misplaced file would otherwise never run |
| `title-unique` | No two nodes have the same `title` |
| `kernel-name` | The name of every kernel and every CPU task a node lists begins with the node's category and a slash, except those exported by `api.ts`. One used by a single node carries that node's name (`filter/blur.pass`); one shared by several nodes of the category carries the name of the private module that defines it (`simulate/talus.step` in `_talus.ts`) |
| `lib-name` | The name of a library defined in a category folder begins with the category id (`filterKernel`). No category library is named `hash`, `noise` or like any library in `src/core/wgsl/` |

**Imports** (found by scanning import specifiers)

| Id | Rule |
| --- | --- |
| `import-node` | A file in `src/core/nodes/<category>/` imports only `../../api.ts` and files of its own folder. No bare specifier, no `node:` module |
| `import-src` | The import rules of `runtime.md` 8.4 hold for every folder of `src/`, and those of 8.7 rule 2 for every panel. `src/core/` imports no package except those on the allow-list the integrator keeps in `tests/unit/boundaries.test.ts`; `electron`, `react` and `webgpu` are never on it |
| `import-tests` | Nothing in `src/` imports from `tests/`. A file in `tests/nodes/<category>/` imports only `node:test`, `node:assert/strict`, `tests/helpers/index.ts`, `src/core/api.ts`, its own folder, and `src/core/nodes/<category>/` |
| `import-ext` | Every relative import has an explicit `.ts` or `.tsx` extension |

**Node source** (found by scanning the text of node files and private modules)

| Id | Rule | Reason |
| --- | --- | --- |
| `no-clock` | No `Math.random`, `Date.now`, `new Date` or `performance.now` | `engine.md` 3.14 rule 3 |
| `no-catch` | No `catch` clause and no `.catch(` | a node lets cancellation, budget and device errors propagate (`engine.md` 4.7). An error that needs a friendlier message is raised by a check before the call, or inside the CPU task |
| `no-float-hash` | No `fract(sin(` in WGSL | `engine.md` 3.14 rule 4 |
| `generator-frame` | The kernels of a node without required inputs do not mention `frame.res` or `frame.cellSize` | `engine.md` 1.9 rule 1 |
| `stats-flag` | A node file that mentions `.stats(` or `minMax(` declares `resolutionDependent: true` | `engine.md` 1.7 |

**Text** (conventions of section 6)

| Id | Rule |
| --- | --- |
| `title` | At most 24 characters; Title Case: every word begins with a capital letter or a digit, except, inside a title, the small words `a`, `an`, `and`, `as`, `at`, `by`, `for`, `in`, `of`, `on`, `or`, `the`, `to` and the signs `/` and `&` (`Bias and Gain`, `Hue / Saturation`); no trailing punctuation. Titles of `ref` nodes end in ` (Reference)`, which is not counted |
| `description` | At most 140 characters; one sentence; begins with a capitalised verb in the third person (`Generates`, `Blurs`, `Selects`); ends with a full stop; no line break |
| `help` | Every parameter: at most 200 characters; begins with a capital; ends with a full stop; differs from the label |
| `label` | Parameter, option and port labels: at most 24 characters; begin with a capital or a digit; no trailing punctuation |
| `keywords` | At most 12; each matches `/^[a-z0-9][a-z0-9 -]*$/`; no duplicates |
| `enum-value` | Every enum option value matches `/^[a-z0-9][A-Za-z0-9-]*$/` |

**Parameters and ports**

| Id | Rule |
| --- | --- |
| `param-words` | No parameter name contains, as a camel-case word, `px`, `pixel`, `pixels`, `texel`, `texels`, `iterations`, `iters`, `steps` or `passes` (`engine.md` 1.6 rule 1) |
| `param-canonical` | A `float`, `int` or `vec2` parameter named `size`, `radius`, `strength`, `height`, `angle`, `octaves` or `gain`, or whose name ends in `Size`, `Radius`, `Strength` or `Angle`, has the kind and unit of that concept in `engine.md` 4.4 |
| `unit-range` | `ratio`: `0 ≤ min` and `max ≤ 1`, never `soft`. `angle`: `0 ≤ min` and `max ≤ 360`. `length`: `0 ≤ min` and `max ≤ 4` for a `float`, `−4 ≤ min` and `max ≤ 4` for a `vec2`. `height`: `−1 ≤ min` and `max ≤ 1` |
| `log-scale` | A `float` with `min > 0` and `max / min ≥ 100` declares `scale: 'log'` |
| `role-select` | `outputs[0]` of a `select` node has role `mask` or `data` |
| `role-generate` | `outputs[0]` of a `generate` node is a `field` of role `height` or `mask` |
| `has-output` | Every node has at least one output, unless it is an export node |

---

## 5. A node's tests and the definition of done

### 5.1 Files of a node

| File | Content |
| --- | --- |
| `src/core/nodes/<category>/<name>.ts` | the node; the patterns are the reference nodes (10.1) |
| `src/core/nodes/<category>/index.ts` | one import and one array entry added, in alphabetical order. In `generate` and `simulate` the import and the entry go into the owner's private index module (`_basics.ts`, `_landforms.ts`, `_erosion.ts`, `_hydrology.ts`; `nodes.md` sections 1 and 4), and `index.ts` is not edited |
| `tests/nodes/<category>/<name>.test.ts` | the test file below |
| `tests/nodes/<category>/unit/<name>.test.ts` | optional: GPU-free tests of the node's CPU task functions |

### 5.2 Required test file

```ts
// tests/nodes/filter/blur.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformance, renderNode, fixtures, stats, expectClose } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/blur.ts';

conformance(def);

test('filter/blur: a constant stays constant', async () => {
  const { out } = await renderNode(def, { inputs: { in: 'one' }, params: { radius: 0.05 } });
  expectClose(out, fixtures.one(257), { max: 1e-6 });
});

test('filter/blur: a larger radius removes more detail', async () => {
  const src = await fixtures.fbm(257);
  const small = await renderNode(def, { inputs: { in: src }, params: { radius: 0.005 } });
  const large = await renderNode(def, { inputs: { in: src }, params: { radius: 0.05 } });
  assert.ok(stats(large.out).std < stats(small.out).std);
  assert.ok(stats(small.out).std < stats(src).std);
});
```

Required content:

1. `conformance(def)` at module scope, with opt-outs if any (3.6).
2. At least one behaviour test: an assertion about what the node is for, which would fail if the node did nothing or did something else. "The output is finite" is not one.
3. At least one assertion for every secondary output.
4. One test for every error the node raises on purpose (`assert.rejects(renderNode(...), /message/)`).
5. For a node of `simulation.md`: the invariants of its section there. The common invariants of `simulation.md` 1.7 items 1, 2, 3 and 5 are conformance checks; item 4 and the node's own invariants are behaviour tests, on the fixtures of 2.2 or on fields made with `fieldOf`.

Rules for test code:

- Test names are `<type>: <behaviour>`.
- Resolution 257 unless the behaviour needs another. Nothing above 513 except in `deterministic-large`: software adapters run these tests on a CPU.
- Expected values come from an analytic property or from a fixture (a constant stays constant, a ramp has a known slope, a sum is conserved), never from a number copied out of a previous run of the same node.
- Numbers that the same code computed in two runs on one device may be bit-compared. Anything else uses the tolerances of 3.4, a CPU task compared with a GPU kernel included.
- No sleeping, no timing assertions, no dependence on the order of test cases.
- Every top-level `await` of a test file (an engine, a device, a fixture) comes before its first `test()` call. `node:test` otherwise runs the cases registered so far and then the `after` hooks while the module still awaits, and the hook of the harness destroys the device: the later cases compute, and every readback rejects with a bare `AbortError`.

An export node's test file contains `conformance(def)` and nothing else; what
an export node writes is tested through builds, in `tests/export/`.

### 5.3 What the author runs

```
npm run verify -- <category>/<name>
```

`verify` (`tests/tools/verify.ts`) runs, in order, and stops at the first
failure:

| Step | What it runs | Passes when |
| --- | --- | --- |
| 1 | `npm run check` | no type error |
| 2 | `npm run test:unit` | lint and unit tests pass |
| 3 | the node's test files on the default adapter, profile `core` | every case passes |
| 4 | the same, profile `max` | every case passes, `budget` included |
| 5 | the same on the machine's software adapter (`tests/env/lavapipe.env` on Linux, `tests/env/warp.env` on Windows), profile `core` | every case passes |
| 6 | `orogen render <type> --res 513`, and with `--masked` for a node that has a masked variant (2.4) | a picture of every output is written |
| 7 | `orogen render <type> --res 4033 --crop 768` | `render` exits with 0 (8.6): a one-to-one crop of every output is written, `longestSliceMs` is at most the hard ceiling of `runtime.md` 3.5 (500 ms), and the run emitted no `engine-error` event |
| 8 | `orogen render <type> --res 4033 --max-params --out <output folder>/max-params` | the same condition, with every `float`, `int` and `vec2` parameter at its `max` (the last run of 3.3). Its pictures have the file names of step 7 and go to a folder of their own, so that those at the defaults stay |

Steps 6 to 8 pass the `params` of the node's conformance call as `--param`,
read from the report of 3.6 rule 2 with a file as an absolute path: a node
whose defaults cannot run, an import node without a file, is rendered the way
the suite ran it.

It ends by printing a summary: the adapter of each step, the number of cases
and skips, every opt-out with its reason, the `budget` estimate, the paths of
the pictures, and the time, longest slice and peak memory of steps 7 and 8.

- A step whose adapter is not present on the machine is reported as `missing`. The node is not done until someone has run that step.
- Step 4 is what exercises the compact formats (`half`, `half2`, `mask8`) and asserts `budget`: the default adapter of the development machine has `texture-formats-tier1`, lavapipe does not.
- Steps 7 and 8 are the only runs at a build-scale resolution before integration. `--res 8129` replaces 4033 where the machine's memory allows.
- Steps 7 and 8 are the test of a kernel's declared `cost` (`engine.md` 3.15 rule 4). Tiling keeps a dispatch under the watchdog only when `cost` is honest. A run that does not pass the `cost` its parameters imply has its rate learned at preview sizes and small parameters, and its first build-scale tiles then take many times their estimate; the measured slice shows it. Step 8 is also the test of 6.6 rule 4.

### 5.4 Pictures

`orogen render` and `orogen gallery` are defined in 8.6. `render` draws one
node with realistic fractal input, because the band-limited `terrain` fixture
of the tests is too smooth to show texel-level defects. Each input has a
source of its own (2.4): the second terrain of a two-input node has another
seed and finer features than the first, so the picture shows what the node
does with two fields and not one field met with itself. A node with an
optional mask, its own or the one `maskable` gives it, is looked at twice:
`orogen render <type>` and `orogen render <type> --masked`.

What the author looks for:

| Seen in the picture | Usual cause |
| --- | --- |
| Magenta texels | NaN or infinity: an unguarded division, `sqrt`, `pow` or `normalize` |
| Blue or red areas in `grey` | values outside 0..1: a generator out of range, a mask not saturated |
| Horizontal bands eight rows high, or a seam every few hundred rows | the kernel depends on the tile or uses `global_invocation_id` |
| A checkerboard or two interleaved terrains | a ping-pong with the wrong parity, or a read of a field the run writes |
| Streaks along the axes or the diagonals | a neighbourhood that favours grid directions; a stencil without distance weights |
| A frame of different texture along the border | border handling: reads clamp to the edge unless the kernel tests `inGrid` |
| Terraces in a smooth slope | a height stored in a compact kind |
| The 4033 crop looks like a different terrain from the 513 sheet | a parameter applied in texels, or an iteration count that does not follow the cell size |
| A mask that is white where nothing should happen | the mask is inverted: 1 means affected |
| The node's effect is invisible at defaults | the defaults are wrong (6.6) |
| The masked picture is the plain one, or the input | the mask does not reach the algorithm, or acts the wrong way round: 1 means affected |

### 5.5 Definition of done for a node

A node is done when all of this is true:

1. `npm run verify -- <type>` exits with 0 and no step is `missing`.
2. The test file meets 5.2. No conformance check fails; every opt-out has a reason a reviewer accepts.
3. The author has looked at the 513 sheets and the 4033 crops against the table of 5.4. Steps 7 and 8 of `verify` passed: no slice above the hard ceiling at defaults or at the parameter maxima.
4. The change touches only the owner's folders (7.1).
5. The change description contains: the summary printed by `verify`, with the longest slice of steps 7 and 8; the 513 picture of every output; the 4033 crop of `outputs[0]`; for a simulation, what is still to calibrate under `simulation.md`.
6. No test is marked blocked (7.4).

### 5.6 Definition of done for application work

For a panel, the shell, the stores or the platform code (`runtime.md` 8.10):

1. `npm run check` and `npm run test:unit` pass.
2. `tests/ui/<owner>/unit/` covers the owner's logic that needs no window (8.5).
3. A panel has at least one hidden-window test in `tests/ui/<panel>/` in which the panel is mounted, every command it registers runs once, and `AppDriver.close()` reports no error; `npm run test:ui` passes on the author's machine.
4. The change touches only the owner's folders, and its description contains the captures the tests wrote.

---

## 6. Conventions

Spelling: identifiers and every text the user reads (titles, labels, help,
option labels) use American spelling, as WGSL, the TypeScript APIs and Unreal
Engine do: `color`, `normalize`, `center`. These documents are written in
British English; that is not a model for the product's text.

### 6.1 Node type ids and files

| Thing | Rule | Example |
| --- | --- | --- |
| Node type | `<category>/<name>`; `<name>` is lower-case kebab-case, at most 32 characters, a noun or noun phrase for the operation | `filter/blur`, `select/slope`, `simulate/thermal-erosion` |
| | Never the name another product uses for it; that goes into `keywords` | `generate/fractal-noise` with keyword `perlin` |
| | No version in the name; a changed algorithm raises `version` and adds `migrate` | not `simulate/erosion2` |
| | The category is not repeated | not `filter/blur-filter` |
| | Export nodes begin with `export-` (`export-unreal.md` 2.3) | `io/export-layer` |
| Node file | `<name>.ts` in the category folder; one node per file | `src/core/nodes/filter/blur.ts` |
| Private module | begins with `_` and is named for what it holds: `_wgsl.ts` (libraries), or one module per group of shared kernels, tasks and helpers | `src/core/nodes/simulate/_talus.ts`, `_route.ts` |
| Enum value | begins with a lower-case letter or a digit; a value that names a kernel variant is lower-case | `ridged`, `png16` |
| Kernel constant | camelCase, named for the pass | `const step = defineKernel({ name: 'simulate/thermal-erosion.step', ... })` |
| Test file | the node's name with `.test.ts` | `tests/nodes/filter/blur.test.ts` |
| Test data | at most 100 kB per file, in `assets/` | `tests/nodes/io/assets/ramp-16.png` |
| WGSL | a template string tagged `/* wgsl */`, in a `.ts` file | |

Released ids are permanent: a node type, a port name, a parameter name and an
enum value are stored in documents and never renamed (`engine.md` 4.2, 4.3, 4.6).

### 6.2 Titles, descriptions and help

| Text | Rule | Good | Bad |
| --- | --- | --- | --- |
| `title` | Title Case, at most 24 characters, what an artist would call it; no "Node", no category word unless it is part of the name | `Thermal Erosion` | `Thermal erosion node` |
| `description` | one sentence, at most 140 characters, third-person verb first, full stop last; says what the node does to the terrain, not how | `Collapses slopes steeper than a talus angle into scree.` | `This node implements a pairwise-gather solver` |
| `keywords` | lower case; the names other tools and textbooks use for the operation; words a user would type to find it | `['talus', 'scree', 'slump', 'thermal']` | `['Node', 'Erosion']` |
| parameter `label` | Sentence case, at most 24 characters, a noun | `Talus angle` | `Talus Angle:` |
| parameter `help` | one or two sentences, at most 200 characters, full stop last; says what a larger value does to the result | `Slopes steeper than this collapse.` | `The talus angle.` |
| | no unit, default or range (the inspector shows them); no reference to the implementation | | `Angle in degrees (default 35).` |
| enum option `label` | Sentence case | `Ridged` | `RIDGED` |
| `group` | Sentence case, one or two words | `Detail` | |
| error message | one sentence, capitalised, no full stop, no internal names | `No file selected` | `ERR: params.file == ''` |

### 6.3 Ports

`engine.md` 4.2 fixes `in`, `out`, `a`, `b` and `mask`. Further names come from
this vocabulary whenever the content matches, so that the same thing has the
same name on every node; another name is used only for content not listed.

| Name | Type and role | Content |
| --- | --- | --- |
| `height` | field, height | the terrain, on a node whose primary input `in` is something else |
| `guide` | field, data or mask | a field that steers the node without being processed |
| `flow` | field, data | water flow or flow accumulation |
| `wear` | field, data | material removed |
| `deposit` | field, data | material laid down |
| `moved` | field, data | material displaced, without sign |
| `water` | field, mask | where standing water is: a lake, the sea |
| `sediment` | field, data | simulation state offered as output |
| `depth` | field, data | depth of water, snow or sand |
| `color` | color | a colour output of a node whose `out` is a field |

The exact meaning and unit of a data output are stated in the node's
description, and for simulations in `simulation.md`.

### 6.4 Parameter names

The canonical concepts and their helpers are `engine.md` 4.4. Beyond them:

| Concept | Name | Kind |
| --- | --- | --- |
| A second parameter of a canonical concept | the concept with a prefix: `warpSize`, `edgeRadius`, `detailStrength` | from the helper, with `name` |
| The two ends of a range | `<what>Min`, `<what>Max`: `slopeMin`, `slopeMax`, `heightMin`, `heightMax` | |
| A choice of algorithm or behaviour | `mode` | `enum` |
| A count of things placed or of levels | `count`; `levels` | `int` |
| A shift in the plane | `offset` | `vec2`, unit `length` |
| A position on the terrain | `center` | `vec2`, unit `length` (a `uv`) |
| Inverting the result | `invert` | `bool` |
| Clamping the result to 0..1 | `clamp` | `bool` |
| A soft edge | `feather` | `float`, unit `length` |

Booleans are named for what `true` does, without `is` or `use`: `invert`, not
`isInverted`.

### 6.5 Structure of a node

| Question | Convention |
| --- | --- |
| Should the node be `maskable`? | Yes for every node of `adjust`, `filter`, `surface` and `color` whose `in` and `out` have the same type, unless the mask must act inside the algorithm; then the node declares its own `mask` input (`engine.md` 4.13) |
| Field or colour? | A node whose operation is the same per channel takes `any` and returns `sameAs` (`engine.md` 4.2), with one kernel variant per kind |
| One node or two? | One node per operation an artist names. An `enum` selects variants of one operation, not different operations |
| Secondary outputs | Offered whenever the node computes the quantity anyway; computed only when `ctx.wants()` |
| Order of parameters | The one that changes the picture most first; `seed` last in its group; rarely used ones in a group named `Advanced` |

### 6.6 Defaults and ranges

| Unit | Range | Default |
| --- | --- | --- |
| `length`, a feature size | the helper's 0.001..4, log, soft | a size that shows several features across the terrain |
| `length`, a radius, distance or feather | `min > 0`; `max ≤ 0.25` unless larger values mean something; log; soft | 0.002..0.02: 16 to 160 texels of an 8129 build |
| `height` | 0..1 for an amplitude or threshold, −1..1 for an offset; soft | |
| `angle`, a direction | 0..360, hard | 0 |
| `angle`, a slope | 0..90, hard | |
| `ratio` | 0..1, hard | `strength`: 1, so the node shows its full effect and the mask scales it |
| `none` | stated explicitly; log when it spans two decades | |
| `int` | a hard `max` equal to the constant bound of the kernel's loop | |

1. At defaults the node's effect is plain in the gallery picture: a reviewer can tell what the node does without reading its description.
2. A default is never at the end of its slider, except: a `strength`, or another ratio that is fully on, of 1; a direction of 0; an optional effect whose off value is 0; and a `<what>Min`, `<what>Max` pair that defaults to the whole range.
3. `min..max` is the range in which the slider is useful. Values beyond it that still make sense are reached by typing (`soft: true`); values the algorithm cannot survive are excluded by a hard limit.
4. Every hard `max` is safe at resolution 8129: the node stays within the cost rules of `engine.md` 3.15 and the `budget` check at that value. `verify` step 8 tests it at 4033 (5.3).
5. Two nodes that expose the same concept use the same default and range unless there is a reason an artist would recognise.

### 6.7 Category colours

A node's header has the colour of its category. The application's theme
provides these values as custom properties of `src/app/shell/theme.css`; no
node or panel hard-codes one.

| Category | Colour |
| --- | --- |
| `generate` | `#79461d` |
| `adjust` | `#246283` |
| `filter` | `#412b51` |
| `simulate` | `#2b652b` |
| `select` | `#3c3c83` |
| `color` | `#6e6e23` |
| `surface` | `#1d725e` |
| `io` | `#82354c` |
| `ref` | `#374725` |

They are header colours for a dark theme with text `#e6e6e6`.

---

## 7. Parallel work

### 7.1 Ownership

Every path has exactly one owner. Only the owner changes it.

| Path | Owner |
| --- | --- |
| `src/core/nodes/<category>/**` and `tests/nodes/<category>/**`, for `generate`, `adjust`, `filter`, `simulate`, `select`, `color`, `surface` | the owner of that category |
| `src/core/nodes/io/**`, `tests/nodes/io/**`, `src/export/**`, `tests/export/**`, `unreal/**`, `docs/user/**` | the export owner: import and export nodes belong together |
| `src/app/**`, `src/platform/**`, `src/viewport/**` | as `runtime.md` 8.10 assigns them: the five panel owners, shell, state, platform |
| `tests/ui/<owner>/**` | the application owner of that name: `graph`, `viewport`, `inspector`, `library`, `build`, `shell`, `state`, `platform` |
| `docs/changes/<prefix>-*.md` | whoever owns `<prefix>` (7.4) |
| everything else | the integrator; frozen (7.2) |

- Two owners never share a folder. People who share one category or panel agree among themselves; to everyone else they are one owner.
- An owner adds files only inside its own folders.
- A branch is named for its owner: `nodes/<category>/<topic>`, `export/<topic>`, `ui/<owner>/<topic>`, `core/<topic>`. `tests/tools/ownership.ts` compares the changed paths of a branch with the paths its prefix owns and fails on any other path; CI runs it on every pull request (9.1). `core/` branches are the integrator's.

### 7.2 Frozen files

These are frozen from the start of parallel work and changed only by the
integrator:

| Frozen | Why it is shared |
| --- | --- |
| `docs/contract/**` | the contract |
| `package.json`, `package-lock.json`, `tsconfig*.json`, the build and packaging configuration, `.github/**` | one dependency set and one build for everyone |
| all of `src/core/` outside the eight category folders: `api.ts`, `runtime.ts`, the kernel system, the evaluator, the pool, `ops/`, `wgsl/`, the decoders, `export-decl.ts`, `nodes/index.ts`, `nodes/ref/**` | every node depends on it |
| `src/cli/**` | the one command-line program |
| `tests/helpers/**`, `tests/tools/**`, `tests/env/**`, `tests/unit/**`, `tests/engine/**`, `tests/graphs/**`, `tests/electron/**`, `tests/nodes/ref/**` | the harness and the suites everyone must pass |

`runtime.md` 8.10 lists the files of the application that are frozen during
panel work; a change to one of them is requested from its owner in the same
way (7.4).

Consequences:

1. No owner adds a dependency. Every dependency is in `package.json` before parallel work starts.
2. `src/core/nodes/index.ts` is written once with all nine imports. Every category's `index.ts` exists from the start as `export const nodes: readonly NodeDef[] = [];`, and only its owner edits it. In `generate` and `simulate` the four private index modules of `nodes.md` sections 1 and 4 exist from the start in that form, each edited by its owner alone, and `index.ts` is written once to concatenate and sort them.
3. A node author never edits the harness to make a test pass, and never copies a harness function into a test file.
4. A defect in a frozen file is reported (7.4), not patched locally.

### 7.3 What an owner may rely on

- The API of `src/core/api.ts`, as `engine.md` states it.
- The harness API of section 2 and the checks of section 3.
- The reference nodes (10.1) as working examples of every pattern.
- Nothing else: not a file of another category, not an internal module of core, not the behaviour of another owner's node.

A node file's module scope throws on an invalid definition (`engine.md`). An
owner therefore runs `npm run test:unit` before pushing: a category that does
not load fails its own lint cases and every test that imports the whole
registry.

### 7.4 Changing a frozen file

A change to a frozen file is requested with a file, never made directly.

```
docs/changes/<prefix>-<slug>.md        prefix: the category id, `export`, or `ui-<owner>`
```

```md
# <one-line summary>

Requester: <prefix>
Files: <the frozen files concerned>
Kind: defect | addition | change
Blocking: no | yes: <what cannot be finished without it>

## Problem
What cannot be done, or what is wrong. For a defect: a failing test, or the
shortest code that shows it, with the output.

## Proposal
The exact text, signature or behaviour wanted.

## Until then
What the requester does meanwhile.
```

The integrator:

1. Applies requests in batches, blocking ones first.
2. Appends the outcome to the request: `Decision: accepted | changed | rejected`, with the commit and, when not accepted as proposed, the reason.
3. Appends one line per applied batch to `docs/changes/LOG.md`: the date, the requests, and what every owner has to do (`nothing`, or the exact edit).
4. Changes the contract document in the same commit as the code, when the change alters a rule or a signature.

While a blocking request is open, the requester marks the test that needs it
with `test('<name>', { todo: 'blocked by docs/changes/<file>' }, ...)`. This is
the only permitted use of `todo`. A node or panel with such a test is not done.

### 7.5 Shared WGSL and shared operations

Code is shared by promotion into core, never by one category importing
another.

| Step | Who | What |
| --- | --- | --- |
| 1 | the author | writes the helper as a private library (`<category><Name>`, in `_wgsl.ts`) or a private function of the category, with tests in the category's folder |
| 2 | a second category that needs the same thing | files a change request of kind `addition`, naming the existing private implementation, the proposed core name and signature, and the tests it must pass. Until it is applied, the second category keeps its own private copy under its own prefix, marked `// PROMOTE: docs/changes/<file>` |
| 3 | the integrator | moves the code into `src/core/wgsl/` (a library with a one-word name and prefix, `engine.md` 3.7) or `src/core/ops/` (a function on `OpContext`, `engine.md` section 5), adds tests under `tests/engine/`, exports it from `api.ts`, and records it in `LOG.md` |
| 4 | both categories | delete their private copies and use the core one |

Promotion criteria:

- The code is needed by at least two categories; or
- it defines something that must be identical everywhere even with one user: a blend mode, a curve shape, a signed distance, a colour conversion.

A request for a new standard-library name, a new field kind, a new parameter
kind or a new `EvalContext` method is a change to `engine.md` and is filed the
same way.

---

## 8. Test layers

### 8.1 Layers

| Layer | Files | Needs | Command |
| --- | --- | --- | --- |
| Unit | `tests/unit/**/*.test.ts`, `tests/nodes/*/unit/*.test.ts`, `tests/export/unit/*.test.ts`, `tests/ui/*/unit/*.test.ts` | nothing | `npm run test:unit` |
| GPU, profile `core` | `tests/engine/**/*.test.ts`, `tests/nodes/*/*.test.ts`, `tests/export/*.test.ts`, `tests/graphs/*.test.ts` | a WebGPU adapter | `npm run test:gpu` |
| GPU, profile `max` | the same | a hardware adapter | `npm run test:gpu:max` |
| GPU, software adapter | the same | lavapipe or WARP | `npm run test:gpu:lavapipe`, `npm run test:gpu:warp` |
| Electron kernels | `tests/electron/*.test.ts` | the built application; a display | `npm run test:electron` |
| UI | `tests/ui/*/*.test.ts` | the built application; a real display; a hardware adapter | `npm run test:ui` |
| Pictures | none | a WebGPU adapter | `orogen render`, `orogen gallery` (8.6) |

`npm test` is `test:unit` followed by `test:gpu`. `npm run check` is the type
check: `tsc -p tsconfig.core.json && tsc -p tsconfig.json`. The core
configuration has neither DOM nor Node types (`runtime.md` 8.4), so core code
that uses `Buffer`, `process` or `document` fails there even though it would
run in Node.

What each layer contains:

| Layer | Contains |
| --- | --- |
| Unit | uniform packing against the WGSL layout rules; the TypeScript hashes and `mixSeed` against fixed vectors; curves and bakers; `defineKernel`, `defineLib`, `defineNode` validation and their messages; `parseDoc`, `serializeDoc`, `normalizeParams` and migration; the document commands; the stores (`docStore` through transactions, `engineStore` as a reduction of recorded `EngineEvent`s); `planBuild`, encoders and decoders (round trips), the manifest; the registry lint and import boundaries; CPU task functions; the arguments of the command line and its usage errors, the document `render` evaluates, the gallery page |
| GPU `tests/engine/` | every rule of `engine.md` and `runtime.md` that a node cannot break by itself: generated WGSL and accessors, the standard library (vertex-centred bilinear, clamping, `slopeAt`), TypeScript and WGSL hashes agreeing on 1000 inputs, per-run uniforms within one slice, call order, binding validation, tiles, the pool (states, reuse, budget, eviction), the out-of-memory retry with `failAllocAfter`, device loss, cache hits, keys and transient entries, `wants` re-runs, the maskable blend, bypass, conversion, progressive previews, thumbnails, CPU tasks, file identity, and every shared op including the coarse-to-fine driver; in `tests/engine/session/` the session (`runtime.md` section 7) on the real engine, with a recording renderer and a build function of the tests' own: latest-wins scheduling and what stays on screen, gestures and draft levels, the view and its loans, idle thumbnails, `inspect`, builds, watched files, device recovery, the event order, both ends of the protocol over a real `MessageChannel`, and the ledger at `dispose`; every subcommand of `orogen` as a child process, with its exit code and the pictures it writes decoded again |
| GPU `tests/nodes/` | conformance and behaviour of each node |
| GPU `tests/export/` | builds: the stages, the files, cancellation, the output folder |
| GPU `tests/graphs/` | the acceptance graphs; `registry.test.ts`, which evaluates `registryDoc(nodes)`, the whole product (`runtime.md` 5.1), at 129 and requires every node to end `done`, except nodes with a `file` parameter |
| Electron kernels | 8.4 |
| UI | 8.5 |

### 8.2 Scripts and environment files

```json
{
  "bin": { "orogen": "src/cli/main.ts" },
  "scripts": {
    "build": "vite build",
    "check": "tsc -p tsconfig.core.json && tsc -p tsconfig.json",
    "test": "npm run test:unit && npm run test:gpu",
    "test:unit": "node tools/guard.mjs --timeout=600 node --test \"tests/unit/**/*.test.ts\" \"tests/nodes/*/unit/*.test.ts\" \"tests/export/unit/*.test.ts\" \"tests/ui/*/unit/*.test.ts\"",
    "test:gpu": "node tools/guard.mjs --timeout=3600 --lock node --test --test-concurrency=1 --test-timeout=300000 \"tests/engine/**/*.test.ts\" \"tests/nodes/*/*.test.ts\" \"tests/export/*.test.ts\" \"tests/graphs/*.test.ts\"",
    "test:gpu:max": "node tools/guard.mjs --timeout=3600 --lock node --env-file=tests/env/max.env --test --test-concurrency=1 --test-timeout=300000 \"tests/engine/**/*.test.ts\" \"tests/nodes/*/*.test.ts\" \"tests/export/*.test.ts\" \"tests/graphs/*.test.ts\"",
    "test:gpu:lavapipe": "node tools/guard.mjs --timeout=3600 --lock node --env-file=tests/env/lavapipe.env --test --test-concurrency=1 --test-timeout=300000 \"tests/engine/**/*.test.ts\" \"tests/nodes/*/*.test.ts\" \"tests/export/*.test.ts\" \"tests/graphs/*.test.ts\"",
    "test:gpu:warp": "node tools/guard.mjs --timeout=3600 --lock node --env-file=tests/env/warp.env --test --test-concurrency=1 --test-timeout=300000 \"tests/engine/**/*.test.ts\" \"tests/nodes/*/*.test.ts\" \"tests/export/*.test.ts\" \"tests/graphs/*.test.ts\"",
    "test:electron": "node tools/guard.mjs --timeout=3600 --lock node --test --test-concurrency=1 --test-timeout=300000 \"tests/electron/*.test.ts\"",
    "test:ui": "node tools/guard.mjs --timeout=3600 --lock node --test --test-concurrency=1 --test-timeout=300000 \"tests/ui/*/*.test.ts\"",
    "orogen": "node src/cli/main.ts",
    "verify": "node tools/guard.mjs --mem=4G --timeout=3600 --lock node tests/tools/verify.ts",
    "expect": "node tests/tools/expect.ts"
  }
}
```

| File | Content |
| --- | --- |
| `tests/env/max.env` | `OROGEN_GPU_PROFILE=max` |
| `tests/env/lavapipe.env` | `OROGEN_GPU_ADAPTER=llvmpipe` |
| `tests/env/warp.env` | `OROGEN_GPU_ADAPTER=Microsoft` |

- Every test script starts its process through `tools/guard.mjs`, which on Linux puts it in its own memory-capped systemd scope (`OROGEN_GUARD_MEM`, default `2G`; `OROGEN_GUARD_TIMEOUT` seconds, default 1800; a script sets its own defaults with leading `--mem=` and `--timeout=`, as the unit script does with 600 seconds, because `--test-timeout` cannot interrupt a test that hangs synchronously) and elsewhere applies only the time limit. A test that leaks or loops then dies alone. Without the scope the kernel's out-of-memory killer ends the whole process group that launched it, the editor or terminal session included: a 13 GB runaway in one unit test did exactly that. Anything else that runs project code from a shell, a single test file or the command-line program, is started the same way: `tools/guard node --test tests/unit/foo.test.ts`. A run that needs more memory raises the cap explicitly, for example `OROGEN_GUARD_MEM=8G tools/guard npm run orogen -- build ...`.
- The whole GPU suites and `verify` also pass `--lock`: on Linux such runs queue on one machine-wide lock, so that several people working on one machine do not exhaust the one GPU's memory or disturb each other's measured slice times. While developing, an owner runs the tests of its own folder, unlocked and small: `tools/guard node --test --test-concurrency=1 "tests/nodes/filter/*.test.ts"`. A render above 2049 from the command line takes the lock explicitly: `tools/guard --lock --mem=4G node src/cli/main.ts render ...`.
- No test hands data-sized values to `assert.deepEqual`, `deepStrictEqual`, `equal` or `strictEqual`: not a field, a pixel buffer, an encoded file or any array whose length grows with a resolution. When such an assertion fails, Node builds a textual diff of both sides; measured here, two 4000-byte arrays with half the bytes different cost 300 MB, and 16 000 bytes passed 1 GB. That is the runaway the guard exists for. Data is compared with the harness functions of 2.5 (or, below the harness, a loop that reports the first difference and a count), and `deepEqual` is kept for small structured values.
- The glob patterns are quoted so that Node expands them, identically on Linux and Windows. A folder passed to `node --test` instead of a pattern fails.
- `--env-file` sets the variables for the runner and for every test process, on every platform. A script never relies on `VAR=value command` syntax.
- One file under another configuration: `node --env-file=tests/env/max.env --test tests/nodes/filter/blur.test.ts`.
- On the development machine the adapter name `llvmpipe` selects lavapipe while the NVIDIA driver is installed beside it; no other variable is needed. Lavapipe comes from the package `mesa-vulkan-drivers`.
- `npm run expect -- <graph>` prints the statistics of an acceptance graph's targets in the format of its expectation file (10.3).
- `npm run build` builds the application into `dist/`: the main-process script, which `package.json` names in `main`, the preload script, the page, the engine worker and the CPU worker. `launchApp` (2.9), `npm run test:electron` and `npm run test:ui` start that build with `electron .` from the repository root and fail with a message that names `npm run build` when `dist/` is missing. The build configuration is the integrator's (`runtime.md` 8.10).

### 8.3 Concurrency

| Layer | Setting | Why |
| --- | --- | --- |
| Unit | Node's default (parallel files) | no device; nothing shared |
| GPU | `--test-concurrency=1`: one test file at a time; one device per file | (1) In Node, waiting for the GPU busy-polls: a process uses 108 to 119 % of one core for as long as it awaits GPU work, so parallel files compete for cores. (2) All processes share one GPU and its memory: 6 GB on the development machine. (3) A software adapter computes on all CPU cores by itself. (4) The runtime sizes slices from measured time, which other processes disturb. The price is small: eight files take 3.0 s serially against 1.4 s in parallel |
| Electron, UI | `--test-concurrency=1`; one application instance at a time | every window of every instance shares one GPU process and one display |

- Test cases inside a file run one after another: no test uses `{ concurrency: true }`.
- `--test-timeout=300000` is a backstop for a hung device, not a performance requirement. No test asserts a duration.
- Creating the device costs 141 to 177 ms per file on the development machine, and a render with readback 5 ms at 513 and 37 ms at 2049. A node's test file therefore keeps its work at 257 and below where it can.
- When the GPU layer becomes too slow for one CI job, it is split with `--test-shard=<i>/<n>` across jobs; the concurrency inside a job stays 1.

### 8.4 The kernel test in Electron

The Dawn inside the `webgpu` package is about five Chromium milestones newer
than the one inside Electron 44, and Electron's Node is older than the Node the
tests run on. WGSL that compiles in Node can fail in the application:
`buffer_view`, `swizzle_assignment` and `fragment_depth` exist in Node's Dawn
and not in Electron 44. The GPU layer cannot see this.

`tests/electron/kernels.test.ts` runs the following once per profile, through
`launchApp` and `orogenTest.ctx`:

1. It waits for `engineState.device.state === 'ready'` and asserts that `device.caps.wgslLanguageFeatures` contains the four language features `engine.md` 3.12 allows. Reaching `ready` proves that every kernel of the engine itself compiled (`createEngine` compiles them).
2. It loads `registryDoc(nodes)`, with build resolution 513 and preview level 2, through `docStore.load`, and waits until no evaluation runs and every node of the view's plan has a final state.
3. It asserts that every node is `done`, except nodes with a `file` parameter and the `ref/combine` links after them. No node may report an error of kind `shader-compile`, `binding`, `validation` or `internal`. A failure prints the `NodeError`, which for a compile error names the kernel and carries the diagnostic and source lines.
4. It asserts that the node types the application's registry lists are those the Node process running the test sees. A node missing from the application bundle fails the test.
5. In a second launch that opens `tests/graphs/05-roundtrip.orogen`, it builds the project into a temporary folder with `ctx.engine.build` and requires `BuildResult.status === 'ok'`: the build's evaluation and encoders run, and the engine worker's file and compression modules work in Electron's Node.

The evaluator compiles every kernel a node lists before it runs the node
(`runtime.md` 5.3), so step 2 compiles all variants, not only those the default
parameters use. `tests/graphs/registry.test.ts` evaluates the same document in
Node; a node that fails only here fails because of the runtime difference.

Running under `core` and under `max` compiles both format columns of the
compact kinds (`engine.md` 1.2).

The test needs the built application and a display. Locally it runs on the real
display and the hardware adapter. It looks at no pixel, so on CI it runs under
a virtual display on the software adapter (9.3).

### 8.5 UI tests

UI tests drive the real application in a window that is never shown
(`launchApp`, 2.9).

Facts that shape them:

| Fact | Consequence |
| --- | --- |
| A hidden window on a real display can be captured with `capturePage()`, WebGPU canvases included. Under Xvfb a WebGPU canvas does not present | UI tests need a real display. They are local only; they are not part of CI |
| In a window that was never shown the page's `requestAnimationFrame` fires once per second, even with `backgroundThrottling: false` and `disable-renderer-backgrounding`. In the engine worker it fires every 16.7 ms | The viewport is driven from the engine worker (`runtime.md` 7.5) and is not slowed down. A test never waits for a page animation frame; it waits for a state with `AppDriver.waitFor` |
| After `win.showInactive()` the page's frames run at 16.7 ms | A test that needs page frames (an animation, a drag) calls `AppDriver.show()` first |
| Timers in the main process are never throttled | `waitFor` polls from the main process |

Rules:

1. A UI test asserts state: the document, the stores, the presence of elements. A capture is written for a person and attached to the change; its pixels are never compared.
2. A test waits for the engine through `engineState`: `evaluation === null` for "nothing is running", `view.revision` for "this revision is shown", `build.running` for a build.
3. Every test ends with `AppDriver.close()`, which fails on any console error or uncaught exception in any process or worker.
4. A test opens documents from `tests/graphs/` or builds its own through commands; it never depends on a file outside the repository.
5. Logic that needs no window is tested in `tests/ui/<owner>/unit/` under plain `node --test`, and runs on CI: document recipes through `docStore.transact`, undo and merging, selectors, layout maths, formatting, and anything driven by engine state, by feeding `engineStore` a recorded list of `EngineEvent`s. The stores are vanilla stores and need no DOM. A recording is a JSON file under `tests/ui/<owner>/assets/`, made by subscribing to a session once. A file in a `unit/` folder imports no React component and no CSS.

The shell owner keeps `tests/ui/shell/smoke.test.ts`: the application starts,
the device becomes `ready`, acceptance graph 01 opens, `engineState.view`
reports its revision, a capture is not empty, and the application closes
without an error.

### 8.6 The command-line program

The program is `orogen`. Its entry point is `src/cli/main.ts`:

```
node src/cli/main.ts <subcommand> [options]         npm run orogen -- <subcommand> [options]
```

It is one Node process with the engine on the main thread (`runtime.md` 8.1).
`main.ts` reads the subcommand and hands over:

| Subcommand | Defined in | Implemented in |
| --- | --- | --- |
| `build`, `unreal-test` | `export-unreal.md` 3.11 and section 9 | `src/export/cli.ts` |
| `probe`, `render`, `gallery` | below | `src/cli/` |

`main.ts` imports the module of a subcommand when that subcommand is named.
For `build` and `unreal-test` it calls the one function `src/export/cli.ts`
exports for it:

```ts
/** `args` are the arguments after the subcommand. Resolves with the exit code; does not end the process. */
declare function runExportCli(subcommand: 'build' | 'unreal-test', args: readonly string[], signal: AbortSignal): Promise<number>;
```

`main.ts` owns the process. It aborts `signal` at the first SIGINT or SIGTERM
and exits at once with 130 at the second; when the subcommand has resolved it
flushes both output streams and calls `process.exit` with the code
(`runtime.md` 1.5 rule 5). A checkout without `src/export/cli.ts` says so on
standard error and exits with 2 for `build` and `unreal-test`. Standard output
of `probe`, `render` and `gallery` carries their result and nothing else: what
the engine or a node logs on the way, the device line of `OROGEN_GPU_LOG=1`
included, goes to standard error.

Options of `probe`, `render` and `gallery`:

| Option | Default | Meaning |
| --- | --- | --- |
| `--profile <core or max>` | `OROGEN_GPU_PROFILE`, else `max` | the device profile |
| `--adapter <substring>` | `OROGEN_GPU_ADAPTER`, else the default adapter | the adapter |
| `--out <dir>` | `OROGEN_TEST_OUTPUT`, else `test-output` | where files are written (`render`, `gallery`). A relative path is taken from the working directory |
| `--budget-mb <n>` | the budget formula of `runtime.md` 2.4 with default preferences: 2.4 GiB in Node, whatever the card | the pool budget in MiB (`render`, `gallery`). A run at 8129 of a node with a large state passes it |

`build` takes `--profile`, `--adapter` and `--budget-mb` with the same meanings
(`export-unreal.md` 3.11). Every subcommand that takes a resolution spells the
option `--res`; `render` and `gallery` accept any resolution legal under
`engine.md` 1.5 and refuse another as a usage error. A subcommand that
evaluates creates its registry with `createRegistry(nodes)` (`runtime.md` 5.1).

Exit codes are those of `export-unreal.md` 3.11: 0 success, 1 a node failed,
2 usage error, 3 no usable device or device lost, 130 cancelled. `render` also
exits with 1 when a slice measured above the hard ceiling of `runtime.md` 3.5
or the run emitted an `engine-error` event; it then prints the kernel names of
the longest slice on standard error. The command line has no session to emit
that event (`runtime.md` 7.7): there it is a slice above the ceiling, which the
`onSlice` hook reports (`runtime.md` 5.14), or a GPU error outside every error
scope, an `uncapturederror` of the device (`runtime.md` 5.8 rule 5).

```
orogen probe
```

Prints the device's `GpuCaps` (`runtime.md` 1.3) as indented JSON on standard
output. Every CI job runs it first, so a log always shows what the tests ran
on.

```
orogen render <type> [--res <n>] [--param <name>=<json>]... [--max-params] [--seed <n>] [--masked] [--crop <size>]
orogen render <project.orogen> --node <id> [--res <n>] [--crop <size>]
```

| | First form | Second form |
| --- | --- | --- |
| Document | one instance of the node type, its inputs connected by the wiring rule of 2.4: each height, data and `any` input from a terrain of its own, masks from the slope mask, colours from a `ref/colorize` of their terrain. The plain variant; with `--masked` the masked variant, a usage error for a node that has none. Settings: `terrainSize` 4096, `heightRange` 1024, `seed` 1, `seaLevel` 0.25, those of the tests (2.1), so that a node that reads the sea level has a sea to show | the project file |
| Parameters | defaults; with `--max-params`, every `float`, `int` and `vec2` parameter at its `max`; then each `--param`, whose value is one the parameter holds as given: a value `normalizeParams` would change (`runtime.md` 4.4) is a usage error; `--seed` sets the node's `seed` | as stored |
| Resolution | `--res`, default 513 | `--res`, default the project's preview resolution |

Both evaluate in `mode: 'build'` with every output of the node as a target, so
they show what a build would do. For every output they write
`nodes/<category>/<name>/<output>-<res>.png` under `--out`: a `sheet` for a
field, where a mask or a data output is drawn over a terrain, and a data output
with `range: 'auto'`; for a colour, `color` and, when there is a terrain, a
`3d` view of it with the colour drawn over it, as `<output>-<res>-3d.png`.
That terrain is what is connected to the node's first height input. In the
first form a node without a height input is drawn over terrain 0, whose broad
shape made the mask and whose colouring is the colour: the distance
`select/distance` measures is shown on the ground whose slopes made the mask. With `--crop`, they also write
a `hillshade` (or `color`) of the centre window of that size at one texel per
pixel, as `<output>-<res>-crop.png`. The masked variant writes files of its
own, with `-masked` after the resolution: `<output>-<res>-masked.png`,
`<output>-<res>-masked-3d.png`, `<output>-<res>-masked-crop.png`. They print one JSON line on
standard output, whatever the status of the evaluation:
`{ type, res, wallMs, gpuMs, longestSliceMs, peakBytes, files }`. `wallMs`,
`gpuMs` and `peakBytes` are those of the node's `node-done` event
(`runtime.md` 5.10), and 0, `null` and 0 when the node did not finish;
`longestSliceMs` is the longest slice of the whole evaluation whose duration
was measured (`runtime.md` 3.5: every slice with `timestamp-query`; by wall
clock only the resolved ones, and 0 when there is none), what feeds the node
included; `files` holds the absolute paths of the pictures written.

```
orogen gallery [--category <category>] [--res <n>]
```

Renders every node of the registry that has outputs as the first form of
`render` does, at resolution 513 unless `--res` is given, and a node that has
a masked variant (2.4) a second time with `--masked`. It writes
`gallery/index.html` with, per node: the picture of `outputs[0]`, below it
that of the masked variant with the inputs the mask is connected to, the title,
description and keywords, the ports, every parameter (label, unit, default,
range, help), the flags `maskable` and `resolutionDependent`, the time and
peak memory, and the content of the node's `conformance/…json` when the output
folder holds one (3.6). A node that fails, in either variant, is listed with
its error, and `gallery` then exits with 1, unless the node has a `file`
parameter: its
defaults select no file, the exception 8.1 makes for the registry test. After
a cancellation or a device loss no page is written. `gallery` prints the path
of the page on standard output. This page is what a reviewer reads.

---

## 9. CI

CI runs on GitHub Actions, on hosted runners without a GPU.

### 9.1 Jobs

| Job | Runner | Runs | Required to merge |
| --- | --- | --- | --- |
| `check` | `ubuntu-latest` | `npm ci`; `npm run check`; `npm run test:unit`; on pull requests `node tests/tools/ownership.ts` | yes |
| `gpu-linux` | `ubuntu-latest` | installs `mesa-vulkan-drivers libvulkan1`; `orogen probe`; `npm run test:gpu` with `OROGEN_GPU_ADAPTER=llvmpipe` | yes |
| `gpu-windows` | `windows-latest` | `orogen probe`; `npm run test:gpu` with `OROGEN_GPU_ADAPTER=Microsoft` | yes |
| `electron-kernels` | `ubuntu-latest` | builds the application; `xvfb-run -a npm run test:electron` with `OROGEN_ELECTRON_GPU=software` | no, until the integrator promotes it (9.3) |
| `package-windows` | `windows-latest` | builds and packages the application | yes, on the main branch |

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request: {}

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 26, cache: npm }
      - run: npm ci
      - run: npm run check
      - run: npm run test:unit
      - if: github.event_name == 'pull_request'
        run: node tests/tools/ownership.ts

  gpu:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { name: gpu-linux, os: ubuntu-latest, adapter: llvmpipe }
          - { name: gpu-windows, os: windows-latest, adapter: Microsoft }
    name: ${{ matrix.name }}
    runs-on: ${{ matrix.os }}
    env:
      OROGEN_GPU_ADAPTER: ${{ matrix.adapter }}
      OROGEN_GPU_PROFILE: core
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 26, cache: npm }
      - if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y mesa-vulkan-drivers libvulkan1
      - run: npm ci
      - run: npm run orogen -- probe
      - run: npm run test:gpu
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: test-output-${{ matrix.name }}, path: test-output }

  electron-kernels:
    runs-on: ubuntu-latest
    continue-on-error: true
    env:
      OROGEN_ELECTRON_GPU: software
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 26, cache: npm }
      - run: sudo apt-get update && sudo apt-get install -y xvfb
      - run: npm ci
      - run: npm run build            # the application build
      - run: xvfb-run -a npm run test:electron
```

The uploaded `test-output` holds the conformance previews and reports of every
node, drawn from data computed on the software adapter. A reviewer can look at
any node's output without a GPU.

### 9.2 What each job proves

| Job | Proves | Cannot prove |
| --- | --- | --- |
| `check` | the code type-checks; core uses no DOM or Node API; registry, naming, text and import rules hold; pure logic is correct; a pull request stays inside its owner's folders | anything that involves a GPU |
| `gpu-linux` | every kernel compiles through the SPIR-V path and runs on a device with default limits and no optional features; every node passes conformance and its own tests; the acceptance graphs meet their expectations; nothing depends on a hardware driver's rounding | performance; behaviour of hardware drivers; races that need real parallel hardware and large fields (`deterministic-large` is skipped); the compact formats and the `budget` check (lavapipe 25.2 has no `texture-formats-tier1`); anything about Windows |
| `gpu-windows` | the same through D3D12 and the HLSL path: the only automatic evidence for the backend the product ships on | performance; behaviour of the NVIDIA D3D12 driver; large-field races; the compact formats, unless the probe shows WARP has them; the 2-second GPU watchdog, to which a CPU adapter is not subject; memory limits |
| `electron-kernels` | the WGSL of every kernel is accepted by the compiler inside the Electron the product ships; every node evaluates there; a build writes its files from the engine worker | anything about values; the D3D12 backend inside Electron (the software adapter there is SwiftShader, a Vulkan implementation); the viewport |
| `package-windows` | the application builds and packages | that it starts, or that anything in it works |

No CI job proves: speed, memory behaviour at 8129, the watchdog, the `max`
profile, the viewport, the UI, or the Unreal import. Sections 5.3, 8.5 and 11
cover those on real machines.

### 9.3 Software adapters

| Where | Adapter | Selected by | Status |
| --- | --- | --- | --- |
| Node on `ubuntu-latest` | lavapipe (Mesa `llvmpipe`, a Vulkan implementation) | `OROGEN_GPU_ADAPTER=llvmpipe` after installing `mesa-vulkan-drivers` | works; also on the development machine |
| Node on `windows-latest` | WARP, `Microsoft Basic Render Driver`, a D3D12 adapter that is part of Windows | `OROGEN_GPU_ADAPTER=Microsoft` | works on hosted runners |
| Electron | SwiftShader, shipped with Electron | `OROGEN_ELECTRON_GPU=software`: on Linux the application then appends `enable-unsafe-webgpu` and not `enable-features=Vulkan`, which leaves Chromium on SwiftShader (`runtime.md` 1.6). `use-webgpu-adapter=swiftshader` is Chromium's explicit switch for the same thing and is the next thing to try if that fails on a runner | the first recipe is measured on the development machine with a display; both are unproven under Xvfb on a hosted runner |

- `forceFallbackAdapter` is never used to obtain a software adapter (`runtime.md` 1.5).
- Software adapters are several times slower than a GPU (lavapipe: 119 ms against 16 ms for the first 257² render, compilation included). Tests keep to 257 and below where they can; the suite has no time assertions.
- The application shows a permanent warning on a software adapter (`runtime.md` 1.3). That warning is not an error for `AppDriver.errors()`.
- The `electron-kernels` job does not block merging while it is unproven. The integrator makes it required once it has passed reliably, and until then runs `npm run test:electron` locally before every batch of frozen-file changes and before every release.
- The feature sets of WARP and of the runners' lavapipe are not assumed; the `probe` step prints them.

---

## 10. Reference nodes and acceptance graphs

### 10.1 Reference nodes

The category `ref` is core-owned and exists before parallel work starts. Each
reference node is complete, passes conformance, and is the template for one
authoring pattern; where one declares an opt-out, that is the model of a
justified one. Authors copy the nearest one. `ref` nodes are registered in
every build, because the acceptance graphs, `registryDoc` and `orogen render`
use them.

| Type | Pattern it shows | Inputs | Outputs | Parameters | Flags |
| --- | --- | --- | --- | --- | --- |
| `ref/fbm` | generator: `uv` only, seed, canonical helpers, fixed normalisation | none | `out` | `seed`, `size`, `octaves`, `gain` | |
| `ref/blur` | separable filter with temporaries: two passes, a temporary released early, a length converted to texels, a bounded tap count, `ops.blur` for what one pass cannot hold, one kernel variant per kind | `in` (any) | `out` (same as `in`) | `radius` | `maskable` |
| `ref/talus` | iterative simulation: `ctx.loop`, ping-pong, in-place accumulator, `ctx.wants`, progressive preview | `in` | `out`, `moved` (data) | `talus`, `reach` | `maskable` |
| `ref/distance` | CPU-assisted node: `ctx.read`, a CPU task with a transferred buffer, `ctx.write` | `in` (mask) | `out` (data) | none | |
| `ref/colorize` | colour node with a LUT: `bakeGradient`, a `vec4f` LUT, a colour output, an optional colour input | `in`, `base` (color, optional) | `out` (color) | `gradient`, `strength` | |
| `ref/slope-mask` | mask producer: physical slope, angle parameters compared as tangents and graded by the angle, saturated output | `in` | `out` (mask) | `slopeMin` (20), `slopeMax` (45) | |
| `ref/combine` | two inputs, an enum, the node's own mask input, a migration | `a`, `b`, `mask` (optional) | `out` | `mode` (`mix`, `add`, `multiply`, `max`, `min`; default `mix`), `strength` (default 0.5) | `version: 2` |
| `ref/autolevel` | a node that legitimately depends on whole-field statistics: `ops.minMax`, `ops.remap` | `in` | `out` | none | `resolutionDependent` |
| `ref/image` | file input: a `file` parameter, `ctx.readFile`, `decodeImage`, upload at the image's size, `ops.resample` | none | `out` | `file` (`png`) | |
| `ref/fail` | a documented error; an input passed straight to the output | `in` | `out` | `message` (text, default empty) | |

`ref/fbm` and `ref/talus` are the worked nodes of `engine.md` section 6.
`ref/talus` declares a `resolutionTol` of 0.2, because it relaxes the slopes it
finds and a finer level resolves steeper pairs of the same terrain: between 257
and 513 its `moved`, the height that crossed each texel, differs by 7 % of its
standard deviation on the `terrain` fixture and by 16 % on a `ref/fbm` of four
octaves with `talus` 30 and `reach` 0.05, the terrain of graph 03, where `out`
differs by 0.2 % and by 2 %. Its test file holds `out` to the default 1 % on
the `terrain` fixture. The others behave as follows:

| Type | Behaviour |
| --- | --- |
| `ref/blur` | Gaussian blur with standard deviation `radius`: weights beyond 3 sigma are dropped and borders clamp. Below a quarter of a texel it outputs its input unchanged. No pass exceeds 64 loads per texel: a radius above 10 texels is handed to `ops.blur`, which computes it on a coarser grid that continues past the terrain as the field's own grid does. A node that builds such a grid itself asks `ops.resample` for a ring (`engine.md` section 5): on a grid that ends at the border a wide blur is wrong by 7 to 21 % of the range at a border whose texels differ from their neighbours. On `ref/fbm`, and on a ring of 1 around 0, the result is the direct Gaussian within 0.3 % of the input's range for radii up to 0.1, and within 0.6 % at 0.25. A constant stays that constant and an opaque colour stays opaque, bit for bit |
| `ref/distance` | Euclidean distance, as a length, from each texel to the nearest texel whose input is at least 0.5; 0 on those texels; `√2` everywhere when there is none. Declares a `resolutionTol` of 0.03, because the boundary of the mask moves by up to one coarse cell between levels: between 257 and 513 that is 0.5 % of the standard deviation around the disc of the `mask` fixture and 1.3 % on the `terrain` fixture read as a mask |
| `ref/colorize` | `out = mix(base, gradient(saturate(in)), strength)`, alpha 1. An unconnected `base` is black |
| `ref/slope-mask` | 0 where the physical slope is at most `slopeMin`, 1 where it is at least `slopeMax`, linear in the slope angle between: the two thresholds are compared as tangents and the angle is computed only between them (`engine.md` 4.5). Declares a `resolutionTol` of 0.08, because it measures slope: between 257 and 513 the mask differs by 0.7 % of its standard deviation on the `terrain` fixture and by 5.6 % on a `ref/fbm` of four octaves, the terrain of the ladder checks in 10.2 |
| `ref/combine` | `r` = `b`, `a + b`, `a · b`, `max(a, b)` or `min(a, b)` by `mode`; `out = mix(a, r, strength · mask)`. Version 1 stored `amount` in percent; `migrate` turns it into `strength = amount / 100` |
| `ref/autolevel` | remaps the input's measured minimum and maximum to 0 and 1 |
| `ref/image` | the first channel of an 8- or 16-bit PNG as heights 0..1, resampled to the evaluation grid. Throws `No file selected` when `file` is empty. Its conformance call passes `params: { file: 'graphs/assets/heights-253.png' }` |
| `ref/fail` | throws `new Error(message)` when `message` is not empty; otherwise outputs its input. The trigger is a `text` parameter because the `params` check does not vary those |

### 10.2 The acceptance graphs

Six project files in `tests/graphs/` exercise the contract end to end. Each has
a test file of the same name. They use reference nodes only, plus three export
nodes of `export-unreal.md` in graph 05, which its test file hands to the
harness with `useNodes` (2.1), so they exist before any product node does.
Core is accepted when all six pass on the hardware adapter under both profiles
and on both software adapters under `core`.

All six use these settings: `terrainSize` 4096, `heightRange` 1024, `seed` 1,
`seaLevel` 0.25. Graphs 01 to 04 and 06 use build resolution 513 and preview
level 1 (257); graph 05 uses 1009 and preview level 1 (505), because export
needs an Unreal landscape size. Parameters not listed are defaults. The tests
use `openGraph`, `renderGraph` and `buildGraph` (2.4); states and error kinds
are those of `runtime.md` 5.8 and 5.10 as `NodeReport` carries them.

"Ladder check" means `expectLadder` between 257 and 513 with the tolerance the
producing node's conformance uses: 3.4, or the `resolutionTol` it declares.
Graphs with a ladder check on a node that reads neighbours give `ref/fbm` four
octaves: at the default `size` its finest wavelength is then 8 cells at 257.
With the default eight octaves the terrain has detail below the coarse cell,
and a slope or a blur legitimately differs between levels.

#### 01-generate

| Node | Type | Parameters | Inputs |
| --- | --- | --- | --- |
| `fbm` | `ref/fbm` | | |

Target `fbm.out`. The test asserts:

1. The statistics at 257 are within `01-generate.expect.json`, and the generator range rule holds.
2. 129, 257 and 513 agree at shared vertices with `max ≤ 1e-6`.
3. A second evaluation of the unchanged document reports `fbm` as `cached` and `nodesRun` 0.
4. Changing the project seed from 1 to 2 changes more than 1 % of the values; so does changing the node's seed from 0 to 1; the two results differ from each other.
5. Doubling `terrainSize` and `heightRange` leaves the output bit-identical: the graph describes a shape in a unit box.
6. Preview mode and build mode give bit-identical output.

#### 02-filter-mask

| Node | Type | Parameters | Inputs |
| --- | --- | --- | --- |
| `fbm` | `ref/fbm` | `octaves` 4 | |
| `steep` | `ref/slope-mask` | | `in` ← `fbm.out` |
| `blur` | `ref/blur` | `radius` 0.02 | `in` ← `fbm.out`; `mask` ← `steep.out` |
| `idle` | `ref/blur` | `radius` 0.05; bypassed | `in` ← `blur.out` |
| `peaks` | `ref/combine` | `mode` `max`, `strength` 1 | `a` ← `idle.out`; `b` ← `fbm.out`; `mask` unconnected |
| `level` | `ref/autolevel` | | `in` ← `peaks.out` |

Targets `level.out` and `steep.out`. The test asserts:

1. `fbm` runs once although three nodes consume it.
2. `steep.out` passes `expectMask`. Doubling `heightRange` changes `steep.out` and leaves `fbm.out` bit-identical: slopes are physical.
3. The maskable blend: `blur.out` equals `mix(fbm.out, B, steep.out)` with `max ≤ 1e-6`, where `B` is `blur.out` evaluated with the mask disconnected.
4. Bypass: `idle.out` is bit-identical to `blur.out`, and `idle` reports `bypassed`.
5. An unconnected own mask reads 1: `peaks.out` equals `max(idle.out, fbm.out)` computed in the test, with `max ≤ 1e-6`.
6. `level.out` has minimum 0 and maximum 1 within `1e-6`.
7. Ladder check on `fbm.out`, `steep.out`, `blur.out` and `peaks.out`. `level.out` is not compared.
8. After `setParam('peaks', 'strength', 0.5)` the next evaluation runs `peaks` and `level` only; `fbm`, `steep` and `blur` report `cached` and `idle` reports `bypassed`.
9. After reconnecting only the mask of `blur` to another source, `blur` reports `cached`: a changed mask repeats the blend and not the node (`runtime.md` 5.6).

#### 03-simulate

| Node | Type | Parameters | Inputs |
| --- | --- | --- | --- |
| `fbm` | `ref/fbm` | | |
| `talus` | `ref/talus` | `talus` 30, `reach` 0.05 | `in` ← `fbm.out` |
| `steep` | `ref/slope-mask` | | `in` ← `talus.out` |
| `dist` | `ref/distance` | | `in` ← `steep.out` |
| `mixed` | `ref/combine` | `mode` `mix`, `strength` 1 | `a` ← `talus.out`; `b` ← `fbm.out`; `mask` ← `talus.moved` |

The test asserts, in preview mode with `outputs: 'needed'` unless stated:

1. Target `talus.out` alone: `moved` is not wanted, and the `peakBytes` of `talus` is 528 392, two fields of 257².
2. Then target `mixed.out` in the same session: `talus` runs again because its entry lacks `moved`, its `peakBytes` is 792 588, and its `out` is bit-identical to step 1.
3. The progress fractions of `talus` are within 0..1 and do not decrease.
4. `slices: 'small'` against `'one'`: `talus.out` and `talus.moved` bit-identical.
5. With `slices: 'small'`, aborting from `onSlice` at the second slice of `talus` gives status `'aborted'` and `talus` as `skipped` with reason `aborted`; `fbm`, which had completed, is `cached` in the next evaluation, which runs `talus` in full and gives the bit-identical result.
6. The relaxation conserves material: `|mean(talus.out) − mean(fbm.out)| ≤ 1e-5`.
7. `talus.moved`, a data field that is not limited to 0..1, drives a mask input: `mixed.out` equals `mix(talus.out, fbm.out, saturate(talus.moved))` computed in the test, with `max ≤ 1e-6`.
8. `dist.out` is finite and is 0 on every texel where `steep.out ≥ 0.5`.
9. Target `mixed.out` with `fieldBudgetBytes: 600000`, in preview mode: `fbm` is `done`, `talus` reports an error of kind `budget`, `mixed` is `skipped` with `upstream` `talus`, and `expectNoLeaks` passes.
10. The same in build mode: no node runs and one node reports kind `budget`, because a build checks its memory before it starts (`runtime.md` 5.3).

#### 04-color

| Node | Type | Parameters | Inputs |
| --- | --- | --- | --- |
| `fbm` | `ref/fbm` | `octaves` 4 | |
| `paint` | `ref/colorize` | | `in` ← `fbm.out` |
| `soft` | `ref/blur` | `radius` 0.02 | `in` ← `paint.out` |
| `relief` | `ref/colorize` | `strength` 0.5 | `in` ← `soft.out`; `base` ← `fbm.out` |

Targets `soft.out` and `relief.out`. The test asserts:

1. `paint.out` and `soft.out` are colours with four floats per texel and alpha exactly 1.
2. The LUT: `paint.out` equals the node's gradient evaluated in the test at `saturate(fbm.out)`, with `max ≤ 2e-3`.
3. The colour variant: each of the R, G and B channels of `soft.out` equals `ref/blur` applied to that channel of `paint.out` as a field, with `max ≤ 2e-3`.
4. Both conversions of `runtime.md` 5.6: `relief` receives a colour on a `field` input (`luma`) and a field on a `color` input (`grey`). `relief.out` equals the value computed in the test from `soft.out` and `fbm.out` with those formulas, with `max ≤ 2e-3`.
5. Ladder check on `paint.out` and `soft.out`.

#### 05-roundtrip

| Node | Type | Parameters | Inputs |
| --- | --- | --- | --- |
| `image` | `ref/image` | `file` `assets/heights-253.png` | |
| `fbm` | `ref/fbm` | `size` 0.1, `octaves` 4 | |
| `land` | `ref/combine` | `mode` `add`, `strength` 0.1 | `a` ← `image.out`; `b` ← `fbm.out` |
| `rock` | `ref/slope-mask` | | `in` ← `land.out` |
| `paint` | `ref/colorize` | | `in` ← `land.out` |
| `outland` | `io/export-landscape` | `dither` false | `in` ← `land.out` |
| `outrock` | `io/export-layer` | `layer` `Rock` | `in` ← `rock.out` |
| `outpaint` | `io/export-color` | | `in` ← `paint.out` |

`assets/heights-253.png` is the `terrain` fixture at resolution 253 as a 16-bit
greyscale PNG, `round(h × 65535)`. 253, 505 and 1009 are levels of one ladder.
The test asserts:

1. Preview at 505: at every second vertex `image.out` equals the PNG's value with `max ≤ 1.6e-5` (one 16-bit step).
2. At 1009 the same holds at every fourth vertex: the upload keeps the image's own size and the GPU resamples it vertex-centred.
3. `planBuild` reports no problem for the document.
4. `buildGraph` ends with status `'ok'`, the manifest's `status` is `"complete"`, and the sink holds exactly the files of `result.files`, which include the manifest (`export-unreal.md` 3.1), and the report.
5. The height PNG and the `.r16` file hold the same samples, and they decode, with the range the manifest records, to `land.out` within the quantisation bound of `export-unreal.md` 5.4.
6. The files of the layers `Rock` and `Base` are 8-bit, 1009 × 1009, and their samples sum to exactly 255 on every texel.
7. The colour texture has a power-of-two size.
8. The transform in the manifest equals the formulas of `export-unreal.md` 5.5 computed in the test.
9. With a `MemorySource`: putting the same PNG bytes again with a new `mtimeMs` re-evaluates `image`; an untouched file leaves it `cached`.
10. A build aborted during its first target ends with status `'aborted'`; the sink holds the report and no other file, and `sink.open` is empty.

#### 06-broken

| Node | Type | Parameters | Inputs |
| --- | --- | --- | --- |
| `fbm` | `ref/fbm` | | |
| `good` | `ref/blur` | `radius` 0.01 | `in` ← `fbm.out` |
| `ghost` | `legacy/unknown`, not registered | `foo` 1, `bar` `"x"` | `in` ← `fbm.out` |
| `after` | `ref/blur` | | `in` ← `ghost.out` |
| `bad` | `ref/fail` | `message` `Reference failure` | `in` ← `fbm.out` |
| `down` | `ref/blur` | | `in` ← `bad.out` |
| `old` | `ref/combine`, stored at version 1 | `mode` `mix`, `amount` 25 | `a` ← `fbm.out`; `b` ← `good.out` |
| `open` | `ref/talus` | | `in` unconnected |
| `loopa` | `ref/blur` | | `in` ← `loopb.out` |
| `loopb` | `ref/blur` | | `in` ← `loopa.out` |

The targets are `fbm.out`, `good.out`, `old.out` and every other node as a node target. The test asserts:

1. `parseDoc` does not throw and reports at least one problem for `ghost` and one for the cycle. Serialising the parsed document and parsing the result gives an equal document, in which `ghost`, its parameters and its connections are as in the file.
2. The evaluation ends with status `'errors'`.
3. `ghost` reports kind `unknown-type`. `after` reports kind `missing-input`: an edge from a node of unknown type is ignored (`runtime.md` 4.3).
4. `bad` reports kind `node-exception` with the message `Reference failure`; `down` is `skipped` with `upstream` `bad`.
5. `open` reports kind `missing-input` with the message `missing input "in"`.
6. `loopa` and `loopb` report kind `cycle`.
7. `old` is migrated: its stored version is 2 after `parseDoc`, and `old.out` equals `mix(fbm.out, good.out, 0.25)` computed in the test, with `max ≤ 1e-6`.
8. `fbm`, `good` and `old` are `done` and their outputs are finite: one failing branch does not stop another.
9. `expectNoLeaks` passes.

### 10.3 Expectation files

`tests/graphs/<name>.expect.json` holds statistics, never values or images:

```ts
interface GraphExpectation {
  readonly res: number;                                                       // 257
  readonly targets: Readonly<Record<string, Partial<Record<StatName, readonly [lo: number, hi: number]>>>>;   // by '<node>.<port>'
}
```

- The integrator creates a file from `npm run expect -- <name>` run on the hardware adapter under `core`, widening each printed value to a range at least `2e-4` wide.
- The same file must hold on every adapter and under both profiles. A range is widened only with a stated reason in the commit; it is never widened to make one adapter pass without understanding the difference.
- For a colour target the statistics are those of channel 0.

### 10.4 What the acceptance graphs do not cover

| Not covered | Covered by |
| --- | --- |
| The simulation algorithms of `simulation.md` | each simulation node's own tests (5.2 item 5) |
| The coarse-to-fine driver, eviction, the out-of-memory retry, device loss, progressive previews, thumbnails | `tests/engine/` |
| The output folder, the other export nodes and formats | `tests/export/` |
| Product nodes | their conformance and behaviour tests; `tests/graphs/registry.test.ts`; the gallery |
| The application | 8.4, 8.5 |
| Build resolutions, speed, the watchdog, Unreal | section 11 |

---

## 11. Checks on real machines

Nothing automatic runs at build resolution on the product's backend. Before a
release, and after any change to slicing, tiling, the pool or device creation,
the integrator runs this list on the target machine (Windows 11, RTX 3080) and
records the results in the release notes.

| Step | Passes when |
| --- | --- |
| `orogen probe` | the adapter is the RTX 3080 and not a software adapter; the output is kept |
| `npm run test:gpu` and `npm run test:gpu:max` | every case passes, `deterministic-large` and `budget` included |
| `npm run test:electron` and `npm run test:ui` | every case passes |
| `orogen render ref/talus --res 8129`, and the same with `--max-params` | exits with 0: no device loss, `longestSliceMs` at most the hard ceiling of `runtime.md` 3.5, no `engine-error` event (8.6) |
| Acceptance graph 05 with build resolution 8129, built from the application | the build completes; no `device-lost` and no `engine-error` event; peak memory stays within the budget |
| The same build a second time | every image and raw file is byte-identical to the first build's |
| `orogen unreal-test`, and the output of graph 05, imported into Unreal Engine | the procedure of `export-unreal.md` section 7 succeeds and the checks of its section 9 give the expected results |
| `orogen gallery` | every node renders; the integrator has looked at the page |

The development machine (Ubuntu, GTX 1660 Ti) runs the first three rows through
Vulkan before every merge of a frozen-file change. That proves hardware
behaviour and the `max` profile; it proves nothing about D3D12 or the watchdog.
