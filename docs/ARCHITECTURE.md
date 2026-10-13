# Orogen: overview

Orogen is a node-based procedural terrain generator. A graph of nodes produces
heightfields, masks and colour maps on the GPU; a build evaluates the graph at
landscape resolution, up to 8129 × 8129, and writes the files Unreal Engine
5.8's Landscape system imports.

This page is the map. The contract is the documents in `docs/contract/`
(section 5). If code and a contract document disagree, one of them is fixed in
the same change.

## 1. Stack

| Piece | Choice |
| --- | --- |
| Language | TypeScript 7, ES modules, erasable syntax only (no enums, no namespaces, no parameter properties), so Node runs the sources directly. Imports carry explicit `.ts` extensions |
| GPU | WebGPU compute shaders in WGSL, written as template strings in `.ts` files; no loader in any environment |
| Desktop shell | Electron 44 (Chromium's WebGPU: D3D12 on Windows, Vulkan on Linux). The engine and the viewport run in one worker; the interface thread has no device |
| Headless | Node 24 or later with the `webgpu` package 0.6.2 (Dawn); the same engine code |
| Interface | React 19, `@xyflow/react` (graph), `dockview-react` (docking), zustand and immer (state and undo) |
| Tests | `node --test` on the `.ts` sources; a conformance suite every node passes |
| Target | Unreal Engine 5.8 landscapes; Windows 11 with an RTX 3080. Development: Linux with a GTX 1660 Ti |

Exact versions are in `runtime.md` 8.9.

## 2. Verified platform facts

Measured on the development machine (GTX 1660 Ti 6 GB, Linux, Vulkan), October
2026, and on GitHub's hosted runners where a paragraph says so. Nothing here is
measured on the target machine or on D3D12 hardware.

**Dawn in Node**

- The adapter reports `maxTextureDimension2D` 32768, `maxStorageBufferBindingSize` 2 GiB − 4 and 8 storage textures per stage, and offers `float32-filterable`, `texture-formats-tier1`, `texture-formats-tier2` and `timestamp-query`. A device has only what it requests: created without `requiredLimits` and features it reports 8192, a 256 MiB buffer limit, a 128 MiB storage binding and 4 storage textures per stage.
- On such a device `r32float` is a `read_write` storage texture, and `rg32float`, `rgba16float` and `rgba32float` are write-only. `rgba32float`, `r16float` and `r8unorm` become `read_write` only with `texture-formats-tier2`, which the engine never requests.
- A texture layout entry with the default `sampleType: 'float'` rejects `r32float` and `rgba32float` unless `float32-filterable` is enabled; `'unfilterable-float'` accepts every field format.
- Throughput at 2048²: a 5-point stencil pass 0.29 ms, 10-octave noise about 2 ms, a four-pass pipe-erosion iteration 3.0 ms. Reading back 264 MB takes about 0.3 s.
- The first write to a new texture is far slower than later ones unless the texture has `RENDER_ATTACHMENT` usage: 9.75 ms against 0.49 ms for a 2048² `r32float`. A whole-run time that includes new textures is not a kernel's throughput.
- After `destroy()` the driver keeps a texture's memory until a further submission has completed, and now and then until a second one has.
- The object returned by the package's `create()` must stay reachable while the device is in use, or the process hangs or crashes.
- While a GPU promise is pending, the process spins one CPU core.
- `adapter.info.memoryHeaps` is absent, so the amount of video memory is unknown headless.
- After a device is lost, `onSubmittedWorkDone()` still resolves and `popErrorScope()` returns `null`; only `mapAsync` rejects.
- With `timestamp-query` the device's timer has steps of 65.536 µs on this card. A slice shorter than a step measures 0 or one step: a measured duration of 0 is the measurement of a short slice, not the sign of one that was not timed (`runtime.md` 3.5).

**WGSL on the adapters**

- A loop that indexes a function-local array is far slower on NVIDIA Vulkan than its texture loads suggest. Ranking 61 samples held in such an array took 779 ms for one 2049² field; the same ranking written out sample by sample, as values that stay in registers, takes 7.4 ms (`filter/median`). A kernel that sorts, ranks or selects among its samples keeps them in named values, and the arithmetic counts in its `cost` (`engine.md` 3.15 rule 4).
- Float division is not exact: a number divided by itself is not 1 on every device. A weighted sum divided by its own weight does not return a constant field bit for bit, and `(s − lo) / (hi − lo)` at `s = hi` can come out just below 1. The shared ops therefore sum differences from an anchor texel (`ops.resample`, `ops.blur`, `ops.smooth`) and select the end of a span (`ops.remap`).
- A builtin is not the function of its name at a large argument on every device. On `windows-latest` (WARP), `tanh(8.2)` returned 1.08, which took 0.0646 off a terrain where 0.06 was the most, and `tanh` of about 1e5 returned NaN (`generate/crater`, `generate/crater-field`); both are 1 on the NVIDIA driver and on lavapipe. Kernels write the hyperbolic tangent with `exp` of a number that is never above 0, and the lint refuses the builtin (`testing.md` section 4).
- A device may reassociate and fuse arithmetic: `mix(a, b, t)` is evaluated as `a + t · (b − a)` on some, which is one ulp off `b` at `t = 1`. Every blend whose two ends must be exact selects them (`ops.blend`, the evaluator's mask blend, `adjust`'s blends): a mask of 0 leaves `a` and a mask of 1 gives `b`, bit for bit. On lavapipe `mix(a, a, t)` is not `a` to the last bit either: level ground interpolated between two of its own texels stood 1e-6 of a sun's disc in its own shadow. A kernel that compares an interpolated value with what it was interpolated from writes `a + t · (b − a)`, which is `a` when the two are equal (`ops.shadow`).

**Electron 44**

- On Linux the real GPU is exposed only with `--enable-unsafe-webgpu --enable-features=Vulkan`. With the first switch alone the adapter is SwiftShader, a software rasteriser, and no error is raised. Limits there: `maxTextureDimension2D` 16384, 4 GiB buffers.
- A worker has `node:fs` and `node:zlib` only with `sandbox: false` and `nodeIntegrationInWorker: true`.
- A hidden `BrowserWindow` (`show: false`) on a real X display can be captured with `webContents.capturePage()`, WebGPU canvases included. Under Xvfb a WebGPU canvas does not present. In a window that was never shown the page's `requestAnimationFrame` fires once per second; a worker's fires at the display rate.
- Electron's Dawn is older than the one in the `webgpu` package: WGSL that compiles in Node can fail in the application.

**GitHub-hosted runners (no GPU)**

- `windows-latest`: Dawn finds the software D3D12 adapter (WARP, "Microsoft Basic Render Driver") from a plain `requestAdapter()`. Compute shaders compile through the HLSL path and run. This is the Windows correctness check.
- WARP does not set `isFallbackAdapter`: under Dawn it reports vendor `microsoft`, architecture `warp`, device `microsoft-basic-render-driver` and `isFallbackAdapter` false, where lavapipe reports architecture `software` and `isFallbackAdapter` true. Whether an adapter is a software one is decided by its name as well (`caps.software`, `runtime.md` 1.3).
- `ubuntu-latest` with `mesa-vulkan-drivers`: Dawn runs on lavapipe (`llvmpipe`). Its `maxStorageBufferBindingSize` is the 128 MiB default.
- A software adapter is selected by name (`llvmpipe`, `Microsoft`); `forceFallbackAdapter` does not select one under Dawn.
- Both software adapters and the GTX 1660 Ti give the same value range for integer-hash noise at equal resolution. Values are not bit-identical across adapters: lavapipe and the NVIDIA driver differ by up to 4.6e-6. Runs on one adapter are bit-identical.

Consequences: no code relies on a feature or a raised limit without reading it
from the device; every kernel runs on a device with default limits and no
optional features; a software adapter costs speed, never correctness; tests
compare across adapters with tolerances.

## 3. Source layout

```
src/
  core/            the engine. No DOM, Node or Electron API
    api.ts           everything a node file imports
    runtime.ts       everything code outside core imports
    nodes/           index.ts (the product's node list) and one folder per category:
                     generate adjust filter simulate select color surface io ref
    gpu/ eval/ graph/ session/ io/ cpu/ wgsl/ ops/
  export/          the build pipeline, encoders, Unreal arithmetic; uses Node built-ins
  viewport/        the viewport renderer
  cli/             the command-line program `orogen`
  platform/
    node/            Dawn device, files on node:fs, CPU worker thread
    electron/        main process, preload bridge, engine worker, CPU worker
  app/             the interface: state, shell, panels (graph viewport inspector library build)
tests/             harness, unit, engine, nodes/<category>, export, graphs, electron, ui/<owner>
unreal/            the experimental editor plugin, C++ source
docs/contract/     the contract        docs/research/   research reports
docs/changes/      change requests     docs/user/       user documentation
```

`runtime.md` 8.4 and 8.10 give the import rules and the owners; `testing.md`
section 1 the test folders.

## 4. Glossary

| Term | Meaning |
| --- | --- |
| grid, resolution | A square lattice of `n × n` samples on vertices that covers the whole terrain; `n` is the resolution. `uv = px / (n − 1)` |
| field, kind | A GPU texture holding one value per sample; its kind (`field`, `color`, `vec2`, …) fixes the channel count and minimum precision. Only `field` and `color` cross ports |
| ladder | The 2:1 vertex levels of the build resolution, `(B − 1) / 2^k + 1`. Previews, drafts, thumbnails and the coarse-to-fine driver use its levels, so a coarser grid is an exact subset of a finer one |
| unit box | The graph describes a shape in a unit box: lengths are fractions of the terrain width, heights are normalised to the height range; project settings give it physical size. Slopes and angles are physical |
| role | What a `field` port carries: `height`, `mask` (0..1) or `data` |
| kernel | One compute pipeline and its declared bindings, made by `defineKernel`; the framework generates the WGSL declarations, accessors and entry point |
| node, `NodeDef` | A graph operation made by `defineNode`: ports, parameters, kernels and an `evaluate` that produces outputs through the evaluation context |
| registry | The set of node definitions a program runs with, made by `createRegistry` |
| evaluation: preview, build | One run of the graph at one resolution. A preview is cached and sliced finely; a build runs at build resolution and frees memory as it goes. A node cannot tell which it is in |
| slice, tile | A slice is one GPU submission, sized by measured throughput. A tile is one band of a run that would be too long for one dispatch. Together they keep the GPU pre-emptible (the Windows watchdog resets a GPU after about two seconds) |
| pool, budget | Every field texture comes from one pool that keeps a byte ledger and enforces a budget; the state of one simulation at 8129² fits in 3.5 GB |
| session | `EngineSession`, the interface's only door to the engine: scheduling, the view, builds, device recovery |
| profile | How a device is created: `core` (default limits, no optional features; what tests assert on) or `max` |
| export node, manifest | A node that declares what a build writes. The manifest is the JSON file that describes a complete build to Unreal and to the user |
| owner, integrator | Every path has one owner; the integrator alone changes frozen files, through change requests |
| to calibrate | A starting value, held as a named constant, that only a measurement changes |

## 5. The contract documents

| Document | Defines | Read it if you |
| --- | --- | --- |
| `engine.md` | fields and kinds, units and value conventions, kernels and generated WGSL, nodes and parameters, the evaluation context, shared operations, two worked nodes | write a node; work on core |
| `testing.md` | the harness, the conformance suite, the registry lint, definition of done, naming and text conventions, ownership and change requests, test layers, the command line, CI, the acceptance graphs | write a node; own any folder; review a change |
| `nodes.md` | the catalog of product nodes: which exist, their ids, ports and purpose | own a node category; look for a node |
| `simulation.md` | the simulation algorithms, their state, passes, stability and iteration scaling, the coarse-to-fine driver, the calibration register | write or review a `simulate` node |
| `runtime.md` | device creation, the pool and budget, slices and tiles, the document, the evaluator and cache, errors and device loss, files and CPU tasks, the session, the application's structure | work on core, the platform code, the viewport or the interface |
| `export-unreal.md` | export nodes, the build pipeline, encoders and decoders, Unreal conventions and formulas, the manifest, the manual import, the experimental plugin, the acceptance test in Unreal | work on export or import nodes; import a build into Unreal |

By role:

| Role | Reads |
| --- | --- |
| Node author | `engine.md` and `testing.md` sections 2 to 7; `simulation.md` for the `simulate` category |
| Export owner | `export-unreal.md`; `engine.md`; `runtime.md` 5.2, 6 and 7.6; `testing.md` |
| Panel, shell or state owner | `runtime.md` sections 4, 7 and 8; `testing.md` 2.9, 5.6, 7 and 8.5; `engine.md` 4.1 to 4.4 for node metadata |
| Platform owner | `runtime.md` sections 1, 6 and 8.1 to 8.6; `testing.md` 2.9 and section 9 |
| Viewport owner | `runtime.md` 5.11, 7.4, 7.5 and 7.8; `engine.md` section 1 |
| Integrator | everything |
