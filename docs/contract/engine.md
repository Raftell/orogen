# Engine contract: fields, kernels and nodes

This document is the node author's contract. With `testing.md` it is everything
needed to write a correct node. It defines the data model, the unit and value
conventions, the kernel system and its generated WGSL, the node and parameter
types, the evaluation context, and the shared operations.

Other documents own what is only referred to here:

| Document | Owns |
| --- | --- |
| `runtime.md` | evaluator, cache and cache keys, texture pool and budget, flush policy and batch sizing, error reporting, device creation and loss, `FileSource`, the document model (`GraphDoc`, settings, `NodeInstance`), the application |
| `simulation.md` | the simulation algorithms, their state layouts and iteration scaling, the behaviour of the coarse-to-fine driver |
| `export-unreal.md` | export nodes, the build pipeline, encoders, Unreal conventions |
| `testing.md` | the test harness, the conformance suite and its tolerances, definition of done, file layout and ownership, text conventions for titles and help |

**Imports.** `src/core/api.ts` re-exports every type, function and constant named
in this document. Node code imports the engine from that module only:

```ts
// src/core/nodes/<category>/<name>.ts
import { defineKernel, defineNode, param, ops, type Field } from '../../api.ts';
```

A node file never imports another node category, `platform/`, `app/`,
`src/export/`, or a core module other than `api.ts`, and never touches a
`GPUDevice`, `GPUTexture` or any other WebGPU object.

`api.ts` also re-exports what other documents define and a node may name:

| Names | Defined in |
| --- | --- |
| `ExportSource`, `ExportContext`, `ExportHook`, `ExportItem` and its members, `HeightRange` (the declaration types of `src/core/export-decl.ts`) | `export-unreal.md` section 2 |
| `decodeRaw` (a core CPU task) | `export-unreal.md` 4.7 |
| `DeviceLostError`, `BudgetExceededError`, `FileError` (errors that reach a node through context methods; a node lets them propagate) | `runtime.md` 1.1, 2.3, 6.1 |
| `NodeRegistry`, `createRegistry` | `runtime.md` 5.1 |

**Module scope.** `defineLib`, `defineKernel`, `defineCpuTask` and `defineNode`
are pure, synchronous and need no device. They are called at module scope only
and throw on an invalid definition (3.13, 4.6). `defineKernel` and
`defineCpuTask` record every name they are given, in a table of the process (a
worker thread has its own): a second, different kernel or task with a name
already used throws, and a CPU task is found by its name in that table.
`createEngine` (`runtime.md` 5.1) seals all four functions; a later call
throws. The node definitions a program uses become a `NodeRegistry` through
`createRegistry` (`runtime.md` 5.1); there is no implicit registry of nodes.

---

## 1. Data model

### 1.1 Grids and the sampling convention

A **grid** is a square lattice of `n × n` samples that covers the whole terrain.
`n` is the grid's **resolution** (vertices per side). Samples sit on vertices,
matching Unreal landscape vertices:

```
px        = (x, y), integers, 0 ≤ x, y ≤ n − 1      x = column, y = row
uv        = px / (n − 1)                             (0,0) and (1,1) are terrain corners
position  = uv * terrainSize                         metres
cellSize  = terrainSize / (n − 1)                    metres between neighbouring samples
```

- The mapping is never texel-centred. `(px + 0.5) / n` and `uv * n − 0.5` are wrong everywhere in this engine.
- Terrains are square. `terrainSize`, `cellSize` and resolutions are scalars.
- An evaluation always covers the whole terrain. A later tiled evaluator will define `uv = (origin + px) / (fullRes − 1)` with an integer `origin`; nothing may be built on a fractional region origin or size.

A **field** is a GPU texture holding one value per sample.

- Fields that cross ports are grids at the evaluation resolution `ctx.res`.
- A node may allocate grids of other resolutions for its own use (4.7). Every field spans the whole terrain whatever its size: a 257² field and an 8129² field describe the same area.
- A 1 × 1 field is a constant; for `n = 1` the divisor `n − 1` is replaced by 1.
- A field that only holds uploaded data (an imported image) may be `w × h` with `w ≠ h`. It still spans the whole terrain, `uv = (x / (w − 1), y / (h − 1))`. Kernels read such a field but never write one (3.11).

### 1.2 Field kinds and formats

```ts
type FieldKind = 'field' | 'vec2' | 'color' | 'aux' | 'half' | 'half2' | 'mask8';
```

| Kind | Channels | WGSL value | Format | Format without `texture-formats-tier1` | Crosses ports | Bytes per texel | One 8129² field |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `field` | 1 | `f32` | `r32float` | same | yes | 4 | 264 MB |
| `vec2` | 2 | `vec2f` | `rg32float` | same | no | 8 | 529 MB |
| `color` | 4 | `vec4f` | `rgba16float` | same | yes | 8 | 529 MB |
| `aux` | 4 | `vec4f` | `rgba32float` | same | no | 16 | 1057 MB |
| `half` | 1 | `f32` | `r16float` | `r32float` | no | 2 or 4 | 132 or 264 MB |
| `half2` | 2 | `vec2f` | `rg16float` | `rg32float` | no | 4 or 8 | 264 or 529 MB |
| `mask8` | 1 | `f32` | `r8unorm` | `r32float` | no | 1 or 4 | 66 or 264 MB |

Rules:

1. A kind fixes the channel count and the minimum precision, not the format. The format is resolved once per device. A node never names a texture format.
2. Only `field` and `color` cross ports. The other kinds are for a node's own state.
3. Every kernel must work with both columns of the table. Tests run on a device with no optional features (profile `core`, `runtime.md`), where the compact kinds use the fallback format.
4. `half`, `half2` and `mask8` never hold a value that is accumulated over iterations or that scales a height. `r16float` has 11 significant bits: about 1 m of a 2 km height range.
5. A value stored to `mask8` must already be in 0..1 (`r8unorm` clamps and quantises to 1/255; the fallback format does neither). A result must not depend on that quantisation.
6. Only `field` can be updated in place (3.5). State with several channels that must be updated in place is stored as several `field` planes; otherwise it is ping-ponged.
7. Integer data (codes, indices, counts up to 2^24) is stored in a `field` as the float with that value. Bit patterns are never stored through `bitcast`.
8. No kernel stores NaN or infinity in any field (1.7).
9. Budget: the complete state of one simulation at 8129² fits in 3.5 GB. `simulation.md` gives each algorithm's layout in these kinds.

### 1.3 Textures behind fields

Every field texture is created with usage
`STORAGE_BINDING | TEXTURE_BINDING | COPY_SRC | COPY_DST | RENDER_ATTACHMENT`,
dimension `2d`, one mip level, sample count 1. `RENDER_ATTACHMENT` is not used
to draw terrain into fields; it lets a new texture and `ctx.clear()` be cleared
on the GPU.

Fields are read with `textureLoad` only. Inputs are bound with
`sampleType: 'unfilterable-float'`. No kernel uses a sampler, and the engine
never depends on the `float32-filterable` feature. Interpolation is four loads
(3.8).

### 1.4 Field handles

```ts
interface Field<K extends FieldKind = FieldKind> {
  readonly kind: K;
  readonly width: number;      // texels
  readonly height: number;     // texels
  readonly readOnly: boolean;  // true for inputs and for fields already passed to ctx.output()
  readonly id: number;         // unique within the engine session; appears in error messages as "field #id"
}
```

A `Field` is an opaque handle. Nothing else about the texture is visible to a node.

Lifetime, as a node sees it:

| Field comes from | Writable | Released |
| --- | --- | --- |
| `ctx.input(name)` | no | by the evaluator; the handle is valid until `evaluate()` settles |
| `ctx.alloc`, `ctx.clone`, a shared op (5) | yes, until passed to `ctx.output()` | when `evaluate()` settles (returns, throws or is aborted), or earlier by `ctx.release()` |
| a field passed to `ctx.output()` | no, from that call on | owned by the evaluator once `evaluate()` resolves |

1. Input fields are shared with the cache and with other consumers. Binding a read-only field to a writable slot throws (3.13). A node that wants to modify its input starts with `ctx.clone(input)`.
2. The contents of a field from `ctx.alloc()` are undefined unless `clear` is given: the texture may hold another node's old data. A kernel writes every texel it later reads, or the field is cleared first.
3. Using a released field in any call throws `FieldAccessError`.
4. A handle is meaningless outside the `evaluate()` call that obtained it. A node keeps no handle, and no other state, between evaluations.
5. Passing an input field straight to `ctx.output()` is allowed and costs nothing: the output is an alias of the input.
6. A node releases large temporaries with `ctx.release()` as soon as they are dead, and allocates all the state a loop needs before that loop, so that a node that does not fit the budget fails before the loop does any work. A node driven by `ops.coarseToFine` allocates each level's state before that level's first loop (`simulation.md` 1.5).

### 1.5 The resolution ladder

Every evaluation resolution is a level of the build resolution's 2:1 vertex ladder:

```
level k of resolution B:   res_k = (B − 1) / 2^k + 1        defined while (B − 1) is divisible by 2^k and res_k ≥ 33
```

| Build resolution | Coarser levels |
| --- | --- |
| 8129 | 4065, 2033, 1017, 509, 255, 128 |
| 4033 | 2017, 1009, 505, 253, 127, 64 |
| 2017 | 1009, 505, 253, 127, 64 |
| 1009 | 505, 253, 127, 64 |

- Build resolutions are the Unreal landscape sizes 1009, 2017, 4033 and 8129, or a custom integer `B` with `129 ≤ B ≤ 8192` and `(B − 1)` divisible by 16.
- The preview resolution is level `previewLevel` of the build resolution (a project setting, `runtime.md`). During a gesture the application evaluates one or two levels coarser still.
- On the ladder every vertex of a coarser level is a vertex of every finer level, and cell sizes differ by exact powers of two. A point-wise function of `uv` therefore gives the same value at shared vertices of a preview and of the build.
- A node sees one resolution, `ctx.res`, and the levels below it, `ctx.ladder` (4.7). It never sees, and must not depend on, the build resolution or whether the evaluation is a preview.
- The coarse-to-fine simulation driver (5) walks the same ladder.

### 1.6 Units

The graph describes a shape in a unit box; project settings give it physical
size. Every stored parameter value is in exactly one of these units:

| `unit` | Stored value | Used for | Conversion in `evaluate()` |
| --- | --- | --- | --- |
| `'length'` | fraction of terrain width; 1.0 = `terrainSize` | feature size, radius, distance, offset, wavelength, width | already a `uv` distance; `ctx.lengthToPx(v)` texels; `ctx.lengthToMetres(v)` |
| `'height'` | normalised; 1.0 = `heightRange` | heights, amplitudes, height thresholds | already in field units; `ctx.heightToMetres(v)` |
| `'angle'` | degrees | directions (0..360) and slope thresholds (0..90) | `v * Math.PI / 180`; a slope threshold is compared as `Math.tan(...)` |
| `'ratio'` | 0..1 | amounts, strengths, opacities, probabilities | none |
| `'none'` | a plain number | exponents, lacunarity, gamma, multipliers | none |

1. No stored value is ever in pixels, texels or iterations per pixel. A parameter that controls how long a simulation runs is a `'length'` (how far material travels), a `'ratio'`, or a `'none'` duration that `simulation.md` defines; the iteration count is computed in `evaluate()`.
2. Slopes are physical. They are computed from real metres with `terrainSize` and `heightRange`: `slope = d(h * heightRange) / d(metres)`. A slope threshold of θ degrees corresponds to `tan θ` metres per metre, and to `tan θ * cellSize / heightRange` height units per texel.
3. The inspector shows and accepts the metric equivalent of `'length'` and `'height'` values (typing `500m` on a 5 km terrain stores 0.1). That is display only; nodes always receive the stored value.
4. Because lengths are fractions of the terrain and heights are normalised, a graph gives the same shape at any `terrainSize` and `heightRange`, except where physical slope enters.

### 1.7 Value conventions

**Heights.** Heights are normalised: 0 is the bottom of the height range and 1.0
equals `heightRange` metres. Values outside 0..1 are legal inside the graph and
are handled at export.

- The primary output of a generator (a node without required inputs whose `outputs[0]` has role `'height'`) is nominally 0..1: at default parameters, for any seed, it lies within −0.05..1.05, spans at least 0.5 and has a mean between 0.25 and 0.75.
- Normalisation is analytic or uses fixed constants compiled into the kernel. It never depends on the resolution or on measured statistics.
- Whole-field statistics (`ctx.stats`, `ops.minMax`) may influence an output only in a node that declares `resolutionDependent: true` (4.6).
- Filters accept any finite input and do not clamp unless clamping is their documented job.

**Masks.** A mask is a `field` on a port with `role: 'mask'`. 0 means unaffected,
1 means fully affected.

- A producer saturates before storing: every texel of a mask output is in 0..1 exactly.
- A consumer saturates on reading. In a kernel, declare the input with `MASK_INPUT` (3.1), whose accessors return `saturate(value)`.
- An unconnected mask input reads 1 on every texel.

**Data.** A `field` on a port with `role: 'data'` carries a quantity with its own
documented meaning and range (flow accumulation, material moved, an angle). It
is finite; nothing else is assumed.

**Roles are not types.** Any `field` output connects to any `field` input. A role
fixes what the producer guarantees and how the consumer reads; the evaluator
converts nothing between roles.

**Colour.** `color` fields hold linear RGB with straight (not premultiplied)
alpha. Alpha is 1 unless the node documents otherwise. Colour parameters and
gradient stops are stored in linear RGB; the inspector converts for display.

**Non-finite values.** No kernel stores NaN or infinity. A kernel guards every
division, `sqrt`, `log`, `pow` and `normalize` whose argument can leave its
domain.

### 1.8 Coordinates and directions

