# Export contract: export nodes, the build pipeline, file formats and Unreal Engine

This document defines how a graph becomes files on disk and how those files
become an Unreal Engine 5.8 landscape. It covers the export nodes, the build
pipeline, the image encoders and decoders, the Unreal conventions and formulas,
the manifest, the manual import procedure, the experimental editor plugin and
the acceptance test.

Other documents own what is only referred to here:

| Document | Owns, as used here |
| --- | --- |
| `engine.md` | `NodeDef` and its member `export`, `defineNode`, `ParamDef`, `ParamsOf`, `PortDef`, `CpuTask`, `hashU32`, `hashCell`, `hashUnit`, `DecodedImage`, `decodeImage`, the grid, unit and direction conventions, build resolutions, `normalAt` |
| `runtime.md` | `GraphDoc`, `ProjectSettings`, `NodeRegistry`, `createRegistry`, `nodes`, `normalizeParams`, `parseDoc`, `Engine`, `EvalTarget`, `EvalEvent`, `NodeError`, `FieldHandle`, `AnyFieldHandle`, `FileSink`, `FileWriter`, `EngineSession`, how the session starts a build, device creation and loss, module boundaries |
| `testing.md` | the test harness, the conformance suite and registry lint, naming conventions, file ownership, the acceptance graphs |

**Status of Unreal facts.** The engine source is private. Nothing in this
document has been compiled or run in Unreal Engine. Every statement about
Unreal carries one of these marks. A `[U]` statement is a working assumption:
section 11 lists the ones this contract depends on and the check that settles
each.

| Mark | Meaning |
| --- | --- |
| `[E]` | Read on a page of Epic's documentation or API reference labelled 5.8. For API functions this confirms the declaration only, never behaviour or default arguments |
| `[3P]` | Confirmed only by a source other than Epic (named where used) |
| `[D]` | Derived by arithmetic from `[E]` facts |
| `[U]` | Unverified: recalled, inferred or reported by users. Not confirmed for 5.8 |

---

## 1. Code layout

| Path | Contents | May import |
| --- | --- | --- |
| `src/core/export-decl.ts` | Pure types, and nothing else. (a) The declaration types of section 2: `ExportSource`, `ExportContext`, `ExportHook`, `ExportItem` and its members, `HeightRange`; re-exported by `src/core/api.ts`. (b) The build types that cross the session boundary: `BuildProblemCode`, `BuildProblem`, `FileEncoding`, `PlannedFile`, `PlannedLayer`, `LandscapeLayout`, `BuildPlan`, `BuildEvent`, `BuildResult` (3.1, 3.3, 3.9, 5.2); re-exported by `src/core/runtime.ts`, from which `src/export/` and `src/app/` import them | core only |
| `src/core/nodes/io/export-*.ts` | The export nodes (2.4) | `api.ts` only |
| `src/core/io/` | Image decoders (4.7) | no Node, DOM or Electron API |
| `src/export/plan.ts`, `unreal.ts`, `manifest.ts` | Planning, Unreal arithmetic, manifest and report types. Pure: no Node module, no GPU, no I/O | `src/core/api.ts`, `src/core/runtime.ts` |
| `src/export/build.ts`, `convert.ts` | The pipeline; sample conversion and the texel-grid resampler | the above, the encoders |
| `src/export/encode/png.ts`, `raw.ts`, `exr.ts`, `tiff.ts` | Streaming encoders (section 4) | `node:zlib` |
| `src/export/folder.ts` | Output folder handling (3.8) | `node:fs`, `node:path` |
| `src/export/unreal-test.ts` | The acceptance pattern (section 9) | the encoders |
| `src/export/cli.ts` | The `build` and `unreal-test` subcommands of the command-line program (3.11) | everything above, `src/core/nodes/index.ts`, `src/platform/node/` |
| `tests/export/`, `tests/export/unit/` | Tests (section 10) | |
| `tests/nodes/io/export-*.test.ts` | `conformance(def)` and nothing else (`testing.md` 5.2) | |
| `unreal/OrogenBridge/` | The editor plugin, C++ source (section 8) | |
| `docs/user/unreal-import.md` | The user documentation of section 7: every statement and its mark unchanged, with the headings and the references between them numbered for that document. It adds a worked example from a real build, the acceptance test of section 9 and how the plugin of section 8 is used | |

`src/export/` is not part of `src/core/` and is imported neither by `src/core/`
nor by `src/app/` (`runtime.md` 8.4). The session, which is core code, receives
the build as a function (`runtime.md` 7.1); the interface names a build's types
through `runtime.ts`. `src/export/` runs on the engine thread: the engine
worker in the application and the main thread in the command-line program. It
uses `node:fs`, `node:path` and `node:zlib` and no other Node module.

---

## 2. Export nodes

An **export node** is a node whose definition has an `export` hook. The hook
declares what to write; it writes nothing. The build pipeline (section 3) owns
evaluation, measurement, conversion, encoding and every Unreal convention, so
no export node contains a formula.

### 2.1 The hook and its context

```ts
// src/core/export-decl.ts

/** The field connected to one input of one export node. */
interface ExportSource {
  readonly node: string;    // node instance id
  readonly input: string;   // input port name of that node
}

interface ExportContext<
  P extends readonly ParamDef[] = readonly ParamDef[],
  I extends readonly PortDef[] = readonly PortDef[],
> {
  /** Normalised parameter values of the instance, as in EvalContext.params. */
  readonly params: ParamsOf<P>;
  readonly nodeId: string;
  /** The instance's title when the user gave one, else the definition's title. */
  readonly title: string;
  /** Whether the input is connected. */
  connected(input: I[number]['name']): boolean;
  /** The source for a connected input. Throws an Error when the input is not connected. */
  source(input: I[number]['name']): ExportSource;
}

type ExportHook<
  P extends readonly ParamDef[] = readonly ParamDef[],
  I extends readonly PortDef[] = readonly PortDef[],
> = (ctx: ExportContext<P, I>) => readonly ExportItem[];
```

`NodeDef.export` (`engine.md` 4.6) has the type `ExportHook`. `defineNode`
types the hook's context from the node's own declarations: its argument
declares `export?(ctx: ExportContext<P, I>): readonly ExportItem[]`.

Rules for the hook:

1. It is called by `planBuild` (3.3) only: once per enabled export node instance per plan. It is never called during an evaluation, a preview or thumbnail rendering.
2. It is synchronous and pure. Its result depends only on `ctx.params` and on which inputs are connected. It performs no I/O, touches no field and no GPU object, and reads no project setting.
3. It returns zero or more items. An empty array means the node exports nothing.
4. Every `source` in a returned item comes from `ctx.source()` of the same call.
5. A throw, a result that is not an array of items of the kinds of 2.2, or a source that breaks rule 4 is the plan problem `E_HOOK_FAILED` on that node. A member that breaks a rule of the table in 2.2 has its own problem code (3.3).

A source stands for exactly the field the node's own `ctx.input(name)` would
receive at build resolution: an input of type `'field'` yields a `field`, an
input of type `'color'` a `color`, with the evaluator's port conversion applied
(`runtime.md` 5.6).

### 2.2 Export items

```ts
type HeightRange =
  | { readonly mode: 'measured'; readonly headroom: number }
  | { readonly mode: 'fixed'; readonly min: number; readonly max: number };

/** The landscape heightmap and everything that is one per landscape. At most one per build. */
interface LandscapeItem {
  readonly kind: 'landscape';
  readonly source: ExportSource;                 // a 'field' holding heights
  readonly name: string;
  readonly range: HeightRange;
  readonly dither: boolean;
  readonly zeroAt: 'seaLevel' | 'bottom';
  readonly origin: 'center' | 'corner';
  readonly baseLayer: string;
  readonly layerBlend: 'advanced' | 'final';
  readonly layerFloor: number;
  readonly layerLimit: number;
  readonly worldPartition: { readonly enabled: boolean; readonly gridSize: number; readonly regionSize: number };
}

/** One landscape target layer, 8 bits, at landscape resolution. */
interface LayerItem {
  readonly kind: 'layer';
  readonly source: ExportSource;                 // a 'field' holding a mask
  readonly layer: string;                        // Unreal target layer name
  readonly weightBlended: boolean;
}

/** A companion texture for materials: power-of-two size, texel-centred. */
interface TextureItem {
  readonly kind: 'texture';
  readonly source: ExportSource;                 // 'color' for content 'color', else 'field'
  readonly name: string;
  readonly content: 'color' | 'mask' | 'normal';
  readonly size: 'auto' | 1024 | 2048 | 4096 | 8192;
  readonly bits: 8 | 16;
}

/** A single-channel image at build resolution on the vertex grid, for other tools. */
interface ImageItem {
  readonly kind: 'image';
  readonly source: ExportSource;                 // a 'field'
  readonly name: string;
  readonly format: 'png8' | 'png16' | 'r16' | 'r32' | 'exr' | 'tiff16' | 'tiff32';
  readonly map: 'unit' | 'measured';
}

type ExportItem = LandscapeItem | LayerItem | TextureItem | ImageItem;
```

| Item | Member | Rule | Meaning |
| --- | --- | --- | --- |
| landscape | `name` | `lettersOnly(name)` (2.6) has 1 to 64 characters | Base name of the build's files |
| | `range` | `headroom` in 0..1; fixed `max > min` | Which heights map to codes 0 and 65535 (5.4) |
| | `dither` | | 1 LSB triangular dither when quantising (5.4) |
| | `zeroAt` | | The normalised height placed at Unreal world Z = 0: the project's sea level, or height 0 (5.5) |
| | `origin` | | Which point lies at world X = Y = 0: `'center'`, the terrain's centre; `'corner'`, vertex (0, 0) (5.5) |
| | `baseLayer` | a layer name (below) | Name of the weight-blended layer that receives the remainder (5.8). Used only when the build has a weight-blended layer item |
| | `layerBlend` | | Unreal blend method of every weight-blended layer of the build (5.8) |
| | `layerFloor` | 0..0.25 | Weights below this fraction are set to 0 before normalising (5.8) |
| | `layerLimit` | integer 0..16 | Largest number of weight-blended layers kept per texel; 0 means no limit (5.8) |
| | `worldPartition` | `gridSize` integer 1..16, `regionSize` integer 4..64 | Written to the manifest for the import (5.10) |
| layer | `layer` | matches `/^[A-Za-z][A-Za-z0-9_]{0,62}$/`; unique in the build ignoring case, `baseLayer` included | The target layer's name; it must equal the layer name used in the landscape material |
| | `weightBlended` | | `true`: member of the weight-blended group, blend method `layerBlend`. `false`: an independent mask, blend method `none` |
| texture | `name` | `alnumOnly(name)` has 1 to 64 characters | Part of the file name |
| | `content` | | 5.9 |
| | `size` | | Side in texels. `'auto'` is the smallest power of two that is at least `resolution − 1`, limited to 1024..8192 |
| | `bits` | 16 only with content `'mask'` | Bits per channel |
| image | `name` | `alnumOnly(name)` has 1 to 64 characters | File name without extension |
| | `format` | | 4.6 |
| | `map` | | Integer formats only: `'unit'` maps field values 0..1 to the code range and clips; `'measured'` maps the field's measured minimum and maximum |

The item kind `'splines'` is reserved (5.11). No node returns it.

### 2.3 Rules for export nodes

`checkExportNode(def: NodeDef): string[]` (`src/export/plan.ts`) returns the
violated rules. The `meta` check of the conformance suite (`testing.md` 3.1)
and `planBuild` call it.

1. `category` is `'io'` and `type` begins with `io/export-`.
2. `outputs` is `[]`, `kernels` is `[]`, and `evaluate` is `evaluate() {}`. The node has no `cpuTasks`, `maskable`, `resolutionDependent`, `uses`, `externalKey` or `seed` param.
3. The first parameter is the bool `enabled`, with label `Enabled` and default `true`.
4. `inputs[0]` is named `in` and is required.

Because an export node has no outputs, nothing ever requests it: its
`evaluate` is never called, in a preview or in a build, and it cannot be
bypassed. A build asks the evaluator for the outputs connected to its inputs
(3.2).

### 2.4 The export nodes

| Type | Title | Input `in` | Returns |
| --- | --- | --- | --- |
| `io/export-landscape` | Unreal Landscape | `field`, role `height` | one `landscape` item |
| `io/export-layer` | Landscape Layer | `field`, role `mask` | one `layer` item |
| `io/export-color` | Color Texture | `color` | one `texture` item, content `'color'`, bits 8 |
| `io/export-mask` | Mask Texture | `field`, role `mask` | one `texture` item, content `'mask'` |
| `io/export-normal` | Normal Texture | `field`, role `height` | one `texture` item, content `'normal'`, bits 8 |
| `io/export-field` | Image File | `field` | one `image` item |

Every node begins with the `enabled` parameter of 2.3. The other parameters, in
inspector order (`engine.md` 4.3 gives the kinds; `testing.md` 6.4 the naming
conventions these names follow):

**`io/export-landscape`**

| Name | Kind | Default | Range or options | Item member |
| --- | --- | --- | --- | --- |
| `name` | text | `'Orogen'` | at most 64 characters | `name` |
| `rangeMode` | enum | `'measured'` | `'measured'`, `'fixed'` | `range.mode` |
| `headroom` | float, ratio | 0 | 0..1 | `range.headroom`; shown when `rangeMode` is `'measured'` |
| `heightMin` | float, height | 0 | 0..1, soft | `range.min`; shown when `rangeMode` is `'fixed'` |
| `heightMax` | float, height | 1 | 0..1, soft | `range.max`; shown when `rangeMode` is `'fixed'` |
| `dither` | bool | true | | `dither` |
| `zeroAt` | enum | `'seaLevel'` | `'seaLevel'`, `'bottom'` | `zeroAt` |
| `origin` | enum | `'center'` | `'center'`, `'corner'` | `origin` |
| `baseLayer` | text | `'Base'` | a layer name | `baseLayer` |
| `layerBlend` | enum | `'advanced'` | `'advanced'`, `'final'` | `layerBlend` |
| `layerFloor` | float, ratio | 0.008 | 0..0.25 | `layerFloor` |
| `layerLimit` | int | 0 | 0..16 | `layerLimit` |
| `partition` | bool | true | | `worldPartition.enabled` |
| `gridComponents` | int | 4 | 1..16 | `worldPartition.gridSize` |
| `regionComponents` | int | 32 | 4..64 | `worldPartition.regionSize` |

"Shown when" is the parameter's `visibleWhen` (`engine.md` 4.3):
`{ param: 'rangeMode', equals: 'measured' }` for `headroom`, and
`{ param: 'rangeMode', equals: 'fixed' }` for `heightMin` and `heightMax`.

The defaults of `dither`, `layerFloor`, `layerLimit`, `gridComponents` and
`regionComponents` are starting points to calibrate in Unreal. `layerFloor`
0.008 is about 2/255; a grid of 4 components with a region of 32 is a tuning
choice, not an Epic recommendation.

**`io/export-layer`**

| Name | Kind | Default | Range or options | Item member |
| --- | --- | --- | --- | --- |
| `layer` | text | `'Layer'` | at most 63 characters | `layer` |
| `weightBlended` | bool | true | | `weightBlended` |

**`io/export-color`, `io/export-mask`, `io/export-normal`**

| Name | Kind | Default | Range or options | Item member |
| --- | --- | --- | --- | --- |
| `name` | text | `'Color'`, `'Mask'`, `'Normal'` | at most 64 characters | `name` |
| `dimension` | enum | `'auto'` | `'auto'`, `'1024'`, `'2048'`, `'4096'`, `'8192'` | `size`: `'auto'`, or the option as a number |
| `bits` | enum | `'8'` | `'8'`, `'16'`; `io/export-mask` only | `bits`, as a number |

**`io/export-field`**

| Name | Kind | Default | Range or options | Item member |
| --- | --- | --- | --- | --- |
| `name` | text | `'Field'` | at most 64 characters | `name` |
| `format` | enum | `'exr'` | `'png8'`, `'png16'`, `'r16'`, `'r32'`, `'exr'`, `'tiff16'`, `'tiff32'` | `format` |
| `rangeMode` | enum | `'unit'` | `'unit'`, `'measured'` | `map` |

A complete export node:

```ts
// src/core/nodes/io/export-layer.ts
import { defineNode } from '../../api.ts';

export default defineNode({
  type: 'io/export-layer',
  title: 'Landscape Layer',
  category: 'io',
  description: 'Exports a mask as an Unreal landscape target layer.',
  keywords: ['unreal', 'weightmap', 'splat', 'paint layer'],
  inputs: [{ name: 'in', type: 'field', role: 'mask' }],
  outputs: [],
  params: [
    { kind: 'bool', name: 'enabled', label: 'Enabled', default: true, help: 'Include this node in builds.' },
    {
      kind: 'text', name: 'layer', label: 'Layer name', default: 'Layer', maxLength: 63,
      help: 'Name of the landscape target layer. It must equal the layer name used in the landscape material.',
    },
    {
      kind: 'bool', name: 'weightBlended', label: 'Weight-blended', default: true,
      help: 'On: the layer shares the total weight with the other weight-blended layers. Off: an independent mask.',
    },
  ],
  kernels: [],
  evaluate() {},
  export(ctx) {
    return [{ kind: 'layer', source: ctx.source('in'), layer: ctx.params.layer, weightBlended: ctx.params.weightBlended }];
  },
});
```

