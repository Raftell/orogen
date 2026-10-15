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
tests/tools/                             verify.ts and its reporter unit-report.ts, expect.ts, ownership.ts (5.3, 10.3, 7.1)
tests/env/                               max.env lavapipe.env warp.env (8.2)
tests/unit/                              GPU-free tests of core code and of the command line (cli/); registry lint; import boundaries; the user documentation against the registry
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
| `OROGEN_GPU_ADAPTER` | case-sensitive substring of an adapter name as its driver spells it, which is not how `caps.adapter` spells it (`runtime.md` 1.3) | unset: the default adapter | the `adapter` passed to `createNodeGpu`: `llvmpipe`, `Microsoft`, `NVIDIA` |
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
  | 'mask' | 'zero' | 'one' | 'impulse' | 'color' | 'color2' | 'color3' | 'color4' | 'fbm';

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
  color2(res: number): FieldData;
  color3(res: number): FieldData;
  color4(res: number): FieldData;
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
| `color2`, `color3`, `color4` | `(cone, 1 − u, basin, 1)`; `(1 − v, bowl, u, 1)`; `(notch, cone, 1 − v, 1)`, each fixture taken at `(u, v)` | the further colour inputs of one node. All four are opaque and within 0..1, and no channel of one is the same channel of another |
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
- `registryDoc` creates, for every given node that has outputs, one instance at default parameters, with every input connected by the wiring rule below, the optional inputs and the masks included. A chain of `ref/combine` nodes then takes `outputs[0]` of every instance, nodes with a `file` parameter last, and `ui.view` shows the end of the chain: evaluating the view evaluates every node. The instance of the first terrain's type (`generate/eroded-noise` where it is among the nodes, else `ref/fbm`) is the first terrain, and the instance of `generate/volcano` the stamp. A wiring type the registry lacks is left out: its inputs take the terrain itself, and without `ref/combine` the document has no chain and no view, so a test names every node as a target.
- **The wiring rule.** `registryDoc`, `orogen render <type>` and `orogen gallery` (8.6) connect the inputs of a node by port, in declaration order. It is two functions of `src/cli/document.ts`: `inputFeeds`, which says what feeds each input, and `feedSource`, which says of which nodes a feed is made in a registry:

  | Input | Fed from |
  | --- | --- |
  | type `field` of role `height` or `data`, and type `any`: the k-th of these, counted together from 0 | terrain k. Terrain 0 is the first terrain of the node's category, from the table below; terrain k ≥ 1 is `ref/fbm` with `seed` k and `size` 0.1, 0.5, 0.05, 0.25, … in turn. A node with two inputs is never shown one field twice |
  | type `field` of role `mask`: the primary input of `select/distance` and `select/edge` among them, and the `mask` the evaluator adds to a `maskable` node | the mask: `ref/slope-mask` of the broad shape of terrain 0, between the two angles the table below gives. It selects about half the terrain, in regions; the slopes of a whole terrain are speckle at the scale of a texel, and a mask of speckle shows nothing |
  | type `color`: the k-th of these | `ref/colorize` of terrain k |
  | a `field` input named `stamp` (role `height`), `flow` (role `data`) or `snow` (role `mask`): names of 6.3 | what it is named for, where the registry holds the node that makes it. `stamp`: `generate/volcano` at its defaults, a landform on level ground, which is what is stamped; a terrain that fills its field has no outline. `flow`: output `out` of `simulate/flow` of terrain 0, the drainage of the terrain the node reads; a second terrain read as a drainage area puts rivers where no water runs. `snow`: output `snow` of `simulate/snow` of terrain 0, and not the steep slopes of the mask, where snow does not lie. The optional inputs of these nodes stay unconnected. Such an input still counts in the rows above, and takes the feed its type gives it where the registry lacks the node |

  **The first terrain, by category.** One table says what a node is shown on. A category is shown on the terrain that shows what it is for:

  | Category | Terrain 0 | The mask is a slope mask of | Why |
  | --- | --- | --- | --- |
  | `generate`, `adjust`, `filter`, `select`, `io`, `ref` | `generate/eroded-noise` at its defaults | its first two octaves, between 40° and 55° | smooth valley floors under rough crests, and relief everywhere. `ref/fbm` is rough everywhere: a node that tells smooth ground from rough (`select/roughness`), keeps or flattens detail (`filter/high-pass`, `filter/smart-blur`), or works on the middle heights has nothing to show on it |
  | `surface` | `generate/mountain-range` at its defaults on gentle ground: a `ref/combine` adds a `ref/fbm` of two octaves (`seed` 9, `size` 0.5) to it, three tenths of its height, so the ground lies a seventh of the height range up and rolls by a few degrees | `ref/fbm` of three octaves, between 35° and 50° | detail that lies on gentle ground (stones, ripples, cracks) and detail that shows on steep ground (strata, outcrops) both have somewhere to be, and the ground between the spurs shows what a node adds by itself. The eroded noise is steep and rough everywhere. The range by itself stands on the floor of the height range: what a node cuts into ground at height 0 lies below the range, and `grey` draws it as out of it. The range has slopes only where it stands, and a mask of them would hide what a node does on the ground around it: its mask is that of the reference noise, whose regions lie across the range and the ground alike |
  | `simulate`, `color` | `generate/island` with `size` 1: a landmass that fills the terrain, in a sea that covers the borders | the island without its gullies (`erosion` 0), between 10° and 25° | a landform that drains to its coast on every side, with the sea below its valley floors. At the sea level of the pictures a fifth of the eroded noise is drowned valleys: no river reaches a coast there, and every water node is shown on a flooded basin. A colouring reads the sea level too, and has a sea, a shore and high ground to colour |

  Where the registry lacks the terrain of a category, terrain 0 is `generate/eroded-noise`, and where it lacks that too `ref/fbm` at its defaults, whose mask is of its first three octaves between 35° and 50°. `registryDoc` holds nodes of every category in one document: its terrain 0 is that of the first row for all of them. The fixtures of the conformance suite (3.1) are not affected.

  Inputs are counted whether or not they are connected, so that an input has the same feed in both of these:

  | Variant | Connected |
  | --- | --- |
  | **plain** | the required inputs. Every optional input is left unconnected, whatever its type and also when it is the node's first, and so is the `mask` of a `maskable` node |
  | **connected** | every input, and the `mask` of a `maskable` node. A node has a connected variant when it has an optional input or is `maskable` |

  The plain variant shows a node as a user sees it on dropping it into a graph, with its own defaults: `generate/crater` on level ground, `filter/warp` moved by its noise, `filter/slope-blur` steered by its own input. The connected variant shows what the optional inputs and a mask do to that. `registryDoc` builds the connected variant of every node.

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
  readonly range?: readonly [number, number] | 'auto' | 'data';   // the values drawn black and white. Default [0, 1]; 'auto' is [min, max]; 'data': below
  readonly height?: FieldData;                                // the terrain to shade when `f` is a mask or a colour, which is drawn over it
  readonly lit?: boolean;                                     // '3d' of a colour over a terrain: false draws the colour as it is. Default true
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
| `3d` | 768 × 512 | orthographic view of the surface in true proportions, from 30° above the horizon, looking towards −Y and turned 25° about Z, so that row 0 is at the back. +X runs to the right: the view is never a mirror image of `grey` (`engine.md` 1.8). Same light for a field and for a mask or a data field drawn over a terrain, so that the view is the top view tilted. A colour drawn over a terrain is lit from the viewer's side: light direction `normalize(−1, 1, √2)`, intensity `0.30 + 0.70·((1 + n·L) / 2)²`, which is 0.81 on level ground and 1 on a face turned to the light; with `lit: false` it is drawn as it is. The terrain's sides are drawn down to height 0; background `#1a1a1a` |
| `color` | field size | linear RGB encoded as sRGB, clamped; alpha ignored |
| `sheet` | 1808 × 512 | `grey` and `hillshade` scaled to 512 × 512 (nearest neighbour) and `3d`, side by side |