| Quantity | Convention |
| --- | --- |
| `px` | `vec2i`; `px.x` is the column and `px.y` the row; texel (0,0) is the first texel of the first row of `ctx.read()` data |
| `uv` | `px / (res − 1)`; the terrain coordinate. A length (1.6) is a distance in `uv` |
| +X, +Y, +Z | +X = increasing `px.x`; +Y = increasing `px.y`; +Z = up. Drawn as Orogen and Unreal draw it (row 0 at the top, +X to the right, +Y down the screen, +Z towards the viewer) this frame is left-handed, as Unreal's is (`export-unreal.md` 5.7) |
| Direction angle θ | the unit vector `(cos θ, sin θ)` in (X, Y): 0° = +X, 90° = +Y. Increasing θ is the turn from +X towards +Y, which appears clockwise in every top view |
| Meaning of a direction | where things go: the direction of motion, or of increasing value for a gradient. A wind direction is where the wind blows to. A light direction points from the terrain towards the light |
| Gradient of a height | `(∂z/∂x, ∂z/∂y)` in metres per metre (`slopeAt`, 3.8) |
| Normal | `normalize(vec3f(−∂z/∂x, −∂z/∂y, 1))`, +Z up |

Every picture of a field shows this frame the same way: thumbnails, test
previews, the viewport's top view and exported images all put texel (0,0) at
the top left, and nothing is flipped anywhere between a field and a file. How
the frame maps to Unreal's axes is `export-unreal.md`'s subject. Nodes work in
the frame above only.

### 1.9 Resolution rules for nodes

The same graph is evaluated at several ladder levels. A node obeys:

1. A generator is a pure function of `uv`, its parameters and its seed. It positions features with `uv`, never with `px`, and never reads `frame.res` or `frame.cellSize`. Its octave count and feature sizes do not depend on the resolution.
2. Neighbourhood sizes are `'length'` parameters converted with `ctx.lengthToPx()`. A filter whose radius in texels is below the size at which it has an effect passes its input through.
3. Slopes and gradients are physical (1.6).
4. Simulations scale their time steps and iteration counts with the cell size as `simulation.md` prescribes.
5. Randomness comes from integer hashes of lattice coordinates and the seed (3.9): never from `px`, from `fract(sin(x))`, from `Math.random()` or from the time. One exception: a simulation of `simulation.md` hashes the texel index of the level it is simulating, as `simulation.md` 1.4 prescribes; such numbers are not expected to agree between levels.
6. Nothing depends on whether the evaluation is a preview or a build.

`testing.md` states how these rules are tested and with which tolerances.

---

## 2. The Frame uniform

Every kernel sees this uniform as `frame`, at `@group(0) @binding(0)`. The
framework fills it for each run.

```wgsl
struct Frame {
  res: vec2u,          // offset  0  size of the grid this run writes, in texels (res.x == res.y)
  tileOrigin: vec2u,   // offset  8  first texel of this dispatch; framework use only (3.15)
  terrainSize: f32,    // offset 16  metres across the terrain
  cellSize: f32,       // offset 20  metres between neighbouring texels of the written grid
  heightRange: f32,    // offset 24  metres represented by height 1.0
  seed: u32,           // offset 28  mixSeed(project seed, node seed) (4.8)
  iteration: u32,      // offset 32  loop index inside ctx.loop, else 0, unless the run overrides it
  bound: u32,          // offset 36  bit i is set when declared input i is bound to a field
};                     // size 40, alignment 8
@group(0) @binding(0) var<uniform> frame: Frame;
```

- `frame.res` is the size of the run's first non-null writable target (3.11), not `ctx.res`. A run that writes a half-resolution temporary sees that grid's `res` and `cellSize = terrainSize / max(res.x − 1, 1)`.
- Author code never reads `frame.tileOrigin` and never tests `frame.bound` directly (use `<input>_bound()`, 3.2).
- The struct is fixed. A value a kernel needs beyond it is passed as a kernel param.

---

## 3. Kernels

A kernel is one compute pipeline plus the declarations needed to bind it. The
author declares resources and writes WGSL; the framework generates the WGSL
declarations, typed accessors, the entry point (map mode), an explicit bind
group layout (never `layout: 'auto'`), the uniform packing and the dispatch.

### 3.1 `defineKernel`

```ts
type UniformType = 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec3f' | 'vec4f' | 'vec2i' | 'vec2u';
type Rgba = readonly [number, number, number, number];

interface InputOptions {
  readonly kind: FieldKind;
  readonly default?: number | Rgba;   // presence makes the input optional; an unbound input reads this value
  readonly saturate?: boolean;        // accessors return saturate(value); default false
  readonly size?: 'grid' | 'any';     // default 'grid'
}
type InputDecl = FieldKind | InputOptions;            // a bare kind is { kind } : required, size 'grid'

/** The declaration of a mask input: optional, reads 1 when unbound, saturated on read. */
declare const MASK_INPUT: { readonly kind: 'field'; readonly default: 1; readonly saturate: true };

interface KernelDef {
  readonly name: string;
  readonly inputs?: Readonly<Record<string, InputDecl>>;
  readonly outputs?: Readonly<Record<string, FieldKind>>;
  readonly inPlace?: Readonly<Record<string, 'field'>>;
  readonly unsafeReadWrite?: Readonly<Record<string, 'field'>>;
  readonly raceFree?: string;
  readonly params?: Readonly<Record<string, UniformType>>;
  readonly luts?: Readonly<Record<string, 'f32' | 'vec4f'>>;
  readonly includes?: readonly WgslLib[];
  readonly mode?: 'map' | 'raw';
  readonly workgroup?: readonly [number, number];
  readonly tiled?: boolean;
  readonly cost?: number;
  readonly code: string;
}

interface Kernel<I = {}, O = {}, W = {}, U = {}, P = {}, L = {}> {
  readonly name: string;
  readonly def: KernelDef;
  /** Type-level only: the declared inputs, outputs, inPlace, unsafeReadWrite, params and luts. */
  readonly __shape?: { i: I; o: O; w: W; u: U; p: P; l: L };
}
type AnyKernel = Kernel<any, any, any, any, any, any>;

declare function defineKernel<
  const I extends Record<string, InputDecl> = {},
  const O extends Record<string, FieldKind> = {},
  const W extends Record<string, 'field'> = {},
  const U extends Record<string, 'field'> = {},
  const P extends Record<string, UniformType> = {},
  const L extends Record<string, 'f32' | 'vec4f'> = {},
>(def: {
  name: string; inputs?: I; outputs?: O; inPlace?: W; unsafeReadWrite?: U; raceFree?: string; params?: P; luts?: L;
  includes?: readonly WgslLib[]; mode?: 'map' | 'raw'; workgroup?: readonly [number, number]; tiled?: boolean; cost?: number;
  code: string;
}): Kernel<I, O, W, U, P, L>;
```

| Member | Default | Meaning |
| --- | --- | --- |
| `name` | required | Unique in the process. `<category>/<node name>[.<pass>]` for a kernel of one node, `<category>/<module>[.<pass>]` for a kernel shared inside a category (`simulate/talus.step`), optionally followed by `#<variant>` (3.6): `filter/blur.h#color`. Appears in every error message and as the GPU label |
| `inputs` | `{}` | Fields the kernel reads. At most 16 |
| `outputs` | `{}` | Fields the kernel writes without reading |
| `inPlace` | `{}` | `field`s the kernel reads and writes at the invocation's own texel only (3.5) |
| `unsafeReadWrite` | `{}` | `field`s exposed as raw `read_write` storage textures. Raw mode only; requires `raceFree` (3.5) |
| `raceFree` | none | Written justification of why no invocation reads a texel that another invocation of the same run writes |
| `params` | `{}` | Members of `struct Params`, bound as `P` (3.10) |
| `luts` | `{}` | Read-only tables (4.9). At most 8 |
| `includes` | `[]` | WGSL libraries (3.7) |
| `mode` | `'map'` | `'map'` (3.3) or `'raw'` (3.4) |
| `workgroup` | `[8, 8]` | Workgroup size; `x * y ≤ 256` |
| `tiled` | `true` | `false` forces one dispatch per run (3.15) |
| `cost` | `8` | Texture loads per texel (3.15); a run may override it |
| `code` | required | Author WGSL |

The type parameters carry only the binding shapes, so two kernels with the same
declarations have the same type and are interchangeable.

### 3.2 Generated WGSL

The framework assembles one WGSL module per kernel, in this order:

1. `struct Frame` and `frame` (section 2).
2. `struct Params` and `P`, when the kernel declares params.
3. One group-1 binding per declared resource, numbered from 0 in this order: inputs, outputs, inPlace, unsafeReadWrite, luts; within each, declaration order.
4. In map mode, unless the kernel has exactly one output and no in-place target: `struct Out`, and `struct Cur` when in-place targets exist (3.3).
5. The standard library (3.8).
6. Accessors for the declared resources (table below).
7. Each included library once, after its dependencies (3.7).
8. The author's `code`.
9. In map mode, the entry point.

For a resource named `x` the framework generates:

| Declared as | Binding | Names visible to author code |
| --- | --- | --- |
| input, 1 channel | `var x: texture_2d<f32>;` | `x` (only as an argument to a function that takes a texture), `alias x_t = f32`, and the accessors below returning `f32` |
| input, 2 channels | same | the same with `vec2f` |
| input, 4 channels | same | the same with `vec4f` |
| output of kind `K` | `var _o_x: texture_storage_2d<FORMAT(K), write>;` | `alias x_t = f32 \| vec2f \| vec4f`; `fn x_set(v: x_t)`, which author code calls in raw mode only |
| inPlace | `var _ip_x: texture_storage_2d<r32float, read_write>;` | map mode: `cur.x` and the `x` member of `Out`; raw mode: `fn x_get() -> f32`, `fn x_set(v: f32)` |
| unsafeReadWrite | `var x: texture_storage_2d<r32float, read_write>;` | `x` |
| lut of type `T` | `var<storage, read> _lut_x: array<T>;` | `fn x_at(t: f32) -> T`, `fn x_item(i: u32) -> T`, `fn x_len() -> u32` |

Input accessors, for an input `x` with value type `T`:

| Accessor | Semantics |
| --- | --- |
| `fn x_at(p: vec2i) -> T` | The texel at `p` in the input's own texels, with `p` clamped to the input's own size. An unbound input returns its default for every `p` |
| `fn x_uv(uv: vec2f) -> T` | Bilinear at terrain coordinate `uv`: `x_lerp(uv * (size − 1))`. Works for an input of any size |
| `fn x_lerp(t: vec2f) -> T` | Bilinear at the fractional texel position `t` in the input's own texels, clamped to `[0, size − 1]`. At an integer position it returns that texel exactly |
| `fn x_res() -> vec2u` | The input's size in texels; (1,1) when unbound |
| `fn x_bound() -> bool` | Whether a field is bound to the input in this run |

With `saturate: true`, `x_at`, `x_uv` and `x_lerp` return `saturate(...)` of the value above.

`x_set(v)` stores at the invocation's own texel: `f32` as `vec4f(v, 0, 0, 1)`,
`vec2f` as `vec4f(v, 0, 1)`, `vec4f` unchanged. `x_get()` loads the own texel.
`x_set` and `x_get` are generated in both modes, because the map-mode entry
point calls them; map-mode author code may not (3.3).

LUT accessors, for a table of length `n ≥ 1`: `x_at(t)` returns the table
linearly interpolated at position `saturate(t) * (n − 1)`; `x_item(i)` returns
element `min(i, n − 1)`; `x_len()` returns `n`. For a lut `x` of type `T` the
generated text is:

```wgsl
fn x_len() -> u32 { return arrayLength(&_lut_x); }
fn x_item(i: u32) -> T { return _lut_x[min(i, x_len() - 1u)]; }
fn x_at(t: f32) -> T {
  let _x = saturate(t) * f32(x_len() - 1u);
  let _i = u32(floor(_x));
  return mix(x_item(_i), x_item(_i + 1u), _x - floor(_x));
}
```

Bind group layouts are explicit and identical in shape for every kernel:

| Binding | Layout entry |
| --- | --- |
| group 0, binding 0 (`frame`) and 1 (`P`) | `{ buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 256 } }`; one layout shared by all kernels, with or without params |
| input, any kind | `{ texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } }` |
| output | `{ storageTexture: { access: 'write-only', format, viewDimension: '2d' } }` |
| inPlace, unsafeReadWrite | `{ storageTexture: { access: 'read-write', format: 'r32float', viewDimension: '2d' } }` |
| lut | `{ buffer: { type: 'read-only-storage' } }` |

Example. For the kernel `ref/talus.step` of section 6.2, declared with
`inputs: { h: 'field' }`, `outputs: { next: 'field' }`, `inPlace: { moved: 'field' }`,
`params: { talus: 'f32', rate: 'f32' }`, the generated module is:

```wgsl
struct Frame { /* section 2 */ };
@group(0) @binding(0) var<uniform> frame: Frame;
struct Params {
  talus: f32,
  rate: f32,
};
@group(0) @binding(1) var<uniform> P: Params;
@group(1) @binding(0) var h: texture_2d<f32>;
@group(1) @binding(1) var _o_next: texture_storage_2d<r32float, write>;
@group(1) @binding(2) var _ip_moved: texture_storage_2d<r32float, read_write>;
struct Out {
  next: f32,
  moved: f32,
};
struct Cur {
  moved: f32,
};

/* standard library, section 3.8 */

alias h_t = f32;
fn h_at(p: vec2i) -> f32 { return ld(h, p); }
fn h_uv(uv: vec2f) -> f32 { return bilinear(h, uv); }
fn h_lerp(t: vec2f) -> f32 { return bilinearPx(h, t); }
fn h_res() -> vec2u { return textureDimensions(h); }
fn h_bound() -> bool { return (frame.bound & 1u) != 0u; }
alias next_t = f32;
fn next_set(v: f32) { textureStore(_o_next, _px, vec4f(v, 0.0, 0.0, 1.0)); }
fn moved_get() -> f32 { return textureLoad(_ip_moved, _px).r; }
fn moved_set(v: f32) { textureStore(_ip_moved, _px, vec4f(v, 0.0, 0.0, 1.0)); }

/* author code: fn exchange(...), fn compute(px, uv, cur) -> Out */

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) _gid: vec3u) {
  if (!beginPixel(_gid)) { return; }
  let _o = compute(_px, uvOf(_px), Cur(moved_get()));
  next_set(_o.next);
  moved_set(_o.moved);
}
```

For a kernel with exactly one output `out` and no in-place target there is no
`Out` and no `Cur`, and the body of the entry point is:

```wgsl
  if (!beginPixel(_gid)) { return; }
  out_set(compute(_px, uvOf(_px)));
```