### 2.5 Which nodes a build targets

A build targets every node instance of the document whose definition has an
`export` hook and whose `enabled` parameter is true. Nothing else selects
targets: not the viewed node, not the selection, not the node's position. The
build evaluates exactly the nodes upstream of those instances' connected inputs.

- An enabled export node whose `in` input is not connected is the plan error `E_INPUT_MISSING`.
- A build with no item is the plan error `E_NOTHING_TO_EXPORT`. A build never succeeds having written nothing.
- At most one `landscape` item exists (`E_SEVERAL_LANDSCAPES`). `layer` items belong to it; a `layer` item without a `landscape` item is `E_LAYER_WITHOUT_LANDSCAPE`. `texture` and `image` items need no landscape.

### 2.6 File names

```ts
// src/export/plan.ts
/** Removes every character that is not an ASCII letter, then upper-cases the first character. */
declare function lettersOnly(text: string): string;    // 'alps 01 (wet)' -> 'Alpswet'
/** Removes every character that is not an ASCII letter or digit. */
declare function alnumOnly(text: string): string;      // 'Rock_Wet 2' -> 'RockWet2'
```

`Name` is `lettersOnly(landscape.name)`, or `Export` when the build has no
landscape item. All files of a build lie directly in the output folder.

| Written for | Path | Encoding (section 4) |
| --- | --- | --- |
| landscape | `<Name>Height.png` | PNG, 16-bit grey |
| landscape | `<Name>Height.r16` | raw `uint16` |
| each layer, the base layer included | `Layer<lettersOnly(layer)>.png` | PNG, 8-bit grey |
| each layer, the base layer included | `Layer<lettersOnly(layer)>.r8` | raw `uint8` |
| texture | `T_<alnumOnly(name)>_<size>.png` | PNG: 8-bit RGB (colour, normal), 8- or 16-bit grey (mask) |
| image | `<alnumOnly(name)>.<ext>` | `ext` is `png`, `r16`, `r32`, `exr` or `tif` |
| every successful build | `<Name>.orogen.json` | the manifest (section 6) |
| every build that started | `<Name>.report.json` | the report (3.10) |

1. The files Unreal's landscape importer reads (heightmap and layer PNG) have names made of letters only plus the extension: no digits, spaces, underscores or resolution suffix. This is a precaution against the file-name reports of 7.4; its mechanism is `[U]`. A layer's file name therefore drops the digits and underscores of its layer name.
2. Two planned files whose paths are equal ignoring case are the plan error `E_FILE_COLLISION`, reported before anything is evaluated or written. The message names both nodes. Layers named `Rock1` and `Rock2` collide (`LayerRock`); name them `RockA` and `RockB`.
3. An empty or over-long sanitised name is `E_NAME_INVALID`.
4. The manifest is the only authority on which file is which. Nothing is ever assigned by directory order or by file-name pattern.

---

## 3. The build pipeline

### 3.1 Entry points

```ts
// src/export/plan.ts
declare function planBuild(doc: GraphDoc, registry: NodeRegistry, opts?: { resolution?: number }): BuildPlan;
declare function checkExportNode(def: NodeDef): string[];

// src/export/build.ts
declare function buildProject(engine: Engine, opts: BuildOptions): Promise<BuildResult>;

// src/export/folder.ts
declare function buildToFolder(engine: Engine, opts: FolderBuildOptions): Promise<BuildResult>;
```

| Function | Does | Called by |
| --- | --- | --- |
| `planBuild` | Collects and validates the export items and derives every file. Pure, synchronous, no GPU, no I/O | `buildProject`; the command line; tests |
| `buildProject` | Runs a plan: evaluates through the engine, converts on the CPU, writes through a `FileSink` | a caller that has a sink: `buildToFolder`, tests with a memory sink |
| `buildToFolder` | Stages a build beside an output folder and swaps it in on success (3.8) | a caller that has a folder path: the command line, and the engine worker on behalf of the session (`runtime.md` 7.1, 7.6) |

`buildProject` plans with `engine.registry`, the registry the engine was
created with (`runtime.md` 5.1). The interface does not call `planBuild`: it
may not import `src/export/` and receives the plan in the `build-plan` event
(3.9).

```ts
// src/export/build.ts
interface BuildOptions {
  readonly doc: GraphDoc;
  readonly sink: FileSink;
  readonly requestId: number;                    // for Engine.evaluate; echoed in every BuildEvent
  readonly resolution?: number;                  // default: doc.settings.buildResolution
  readonly signal?: AbortSignal;
  readonly onEvent?: (e: EvalEvent | BuildEvent) => void;
}

// src/export/folder.ts
interface FolderBuildOptions extends Omit<BuildOptions, 'sink'> {
  readonly outDir: string;                       // absolute path of the output folder
  readonly createSink: (absDir: string) => FileSink;
}

// src/core/export-decl.ts
interface BuildResult {
  readonly requestId: number;
  readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  readonly problems: readonly BuildProblem[];    // errors and warnings, plan problems first
  readonly files: readonly { readonly path: string; readonly bytes: number }[];   // every file made visible except the report, in the order of plan.files, the manifest last; empty unless ok
  readonly manifest: string | null;              // path of the manifest in the sink; null unless ok
  readonly report: string | null;                // path of the report in the sink; null when the plan had an error
  readonly outDir: string | null;                // buildToFolder only: the folder that holds the files
}
```

| `status` | Meaning | Files that became visible |
| --- | --- | --- |
| `'ok'` | Every planned file and the manifest are written | all, and the report |
| `'errors'` | The plan has an error (nothing was evaluated), or a node failed, a field held a non-finite value, or a write failed. `problems` says which | the report, unless the plan had the error |
| `'aborted'` | The signal aborted | the report |
| `'device-lost'` | The GPU device was lost. The build is not resumed | the report |

`buildProject` never rejects for these outcomes; it rejects only for a
malformed call. The four literals are those of `EvaluateResult.status`
(`runtime.md` 5.2). One build runs at a time per engine.

### 3.2 How the pipeline uses the engine

The pipeline evaluates nothing itself, runs no kernel and allocates no GPU
memory. It makes one call to `Engine.evaluate` with staged delivery and reads
the delivered fields in bands (`runtime.md` 5.1, 5.2, 5.7):

```ts
engine.evaluate(opts.doc, targets, {
  resolution,                    // opts.resolution ?? opts.doc.settings.buildResolution
  mode: 'build',
  requestId: opts.requestId,
  signal,                        // the pipeline's own controller, which follows opts.signal
  onEvent,                       // forwards every EvalEvent to opts.onEvent
  onTarget,                      // one stage per target (3.4)
});
```

1. **Targets.** For plan target `{ node, input }` the pipeline takes the edge the evaluator uses for that input (`runtime.md` 4.3 rule 5: the first edge of `doc.edges`, in record order, whose `to` is `{ node, port: input }` and whose `from` names an output of an existing node of a known type; `edgeInto` of `src/export/plan.ts`) and passes `{ ref: edge.from, as: T }`, where `T` is the type of the input port, `'field'` or `'color'`. Targets are in plan order. An input without such an edge is unconnected for the plan as it is for the evaluator, so no target names a node or an output the document lacks.
2. **Delivery.** `onTarget(i, handle)` is the stage of target `i`. The evaluator delivers targets one at a time, runs no node while the stage is pending, and releases the handle when the stage's promise settles. Each target is therefore evaluated, measured, read, converted and encoded, and its handle released, before the next node runs; its texture is freed as soon as no later node reads it (`runtime.md` 2.8).
3. **Access.** A stage uses `engine.stats(handle)` and `engine.read(handle, [y0, y1])` only. It never touches `handle.texture`, never retains the handle and never uses it after its promise has settled.
4. **First error stops the build.** The pipeline's controller aborts when `opts.signal` aborts and when the first `node-error` event arrives. A stage that fails rejects its promise, which stops the evaluation (`runtime.md` 5.2).
5. **Outcome.** After `evaluate` has settled or rejected: a lost device gives `'device-lost'`; an abort through `opts.signal` gives `'aborted'`; a `node-error` gives `'errors'` with one `E_NODE_FAILED` per `NodeError`; a failed stage, whose rejection `evaluate` passes on, gives `'errors'` with its problem. Otherwise phase 3 follows (3.4).

Node progress, timings and errors of the evaluation reach the listener as
`EvalEvent`s. The pipeline adds its own events (3.9) and repeats none.

### 3.3 The plan

```ts
// src/core/export-decl.ts
type FileEncoding =
  | 'png-gray8' | 'png-gray16' | 'png-rgb8'
  | 'raw-u8' | 'raw-u16' | 'raw-f32'
  | 'exr-f32' | 'tiff-u16' | 'tiff-f32' | 'json';

interface PlannedFile {
  readonly path: string;
  readonly encoding: FileEncoding;
  readonly width: number;                        // 0 for JSON
  readonly height: number;
  readonly bytes: number | null;                 // exact size when it is known in advance (4.4 to 4.6); null for PNG and JSON
  readonly nodeId: string | null;                // the export node; null for the base layer and the manifest
}

interface PlannedLayer {
  readonly name: string;
  readonly blend: 'none' | 'final' | 'advanced';
  readonly base: boolean;
  readonly nodeId: string | null;
}

type BuildProblemCode =
  | 'E_NOTHING_TO_EXPORT' | 'E_INPUT_MISSING' | 'E_HOOK_FAILED' | 'E_RESOLUTION' | 'E_SIZE_NOT_LANDSCAPE'
  | 'E_SEVERAL_LANDSCAPES' | 'E_LAYER_WITHOUT_LANDSCAPE' | 'E_NAME_INVALID' | 'E_LAYER_NAME_INVALID'
  | 'E_LAYER_NAME_DUPLICATE' | 'E_TOO_MANY_LAYERS' | 'E_RANGE_INVALID' | 'E_FORMAT_INVALID' | 'E_FILE_COLLISION'
  | 'W_MANY_LAYERS' | 'W_GRID_SIZE' | 'W_REGION_SIZE'
  | 'E_NODE_FAILED' | 'E_NON_FINITE' | 'E_WRITE_FAILED' | 'E_DEVICE_LOST' | 'E_OUT_DIR' | 'E_COMMIT_FAILED' | 'E_INTERNAL'
  | 'W_HEIGHT_CLIPPED' | 'W_FLAT' | 'W_LAYER_EMPTY';

interface BuildProblem {
  readonly severity: 'error' | 'warning';
  readonly code: BuildProblemCode;
  readonly message: string;                      // one sentence for the user, naming the node by title
  readonly nodeId?: string;
}

interface BuildPlan {
  readonly ok: boolean;                          // no problem of severity 'error'
  readonly resolution: number;
  readonly name: string;                         // <Name> of 2.6
  readonly items: readonly { readonly nodeId: string; readonly item: ExportItem }[];   // in processing order
  readonly targets: readonly ExportSource[];     // items[i].item.source, same order
  readonly layout: LandscapeLayout | null;       // 5.2; null without a landscape item
  readonly layers: readonly PlannedLayer[];      // base first; empty without layer items
  readonly files: readonly PlannedFile[];        // every file of a complete build, report excluded, manifest last
  readonly problems: readonly BuildProblem[];
  readonly estimate: {
    readonly planeBytes: number;                 // CPU memory held for weight-blended layers (3.7)
    readonly knownFileBytes: number;             // sum of the non-null PlannedFile.bytes
  };
}
```

A plan is plain data. `planBuild` proceeds in this order and collects every
problem it finds; it does not stop at the first:

1. The resolution is `opts.resolution`, else `doc.settings.buildResolution`. A value that is not a build resolution (`engine.md` 1.5) is `E_RESOLUTION`.
2. Node instances whose type the registry knows and whose definition has `export` are visited in ascending order of node id. Parameters are normalised with `normalizeParams` (`runtime.md` 4.4); an `error` from it is `E_HOOK_FAILED` with that message. An instance whose `enabled` is false is skipped. A definition that breaks a rule of 2.3 (`checkExportNode`) is `E_HOOK_FAILED` with the first rule it breaks. An `in` input without an edge the evaluator uses (3.2) is `E_INPUT_MISSING`. Otherwise the hook is called. The instance's `bypass` flag is ignored.
3. Each item is checked against 2.2 and the cross-item rules of 2.5.
4. Items are put in processing order: the landscape item; weight-blended layer items by `layer.toLowerCase()` ascending in UTF-16 code unit order; other layer items likewise; texture items by file name; image items by file name.
5. Files are derived (2.6) and checked for collisions. `files` lists the heightmap PNG and `.r16`; then, for each layer in the order of step 6, its PNG and its `.r8`; then the textures; then the images; then the manifest.
6. `layers` is the base layer (when there is at least one weight-blended layer item), then the weight-blended layers, then the others, each group in the order of step 4.

Plan problems:

| Code | Severity | Condition |
| --- | --- | --- |
| `E_NOTHING_TO_EXPORT` | error | no item, whatever else the plan reports |
| `E_INPUT_MISSING` | error | an enabled export node has no connection on `in` |
| `E_HOOK_FAILED` | error | 2.1 rule 5; step 2 |
| `E_RESOLUTION` | error | step 1 |
| `E_SIZE_NOT_LANDSCAPE` | error | a landscape item exists and `landscapeLayout(resolution)` is null (5.2). The message lists the nearest valid sizes below and above |
| `E_SEVERAL_LANDSCAPES`, `E_LAYER_WITHOUT_LANDSCAPE` | error | 2.5 |
| `E_NAME_INVALID` | error | 2.6 rule 3 |
| `E_LAYER_NAME_INVALID` | error | a `layer` or `baseLayer` breaks the pattern of 2.2 |
| `E_LAYER_NAME_DUPLICATE` | error | two layer names are equal ignoring case; `baseLayer` takes part when the build has a weight-blended layer item |
| `E_TOO_MANY_LAYERS` | error | more than 15 weight-blended layer items |
| `E_RANGE_INVALID` | error | a `HeightRange` breaks 2.2 |
| `E_FORMAT_INVALID` | error | any other member of an item breaks its rule in 2.2 |
| `E_FILE_COLLISION` | error | 2.6 rule 2, once for every path that is taken: two layers of one file name collide in their PNG and in their raw file. The name of the report counts as taken |
| `W_MANY_LAYERS` | warning | more than 12 layers in all, the base layer included (5.8) |
| `W_GRID_SIZE` | warning | `layout.components` is not a multiple of `gridSize` |
| `W_REGION_SIZE` | warning | `regionSize` is 4 (7.4) |

### 3.4 Phases and stages

`buildProject` runs these phases. A phase begins only when the previous one
has ended without error.

| Phase | Work |
| --- | --- |
| 1. Plan | `planBuild`. With an error: status `'errors'`, nothing evaluated, no file |
| 2. Targets | `engine.evaluate` (3.2). One stage per target, in the order the evaluator delivers them: each as soon as the node that makes it has run (`runtime.md` 5.2). Where one node feeds several items their stages follow each other, whatever lies between them in the plan; nothing in the pipeline depends on the order |
| 3. Weights | Only with weight-blended layer items: the joint quantisation of 5.8, from the planes kept in phase 2 |
| 4. Commit | Every open `FileWriter` is closed, in the order of `plan.files`; then the manifest is written with `sink.write` |
| 5. Report | The report is written with `sink.write`, whatever the status, unless the plan had an error |

A stage, the body of one `onTarget` call:

| Item | Stage |
| --- | --- |
| landscape | `stats = await engine.stats(handle)`. `stats.nonFinite > 0` is `E_NON_FINITE`. Compute the mapping (5.4). Create `<Name>Height.png` and `<Name>Height.r16`. For each band: `engine.read`, `quantiseHeights`, write the same codes to both encoders. End the encoders |
| layer, weight-blended | For each band: `engine.read`, convert to 16-bit codes `floor(saturate(v) · 65535 + 0.5)` and store them in the layer's plane, a `Uint16Array(res · res)` kept until phase 3. No file is created in this stage |
| layer, not weight-blended | Create `Layer<X>.png` and `Layer<X>.r8`. For each band: `engine.read`, convert to `floor(saturate(v) · 255 + 0.5)`, write to both encoders. End the encoders |
| texture | Create the PNG. For each band: `engine.read`; for content `'normal'` compute the band's vertex normals; push the rows through the texel-grid resampler; convert the output rows it returns; write (5.9). End the encoder |
| image | With an integer format and `map: 'measured'`: `engine.stats`. Create the file. For each band: `engine.read`, convert (4.6), write. End the encoder |

Phase 3 creates `Layer<X>.png` and `Layer<X>.r8` for the base layer and for
every weight-blended layer, calls `quantiseWeights` (5.8) for `bandRows(res, 1)`
rows at a time, writes each layer's bytes to its two encoders, ends the
encoders and drops the planes.

Rules for every stage and for phase 3:

- `onTarget` delivers an `AnyFieldHandle` (`runtime.md` 2.2). A stage whose item needs a `field` (landscape, layer, image, and a texture of content `'mask'` or `'normal'`) begins with `if (handle.kind !== 'field') throw …`, and a colour texture's stage with the opposite test. The throw is `E_INTERNAL`: the target was requested with the kind of the input port (3.2), so it cannot happen in a correct build. After the test `engine.stats(handle)` type-checks.
- A non-finite sample found while converting is `E_NON_FINITE` for that node.
- A file is created only when its first band is ready to be written.
- **No writer is closed before phase 4.** Until then every data file exists only under its temporary name (`runtime.md` 6.2). On any status other than `'ok'` the pipeline calls `sink.abortAll()`, so a build that did not succeed changes no file under a final name; only the report is then written.
- The pipeline counts the bytes it hands to each `FileWriter`; `close()` must report the same number, or the build fails with `E_WRITE_FAILED`. Those counts are the `bytes` of the manifest and the report.
- Each layer's mean weight is accumulated while converting.

### 3.5 Bands

All readback is `engine.read(handle, [y0, y1])` in bands:

```ts
// src/export/build.ts
/** Rows per band for a field of the given width and channel count (1 or 4). */
function bandRows(width: number, channels: number): number {
  const rows = Math.floor((32 * 1024 * 1024) / (width * channels * 4) / 16) * 16;
  return Math.max(16, Math.min(512, rows));
}
```

A band is at most 32 MiB of `float32` and at most 512 rows: 512 rows
(16.6 MB) for an 8129-wide `field`, 256 rows (33.3 MB) for an 8129-wide
`color`. The band size is a starting point to calibrate.

- Bands are read and written top row first, strictly in order.
- The pipeline awaits each encoder's `write` before reading the next band, so memory does not grow when the disk is slow.
- The pipeline keeps no band after its `write` calls have resolved, and never calls `engine.read` without `rows` on a build-resolution field.
- Conversion runs synchronously on the engine thread, one band at a time. The pipeline checks the signal before every band.

### 3.6 Measured costs

Measured on the development machine (Node 26, CPU only, one synthetic 8129²
field): removing row padding from a readback 201 ms, `float32` to 16-bit
270 ms, PNG Up filter 287 ms, deflate 2.6 to 2.9 s. Reading 264 MB back from
the GPU takes about 0.3 s. Unfiltered 16-bit scanlines barely compress
(8.06 MB of 8.4 MB at 2049²), which is why the filter of 4.3 is not optional.
The time and size of a build at the settings of 4.3 on real terrain, and the
cost of the texel-grid resampler and of phase 3, are to calibrate.

### 3.7 Memory bounds at 8129 × 8129

One 8129² `field` is 264.3 MB on the GPU, one `color` 528.6 MB. The evaluator
holds the target while its stage runs (`runtime.md` 2.8); readback goes through
the engine's one staging buffer of at most 64 MiB (`runtime.md` 5.7). **The
pipeline itself allocates no GPU memory.** On the CPU a stage holds:

| Stage | CPU held by the pipeline |
| --- | --- |
| landscape | one band: 16.6 MB `float32`, 8.3 MB codes, 8.3 MB of PNG scanlines |
| layer, weight-blended | one band, and the plane: 132.2 MB, kept until phase 3 |
| layer, not weight-blended | one band, 4.2 MB of bytes |
| texture, colour, size 8192 | one band (33.3 MB); the resampler's window (below); the output rows of one band as bytes (6.3 MB) |
| texture, normal, size 8192 | one band of heights (16.6 MB); its normals, 3 floats per vertex (49.9 MB); the resampler's window; the output rows as bytes |
| image | one band and its converted samples |
| phase 3, `L` weight-blended layer items | `L` planes of 132.2 MB and `L + 1` bands of bytes (4.2 MB each) |

The resampler's window is at most `2ρ + 2` rows of `S × channels` `float64`
values, with `ρ` of 5.9: 0.8 MB for a colour texture of side 8192 from 8129,
and less for a smaller side.

Bounds, which the implementation must keep:

1. GPU: nothing beyond the target the evaluator holds and the engine's staging buffer. The GPU memory of a build does not grow with the number of layers, because weight-blended layers are held as CPU planes, not as fields.
2. CPU: `132.2 MB × L` for the planes, plus working buffers that do not grow with the image: one input band, what the table derives from it, and the encoders' bounded stream buffers. The planes take 0.93 GB for 7 weight-blended layer items and 1.98 GB at the limit of 15. The plan reports them as `estimate.planeBytes`.
3. No stage holds a whole build-resolution image on the CPU in any form other than a weight-blended layer's plane, of which there is exactly one copy.

### 3.8 What a build leaves on disk

**Through a sink (`buildProject`).** The data files of a build become visible
together, in phase 4, and only when everything succeeded; the manifest follows
them. A failed, aborted or interrupted build leaves the folder's earlier
contents under their final names untouched, apart from the report.

- Phase 4 is a sequence of renames and one small write. An error in it (on Windows, typically a file open in another program) is `E_COMMIT_FAILED`; the pipeline aborts the writers still open and does not write the manifest. Files already renamed stay. A manifest from an earlier build may then describe files that were replaced: the message tells the user to build again.
- A sink cannot delete. Files of an earlier build that the new build does not write stay in the folder. The manifest lists what belongs to the build.
- A build is deterministic: two builds of the same document, at the same resolution, on the same device and with the same version of Orogen write byte-identical data files and manifests. The report differs.

**Into a folder (`buildToFolder`).** `buildToFolder` adds what a sink cannot
give: a folder that holds exactly one build.

```
staging  = outDir + '.partial'
previous = outDir + '.previous'
```

1. `outDir` is acceptable when it does not exist, is empty, or holds a previous build and nothing else: a file `*.orogen.json` whose `schema` begins with `orogen.unreal.landscape/`, the files that manifest lists under `files`, and reports (`*.report.json` whose `schema` begins with `orogen.build-report/`). `Thumbs.db`, `desktop.ini` and `.DS_Store` do not count. Anything else is `E_OUT_DIR` with status `'errors'`, and the message names the first entry that is not the build's: Orogen replaces a folder only when it is a previous Orogen build, and a build folder into which somebody has put a file of their own (the project file, for one) is refused, not emptied. A path that is a file, the root of a drive, or a folder that cannot be read is `E_OUT_DIR` as well, and so is a staging folder that cannot be made. Nothing is planned then: the listener receives the problem and the result.
2. A leftover `staging` or `previous` folder is deleted when it is Orogen's, and is `E_OUT_DIR` otherwise: nothing is deleted because of its name alone. `previous` is Orogen's by the test of step 1. `staging` is Orogen's by that test (a complete build whose swap failed), when it holds reports and nothing else (a build that did not succeed), or when it holds the marker file `.orogen-staging` (a build that was interrupted). `staging` is then created empty but for that marker, which `buildToFolder` writes before the build and deletes when `buildProject` has returned. A folder of Orogen's is deleted with its manifest last, so that an interrupted deletion leaves a folder the next build still knows.
3. `buildProject` runs with `sink = createSink(staging)`. When the plan has an error, `staging` is deleted.
4. Status `'ok'`: `outDir` is tested once more as in step 1, and what it holds by now that is not the build's is a failed rename of step 5 (a file saved into it while the build ran is not deleted). Then `outDir`, when it exists, is renamed to `previous`; `staging` is renamed to `outDir`; `previous` is deleted with everything in it. `result.outDir` is `outDir`.
5. A rename that fails in step 4 is `E_COMMIT_FAILED` with status `'errors'`. The complete build stays in `staging`, `result.outDir` is `staging`, and the message says so; when `outDir` had already been renamed to `previous` it is renamed back. A `previous` that cannot be deleted after the swap leaves the build in place with status `'ok'` and a problem of severity `'warning'` with the code `E_COMMIT_FAILED`.
6. Any other status: `staging` holds the report and nothing else. `result.outDir` is `staging`. The next build removes it.

Consequences of `buildToFolder`:

- The output folder holds one complete build with its manifest, or is untouched. A file left over from an earlier build with other layer names cannot survive.
- A folder that the user shares with their own files is refused, not cleaned, also when it holds a build. The user documentation says that the output folder belongs to Orogen.
- While a build runs, the disk holds the previous build and the new one.

### 3.9 Progress, cancellation and failure

```ts
// src/core/export-decl.ts
type BuildEvent =
  | { readonly type: 'build-plan'; readonly requestId: number; readonly plan: BuildPlan }
  | { readonly type: 'build-target'; readonly requestId: number; readonly index: number; readonly count: number;
      readonly nodeId: string; readonly label: string }
  | { readonly type: 'build-progress'; readonly requestId: number;
      readonly phase: 'targets' | 'weights' | 'commit'; readonly fraction: number }
  | { readonly type: 'build-problem'; readonly requestId: number; readonly problem: BuildProblem }
  | { readonly type: 'build-result'; readonly requestId: number; readonly result: BuildResult };
```

| Event | When |
| --- | --- |
| `'build-plan'` | Once, first. When the plan has an error it is followed by `'build-result'` only |
| `'build-target'` | The stage of target `index` begins. `label` is the export node's title and the first file of the item |
| `'build-progress'` | `fraction` is the export work done: rows converted so far divided by all rows the build converts (the output rows of every target, plus `resolution` rows for phase 3). Non-decreasing, at most 10 events per second, 1 when phase 4 begins |
| `'build-problem'` | A problem found after the plan |
| `'build-result'` | Once, last. From `buildToFolder` it carries the folder's result, with `outDir`; the pipeline's own is not emitted beside it |

Every event is plain data and can be structured-cloned. `'build-progress'`
measures the export work only; how far the evaluation has come is in the
`eval-progress` and node events of the same request (`runtime.md` 5.10). The
type names do not collide with those of `EngineEvent` (`runtime.md` 7.7).

**Cancellation.** When `opts.signal` aborts, the evaluation stops, a running
stage throws the abort reason at its next band, phase 3 stops at its next band,
`sink.abortAll()` is called, the planes are dropped, the report is written and
the status is `'aborted'`. The latency is one band of conversion or the
evaluator's own (`runtime.md` 3.7), whichever is running.

**Failure.** The build stops at the first error; it does not go on to find
others. Problems found after the plan:

| Code | Severity | Condition | Status |
| --- | --- | --- | --- |
| `E_NODE_FAILED` | error | a `node-error` event; message and node id from the `NodeError` | `'errors'` |
| `E_NON_FINITE` | error | a target holds NaN or infinity | `'errors'` |
| `E_WRITE_FAILED` | error | a `FileSink`, `FileWriter` or encoder call rejected; the message carries the cause and the path | `'errors'` |
| `E_DEVICE_LOST` | error | the evaluation ended with `'device-lost'` | `'device-lost'` |
| `E_OUT_DIR`, `E_COMMIT_FAILED` | error | 3.8 | `'errors'` |
| `E_INTERNAL` | error | any other exception; the message is the exception's | `'errors'` |
| `W_HEIGHT_CLIPPED` | warning | fixed range: samples lie outside it; the message gives the count | |
| `W_FLAT` | warning | the mapped range was under 1 m and was widened (5.4) | |
| `W_LAYER_EMPTY` | warning | a layer other than the base is 0 everywhere | |

### 3.10 The report

`<Name>.report.json` is written for every build that got past the plan, also
when it failed or was aborted. It is UTF-8 JSON, two-space indented, with a
final newline.

```ts
// src/export/manifest.ts
interface BuildReport {
  schema: 'orogen.build-report/1';
  status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  generator: { name: 'Orogen'; version: string };
  startedUtc: string;                            // ISO 8601
  endedUtc: string;
  durationMs: number;
  resolution: number;
  problems: BuildProblem[];
  targets: {
    nodeId: string;
    nodeType: string;
    title: string;
    kind: 'landscape' | 'layer' | 'texture' | 'image';
    evaluateMs: number | null;                   // from the end of the previous stage to this target's delivery; null when not reached
    exportMs: number | null;                     // duration of its stage
    min: number | null;                          // measured field values, where the stage measured them
    max: number | null;
  }[];
  weightsMs: number | null;                      // duration of phase 3
  height: null | {
    measuredMin: number; measuredMax: number;    // normalised heights
    valueMin: number; valueMax: number;          // normalised heights mapped to codes 0 and 65535
    clippedSamples: number;
  };
  layers: { name: string; base: boolean; blend: 'none' | 'final' | 'advanced'; meanWeight: number }[];
  files: { path: string; bytes: number }[];      // files made visible, in the order of plan.files
}
```

`meanWeight` is the mean of the layer's bytes divided by 255. Per-node timings
are not in the report; they are in the `node-done` events (`runtime.md` 5.10).
`layers` lists the layers whose bytes were written: all of them in a build that
succeeded.

A report that cannot be written does not change what a build is: its status
stays, `result.report` is `null`, and a problem of severity `'warning'` with the
code `E_WRITE_FAILED` names the report.

### 3.11 The command line

`src/export/cli.ts` implements the `build` and `unreal-test` subcommands of
`orogen`, the product's one command-line program, whose entry point is
`src/cli/main.ts` (`testing.md` 8.6). `orogen` below stands for
`node src/cli/main.ts`.

```
orogen build <project.orogen> --out <dir> [--res <n>] [--seed <n>] [--budget-mb <n>]
             [--profile <core|max>] [--adapter <substring>] [--json] [--quiet]
orogen unreal-test --out <dir> [--res <n>]
orogen unreal-test --check <file> [--res <n>]
```

| Argument | Meaning |
| --- | --- |
| `<project.orogen>` | The project file. Required |
| `--out <dir>` | The output folder (3.8). Required. A relative path is resolved against the working directory |
| `--res <n>` | Overrides the project's build resolution |
| `--seed <n>` | Overrides the project seed, an integer 0 .. 2^32 − 1 |
| `--budget-mb <n>` | The pool budget in MiB: `budgetBytes = n × 2^20`. Default: the formula of `runtime.md` 2.4 with default preferences, which in Node gives 2.4 GiB whatever the card. A build at 8129 whose graph holds `simulate/hydraulic-erosion` or `simulate/rivers` needs more for that node's state alone (`simulation.md` 1.5) |
| `--profile <core\|max>`, `--adapter <substring>` | The device profile and adapter, with the meanings and defaults `testing.md` 8.6 gives them for every subcommand |
| `--json` | Writes every `EvalEvent` and `BuildEvent` as one JSON object per line on standard output, and nothing else there |
| `--quiet` | Suppresses progress on standard error. Problems are still printed |

`build` reads the project with `parseDoc`, opens a device and creates an engine
as `runtime.md` prescribes for headless use (`createNodeGpu`,
`createRegistry(nodes)`, `NodeFileSource`, `createNodeCpuRunner`, the budget
above), calls `buildToFolder` with `NodeFileSink` as `createSink`, disposes the
engine and exits. Without `--json` it prints progress lines and problems on standard error
and, on success, the path of the manifest on standard output. Problems that
`parseDoc` reports are printed as warnings.

| Exit code | Meaning |
| --- | --- |
| 0 | Status `'ok'`. The output folder holds the build |
| 1 | Status `'errors'`. Problems are printed; the report, when there is one, is in `<dir>.partial` |
| 2 | Usage error: unknown or missing argument, unreadable project file, `DocFormatError`. Nothing was planned or written |
| 3 | No usable GPU device (`GpuUnavailableError`), or status `'device-lost'` |
| 130 | Cancelled by SIGINT or SIGTERM: status `'aborted'`. A second signal exits at once with the same code |