- Pixel `(x, y)` of `grey`, `hillshade` and `color` is texel `(x, y)`. Nothing is flipped: row 0 is the top row.
- `crop` selects a square window of texels before drawing, for one-to-one views of large fields.
- **`range: 'data'`** is the scale of a data output. It is `'auto'`, unless the field holds no negative value and its largest value is more than a hundred times its mean. Such a field spans orders of magnitude between what is typical of it and what is largest: a drainage area, a discharge, the depth of rivers, which are lines on a terrain where there is none. On a linear scale its picture is black but for a few texels, its mean under a hundredth of white (of `simulate/flow` on the island at 513 the largest value is 400 times the mean, of the depth of `simulate/rivers` 200 times; of what a thermal erosion wore away 70 times, of a distance 13 times), so it is drawn by the logarithm of its values: the largest is white, and black is the first percentile of the positive values or a ten-thousandth of the largest, whichever is larger. Zero, and whatever lies below the foot of that scale, is black and not the blue of a value out of range. Where a field has more than 2²⁰ values the percentile is that of every n-th.
- **The light of a colour.** The `3d` view looks at the slopes that face +Y, and the light of the map comes from −Y, behind them: under it every face a viewer sees is in the shade, and a colouring looks dark whatever it is. A colour is therefore lit from the viewer's side in that view, and keeps more of itself: four fifths on level ground. A colour that is itself a lit rendering of the terrain (`color/hillshade`) would show two lights on top of each other: `render` draws it with `lit: false` (8.6).
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
| `OROGEN_TEST=1` | creates its window with `show: false` and sizes it by its page: the page is 1600 × 1000 on every system, the frame on top of it (`useContentSize`; `autoHideMenuBar` too, without which Electron adds the native menu bar's height to the page). The window of a start that is shown is sized with its frame, which takes its pixels from the page on Windows (`runtime.md` 8.2 rule 9). It opens no dialog, no file manager and no other program (`openExternal`, `openDocument` and `openBuildFile` of `runtime.md` 8.6 answer as they would and start nothing), and ends and restarts nothing (`restartWithSoftwareRendering` answers as it would), keeps its preferences in a temporary folder of the run (`orogen-test-…` in the system's temporary folder, set as Electron's user-data folder), and assigns `window.orogenTest = { ctx }` in the main window, where `ctx` is the `CommandContext` of `runtime.md` 8.8. The page does the last, when `PlatformApi.testMode` says so (`runtime.md` 8.6). It takes no single-instance lock (a test runs beside the user's own application, and two test applications may run at once), reads and keeps no window place and writes no log file (`runtime.md` 8.2 rules 8 to 10). When its page's process ends otherwise than cleanly, it loads the window again without a dialog, three times at the most, so that a test can see what the page then offers (rule 11); the end of that process is in `errors()`, so such a test reads `errors()` itself and does not rely on `close()` |
| a project file as the first argument (`open`) | opens that project |
| `OROGEN_TEST_DRIVER=<absolute path>` | `require`s that module in the main process once the main window has loaded and calls its default export with `{ app, win, errors }`. `errors` is the list the main process has kept since launch, and keeps: what `AppDriver.errors()` returns. The module is `tests/electron/driver.cjs`; it carries the `AppDriver` calls |
| `OROGEN_GPU_PROFILE` | creates its device with that profile (`runtime.md` 1.1) |
| `OROGEN_ELECTRON_GPU=software` | starts on the software adapter (9.3): on Linux it does not append the switch `enable-features=Vulkan`, on Windows it appends the switches that ask WebGPU for SwiftShader (`runtime.md` 1.6), which give it no adapter there (9.3). A run restarted with software rendering has the same switches, by `--software-rendering` (`runtime.md` 8.7 rule 16), which the page asks for on Linux only |

- **The channel.** `launchApp` starts the application with a channel to the test process, and each `AppDriver` call is one request on it. The channel carries JSON, since Electron's V8 and the test's do not read each other's structured clones: a result of `eval` is structured-cloned from the page to the main process, and what JSON has no word for (`undefined`, numbers that are not finite, typed arrays, maps, sets, dates) is tagged there and restored in the test. An expression that throws in the page rejects its `eval` or `waitFor` with the error's name and message, and is no error of the application.
- **Errors.** `errors()` holds every console message of level error and every uncaught exception and rejection of the page, the engine worker and the CPU worker, which all reach the `console-message` event of the window (measured), and those of the main process; a renderer process that is gone and a page that did not load are errors too. A GPU process that is gone is not one: the session recovers from it (`runtime.md` 7.8).
- **The end.** `close()` ends the application, and so does the loss of the channel, from inside. An application that a test forgot is killed when the tests of its file are over, and it never holds the test process open. `launchApp` removes the temporary folder of the run once the application has exited: the application removes it as it exits, and Chromium writes its last state there again afterwards.
- A relative `open` is taken from the repository root. `launchApp` fails with a message that names `npm run build` when a file of `dist/` is missing, after it has waited through a build's swap: a build that ends puts its folder in place by two renames, between which there is no `dist/` (8.2; Node has no call that puts a folder in the place of one that holds files), so a file that is missing is looked for again every 10 ms for 5 s at the most (`waitThroughSwap` of `tools/build-folder.ts`). That moment is no longer than the second rename takes: on Linux no look of `tests/ui/platform/build.test.ts` has found it, on Windows 16 of 32 778 looks did during one build. The test asserts the same on every system: the folder never holds part of an application, it is missing at one moment at most, and a test that starts in that moment finds the new application.

Through `orogenTest.ctx` a test reaches everything a command can: the three
stores, the engine client, the registry and `run(commandId)`.

Beside `ctx` the shell assigns `orogenTest.shell`, for what a test cannot
reach through a command:

| Member | Is |
| --- | --- |
| `state` | the shell's own vanilla store: the preferences as the shell holds them, `paused`, the palette, the dialog that is open, the notices |
| `answers` | `{ openProjectDialog, saveProjectDialog, openFileDialog, chooseFolder }`, each a list of paths. Test mode opens no dialog, so `ctx.platform` answers each of these four calls with the next entry of its list, and as the bridge does (`null`) when the list is empty. A panel that asks for a file or a folder calls `ctx.platform`, so that its test can answer |
| `layout()`, `restoreLayout()` | the dock's layout as it would be saved; applying `Preferences.layout` as start-up does, which resolves `'restored'` or `'default'` |
| `dock.setSize(panelId, { width?, height? })`, `dock.size(panelId)` | gives the group of a panel a width, a height or both in CSS pixels, as dragging its dividers does, with its neighbours taking or giving the difference and no group going below the dock's least (220 by 100, `runtime.md` 8.7 rule 7); and the size the dock holds for it, or `null`. This is how a test makes a panel narrow, low or tall: `panelSize` and `tallest` of `tests/ui/shell/rig.ts` call it and wait until the panel's element has followed |
| `gallery` | the values of the control gallery, the dialog of the command `view.controlGallery`, which exists in test mode only and holds one of every shared control of `src/app/ui/` |
| `engineWorker()` | the engine worker of the moment, a `Worker`. A test ends it with `terminate()`, which nothing in the application does unasked, to see the application without one (`runtime.md` 8.5) |

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
| type `color`, and type `any` in the colour variant | counted together in declaration order: `color` for the first such input, then `color2`, `color3`, `color4`, repeating. As with heights, two inputs of one node are never the same colour: `adjust/switch` given one colour four times passes every check whichever input it passes on |

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
| `finite` | every node; both variants | R257 | passes the basic assertions. Non-finite count is exactly 0. Also writes a `sheet` (or `color`) preview of every output to `nodes/<category>/<name>/<output>.png`, and to `<output>-color.png` in the colour variant. A mask or a data output is drawn over a terrain as `render` draws it (8.6): the node's `outputs[0]` where that is a height, else the fixture of its first height input |
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
- An optional input does not change what a node is. The checks run with every input connected (3.1), so a generator that stamps into a terrain (`generate/crater`) is held to the range and to exact agreement on the `terrain` fixture it is given; it reads that input at its own texel, and on the coarsest ladder level, which 257 and 513 share (`engine.md` 1.9 rule 1). That level has 33 vertices a side at every test resolution, 64 in a project of 1009, 2017 or 4033 and 128 in one of 8129: the suite sees the node on the first grid alone, and what the node derives from the grid is held to its purpose on all three by the node's own tests (`tests/nodes/generate/unit/land-crater.test.ts`).
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
| `skip['generator-range']` | the check is not run | a generator (3.2) whose purpose is not a terrain that fills 0..1: a constant; a single shape with a small span; and a landform whose mean or span lies outside the rule by what it is: one landform on level ground at height 0 (`generate/mountain`, `generate/mountain-range`, `generate/volcano`: the ground takes most of the terrain, and the mean is 0.04 to 0.12), a landmass in a sea (`generate/island`: most of the terrain is seabed below the sea level), relief that is low by nature (`generate/dunes`: a span of 0.06). The reason states the mean or the span measured at the defaults, and the node's own tests hold its heights to the range its parameters give it (0..`height`) |
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