Rules for author code, enforced by `defineKernel` (3.13):

1. Author code never calls `textureLoad`, `textureStore`, `textureDimensions` or `textureNumLevels` on anything but an `unsafeReadWrite` name, and never calls a `textureSample*` or `textureGather*` function.
2. Author code uses no identifier that begins with an underscore.
3. Author code contains no `@group`, `@binding`, `override`, `enable`, `requires` or `diagnostic`, and does not mention `tileOrigin`, `local_invocation_id`, `local_invocation_index`, `workgroup_id` or `num_workgroups`.
4. Names declared at module scope by author code (`fn`, `struct`, `const`, `var`, `alias`) must not be a standard library name, a generated name (`Frame`, `Params`, `P`, `frame`, `Out`, `Cur`, `main`, and `compute` in raw mode), a name of the form `<resource>_<suffix>` for a declared resource, or begin with `<library>_` for an included library.

### 3.3 Map mode

Map mode covers every kernel that computes one value per texel for each of its
targets. The framework owns the entry point, the bounds check, the tile origin
and the stores. The author writes `compute`:

```wgsl
// exactly one output and no inPlace target: return the bare value
fn compute(px: vec2i, uv: vec2f) -> f32        // output of a 1-channel kind
fn compute(px: vec2i, uv: vec2f) -> vec2f      // 2-channel kind
fn compute(px: vec2i, uv: vec2f) -> vec4f      // 4-channel kind

// several outputs, no inPlace target
fn compute(px: vec2i, uv: vec2f) -> Out

// any number of outputs (including none) and at least one inPlace target
fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out
```

- `px` is the texel being written and `uv = uvOf(px)` its terrain coordinate.
- `struct Out` has one member per output, then one per inPlace target, in declaration order, each with the target's value type. `struct Cur` has one `f32` member per inPlace target holding its current value at `px`.
- `compute` is called exactly once for every texel of the written grid, and every member of the returned `Out` is stored. To leave an in-place value unchanged, return `cur.x` for it.
- In map mode the storage textures and the `x_set`/`x_get` functions are not available to author code; `defineKernel` rejects a call to them.
- A target bound to `null` (3.11) is still computed and its value discarded. The `cur` member of a target that may be `null` has an unspecified value and must not influence any other member of `Out`.
- `unsafeReadWrite` is not available in map mode.

### 3.4 Raw mode

Raw mode is for a kernel that is not one value per texel per target: it stores
conditionally, or it needs `unsafeReadWrite`. The author writes the entry point:

```wgsl
@compute @workgroup_size(8, 8)                                   // must equal KernelDef.workgroup
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (!beginPixel(gid)) { return; }                             // required first statement
  let px = pixel();                                             // the invocation's texel
  // read:  inputs through their accessors, in-place targets with x_get()
  // write: outputs and in-place targets with x_set(v), which store at px
}
```

- The entry point is named `main` and takes `global_invocation_id` only. `gid` is used for nothing but the call to `beginPixel`.
- The framework dispatches `ceil(res / workgroup)` workgroups over the written grid, possibly in several tiles (3.15). `beginPixel` adds the tile origin and returns false outside the grid.
- An invocation stores only to its own texel. Outputs and in-place targets can only be reached through `x_set`, which enforces this. A texel for which `x_set` is not called keeps its previous contents, so its field must have defined contents before the run.
- An `unsafeReadWrite` target is a plain variable. The author loads and stores it with `textureLoad(x, p).r` and `textureStore(x, p, vec4f(v, 0.0, 0.0, 1.0))` under the rules of 3.5.

### 3.5 In-place safety

Reading a neighbour of a texture that the same dispatch writes is a data race:
the result depends on scheduling, differs from run to run on one GPU, and
raises no error. The contract makes the race impossible to write by accident.

1. An `inPlace` target is readable and writable at the invocation's own texel only. The texture is not visible to author code.
2. A step that needs neighbouring values of the state it updates reads them from a different field: the other half of a ping-pong pair, or a `ctx.clone()` snapshot. It writes the new state to an output.
3. Only `field` can be an in-place target, on every device. There is no in-place access to other kinds and no automatic fallback.
4. A new field used as an in-place target is cleared first (`ctx.alloc(kind, { clear })` or `ctx.clear`).
5. `unsafeReadWrite` gives raw access. It requires `mode: 'raw'` and a `raceFree` string of at least 20 characters that states why no invocation loads a texel that another invocation of the same run stores. Example: `'red-black: an invocation stores only where (x + y + parity) is even and loads only where it is odd'`. The property must hold for every legal parameter value; it also makes tiling safe.
6. Every kernel, in-place or not, gives bit-identical results when run twice on the same inputs on one device, and the same results whether or not its runs are split into tiles (3.14).

```ts
// unsafeReadWrite in its typical use: one half-step of a two-colour relaxation.
// (A ping-pong step with an in-place accumulator, the normal case, is in 6.2.)
const relax = defineKernel({
  name: 'ref/relax.half',
  mode: 'raw',
  unsafeReadWrite: { g: 'field' },
  raceFree: 'red-black: an invocation stores only where (x + y + parity) is even and loads only where it is odd',
  params: { parity: 'u32' },
  code: /* wgsl */ `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (!beginPixel(gid)) { return; }
  let px = pixel();
  if (((u32(px.x) + u32(px.y) + P.parity) & 1u) != 0u) { return; }
  let e = textureLoad(g, clampToGrid(px + vec2i(1, 0))).r;
  let w = textureLoad(g, clampToGrid(px - vec2i(1, 0))).r;
  let n = textureLoad(g, clampToGrid(px + vec2i(0, 1))).r;
  let s = textureLoad(g, clampToGrid(px - vec2i(0, 1))).r;
  textureStore(g, px, vec4f(0.25 * (e + w + n + s), 0.0, 0.0, 1.0));
}`,
});
```

### 3.6 Variants

There is one mechanism: a variant is an ordinary kernel made by calling a
module-scope function once per variant key.

```ts
const box3 = (kind: 'field' | 'color') => defineKernel({
  name: `ref/box3#${kind}`,
  inputs: { src: kind, mask: MASK_INPUT },
  outputs: { out: kind },
  params: { dir: 'vec2i' },
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> out_t {
  let blurred = (src_at(px - P.dir) + src_at(px) + src_at(px + P.dir)) / 3.0;
  return mix(src_at(px), blurred, mask_at(px));
}`,
});
const box3Kernels = { field: box3('field'), color: box3('color') };
// NodeDef.kernels: [box3Kernels.field, box3Kernels.color]
// evaluate():       ctx.run(box3Kernels[src.kind], { ... })
```

- Each variant has its own name `<base>#<key>` and is listed in `NodeDef.kernels`.
- The aliases `x_t` let one body serve several kinds: write `-> out_t`, `var acc = out_t(0.0);`.
- A code path selected by an enum is either a variant per value (string interpolation in the factory) or a `u32` param tested in WGSL. Prefer the param unless the paths differ in bindings.
- There are no `override` constants, no preprocessor, and no kernel creation at run time.
- Because the factory's parameter has a union type, all variants share one TypeScript type and `ctx.run` accepts a field of either kind; `run()` checks the actual kind (3.13).

### 3.7 WGSL libraries

```ts
interface WgslLib {
  readonly name: string;
  readonly code: string;
  readonly deps: readonly WgslLib[];
}
declare function defineLib(def: { name: string; code: string; deps?: readonly WgslLib[] }): WgslLib;
```

1. `name` matches `/^[a-z][A-Za-z0-9]*$/` and is unique. Two different library objects with one name is an error.
2. Every identifier a library declares at module scope (`fn`, `struct`, `const`, `alias`) begins with `<name>_`. `defineLib` checks this.
3. A library is emitted once per kernel however it is reached, after its `deps`.
4. Library code may use `frame`, the standard library and its dependencies. It takes textures as `texture_2d<f32>` function parameters and reads them with `ld`, `bilinear` and the other functions of 3.8. It never refers to a kernel's bindings, to `P`, to an accessor, or to an underscore name, and declares no `var`, `override` or entry point.
5. Core libraries live in `src/core/wgsl/` and are changed only through the integrator (`testing.md`). Their names are reserved: `hash`, `noise` (3.9).
6. A node category may define private libraries in its own folder. Their names begin with the category id: `simulateTalus`, `filterKernel`.
7. A helper used by a single kernel stays in that kernel's `code`. A helper shared by kernels of one node is a private library.

### 3.8 The standard library

The standard library is part of every kernel. Its names are frozen; adding one
is a change to this document. The text below is normative.

```wgsl
var<private> _px: vec2i;

// ---- the invocation's texel -------------------------------------------------
// Sets the invocation's texel from the dispatch id and the tile origin.
// Returns false when it lies outside the written grid. Raw mode calls it once, first.
fn beginPixel(gid: vec3u) -> bool {
  let p = gid.xy + frame.tileOrigin;
  _px = vec2i(p);
  return all(p < frame.res);
}
// The invocation's texel. Valid after beginPixel.
fn pixel() -> vec2i { return _px; }

// ---- the written grid -------------------------------------------------------
// True when p is a texel of the written grid.
fn inGrid(p: vec2i) -> bool { return all(p >= vec2i(0)) && all(p < vec2i(frame.res)); }
// p clamped to the written grid.
fn clampToGrid(p: vec2i) -> vec2i { return clamp(p, vec2i(0), vec2i(frame.res) - vec2i(1)); }
// Terrain coordinate of texel p of the written grid: p / (res - 1).
fn uvOf(p: vec2i) -> vec2f { return vec2f(p) / vec2f(max(frame.res, vec2u(2u)) - vec2u(1u)); }
// Position of texel p of the written grid in metres.
fn metresOf(p: vec2i) -> vec2f { return uvOf(p) * frame.terrainSize; }

// ---- texture reads, for library code that receives a texture ---------------
// Texel p of t, with p clamped to t's own size. A 1x1 texture is a constant.
fn ld(t: texture_2d<f32>, p: vec2i) -> f32 { return textureLoad(t, clamp(p, vec2i(0), vec2i(textureDimensions(t)) - vec2i(1)), 0).r; }
fn ld2(t: texture_2d<f32>, p: vec2i) -> vec2f { return textureLoad(t, clamp(p, vec2i(0), vec2i(textureDimensions(t)) - vec2i(1)), 0).rg; }
fn ld4(t: texture_2d<f32>, p: vec2i) -> vec4f { return textureLoad(t, clamp(p, vec2i(0), vec2i(textureDimensions(t)) - vec2i(1)), 0); }
// A mask value: saturate(ld(t, p)).
fn ldMask(t: texture_2d<f32>, p: vec2i) -> f32 { return saturate(ld(t, p)); }

// Bilinear at the fractional texel position x, in t's own texels, clamped to [0, size - 1].
fn bilinearPx4(t: texture_2d<f32>, x: vec2f) -> vec4f {
  let c = clamp(x, vec2f(0.0), vec2f(textureDimensions(t)) - vec2f(1.0));
  let i = vec2i(floor(c));
  let f = c - floor(c);
  return mix(mix(ld4(t, i), ld4(t, i + vec2i(1, 0)), f.x), mix(ld4(t, i + vec2i(0, 1)), ld4(t, i + vec2i(1, 1)), f.x), f.y);
}
fn bilinearPx2(t: texture_2d<f32>, x: vec2f) -> vec2f { return bilinearPx4(t, x).rg; }
fn bilinearPx(t: texture_2d<f32>, x: vec2f) -> f32 { return bilinearPx4(t, x).r; }
// Bilinear at terrain coordinate uv. uv 0..1 spans t's first to last texel:
// texel position = uv * (size - 1). Never uv * size - 0.5.
fn bilinear4(t: texture_2d<f32>, uv: vec2f) -> vec4f { return bilinearPx4(t, uv * (vec2f(textureDimensions(t)) - vec2f(1.0))); }
fn bilinear2(t: texture_2d<f32>, uv: vec2f) -> vec2f { return bilinear4(t, uv).rg; }
fn bilinear(t: texture_2d<f32>, uv: vec2f) -> f32 { return bilinear4(t, uv).r; }

// ---- terrain shape ----------------------------------------------------------
// Gradient (dz/dx, dz/dy) of the height texture t at texel p, in metres per metre.
// Central difference; one-sided on t's border. The cell size is taken from t's own
// size, so t may have any resolution. Heights are multiplied by frame.heightRange.
fn slopeAt(t: texture_2d<f32>, p: vec2i) -> vec2f {
  let last = vec2i(textureDimensions(t)) - vec2i(1);
  let q = clamp(p, vec2i(0), last);
  let lo = max(q - vec2i(1), vec2i(0));
  let hi = min(q + vec2i(1), last);
  let d = vec2f(ld(t, vec2i(hi.x, q.y)) - ld(t, vec2i(lo.x, q.y)), ld(t, vec2i(q.x, hi.y)) - ld(t, vec2i(q.x, lo.y)));
  let run = vec2f(max(hi - lo, vec2i(1))) * (frame.terrainSize / vec2f(max(last, vec2i(1))));
  return d * frame.heightRange / run;
}
// Unit surface normal, +Z up: normalize(vec3f(-dz/dx, -dz/dy, 1)).
fn normalAt(t: texture_2d<f32>, p: vec2i) -> vec3f { let s = slopeAt(t, p); return normalize(vec3f(-s.x, -s.y, 1.0)); }

// ---- seeds ------------------------------------------------------------------
fn _pcg(x: u32) -> u32 {
  let s = x * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Combines two seeds. Identical to the TypeScript mixSeed (4.8).
fn mixSeed(a: u32, b: u32) -> u32 { return _pcg(_pcg(a) + b); }
// A sub-seed of the node's seed, decorrelated for each stream number.
fn seedFor(stream: u32) -> u32 { return mixSeed(frame.seed, stream); }
```

All reads clamp to the edge: a neighbour outside a texture reads the border
texel. A kernel that must treat the border differently tests `inGrid(q)`.

Node kernels read their inputs through the generated accessors (3.2), which call
these functions. The texture-taking functions exist for library code and for
`slopeAt(x, p)` and `normalAt(x, p)`, to which an input `x` is passed by name.
They accept inputs only; an in-place target cannot be passed to them.

### 3.9 Core libraries

```ts
declare const hash: WgslLib;
declare const noise: WgslLib;    // deps: [hash]
```