The exit code is 0 only when a manifest was written. Without `--json` and
`--quiet` the last progress line of a build that succeeded states its duration,
the number and size of its files, the most the pool's ledger held and the peak
resident memory of the process. The `unreal-test` forms are defined in section
9; they need no GPU and exit with 0, 1 (the check found a difference, the file
is no heightmap of the pattern's size, or the output folder was refused) or 2.

---

## 4. Encoders and decoders

### 4.1 Encoder interface

```ts
// src/export/encode/*.ts
interface RowEncoder<S extends Uint8Array | Uint16Array | Float32Array> {
  readonly rowsWritten: number;
  /** Appends whole rows, top row first: rows.length is a multiple of width x channels. */
  write(rows: S): Promise<void>;
  /** Writes whatever ends the format. Does not close the FileWriter. */
  end(): Promise<void>;
}

declare function createPngEncoder(out: FileWriter, o: { width: number; height: number; channels: 1 | 3; bits: 8 | 16 }): RowEncoder<Uint8Array | Uint16Array>;
declare function createRawEncoder(out: FileWriter, o: { width: number; height: number; sample: 'u8' | 'u16' | 'f32' }): RowEncoder<Uint8Array | Uint16Array | Float32Array>;
declare function createExrEncoder(out: FileWriter, o: { width: number; height: number }): RowEncoder<Float32Array>;
declare function createTiffEncoder(out: FileWriter, o: { width: number; height: number; sample: 'u16' | 'f32' }): RowEncoder<Uint16Array | Float32Array>;
```

1. An encoder is streaming and append-only. It never seeks, never holds more than the rows of one `write` call plus bounded stream buffers, and never reads the file back.
2. `write` resolves when the rows have been consumed: the caller may then reuse the array. It applies back-pressure: it awaits each `FileWriter.write` before the next and does not resolve while the compressor is saturated.
3. `write` throws `RangeError` when `rows.length` is not a whole number of rows, when the sample array type does not match (`Uint8Array` for 8 bits, `Uint16Array` for 16, `Float32Array` for float), or when more than `height` rows are written. `end` rejects when fewer than `height` rows were written.
4. An encoder passes the `FileWriter` chunks of at most 16 MiB.
5. The encoder does not create, close or abort the `FileWriter`. The pipeline does (3.4).
6. Multi-byte values are written in the byte order the format demands whatever the host's byte order.
7. Sample arrays are row-major, top row first, channels interleaved.

Every format whose header must state where the pixel data lies is written
uncompressed, so that every offset is known before the first row arrives. PNG
is the compressed format.

### 4.2 Sample layouts

| Encoding | Samples | File size for `w × h` |
| --- | --- | --- |
| `png-gray8`, `png-gray16`, `png-rgb8` | 1 or 3 channels, 8 or 16 bits | depends on the content |
| `raw-u8` (`.r8`) | 1 byte | `w · h` |
| `raw-u16` (`.r16`) | 2 bytes, little-endian | `2 · w · h` |
| `raw-f32` (`.r32`) | 4 bytes, IEEE 754 little-endian | `4 · w · h` |
| `exr-f32` (`.exr`) | 4 bytes, IEEE 754 little-endian | `277 + h · (16 + 4 · w)` |
| `tiff-u16`, `tiff-f32` (`.tif`) | 2 or 4 bytes, little-endian | `D + b · w · h`, 4.6 |

At 8129 × 8129: `.r8` 66,080,641 bytes; `.r16` 132,161,282; `.r32`
264,322,564; `.exr` 264,452,905; 16-bit `.tif` 132,162,452; float `.tif`
264,323,734.

### 4.3 PNG

All integers are big-endian.

```
file      89 50 4E 47 0D 0A 1A 0A          signature
          IHDR chunk
          IDAT chunk, one or more
          IEND chunk                        00 00 00 00 49 45 4E 44 AE 42 60 82
chunk     uint32 length of data
          4 bytes type, ASCII
          data
          uint32 CRC-32 of type and data
IHDR      uint32 width
          uint32 height
          uint8  bit depth                  8 or 16
          uint8  colour type                0 grey, 2 RGB
          uint8  compression                0
          uint8  filter method              0
          uint8  interlace                  0
```

- The IDAT data, concatenated over all IDAT chunks, is one zlib stream of the scanlines. A scanline is one filter-type byte followed by the row's samples; 16-bit samples have the high byte first. The uncompressed length is `h · (1 + w · channels · bits / 8)`: 132,169,411 bytes for a 16-bit grey 8129².
- **Filter.** Every scanline uses filter type 2 (Up): each byte is stored as `(byte − byteAbove) mod 256`, where `byteAbove` is the byte at the same position of the previous row, and 0 for the first row. The encoder keeps the last row of each `write` for the next.
- **Compression.** `zlib.createDeflate({ level: 3, chunkSize: 1 << 20 })`, other options at their defaults. Scanlines of one `write` are filtered into one buffer and written to the deflate stream; `write` waits for `'drain'` when the stream reports back-pressure.
- **Chunking.** The zlib stream is cut into IDAT chunks of exactly 1,048,576 bytes; the last chunk holds the rest. The cut does not depend on how the deflate stream happens to deliver its output, so the same image always gives the same file.
- CRCs are computed with `zlib.crc32`.
- No ancillary chunk is written: no `gAMA`, `sRGB`, `iCCP`, `tEXt` or `tIME`. Whether a PNG holds data or sRGB colour is stated in the manifest, not in the file.
- No alpha channel and no palette are ever written.

The choice of filter (Up against Sub and Paeth) and of level 3 are to calibrate
on an eroded 8129² terrain for time and size. They are fixed in this contract
until then; changing them changes no reader.

### 4.4 Raw

`.r8`, `.r16` and `.r32` have no header. Samples are row-major, row 0 first,
which is the top row of the image. `.r16` and `.r32` are little-endian. A
`.r32` holds the field's values unchanged.

The reader of a raw file must be told its size. Orogen's own decoder accepts a
raw file without stated dimensions only when its sample count is a perfect
square (4.7).

### 4.5 OpenEXR

One part, scan lines, one channel `Y` of type FLOAT, no compression, increasing
Y. All values little-endian, no padding.

```
offset 0     76 2F 31 01                     magic
offset 4     02 00 00 00                     version 2, no flags
offset 8     header: attributes, each
               name, zero-terminated
               type name, zero-terminated
               int32 size of the value
               value
             then one zero byte
offset 277   offset table: h x uint64, absolute file offset of each chunk
then         h chunks, chunk y:
               int32 y
               int32 4 * w                   size of the pixel data
               w x float32                   row y
```

The attributes, in this order:

| Name | Type name | Size | Value |
| --- | --- | --- | --- |
| `channels` | `chlist` | 19 | `59 00` (the name `Y`), int32 2 (FLOAT), uint8 0 (pLinear), 3 zero bytes, int32 1 (xSampling), int32 1 (ySampling), then one zero byte ending the list |
| `compression` | `compression` | 1 | uint8 0 |
| `dataWindow` | `box2i` | 16 | int32 0, 0, `w − 1`, `h − 1` |
| `displayWindow` | `box2i` | 16 | int32 0, 0, `w − 1`, `h − 1` |
| `lineOrder` | `lineOrder` | 1 | uint8 0 (increasing Y) |
| `pixelAspectRatio` | `float` | 4 | 1.0 |
| `screenWindowCenter` | `v2f` | 8 | 0.0, 0.0 |
| `screenWindowWidth` | `float` | 4 | 1.0 |

With these attributes the header ends at offset 277 whatever the image size.
Without compression every chunk is one scan line, so chunk `y` begins at
`277 + 8 · h + y · (8 + 4 · w)` and the encoder writes the whole offset table
before the first row.

No compression is the choice because the offset table precedes the pixel
data and a `FileWriter` only appends: with ZIP the chunk sizes are not known in
advance. Compression code 0 is a standard mode of the format. A file this
encoder wrote (4033 × 4033) has been read with the OpenEXR reference library
(libOpenEXR 3.1): its C core returns every scan line as it was written, and
its `RgbaInputFile`, which checks the header, the samples as halves. The
encoder's test file records the check and how to repeat it (10.2).

### 4.6 TIFF, and image formats by item

Baseline TIFF, little-endian, one image, one sample per pixel, uncompressed, in
strips of 64 rows. `b` is 2 (16-bit) or 4 (float); `n = ceil(h / 64)` strips.

```
offset 0     49 49 2A 00                     little-endian TIFF
offset 4     uint32 8                        offset of the IFD
offset 8     uint16 11                       number of entries
offset 10    11 entries of 12 bytes, ascending tag:
               uint16 tag, uint16 type (3 SHORT, 4 LONG), uint32 count, 4 bytes value or offset
offset 142   uint32 0                        no further IFD
offset 146   n x uint32                      strip offsets      (only when n > 1)
then         n x uint32                      strip byte counts  (only when n > 1)
offset D     the samples, row-major          D = 146 when n = 1, else 146 + 8 * n
```

| Tag | Name | Type | Count | Value |
| --- | --- | --- | --- | --- |
| 256 | ImageWidth | LONG | 1 | `w` |
| 257 | ImageLength | LONG | 1 | `h` |
| 258 | BitsPerSample | SHORT | 1 | 16 or 32 |
| 259 | Compression | SHORT | 1 | 1 (none) |
| 262 | PhotometricInterpretation | SHORT | 1 | 1 (BlackIsZero) |
| 273 | StripOffsets | LONG | `n` | `n = 1`: `D`. Else the offset of the array, 146 |
| 277 | SamplesPerPixel | SHORT | 1 | 1 |
| 278 | RowsPerStrip | LONG | 1 | 64 |
| 279 | StripByteCounts | LONG | `n` | `n = 1`: `b · w · h`. Else the offset of the array, `146 + 4 · n` |
| 284 | PlanarConfiguration | SHORT | 1 | 1 |
| 339 | SampleFormat | SHORT | 1 | 1 (unsigned integer) or 3 (IEEE float) |

A SHORT value occupies the first two bytes of its 4-byte value field; the other
two are zero. Strip `i` begins at `D + i · 64 · b · w` and holds
`min(64, h − 64 · i) · b · w` bytes. At 8129², `n` is 128 and `D` is 1170.

An `image` item is converted and encoded by its format. `t` is the field value
`v` for `map: 'unit'`, and `(v − min) / (max − min)` for `map: 'measured'`
(`min` and `max` from `engine.stats`; `t = 0` when they are equal).

| `format` | Encoding | Sample |
| --- | --- | --- |
| `'png8'` | `png-gray8` | `floor(saturate(t) · 255 + 0.5)` |
| `'png16'` | `png-gray16` | `floor(saturate(t) · 65535 + 0.5)` |
| `'r16'` | `raw-u16` | as `'png16'` |
| `'tiff16'` | `tiff-u16` | as `'png16'` |
| `'r32'` | `raw-f32` | `v` |
| `'exr'` | `exr-f32` | `v` |
| `'tiff32'` | `tiff-f32` | `v` |

Image files are on the vertex grid at build resolution: sample `(x, y)` is
field texel `(x, y)`. For an integer format the manifest records the two field
values that map to the lowest and highest code.

### 4.7 Decoders

Import nodes decode with core CPU tasks (`engine.md` 4.11, 4.12). The decoders
live in `src/core/io/` and use no Node, DOM or Electron API.

```ts
// engine.md 4.12. The task is named 'core/decode-image'; its run returns a promise for every format.
declare const decodeImage: CpuTask<{ bytes: Uint8Array }, Promise<DecodedImage>>;

// src/core/io/raw.ts, re-exported by api.ts. The task is named 'core/decode-raw'.
declare const decodeRaw: CpuTask<
  { bytes: Uint8Array; sample: 'u8' | 'u16' | 'f32'; width?: number; height?: number },
  DecodedImage
>;
```

`decodeImage` recognises the format from the first bytes, never from a file
name:

| Format | First bytes | Decoded with | Accepted |
| --- | --- | --- | --- |
| PNG | `89 50 4E 47 0D 0A 1A 0A` | `fast-png` 8.0.0 | 8 and 16 bits per channel; grey, grey with alpha, RGB, RGBA, palette |
| TIFF | `49 49 2A 00` or `4D 4D 00 2A` | `geotiff` 3.0.5 | the first image of the file; strips or tiles; 8-, 16- and 32-bit integers and 32-bit float; 1, 3 or 4 samples per pixel; uncompressed, PackBits, LZW or Deflate, with or without a predictor (horizontal differencing, floating point) |
| OpenEXR | `76 2F 31 01` | `parse-exr` 1.0.2 | scan-line files with a `Y` channel, or `R`, `G`, `B` and optional `A`; the compressions the library reads |

The decoders' tests (`tests/unit/decoders.test.ts`) pin the accepted sets with
files they generate, among them files in the exact layouts of 4.5 and 4.6. The
tests of the encoders decode what each encoder writes (10.2).

Within the accepted sets a decoder refuses what its library would decode to
wrong values without an error:

| Format | Also rejected |
| --- | --- |
| PNG | grey and RGB of 1, 2 or 4 bits per channel; an interlaced palette image of 1, 2 or 4 bits per pixel. Without interlacing a palette is read at every index depth; a `tRNS` colour key of a grey or RGB image is ignored |
| TIFF | BigTIFF (not recognised); 2 samples per pixel; samples of one pixel that differ in size or type; 16- and 64-bit float; a PhotometricInterpretation other than WhiteIsZero, BlackIsZero and RGB (palette, CMYK, YCbCr, CIELab); a Predictor other than 1, 2 and 3; a big-endian file with Predictor 3, or with Predictor 2 and samples of more than 8 bits. Samples are returned as stored: WhiteIsZero is not inverted |
| OpenEXR | tiled, deep and multi-part files; a file with a UINT channel or a subsampled channel; `Y`, `R`, `G`, `B` and `A` channels that mix HALF and FLOAT; B44 and B44A; decreasing line order together with a compression whose chunks hold several scan lines (ZIP, PIZ, PXR24, DWAA, DWAB); a file whose chunks are not stored in the order its `lineOrder` states. HALF samples are widened to float; other channels of the file are ignored |

All three libraries load and run inside a CPU-task thread without Node APIs.
This is measured in a dedicated Web Worker of Electron 44 without Node
integration, with the worker built for the browser, and in the Node worker
thread. Three rules keep it true:

1. `decodeImage` loads the module of a format (`png.ts`, `tiff.ts`, `exr.ts`), and with it the library, by a dynamic `import()` when the first file of that format arrives; `geotiff` loads its codecs the same way. A thread that only names the task loads no decoder, and the CPU worker of the application is built as an ES module with code splitting.
2. `geotiff` imports the package `web-worker`, whose Node build reads `workerData.mod` when it is loaded in a worker thread and throws a `TypeError` when `workerData` is undefined. The Node runner therefore starts its worker with `workerData: {}` (`runtime.md` 6.3). In a browser build that package is the global `Worker`, and the Node modules `geotiff` names (`fs`, `http`, `https`, `url`) are empty.
3. `geotiff` 3.0.5 reads a strip or tile table that it loads lazily as little-endian, whatever the byte order of the file. `tiff.ts` sets the library's directory parser to eager (`tiff.parser.eager = true`), which reads every table with the directory, in the file's byte order.

Result (`DecodedImage`, `engine.md` 4.12):

| Source | `channels` | `data` |
| --- | --- | --- |
| grey, or grey with alpha | 1 | alpha is dropped |
| RGB, or a palette without transparency | 3 | |
| RGBA, or a palette with transparency | 4 | |
| unsigned integer samples of `k` bits | | `sample / (2^k − 1)` |
| signed integer samples of `k` bits | | `(sample + 2^(k−1)) / (2^k − 1)` |
| float samples | | unchanged; a non-finite sample becomes 0 |

- Rows are top first; nothing is flipped. No gamma or colour-space conversion is applied: an 8-bit colour PNG yields its stored, sRGB-encoded values, and the import node converts.
- `decodeRaw` reads headerless samples: `'u8'` as `sample / 255`, little-endian `'u16'` as `sample / 65535`, little-endian `'f32'` unchanged with non-finite as 0. These are the three files of 4.4. With `width` and `height` the byte length must equal `width · height · bytesPerSample`. Without them the sample count must be a perfect square, which gives the side. One of the two without the other is an error.
- Every decoder rejects, with a one-sentence `Error`, a file it does not recognise, a truncated file, an image with a side above 8192, and an image whose decoded data would exceed 1 GiB. Messages name the cause: `'image is 10812 x 10812; the largest side is 8192'`.

---

## 5. Unreal Engine 5.8 conventions

Orogen targets the heightfield Landscape system. Mesh Terrain, new in 5.8, is
Experimental `[E]` and is not targeted.

The functions of this section are in `src/export/unreal.ts` unless a path is
given. They are pure and are the single implementation of each formula: the
pipeline, the manifest writer and the acceptance pattern call them.

### 5.1 Units and axes

| Fact | Status |
| --- | --- |
| Unreal's frame is left-handed with Z up: +X forward, +Y right, +Z up | `[E]` |
| 1 Unreal unit is 1 cm | `[E]`, from the landscape scale statements of Epic's Technical Guide |
| A landscape's samples are vertices: `N` samples span `N − 1` quads | `[E]` |
| A landscape costs about 4 bytes per vertex of texture data; the heightmap texture also stores the normals, which Unreal derives from the heights | `[E]` |
| The Landscape actor's location is the position of vertex (0, 0), the minimum-X, minimum-Y corner, at stored height 32768 | `[3P]` (a MathWorks example is consistent with it), otherwise `[U]` |

### 5.2 Valid sizes and component layouts

```
quadsPerComponent = sectionsPerComponent · quadsPerSection
N                 = components · quadsPerComponent + 1          vertices per side
```

with `quadsPerSection ∈ {7, 15, 31, 63, 127, 255}` and `sectionsPerComponent ∈
{1, 2}` (shown as 1x1 and 2x2). The New Landscape panel allows at most 32 × 32
components, and Epic recommends at most 1024 components in total. `[E]`

The build-resolution presets and their layouts are rows of Epic's table of
recommended sizes `[E]`:

| `N` | Quads per section | Sections per component | Components | Total components | Quads per side |
| --- | --- | --- | --- | --- | --- |
| 1009 | 63 | 2 (2x2) | 8 × 8 | 64 | 1008 |
| 2017 | 63 | 2 (2x2) | 16 × 16 | 256 | 2016 |
| 4033 | 63 | 2 (2x2) | 32 × 32 | 1024 | 4032 |
| 8129 | 127 | 2 (2x2) | 32 × 32 | 1024 | 8128 |

8129 is the largest size Epic's table recommends `[E]`.

```ts
// src/core/export-decl.ts
interface LandscapeLayout {
  readonly quadsPerSection: 7 | 15 | 31 | 63 | 127 | 255;
  readonly sectionsPerComponent: 1 | 2;
  readonly components: number;        // per side, 1 .. 32
  readonly totalComponents: number;   // components squared
}

// src/export/unreal.ts
/** The layout whose vertex count is exactly n with the fewest components, or null. */
function landscapeLayout(n: number): LandscapeLayout | null {
  let best: LandscapeLayout | null = null;
  for (const q of [255, 127, 63, 31, 15, 7] as const) {
    for (const s of [2, 1] as const) {
      if ((n - 1) % (q * s) !== 0) continue;
      const c = (n - 1) / (q * s);
      if (c < 1 || c > 32) continue;
      if (best === null || c * c < best.totalComponents) {
        best = { quadsPerSection: q, sectionsPerComponent: s, components: c, totalComponents: c * c };
      }
    }
  }
  return best;
}
```

The chooser is `[D]`; it reproduces Epic's table for 127, 253, 505, 1009, 2017,
4033 and 8129. A custom build resolution may have no layout (2049 and 4097 have
none): a landscape item is then the plan error `E_SIZE_NOT_LANDSCAPE`. Orogen
never pads, crops or resamples a heightmap to make it fit, and never lets the
importer do so.

No tiled export exists. Unreal 5 reads tiles without a shared border row
`[3P]`, so a tile size must divide the landscape size, and 8129 = 11 × 739 has
no usable tiling `[D]`.

### 5.3 How Unreal reads a height

For a stored 16-bit value `v` (unit: cm):

```
localZ(v) = (v − 32768) / 128
worldZ(v) = ActorLocation.Z + (v − 32768) / 128 · ActorScale.Z
```

| Fact | Status |
| --- | --- |
| Heights span −256 to 255.992 units at 16-bit precision, multiplied by the Z scale; Z scale 100 gives about ±256 m | `[E]` (Landscape Technical Guide) |
| The native packed height encoding maps to [−256, 256 − 1/128] before the landscape scale, which fixes the step at 1/128 and the zero at 32768 | `[E]` (Landscape Patch page). That this encoding is the landscape's own rests on the numeric match with the line above, not on a sentence of Epic's |
| At Z scale 100, +128 stored units are +1 m | `[3P]` (forum test) |
| The values of the engine constants behind this (`LANDSCAPE_ZSCALE`, `LandscapeDataAccess::MidValue`, `MaxValue`) | `[U]`; only the identifiers are on the API pages |
| The two formulas above | `[D]` from the first two lines |
| Epic's documented rule `ZScale = height in metres × 100 × 0.001953125` (1/512) | `[E]`. It treats the range as 65536 steps and is one code short at the top |

| Quantity | Value |
| --- | --- |
| `v = 0` | −256 · ScaleZ cm from the actor |
| `v = 32768` | the actor's Z |
| `v = 65535` | +255.9921875 · ScaleZ cm |
| Whole range | 65535 / 128 · ScaleZ = 511.9921875 · ScaleZ cm |
| One code | ScaleZ / 128 cm |

Heightmap files `[E]`: 16-bit greyscale PNG and 16-bit `.r16`; the documented
list of import formats has no 32-bit float format. That `.r16` is little-endian
is `[3P]` (MathWorks; a forum post citing Epic's 5.1 documentation); the 5.8
pages do not state the byte order. Orogen writes both files from the same
codes.

### 5.4 Quantising heights

The mapped range `[a, b]`, in normalised heights, is the pair of field values
stored as codes 0 and 65535:

```ts
// src/export/unreal.ts
/** min and max are the measured field minimum and maximum (Engine.stats). heightRange in metres. */
function heightMapping(range: HeightRange, min: number, max: number, heightRange: number): { a: number; b: number; widened: boolean } {
  let a: number, b: number;
  if (range.mode === 'fixed') { a = range.min; b = range.max; }
  else { const r = max - min; a = min - range.headroom * r; b = max + range.headroom * r; }
  const least = 1 / heightRange;                 // 1 metre, as a normalised height
  if (b - a >= least) return { a, b, widened: false };
  const mid = (a + b) / 2;
  return { a: mid - least / 2, b: mid + least / 2, widened: true };
}
```

- `'measured'` uses the terrain's actual minimum and maximum, measured on the GPU during the build, so none of the 65536 levels is wasted. `headroom` widens the range by that fraction of itself at each end, leaving room to sculpt above and below in Unreal.
- `'fixed'` maps the given range. Samples outside it are clipped and counted (`W_HEIGHT_CLIPPED`).
- A range under 1 m (a flat terrain) is widened to 1 m about its middle (`W_FLAT`).

**Why `'fixed'` exists.** With `'measured'`, `ScaleZ` and the actor's Z change
with every build, because the measured extremes change. A landscape that was
imported and then sculpted in Unreal cannot take a rebuilt heightmap without
its transform changing, which rescales the sculpted edit layers. A project that
re-imports uses `'fixed'`, with a range that covers every build.

```ts
// src/export/unreal.ts
const DITHER_SEED = 0x4f524f47;

/**
 * Converts one band. src holds rows y0, y0 + 1, ... of a field `width` wide.
 * Returns the number of samples outside [a, b].
 */
function quantiseHeights(src: Float32Array, dst: Uint16Array, o: { width: number; y0: number; a: number; b: number; dither: boolean }): number {
  const k = 65535 / (o.b - o.a);
  let clipped = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v < o.a || v > o.b) clipped++;
    let q = (v - o.a) * k + 0.5;
    if (o.dither) {
      const h = hashCell(i % o.width, o.y0 + Math.floor(i / o.width), DITHER_SEED);
      q += hashUnit(h) + hashUnit(hashU32(h)) - 1;        // triangular, in (-1, 1)
    }
    dst[i] = q <= 0 ? 0 : q >= 65535 ? 65535 : Math.floor(q);
  }
  return clipped;
}
```

- Arithmetic is in `float64` on the `float32` field values. Without dither the code is `round((v − a) / (b − a) · 65535)`, clamped.
- A code `q` decodes to `a + q · (b − a) / 65535`. For a sample inside `[a, b]` the decoded value differs from the sample by at most half a code, `0.5 · (b − a) / 65535`, without dither, and by less than 1.5 codes with it.
- The dither is the sum of two uniform values, a triangular distribution one code wide at half height and two codes wide at its base. It depends only on the texel position, so two builds of the same field give the same file.
- **What dither is for.** At 2400 m of relief one code is 3.66 cm; over a 98.4 cm quad that is a smallest representable slope of 2.13° `[D]`. Without dither gentle slopes become terraces and Unreal's normals, which it derives from the heightmap, show bands. With dither an exactly flat area becomes noise of one code. A terrain with large exactly-flat surfaces is better exported without it.
- The PNG and the `.r16` receive the same `dst`.

### 5.5 Scale and placement

```ts
// src/export/unreal.ts
interface Vec3 { readonly x: number; readonly y: number; readonly z: number }
interface LandscapeTransform {
  readonly scaleCm: Vec3;             // the actor's scale
  readonly actorLocationCm: Vec3;     // the actor's location: vertex (0, 0) at code 32768
  readonly uiLocationCm: Vec3;        // the terrain's centre in X and Y, the actor's Z
  readonly heightMinM: number;        // world Z of code 0, in metres
  readonly heightMaxM: number;        // world Z of code 65535, in metres
  readonly seaLevelZCm: number;       // world Z of the project's sea level
}
declare function landscapeTransform(o: {
  resolution: number; terrainSize: number; heightRange: number; seaLevel: number;
  a: number; b: number; zeroAt: 'seaLevel' | 'bottom'; origin: 'center' | 'corner';
}): LandscapeTransform;
```

With `N = resolution`, `terrainSize` and `heightRange` in metres, `seaLevel`,
`a` and `b` normalised:

```
extentCm    = terrainSize · 100
scaleXY     = extentCm / (N − 1)                         cm per quad
rangeCm     = (b − a) · heightRange · 100
scaleZ      = rangeCm · 128 / 65535
z0          = seaLevel when zeroAt = 'seaLevel', else 0
hMinCm      = (a − z0) · heightRange · 100               world Z of code 0
actorZ      = hMinCm + 256 · scaleZ
actorX      = actorY = −extentCm / 2 when origin = 'center', else 0

scaleCm         = (scaleXY, scaleXY, scaleZ)
actorLocationCm = (actorX, actorY, actorZ)
uiLocationCm    = (actorX + extentCm / 2, actorY + extentCm / 2, actorZ)
heightMinM      = hMinCm / 100
heightMaxM      = (hMinCm + rangeCm) / 100
seaLevelZCm     = (seaLevel − z0) · heightRange · 100
```

Then, for a code `v` at image column `i` and row `j`:

```
worldX = actorX + i · scaleXY
worldY = actorY + j · scaleXY
worldZ = actorZ + (v − 32768) / 128 · scaleZ
worldZ(0) = hMinCm          worldZ(65535) = hMinCm + rangeCm
```

and a normalised height `h` of the graph lies at world Z `(h − z0) ·
heightRange · 100` cm, whatever the mapped range.

- `scaleXY` divides by `N − 1`, never by `N`.
- `scaleZ = rangeCm · 128 / 65535` is exact for a range mapped onto 0..65535. The manifest names the formula. Epic's `rangeCm / 512` would leave the top 1 code low.
- All of these are `[D]`. `uiLocationCm` is what the New Landscape panel's Location field takes if that field means the landscape's centre in X and Y, which is `[U]` (inferred from Gaea2Unreal's copy of the editor's centring offset; Epic's page says only that Location is where the landscape is created).
- For 100 cm per quad exactly, set the terrain size to `N − 1` metres: 8128 m at 8129.

### 5.6 Worked example: 8129, 8 km, 2400 m of relief

Project: `resolution` 8129, `terrainSize` 8000 m, `heightRange` 3000 m,
`seaLevel` 0.1. Landscape item: range `'measured'` with headroom 0, `zeroAt`
`'seaLevel'`, `origin` `'center'`. Take the measured minimum and maximum as
exactly 0.05 and 0.85.

```
layout       127 quads per section, 2x2 sections, 32 x 32 components = 1024 components   [E]
             8128 quads per side; 66,080,641 vertices

a, b         0.05, 0.85                       150 m and 2550 m above height 0
extentCm     800000
scaleXY      800000 / 8128            = 98.4251968503937        (one component = 254 quads = 250 m exactly)
rangeCm      0.8 · 3000 · 100         = 240000
scaleZ       240000 · 128 / 65535     = 468.75715266651406
one code     scaleZ / 128             = 3.662165255207 cm
hMinCm       (0.05 − 0.1) · 300000    = −15000
actorZ       −15000 + 256 · scaleZ    = 105001.8310826276
actorX, Y    −400000

scaleCm          (98.4251968503937, 98.4251968503937, 468.75715266651406)
actorLocationCm  (−400000, −400000, 105001.8310826276)
uiLocationCm     (0, 0, 105001.8310826276)
heightMinM       −150
heightMaxM       2250
seaLevelZCm      0

check        worldZ(0)     = 105001.8310826276 − 256 · 468.75715266651406          = −15000 cm
             worldZ(65535) = 105001.8310826276 + 255.9921875 · 468.75715266651406  = 225000 cm
sea level    (0.1 − 0.05) / 0.8 · 65535 = 4095.9375  ->  code 4096 without dither
footprint    X, Y from −400000 to +400000 cm; Z from −15000 to +225000 cm
texel (i, j) world (−400000 + i · 98.4251968503937, −400000 + j · 98.4251968503937)

files        <Name>Height.r16   132,161,282 bytes
             each Layer*.r8      66,080,641 bytes
```

With Epic's approximate rule the scale would be 468.75, the actor's Z 105000
and the top 224996.34 cm.

World Partition `[D]`, with 254-quad components of 250 m:

| `gridSize` (components per streaming proxy, per side) | Proxies | Proxy side |
| --- | --- | --- |
| 2 | 16 × 16 = 256 | 500 m |
| 4 | 8 × 8 = 64 | 1 km |
| 8 | 4 × 4 = 16 | 2 km |

`regionSize` 16 gives 2 × 2 regions of 4 km; 32 or more gives one region.

### 5.7 Orientation

The engine frame of `engine.md` 1.8 maps onto Unreal axis for axis:

```
image column i  =  px.x  ->  Unreal +X
image row    j  =  px.y  ->  Unreal +Y        row 0 is the first row of every file
height                   ->  Unreal +Z
texel (0, 0)             ->  the landscape actor's origin, the minimum-X, minimum-Y corner
```

Nothing is mirrored, flipped or transposed anywhere between a field and a file:
row `y` of a field (`engine.md` 1.8) is row `y` of the PNG, of the raw file and
of the landscape. Unreal's `Flip Y Axis` import option stays off.

| Fact | Status |
| --- | --- |
| Height data is row-major with index `X + Y · SizeX`, so column goes to +X, row to +Y, and pixel (0, 0) to the actor's origin, without mirroring | `[U]`. Not in Epic's documentation; inferred from the indexing in Gaea2Unreal's source. Section 9 tests it |
| Seen from above with +X to the right, +Y points down the screen, so the landscape looks like the image | `[D]` from the line above and the left-handed frame |
| Unreal's Top viewport draws +X up and +Y to the right, so the landscape appears turned 90° counter-clockwise against the image. This is a view convention, not a data flip | `[U]` |
| What `Flip Y Axis` does to a single file | `[U]`; Epic documents it only for tiles that do not fit together |

An engine direction of angle θ (`engine.md` 1.8) is the vector `(cos θ, sin θ)`
in (X, Y) and becomes the Unreal vector `(cos θ, sin θ, 0)`. Because Unreal's
frame is left-handed `[E]`, the turn from +X towards +Y appears clockwise when
the landscape is seen from above in Unreal `[D]`. A light or wind direction set
in the graph keeps its relation to the terrain. Orogen draws the same
left-handed frame everywhere (`engine.md` 1.8): its viewport (`runtime.md`
7.5), thumbnails and previews show the terrain as Unreal shows it, never its
mirror image, and its angle controls turn clockwise as well.

### 5.8 Weight layers

Unreal side:

| Fact | Status |
| --- | --- |
| A weightmap file is single-channel, 8 bits per pixel, PNG or raw; weights are 0..255 | `[E]` |
| A layer file's resolution must equal the landscape's overall resolution exactly, or the editor refuses it | `[E]` |
| A target layer is a named weight channel; names come from the landscape material, are case-insensitive and unique; a material layer with no matching target layer has weight 0 | `[E]` |
| Every target layer needs its own Landscape Layer Info asset; no two layers share one | `[E]` |
| Blend methods of a layer info: No Weight Blending (`None`), Final Weight Blending (Legacy) (`FinalWeightBlending`), Advanced Weight Blending (`PremultipliedAlphaBlending`) | `[E]` |
| Final Weight Blending normalises once at the end of the edit-layer stack, so those layers total 255 except where all are 0. Advanced Weight Blending blends at each edit layer and only keeps the group's total from exceeding 255 | `[E]` |
| Import alphamap type `Additive`: the maps of blended layers total 1.0; the style Unreal uses internally | `[E]` |
| A component gets one more weightmap texture for every 4 target layers on it; layers a component does not use are stripped from its shader | `[E]` |
| A landscape whose layered material has no painted layer shades black | `[U]` |
| The landscape importer does not assign layer files by file name; each is chosen by hand | `[U]` (nothing found in Epic's pages; absence is not proof) |

Orogen's rules:

1. Layers are 8-bit, at exactly the landscape resolution, on the vertex grid, in the orientation of 5.7. Each is written as `.r8` and as an 8-bit grey PNG.
2. A layer item with `weightBlended: false` is an independent mask: `byte = floor(saturate(v) · 255 + 0.5)`, blend `none`. It is the vehicle for analysis masks (flow, wetness, slope, wear, deposit, snow) that materials and PCG read. PCG's landscape data exposes per-layer weights `[E]`; that the grass system reads them through the material is `[U]`.
3. The weight-blended layer items and the base layer form one group. The group's bytes sum to exactly 255 at every texel. Data that totals 255 satisfies both Unreal blend methods unchanged. All layers of the group share the landscape item's `layerBlend`.
4. The base layer has no input. Its weight is whatever the other layers leave. It exists whenever the build has a weight-blended layer item, so no texel of the group is ever uncovered.
5. Weights are quantised jointly. Rounding each layer on its own leaves 43.0 % of texels with a total other than 255 (measured: 6 normalised layers, totals from 253 to 257).

The joint rule works on the layers' 16-bit codes `p_i = floor(saturate(v_i) ·
65535 + 0.5)`, in integer arithmetic, texel by texel. `out[0]` is the base
layer; `out[i + 1]` belongs to `planes[i]`; the planes are in plan order.

```ts
// src/export/unreal.ts
/**
 * Quantises texels offset .. offset + count - 1 of every plane.
 * floorCode = floor(layerFloor * 65535 + 0.5); limit = layerLimit.
 */
function quantiseWeights(
  planes: readonly Uint16Array[], out: readonly Uint8Array[],
  o: { offset: number; count: number; floorCode: number; limit: number },
): void {
  const L = planes.length, T = 65535;
  const e = new Array<number>(L + 1), w = new Array<number>(L + 1), r = new Array<number>(L + 1);
  for (let t = 0; t < o.count; t++) {
    // 1. Floor, then the base takes what is left of a full weight.
    let s = 0;
    for (let i = 0; i < L; i++) {
      const p = planes[i][o.offset + t];
      e[i + 1] = p >= o.floorCode ? p : 0;
      s += e[i + 1];
    }
    e[0] = Math.max(0, T - s);
    // 2. Keep at most `limit` entries: drop the smallest; among equals the higher index goes first.
    if (o.limit > 0) {
      let kept = 0;
      for (let j = 0; j <= L; j++) if (e[j] > 0) kept++;
      for (; kept > o.limit; kept--) {
        let m = -1;
        for (let j = 0; j <= L; j++) if (e[j] > 0 && (m < 0 || e[j] <= e[m])) m = j;
        e[m] = 0;
      }
    }
    // 3. Largest remainder: floors, then one more unit to the largest remainders; ties to the lower index.
    let total = 0;
    for (let j = 0; j <= L; j++) total += e[j];
    let sum = 0;
    for (let j = 0; j <= L; j++) {
      const p = 255 * e[j];
      w[j] = Math.floor(p / total);
      r[j] = p - w[j] * total;
      sum += w[j];
    }
    for (let missing = 255 - sum; missing > 0; missing--) {
      let m = 0;
      for (let j = 1; j <= L; j++) if (r[j] > r[m]) m = j;
      w[m]++;
      r[m] = -1;
    }
    for (let j = 0; j <= L; j++) out[j][t] = w[j];
  }
}
```

Properties, which tests assert:

- `Σ out[j][t] = 255` for every texel, for any inputs.
- With `layerFloor` 0 and `layerLimit` 0, each byte differs from the exact value `255 · e_j / total` by less than 1.
- Where the layers' weights total at most 1, each layer keeps its weight and the base receives the rest. Where they total more, they are scaled down in proportion and the base is 0. The result does not depend on the order of the layers except in ties.
- `total` is never 0, and all intermediate values are integers below 2^31.

`layerFloor` and `layerLimit` exist because procedural masks are non-zero
almost everywhere, which defeats Unreal's per-component stripping of unused
layers `[D]`. Guidance, all `[D]` and to calibrate: at most 4 weight-blended
layers on a component, at most 8 layers in all, a warning above 12
(`W_MANY_LAYERS`).

### 5.9 Companion textures

Colour, normal and mask textures for materials are not landscape data. They are
resampled to a power-of-two side, at most 8192.

| Fact | Status |
| --- | --- |
| Streaming virtual textures require power-of-two dimensions | `[E]` |
| A regular texture must be power-of-two to have mips and to stream, in 5.8 | `[U]`. Exporting powers of two is safe either way |
| The largest texture side Direct3D accepts is 16384; 8192 is the largest size for a regular, non-virtual texture | `[U]` for 5.8 (older evidence only) |
| Unreal reads normal maps in the DirectX convention (green pointing down the image) | `[U]` |

A texture covers the landscape from its first to its last vertex. Texel `(i,
j)` of an `S × S` texture holds the terrain at `uv = ((i + 0.5) / S, (j + 0.5)
/ S)`, so that a material samples it with

```
U = (WorldX − actorLocationCm.x) / extentCm          V = (WorldY − actorLocationCm.y) / extentCm
```

`[D]`. V grows with +Y, as image rows do: no flip.

**The texel-grid resampler.** A field is on the vertex grid; a texture is
texel-centred. The pipeline converts on the CPU, from bands. For a source of
`N × N` vertices and a texture of side `S`:

```
ρ       = max(1, (N − 1) / S)                    radius of the filter, in source cells
c(i)    = (i + 0.5) · (N − 1) / S                source position of the centre of texel i
w(k, c) = max(0, 1 − |k − c| / ρ)                weight of source index k, k = 0 .. N − 1

out(i, j) = Σ_l Σ_k w(l, c(j)) · w(k, c(i)) · src(k, l)  /  ( Σ_l w(l, c(j)) · Σ_k w(k, c(i)) )
```

- When `S ≥ N − 1` (the default `'auto'` size), `ρ` is 1 and the rule is bilinear interpolation between the four vertices around the texel centre.
- When `S < N − 1` the tent widens with the reduction, so a smaller texture is filtered, not point-sampled.
- A constant field gives that constant. Each channel is resampled independently.
- Sums are accumulated in `float64`.

```ts
// src/export/convert.ts
interface TexelGridResampler {
  /** Takes the next source rows, in order (row-major, channels interleaved). Returns the output rows now complete. */
  push(rows: Float32Array): Float32Array;
  /** Returns the output rows not yet returned. */
  finish(): Float32Array;
}
declare function createTexelGridResampler(o: { srcSize: number; dstSize: number; channels: 1 | 3; stride?: number }): TexelGridResampler;
```

The resampler is streaming: it keeps the horizontally resampled rows inside
its vertical support, `2ρ + 2` rows at most, and its output does not depend on
how the source rows are cut into `push` calls. `stride` is the number of floats
a source texel has, of which the first `channels` are resampled; it defaults to
`channels`, and is 4 for a `color`, whose alpha is dropped without a copy of the
band. Each sum is taken over differences from its first sample, which is the
weighted mean above and returns a constant field bit for bit. A whole reduction
keeps a ramp exactly where the tent is not cut by the border; for another one
the weights at the vertices are not even about the texel centre, and a ramp is
off by a small part of a source cell (under 0.01 of one for 101 vertices onto 7
texels).

**Conversion by content.**

| `content` | Source | Resampled | Per output texel | PNG |
| --- | --- | --- | --- | --- |
| `'color'` | `color`, linear RGB | R, G, B; alpha is dropped | each channel: `SRGB8[floor(saturate(c) · 65535 + 0.5)]` | 8-bit RGB |
| `'mask'` | `field` | the value | `floor(saturate(v) · M + 0.5)`, `M` = 255 or 65535 | 8- or 16-bit grey |
| `'normal'` | `field` of heights | the three components of the vertex normal | normalise; a vector shorter than 1e-6 becomes (0, 0, 1); each component `floor((c · 0.5 + 0.5) · 255 + 0.5)` | 8-bit RGB |

```ts
// src/export/unreal.ts
/** SRGB8[i] is the 8-bit sRGB code of the linear value i / 65535. */
const SRGB8 = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
  const c = i / 65535;
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  SRGB8[i] = Math.floor(s * 255 + 0.5);
}
```

The vertex normal at `(x, y)` is that of `normalAt` (`engine.md` 3.8), computed
on the CPU from the height rows `y − 1`, `y` and `y + 1`, and for the first and
the last row from that row and the two next to it:

```
dx = (h(x + 1, y) − h(x − 1, y)) / 2                          inside
     (4 · h(1, y) − 3 · h(0, y) − h(2, y)) / 2                at x = 0: the one-sided difference of second order
     −(4 · h(N − 2, y) − 3 · h(N − 1, y) − h(N − 3, y)) / 2   at x = N − 1
sx = dx · heightRange · (N − 1) / terrainSize                 metres per metre
sy = the same along y
n  = normalize(−sx, −sy, 1)
```

- The normals come from physical slopes, not from normalised heights, and do not depend on where bands begin.
- A normal texture stores `(n.x, n.y, n.z)` in the landscape's axes: red is the normal's +X component, green its +Y component, blue its +Z component, each mapped from −1..1 to 0..255. With the texture mapped as above, green grows along +V. That this is what Unreal's default normal-map handling expects is `[U]`; if lighting from the texture is inverted along Y, the texture's green channel is flipped in Unreal.
- Unreal needs no normal map to shade a landscape `[E]`. The normal texture is a macro normal for materials.
- A colour texture's file holds sRGB-encoded values; a mask or normal texture holds data. The manifest states which (`srgb`).
- Any other data texture (a flow direction, for instance) is a mask texture, or a colour texture whose colour the graph composes.

### 5.10 World Partition

| Fact | Status |
| --- | --- |
| A World Partition landscape is one `ALandscape` actor and many `ALandscapeStreamingProxy` actors | `[E]` |
| World Partition Grid Size: components per streaming proxy, per axis; clamped 1..16 | `[E]` (API tooltip). Epic's import page words it the other way round; the tooltip is followed here |
| World Partition Region Size: components per region, per axis; clamped 4..64 | `[E]` |
| The defaults of the two (recalled as 2 and 16) | `[U]` |
| A landscape larger than the region size is created region by region | `[U]` |

The landscape item's `worldPartition` values go to the manifest unchanged. They
are applied by the user in the import panel or by the plugin. Orogen itself
writes one heightmap file whatever they are.

### 5.11 River and lake splines (reserved)

No node produces spline data: vector layers do not exist in the graph. The
manifest's `splines` member is `null`. The format is fixed now so that later
work and the plugin agree; the item kind `'splines'`, the file name
`<Name>.splines.json` and the schema name are reserved.

```jsonc
{
  "schema": "orogen.splines/1",
  "space": "unreal-world-cm",
  "rivers": [
    { "name": "RiverA",
      "points": [ { "pos": [x, y, z], "halfWidthCm": 600, "depthCm": 150, "velocity": 1.0 } ] }
  ],
  "lakes": [
    { "name": "LakeA", "surfaceZ": 12345.0, "points": [ [x, y], [x, y] ] }
  ]
}
```

- Positions are Unreal world centimetres, already transformed with 5.5, so a reader does no arithmetic.
- River points run downstream, one every 50 to 200 m, and are meant as curve points whose tangents Unreal computes.
- A lake is a closed outline at one surface height.
- `halfWidthCm` is a half-width because the Water plugin's `RiverWidth` is measured from the centre in each direction `[E]`. That its width and depth are in centimetres is `[U]`: the units are undocumented.
- The Water plugin's headers lie under an `Experimental` path in 5.8 `[E]`. That no native interchange format for water splines exists is `[U]` (none was found).
- Water bodies carve the landscape through an edit layer `[E]`. A heightmap from Orogen already contains its channels, so a river made from this file is created with `Affects Landscape` off; whether that is the right setting is `[U]`.

### 5.12 Not exported

| Not exported | Reason |
| --- | --- |
| Tiled heightmaps | 5.2 |
| `.raw` with Unreal's JSON sidecar | The key of its bit depth is printed as `bbp` in Epic's page; whether the engine reads `bbp` or `bpp` is `[U]` |
| Nanite settings | Enabling Nanite from code is `[U]`; the user enables it (7.2) |
| Runtime virtual texture, PCG, grass, water or material assets | They are authored in Unreal |
| Meshes | Outside this document |

---

## 6. The manifest

`<Name>.orogen.json` describes a complete build. It is written last, so a
folder without it is not a build. The plugin reads it; the manual procedure
copies its numbers.

- UTF-8 without a byte order mark, two-space indentation, a final newline, keys in the order of the example.
- Numbers are written as JavaScript writes them (`JSON.stringify`): the shortest text that reads back to the same `float64`. No number is rounded for display.
- Paths are file names relative to the manifest's folder, with no directory part.
- `schema` is `orogen.unreal.landscape/<major>`. A reader rejects a major version it does not know and ignores members it does not know. Adding a member does not change the major version; changing or removing one does.
- The manifest holds no time and no path outside its folder, so that a repeated build writes the same bytes (3.8). Times are in the report.

### 6.1 Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "orogen.unreal.landscape/1",
  "title": "Orogen build manifest",
  "type": "object",
  "required": ["schema", "status", "generator", "targetEngine", "project", "terrain", "resolution",
               "landscape", "textures", "images", "splines", "files"],
  "properties": {
    "schema": { "const": "orogen.unreal.landscape/1" },
    "status": { "const": "complete" },
    "generator": {
      "type": "object", "required": ["name", "version"],
      "properties": { "name": { "const": "Orogen" }, "version": { "type": "string" } }
    },
    "targetEngine": { "const": "5.8" },
    "project": {
      "type": "object", "required": ["seed"],
      "properties": { "seed": { "type": "integer", "minimum": 0, "maximum": 4294967295 } }
    },
    "terrain": {
      "type": "object", "required": ["sizeM", "heightRangeM", "seaLevel"],
      "properties": {
        "sizeM": { "type": "number", "exclusiveMinimum": 0, "description": "Terrain width, first vertex to last vertex, metres." },
        "heightRangeM": { "type": "number", "exclusiveMinimum": 0, "description": "Metres represented by the normalised height 1.0." },
        "seaLevel": { "type": "number", "description": "The project's sea level as a normalised height." }
      }
    },
    "resolution": { "$ref": "#/$defs/size", "description": "Vertices per side of the build. x equals y." },
    "landscape": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "object",
          "required": ["layout", "heightmap", "transform", "orientation", "seaLevelZCm", "worldPartition", "alphamapType", "layers"],
          "properties": {
            "layout": {
              "type": "object", "required": ["quadsPerSection", "sectionsPerComponent", "components"],
              "properties": {
                "quadsPerSection": { "enum": [7, 15, 31, 63, 127, 255] },
                "sectionsPerComponent": { "enum": [1, 2], "description": "Per side: 2 is shown as 2x2 in Unreal." },
                "components": { "$ref": "#/$defs/size" }
              }
            },
            "heightmap": {
              "type": "object",
              "required": ["r16", "png", "rangeMode", "valueMin", "valueMax", "heightMinM", "heightMaxM",
                           "measuredMin", "measuredMax", "clippedSamples", "zScaleFormula", "dither"],
              "properties": {
                "r16": { "type": "string", "description": "uint16 little-endian, row-major, row 0 first, no header." },
                "png": { "type": "string", "description": "16-bit greyscale PNG holding the same codes." },
                "rangeMode": { "enum": ["measured", "fixed"] },
                "valueMin": { "type": "number", "description": "Normalised height stored as code 0." },
                "valueMax": { "type": "number", "description": "Normalised height stored as code 65535." },
                "heightMinM": { "type": "number", "description": "World Z of code 0, metres." },
                "heightMaxM": { "type": "number", "description": "World Z of code 65535, metres." },
                "measuredMin": { "type": "number", "description": "Smallest normalised height of the terrain." },
                "measuredMax": { "type": "number", "description": "Largest normalised height of the terrain." },
                "clippedSamples": { "type": "integer", "minimum": 0 },
                "zScaleFormula": { "const": "range_cm*128/65535" },
                "dither": { "enum": ["none", "tpdf-1lsb"] }
              }
            },
            "transform": {
              "type": "object", "required": ["scaleCm", "actorLocationCm", "uiLocationCm", "rotationDeg"],
              "properties": {
                "scaleCm": { "$ref": "#/$defs/vec3", "description": "Actor scale: cm per quad in x and y; cm per 128 codes in z." },
                "actorLocationCm": { "$ref": "#/$defs/vec3", "description": "Actor location: world position of pixel (0, 0) at code 32768." },
                "uiLocationCm": { "$ref": "#/$defs/vec3", "description": "The terrain's centre in x and y with the actor's z." },
                "rotationDeg": {
                  "type": "object", "required": ["pitch", "yaw", "roll"],
                  "properties": { "pitch": { "const": 0 }, "yaw": { "const": 0 }, "roll": { "const": 0 } }
                }
              }
            },
            "orientation": {
              "type": "object", "required": ["pixel00", "imageX", "imageY", "flipYAxis"],
              "properties": {
                "pixel00": { "const": "minX_minY" }, "imageX": { "const": "+X" }, "imageY": { "const": "+Y" },
                "flipYAxis": { "const": false }
              }
            },
            "seaLevelZCm": { "type": "number", "description": "World Z of the project's sea level." },
            "worldPartition": {
              "type": "object", "required": ["enabled", "gridSize", "regionSize"],
              "properties": {
                "enabled": { "type": "boolean" },
                "gridSize": { "type": "integer", "minimum": 1, "maximum": 16 },
                "regionSize": { "type": "integer", "minimum": 4, "maximum": 64 }
              }
            },
            "alphamapType": { "const": "Additive" },
            "layers": {
              "type": "array",
              "items": {
                "type": "object", "required": ["name", "r8", "png", "blend", "base", "meanWeight"],
                "properties": {
                  "name": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_]{0,62}$" },
                  "r8": { "type": "string", "description": "uint8, row-major, row 0 first, no header, landscape resolution." },
                  "png": { "type": "string", "description": "8-bit greyscale PNG holding the same bytes." },
                  "blend": { "enum": ["none", "final", "advanced"],
                             "description": "ELandscapeTargetLayerBlendMethod: None, FinalWeightBlending, PremultipliedAlphaBlending." },
                  "base": { "type": "boolean" },
                  "meanWeight": { "type": "number", "minimum": 0, "maximum": 1 }
                }
              }
            }
          }
        }
      ]
    },
    "textures": {
      "type": "array",
      "items": {
        "type": "object", "required": ["content", "file", "size", "channels", "bits", "srgb", "covers", "sampling"],
        "properties": {
          "content": { "enum": ["color", "mask", "normal"] },
          "file": { "type": "string" },
          "size": { "enum": [1024, 2048, 4096, 8192] },
          "channels": { "enum": [1, 3] },
          "bits": { "enum": [8, 16] },
          "srgb": { "type": "boolean", "description": "True when the file holds sRGB-encoded colour." },
          "covers": { "const": "landscapeExtent" },
          "sampling": { "const": "texel-center" },
          "normalEncoding": { "const": "xyz-landscape-axes", "description": "Present for content normal." }
        }
      }
    },
    "images": {
      "type": "array",
      "items": {
        "type": "object", "required": ["file", "format", "width", "height", "valueMin", "valueMax"],
        "properties": {
          "file": { "type": "string" },
          "format": { "enum": ["png8", "png16", "r16", "r32", "exr", "tiff16", "tiff32"] },
          "width": { "type": "integer" },
          "height": { "type": "integer" },
          "valueMin": { "type": ["number", "null"], "description": "Field value stored as the lowest code; null for float formats." },
          "valueMax": { "type": ["number", "null"], "description": "Field value stored as the highest code; null for float formats." }
        }
      }
    },
    "splines": { "type": "null" },
    "files": {
      "type": "array",
      "description": "Every file of the build except the manifest and the report.",
      "items": {
        "type": "object", "required": ["path", "bytes"],
        "properties": { "path": { "type": "string" }, "bytes": { "type": "integer", "minimum": 0 } }
      }
    }
  },
  "$defs": {
    "size": {
      "type": "object", "required": ["x", "y"],
      "properties": { "x": { "type": "integer", "minimum": 1 }, "y": { "type": "integer", "minimum": 1 } }
    },
    "vec3": {
      "type": "object", "required": ["x", "y", "z"],
      "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "z": { "type": "number" } }
    }
  }
}
```

`src/export/manifest.ts` exports this schema as `MANIFEST_SCHEMA` and the
matching TypeScript type `Manifest`. Tests validate every manifest the pipeline
writes against it.

Member rules beyond the schema:

- `landscape.layers` lists the base layer first, then the weight-blended layers, then the others, in plan order. `blend` is the landscape item's `layerBlend` for the base and the weight-blended layers and `none` for the others.
- `landscape.layout` equals `landscapeLayout(resolution.x)`, with `components.x = components.y`.
- `heightmap.valueMin`, `valueMax` are `a`, `b` of 5.4; `transform` and `seaLevelZCm` come from `landscapeTransform`.
- `files[].bytes` is the size on disk.

### 6.2 Example

The build of 5.6 with two weight-blended layers, one mask layer and two
textures. The byte counts of the PNG files and the `meanWeight` values are
illustrative, not measurements.

```json
{
  "schema": "orogen.unreal.landscape/1",
  "status": "complete",
  "generator": { "name": "Orogen", "version": "0.1.0" },
  "targetEngine": "5.8",
  "project": { "seed": 1234 },
  "terrain": { "sizeM": 8000, "heightRangeM": 3000, "seaLevel": 0.1 },
  "resolution": { "x": 8129, "y": 8129 },
  "landscape": {
    "layout": { "quadsPerSection": 127, "sectionsPerComponent": 2, "components": { "x": 32, "y": 32 } },
    "heightmap": {
      "r16": "AlpsHeight.r16",
      "png": "AlpsHeight.png",
      "rangeMode": "measured",
      "valueMin": 0.05,
      "valueMax": 0.85,
      "heightMinM": -150,
      "heightMaxM": 2250,
      "measuredMin": 0.05,
      "measuredMax": 0.85,
      "clippedSamples": 0,
      "zScaleFormula": "range_cm*128/65535",
      "dither": "tpdf-1lsb"
    },
    "transform": {
      "scaleCm": { "x": 98.4251968503937, "y": 98.4251968503937, "z": 468.75715266651406 },
      "actorLocationCm": { "x": -400000, "y": -400000, "z": 105001.8310826276 },
      "uiLocationCm": { "x": 0, "y": 0, "z": 105001.8310826276 },
      "rotationDeg": { "pitch": 0, "yaw": 0, "roll": 0 }
    },
    "orientation": { "pixel00": "minX_minY", "imageX": "+X", "imageY": "+Y", "flipYAxis": false },
    "seaLevelZCm": 0,
    "worldPartition": { "enabled": true, "gridSize": 4, "regionSize": 32 },
    "alphamapType": "Additive",
    "layers": [
      { "name": "Base", "r8": "LayerBase.r8", "png": "LayerBase.png", "blend": "advanced", "base": true, "meanWeight": 0.52 },
      { "name": "Grass", "r8": "LayerGrass.r8", "png": "LayerGrass.png", "blend": "advanced", "base": false, "meanWeight": 0.31 },
      { "name": "Rock", "r8": "LayerRock.r8", "png": "LayerRock.png", "blend": "advanced", "base": false, "meanWeight": 0.17 },
      { "name": "Flow", "r8": "LayerFlow.r8", "png": "LayerFlow.png", "blend": "none", "base": false, "meanWeight": 0.04 }
    ]
  },
  "textures": [
    { "content": "color", "file": "T_Color_8192.png", "size": 8192, "channels": 3, "bits": 8, "srgb": true,
      "covers": "landscapeExtent", "sampling": "texel-center" },
    { "content": "normal", "file": "T_Normal_8192.png", "size": 8192, "channels": 3, "bits": 8, "srgb": false,
      "covers": "landscapeExtent", "sampling": "texel-center", "normalEncoding": "xyz-landscape-axes" }
  ],
  "images": [],
  "splines": null,
  "files": [
    { "path": "AlpsHeight.png", "bytes": 90000000 },
    { "path": "AlpsHeight.r16", "bytes": 132161282 },
    { "path": "LayerBase.png", "bytes": 20000000 },
    { "path": "LayerBase.r8", "bytes": 66080641 },
    { "path": "LayerGrass.png", "bytes": 20000000 },
    { "path": "LayerGrass.r8", "bytes": 66080641 },
    { "path": "LayerRock.png", "bytes": 20000000 },
    { "path": "LayerRock.r8", "bytes": 66080641 },
    { "path": "LayerFlow.png", "bytes": 20000000 },
    { "path": "LayerFlow.r8", "bytes": 66080641 },
    { "path": "T_Color_8192.png", "bytes": 100000000 },
    { "path": "T_Normal_8192.png", "bytes": 100000000 }
  ]
}
```

---

## 7. Importing a build into Unreal Engine 5.8 by hand

This section is the text of the manual import in `docs/user/unreal-import.md`
(section 1 says what that file adds). Importing by hand is the supported
route. Each statement about Unreal says how far it has been checked:

- **confirmed**: read in Epic's documentation or API reference for 5.8.
- **third party**: confirmed only by someone other than Epic.
- **derived**: computed from confirmed facts.
- **unconfirmed**: recalled, inferred, or reported by users; not confirmed for 5.8. The wording of menus and panels in the steps below was not checked item by item and is unconfirmed unless a step says otherwise.

Nobody at Orogen has run this procedure in Unreal Engine. Run the acceptance
test (section 9) once on your engine version before you trust an import.

### 7.1 Before you start

1. Build the project in Orogen into a folder of its own. The folder belongs to Orogen: each build replaces everything in it, and Orogen refuses to build into a folder that holds anything but an earlier build, so keep the project file and your own files elsewhere. You need `<Name>.orogen.json` (the manifest), `<Name>Height.png`, one `Layer<X>.png` per layer, and the `T_*.png` textures.
2. Do not rename the heightmap or layer files and do not copy other images into the folder. Their names are letters only on purpose (7.4, item 3).
3. Use Unreal Engine 5.8.3 or later. 5.8.2 fixed a crash when editing landscape layers in Landscape Mode (confirmed, hotfix notes). Earlier 5.8 versions have the material problem of 7.4, item 2; whether 5.8.3 is free of it is unconfirmed.
4. Open the manifest in a text editor. Every number below is copied from it with all its digits. A horizontal scale shortened to two decimals moves the far edge of an 8 km terrain by about 40 cm (derived).
5. Make the landscape material first if you import layers. Target layers take their names from the layer names used in the landscape material (confirmed); names are case-insensitive and must equal the `name` values under `landscape.layers`. Whether the import panel offers a layer that the material does not name is unconfirmed.

### 7.2 Steps

1. Open or create the level. If the level uses World Partition and the landscape is 8129 × 8129, read 7.4, item 1 first.
2. Open Landscape Mode, the Manage tab, New, and choose Import from File.
3. Heightmap File: choose `<Name>Height.png`. Unreal imports 16-bit greyscale PNG and 16-bit `.r16` heightmaps (confirmed). The `.r16` file holds the same data; that Unreal reads it as little-endian is third party, so prefer the PNG.
4. Leave Flip Y Axis off. The option exists (confirmed); what it does to a single file is unconfirmed.
5. If Unreal asks whether to use the tiled image path, answer No. Unreal asks this when it considers the heightmap tiled (confirmed); an Orogen build is one file.
6. Compare the layout the panel shows with `landscape.layout` in the manifest and correct the panel if it differs: Section Size = `quadsPerSection` (for 8129: 127x127 quads), Sections Per Component = 1x1 or 2x2 for `sectionsPerComponent` 1 or 2, Number of Components = `components` (32 x 32), Overall Resolution = `resolution` (8129 x 8129). These values are confirmed for the four sizes Orogen offers; that the panel fills them in by itself is unconfirmed.
7. Scale: type `landscape.transform.scaleCm` x, y and z (derived).
8. Location: type `landscape.transform.uiLocationCm`. This assumes the panel's Location is the centre of the landscape in X and Y, which is unconfirmed; step 13 checks it. Leave Rotation at 0.
9. Material: choose your landscape material.
10. Layers. For each entry of `landscape.layers`, in the row of the target layer with the same name:
    - create its layer info with the "+" button: Weight-Blended Layer when `blend` is `advanced` or `final`, Non Weight-Blended Layer when it is `none` (confirmed: every layer needs its own layer info asset, and these are the two choices);
    - open the layer info and set Weight Blending Method to Advanced Weight Blending for `advanced`, Final Weight Blending (Legacy) for `final`, No Weight Blending for `none` (the three methods are confirmed);
    - choose the layer's `png` file. Each layer's file is chosen by hand; nothing found in Epic's pages assigns files by name (unconfirmed, an absence).

    Set Layer Alphamap Type to Additive (confirmed: Additive means the blended layers' maps total 1, which is how Orogen writes them). A layer file must have exactly the landscape's resolution or Unreal refuses it (confirmed); Orogen's always have.
11. World Partition levels only: set World Partition Grid Size and World Partition Region Size to `landscape.worldPartition.gridSize` and `regionSize`. Both options exist with ranges 1 to 16 and 4 to 64 (confirmed). Grid Size is the number of components per streaming proxy along one side; Epic's import page describes it the other way round, and the API reference is followed here. The panel's own default values are unconfirmed.
12. Click Import.
13. Select the Landscape actor. Its Transform must show Location = `landscape.transform.actorLocationCm` and Scale = `scaleCm`. If the Location shows `uiLocationCm` instead, the panel did not centre the landscape: type `actorLocationCm` into the actor's Location (derived).
14. Look at the terrain. Seen from above with +X pointing to the right of the screen, +Y points down the screen and the terrain looks like `<Name>Height.png` as an image viewer shows it (unconfirmed; the acceptance test checks it). Unreal's Top viewport shows it turned a quarter turn counter-clockwise; that is how the viewport is drawn, not an error (unconfirmed). If the terrain is mirrored or turned in any other way, stop and run the acceptance test.
15. Nanite, if you want it: on the Landscape actor's Details panel, Nanite, tick Enable Nanite and press Build Data, or use Build, Build Landscape (confirmed). Nanite and non-Nanite data are both kept, and about twice the data is streamed (confirmed).
16. Textures: import the `T_*.png` files as ordinary textures. Switch sRGB off for every texture whose manifest entry says `"srgb": false`. Sample them in the landscape material with `U = (WorldX − actorLocationCm.x) / extent`, `V = (WorldY − actorLocationCm.y) / extent`, where `extent` is `terrain.sizeM × 100` (derived). Unreal shades a landscape from the heightmap without any normal map (confirmed); `T_Normal` is an optional macro normal, and whether its green channel needs flipping is unconfirmed.
17. Save the level and the layer info assets.

Sculpt in a new edit layer above the imported one, not in the imported one. All
landscapes have edit layers in 5.8, and the base layer is named "Layer"
(confirmed).

### 7.3 Importing a rebuilt terrain

There is no tested procedure for replacing the heights of a landscape that
already exists. Two facts bear on it:

- With Height range set to Measured, the scale and location in the manifest change with every build. Replacing only the heightmap of an existing landscape would then be wrong, and changing the actor's scale rescales everything sculpted on it. Set Height range to Fixed before the first import if you intend to re-import (derived).
- The editor can import into an existing landscape (confirmed); the steps are unconfirmed.

### 7.4 Known risks and workarounds

1. **Repeated tiles after importing 8129 × 8129 into a World Partition level.** One user reports that importing a single 8129 × 8129 16-bit PNG into a World Partition level shows one part of the heightmap repeated 4 × 4 or 16 × 16 times, with a correct wireframe and wrong shading, on 5.7.0, 5.7.4 and 5.8.0; it worked on 5.5.4 and 5.6.1. Epic has not replied and there is no ticket (forum report of 2026-08-24; confirmed as a report, not reproduced by Orogen; the state on 5.8.3 is unknown). This is exactly an Orogen build at its largest size. The reporter's workaround: import into a level without World Partition, then convert the level to World Partition. Check with the acceptance test at 8129 before you rely on a World Partition import.
2. **Wrong output of the Landscape Layer Blend material node.** The node gave washed-out or wrong specular, and in some cases a grey Nanite landscape, on 5.8.0 to 5.8.2 (first report 2026-06-26, Epic ticket UE-386355). The ticket was closed as fixed; a user reported on 2026-08-26 that 5.8.2 did not fix it; Epic staff said on 2026-08-27 it would be reopened and on 2026-09-07 that it would be addressed in 5.8.3. The 5.8.3 notes do not mention it, so whether 5.8.3 fixes it is unconfirmed. Two workarounds reported by users on early 5.8, both unconfirmed: feed single attributes such as Specular through the blend node instead of Material Attributes; or use Final Weight Blending (Legacy) instead of Advanced Weight Blending. For the second, set Layer blend method to Final on Orogen's Unreal Landscape node and build again: the manifest then says `"blend": "final"`.
3. **Heightmap file names.** Users have met the import error `doesn't have proper pattern(ex: _x0_y0.png)` on ordinary single files and reported that it went away after removing digits from the file name, avoiding spaces and special characters, removing similarly named PNG files from the same folder, deleting temporary copies left by an image editor, or deleting the stale asset and importing again (forum threads about UE 5.0, posts from 2022 to 2024). The cause is unconfirmed, and none of it has been reproduced on 5.8. Orogen's file names and its rule of one folder per build are a precaution against it.
4. **Too many layers on a component.** A report for 5.8 says that merging edit layers makes each component inherit its left and top neighbours' layers, so that with about ten or more layers a component exceeds Direct3D 12's limit of 64 shader resources and silently falls back to the default material (forum report of 2026-08-12, no reply from Epic; unconfirmed). Keep the number of layers low: aim for at most 8, and Orogen warns above 12.
5. **World Partition Region Size 4.** On 5.5.4, creating a landscape with Region Size 4 fails an assertion; 5 and 8 work (forum report of 2026-07-31; the state on 5.8 is unknown). Orogen warns when the value is 4.
6. **Stale image size.** The editor caches an image file's resolution; after a build at another resolution it can keep the old size until another file is selected (third party, observed on 5.5.3). Select a different file and then the right one again.
7. **Slow imports.** QuadSpinner reports slow landscape imports since 5.5, most of all with World Partition, and attributes them to the engine (third party).

---

## 8. The editor plugin (experimental)

`OrogenBridge` is an Unreal editor plugin that creates a landscape from a
manifest in one call, without the import panel.

**It is delivered as C++ source only. It cannot be compiled, loaded or tested
on the development machine or on hosted CI, which have no Unreal Engine. No
binary is shipped. Nothing in this section has been built or run. It is
labelled experimental in the product and in the user documentation, and the
procedure of section 7 is the route Orogen supports.**

The reasons it exists: only C++ reaches `ALandscapeProxy::Import`, the one
function that creates landscape components from height data. In 5.8 that
function, the import helpers, the landscape subsystem, the addition of target
layers and the naming of a layer info are not exposed to Python or Blueprint
(`[E]`: no page or no specifier in the 5.8 references), so no Python-only
import is possible.

### 8.1 Scope

| In | Out |
| --- | --- |
| One new `ALandscape` in the current editor world from `landscape` of a manifest: heights from the `.r16`, one target layer and one layer info asset per entry of `layers` from the `.r8` files, the transform, the material, the World Partition grid | Re-import into an existing landscape; tiled or region-by-region import; Nanite; textures; water bodies and splines; runtime virtual textures; any runtime module; any user interface |

The plugin reads `.r16` and `.r8` directly. It does not read PNG files, does
not use the `LandscapeEditor` module and never lets the engine pad, crop or
resample.

### 8.2 The entry point

```cpp
// Source/OrogenBridge/Public/OrogenImportLibrary.h
UCLASS()
class UOrogenImportLibrary : public UBlueprintFunctionLibrary
{
    GENERATED_BODY()
public:
    /**
     * Creates a Landscape in the current editor world from an Orogen manifest.
     * MaterialPath: object path of the landscape material, or empty for none.
     * LayerInfoFolder: content folder for the layer info assets, e.g. "/Game/Orogen/LayerInfos".
     * Returns the new actor, or nullptr with OutError set. On failure nothing is left in the world.
     */
    UFUNCTION(BlueprintCallable, Category = "Orogen")
    static ALandscape* ImportTerrain(const FString& ManifestPath, const FString& MaterialPath,
                                     const FString& LayerInfoFolder, FString& OutError);
};
```

This is the only function the plugin exposes. A `BlueprintCallable` function
of an editor module is expected to be callable from an Editor Utility Widget
and from Python `[U]`. A Python driver, per Epic's documented command line
`[E]`:

```
UnrealEditor-Cmd.exe "<project>.uproject" -ExecutePythonScript="<script>.py"
```

```python
import unreal
unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level("/Game/Maps/World")
landscape, error = unreal.OrogenImportLibrary.import_terrain(
    r"D:/Build/Alps/Alps.orogen.json", "/Game/Materials/M_Landscape", "/Game/Orogen/LayerInfos")
if not landscape:
    raise RuntimeError(error)
unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)
```

That the output parameter arrives as the second element of a tuple, and that
this script runs unattended to completion, is `[U]`. Whether a landscape import
completes in commandlet mode (`-run=pythonscript`) is `[U]`; the full-editor
form above is the one to use.

### 8.3 What it does, call by call

Module type Editor. Dependencies: `Core`, `CoreUObject`, `Engine`, `UnrealEd`,
`Landscape`, `AssetTools`, `AssetRegistry`, `Json`, `JsonUtilities`.

The landscape declarations named below (`Import`, `GetLandscapeInfo`,
`UpdateLayerInfoMap`, `AddTargetLayer`, `FLandscapeImportLayerInfo`,
`FLandscapeTargetLayerSettings`, the layer info's setters, `IsGridBased`,
`ChangeGridSize`) were read on the 5.8 API reference `[E]`. The other calls
(loading a file, spawning the actor, creating an asset, `StaticLightingLOD`)
follow Gaea2Unreal's source; that they are unchanged in 5.8 is `[U]`. The
behaviour and the default arguments of all of them are `[U]`. Every argument is
passed explicitly.

1. **Read and check the manifest** (`Json` only). Reject unless `schema` is `orogen.unreal.landscape/1`, `status` is `complete` and `landscape` is not null. Compute `SizeX = components.x · quadsPerSection · sectionsPerComponent + 1` (likewise `SizeY`) and reject unless it equals `resolution`. Reject unless the `.r16` file is `SizeX · SizeY · 2` bytes and every `.r8` file `SizeX · SizeY` bytes.
2. **Heights.** `FFileHelper::LoadFileToArray`, then a copy into `TArray<uint16>` (the host is little-endian). Index `X + Y · SizeX`.
3. **Layers.** For each manifest layer: an `FLandscapeImportLayerInfo(FName)` with `LayerData` from the `.r8`, `SourceFilePath`, and `LayerInfo` set to a `ULandscapeLayerInfoObject` asset named `<Layer>_LayerInfo`, created in `LayerInfoFolder` through the asset tools (an asset of that name that already is a layer info is reused), then `SetLayerName(Name, true)` and `SetBlendMethod(Method, true)` with `None`, `FinalWeightBlending` or `PremultipliedAlphaBlending` for `none`, `final`, `advanced`. The public properties of the layer info are announced to become private in 5.9 `[E]`; only the setters are used. No blend group is set.
4. **Actor.** `World->SpawnActor<ALandscape>(actorLocationCm, rotation)`; assign `LandscapeMaterial`; `SetActorRelativeScale3D(scaleCm)`; set `StaticLightingLOD` to `DivideAndRoundUp(CeilLogTwo(SizeX · SizeY / (2048 · 2048) + 1), 2)`, as Gaea2Unreal does.
5. **Import.** `Landscape->Import(FGuid::NewGuid(), 0, 0, SizeX − 1, SizeY − 1, sectionsPerComponent, quadsPerSection, Heights, HeightFileName, Layers, ELandscapeImportAlphamapType::Additive, TArrayView<const FLandscapeLayer>())`, with the heights and the layers each in a map keyed by a default `FGuid()`.
6. **Target layers.** `GetLandscapeInfo()`, `UpdateLayerInfoMap(Landscape, false)`, `RegisterAllComponents()` as Gaea2Unreal calls it at this point (`[U]`: `Import` may already have registered them), then `AddTargetLayer(Name, FLandscapeTargetLayerSettings(LayerInfo, SourceFile), true)` for each layer. The plugin then writes a warning to the log, and does not fail, when `GetEditLayer(0)` returns null or `GetLandscapeExtent` reports another extent than the one imported; both declarations are `[E]`.
7. **World Partition.** When `worldPartition.enabled` and the world's `ULandscapeSubsystem` reports `IsGridBased()`: `ChangeGridSize(LandscapeInfo, gridSize)`. The whole landscape is imported first and partitioned afterwards.
8. Label the actor `Orogen_<Name>` and return it.

Open questions that only a run on 5.8.3 answers, all `[U]`:

- Whether `Import` with an empty `InImportLayers` creates the default edit layer by itself.
- Whether the repeated-tile report of 7.4 reproduces through this path.
- Whether the sequence above is complete. It follows the open-source Gaea2Unreal plugin, which has no build for 5.8; nothing readable says its calls work unchanged on 5.8.

### 8.4 Isolating engine versions

The landscape C++ API changes in almost every engine release. The plugin
confines the damage to one file.

| File | Contains | Engine headers |
| --- | --- | --- |
| `Private/OrogenManifest.h`, `.cpp` | `FOrogenManifest`, a plain struct mirroring the manifest; parsing and step 1 | `Core`, `Json` |
| `Private/OrogenLandscapeCompat.h` | `struct FOrogenLandscapeDesc` (sizes, layout, transform, heights, per layer: name, blend, bytes, source path; material path; layer info folder; grid size) and `ALandscape* OrogenCreateLandscape(UWorld*, const FOrogenLandscapeDesc&, FString& OutError)`. No landscape type other than the forward-declared `ALandscape` appears in it | `Core` |
| `Private/OrogenLandscapeCompat.cpp` | Steps 3 to 8. Every include of a `Landscape` or `AssetTools` header and every use of `ENGINE_MAJOR_VERSION` / `ENGINE_MINOR_VERSION` in the plugin | all |
| `Private/OrogenImportLibrary.cpp` | `ImportTerrain`: steps 1 and 2, fills the description, calls `OrogenCreateLandscape` with the editor's world; the module's `IMPLEMENT_MODULE` | `Core`, `Engine`, `UnrealEd` (`GEditor`) |

- `OrogenLandscapeCompat.cpp` begins with a guard that stops compilation with a clear message on any engine version other than 5.8, so that building against an unverified engine is a deliberate edit, not an accident.
- Supporting another engine version means editing that one file.
- `unreal/OrogenBridge/Fixtures/example.orogen.json` is the manifest of 6.2. The TypeScript tests validate the same file against `MANIFEST_SCHEMA`, so the plugin's reader and the writer cannot drift apart unnoticed.
- The user compiles the plugin inside a C++ project: copy `unreal/OrogenBridge` to `<Project>/Plugins/OrogenBridge` and build the project. The user documentation states the tools Epic requires for building a 5.8 C++ project; that list is not part of this contract.

---

## 9. Acceptance test in Unreal

The test resolves the `[U]` statements this contract depends on: orientation,
the height formulas, the meaning of the panel's Location, layer orientation,
and the repeated-tile report. It is run by the user, in Unreal, once per engine
version, and again at 8129 before a World Partition import is trusted.

### 9.1 The pattern

```
orogen unreal-test --out <dir> [--res <n>]        n is 1009 (default), 2017, 4033 or 8129
```

writes a complete build named `Marker` into `<dir>` (3.8) without a project and
without a GPU. It uses the encoders, `landscapeLayout`, `quantiseWeights` and
the manifest writer of this document. `N` is the resolution; `step` is 16, 8,
4, 2 for 1009, 2017, 4033, 8129.

Heights, as 16-bit codes, written without dither:

| Region (columns × rows) | Code | Name |
| --- | --- | --- |
| everything else | 32768 | plain |
| columns 0..63, rows 0..63 | 65535 | tower: 64 × 64, at the image's top left |
| columns `N − 64 .. N − 1`, rows 0..31 | 0 | pit: 64 wide, 32 deep in rows, at the top right |
| all columns, rows `N − 32 .. N − 1` | `32768 + step · column` | ramp: along the bottom edge, rising to the right |

Transform: `scaleCm` = (100, 100, 100), `actorLocationCm` = (0, 0, 0),
`uiLocationCm` = (`50 · (N − 1)`, `50 · (N − 1)`, 0), stated directly in the
manifest. That is a terrain of `N − 1` metres with vertex (0, 0) at the world
origin, 100 cm per quad, and a mapped range of 511.9921875 m with code 32768 at
world Z = 0.

Layers: `Base` (the remainder), `Left` (weight-blended; 255 where column <
`(N − 1) / 2`, else 0) and `Top` (not weight-blended; 255 where row < `(N − 1)
/ 2`, else 0). Texture `T_Marker_1024.png`: red in the quarter of the tower,
green in the quarter of the pit, blue in the bottom-left quarter, white in the
bottom-right quarter.

### 9.2 Expected result

Import the build by the procedure of section 7 (or with the plugin) and check,
in the editor, with the cursor's world position or a placed actor:

| # | Check | Expected | A different result means |
| --- | --- | --- | --- |
| 1 | The Landscape actor's Location and Scale after the import | (0, 0, 0) and (100, 100, 100) | Location = `uiLocationCm`: the panel's Location is the actor's origin, not the centre. Use `actorLocationCm` on the actor (7.2, step 13) |
| 2 | The landscape's extent | X and Y from 0 to `100 · (N − 1)` cm: 100800 at 1009 | another extent: the size or the XY scale was changed by the importer |
| 3 | Where the tower is | at the corner of smallest X and smallest Y; its top spans X 0..6300, Y 0..6300 | at smallest X, largest Y: rows are flipped. At largest X, smallest Y: columns are flipped. At largest X and Y: both |
| 4 | Where the pit is | at largest X, smallest Y, longer along X (6300 cm) than along Y (3100 cm) | at smallest X, largest Y and longer along Y: X and Y are exchanged |
| 5 | Where the ramp is | along the edge of largest Y, rising with X | along smallest Y: rows are flipped. Along an X edge: X and Y are exchanged |
| 6 | Height of the plain | Z = 0 | Z ≠ 0: code 32768 is not the actor's Z |
| 7 | Height of the tower's top | Z = +25599.22 cm | another value: the mapping of 5.3 is wrong |
| 8 | Depth of the pit's floor | Z = −25600 cm | another value: the mapping of 5.3 is wrong |
| 9 | Height on the ramp at column `c` | Z = `0.78125 · step · c` cm; at 1009, X = 80000 cm gives Z = 10000 cm exactly | a proportional error: the Z scale formula is wrong |
| 10 | Layer `Left` (layer visualisation, or a material showing it) | covers the half of smallest X | the other half: layers are oriented differently from heights |
| 11 | Layer `Top` | covers the half of smallest Y | |
| 12 | The texture, sampled with the formula of 7.2, step 16 | red on the tower's quarter, green on the pit's | exchanged colours: the texture's U or V runs the other way |
| 13 | The whole landscape, at 8129 in a World Partition level | one tower, one pit, one unbroken ramp | several towers or a sawtooth ramp: the repeated-tile problem of 7.4, item 1 |

Checks 3 to 5 distinguish all eight ways an image can be mirrored, rotated or
transposed, because the three markers sit on different corners and edges and
the pit is not square.

### 9.3 Round trip

Export the landscape's heightmap from Unreal to a 16-bit PNG or `.r16` (Unreal
exports both `[E]`) and run

```
orogen unreal-test --check <file> [--res <n>]
```

It decodes the file, regenerates the pattern and prints the number of samples
that differ and the largest difference. Exit code 0 means every sample is
identical. That an unmodified import exports identically is the expectation
under test, `[U]`.

### 9.4 Recording the outcome

The result of each check, with the engine version, goes into
`docs/user/unreal-import.md` in place of the word "unconfirmed" for the
statements it settles. A check that fails is a defect of this contract: the
formula or convention of section 5 is corrected, not worked around in a node.

---

## 10. Tests

`testing.md` defines the layers and the harness. This section states what the
code of this document must be tested for.

### 10.1 An export node

The conformance suite checks an export node's metadata only, `checkExportNode`
included (`testing.md` 3.1). The node's own test file,
`tests/nodes/io/<name>.test.ts`, is `conformance(def)` and nothing else
(`testing.md` 5.2): a file in `tests/nodes/` may not import `src/export/`.

`tests/export/unit/export-nodes.test.ts` asserts for every export node, without
a GPU:

1. On a document holding the node with default parameters and a connected `in`, `planBuild` returns the items and files that 2.4 and 2.6 state, and no error.
2. Every option of every enum parameter and both values of every bool parameter give the item member that 2.4 states.
3. The hook is pure: two calls with the same context return deeply equal results.
4. With `enabled` false the node contributes nothing, and with `in` unconnected it gives `E_INPUT_MISSING`.

### 10.2 GPU-free tests (`tests/export/unit/`)

| Subject | Asserted |
| --- | --- |
| Each encoder | A file written from a known image decodes to the same samples: PNG with `fast-png`, TIFF and EXR with `decodeImage`, raw by reading the bytes. File sizes equal the formulas of 4.2. Writing the image in one call and in many gives identical bytes |
| PNG | Every scanline carries filter type 2; every IDAT chunk but the last is 1 MiB; no ancillary chunk |
| EXR | One written file is also read with an EXR reader that is not Orogen's, once, by hand; the result is recorded in the test file's header |
| `landscapeLayout` | The table of 5.2; `null` for 2049 and 4097 |
| `heightMapping`, `landscapeTransform` | The worked example of 5.6 to 12 significant digits; headroom; the 1 m minimum |
| `quantiseHeights` | The error bounds of 5.4 with and without dither; identical output for any band split; the clipped count |
| `quantiseWeights` | The properties of 5.8, on random planes and on the edge cases: all zero, one layer full, ties, `layerLimit` 1 |
| The resampler | Equals bilinear interpolation when `S ≥ N − 1`; preserves a constant; identical output for any split of the source rows; a ramp stays a ramp |
| `planBuild` | Every problem code of 3.3 from a document made to provoke it; the order of items, layers and files |
| The manifest | The example of 6.2 and every manifest a test build writes validate against `MANIFEST_SCHEMA` |
| `unreal-test` | The pattern of 9.1 at 1009; `--check` accepts its own heightmap and reports a planted difference |
| Decoders | In `tests/unit/decoders.test.ts`, with the core code they belong to: each accepted format of 4.7 from a file the test generates; each rejection with its message |

### 10.3 GPU tests (`tests/export/`)

| Subject | Asserted |
| --- | --- |
| A build | The assertions of acceptance graph 05 (`testing.md` 10.2): the folder holds the files of `manifest.files`, the manifest and the report; the PNG and the `.r16` hold the same codes and decode to the source field within the bound of 5.4; layers total 255; the texture's side is a power of two; the transform equals 5.5 |
| Determinism | Two builds of one document give byte-identical data files and manifests |
| Cancellation | A build aborted in a stage, and one aborted in phase 3, leave no file under a final name except the report, and no `.partial` file |
| Failure | A graph with a failing node upstream of the second target ends with `'errors'` and `E_NODE_FAILED`, having made no data file visible |
| Memory | During a build at 1009 the engine's ledger shows no allocation made by the pipeline |
| `buildToFolder` | A second build into the same folder replaces it and leaves no file of the first; a folder with a foreign file is refused |

---

## 11. Unverified statements this contract depends on

| # | Statement | Used in | Settled by |
| --- | --- | --- | --- |
| 1 | Image column maps to +X, row to +Y, pixel (0, 0) to the actor's origin, without mirroring | 5.7, every file | 9.2, checks 3 to 5 |
| 2 | The actor's location is vertex (0, 0) at code 32768; the step is 1/128 of the Z scale | 5.3, 5.5 | 9.2, checks 6 to 9 |
| 3 | The New Landscape panel's Location is the landscape's centre | `uiLocationCm`, 7.2 | 9.2, check 1 |
| 4 | `.r16` is little-endian | 4.4, the plugin | 9.3 with an `.r16` import |
| 5 | Layer files are oriented like the heightmap | 5.8 | 9.2, checks 10 and 11 |
| 6 | Unreal's normal-map convention matches the encoding of 5.9 | the normal texture | a lighting check in the user's material |
| 7 | A single 8129² import into a World Partition level works on the target engine | 5.10, 7.2 | 9.2, check 13 |
| 8 | An unmodified import exports byte-identical heights | re-import workflows | 9.3 |
| 9 | Power-of-two is required for regular textures; 8192 is safe as a regular texture | 5.9 | an import of `T_*_8192.png` |
| 10 | The plugin's call sequence compiles and works on 5.8.3 | section 8 | compiling and running it |
| 11 | The file-name precaution is needed, or sufficient | 2.6 | not testable by one check; kept as a precaution |
| 12 | The defaults of World Partition Grid Size and Region Size; the behaviour of Region Size 4 on 5.8; what Flip Y Axis does to one file | 7.2 | observation during the import |