The lint is `tests/unit/registry.test.ts`, `tests/unit/boundaries.test.ts` and
`tests/unit/catalog.test.ts`. It needs no GPU. It imports each category index separately, so a category that
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
| `catalog` | `tests/unit/catalog.test.ts` reads the tables of `nodes.md`. For every category that has registered nodes: each node a table lists is registered, with the title, the ports (names, types, roles, optional inputs, order) and the flags `maskable` and `resolutionDependent` of its row, and has every parameter the row names and every option it names for an `enum`; and no node is registered that no table lists. A node an owner adds is listed in its category's section under `### Added by owners`. A category with no registered node is not compared. A node another document specifies has a row with its parameters and no ports, held to the same rule for them; no node is listed by its id alone. Where two owners share a category, each private index lists the nodes the owners' table gives its owner, and every other private module of the folder is named by exactly one owner there. A parameter a node has and its row does not name fails nothing, because owners add the parameters a node needs: the case says it as a diagnostic, for the integrator to name it |
| `lib-name` | The name of a library defined in a category folder begins with the category id (`filterKernel`). No category library is named `hash`, `noise`, `convert` or like any other library in `src/core/wgsl/` |

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
| `no-tanh` | No call of the WGSL builtin `tanh(` | `engine.md` 1.7: on Microsoft's software adapter `tanh(8.2)` is 1.08 and `tanh(1e5)` is not a number. A kernel writes it with the exponential of a number that is never above 0 |
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
| 1 | `npm run check`, each of its programs by itself | no type error in the category's folders (7.1) |
| 2 | `npm run test:unit`, with a second reporter that says of every case which file it is in (`tests/tools/unit-report.ts`) | the category's own cases pass: its case of the registry lint and its case of the catalog (section 4), every case in `tests/nodes/<category>/unit/`, and a case of the lint files that covers the whole product (`title-unique`, `test-location`, the import rules) when its message names a file or a node of the category. The category's lint case, and its catalog case where the catalog lists the category, must have run |
| 3 | the node's test files on the default adapter, profile `core` | every case passes |
| 4 | the same, profile `max` | every case passes, `budget` included |
| 5 | the same on the machine's software adapter (`tests/env/lavapipe.env` on Linux, `tests/env/warp.env` on Windows), profile `core` | every case passes |
| 6 | `orogen render <type> --res 513`, and with `--connected` for a node that has a connected variant (2.4) | a picture of every output is written |
| 7 | `orogen render <type> --res 4033 --crop 768` | `render` exits with 0 (8.6): a one-to-one crop of every output is written, `longestSliceMs` is at most the hard ceiling of `runtime.md` 3.5 (500 ms), and the run emitted no `engine-error` event |
| 8 | `orogen render <type> --res 4033 --max-params --out <output folder>/max-params` | the same condition, with every `float`, `int` and `vec2` parameter at its `max` (the last run of 3.3). Its pictures have the file names of step 7 and go to a folder of their own, so that those at the defaults stay |

Steps 1 and 2 cover the whole repository, in which several owners work at
once. A type error or a failed unit case outside the category's folders is
another owner's: `verify` lists it in the summary under a heading of its own
and does not fail for it, so that one unfinished category does not stop every
other owner's nodes from being verified. (`npm run check` joins its programs
with `&&`, so an error in the first would hide the second, which holds the
tests: `verify` runs each by itself and reads every error.) What is listed
there is fixed before integration, by its owner.

Steps 6 to 8 pass the `params` of the node's conformance call as `--param`,
read from the report of 3.6 rule 2 with a file as an absolute path: a node
whose defaults cannot run, an import node without a file, is rendered the way
the suite ran it. For an export node (3.1) the three steps are reported as
`skipped`: it has no outputs, `render` refuses a node without them, and what
it writes is tested through builds (`tests/export/`).

It ends by printing a summary: the adapter of each step, the number of cases
and skips, every opt-out with its reason, the `budget` estimate, the paths of
the pictures, the time, longest slice and peak memory of steps 7 and 8, and
what fails outside the category.

- A step whose adapter is not present on the machine is reported as `missing`. The node is not done until someone has run that step.
- Step 4 is what exercises the compact formats (`half`, `half2`, `mask8`) and asserts `budget`: the default adapter of the development machine has `texture-formats-tier1`, lavapipe does not.
- Steps 7 and 8 are the only runs at a build-scale resolution before integration. `--res 8129` replaces 4033 where the machine's memory allows.
- Steps 7 and 8 are the test of a kernel's declared `cost` (`engine.md` 3.15 rule 4). Tiling keeps a dispatch under the watchdog only when `cost` is honest. A run that does not pass the `cost` its parameters imply has its rate learned at preview sizes and small parameters, and its first build-scale tiles then take many times their estimate; the measured slice shows it. Step 8 is also the test of 6.6 rule 4.

### 5.4 Pictures

`orogen render` and `orogen gallery` are defined in 8.6. `render` draws one
node with realistic input, because the band-limited `terrain` fixture of the
tests is too smooth to show texel-level defects: as its first terrain the one
that shows what the node's category is for (2.4: an eroded noise with smooth
valleys and rough crests, a mountain range on level ground for surface detail,
an island for water and colour), fractal noise for every other.
Each input has a source of its own (2.4): the second terrain of a two-input
node has another seed and finer features than the first, so the picture shows
what the node does with two fields and not one field met with itself. A node
with an optional input or a mask, its own or the one `maskable` gives it, is
looked at twice: `orogen render <type>`, the node as it is dropped into a
graph, and `orogen render <type> --connected`, with its optional inputs and
its mask connected.

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
| The connected picture is the plain one, or the input | an optional input or the mask does not reach the algorithm, or the mask acts the wrong way round: 1 means affected |
| The plain picture of a node with an optional input shows nothing, or an error | the node does not stand on its own defaults when the input is unconnected: a user who drops it sees that |

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
| Test data | at most 100 kB per file, in `assets/` | `tests/nodes/io/assets/terrain-193.png` |
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
| `snow` | field, mask | where snow lies |
| `stamp` | field, height | a landform that is set on another terrain, in copies |
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
| A soft edge | `feather` | `float`, unit `length`; where the edge is that of a measured quantity which is no length, the unit of that quantity: `height` in `select/height` and `select/peaks`, `angle` in `select/slope` and `select/aspect` |

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

The Default column gives the value a parameter has unless rule 1 asks for
another. In `select`: the direction of `select/aspect` and `select/exposure`
defaults to 180, the slopes the 3D picture faces; the radius of `select/peaks`
and `select/occlusion` to 0.04, the size of a landform, and that of
`select/curvature` and `select/roughness` to 0.01, the width of a crest and of
the relief that makes ground rough; and a `strength` that
sets how readily a selection responds (`select/curvature`, `select/occlusion`,
`select/roughness`) to 0.5, where it acts as its cube, so that half of it asks
for eight times as much and there is room on both sides of the default.

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
| `docs/user/nodes.md` | nobody by hand: `tools/node-reference.ts` writes it from the registry, and the unit layer fails while it is behind (`tests/unit/docs.test.ts`). Whoever changes a node's title, description, ports, parameters or help runs the tool and hands in the page with the change; the ownership check lets every category owner change this one file |
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
check: one `tsc -p` for every `tsconfig*.json` of the repository root, the
programs of `runtime.md` 8.4 (the script is in 8.2). The core
configuration has neither DOM nor Node types (`runtime.md` 8.4), so core code
that uses `Buffer`, `process` or `document` fails there even though it would
run in Node.

What each layer contains:

| Layer | Contains |
| --- | --- |
| Unit | uniform packing against the WGSL layout rules; the TypeScript hashes and `mixSeed` against fixed vectors; curves and bakers; `defineKernel`, `defineLib`, `defineNode` validation and their messages; `parseDoc`, `serializeDoc`, `normalizeParams` and migration; the document commands; the stores (`docStore` through transactions, `engineStore` as a reduction of recorded `EngineEvent`s); `planBuild`, encoders and decoders (round trips), the manifest; the registry lint, the node catalog against the registered nodes, and import boundaries; CPU task functions; the arguments of the command line and its usage errors, the document `render` evaluates, the gallery page; the node reference of the user documentation against the registry (what `tools/node-reference.ts --check` checks) and its example projects, parsed and planned (`docs.test.ts`); whose a failure of `verify`'s first two steps is |
| GPU `tests/engine/` | every rule of `engine.md` and `runtime.md` that a node cannot break by itself: generated WGSL and accessors, the standard library (vertex-centred bilinear, clamping, `slopeAt`), TypeScript and WGSL hashes agreeing on 1000 inputs, per-run uniforms within one slice, call order, binding validation, tiles, the pool (states, reuse, budget, eviction), the out-of-memory retry with `failAllocAfter`, device loss, cache hits, keys and transient entries, `wants` re-runs, the maskable blend, bypass, conversion, progressive previews, thumbnails, CPU tasks, file identity, and every shared op including the coarse-to-fine driver; in `tests/engine/session/` the session (`runtime.md` section 7) on the real engine, with a recording renderer and a build function of the tests' own: latest-wins scheduling and what stays on screen, gestures and draft levels, the view and its loans, idle thumbnails at both resolutions, `inspect`, builds and plans, watched files, device recovery, the event order, both ends of the protocol over a real `MessageChannel`, the ledger at `dispose`, and a document of 300 nodes under bursts of 200 revisions (`scale.test.ts`: the session comes to rest and what it emits is bounded by the size of an idle evaluation); every subcommand of `orogen` as a child process, with its exit code and the pictures it writes decoded again |
| GPU `tests/nodes/` | conformance and behaviour of each node |
| GPU `tests/export/` | builds: the stages, the files, cancellation, the output folder |
| GPU `tests/graphs/` | the acceptance graphs; `registry.test.ts`, which evaluates `registryDoc(nodes)`, the whole product (`runtime.md` 5.1), at 129 and requires every node to end `done`, except nodes with a `file` parameter |
| Electron kernels | 8.4 |
| UI | 8.5 |

### 8.2 Scripts and environment files