**`hash`** — integer hashing (PCG). The text is normative; `api.ts` exports
TypeScript twins `hashU32(x)`, `hashCell(x, y, seed)` and `hashUnit(h)` that
return the same values (4.8).

```wgsl
fn hash_u32(x: u32) -> u32 {
  let s = x * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Hash of an integer lattice cell and a seed. Negative coordinates are valid.
fn hash_cell(c: vec2i, seed: u32) -> u32 {
  return hash_u32(bitcast<u32>(c.x) + hash_u32(bitcast<u32>(c.y) + hash_u32(seed)));
}
// Uniform float in [0, 1) from the top 24 bits; exact.
fn hash_unit(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
// Two independent uniform floats in [0, 1).
fn hash_unit2(h: u32) -> vec2f { return vec2f(hash_unit(h), hash_unit(hash_u32(h))); }
```

**`noise`** (depends on `hash`) — lattice noise. `p` is in lattice units: one
cell is 1.0, so a feature size `size` (a length) is `p = uv / size`. The
lattice is unbounded and not periodic. Every function is a function of `p` and
`seed` only and uses integer hashing of `floor(p)`. The text of the library is
`src/core/wgsl/noise.ts`; that file is the definition, and the table below
states what it must satisfy.

| Function | Result |
| --- | --- |
| `noise_value(p: vec2f, seed: u32) -> f32` | value noise in [0, 1]; quintic interpolation of `hash_unit` at the four cell corners |
| `noise_gradient(p: vec2f, seed: u32) -> f32` | gradient noise in [−1, 1]; unit gradients, quintic interpolation, scaled by √2; 0 at lattice points |
| `noise_gradientD(p: vec2f, seed: u32) -> vec3f` | `.x` = `noise_gradient(p, seed)`; `.yz` = its analytic derivative with respect to `p` |
| `noise_worley(p: vec2f, seed: u32) -> vec2f` | `(F1, F2)`: distances in lattice units to the nearest and second nearest feature point, one jittered point per cell; `0 ≤ F1 ≤ √2` |
| `noise_fbm(p: vec2f, seed: u32, octaves: i32, lacunarity: f32, gain: f32) -> f32` | `Σ gainⁱ · noise_gradient(p · lacunarityⁱ, mixSeed(seed, i)) / Σ gainⁱ` for `i = 0 .. octaves − 1`; in [−1, 1]; `octaves` is clamped to 1..16 |

The ranges are analytic bounds, not typical ranges. A generator that must meet
the range rule of 1.7 applies its own fixed gain.

Other shared WGSL (blend modes, signed distances, curve shaping) is added to
`src/core/wgsl/` through the integrator as nodes need it, under these rules.

### 3.10 Params

Kernel params are packed into `struct Params` in declaration order with the WGSL
layout rules. The generated struct and the packer walk the same list; nothing is
reordered.

| Type | Alignment | Size | JS value |
| --- | --- | --- | --- |
| `f32` | 4 | 4 | a finite number |
| `i32` | 4 | 4 | an integer in −2^31 .. 2^31 − 1, or a boolean (true = 1) |
| `u32` | 4 | 4 | an integer in 0 .. 2^32 − 1, or a boolean (true = 1) |
| `vec2f` | 8 | 8 | an array of exactly 2 finite numbers |
| `vec2i` | 8 | 8 | an array of exactly 2 integers |
| `vec2u` | 8 | 8 | an array of exactly 2 non-negative integers |
| `vec3f` | 16 | 12 | an array of exactly 3 finite numbers |
| `vec4f` | 16 | 16 | an array of exactly 4 finite numbers |

```ts
const WGSL_LAYOUT = {
  f32: [4, 4], i32: [4, 4], u32: [4, 4], vec2f: [8, 8], vec2i: [8, 8], vec2u: [8, 8], vec3f: [16, 12], vec4f: [16, 16],
} as const;   // [alignment, size]

function packLayout(params: Record<string, UniformType>) {
  let cursor = 0, maxAlign = 4;
  const fields: { name: string; type: UniformType; offset: number }[] = [];
  for (const [name, type] of Object.entries(params)) {
    const [align, size] = WGSL_LAYOUT[type];
    const offset = Math.ceil(cursor / align) * align;
    fields.push({ name, type, offset });
    cursor = offset + size;
    maxAlign = Math.max(maxAlign, align);
  }
  return { fields, size: Math.ceil(cursor / maxAlign) * maxAlign };
}
```

Examples: `{ a: 'vec3f', b: 'f32' }` puts `a` at 0 and `b` at 12, size 16;
`{ a: 'f32', b: 'vec3f' }` puts `b` at 16, size 32;
`{ a: 'f32', b: 'vec2f', c: 'f32' }` gives offsets 0, 8, 16, size 24.

- `size` must not exceed 256 bytes.
- A kernel without params has no `Params` struct and no `P`. WGSL has no `bool` uniform; a boolean is a `u32`.
- Params are captured by value when `ctx.run()` is called. Changing the object afterwards has no effect on that run.
- A params object built outside the `ctx.run` call needs `as const` for its vectors: `{ dir: [1, 0] }` is otherwise typed `number[]`, which the binding type rejects.
- Param names are struct members. They match `/^[a-z][A-Za-z0-9]*$/` and are not WGSL keywords or reserved words (`type`, `filter`, `smooth`, `target`, `from`, `default`, `active`, `pass`, `precision` are rejected). Struct members do not shadow builtins, so `min`, `max`, `step`, `mix`, `scale` and `mode` are legal here.

### 3.11 Running a kernel

```ts
interface Lut<T extends 'f32' | 'vec4f' = 'f32' | 'vec4f'> {
  readonly type: T;
  readonly length: number;      // elements
}

type UniformValue<T> =
  T extends 'f32' ? number
  : T extends 'i32' | 'u32' ? number | boolean
  : T extends 'vec2f' | 'vec2i' | 'vec2u' ? readonly [number, number]
  : T extends 'vec3f' ? readonly [number, number, number]
  : T extends 'vec4f' ? Rgba
  : never;

type Kind1 = 'field' | 'half' | 'mask8';
type Kind2 = 'vec2' | 'half2';
type Kind4 = 'color' | 'aux';
/** The kinds with the same channel count as K. */
type SameShape<K extends FieldKind> = K extends Kind1 ? Kind1 : K extends Kind2 ? Kind2 : Kind4;

type KindOfInput<D> = D extends FieldKind ? D : D extends { kind: infer K extends FieldKind } ? K : never;
type OptionalInputs<I> = { [K in keyof I]: I[K] extends { default: number | Rgba } ? K : never }[keyof I];
type InBindings<I> =
  & { [K in Exclude<keyof I, OptionalInputs<I>>]: Field<SameShape<KindOfInput<I[K]>>> }
  & { [K in OptionalInputs<I>]?: Field<SameShape<KindOfInput<I[K]>>> | null };
/** `Key` is required when the kernel declares anything for it and forbidden otherwise. */
type Slot<Decl, Key extends string, Body> = [keyof Decl] extends [never] ? { [K in Key]?: undefined } : { [K in Key]: Body };

type RunBindings<I, O, W, U, P, L> =
  & Slot<I, 'in', InBindings<I>>
  & Slot<O, 'out', { [K in keyof O]: Field<O[K] & FieldKind> | null }>
  & Slot<W & U, 'rw', { [K in keyof W]: Field<'field'> | null } & { [K in keyof U]: Field<'field'> }>
  & Slot<P, 'params', { [K in keyof P]: UniformValue<P[K]> }>
  & Slot<L, 'luts', { [K in keyof L]: Lut<L[K] & ('f32' | 'vec4f')> }>
  & { iteration?: number; cost?: number };
```

`ctx.run(kernel, bindings)` (4.7) validates the bindings (3.13), then encodes
the run. It is synchronous, never blocks, and performs no GPU work itself.

| Slot | Entries | Rules |
| --- | --- | --- |
| `in` | every input | An input declared with a bare kind or without `default` must be given a field. An input with a `default` may be omitted or `null`: it is then bound to a framework-owned 1 × 1 texture holding the default (a number fills every channel) |
| `out` | every output | A field, or `null` to discard the output |
| `rw` | every `inPlace` and `unsafeReadWrite` name | `inPlace`: a field, or `null` to discard. `unsafeReadWrite`: a field |
| `params` | every param | Exactly the declared names |
| `luts` | every lut | A `Lut` created by `ctx.lut()` in this evaluation |
| `iteration` | optional | Overrides `frame.iteration` for this run; an integer 0 .. 2^32 − 1 |
| `cost` | optional | Overrides `KernelDef.cost` for this run (3.15) |

- **Kinds.** An input accepts any field with the declared channel count (`field`, `half` and `mask8` are interchangeable as inputs, as are `vec2` and `half2`, and `color` and `aux`). An output, in-place or unsafe target must have exactly the declared kind.
- **The written grid.** All non-null writable targets of a run have the same size and are square. That size is `frame.res`. A `null` target is bound to a framework-owned 1 × 1 sink, a distinct one per slot; its stores are discarded. A run whose writable targets are all `null` throws: skip the run instead.
- **Input sizes.** An input declared `size: 'grid'` (the default) must have the size of the written grid or be 1 × 1. An input declared `size: 'any'` may have any size, including non-square, and is read with `x_uv(uv)`.
- **Aliasing.** No field appears twice among the writable targets, and none of them appears among the inputs. The same field may be bound to several inputs. A field that is an output of one run may be an input of the next run: a ping-pong inside one batch is legal.
- **Read-only fields** cannot be bound to `out` or `rw`.

**Uniform data.** Group 0 is the same for every kernel. `frame` and `P` are
256-byte slots of one arena buffer, bound with dynamic offsets. `run()` copies
the run's Frame and Params bytes into the next free slots of a CPU-side copy of
the arena and encodes the offsets; the arena is uploaded once, immediately
before the encoded work is submitted. A run split into tiles uses one Frame slot
per tile. Consequently every run owns its `frame.iteration`, its seed and its
params, however many runs are batched into one submission, and passing
different params on every run costs nothing.

**Order.** Everything a node asks for takes effect in the order of the calls:
`ctx.run`, `ctx.clear`, `ctx.clone`, the shared ops, `ctx.write`, `ctx.read`,
`ctx.stats`. While runs are encoded but not yet submitted, nothing else touches
the GPU queue: an operation that acts on the queue (`ctx.write`, `ctx.read`,
`ctx.stats`, the pool destroying a texture) first submits what is encoded. A
node never needs to flush to get correct ordering.

### 3.12 Limits

Every kernel runs on a device with WebGPU default limits and no optional features.

| Limit | Value | Enforced by |
| --- | --- | --- |
| Writable textures per kernel (outputs + inPlace + unsafeReadWrite) | at least 1, at most 4 | `defineKernel` |
| Inputs per kernel | 16 | `defineKernel` |
| LUTs per kernel | 8 | `defineKernel` |
| `Params` size | 256 bytes | `defineKernel` |
| Workgroup | `x * y ≤ 256` | `defineKernel` |
| LUT length | 1 .. 1 048 576 elements | `ctx.lut` |
| Field side | 1 .. 8192 texels | `ctx.alloc` |
| In-place access | `field` only | types and `defineKernel` |

A pass that needs more than four writable textures is split into two kernels.

WGSL language: author code uses core WGSL plus, at most, the language features
`readonly_and_readwrite_storage_textures`, `packed_4x8_integer_dot_product`,
`unrestricted_pointer_parameters` and `pointer_composite_access`. It uses no
`f16`, no subgroups, no atomics and no storage buffers other than LUTs.

### 3.13 Validation and errors

```ts
declare class KernelDefError extends Error {}       // defineKernel, defineLib
declare class NodeDefError extends Error {}         // defineNode, defineCpuTask
declare class KernelBindingError extends Error {}   // ctx.run
declare class FieldAccessError extends Error {}     // misuse of a field handle
```

**At module load.** `defineKernel` and `defineLib` throw `KernelDefError`.
Messages begin with `kernel "<name>": ` or `library "<name>": `.

| Check | Message after the prefix |
| --- | --- |
| Kernel name does not match `/^[a-z]+\/[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?(#[a-z0-9-]+)?$/` | `invalid kernel name` |
| A kernel with this name is already defined in the process | `a kernel with this name is already defined` |
| Resource name (input, output, inPlace, unsafeReadWrite, lut) does not match `/^[a-z][A-Za-z0-9]*$/` | `input name "Src" must match [a-z][A-Za-z0-9]*` |
| Resource name is a WGSL keyword or reserved word, a WGSL builtin function or predeclared type, a standard library name, or one of `frame`, `main`, `compute`, `cur`, `px`, `uv` | `input name "filter" is reserved in WGSL` / `output name "mix" would shadow a WGSL builtin` / `input name "ld" is a standard library name` |
| A name is used twice across inputs, outputs, inPlace, unsafeReadWrite and luts | `"h" is declared twice (inputs, outputs, inPlace, unsafeReadWrite and luts share one namespace)` |
| Param name invalid or a WGSL keyword or reserved word | `param name "type" is reserved in WGSL` |
| Limits of 3.12 | `5 writable textures (outputs + inPlace + unsafeReadWrite); the limit is 4` / `Params is 272 bytes; the limit is 256` |
| No writable target | `a kernel needs at least one output, inPlace or unsafeReadWrite target` |
| `unsafeReadWrite` without `mode: 'raw'`, or without a `raceFree` of at least 20 characters | `unsafeReadWrite requires mode "raw" and a raceFree justification` |
| Map mode: no `fn compute(`, or an `@compute` entry point, or a call to `x_set` / `x_get` | `map mode needs "fn compute("` / `map mode code may not call next_set(); return the value from compute` |
| Raw mode: no `fn main(`, `@workgroup_size` differs from `workgroup`, or no `if (!beginPixel(` | `raw mode main must start with "if (!beginPixel(gid)) { return; }"` |
| Rules 1 to 4 of 3.2 | `author code calls textureLoad on "src"; use src_at(p)` / `author code uses "_px"; names beginning with "_" are reserved` / `author code declares "ld", a standard library name` |
| Library identifier without the `<name>_` prefix | `library "noise": "fbm" must be named "noise_fbm"` |
| Two different libraries with one name among the includes | `two different libraries are named "hash"` |