```json
{
  "main": "dist/main.cjs",
  "bin": { "orogen": "src/cli/main.ts" },
  "scripts": {
    "build": "vite build",
    "start": "npm run build && electron .",
    "dist:win": "npm run build && electron-builder --win --x64 --publish never",
    "check": "tsc -p tsconfig.core.json && tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.viewport.json && tsc -p tsconfig.app.json",
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
- The whole GPU suites and `verify` also pass `--lock`: on Linux such runs queue on one machine-wide lock, so that several people working on one machine do not exhaust the one GPU's memory or disturb each other's measured slice times. The lock is taken outside the scope (`flock <file> systemd-run … -- <command>`), so the time limit begins when the run has the lock: a suite that queued behind another for most of its limit is not ended in the middle of its tests. A command that is ended is told why: the time limit ends it with SIGTERM, the memory cap kills it. On Windows the guard starts `npm` and `npx` through the shell, since both are scripts there. What the guard starts is `guardCommand` of `tools/guard-command.ts`, which `tests/unit/guard.test.ts` holds to this. While developing, an owner runs the tests of its own folder, unlocked and small: `tools/guard node --test --test-concurrency=1 "tests/nodes/filter/*.test.ts"`. A render above 2049 from the command line takes the lock explicitly: `tools/guard --lock --mem=4G node src/cli/main.ts render ...`.
- No test hands data-sized values to `assert.deepEqual`, `deepStrictEqual`, `equal` or `strictEqual`: not a field, a pixel buffer, an encoded file or any array whose length grows with a resolution. When such an assertion fails, Node builds a textual diff of both sides; measured here, two 4000-byte arrays with half the bytes different cost 300 MB, and 16 000 bytes passed 1 GB. That is the runaway the guard exists for. Data is compared with the harness functions of 2.5 (or, below the harness, a loop that reports the first difference and a count), and `deepEqual` is kept for small structured values.
- The glob patterns are quoted so that Node expands them, identically on Linux and Windows. A folder passed to `node --test` instead of a pattern fails.
- `--env-file` sets the variables for the runner and for every test process, on every platform. A script never relies on `VAR=value command` syntax.
- One file under another configuration: `node --env-file=tests/env/max.env --test tests/nodes/filter/blur.test.ts`.
- On the development machine the adapter name `llvmpipe` selects lavapipe while the NVIDIA driver is installed beside it; no other variable is needed. Lavapipe comes from the package `mesa-vulkan-drivers`.
- `npm run expect -- <graph>` prints the statistics of an acceptance graph's targets in the format of its expectation file (10.3).
- `npm run build` builds the application into `dist/` from one configuration, `vite.config.ts`, every file with a source map: the main-process script `main.cjs`, which `package.json` names in `main`, the preload script `preload.cjs`, the page `index.html` with its `assets/`, the engine worker `engine-worker.js` and the CPU worker `cpu-worker.js`. The two workers are classic scripts beside the page, which is how each is created (`runtime.md` 8.3, 6.3). `npm start` builds and runs the application. `npm run dist:win` builds it and packs it for Windows with `electron-builder` (`electron-builder.yml`) into `release/`: a zip and a portable executable, unsigned, holding `dist/` and no module of `node_modules`. `launchApp` (2.9), `npm run test:electron` and `npm run test:ui` start that build with `electron .` from the repository root and fail with a message that names `npm run build` when `dist/` is missing. The build configuration is the integrator's (`runtime.md` 8.10).
- **A build never empties the folder in use.** `dist/` is shared: whoever builds, builds for everybody who starts the application meanwhile, and a build that emptied `dist/` first left tests that started in those seconds without an application ("The application is not built", measured as missing at 112 018 of 139 555 looks during one build). The build therefore writes everything into a folder beside it, `dist.partial-<pid>`, and puts that in the place of `dist/` when the last script is built: `dist/` is renamed aside, the new folder renamed to `dist/`, the old one deleted (`tools/build-folder.ts`, `replaceFolder`). Between the two renames there is no `dist/` for as long as it takes to make the second call; at every other moment it holds a whole build, the old or the new. A build that fails deletes its own folder and leaves `dist/` as it was. Where `dist/` cannot be renamed, as Windows refuses for a folder a running program has open, its files are replaced one by one and those the new build lacks are deleted last. A staging or replaced folder that a build left when it was interrupted is deleted by the next build once it is an hour old. `OROGEN_DIST` names another folder than `dist/` to build into; only `tests/ui/platform/build.test.ts` sets it, which builds into a folder of its own that holds an application of before, watches it while the build runs, and so needs neither the lock nor a window.

### 8.3 Concurrency

| Layer | Setting | Why |
| --- | --- | --- |
| Unit | Node's default (parallel files) | no device; nothing shared |
| GPU | `--test-concurrency=1`: one test file at a time; one device per file | (1) In Node, waiting for the GPU busy-polls: a process uses 108 to 119 % of one core for as long as it awaits GPU work, so parallel files compete for cores. (2) All processes share one GPU and its memory: 6 GB on the development machine. (3) A software adapter computes on all CPU cores by itself. (4) The runtime sizes slices from measured time, which other processes disturb. The price is small: eight files take 3.0 s serially against 1.4 s in parallel |
| Electron, UI | `--test-concurrency=1`; one application instance at a time | every instance has a GPU process of its own (measured), and all of them share the one GPU, its memory and one display |

- Test cases inside a file run one after another: no test uses `{ concurrency: true }`.
- `--test-timeout=300000` is a backstop for a hung device, not a performance requirement. No test asserts a duration.
- Nor does a test assert what follows from a duration the machine measured: how many slices or batches a workload takes under `'auto'`, that a slice timed by wall clock was resolved, that one measured more or less than its estimate, or more than nothing, that no slice exceeded the hard ceiling, which level a draft runs at, or which node is too slow for an idle thumbnail. A software adapter on a shared runner is a hundred times slower than a GPU and different on every run, and the device's timer has steps (`runtime.md` 3.5). A test of a rule that depends on measured time gives the durations itself: those of slices (the learned rates, the bound on unmeasured kernels, the hard ceiling) through the `measure` hook (`runtime.md` 5.14), and what a session is told of its engine (the time of an evaluation, the last timing of a node; `runtime.md` 7.3 rules 4 and 9) through the engine its test hands it. A test that leaves the measuring to the machine asserts only what holds for whatever it reports.
- A wait for something the GPU delivers ends when it is delivered. Its limit, in time, is a backstop that says what did not happen; it is never a number of polls or of turns of the event loop, which a slow adapter uses up.
- A test that checks which adapter it runs on compares names with `adapterNamed` (`runtime.md` 1.3), never with the strings of `caps.adapter` directly.
- Creating the device costs 141 to 177 ms per file on the development machine, and a render with readback 5 ms at 513 and 37 ms at 2049. A node's test file therefore keeps its work at 257 and below where it can.
- When the GPU layer becomes too slow for one CI job, it is split with `--test-shard=<i>/<n>` across jobs; the concurrency inside a job stays 1.

### 8.4 The kernel test in Electron

The Dawn inside the `webgpu` package is about five Chromium milestones newer
than the one inside Electron 44, and Electron's Node is older than the Node the
tests run on. WGSL that compiles in Node can fail in the application. Measured
with Electron 44.7.0 and `webgpu` 0.6.2: of the WGSL language features Node's
Dawn reports, the application's lacks `fragment_depth` and
`texture_formats_tier1`, and has every other, the four that `engine.md` 3.12
allows among them. The compilers differ beyond what that list says. The GPU
layer cannot see this.

`tests/electron/kernels.test.ts` runs the following once per profile, through
`launchApp` and `orogenTest.ctx`:

1. It detaches the viewport (`ctx.engine.viewport.detach()`), waits for `engineState.device.state === 'ready'` and asserts that `device.caps.wgslLanguageFeatures` contains the four language features `engine.md` 3.12 allows. Reaching `ready` proves that every kernel of the engine itself compiled (`createEngine` compiles them).
2. It loads `registryDoc(nodes)`, with build resolution 513 and preview level 2, through `docStore.load`, and waits until no evaluation runs and every node of the view's plan has a final state.
3. It asserts that every node is `done`, except nodes with a `file` parameter and the `ref/combine` links after them. No node may report an error of kind `shader-compile`, `binding`, `validation` or `internal`. A failure prints the `NodeError`, which for a compile error names the kernel and carries the diagnostic and source lines.
4. It asserts that the node types the application's registry lists are those the Node process running the test sees. A node missing from the application bundle fails the test.
5. In a second launch it opens a project file that it has written to `<OROGEN_TEST_OUTPUT>/electron/<profile>/`: acceptance graph 05 (10.2), and beside it what step 2 cannot run, which is `io/import-field` and `io/import-color` with a file each and every export node. Its `file` parameters are absolute. It builds the project into a folder beside the project file with `ctx.engine.build` and requires `BuildResult.status === 'ok'` and every file of the result on disk at its size: the kernels of the nodes with a file compile, the build's evaluation and encoders run, an image is decoded in the CPU worker, and the engine worker's file and compression modules work in Electron's Node.
6. On a hardware adapter, and under the profile the device of the test process has, it compares twelve nodes of step 2 with this process's Dawn: the `min`, `max` and `mean` that `ctx.engine.inspect` gives for `outputs[0]` against the statistics of the same document evaluated through the harness, within `1e-5` (3.4). The sample is one or two nodes of each category that has field outputs, and no simulation: over its iterations the last bit of two compilers grows into another terrain.

The evaluator compiles every kernel a node lists before it runs the node
(`runtime.md` 5.3), so step 2 compiles all variants, not only those the default
parameters use. `tests/graphs/registry.test.ts` evaluates the same document in
Node; a node that fails only here fails because of the runtime difference.

Running under `core` and under `max` compiles both format columns of the
compact kinds (`engine.md` 1.2).

The test needs the built application and a display. Locally it runs on the real
display and the hardware adapter. It looks at no pixel, so on CI it runs under
a virtual display on the software adapter (9.3). There the first frame drawn to
a WebGPU canvas costs the device (`runtime.md` 7.5 rule 9), which is why step 1
detaches the viewport: a frame drawn before that may still cost the device
once, the session replaces it (`runtime.md` 7.8), and every wait of the test
is for a result the GPU delivered after the detach, which the lost device of
that frame cannot deliver. A wait that does not end says what the engine was
doing instead: the device's state and message, and how many nodes had ended.

### 8.5 UI tests

UI tests drive the real application in a window that is never shown
(`launchApp`, 2.9).

Facts that shape them:

| Fact | Consequence |
| --- | --- |
| A hidden window on a real display can be captured with `capturePage()`, WebGPU canvases included. Under Xvfb a WebGPU canvas does not present, and its first frame costs the device (`runtime.md` 7.5 rule 9) | UI tests need a real display. They are local only; they are not part of CI |
| In a window that was never shown the page's `requestAnimationFrame` fires once per second, even with `backgroundThrottling: false` and `disable-renderer-backgrounding`. In the engine worker it fires every 16.7 ms | The viewport is driven from the engine worker (`runtime.md` 7.5) and is not slowed down. A test never waits for a page animation frame; it waits for a state with `AppDriver.waitFor` |
| After `win.showInactive()` the page's frames run at 16.7 ms | A test that needs page frames (an animation, a drag) calls `AppDriver.show()` first |
| Timers in the main process are never throttled | `waitFor` polls from the main process |
| A window that was never shown does not have the system's focus: `document.hasFocus()` is false, `element.focus()` moves `document.activeElement`, and Chromium dispatches no `focus`, `blur`, `focusin` or `focusout` event (measured) | A control does not leave to a focus event what Enter or Escape must do as well. A test that needs one dispatches it |
| What `capturePage()` copies in such a window can be older than the page: measured, a picture taken 1.3 s after a change showed parts of the page as they were before it, in the first seconds of the application above all | A capture waits for two page frames and a second more (`tests/ui/shell/rig.ts`); it is still a picture for a person (rule 1) |
| In a window that was never shown, `window.resizeTo(w, h)` ends the GPU process within a frame (`device-lost`: "A valid external Instance reference no longer exists"), and the recovery that follows fails now and then with "No WebGPU adapter is available" (measured independently for four panels; a killed GPU process, by contrast, recovers in under a second). A visible window that the user resized, maximised and restored kept its device on the target machine (2026-10-15, `ARCHITECTURE.md` section 2); on Linux that is not known | A test never resizes the window: no file under `tests/ui/` calls `window.resizeTo`. A panel is given another size through the dock (`orogenTest.shell.dock.setSize`, 2.9), which is harmless; what a panel looks like in a small window is tested at the size such a window gives the panel. The rigs of the panels give the panel under test all the height of its column, so that a change of the default layout changes no test but the layout's own. Resizing a visible window is on the list of what must be checked by hand on both machines |
| The size of a window includes its frame and title bar on Windows, which take their pixels from the page; on Linux (X11) the frame lies outside it. Before test mode sized its window by its page, three tests failed on Windows by that: a column of the dock asked for 1370 pixels got less than 1362; a terrain seen from above drew 0.296 of the viewport's canvas, against 0.305 on Linux, where more than 0.3 was asked for; and the highest of a grid of pixels of the 3D view showed, in the draft, the ground behind a ridge that the refined terrain draws in front of it (measured here on a canvas made 1217 × 401 through the dock: 0.15 in the draft against 0.34 refined under one pixel) | Test mode sizes its window by its page (2.9). A test whose expectation depends on a panel's size computes it from the sizes the page has, the dock's width or the canvas's proportions and camera, so that it does not depend on the window's size either. Where the ground under a pixel matters, a test chooses the place and asks for the pixel that shows it from above, where a pixel shows the ground at its uv whatever the heights; in the 3D view which ground a pixel shows depends on the heights in front of it |
| In such a window `:focus` and `:focus-visible` do not match the element that `document.activeElement` names; `:focus-within` does (measured) | A focus ring cannot be captured or asserted there. That a control draws one is held by a lint of its style sheet, and looked at in a visible window |
| A `DataTransfer` that a script made ignores what is assigned to its `effectAllowed` (measured: it stays `'none'`) | A test of a drag records the assignment itself (`tests/ui/library/rig.ts`) |
| Input is synthesised in the page (`dispatchEvent`): the desktop sends none to a window that is not shown. A press is `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`; a submenu and a tooltip of `@base-ui/react` open on the pointer events of a hover, not on a press (measured) | `tests/ui/shell/rig.ts` installs these as `shellTest` in the page; the tests of a panel may import it |

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

`tests/ui/shell/journey.test.ts` is the foundation in one run, as a person
uses it: the engine worker has the hardware adapter; the default project is
computed and shown; a node is added, connected and changed with the commands
of `runtime.md` 4.6, each in one transaction, and the changes are undone and
redone by their keys; the project is saved, and a second application, started
beside the first, opens the file and computes the same terrain; a node whose
file is missing is reported in the status bar and in the list of errors, the
application goes on, and the report ends with the node; the GPU process is
killed and the terrain comes back (`runtime.md` 7.8; Linux); the engine worker
is ended and `engine.restart` brings the terrain back on a new canvas
(`runtime.md` 8.5). It writes twelve captures, `journey-01` to `journey-12`.
It is one of two tests that have two applications running at once (8.3), from
the start of the second until it has shown the file; each has a GPU process of
its own.

The `gate-*.test.ts` files of `tests/ui/shell/` use the finished application
as its user does, with all five panels, and write no store: every step is
input synthesised in the page (`tests/ui/shell/gate-rig.ts` installs the
panels' own input functions side by side). `gate-journey` goes from the first
start through an example, an edit, a build at 1009, the Unreal numbers against
the manifest on disk, a save and a second application that shows the same
picture, and then makes a project from nothing; `gate-consistency` holds one
node to one title, colour and status in the graph, the library and the
inspector, the selection to what the inspector and the viewport show, and an
error to the graph, the inspector and the status bar at once; `gate-commands`
chooses every item of the View, Engine, Viewport, Graph, Inspector and Library
menus and presses every default key of `runtime.md` 8.8 in its scope and
outside it; `gate-robustness` uses a project of 300 nodes and kills the GPU
process, and restarts the engine, in the middle of a drag. Their captures are
under `test-output/ui/gate-*/`.

`tests/ui/shell/heavy/build-4033.ts` builds the alpine example at
4033 × 4033 from the application and uses the interface while the build runs.
It is no file of a layer (its name ends in no `.test.ts`): it needs more memory
than the guard allows by default. It is run by itself, after `npm run build`:

```
tools/guard --lock --mem=6G --timeout=3600 node --test --test-concurrency=1 --test-timeout=3000000 tests/ui/shell/heavy/build-4033.ts
```
Its window-free counterpart is `tests/ui/shell/unit/foundation.test.ts`: the
members of the stores, the engine client, the bridge and a `PanelDef` against
the declarations this contract prints, the five panel folders, the exports of
`src/app/ui/`, and a throwaway panel that brings a command, a key and a menu
entry in its `PanelDef` to the real shell (`runtime.md` 8.10).

The state owner keeps `tests/ui/state/client.test.ts`, the one file of this
layer without a window: the three stores and `EngineClient` on one port of a
`MessageChannel`, and on the other `serveSession` over a real session on the
harness's engine, with a build function that calls `buildProject` with a memory
sink (`runtime.md` 7.1). It needs a WebGPU adapter and neither the built
application nor a display. `tests/ui/state/record.ts` makes the recordings of
`tests/ui/state/assets/` from such a session:
`tools/guard node tests/ui/state/record.ts`.

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
| `--budget-mb <n>` | the budget formula of `runtime.md` 2.4 with default preferences: 60 % of what nvidia-smi reports for an NVIDIA card (`runtime.md` 1.3), else 2.4 GiB | the pool budget in MiB (`render`, `gallery`). A run at 8129 of a node with a large state passes it |

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
orogen render <type> [--res <n>] [--param <name>=<json>]... [--max-params] [--seed <n>] [--connected] [--crop <size>]
orogen render <project.orogen> --node <id> [--res <n>] [--crop <size>]
```

| | First form | Second form |
| --- | --- | --- |
| Document | one instance of the node type, its inputs connected by the wiring rule of 2.4: each height, data and `any` input from a terrain of its own, the first that of the node's category, masks from the slope mask, colours from a `ref/colorize` of their terrain, and an input named `stamp`, `flow` or `snow` from what it is named for. The plain variant, in which optional inputs are unconnected; with `--connected` the connected variant, a usage error for a node that has none. Settings: `terrainSize` 4096, `heightRange` 1024, `seed` 1, `seaLevel` 0.25, those of the tests (2.1), so that a node that reads the sea level has a sea to show | the project file |
| Parameters | defaults; with `--max-params`, every `float`, `int` and `vec2` parameter at its `max`; then each `--param`, whose value is JSON, or a plain word (a letter, then letters, digits, `-` and `_`) that is no JSON and is taken as that text, so that a choice needs no quotes in any shell; the value is one the parameter holds as given: a value `normalizeParams` would change (`runtime.md` 4.4) is a usage error; `--seed` sets the node's `seed` | as stored |
| Resolution | `--res`, default 513 | `--res`, default the project's preview resolution |

Both evaluate in `mode: 'build'` with every output of the node as a target, so
they show what a build would do. For every output they write
`nodes/<category>/<name>/<output>-<res>.png` under `--out`: a `sheet` for a
field, where a mask or a data output is drawn over a terrain, and a data output
with `range: 'data'` (2.7), the scale found on the whole field and shared by
its crop; for a colour, `color` and, when there is a terrain, a `3d` view of
it with the colour drawn over it and lit from the viewer's side, as
`<output>-<res>-3d.png`. The outputs of `color/hillshade`, a lit rendering
already, are drawn there as they are (`lit: false`).
That terrain is the node's own `outputs[0]` where that is a height: the
`water` of `generate/island` is drawn over the island, the `weight` of
`adjust/height-blend` over the blend and what a simulation moved over the
terrain it left, never as a height sheet of the mask itself. For a node whose
`outputs[0]` is no height it is what is connected to the node's first height
input. In the first form a node with neither is drawn over terrain 0, whose
broad shape made the mask and whose colouring is the colour: the distance
`select/distance` measures is shown on the ground whose slopes made the mask.
In the second form a node with neither is drawn over the terrain the project
shows, the `height` of its view (`runtime.md` 7.4), when that is an output of
another node the evaluator would find: the last blend of two colour maps of a
project has no terrain of its own and is the picture one wants of it. That
terrain is one more target of the evaluation, so a failure in what makes it is
reported like any other. A project that shows no terrain gives such a node its
`color` picture alone.
With `--crop`, they also write a `hillshade` (or `color`) of the centre window
of that size at one texel per pixel, as `<output>-<res>-crop.png`. The
connected variant writes files of its own, with `-connected` after the
resolution: `<output>-<res>-connected.png`, `<output>-<res>-connected-3d.png`,
`<output>-<res>-connected-crop.png`. They print one JSON line on
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

Renders every node of the registry that has outputs, or of one category, as
the first form of `render` does, at resolution 513 unless `--res` is given,
and a node that has a connected variant (2.4) a second time with
`--connected`. For a variant in which two or more inputs of the node are
connected it also draws what each was given, at one pixel per texel, as
`nodes/<category>/<name>/input-<port>-<res>[-connected].png`: a terrain and a
landform as a `hillshade`, the mask and the snow as `grey`, the drainage as
`grey` with `range: 'data'`, a colouring as `color`. (No output has such a
name: a port name holds no hyphen.)

A node with a `file` parameter is drawn with the `params` of its conformance
call, read from the report of 3.6 rule 2 in the output folder as `verify`
reads them (5.3), and its page names them: the import nodes are shown with the
file their tests give them. Without that report, or when the node no longer
takes the parameters it holds, the node is drawn at its defaults.

It writes one page per category drawn, `gallery/<category>.html`, with, per
node: the picture of `outputs[0]`, with the inputs beside it where they were
drawn, and the pictures of its other outputs beside it, each with its name and
type and a colour with its `3d` view; of a data output what black and white
stand for, and that the scale is logarithmic where it is; below it the same
for the connected variant, with its inputs and the names of what was
connected; the title, description and keywords, the ports, every
parameter (label, unit, default, range, help), the flags `maskable` and
`resolutionDependent`, the time and peak memory, and the content of the node's
`conformance/…json` when the output folder holds one (3.6). A node that fails,
in either variant, is listed with its error, and `gallery` then exits with 1,
unless the node has a `file` parameter and was drawn at its defaults: they
select no file, the exception 8.1 makes for the registry test. Drawn with the
file of its conformance call, such a node is held to rendering like any other.

It then writes `gallery/index.html`, which links the page of every category
that has been drawn into the output folder, by this run or by an earlier one,
in the order of `engine.md` 4.1, with the number of its nodes, how many of them
failed, and the resolution, adapter and profile it was drawn with. A page says
these of itself, in a `meta` element named `orogen-gallery`, so drawing one
category leaves the pages of the others as they are and the index whole. A
category without a node that has outputs gets no page. After a cancellation or
a device loss nothing is written. `gallery` prints on standard output the path
of the page to open: that of the category given with `--category`, else the
index. These pages are what a reviewer reads.

---

## 9. CI

CI runs on GitHub Actions, on hosted runners without a GPU.

### 9.1 Jobs