Common trap: many natural names are unusable as resource names. Reserved in
WGSL: `filter`, `target`, `mod`, `smooth`, `type`, `from`, `set`, `ref`.
Builtins: `min`, `max`, `mix`, `step`, `length`, `distance`, `sign`, `round`,
`select`, `abs`, `pow`, `clamp`, `saturate`. Usable and conventional: `src`,
`in`, `out`, `mask`, `a`, `b`, `h`, `height`, `flow`, `water`, `sediment`,
`deposit`, `next`.

**Compilation.** The evaluator compiles every kernel listed in a node's
`NodeDef.kernels` before it calls `evaluate()`. A WGSL error fails the node and
is reported with the kernel name, the line and column in the author's own
`code`, and the surrounding source lines; an error located in a library or in
generated code names that origin (`runtime.md` defines the report).

**At `ctx.run()`.** `run()` validates synchronously, before encoding anything,
and throws `KernelBindingError`. Messages have the form
`kernel "<kernel>" (node <node id>, <node type>): <problem>. <remedy>`.

| Check | Problem and remedy |
| --- | --- |
| Kernel not in `NodeDef.kernels` | `is not listed in NodeDef.kernels` |
| Unknown name in a slot | `unknown binding in.height; the kernel declares inputs: h` |
| Missing required entry | `missing binding out.next. Pass a field, or null to discard the output` |
| Released field | `field #12 bound to input "h" was released` |
| Input channel count | `input "h" is declared "field" (1 channel) but field #12 is "color" (4 channels)` |
| Target kind | `output "next" is declared "field" but field #12 is "color"` |
| Read-only target | `rw "moved" is bound to field #9, which is read-only (a node input, or already passed to ctx.output()). Use ctx.clone()` |
| Aliasing | `field #17 is bound to input "h" and output "next". One run cannot read and write the same texture; write to another field and swap` |
| Target sizes | `output "next" is 257x257 but rw "moved" is 129x129. All writable targets of a run have the same size` |
| Non-square target | `output "next" is 300x200. Kernels write square grids` |
| Grid input size | `input "h" is 129x129 but the run writes 257x257. Declare the input with size: "any" and read it with h_uv(uv), or resample it first` |
| All targets null | `every writable target is null. Skip the run` |
| Params | `unknown param "strenght"; the kernel declares talus, rate` / `missing param "rate"` / `param "talus" is NaN` / `param "dir" needs 2 numbers, got 3` / `param "octaves" (i32) is 2.5` |
| LUT | `lut "ramp" is declared vec4f but the Lut is f32` / `lut "ramp" was not created in this evaluation` |

`run()` also throws, before encoding anything, when a kernel declared
`tiled: false` is estimated above the hard ceiling; the node then fails with
kind `'watchdog'` (`runtime.md` 3.4).

A GPU validation error that escapes these checks is attributed to the node whose
work was submitted and fails that node (`runtime.md`).

**Types.** `defineKernel` and `defineNode` infer names and kinds from their
arguments, so a misspelt binding, a missing param, a vector passed for a scalar,
a `color` field bound to a `field` output and a `null` bound to a required input
are compile errors as well. The runtime checks above remain authoritative,
because variant kernels (3.6) are typed by the union of their kinds.

### 3.14 Determinism

1. Run twice on the same inputs on one device, every kernel produces bit-identical output.
2. The output does not depend on how runs are batched into submissions, on how a run is split into tiles, or on the order in which invocations execute.
3. The output of a node depends only on its input fields, its parameters, `frame.seed`, `terrainSize`, `heightRange`, the settings it declares (4.15), the files its `externalKey` covers, and `ctx.res`. It does not depend on the time, on `Math.random()`, on earlier evaluations, on which outputs are wanted, or on whether the evaluation is a preview.
4. All hashing is integer (3.9). `fract(sin(x) * k)` and any hash built on float trigonometry are forbidden: they differ between GPU drivers.
5. Floating-point results are not bit-identical across adapters or backends (WGSL allows fused multiply-add and gives accuracy bounds, not exact results, for division and most builtins). Nothing may rely on exact float equality across devices; tests compare with tolerances (`testing.md`). Integer arithmetic is exact everywhere.
6. No kernel reads a texel it has not been given defined contents for (1.4 rule 2), and none relies on NaN or infinity propagating.

### 3.15 Tiling and the GPU watchdog

Windows resets a GPU whose single dispatch cannot be pre-empted for about two
seconds. The framework therefore splits one run into several dispatches
("tiles", horizontal bands of the written grid) whenever it estimates the run
to be long, and submits work in bounded batches (`runtime.md` defines the
targets). Tiling is invisible to a correctly written kernel:

1. A kernel takes its texel from `px` (map mode) or `pixel()` after `beginPixel(gid)` (raw mode). It never uses `global_invocation_id` for anything else and never reads `frame.tileOrigin`.
2. An invocation stores only to its own texel, and reads no texel that the same run writes, except its own texel of an in-place target. Map mode and the accessors guarantee this; `unsafeReadWrite` code must (3.5).
3. Loops in WGSL have a constant upper bound: a `const` maximum in the kernel, with the param clamped to it (`let n = clamp(P.taps, 1, MAX_TAPS);`).
4. `cost` is the number of texture loads one texel performs in the run, counting a bilinear read as 4 and one octave of library noise as 8. The kernel default is `KernelDef.cost` (8 when omitted). A run passes `cost` whenever the count depends on its params (taps, octaves, steps). The runtime sizes tiles and batches from `texels × cost` and corrects the estimate from measured times.
5. A neighbourhood wider than 64 texels is not computed by a wider loop. Use `ops.blur`, work on a coarser grid (`ops.resample`), or use several runs.
6. `tiled: false` makes every run of the kernel a single dispatch. It is for a kernel whose result would differ if bands of rows ran as separate dispatches; no kernel written to rules 1 and 2 needs it. Such a kernel performs at most 64 loads per texel.
7. A node that runs a kernel a number of times that depends on params or on the resolution, or more than 8 times in a row, does so inside `ctx.loop` (4.7), so that batches are awaited, progress is reported and the evaluation can be cancelled.

---

## 4. Nodes

### 4.1 Categories

```ts
type Category = 'generate' | 'adjust' | 'filter' | 'simulate' | 'select' | 'color' | 'surface' | 'io' | 'ref';
```

| Category | Contains |
| --- | --- |
| `generate` | nodes without required inputs that create heights or masks: noises, gradients, shapes, primitives |
| `adjust` | per-texel changes and combinations: levels, curves, clamp, remap, math, combine, blend |
| `filter` | neighbourhood and geometric operations: blur, sharpen, warp, transform, resize of features |
| `simulate` | iterative simulations and water routing: erosion, thermal, snow, sand, ice, depression filling, flow routing, rivers, lakes, sea (`simulation.md`) |
| `select` | masks and data derived from a terrain without routing or simulation: height, slope, curvature, exposure, distance. Flow and every other routing output are `simulate` nodes (`simulation.md`) |
| `color` | everything that produces or changes `color` fields |
| `surface` | detail and structure added to a terrain without simulation: terraces, strata, rocks, scatter |
| `io` | import nodes and export nodes |
| `ref` | core-owned reference nodes: the templates authors copy (`testing.md`) |

The set is closed. A category is also a source folder and the prefix of its
node types.

### 4.2 Ports

```ts
type PortType = 'field' | 'color' | 'any';
type PortRole = 'height' | 'mask' | 'data';

interface PortDef {
  readonly name: string;
  readonly type: PortType | { readonly sameAs: string };
  readonly role?: PortRole;
  readonly label?: string;
  readonly optional?: boolean;
}
```

| Member | Rules |
| --- | --- |
| `name` | Matches `/^[a-z][A-Za-z0-9]{0,23}$/`; unique among the node's inputs and among its outputs; stored in documents and never renamed after release |
| `type` | `'field'`: receives or produces a `field`. `'color'`: a `color`. `'any'` (inputs only): receives a `field` or a `color` as connected, unconverted. `{ sameAs: 'x' }` (outputs only): the output has the kind of the field connected to input `x`, which must be a required input of type `'any'` |
| `role` | Only on ports of type `'field'`; default `'height'` (1.7) |
| `label` | Display name; default: `name` with a capital |
| `optional` | Inputs only; default false. Required inputs are declared before optional ones |

Conventions enforced by `defineNode`:

- `outputs[0]`, when the node has outputs, is the primary output and is named `out`.
- `inputs[0]`, when the node has inputs, is the primary input and is named `in`; a node with two inputs of equal rank names them `a` and `b`.
- An input named `mask` has type `'field'`, role `'mask'` and is optional.
- Secondary outputs are named for their content: `flow`, `wear`, `deposit`.

`defineNode` infers the context's types from the port names (4.7), so a name
must be a string literal type. A port definition shared between nodes is
declared `as const satisfies PortDef`, never with the annotation `: PortDef`,
which widens the name to `string` (4.6).

Guarantees from the evaluator:

- `evaluate()` is called only when every required input is connected and every connected input's upstream node succeeded. An unconnected required input is reported as `missing input "<name>"`.
- Every input field has size `ctx.res × ctx.res`.
- An input of type `'field'` always receives a `field` and one of type `'color'` a `color`: the evaluator converts a connection of the other type first (`runtime.md`). An input of type `'any'` is never converted; the node reads `field.kind`. Its type is the union `Field<'field'> | Field<'color'>` (4.7), which `if (src.kind === 'field')` narrows.

### 4.3 Parameters

```ts
interface CurvePoint { readonly x: number; readonly y: number }
interface GradientStop { readonly t: number; readonly color: readonly [number, number, number] }

type Unit = 'length' | 'height' | 'angle' | 'ratio' | 'none';
type ParamValue =
  | number | boolean | string
  | readonly [number, number] | readonly [number, number, number]
  | readonly CurvePoint[] | readonly GradientStop[];

interface ParamCommon {
  readonly name: string;
  readonly label?: string;
  readonly help: string;
  readonly group?: string;
  readonly visibleWhen?: { readonly param: string; readonly equals: string | number | boolean };
}

interface FloatParam extends ParamCommon {
  readonly kind: 'float';
  readonly unit: Unit;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly soft?: boolean;
  readonly scale?: 'linear' | 'log';
  readonly step?: number;
}
interface IntParam extends ParamCommon { readonly kind: 'int'; readonly default: number; readonly min: number; readonly max: number }
interface BoolParam extends ParamCommon { readonly kind: 'bool'; readonly default: boolean }
interface EnumParam extends ParamCommon {
  readonly kind: 'enum';
  readonly default: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}
interface SeedParam extends ParamCommon { readonly kind: 'seed'; readonly name: 'seed'; readonly default: number }
interface Vec2Param extends ParamCommon {
  readonly kind: 'vec2';
  readonly unit: 'length' | 'ratio' | 'none';
  readonly default: readonly [number, number];
  readonly min: number;
  readonly max: number;
  readonly soft?: boolean;
}
interface ColorParam extends ParamCommon { readonly kind: 'color'; readonly default: readonly [number, number, number] }
interface CurveParam extends ParamCommon { readonly kind: 'curve'; readonly default: readonly CurvePoint[] }
interface GradientParam extends ParamCommon { readonly kind: 'gradient'; readonly default: readonly GradientStop[] }
interface FileParam extends ParamCommon { readonly kind: 'file'; readonly default: ''; readonly filters: readonly string[] }
interface TextParam extends ParamCommon { readonly kind: 'text'; readonly default: string; readonly maxLength?: number }

type ParamDef =
  | FloatParam | IntParam | BoolParam | EnumParam | SeedParam | Vec2Param
  | ColorParam | CurveParam | GradientParam | FileParam | TextParam;
```

Common members:

| Member | Meaning |
| --- | --- |
| `name` | Matches `/^[a-z][A-Za-z0-9]*$/`; unique in the node; stored in documents and never renamed after release (use `migrate`, 4.6) |
| `label` | Inspector label; default: `name` with a capital |
| `help` | Required, non-empty. One or two sentences shown as the tooltip |
| `group` | Inspector section title; params without a group come first |
| `visibleWhen` | Inspector only: the control is shown only while the node's param named `param` has the value `equals` (`{ param: 'rangeMode', equals: 'fixed' }`). `param` names another `bool`, `enum` or `int` param of the node. It has no effect on evaluation, validation or the cache key |

Kinds:

| Kind | Stored value | Rules |
| --- | --- | --- |
| `float` | number | `unit` is required. `min < max`, `min ≤ default ≤ max`. `min` and `max` are hard limits, enforced when a document loads and when a value is set; with `soft: true` they bound only the slider and any finite typed value is accepted, so the node clamps what it cannot handle. `scale: 'log'` requires `min > 0`. `step` is the keyboard and drag increment; values are not snapped |
| `int` | integer | `min ≤ default ≤ max`, all integers; hard limits |
| `bool` | boolean | |
| `enum` | one of `options[].value` | At least two options with distinct values; `default` is one of them. Values are stored in documents: never renamed, new ones appended |
| `seed` | integer 0 .. 2^32 − 1 | At most one per node, named `seed` (4.8) |
| `vec2` | `[x, y]` | Each component within `min..max` (hard unless `soft`). `unit: 'length'` for an offset or a position in `uv` |
| `color` | `[r, g, b]` | Linear RGB, each component in 0..1 |
| `curve` | `CurvePoint[]` | A function 0..1 → 0..1: at least 2 points, `x` strictly increasing, `x` and `y` in 0..1 |
| `gradient` | `GradientStop[]` | At least 2 stops, `t` non-decreasing in 0..1, `color` in linear RGB |
| `file` | string | A path, or `''` for no file. `filters` are extensions without the dot: `['png', 'r16']` (4.12) |
| `text` | string | Free text, at most `maxLength` characters (default 256): file and layer names |

`ctx.params` holds validated values: every declared name is present, defaults
are filled in, numbers are finite and within their hard limits, enum values are
valid, curve points and gradient stops are sorted. Parameters are stored in the
document exactly as the user set them, in the units of 1.6.

### 4.4 Canonical parameters

When a node has a parameter for one of these concepts it uses the helper, so
that names, units and ranges agree across the product.