| Job | Runner | Runs | Required to merge |
| --- | --- | --- | --- |
| `check` | `ubuntu-latest` | `npm ci`; `npm run check`; `npm run test:unit`; `node --test .github/scripts/launch-check.test.mjs`, the verdicts of the launch check (below); on pull requests `node tests/tools/ownership.ts` | yes |
| `gpu-linux` | `ubuntu-latest` | installs `mesa-vulkan-drivers libvulkan1`; `orogen probe`; `npm run test:gpu` with `OROGEN_GPU_ADAPTER=llvmpipe`. In the workflow it is two jobs, `gpu-linux-1` and `gpu-linux-2`, each a shard of the suite's test files (`node --test-shard`): on the software adapter one job no longer finishes in time | yes, every shard |
| `gpu-windows` | `windows-latest` | `orogen probe`; `npm run test:gpu` with `OROGEN_GPU_ADAPTER=Microsoft`. Four jobs, `gpu-windows-1` to `gpu-windows-4`, for the same reason: Windows' software adapter is the slower one | yes, every shard |
| `unit-windows` | `windows-latest` | `npm ci`; `npm run check`; `npm run test:unit`; `node --test .github/scripts/launch-check.test.mjs` | no, until it has passed there |
| `electron-kernels` | `ubuntu-latest` | builds the application; the launch check under `xvfb-run -a` as the first start of the Electron binary (below); `xvfb-run -a npm run test:electron`, all with `OROGEN_ELECTRON_GPU=software` | no, until the integrator promotes it (9.3) |
| `package-windows` | `windows-latest` | builds the application and packages it unsigned (`npm run dist:win`); uploads the application folder `release/win-unpacked` as the artifact `Orogen-windows-x64` and the portable executable as `Orogen-windows-x64-portable`; starts the packaged `Orogen.exe` with the launch check (below) as it is, and again with `OROGEN_ELECTRON_GPU=software` and `--require-evaluation`; uploads what it saw as `launch-check-windows` | yes, on the main branch: the package, and that the packaged application loads its window. That its engine opens a device as it is (the runner has no GPU, and Chromium offers WebGPU no adapter there), that it computes on the software adapter, and that the portable executable starts, are said and not required. The software step is advisory for good: Electron 44 gives WebGPU no adapter in software mode on Windows, on this runner and on the target machine with its RTX 3080 (9.3) |

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
      - run: node --test .github/scripts/launch-check.test.mjs
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
      # Ubuntu 24.04 restricts unprivileged user namespaces, which Chromium's sandbox uses.
      - run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
      - run: npm ci
      - run: npm run build            # the application build
      - name: First start of the application
        run: xvfb-run -a node .github/scripts/launch-check.mjs --result test-output/launch-check/first-start.json
        env: { OROGEN_LAUNCH_CHECK_OUTPUT: '1' }
      - run: xvfb-run -a npm run test:electron
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: test-output-electron-kernels, path: test-output }

  unit-windows:
    runs-on: windows-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 26, cache: npm }
      - run: npm ci
      - run: npm run check
      - run: npm run test:unit
      - run: node --test .github/scripts/launch-check.test.mjs

  package-windows:
    runs-on: windows-latest
    env:
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'      # unsigned: no certificate is looked for
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 26, cache: npm }
      - run: npm ci
      - run: npm run dist:win         # the build, then electron-builder (8.2)
      - uses: actions/upload-artifact@v4
        with: { name: Orogen-windows-x64, path: release/win-unpacked, if-no-files-found: error }
      - uses: actions/upload-artifact@v4
        with: { name: Orogen-windows-x64-portable, path: release/*-portable.exe, if-no-files-found: error }
      - name: Start the packaged application
        run: node .github/scripts/launch-check.mjs --app release/win-unpacked/Orogen.exe --result test-output/launch-check/packaged.json
      - name: Its engine opens a GPU device
        continue-on-error: true
        run: node .github/scripts/launch-check.mjs --read test-output/launch-check/packaged.json --require-device
      # Advisory: software mode gives WebGPU no adapter on Windows, here and beside a working RTX 3080
      # (docs/ARCHITECTURE.md section 2), so the application offers it on Linux only (runtime.md 8.7 rule 16).
      # It stays to say when a later Electron changes that.
      - name: Its engine computes on the software adapter
        continue-on-error: true
        run: node .github/scripts/launch-check.mjs --app release/win-unpacked/Orogen.exe --result test-output/launch-check/packaged-software.json --require-evaluation --timeout 600
        env: { OROGEN_ELECTRON_GPU: software, OROGEN_LAUNCH_CHECK_EVALUATION_MS: '300000' }
      - name: Start the portable executable
        continue-on-error: true
        shell: bash
        run: node .github/scripts/launch-check.mjs --app "$(ls release/*-portable.exe | head -n 1)" --result test-output/launch-check/portable.json --settle 120
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: launch-check-windows, path: test-output/launch-check }
```

`.github/workflows/ci.yml` is this with what a runner needs beside it: time
limits, the GPU layer split into shards (8.3), a listing of what the package
holds.

**The Windows build to download** is the artifact `Orogen-windows-x64` of a
run: the application folder, which GitHub hands out as one zip, so that
unpacking it once gives `Orogen.exe`. It holds what the zip of `npm run
dist:win` holds, without a zip inside a zip. `Orogen-windows-x64-portable` is
the one portable executable.

**The launch check** (`.github/scripts/launch-check.mjs`) starts the
application once in test mode (2.9) and says how far it came. Without `--app`
it starts the build of the checkout with `electron .`; with `--app` a packaged
executable, as it is, from the command line: `OROGEN_TEST=1` and
`OROGEN_TEST_DRIVER` naming `.github/scripts/launch-check-driver.cjs`, which,
unlike `tests/electron/driver.cjs`, needs no channel to a parent. The driver
detaches the viewport as the kernel test does (8.4 step 1), waits for the
engine's device to be `ready` or `failed`, and writes what it saw as JSON to
the file `OROGEN_LAUNCH_CHECK_RESULT` names: the states the device went
through with their times, the adapter, Chromium's GPU feature status when the
window had loaded and at the end, whether the start-up project was computed,
whether an adapter asked for at the end is still given, and the errors the
application recorded. When the first start of the engine finds no device it
runs the command `engine.retryDevice`, which is what the status bar's Retry
does, and records the second start beside the first. The program exits with 0
when the window loaded its interface, with 1 when the application did not
start, did not load or left no result, with `--require-device` with 3 when no
device was opened, and with `--require-evaluation` with 3 likewise and with 4
when the device was opened but the start-up project was not computed: the
evaluation did not end within `OROGEN_LAUNCH_CHECK_EVALUATION_MS`, a node of
it did not end `done`, or nothing was shown. `--read <file>` judges a result
that was written before and starts nothing. It looks at no pixel and asserts
nothing about values or time; the time it waits is a backstop.

The uploaded `test-output` holds the conformance previews and reports of every
node, drawn from data computed on the software adapter. A reviewer can look at
any node's output without a GPU.

### 9.2 What each job proves

| Job | Proves | Cannot prove |
| --- | --- | --- |
| `check` | the code type-checks; core uses no DOM or Node API; registry, naming, text and import rules hold; pure logic is correct; a pull request stays inside its owner's folders | anything that involves a GPU |
| `unit-windows` | the type check and the pure logic hold where paths have drive letters and backslashes and the temporary folder is Windows' own; a checkout on Windows has the line ends the repository stores (`.gitattributes`), without which 17 of the tests that read the contract's Markdown fail (measured on a converted copy) | anything that involves a GPU |
| `gpu-linux` | every kernel compiles through the SPIR-V path and runs on a device with default limits and no optional features; every node passes conformance and its own tests; the acceptance graphs meet their expectations; nothing depends on a hardware driver's rounding | performance; behaviour of hardware drivers; races that need real parallel hardware and large fields (`deterministic-large` is skipped); the compact formats and the `budget` check (lavapipe 25.2 has no `texture-formats-tier1`); anything about Windows |
| `gpu-windows` | the same through D3D12 and the HLSL path: the only automatic evidence for the backend the product ships on | performance; behaviour of the NVIDIA D3D12 driver; large-field races; the compact formats, unless the probe shows WARP has them; the 2-second GPU watchdog, to which a CPU adapter is not subject; memory limits |
| `electron-kernels` | the WGSL of every kernel is accepted by the compiler inside the Electron the product ships; every node evaluates there; a build writes its files from the engine worker | anything about values; the D3D12 backend inside Electron (the software adapter there is SwiftShader, a Vulkan implementation); the viewport |
| `package-windows` | the application builds and packages; the packaged application starts on Windows and loads its interface, with the driver of the launch check loaded from outside its archive; and, where the steps that are not required pass, that the portable executable starts, and that its engine worker, loaded from the archive, opens a device on the software adapter and computes the start-up project there. The software-adapter step does not pass with Electron 44: Chromium gives WebGPU no adapter in software mode on Windows (9.3) | anything about a hardware adapter or the D3D12 backend inside Electron, a visible window, a dialog, an input device or a build: the window is hidden and nothing is clicked. The engine worker on Windows: it computes only where there is a graphics card, which the runner lacks |

No CI job proves: speed, memory behaviour at 8129, the watchdog, the `max`
profile, the viewport, the UI, or the Unreal import. Sections 5.3, 8.5 and 11
cover those on real machines.

### 9.3 Software adapters

| Where | Adapter | Selected by | Status |
| --- | --- | --- | --- |
| Node on `ubuntu-latest` | lavapipe (Mesa `llvmpipe`, a Vulkan implementation) | `OROGEN_GPU_ADAPTER=llvmpipe` after installing `mesa-vulkan-drivers` | works; also on the development machine |
| Node on `windows-latest` | WARP, `Microsoft Basic Render Driver`, a D3D12 adapter that is part of Windows | `OROGEN_GPU_ADAPTER=Microsoft` | works on hosted runners. It does not report `isFallbackAdapter`; `caps.software` knows it by its name (`runtime.md` 1.3) |
| Electron on Linux | SwiftShader, shipped with Electron | `OROGEN_ELECTRON_GPU=software`: the application then appends `enable-unsafe-webgpu` and not `enable-features=Vulkan`, which leaves Chromium on SwiftShader (`runtime.md` 1.6) | works: measured on the development machine, with a display and under `xvfb-run`, where the kernel test passes in both in 35 to 50 s; on `ubuntu-latest` it gave SwiftShader to every launch but the first start of the binary (below) |
| Electron on Windows | none | `OROGEN_ELECTRON_GPU=software`, with the switches of `runtime.md` 1.6 that ask WebGPU for SwiftShader | **does not work** with Electron 44: no adapter, on `windows-latest` and on the target machine beside a working RTX 3080 (below). The tests that start the application this way (`pipeline.test.ts`, `smoke.test.ts` of `tests/ui/`) are skipped on Windows with that reason, by `offersSoftwareRendering` of `src/app/shell/shell.ts`, which is also what keeps the application from offering software rendering there (`runtime.md` 8.7 rule 16) |

- `forceFallbackAdapter` is never used to obtain a software adapter (`runtime.md` 1.5).
- Software adapters are several times slower than a GPU (lavapipe: 119 ms against 16 ms for the first 257² render, compilation included). Tests keep to 257 and below where they can; the suite has no time assertions.
- **The viewport on a software adapter.** A CPU rasteriser draws every frame of the viewport whole, and the light maps are refined over many frames (`runtime.md` 7.5 rule 13): on WARP a test that refined the maps of a 2017² field under a 1600 × 1000 canvas through ten bakes ran past the 300 s backstop, and four others took 117 to 136 s each. A test of `tests/engine/viewport/` that redraws many frames therefore runs on a software adapter (`caps.software`) at a smaller size, with what it asserts unchanged: a quarter of the field's texels, a sixth of the canvas's pixels, fewer moves of the sun or a shorter erosion; on a GPU it keeps its size. A test whose subject is a picture for a person, or the look of the terrain from near, is skipped there with its reason (`t.skip`), as `pictures.test.ts` and `look.test.ts` do.
- The application shows a permanent warning on a software adapter (`runtime.md` 1.3). That warning is not an error for `AppDriver.errors()`.
- The `electron-kernels` job does not block merging while it is unproven. The integrator makes it required once it has passed reliably, and until then runs `npm run test:electron` locally before every batch of frozen-file changes and before every release.
- **The first start on a runner.** On the one run on record (13 October 2026) the first of the four launches failed with `the engine did not start: No WebGPU adapter is available` and the three after it, one of them with the same profile, had SwiftShader. The message is that of the worker's own `requestAdapter()` resolving `null` (`runtime.md` 8.3 step 1), not that of a failed recovery, and the launch was the first start of the Electron binary on that machine: `npm ci` no longer fetches the binary, so the package downloaded it inside that test. `ARCHITECTURE.md` section 2 records the same answer after a GPU process has ended: a recovery that fails now and then for want of an adapter. It is not reproduced on the development machine, under `xvfb-run` with `OROGEN_ELECTRON_GPU=software`, with an empty home folder or with a renderer that asks seconds later; there Chromium reports `webgpu: disabled_off` and no GPU access from the moment the window has loaded and still gives every renderer SwiftShader. The job therefore makes the first start a step of its own, the launch check (9.1), which records what that start found and whether a second start of the engine finds an adapter, and the kernel test begins on a binary that has run once. What the application lacks is in `runtime.md` 8.3: an engine worker that is given no adapter stops for good, and only the Retry of the status bar starts another.
- **The Windows package on a runner without a GPU.** Measured on 14 October 2026: started as it is, the packaged application loaded its window and its engine was given no adapter, at the first start and at Retry; Chromium reported `"webgpu": "unavailable_software"` and the one adapter of the machine, "Microsoft Basic Render Driver", inactive. WARP, which Dawn in Node takes on the same runner, is not offered to WebGPU. That step stays and says it, as a warning. The step after it starts the package with `OROGEN_ELECTRON_GPU=software`, which on Windows asks WebGPU for SwiftShader (`runtime.md` 1.6), and requires the start-up project computed. Chromium refused it on the runner in three rounds of switches, the last adding `ignore-gpu-blocklist`, `use-angle=swiftshader`, `use-vulkan=swiftshader` and the `Vulkan` feature: `"webgpu"` stayed `"unavailable_software"` (`ARCHITECTURE.md` section 2). On 15 October 2026 the target machine, whose RTX 3080 works, gave the same answer to `npm run test:ui`: both tests that start the application in software mode ended at "No WebGPU adapter is available". Software mode does not work on Windows, so the step is advisory (`continue-on-error`) and stays only to say when a later Electron changes that; SwiftShader on Linux computes the start-up project in 3 s.
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
| `ref/talus` | iterative simulation: `ctx.loop`, ping-pong, in-place accumulator, a pairwise exchange by the slope at the middle of each pair, `ctx.wants`, progressive preview | `in` | `out`, `moved` (data) | `talus`, `reach` | `maskable` |
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
| `ref/slope-mask` | 0 where the physical slope is at most `slopeMin`, 1 where it is at least `slopeMax`, linear in the slope angle between: the two thresholds are compared as tangents and the angle is computed only between them (`engine.md` 4.5). Declares a `resolutionTol` of 0.08, because it measures slope: between 257 and 513 the mask differs by 0.5 % of its standard deviation on the `terrain` fixture and by 5.6 % on a `ref/fbm` of four octaves, the terrain of the ladder checks in 10.2 |
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
  readonly res: number;                                                       // the preview resolution of the graph: 257, and 505 for graph 05
  readonly targets: Readonly<Record<string, Partial<Record<StatName, readonly [lo: number, hi: number]>>>>;   // by '<node>.<port>'
}
```

- The integrator creates a file from `npm run expect -- <name>` run on the hardware adapter under `core`, widening each printed value to a range at least `2e-4` wide.
- The same file must hold on every adapter and under both profiles. A range is widened only with a stated reason in the commit; it is never widened to make one adapter pass without understanding the difference.
- For a colour target the statistics are those of channel 0.
- A file names every output its graph delivers: all of them for graphs 01 to 04, the outputs of the five nodes that are no export node for graph 05, and for graph 06 the three that can be made. The test of a graph holds one evaluation at `res` to it (`expectTargets` of `tests/graphs/_graphs.ts`, which also refuses a range narrower than `2e-4`).
- `npm run expect` loads the categories whose nodes the graph names, and no other: a category somebody is working on does not stop the graphs that do not use it.

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
| `orogen gallery` | every node renders; the integrator has looked at the pages |

The development machine (Ubuntu, GTX 1660 Ti) runs the first three rows through
Vulkan before every merge of a frozen-file change. That proves hardware
behaviour and the `max` profile; it proves nothing about D3D12 or the watchdog.