```ts
type Named<T extends ParamDef, N extends string> = Omit<T, 'name'> & { readonly name: NoInfer<N> };
type Over<T> = Partial<Omit<T, 'kind' | 'name' | 'unit'>>;

declare const param: {
  seed(o?: Over<SeedParam>): SeedParam;
  size<const N extends string = 'size'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  radius<const N extends string = 'radius'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  strength<const N extends string = 'strength'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  height<const N extends string = 'height'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  angle<const N extends string = 'angle'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
  slope<const N extends string>(name: N, o?: Over<FloatParam>): Named<FloatParam, N>;
  octaves<const N extends string = 'octaves'>(o?: Over<IntParam> & { name?: N }): Named<IntParam, N>;
  gain<const N extends string = 'gain'>(o?: Over<FloatParam> & { name?: N }): Named<FloatParam, N>;
};
```

| Helper | Kind, unit | Name | Label | Default | Min | Max | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `param.seed()` | seed | `seed` | Seed | 0 | | | |
| `param.size()` | float, length | `size` | Feature size | 0.25 | 0.001 | 4 | log, soft |
| `param.radius()` | float, length | `radius` | Radius | 0.005 | 0.0001 | 0.25 | log, soft |
| `param.strength()` | float, ratio | `strength` | Strength | 1 | 0 | 1 | |
| `param.height()` | float, height | `height` | Height | 1 | 0 | 1 | soft |
| `param.angle()` | float, angle | `angle` | Direction | 0 | 0 | 360 | |
| `param.slope(name)` | float, angle | as given | Slope | 30 | 0 | 90 | |
| `param.octaves()` | int | `octaves` | Octaves | 8 | 1 | 16 | |
| `param.gain()` | float, ratio | `gain` | Roughness | 0.5 | 0 | 1 | |

Every helper supplies a `help` text and accepts overrides for anything except
`kind` and `unit`. A second parameter of the same concept is made with a new
name: `param.size({ name: 'warpSize', label: 'Warp size' })`.

A parameter's name must be a string literal type, as a port's (4.2). A
definition shared between nodes is declared `as const satisfies ParamDef`. A
category's own helper that builds a parameter returns
`Named<FloatParam, 'duration'>`, never `FloatParam`, and a parameter list is
never spread from an array typed `ParamDef[]`: both widen the name to `string`,
which `defineNode` rejects (4.6).

`defineNode` rejects the parameter names `scale` and `frequency` (use `size`),
`amount`, `intensity` and `opacity` (use `strength`), `blur` (use `radius`),
and `rotation` and `rotate` (use `angle`).

### 4.5 From parameters to kernels

| Param kind | Type in `ctx.params` | Passed to a kernel as |
| --- | --- | --- |
| `float`, unit `length` | `number` | `f32`: unchanged when the kernel works in `uv`; `ctx.lengthToPx(v)` when it works in texels |
| `float`, unit `height` | `number` | `f32`, unchanged (field units) |
| `float`, unit `angle` | `number` | a direction as `vec2f` `[Math.cos(r), Math.sin(r)]` or as `f32` radians, `r = v * Math.PI / 180`; a slope threshold as `f32` `Math.tan(r)` |
| `float`, unit `ratio` or `none` | `number` | `f32` |
| `int` | `number` | `i32` or `u32` |
| `bool` | `boolean` | `u32` (true = 1) |
| `enum` | union of the option values | `u32` through `ctx.enumIndex(name)`, the index of the value in `options`; or by choosing a kernel variant |
| `seed` | `number` | never passed: it is in `frame.seed` (4.8) |
| `vec2` | `readonly [number, number]` | `vec2f` |
| `color` | `readonly [number, number, number]` | `vec3f`, or `vec4f` with alpha appended |
| `curve` | `readonly CurvePoint[]` | a `'f32'` LUT: `ctx.lut(bakeCurve(v), 'f32')` (4.9) |
| `gradient` | `readonly GradientStop[]` | a `'vec4f'` LUT: `ctx.lut(bakeGradient(v), 'vec4f')` |
| `file`, `text` | `string` | not passed |

Kernel param names are independent of node param names.

### 4.6 `defineNode`

```ts
type SettingName = 'seaLevel';

interface NodeDef {
  readonly type: string;
  readonly title: string;
  readonly category: Category;
  readonly description: string;
  readonly keywords?: readonly string[];
  readonly inputs: readonly PortDef[];
  readonly outputs: readonly PortDef[];
  readonly params: readonly ParamDef[];
  readonly kernels: readonly AnyKernel[];
  readonly cpuTasks?: readonly AnyCpuTask[];
  readonly maskable?: boolean;
  readonly resolutionDependent?: boolean;
  readonly uses?: readonly SettingName[];
  readonly version?: number;
  migrate?(params: Record<string, unknown>, from: number): Record<string, unknown>;
  externalKey?(env: ExternalKeyContext): string | Promise<string>;
  evaluate(ctx: EvalContext): void | Promise<void>;
  readonly export?: ExportHook;                      // export nodes only; export-unreal.md 2.1
}

/** Makes a non-literal name a compile error on the offending element of a port or param list. */
type LiteralNames<T extends readonly { readonly name: string }[], W extends string> =
  number extends T['length']
    ? (T extends readonly [...infer _H, infer _L] | readonly [infer _F, ...infer _R] ? LiteralNamesOf<T, W> : unknown)
    : LiteralNamesOf<T, W>;
type LiteralNamesOf<T extends readonly { readonly name: string }[], W extends string> = {
  readonly [K in keyof T]: T[K] extends { readonly name: infer N extends string }
    ? (string extends N
        ? { readonly name: `${W} names must be string literals: write the definition inline, add "as const satisfies ...", or return Named<..., "name"> from the helper` }
        : unknown)
    : unknown;
};

declare function defineNode<
  const P extends readonly ParamDef[],
  const I extends readonly PortDef[],
  const O extends readonly PortDef[],
>(def: Omit<NodeDef, 'inputs' | 'outputs' | 'params' | 'evaluate' | 'externalKey' | 'export'> & {
  inputs: I & LiteralNames<I, 'input'>;
  outputs: O & LiteralNames<O, 'output'>;
  params: P & LiteralNames<P, 'param'>;
  externalKey?(env: ExternalKeyContext<P>): string | Promise<string>;
  evaluate(ctx: EvalContext<P, I, O>): void | Promise<void>;
  export?(ctx: ExportContext<P, I>): readonly ExportItem[];
}): NodeDef;
```

| Member | Default | Meaning |
| --- | --- | --- |
| `type` | required | Stable id `<category>/<name>`, matching `/^[a-z]+\/[a-z][a-z0-9-]*$/`, with the category as prefix. Stored in documents; never renamed after release |
| `title`, `description`, `keywords` | required, required, `[]` | Library and tooltip text (`testing.md` gives the conventions) |
| `category` | required | 4.1 |
| `inputs`, `outputs` | required | 4.2. Order is display order |
| `params` | required | 4.3. Order is inspector order |
| `kernels` | required | Every kernel `evaluate()` may pass to `ctx.run`, including all variants. Kernels used inside shared ops are not listed |
| `cpuTasks` | `[]` | Every task `evaluate()` may pass to `ctx.cpu` (4.11) |
| `maskable` | false | 4.13 |
| `resolutionDependent` | false | The result legitimately depends on whole-field statistics (auto-level, normalise, equalise). Only such nodes may let `ctx.stats` or `ops.minMax` influence an output. They are excluded from the cross-resolution conformance check and marked in the user interface |
| `uses` | `[]` | Project settings the node reads (4.15) |
| `version` | 1 | Integer ≥ 1. Raised whenever a change makes old stored params mean something else or changes the result for the same params |
| `migrate` | none | Required when `version > 1`. Called once per step with the params stored at version `from`; returns the params for version `from + 1`. Pure |
| `externalKey` | see 4.12 | Identity of external data the node reads |
| `evaluate` | required | Produces the outputs through the context (4.7) |
| `export` | none | Export nodes only: declares what a build writes for the node. `ExportHook`, `ExportContext` and `ExportItem` are declared in `src/core/export-decl.ts` and defined, with the hook's rules, in `export-unreal.md` 2.1. Other nodes omit it |

`export` is in the `Omit` list of `defineNode` like `evaluate`: the member is
then typed by the node's own declarations alone, so `ctx.params.layer` in a
hook is a `string` and not a `ParamValue`.

`LiteralNames` rejects a port or param whose name is not a string literal type
(a constant annotated `: PortDef`, a helper declared to return `FloatParam`, a
spread of a `ParamDef[]`). Without it such a definition would compile and
silently lose every name check of the context. The error appears on the
offending element. It stays silent when another error in the same list (a
missing `help`, for instance) makes inference fall back to the plain array
type; that error is reported first.

`defineNode` throws `NodeDefError`, with the message prefix `node "<type>": `, when:

1. `type`, a port name or a param name violates its pattern, or a name is duplicated.
2. A port breaks a rule or convention of 4.2: a role on a non-`field` port, `optional` on an output, a required input after an optional one, `'any'` on an output, `sameAs` not naming a required `'any'` input, `outputs[0]` not named `out`, `inputs[0]` named neither `in` nor `a`, an input named `mask` that is not an optional `field` with role `'mask'`.
3. A param breaks a rule of 4.3: default outside `min..max`, `min ≥ max`, log scale with `min ≤ 0`, enum default not among the options, empty `help`, a second `seed` param, a `seed` param with another name, a rejected synonym (4.4), a `visibleWhen.param` that is not another `bool`, `enum` or `int` param of the node.
4. `maskable` is set on a node that does not qualify (4.13).
5. `kernels` or `cpuTasks` lists the same kernel or task twice.
6. A kernel in `kernels` reads the seed (its code or an included library mentions `frame.seed` or `seedFor(`) and the node has no `seed` param.
7. `version > 1` without `migrate`; `uses` names an unknown setting.

A node file's module scope builds definitions and nothing else: no GPU work, no
I/O, no mutable state.

### 4.7 The evaluation context

```ts
interface AllocOptions {
  readonly size?: number | readonly [number, number];   // default ctx.res; a number n means n × n
  readonly like?: Field;                                 // same size as this field; ignored when size is given
  readonly clear?: number | Rgba;                        // initial contents; default: undefined contents
}
interface LoopOptions<OutputName extends string = string> {
  readonly label?: string;
  readonly progress?: readonly [from: number, to: number];   // default [0, 1]
  readonly preview?: () => Readonly<Partial<Record<OutputName, Field>>>;
}
interface FieldStats { readonly min: number; readonly max: number; readonly mean: number; readonly nonFinite: number }

/** The part of the context that does not depend on a node's declarations. Shared ops and helper functions take this. */
interface OpContext {
  readonly res: number;
  readonly cellSize: number;
  readonly terrainSize: number;
  readonly heightRange: number;
  readonly ladder: readonly number[];
  readonly signal: AbortSignal;

  lengthToPx(length: number, grid?: Field | number): number;
  lengthToMetres(length: number): number;
  heightToMetres(height: number): number;

  alloc<K extends FieldKind>(kind: K, opts?: AllocOptions): Field<K>;
  clone<K extends FieldKind>(field: Field<K>): Field<K>;
  clear(field: Field, value?: number | Rgba): void;
  release(field: Field): void;

  run<KI, KO, KW, KU, KP, KL>(kernel: Kernel<KI, KO, KW, KU, KP, KL>, bindings: NoInfer<RunBindings<KI, KO, KW, KU, KP, KL>>): void;
  loop<R>(iterations: number, body: (i: number) => R extends PromiseLike<unknown> ? 'loop body must be synchronous' : R, opts?: LoopOptions): Promise<void>;
  flush(): Promise<void>;

  lut<T extends 'f32' | 'vec4f'>(data: Float32Array, type: T): Lut<T>;
  read(field: Field, rows?: readonly [y0: number, y1: number]): Promise<Float32Array<ArrayBuffer>>;
  write(field: Field, data: Float32Array, rows?: readonly [y0: number, y1: number]): void;
  stats(field: Field<'field' | 'half' | 'mask8'>): Promise<FieldStats>;

  cpu<A, R>(task: CpuTask<A, R>, args: A, transfer?: readonly ArrayBuffer[]): Promise<Awaited<R>>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  progress(fraction: number, label?: string): void;
}

type ValueOf<D> =
  D extends { kind: 'float' | 'int' | 'seed' } ? number
  : D extends { kind: 'bool' } ? boolean
  : D extends { kind: 'enum'; options: readonly { value: infer V }[] } ? V
  : D extends { kind: 'vec2' } ? readonly [number, number]
  : D extends { kind: 'color' } ? readonly [number, number, number]
  : D extends { kind: 'curve' } ? readonly CurvePoint[]
  : D extends { kind: 'gradient' } ? readonly GradientStop[]
  : D extends { kind: 'file' | 'text' } ? string
  : never;
/** With literal names: one member per param. For the untyped default (names are `string`): a plain record. */
type ParamsOf<P extends readonly ParamDef[]> =
  string extends P[number]['name']
    ? Readonly<Record<string, ParamValue>>
    : { readonly [D in P[number] as D['name']]: ValueOf<D> };

type PortNamed<Ports extends readonly PortDef[], N> =
  string extends Ports[number]['name'] ? Ports[number] : Extract<Ports[number], { name: N }>;
type KindOfPortType<T> = T extends 'field' ? 'field' : T extends 'color' ? 'color' : 'field' | 'color';
/** The field of an 'any' port is a union of two handle types, so a test of `kind` narrows it. */
type FieldOfPortType<T> = T extends 'field' ? Field<'field'> : T extends 'color' ? Field<'color'> : Field<'field'> | Field<'color'>;
type InputField<Port extends PortDef> =
  FieldOfPortType<Port['type']> | (Port extends { optional: true } ? null : PortDef extends Port ? null : never);
type EnumNames<P extends readonly ParamDef[]> = Extract<P[number], { kind: 'enum' }>['name'];

interface EvalContext<
  P extends readonly ParamDef[] = readonly ParamDef[],
  I extends readonly PortDef[] = readonly PortDef[],
  O extends readonly PortDef[] = readonly PortDef[],
> extends OpContext {
  readonly params: ParamsOf<P>;
  readonly seed: number;
  setting(name: SettingName): number;
  enumIndex(name: EnumNames<P>): number;
  input<N extends I[number]['name']>(name: N): InputField<PortNamed<I, N>>;
  wants(name: O[number]['name']): boolean;
  output<N extends O[number]['name']>(name: N, field: Field<KindOfPortType<PortNamed<O, N>['type']>>): void;
  /** OpContext.loop, with the preview keyed by this node's output names. */
  loop<R>(iterations: number, body: (i: number) => R extends PromiseLike<unknown> ? 'loop body must be synchronous' : R, opts?: LoopOptions<O[number]['name']>): Promise<void>;
}
```

The untyped forms are usable: `EvalContext` without type arguments has
`params: Readonly<Record<string, ParamValue>>`, `input()` returning
`Field<'field'> | Field<'color'> | null` and `output()` taking a field of either
kind. A node's own context is assignable to it, so a helper of a category may
take `ctx: EvalContext` when it needs more than `OpContext` offers (`ctx.seed`,
`ctx.setting`).

#### Environment

| Member | Meaning |
| --- | --- |
| `res` | Resolution of this evaluation: vertices per side of every input and output |
| `cellSize` | `terrainSize / (res − 1)`, metres |
| `terrainSize` | Terrain width in metres |
| `heightRange` | Metres represented by height 1.0 |
| `ladder` | Ladder levels from `res` downwards (1.5): `ladder[0] === res`, `ladder[j] === (res − 1) / 2^j + 1`. For `res` 509: `[509, 255, 128]`. It has a single element when `res` has no coarser level (128, 64 and 33 are such resolutions; thumbnails of an 8129 project are evaluated at 128). An index past the end is `undefined` although the type says `number`: a node that works on a coarser grid writes `ctx.ladder[1] ?? ctx.res` |
| `signal` | Aborted when the evaluation is cancelled |
| `params` | Validated parameter values (4.3) |
| `seed` | The value in `frame.seed` (4.8). Reading it in a node without a `seed` param throws |
| `setting(name)` | A declared project setting (4.15). Throws when the node's `uses` does not list it |
| `enumIndex(name)` | Index of the current value of an enum param in its `options` |
| `lengthToPx(length, grid?)` | `length * (n − 1)`: a length in texels of a grid of resolution `n`. `grid` is a field (its width is used), a resolution, or omitted for `res`. Not rounded |
| `lengthToMetres(length)` | `length * terrainSize` |
| `heightToMetres(height)` | `height * heightRange` |

The context does not say whether the evaluation is a preview or a build.

#### Ports

| Method | Semantics | Failure |
| --- | --- | --- |
| `input(name)` | The read-only field connected to the input. For an optional input, `null` when nothing is connected. The same handle on every call | An unknown name is a compile error and throws at run time |
| `wants(name)` | Whether this evaluation needs the output (4.10). Constant during `evaluate()` | |
| `output(name, field)` | Declares `field` as the value of the output. The field becomes read-only at this call. It must have the port's kind (for `sameAs`, the kind of that input's field) and size `res × res`. It is a field this node allocated, or one of its inputs (an alias). One field may be given to several outputs | `FieldAccessError` for a wrong kind or size, a released field, or a second call for one port |

When `evaluate()` resolves, every output for which `wants()` is true must have
been given; otherwise the node fails with `output "<name>" was not produced`. An
output that is not wanted may be skipped, or given anyway.

#### Fields

| Method | Semantics | Failure |
| --- | --- | --- |
| `alloc(kind, opts?)` | A new writable field owned by the node. Size: `opts.size`, else `opts.like`'s size, else `res × res`. Contents undefined unless `opts.clear` is given. A non-square size is allowed for data that kernels only read (4.12) | `RangeError` for a side outside 1..8192; the pool's budget error when the request does not fit (`runtime.md`). Do not catch it |
| `clone(field)` | A new writable field of the same kind and size with the same contents (a GPU texture copy, in order). `field` may be read-only | as `alloc` |
| `clear(field, value?)` | Sets every texel, in order. A number sets every channel to it; an `Rgba` sets the channels the kind has. Default 0 | `FieldAccessError` when the field is read-only or released |
| `release(field)` | Returns a field the node owns to the pool now. The handle is dead afterwards | `FieldAccessError` when the field is an input, was passed to `output()`, or was already released |

#### GPU work

| Method | Semantics | Failure |
| --- | --- | --- |
| `run(kernel, bindings)` | Validates and encodes one run (3.11). Synchronous | `KernelBindingError` (3.13). Also throws when a kernel declared `tiled: false` is estimated above the hard ceiling (`runtime.md` 3.4) |
| `loop(iterations, body, opts?)` | Calls `body(i)` once for each `i = 0 .. iterations − 1`, in order. Between batches of calls it submits the encoded work, waits until the GPU has caught up (`runtime.md` 3.6), checks `signal`, reports progress and offers a preview. Resolves when all the work of the last batch has finished | Rejects with the abort reason when cancelled, and with whatever `body` throws. `RangeError` when `iterations` is not an integer ≥ 0 |
| `flush()` | Submits everything encoded so far and resolves when the GPU has finished it | Rejects with the abort reason when cancelled |

Rules for `loop`:

1. `body` is synchronous. Returning a thenable is a compile error and throws at run time.
2. Inside `body`, `frame.iteration` of every run is `i` unless the run passes `iteration`.
3. `body` may call `run`, `clear`, `clone`, `alloc`, `release` and the synchronous shared ops, and may do ordinary JavaScript such as swapping a ping-pong pair. Calling `loop`, `flush`, `read`, `write`, `stats`, `lut`, `cpu`, `readFile`, `progress`, `output` or an asynchronous op inside `body` throws.
4. The framework chooses the batch sizes and changes them while the loop runs. The result must not depend on them (3.14).
5. `opts.progress` maps the loop onto a sub-range of the node's progress, for a node with several phases: `[0, 0.6]` then `[0.6, 1]`. `opts.label` is shown with the progress.
6. `opts.preview`, when given, is called between batches. It returns, by output port name, the fields that currently hold a displayable state of those outputs. The viewer may draw them until the next batch starts. The fields have the port's kind and any size; the function has no side effects and calls no context method. Previewed content is never cached. On `EvalContext` a key that is not an output of the node is a compile error, and it fails the node at run time (`runtime.md` 5.11).
7. After a rejection the node stops: it does not catch the error and continue.

`flush()` is rarely needed: order is guaranteed without it (3.11), `read`,
`stats` and `loop` wait by themselves, and the evaluator flushes when
`evaluate()` resolves. Call it between phases of a node that encodes several
heavy runs outside a loop, so that cancellation can take effect.

#### Data

| Method | Semantics | Failure |
| --- | --- | --- |
| `lut(data, type)` | An immutable table for kernels (4.9). Synchronous | `RangeError` for a bad length |
| `read(field, rows?)` | The field's contents as `Float32Array`, row-major, tightly packed, 1, 2 or 4 floats per texel by the kind's channel count, converted to float32 whatever the format. `rows = [y0, y1]` reads rows `y0 ≤ y < y1` only. Waits for all earlier work | Rejects with the abort reason when cancelled |
| `write(field, data, rows?)` | Replaces the contents (or the given rows) with `data`, in the layout of `read`. Takes effect after all earlier runs. Synchronous | `FieldAccessError` when read-only or released; `RangeError` when `data.length` is not `width × rowCount × channels` |
| `stats(field)` | Minimum, maximum and mean over the finite texels of a 1-channel field, and the count of non-finite texels, computed on the GPU. Waits for all earlier work | Rejects with the abort reason when cancelled |

A full `read` of a build-resolution field is 264 MB per channel. Read whole
fields only to hand them to a CPU task, and release the array when done.

#### CPU, files, progress

| Method | Semantics | Failure |
| --- | --- | --- |
| `cpu(task, args, transfer?)` | Runs a registered pure function off the engine thread (4.11) | Rejects with the abort reason when cancelled, and with the task's error |
| `readFile(path)` | The bytes of a file (4.12) | Rejects when the file cannot be read; throws when the node has neither a `file` param nor `externalKey` |
| `progress(fraction, label?)` | Reports progress of the node, 0..1, non-decreasing. `loop` and the coarse-to-fine driver report by themselves | |

#### Cancellation, errors and guarantees

- When `signal` aborts, every context method throws or rejects with `signal.reason` (a `DOMException` named `AbortError`). The node lets it propagate. Nothing from a cancelled evaluation is cached.
- When `evaluate()` throws or rejects for any reason, the node fails. Its outputs are discarded, every field it allocated is released, and nodes downstream are skipped (`runtime.md`). A node reports a user-facing problem by throwing an `Error` with a one-sentence message: `throw new Error('No file selected')`.
- After `evaluate()` has settled, every context method throws.
- When the device is lost, context methods throw the device-loss error (`runtime.md`); the node lets it propagate.
- A node must not hold the engine thread for more than a few milliseconds between two awaits. Work that visits every texel on the CPU goes through `ctx.cpu`.
- `evaluate()` is a pure function of what 3.14 rule 3 lists. The evaluator caches its outputs and may skip the call altogether.

### 4.8 Seeds

```ts
declare function hashU32(x: number): number;                         // PCG, as hash_u32 (3.9)
declare function hashCell(x: number, y: number, seed: number): number;
declare function hashUnit(h: number): number;
declare function mixSeed(a: number, b: number): number;              // hashU32((hashU32(a) + b) >>> 0)
```

1. A node's seed is its param of kind `seed`, which is named `seed` (`param.seed()`). A node has at most one.
2. `frame.seed = mixSeed(settings.seed, params.seed ?? 0)`, where `settings.seed` is the project seed. `ctx.seed` is the same number.
3. The node instance is not mixed in: a copied node gives the same result until its seed is changed.
4. A kernel derives independent random streams with `seedFor(0u)`, `seedFor(1u)`, ...; it never combines seeds by hand with constants.
5. A node that needs a second user-controlled seed declares an ordinary `int` param and passes it to its kernels as a `u32`.
6. A node whose kernels read the seed, or which reads `ctx.seed`, must declare the `seed` param: only then is the project seed part of its cache key (4.6 check 6).
7. `mixSeed` and the `hash*` functions return the same values in TypeScript and in WGSL, so CPU-side placement (scatter points computed in `evaluate()` or in a CPU task) agrees with kernels.

### 4.9 LUTs

```ts
declare function evalCurve(points: readonly CurvePoint[], x: number): number;
declare function bakeCurve(points: readonly CurvePoint[], n?: number): Float32Array;       // n defaults to 1024
declare function bakeGradient(stops: readonly GradientStop[], n?: number): Float32Array;   // n defaults to 256; n × 4 floats
```

- `ctx.lut(data, type)` creates an immutable table that lives until `evaluate()` settles. For `'f32'` the length is `data.length`; for `'vec4f'` it is `data.length / 4`, and `data.length` must be a multiple of 4. A `Lut` is never rewritten: a different table is a new `Lut`.
- A kernel declares `luts: { ramp: 'vec4f' }` and reads `ramp_at(t)`, `ramp_item(i)`, `ramp_len()` (3.2). The run binds `luts: { ramp }`.
- `evalCurve` is the single definition of a curve: the monotone cubic (Fritsch–Carlson) interpolant through the points, constant before the first and after the last point. The inspector draws it and the baker samples it.
- `bakeCurve(points, n)` returns `n` samples, sample `i` being `evalCurve(points, i / (n − 1))`.
- `bakeGradient(stops, n)` returns `n` RGBA samples with alpha 1, sample `i` taken at `t = i / (n − 1)` by linear interpolation in linear RGB between the neighbouring stops, constant before the first and after the last stop.
- A LUT also carries any other small table a kernel needs (a strata profile, a list of points as `vec4f`), up to the length limit of 3.12.

### 4.10 `ctx.wants`

`ctx.wants(name)` is false when nothing in this evaluation uses the output: no
connected consumer, no evaluation target, no viewer.

- A node with secondary outputs checks `wants` and neither allocates nor computes an unwanted one. In a kernel that also writes other targets, the unwanted target is bound to `null`.
- The value of an output must not depend on which other outputs are wanted.
- The evaluator caches the outputs a node produced. A later request for an output the cache entry lacks re-runs the node (`runtime.md`). A node therefore gives every wanted output in one call and never assumes it runs once.

### 4.11 CPU tasks

```ts
interface CpuEnv { progress(fraction: number): void }
interface CpuTask<A, R> {
  readonly name: string;
  readonly run: (args: A, env: CpuEnv) => R;
}
type AnyCpuTask = CpuTask<any, any>;
declare function defineCpuTask<A, R>(def: { name: string; run(args: A, env: CpuEnv): R }): CpuTask<A, R>;
```

`ctx.cpu(task, args, transfer)` runs `task.run(args, env)` in another thread and
resolves with its result.

1. A task is defined at module scope and listed in `NodeDef.cpuTasks`. It is named like a kernel: `<category>/<node name>[.<task>]` for a task of one node, `<category>/<module>[.<task>]` for a task shared inside a category (`simulate/route`). `defineCpuTask` throws `NodeDefError` for a second, different task with a name already defined in the process.
2. `run` is pure: its result depends on `args` only. It has no access to the context, to fields or to the GPU, and it must not rely on module-level state of the engine thread, because it executes in another thread that has loaded the same modules.
3. `args` and the result are structured-cloned. Buffers listed in `transfer` are moved, not copied, and are unusable by the caller afterwards. Typed arrays in the result are moved back.
4. `run` may be synchronous or return a promise. It reports progress through `env.progress(0..1)`, which maps onto the node's progress.
5. On cancellation `ctx.cpu` rejects at once and the task may be terminated at any point.
6. The typical shape: `const data = await ctx.read(f); const r = await ctx.cpu(task, { data, w, h }, [data.buffer]); ctx.write(g, r.data);`

### 4.12 File inputs and `externalKey`

```ts
interface ExternalKeyContext<P extends readonly ParamDef[] = readonly ParamDef[]> {
  readonly params: ParamsOf<P>;
  stat(path: string): Promise<{ readonly size: number; readonly mtimeMs: number } | null>;   // null: no such file
}

interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 3 | 4;
  readonly data: Float32Array;     // row-major, 0..1 for integer formats, first row = top row of the image
}
declare const decodeImage: CpuTask<{ bytes: Uint8Array }, DecodedImage>;
```

1. A `file` param stores a path. Paths are stored relative to the project file when the file lies under its folder; `FileSource` (`runtime.md`) resolves them. The value `''` means no file is selected; the node throws `new Error('No file selected')`.
2. `ctx.readFile(path)` returns the file's bytes. Decoding is CPU work: `await ctx.cpu(decodeImage, { bytes }, [bytes.buffer])`. `decodeImage` is a core task; a node that uses it lists it in `cpuTasks`. The formats it accepts, its limits and the companion task `decodeRaw` are defined in `export-unreal.md` 4.7.
3. The node uploads decoded data to a field of the image's own size (`ctx.alloc('field', { size: [w, h] })`, `ctx.write`) and brings it onto the evaluation grid on the GPU with `ops.resample` or a kernel that reads it with `x_uv(uv)`. It does not resample on the CPU. Row `y` of the image is row `y` of the field: nothing is flipped.
4. The identity of external data is part of the node's cache key through `externalKey`, which the evaluator awaits before deciding whether the node must run. It returns a string that changes whenever the data `evaluate()` reads changes. It uses `env.stat`, never reads file contents, and has no side effects.
5. Default: a node that has `file` params and no `externalKey` gets one that returns, for each `file` param in declaration order, its resolved path, size and modification time (or a marker for a missing file). A re-saved image therefore re-evaluates the node.
6. A node that reads any file not named by one of its `file` params (a sidecar, a tile set) defines `externalKey` and covers every such file.

### 4.13 `maskable`

`maskable: true` gives a node a mask without any code in the node.

1. It is allowed only when `inputs[0]` and `outputs[0]` exist and have the same type (both `'field'`, both `'color'`, or `'any'` with `sameAs` naming it), and the node declares no input named `mask`. Generators and nodes that change the type are not maskable.
2. The evaluator appends the input `{ name: 'mask', type: 'field', role: 'mask', optional: true }` after the declared inputs.
3. When `mask` is connected, after `evaluate()` the evaluator replaces `outputs[0]` by `mix(inputs[0], outputs[0], saturate(mask))`, per channel. Other outputs are untouched.
4. When `mask` is not connected nothing is added: no pass, no texture.
5. `evaluate()` never sees the mask: `ctx.input('mask')` does not exist for a maskable node.
6. A node whose algorithm needs the mask inside it (an erosion that must not erode masked areas) declares its own `mask` input and is not `maskable`.

### 4.14 Bypass

A node instance can be bypassed by the user when its `inputs[0]` and
`outputs[0]` exist with the same type. A bypassed node's `evaluate()` is not
called: `outputs[0]` is `inputs[0]`, and the evaluator supplies the other
outputs (`runtime.md`). A node needs no code for this and cannot observe it.

### 4.15 Project settings

A node always has `ctx.res`, `ctx.terrainSize` and `ctx.heightRange`. Any other
project setting is declared:

| `SettingName` | `ctx.setting(name)` returns |
| --- | --- |
| `'seaLevel'` | the sea level as a normalised height |

A setting enters a node's cache key only when the node declares it in `uses`,
so changing the sea level re-evaluates only the nodes that read it. Reading an
undeclared setting throws. The project seed is covered by the `seed` param (4.8).

---

## 5. Shared operations

`ops` holds the core-provided operations any node may use. They are built on
`OpContext`, so everything in 4.7 applies: results are new fields owned by the
calling node (released like any `alloc`), inputs are never modified, and the
work is encoded in call order. All but `coarseToFine` are synchronous and may be
called inside a `ctx.loop` body.

```ts
type ResampleFilter = 'auto' | 'nearest' | 'bilinear' | 'tent' | 'bspline';
type Img = 'field' | 'color';

interface LadderLevel {
  readonly res: number;                                  // vertices per side at this level
  readonly cellSize: number;                             // metres
  readonly index: number;                                // 0 = the coarsest level of this run
  readonly count: number;                                // number of levels in this run
  readonly progress: readonly [from: number, to: number];// this level's share of the node's progress
}

declare const ops: {
  copy<K extends FieldKind>(ctx: OpContext, src: Field<K>, dst: Field<NoInfer<K>>): void;
  resample<K extends Img>(ctx: OpContext, src: Field<K>, opts: { size: number; filter?: ResampleFilter }): Field<K>;
  blur<K extends Img>(ctx: OpContext, src: Field<K>, sigma: number): Field<K>;
  blend<K extends Img>(ctx: OpContext, a: Field<K>, b: Field<NoInfer<K>>, mask: Field<'field'> | number): Field<K>;
  slope(ctx: OpContext, height: Field<'field'>): Field<'field'>;
  normal(ctx: OpContext, height: Field<'field'>): Field<'color'>;
  minMax(ctx: OpContext, src: Field<'field'>): Field<'vec2'>;
  remap(ctx: OpContext, src: Field<'field'>, opts: {
    from: readonly [number, number] | Field<'vec2'>;
    to?: readonly [number, number];
    clamp?: boolean;
  }): Field<'field'>;
  coarseToFine<S>(ctx: OpContext, opts: {
    coarsestCell: number;
    begin(level: LadderLevel): S;
    simulate(level: LadderLevel, state: S): Promise<void>;
    refine(coarse: LadderLevel, fine: LadderLevel, state: S): S;
  }): Promise<S>;
};
```

| Operation | Semantics |
| --- | --- |
| `copy(ctx, src, dst)` | Copies `src` into the writable field `dst` of the same kind and size. `NoInfer` makes the first field decide `K` here and in `blend`, so two fields of different kinds are a compile error |
| `resample(ctx, src, { size, filter })` | A new `size × size` field holding `src` resampled with the vertex-centred mapping of 1.1; `src` may have any size. `'auto'` (default) is `'tent'` when shrinking and `'bilinear'` when growing. `'tent'` is a triangle filter as wide as the reduction (1-2-1 weights for an exact 2:1 ladder step); `'bspline'` is the cubic B-spline (smooth, no faceting in slope maps, slightly blurring); `'nearest'` takes the nearest source texel |
| `blur(ctx, src, sigma)` | Gaussian blur with standard deviation `sigma`, a length (1.6). Weights beyond 3 `sigma` are dropped and the rest renormalised; borders clamp. Returns a copy when `sigma` is below a quarter of a texel. No pass exceeds 64 loads per texel: wide blurs are evaluated on a coarser grid, with an error bound that is to calibrate |
| `blend(ctx, a, b, mask)` | `mix(a, b, saturate(mask))` per channel. `mask` is a field or a constant |
| `slope(ctx, height)` | Physical slope angle in degrees, 0..90: `degrees(atan(length(slopeAt)))`; a `data` field |
| `normal(ctx, height)` | Unit normals as a `color` field: `rgb = normalAt`, components in −1..1, `a = 1` |
| `minMax(ctx, src)` | A 1 × 1 `vec2` field holding `(min, max)` over the finite texels of `src`, computed on the GPU without readback. Bind it to a kernel input as a constant. Subject to the statistics rule of 1.7 |
| `remap(ctx, src, { from, to, clamp })` | `to[0] + (v − from[0]) / (from[1] − from[0]) * (to[1] − to[0])`; `to` defaults to `[0, 1]`; `from` is a pair or a `minMax` result; a zero-width `from` gives `to[0]`; `clamp` (default false) limits the result to `to` |
| `coarseToFine(ctx, opts)` | Runs a simulation up the ladder. Starts at the coarsest level of `ctx.ladder` whose cell size is at most `coarsestCell` (a length), calls `begin` there, then alternates `simulate(level, state)` and `refine(coarse, fine, state)` until `simulate` has run at `ctx.res`, and resolves with that state. `refine` returns the state for the finer level and releases the coarse fields it replaces. When no level of `ctx.ladder` has a cell that small, the run has the single level `ctx.res`. `LadderLevel.progress` shares the node's progress between the levels in proportion to their texel counts. `begin` and `refine` are synchronous: they do no readback and start no CPU task. `simulation.md` section 2 defines level selection, the call sequence, the share of work per level and the standard refinement step |

A node that needs an operation two categories would share asks the integrator
for it (`testing.md`); it does not import another category. A node never
evaluates another node.

---

## 6. Worked nodes

Both nodes are complete. They are the reference nodes for their patterns.

### 6.1 A generator

```ts
// src/core/nodes/ref/fbm.ts
import { defineKernel, defineNode, noise, param } from '../../api.ts';

const fbm = defineKernel({
  name: 'ref/fbm',
  outputs: { out: 'field' },
  params: { cells: 'f32', octaves: 'i32', gain: 'f32' },
  includes: [noise],
  code: /* wgsl */ `
const SPREAD = 1.6;   // fixed normalisation constant; to calibrate against the generator range rule (1.7)

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let n = noise_fbm(uv * P.cells, seedFor(0u), clamp(P.octaves, 1, 16), 2.0, P.gain);
  return 0.5 + 0.5 * SPREAD * n;
}`,
});

export default defineNode({
  type: 'ref/fbm',
  title: 'Fractal Noise (Reference)',
  category: 'ref',
  description: 'Generates fractal gradient noise; the reference node for generators.',
  keywords: ['perlin', 'fbm', 'noise'],
  inputs: [],
  outputs: [{ name: 'out', type: 'field' }],
  params: [
    param.seed(),
    param.size(),
    param.octaves(),
    param.gain(),
  ],
  kernels: [fbm],
  evaluate(ctx) {
    const { size, octaves, gain } = ctx.params;
    const out = ctx.alloc('field');
    ctx.run(fbm, {
      out: { out },
      params: { cells: 1 / Math.max(size, 0.001), octaves, gain },   // size is a length: 1 / size lattice cells across the terrain
      cost: 8 * octaves,
    });
    ctx.output('out', out);
  },
});
```

What makes it correct:

- The value is a function of `uv`, the params and the seed only, so every ladder level agrees at shared vertices. It reads neither `px` nor `frame.res`.
- The node declares `param.seed()` because its kernel calls `seedFor`.
- The octave count is a parameter with a hard maximum of 16, clamped again in WGSL, and passed as `cost`.
- `size` is a soft parameter, so any finite value can arrive, 0 and negative numbers included; the node clamps it before dividing. An unclamped `1 / size` is infinite for 0, which `ctx.run()` rejects.
- The output is normalised by a constant, not by measured statistics.
- `out` is allocated without `clear`: map mode writes every texel.

### 6.2 An iterative simulation step

```ts
// src/core/nodes/ref/talus.ts
import { defineKernel, defineNode, param } from '../../api.ts';

const step = defineKernel({
  name: 'ref/talus.step',
  inputs: { h: 'field' },          // current heights: read with neighbours
  outputs: { next: 'field' },      // new heights: the other half of the ping-pong pair
  inPlace: { moved: 'field' },     // accumulator: read and written at the own texel only
  params: { talus: 'f32', rate: 'f32' },
  code: /* wgsl */ `
// Height this texel receives from neighbour q (negative: gives). The amount
// depends only on the two heights, so both texels compute the same magnitude
// with opposite sign and the total is conserved.
fn exchange(hp: f32, q: vec2i, dist: f32) -> f32 {
  if (!inGrid(q)) { return 0.0; }
  let d = h_at(q) - hp;
  return sign(d) * max(abs(d) - P.talus * dist, 0.0) * P.rate / dist;
}

fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let hp = h_at(px);
  var net = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      if (i != 0 || j != 0) {
        net += exchange(hp, px + vec2i(i, j), length(vec2f(vec2i(i, j))));
      }
    }
  }
  return Out(hp + net, cur.moved + abs(net));
}`,
});

export default defineNode({
  type: 'ref/talus',
  title: 'Talus (Reference)',
  category: 'ref',
  description: 'Relaxes slopes steeper than the talus angle; the reference node for iterative simulations.',
  inputs: [{ name: 'in', type: 'field' }],
  outputs: [
    { name: 'out', type: 'field' },
    { name: 'moved', type: 'field', role: 'data' },
  ],
  params: [
    param.slope('talus', { label: 'Talus angle', default: 35, help: 'Slopes steeper than this collapse.' }),
    {
      kind: 'float', name: 'reach', label: 'Reach', unit: 'length', default: 0.02, min: 0.001, max: 0.25, scale: 'log',
      help: 'How far material can travel downslope.',
    },
  ],
  kernels: [step],
  maskable: true,
  async evaluate(ctx) {
    const { talus, reach } = ctx.params;

    // All state is allocated before the loop.
    let a = ctx.clone(ctx.input('in'));      // writable copy: the input itself is read-only
    let b = ctx.alloc('field');              // contents undefined: every texel is written before it is read
    const moved = ctx.wants('moved') ? ctx.alloc('field', { clear: 0 }) : null;

    const params = {
      talus: Math.tan((talus * Math.PI) / 180) * ctx.cellSize / ctx.heightRange,   // height units per texel
      rate: 0.1,
    };
    const iterations = Math.ceil(ctx.lengthToPx(reach));   // material moves at most one texel per iteration

    await ctx.loop(iterations, () => {
      ctx.run(step, { in: { h: a }, out: { next: b }, rw: { moved }, params });
      [a, b] = [b, a];                       // a always holds the latest complete state
    }, { preview: () => ({ out: a }) });

    ctx.release(b);
    ctx.output('out', a);
    if (moved) ctx.output('moved', moved);
  },
});
```

What makes it correct:

- The kernel reads neighbours only from `h`, an input, and writes the new heights to a different field. The accumulator is in place and touches its own texel only. A run never reads and writes one field.
- The stored parameters are an angle and a length. The talus threshold per texel and the iteration count are derived in `evaluate()` from `ctx.cellSize`, `ctx.heightRange` and `ctx.lengthToPx`, so material can travel the same physical distance in a preview and in a build. (`simulation.md` owns the stability and iteration-scaling rules of the real simulations; the constants here are this node's.)
- The swap is ordinary JavaScript inside the synchronous loop body. Whatever the batch sizes, `a` holds the latest state when the loop ends and when a preview is taken.
- `moved` is neither allocated nor computed when nobody wants it: the target is bound to `null`, and `cur.moved` influences no other member of `Out`.
- `maskable` blends `out` over `in` by the user's mask; `moved` is left as computed.
- Nothing is caught. Cancelling rejects `ctx.loop`, the rejection leaves `evaluate()`, and the evaluator releases `a`, `b` and `moved`.
