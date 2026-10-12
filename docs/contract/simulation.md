# Simulation contract: the v1 algorithms

This document defines the simulations of Orogen v1: what each one computes, the
parameters a user sees, the state it holds in the field kinds of `engine.md`,
its passes, its update equations, its stability limits, how its iteration
counts follow from the cell size, and what a test asserts about it. It also
defines the behaviour of `ops.coarseToFine`, whose signature is in `engine.md`.

Other documents own what is only referred to here:

| Document | Owns |
| --- | --- |
| `engine.md` | fields and kinds, kernels and the standard library, `EvalContext`, the signatures of `ops`, the resolution ladder, units, port and parameter types |
| `runtime.md` | the texture budget and the pool, batch sizing and the watchdog, the `seaLevel` setting, the threads that run CPU tasks |
| `testing.md` | the harness, fixtures, conformance tolerances, the file layout of the `simulate` category |

Everything here is written against the kernel contract of `engine.md`: map-mode
kernels, inputs read through accessors, at most 4 writable textures per kernel,
in-place access on `field` at the invocation's own texel only.

---

## 0. Status labels and references

Methods, formulas and numbers in this document are labelled with one of three
statuses. A constant labelled **fixed** in section 13 follows from a derivation
and is not tuned.

| Label | Meaning |
| --- | --- |
| **published** | Taken from a paper, or from released source code whose licence permits it (section 12). The reference key is given |
| **design, to validate** | Constructed for this engine. It is not found in a publication in this form. It is binding as written until a validation experiment changes this document |
| **to calibrate** | A number that is a starting value. It is a named constant of section 13, never a literal in a kernel. Calibration changes the table in section 13, not the algorithms |

A formula without a label inside a section marked **design, to validate**
inherits that status.

| Key | Reference |
| --- | --- |
| Mei07 | Mei, Decaudin, Hu: Fast Hydraulic Erosion Simulation and Visualization on GPU, Pacific Graphics 2007 |
| Stava08 | Stava, Benes, Brisbin, Krivanek: Interactive Terrain Modeling Using Hydraulic Erosion, SCA 2008 |
| JT11 | Jako, Toth: Fast Hydraulic and Thermal Erosion on the GPU, CESCG 2011 |
| Schott23 | Schott et al.: stream-power erosion on the GPU, 2023. Source: the released shader `spe_shader.glsl` (MIT) |
| Schott24 | Schott et al.: Terrain Amplification using Multi-scale Erosion, 2024. Source: the released shaders (MIT) |
| Jain24 | Jain, Benes, Cordonnier: Efficient Debris-flow Simulation for Steep Terrain Erosion, SIGGRAPH 2024 |
| FastFlow24 | Jain, Kerbl, Gain, Finley, Cordonnier: FastFlow, Pacific Graphics 2024 |
| Tzathas24 | Tzathas et al.: Physically-based Analytical Erosion, Eurographics 2024 |
| Barnes14 | Barnes, Lehman, Mulla: Priority-Flood, 2014 |
| PD01 | Planchon, Darboux: A fast, simple and versatile algorithm to fill the depressions of digital elevation models, 2001. Source: secondary descriptions |
| Nilles24 | Nilles et al.: Real-Time Desertscapes Simulation with CUDA, GRAPP 2024 (released code, MIT) |
| Argudo20 | Argudo et al.: glacier simulation, 2020 (released shallow-ice shader, MIT) |
| RT06 | Rong, Tan: Jump Flooding in GPU, 2006 |
| LM53 | Leopold, Maddock: The Hydraulic Geometry of Stream Channels, 1953 (exponents as commonly cited; not checked against the paper) |

---

## 1. Common rules

### 1.1 Nodes and shared modules

All nodes of this document are in category `simulate`.

| Node type | Computes | Uses `ops.coarseToFine` | CPU task | Section |
| --- | --- | --- | --- | --- |
| `simulate/fluvial-erosion` | stream-power erosion: valley networks | yes | `simulate/route` | 3 |
| `simulate/hydraulic-erosion` | virtual-pipe erosion: gullies, deposits | yes | none | 4 |
| `simulate/thermal-erosion` | talus relaxation of the terrain | yes | none | 5 |
| `simulate/sediment` | a loose layer settling on the terrain | yes | none | 5.9 |
| `simulate/fill` | depression filling | no | `simulate/route` | 6 |
| `simulate/flow` | flow accumulation and wetness | no | `simulate/route` | 7 |
| `simulate/rivers` | river extraction and carving | no | `simulate/route` | 8 |
| `simulate/lakes` | lakes | no | `simulate/route`, `simulate/lakes.prune` | 9.1 |
| `simulate/sea` | sea mask and depth; coastal reshaping | no | `simulate/sea.connect` | 9.2 |
| `simulate/snow` | snow cover | yes | none | 10 |

Rules common to these nodes:

1. None is `maskable`. A node that has a mask declares the optional input `mask` and uses it inside the algorithm as stated in its section.
2. None declares `resolutionDependent`, and none lets `ctx.stats` or `ops.minMax` influence an output.
3. `simulate/fluvial-erosion`, `simulate/hydraulic-erosion`, `simulate/fill`, `simulate/flow`, `simulate/rivers`, `simulate/lakes` and `simulate/sea` declare `uses: ['seaLevel']`.
4. A secondary output is allocated and computed only when `ctx.wants(name)` is true; in a kernel that also writes other targets its target is bound to `null`.
5. Reserved node types, not in v1: `simulate/dunes`, `simulate/glacier`, `simulate/droplets`, `simulate/debris` (section 11).

Kernels, tasks and helpers shared by several of these nodes live in private
modules of the category (`testing.md` 6.1 names the files). A shared kernel or
task is one module-scope object, named after its module; every node that runs
it lists it in `NodeDef.kernels` or `NodeDef.cpuTasks`. A kernel or task used
by one node carries that node's name.

| Module | Kernels and tasks | Helpers | Defined in |
| --- | --- | --- | --- |
| refine | `simulate/refine.height`, `simulate/refine.plane` | `levelInput`, `refineHeight`, `refinePlane`, `levelBudget` | 2 |
| talus | `simulate/talus.step` | | 5.6 |
| layer | `simulate/layer.limit`, `simulate/layer.move` | | 5.9 |
| route | task `simulate/route`; `simulate/route.receivers`, `simulate/route.sweep` | | 6 |
| jump | `simulate/jump.step` | | 8.5 |
| diff | `simulate/diff` | | 5.5 |
| constants | | every constant of section 13 | 13 |

### 1.2 Units and storage

Symbols used throughout:

| Symbol | Meaning | In a kernel | In `evaluate()` |
| --- | --- | --- | --- |
| `R` | metres per height unit | `frame.heightRange` | `ctx.heightRange` |
| `T` | terrain width in metres | `frame.terrainSize` | `ctx.terrainSize` |
| `dx` | metres between neighbouring texels of the grid being written | `frame.cellSize` | `level.cellSize` |
| `res` | texels per side of the grid being written | `frame.res.x` | `level.res` |
| `sea` | sea level, normalised | a kernel param | `ctx.setting('seaLevel')` |

User parameters are stored in the units of `engine.md` 1.6 and converted in
`evaluate()`: a length `v` is `v * T` metres, a height `v` is `v * R` metres, a
slope threshold of `v` degrees is the tangent `Math.tan(v * Math.PI / 180)`.

Equations in this document are written in SI units: metres, seconds, cubic
metres per second. State planes hold:

| Quantity | Stored as | Kind |
| --- | --- | --- |
| Any vertical length: terrain height, routing surface, water depth, suspended sediment (as the terrain height it would add), layer thickness, wear, deposit | normalised height: metres / `R` | `field` |
| Drainage area | fraction of the terrain area, 0..1 | `field` |
| Receiver code, nearest-site coordinates | the integer as a float | `field`, `vec2` |
| Pipe flux | m³/s | `field` |
| Accumulated unit discharge | m² | `field` |

1. A kernel converts on read (`z = R * h`) and stores a height as `stored + change / R`, where `change` is computed in metres. It never stores `(R * stored + change) / R`. A zero change therefore leaves a texel bit-identical.
2. A height difference is formed from stored values before scaling: `R * (hA - hB)`, not `R * hA - R * hB`.
3. The terrain plane of every simulation holds normalised heights at all times, so it can be lent to `ctx.loop`'s `preview`.
4. Height changes smaller than half a float32 step of the stored height (3e-8 of the height range for heights in 0.5..1) are lost. This is below the 16-bit export step (1.5e-5 of the range) by a factor of 500 and is accepted.

### 1.3 Neighbours, borders, outlets

| Set | Index `k` | Offsets `o_k` (x, y) | Run length |
| --- | --- | --- | --- |
| N4 | 0, 1, 2, 3 | (1, 0), (0, 1), (−1, 0), (0, −1) | `dx` |
| N8 | loop `j = −1..1`, `i = −1..1`, skipping (0, 0) | (i, j) | `dx * length(vec2f(i, j))` |

- `opp(k) = (k + 2) % 4` is the N4 direction pointing back.
- A receiver code is the N4 index of the texel a texel drains to, or 4 for none.
- Accessors clamp to the edge. No kernel of this document relies on the clamp: a kernel that can reach a neighbour outside the grid tests `inGrid(q)` and treats that neighbour as its section says.
- **Border ring**: the texels with `x = 0`, `y = 0`, `x = res − 1` or `y = res − 1`.
- **Outlet** (routing, sections 3 and 6 to 9): a texel on the border ring, or a texel whose terrain height is `<= sea`. Water that reaches an outlet leaves the simulation. An outlet has receiver code 4.
- **Sink** (section 4): a texel whose terrain height is `<= sea`.

Routing uses N4 everywhere: filling, receivers and accumulation agree on the
connectivity, so a filled surface always has a receiver for every texel that is
not an outlet.

### 1.4 Random numbers

A per-texel random number of a simulation is
`hash_unit(hash_cell(px, seedFor(stream)))`, with `px` the texel of the level
being simulated. It is a property of the level's own grid; it is not expected
to agree between levels. The CPU computes the same number as
`hashUnit(hashCell(x, y, mixSeed(ctx.seed, stream)))`.

| Stream | Use |
| --- | --- |
| 0 | receiver choice (`simulate/route.receivers` and the router task) |
| 1 | erodibility jitter (`simulate/hydraulic-erosion`) |
| the fine level's `res` (always ≥ 33) | refinement jitter of that level (2.4); its detail noise uses `mixSeed(salt, 1)` |

Kernels of the refine module take their seed as a `u32` param (`salt`), so
that nodes without a `seed` param can run them.

### 1.5 Memory

The **state** of a node is every field it owns at one moment: planes, scratch
and the outputs it has produced. Its inputs are owned by the evaluator and are
not counted. The budget of `engine.md` 1.2 applies to the peak state at
`ctx.res = 8129` with every output wanted.

Bytes at 8129² (66 080 641 texels): one `field` is 264.3 MB, one `vec2` is
528.6 MB. No simulation of this document uses `aux`, `color`, `half`, `half2`
or `mask8`, so the figures are the same on a device with and without
`texture-formats-tier1`.

| Node | Planes at the peak | Peak state | Share of 3500 MB |
| --- | --- | --- | --- |
| `simulate/hydraulic-erosion` | 10 `field` + 1 `vec2` | 3172 MB | 91 % |
| `simulate/rivers` | 6 `field` + 2 `vec2` | 2643 MB | 76 % |
| `simulate/fluvial-erosion` | 7 `field` | 1850 MB | 53 % |
| `simulate/sea` with coastal reshaping | 3 `field` + 2 `vec2` | 1850 MB | 53 % |
| `simulate/lakes` | 4 `field` | 1057 MB | 30 % |
| `simulate/thermal-erosion`, `simulate/sediment`, `simulate/snow`, `simulate/sea` without coast | 3 `field` | 793 MB | 23 % |
| `simulate/fill`, `simulate/flow` | 2 `field` | 529 MB | 15 % |

Each section lists the planes. Rules that keep these figures true:

1. Within a level, a node allocates every plane before the level's first `ctx.loop`.
2. A node releases scratch planes before it allocates the fields of its secondary outputs.
3. During refinement (2.6) coarse planes are released one by one as their fine replacements are encoded. The peak of a refinement stays below the peak of the level it leads to.
4. A run with several levels allocates its top-level state in the last refinement. The coarser levels cost a small share of the run (2.3), so a state that does not fit the budget fails early in the node's work.

The router task (6.2) holds its arrays in ordinary memory, not in textures:
an estimated 1.2 to 1.7 GB at 8129² (heights, flood order, queue, float64
areas), **to calibrate**.

### 1.6 Reading the pass tables

In a pass table, **Reads** lists inputs with their footprint (`own` = the
invocation's texel, `N4`, `N8`), **Writes** lists outputs (bound to a field
other than every input), **In place** lists `inPlace` targets, and **Loads** is
the kernel's `cost` in texture loads per texel. "Swap" means exchanging two
JavaScript variables in the loop body.

### 1.7 Invariants of every simulation node

A test can assert, for every node of this document:

1. Every output is finite, and every `mask` output lies in 0..1.
2. Two evaluations with the same inputs, parameters and seed on one device give bit-identical outputs, whatever the batch sizes of `ctx.loop` and the tile sizes of the runs.
3. The value of an output does not depend on which other outputs are wanted.
4. When the iteration budget of 2.5 is zero at every level, the terrain the simulation returns is bit-identical to the input. The steps a node applies after its last level still run.
5. CPU tasks are deterministic: equal arguments give bit-identical results.

Across adapters, results agree within tolerances only (`engine.md` 3.14).

---

## 2. The coarse-to-fine driver

Every iterative simulation moves material at most about one texel per
iteration, so on one grid its iteration count grows with the grid width and its
cost with the cube of the width. `ops.coarseToFine` removes the cube: a
simulation does its long-range work on a coarse level of the resolution ladder
and only a fixed amount of work per finer level.

The driver, the refinement helpers and the budget rule are **design, to
validate**. The jittered upsampling is **published** (Tzathas24).

### 2.1 Level selection

```
cell(j)  = 1 / (ctx.ladder[j] − 1)                 // cell size of ladder level j, as a length
J        = { j : cell(j) <= coarsestCell }
jBase    = max(J)   if J is not empty, else 0
levels   = ladder[jBase], ladder[jBase − 1], …, ladder[0]
```

- The run has `count = jBase + 1` levels. `LadderLevel.index` is 0 for `ladder[jBase]` (the **base level**) and `count − 1` for `ctx.res`.
- `coarsestCell` must be finite and greater than 0; otherwise the driver throws `RangeError`.
- When `J` is empty (the cells of `ctx.res` itself are larger than `coarsestCell`), the run has the single level `ctx.res`.

| `ctx.res` | `coarsestCell` | Levels |
| --- | --- | --- |
| 8129 | 1/256 | 509, 1017, 2033, 4065, 8129 |
| 1017 | 1/256 | 509, 1017 |
| 8129 | 1/640 | 1017, 2033, 4065, 8129 |
| 509 | 1/640 | 509 |
| 4033 | 1/256 | 505, 1009, 2017, 4033 |
| 8129 | 1/50 | 128, 255, 509, 1017, 2033, 4065, 8129 |
| 8129 | 1/20000 | 8129 |

A node derives `coarsestCell` from a user length so that the base level is
fixed by the feature the user asks for, not by `ctx.res`:
`coarsestCell = size / FEATURE_CELLS`.

### 2.2 Call sequence

```
state = begin(level[0])
for i = 0 … count − 1:
    await simulate(level[i], state)
    if i < count − 1:
        state = refine(level[i], level[i + 1], state)
resolve(state)
```

1. `begin` and `refine` are synchronous. They allocate, encode runs and call synchronous ops. They do not read back, do not call `ctx.cpu` and do not flush. Work that needs a CPU task belongs at the start of `simulate`.
2. `simulate` runs the level's iterations inside `ctx.loop`, passing `progress: level.progress`.
3. `refine` returns the state of the fine level and releases every coarse field that the returned state does not hold.
4. The driver checks `ctx.signal` before each call. An error or abort from a callback rejects the driver's promise; the node lets it propagate.
5. The driver allocates nothing and runs no kernel itself.

### 2.3 Progress

`level.progress` maps the levels onto the node's progress 0..1 in proportion to
their texel counts: the weight of level `i` is `res_i²`. For the levels 509 to
8129 the ranges end at 0.003, 0.015, 0.062, 0.249 and 1. A node that does work
after the driver resolves reports it with `ctx.progress(1, label)`.

### 2.4 The standard refinement step

Two kinds of plane cross a refinement.

**Terrain height.** The fine terrain is the node's input at the fine level plus
the change the simulation has made so far:

```
fine(px) = fineBase(px) + U(coarse − coarseBase)(px) + detailNoise(px)
```

`fineBase` and `coarseBase` are the node's input brought to the two levels by
`levelInput`. Detail of the input that the coarse level cannot represent is
therefore kept, and a texel the simulation has not changed keeps the input's
value exactly.

**Any other carried plane** (water depth, sediment, layer thickness, wear) is
upsampled: `fine(px) = gain * U(coarse)(px)`.

`U` is bilinear interpolation of the coarse plane at the position

```
t(px) = vec2f(px) * 0.5 + J(px)                          // in coarse texels
J(px) = (hash_unit2(hash_cell(px, salt)) − 0.5) * 0.5    // uniform in [−0.25, 0.25)², when jitter is on
J(px) = 0                                                // when jitter is off, and on the border ring
```

clamped to the coarse plane. On the ladder `vec2f(px) * 0.5` is exact: even
fine texels coincide with coarse texels. The jitter keeps channels from
following the blocks of the coarse grid (Tzathas24).

```ts
/** The node input on the grid of `level`: `input` itself when it already has that size; otherwise a new field,
 *  ops.resample(ctx, input, { size: level.res }), which the caller owns and releases. */
declare function levelInput(ctx: OpContext, input: Field<'field'>, level: LadderLevel): Field<'field'>;

interface RefineHeightOptions {
  readonly coarse: Field<'field'>;        // terrain plane of the coarse level
  readonly coarseBase: Field<'field'>;    // levelInput(...) of the coarse level
  readonly fineBase: Field<'field'>;      // levelInput(...) of the fine level
  readonly jitter: boolean;
  readonly salt: number;                  // u32; ignored when jitter is false and detail is 0
  readonly detail: number;                // 0..1; 0 injects nothing
}
/** A new field of fineBase's size holding the refined terrain. */
declare function refineHeight(ctx: OpContext, o: RefineHeightOptions): Field<'field'>;

interface RefinePlaneOptions {
  readonly size: number;                  // res of the fine level
  readonly jitter?: boolean;              // default false
  readonly salt?: number;                 // required when jitter is true; the salt of the matching refineHeight
  readonly gain?: number;                 // default 1
}
/** A new size × size field holding gain * U(coarse). */
declare function refinePlane(ctx: OpContext, coarse: Field<'field'>, o: RefinePlaneOptions): Field<'field'>;
```

`salt` for a refinement to the fine level `fine` is `mixSeed(ctx.seed, fine.res)`.

The kernel behind `refineHeight`:

```ts
const refineHeightKernel = defineKernel({
  name: 'simulate/refine.height',
  inputs: {
    fineBase: 'field',
    coarse: { kind: 'field', size: 'any' },
    coarseBase: { kind: 'field', size: 'any' },
  },
  outputs: { out: 'field' },
  params: { jitter: 'f32', salt: 'u32', detail: 'f32', noiseSeed: 'u32' },
  includes: [hash, noise],
  cost: 17,
  code: /* wgsl */ `
// Change made at coarse texel c. Exactly 0 where the coarse level changed nothing.
fn delta(c: vec2i) -> f32 { return coarse_at(c) - coarseBase_at(c); }

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let last = vec2i(frame.res) - vec2i(1);
  let onBorder = any(px == vec2i(0)) || any(px == last);
  var t = vec2f(px) * 0.5;                                   // position in coarse texels
  if (!onBorder) { t += (hash_unit2(hash_cell(px, P.salt)) - vec2f(0.5)) * P.jitter; }
  let c = clamp(t, vec2f(0.0), vec2f(coarse_res()) - vec2f(1.0));
  let i = vec2i(floor(c));
  let f = c - floor(c);
  let d = mix(mix(delta(i), delta(i + vec2i(1, 0)), f.x), mix(delta(i + vec2i(0, 1)), delta(i + vec2i(1, 1)), f.x), f.y);
  var v = fineBase_at(px) + d;
  if (P.detail > 0.0 && !onBorder) { v += P.detail * noise_gradient(vec2f(px) * 0.5, P.noiseSeed); }
  return v;
}`,
});
```

- `P.jitter` is 0.5 with jitter and 0 without. `P.noiseSeed` is `mixSeed(salt, 1)`.
- The interpolation is applied to the per-texel differences, not to the two planes separately. An unchanged region gives exactly 0, and a plane that only went down gives a value `<= 0`.
- `simulate/refine.plane` has the input `coarse` (`size: 'any'`), one output and the params `jitter`, `salt`, `gain`; it returns `P.gain * coarse_lerp(t)` with the same `t`.

**Detail injection.** `detailNoise` is gradient noise with a lattice cell of two
fine texels, the shortest band the fine grid resolves well. Its amplitude is a
fixed fraction of the cell size, so the slopes it adds are the same at every
level:

```
P.detail = detail * DETAIL_SLOPE * dx_fine / R          // normalised height
```

`detail = 0` (the default of every v1 node) injects nothing. The border ring
receives neither jitter nor noise. The injected noise is part of the node's
change to the terrain: a secondary output defined as a difference to the input
(wear, deposit) includes it.

**Which planes are refined how** is stated per algorithm. The summary:

| Node | Terrain | Other carried planes | Recomputed at each level |
| --- | --- | --- | --- |
| `simulate/fluvial-erosion` | `refineHeight`, jitter on | none | routing surface, drainage area, receivers |
| `simulate/hydraulic-erosion` | `refineHeight`, jitter on | water and sediment: `refinePlane`, no jitter; wear: `refinePlane` with the terrain's jitter and salt; flow: `refinePlane`, no jitter | flux (cleared), scratch |
| `simulate/thermal-erosion` | `refineHeight`, jitter off | none | scratch |
| `simulate/sediment`, `simulate/snow` | bed is `levelInput` of each level | layer: `refinePlane`, no jitter | limiter |

### 2.5 Iteration budgets

A node states its work as a **total**: the number of iterations the simulation
would need on the base level alone. The driver spends part of it on the finer
levels, where one iteration achieves less: a front moving one texel per
iteration covers half the distance (`ratio = 0.5`), a relaxation spreading by
diffusion covers a quarter of the area (`ratio = 0.25`).

```ts
/** Iterations per level, index = LadderLevel.index. One iteration at level i counts ratio^i base iterations. */
declare function levelBudget(total: number, levels: number, perLevel: number, ratio: 0.5 | 0.25):
  { readonly iterations: readonly number[]; readonly equivalent: number };
```

```
L          = levels − 1
tail(n)    = n * ratio * (1 − ratio^L) / (1 − ratio)       // base iterations that n iterations on each finer level amount to
nDetail    = L > 0 ? min(perLevel, floor(total / 2)) : 0
nBase      = total < 0.5 ? 0 : ceil(total − tail(nDetail))
iterations = [nBase, nDetail, nDetail, …]
equivalent = nBase + tail(nDetail)
```

1. `total` is computed from the user parameters and from the feature size in base cells, `F = size * (res_0 − 1)`. With `coarsestCell = size / FEATURE_CELLS`, `F` lies in `[FEATURE_CELLS, 2 * FEATURE_CELLS)` unless the base level is the coarsest ladder level or `ctx.res`.
2. `equivalent` equals `total` up to the rounding of `nBase`, whatever the number of levels. A preview and a build therefore simulate the same distance, the same duration and the same totals; they differ in how much of it runs on fine grids.
3. A quantity that must sum to a given total over the run (uplift, snowfall, simulated time) is applied per iteration in proportion to `ratio^i / equivalent`.
4. `perLevel` is the algorithm's `DETAIL_ITERATIONS_*` constant. It bounds the work per finer level: the cost of a run is dominated by that many iterations at `ctx.res`.
5. When `total < 0.5` no level simulates; refinement of an unchanged terrain returns the input bit for bit (1.7).

Starting schedules for a build at 8129 with default parameters:

| Node | Defaults | Levels | Iterations per level | Same work on 8129 alone |
| --- | --- | --- | --- | --- |
| `simulate/fluvial-erosion` | size 0.125, duration 1 | 509 to 8129 | 281, 256, 256, 256, 256 | 8331 |
| `simulate/hydraulic-erosion` | size 0.05, duration 2 | 1017 to 8129 | 814, 384, 384, 384 | 9196 |
| `simulate/thermal-erosion` | size 0.02, strength 1 | 509 to 8129 | 175, 96, 96, 96, 96 | 52 852 |

The same nodes in a preview at 1017 run 393 + 256, 1150, and 183 + 96
iterations.

### 2.6 Order of work in `refine`

1. Release every coarse plane that is not carried (scratch, ping-pong partners, recomputed planes).
2. For each carried plane: encode its refinement into a new fine field, then release the coarse plane. The terrain goes first; its `coarseBase` is released after it unless it is the node's input.
3. Allocate the fine scratch planes; clear those that must start at a defined value.

### 2.7 Skeleton of a node that uses the driver

```ts
// src/core/nodes/simulate/thermal-erosion.ts (abridged)
interface State { h: Field<'field'>; spare: Field<'field'>; base: Field<'field'> }

async evaluate(ctx) {
  const { talus, size, strength, removal } = ctx.params;
  const input = ctx.input('in');
  const mask = ctx.input('mask');
  let budget: readonly number[] = [];

  const state = await ops.coarseToFine<State>(ctx, {
    coarsestCell: size / FEATURE_CELLS_RELAX,
    begin(level) {
      const cells = size * (level.res - 1);
      budget = levelBudget(strength * RELAX * cells * cells, level.count, DETAIL_ITERATIONS_RELAX, 0.25).iterations;
      const base = levelInput(ctx, input, level);
      return { base, h: ctx.clone(base), spare: ctx.alloc('field', { like: base }) };
    },
    async simulate(level, s) {
      const gate = mask ? levelInput(ctx, mask, level) : null;
      const params = { talus: Math.tan((talus * Math.PI) / 180), keep: 1 - removal };
      await ctx.loop(budget[level.index]!, () => {
        ctx.run(talusStep, { in: { h: s.h, mask: gate }, out: { next: s.spare }, rw: { wear: null }, params });
        [s.h, s.spare] = [s.spare, s.h];
      }, { label: 'Thermal erosion', progress: level.progress, preview: () => ({ out: s.h }) });
      if (gate && gate !== mask) ctx.release(gate);
    },
    refine(coarse, fine, s) {
      ctx.release(s.spare);
      const base = levelInput(ctx, input, fine);
      const h = refineHeight(ctx, { coarse: s.h, coarseBase: s.base, fineBase: base, jitter: false, salt: 0, detail: 0 });
      ctx.release(s.h);
      if (s.base !== input) ctx.release(s.base);
      return { base, h, spare: ctx.alloc('field', { like: h }) };
    },
  });
  // state.base is the input itself here; state.h becomes `out` (section 5.5 gives the rest).
}
```

Auxiliary inputs (`mask` and the like) are brought to a level with `levelInput`
at the start of `simulate` and released at its end, unless they are the node's
own input.

### 2.8 Preview and build

1. The base level is selected from a user length. A preview whose `ctx.res` is at least the base resolution runs the same coarse levels as the build, with the same per-texel random numbers, and stops earlier.
2. The two runs do not give identical values on shared levels: their inputs differ (the build's input is filtered down from more detail), and the base level receives a different share of the total (2.5).
3. A preview whose `ctx.res` is coarser than the base level runs one level with fewer texels per feature. It is an approximation and the node reports nothing special.
4. Nothing in a node tests which of these cases it is in.
5. Every node of sections 3 to 10 therefore declares a `resolutionTol` with this reason (`testing.md` 3.6). Its value is set by calibration (section 13 item 7). An output that consists of line features one texel wide (`out` of `simulate/flow`, `river` of `simulate/rivers`) moves between levels and may meet no tolerance the suite accepts (at most 0.5); a node with such an output then declares `skip: { resolution: … }` with that reason instead, and its own tests compare the large features. Which nodes need it is settled by the same calibration.

---

## 3. Stream-power fluvial erosion: `simulate/fluvial-erosion`

### 3.1 Purpose and landforms

The large-scale shaper. It carves dendritic valley networks into any terrain:
trunk valleys and tributaries that reach the border or the sea, V-shaped cross
sections, graded long profiles, knickpoints that travel upstream, drainage
divides that sharpen into ridges. With uplift it grows mountain ranges from a
flat or blocky input. It moves no sediment: eroded material disappears, and
depressions are either left or filled at the end.

### 3.2 Interface

| Input | Type, role | Meaning |
| --- | --- | --- |
| `in` | field, height | terrain |
| `mask` | field, mask, optional | erodibility: 0 = not erodible, 1 = fully erodible |
| `upliftMask` | field, mask, optional | where the `uplift` parameter applies; default everywhere |

| Output | Role | Meaning | Produced |
| --- | --- | --- | --- |
| `out` | height | eroded terrain | always |
| `wear` | data | `max(in − out, 0)`: height removed, in height units | when wanted |
| `flow` | data | drainage area of each texel as a fraction of the terrain area, in (0, 1], on the final routing surface | when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `seed` | seed | 0 | | receiver choice, refinement jitter |
| `size` | float, length (`param.size`) | 0.125 | 0.01..1, log | feature size: the width of the catchments that erode at the reference speed. Sets the base level |
| `duration` | float, none | 1 | 0.05..8, log | how far the incision front of a reference catchment travels, in feature sizes |
| `concavity` | float, none | 0.4 | 0.2..0.8 | exponent `m`: low values erode small and large streams alike, high values concentrate erosion in large rivers |
| `talus` | float, angle (`param.slope`) | 30 | 5..90 | valley sides steeper than this are worn back; 90 disables |
| `uplift` | float, height | 0 | 0..1, soft | height added during the run where `upliftMask` is 1 |
| `lakeFill` | float, ratio | 1 | 0..1 | how far the depressions that remain are filled with sediment |
| `detail` | float, ratio | 0 | 0..1 | fine noise injected at each refinement (2.4) |

All defaults are **to calibrate**. `concavity` 0.4 and `talus` 30° are the
published values of Tzathas24 (`m = 0.4`, critical slope tangent 0.57).

### 3.3 Model and units

Stream power law with slope exponent 1 (**published**: FastFlow24 eq. 2,
Jain24 eq. 1, Tzathas24):

```
∂z/∂t = u − k * A^m * S                     z in m, A drainage area in m², S slope (rise over run), u uplift in m/yr
```

The node has no parameter in years. It normalises time by the erosion speed of
a reference catchment of area `Aref = (size * T)²`:

```
t* = k * Aref^m * t                         metres that the incision front of a reference catchment has travelled
∂z/∂t* = u* − κ * S        κ = (A / Aref)^m = (a / size²)^m        a = drainage area as a fraction of T²
```

The run covers `t* = duration * size * T` metres. To compare with published SI
values: `k * t = duration * size * T / Aref^m`. With `T` = 8000 m, `size` =
0.125, `duration` = 1 and `m` = 0.4 this is 3.98 m^0.2, which with
`k = 2e-5 m^0.2/yr` (Tzathas24) is 199 000 years.

Additions to the law, all **design, to validate**:

| Term | Formula | Reason |
| --- | --- | --- |
| Celerity cap | `κ = min((a / size²)^m, CELERITY_CAP)` | Bounds the time step by the feature scale instead of by the largest river on the map. Rivers draining more than `CELERITY_CAP^(1/m)` reference areas (32 at the defaults) erode at the capped speed. The shader of Schott24 also caps its erosion term |
| Slope limit | `+ TALUS_RATE * max(S − tan(talus), 0)` | Wears valley sides back to the talus angle. Without it stream power cuts slots, because the sides drain almost no area. Form of Jain24 eq. 8 and Tzathas24 eq. 27 |
| Erodibility | both terms are multiplied by `mask` | |

Slope exponents other than 1, deposition of the eroded material, and the
`A^(−h)` hillslope term of Tzathas24 are not in v1.

### 3.4 State and memory

| Plane | Kind | Holds | At a refinement |
| --- | --- | --- | --- |
| `z`, `zNext` | field × 2 | terrain, ping-pong | `z`: `refineHeight`, jitter on |
| `area`, `areaNext` | field × 2 | drainage fraction `a`, ping-pong | recomputed by the router |
| `w`, `wNext` | field × 2 | routing surface (6.1), ping-pong | recomputed by the router |
| `rcv` | field | receiver code 0..4 | recomputed |

7 `field` = 1850 MB at 8129². After the loop `simulate/fluvial-erosion.finish` writes
`out` into the spare terrain plane; the node then releases the other terrain
plane, `areaNext`, `wNext`, `rcv` and `w` before it allocates `wear`. `flow` is
the `area` plane. The inputs `mask` and `upliftMask` are brought to each level
with `levelInput` at the start of `simulate` and released at its end (2.7); at
`ctx.res` they are the inputs themselves. An unconnected one is bound as
`null` and reads 1. These per-level copies are in addition to the 7 planes: at
most 2 `field` of the level's size, and none at `ctx.res`.

### 3.5 Passes

At the start of each level, in `simulate` (not a pass): read `z`, run the
router (6.2) with `routing: 'single'`, write `w` and `area`.

Per iteration:

| # | Kernel | Reads | Writes | In place | Loads |
| --- | --- | --- | --- | --- | --- |
| 1 | `simulate/route.receivers` | `z` own, `w` own + N4 | `rcv` | | 6 |
| 2 | `simulate/fluvial-erosion.erode` | `z` own, `w` own + N4, `area` own + N4, `rcv` own + N4, `mask` own, `upliftMask` own | `zNext`, `areaNext` | | 18 |
| | swap `z`/`zNext`, `area`/`areaNext` | | | | |
| 3 | `simulate/route.sweep`, `FILL_SWEEPS` times, swapping `w`/`wNext` after each | `z` own, `w` N4 | `wNext` | | 5 |

After the last level:

| # | Step | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 4 | router once more on `z`, when `lakeFill > 0` or `flow` is wanted: exact `w` and `area` | | | CPU |
| 5 | `simulate/fluvial-erosion.finish` | `z` own and the neighbour one texel inwards, `in` at that neighbour, `w` own | `out` (the spare terrain plane) | 4 |
| 6 | `simulate/diff`, when `wear` is wanted | `in` own, `out` own | `wear` (`deposit` bound to `null`) | 2 |

No pass has more than 2 writable textures. Nothing is updated in place.

### 3.6 Update equations

`simulate/route.receivers` and `simulate/route.sweep` are defined in section 6.

`simulate/fluvial-erosion.erode`, for texel `i` with N4 neighbours `q_k`:

```
areaNext_i = 1 / res² + Σ_{k : inGrid(q_k) and rcv(q_k) = opp(k)} area(q_k)

if outlet(i):                         zNext_i = z_i
else if rcv_i = 4 or w_i > z_i:       zNext_i = z_i + lift * upliftMask_i        // a pit of w, or under a lake
else:
    gx = R * max(0, w_i − w(q_0), w_i − w(q_2)) / dx
    gy = R * max(0, w_i − w(q_1), w_i − w(q_3)) / dx
    S  = sqrt(gx² + gy²)                                                          // upwind slope, Jain24 eq. 18
    κ  = min((area_i / size²)^m, CELERITY_CAP)
    e  = STEP * dx * mask_i * (κ * S + TALUS_RATE * max(S − tanTalus, 0))         // metres
    z1 = max(z_i − e / R, w(q_rcv))                                               // never below the receiver
    zNext_i = z1 + lift * upliftMask_i

STEP = COURANT / (CELERITY_CAP + TALUS_RATE)
lift = uplift * ratio^index / equivalent                                          // per iteration, normalised height (2.5)
```

- The slope and the clamp use the routing surface `w`. Where a texel is eroded, `w_i = z_i`.
- The random single receiver and the upwind slope are **published** (Jain24, Tzathas24). One accumulation sweep per erosion step is **published** (Schott23, Jain24).
- An outlet never changes: it is the base level.

`simulate/fluvial-erosion.finish`:

```
interior texel:   out_i = z_i + lakeFill * max(w_i − z_i, 0)
border ring:      out_i = z_i − max(in_n − z_n, 0)        n = the neighbour one texel inwards (diagonally, at a corner)
```

A border texel is fixed during the run. The border rule gives it the lowering
of its inward neighbour afterwards, which removes the one-texel wall that a
fixed border leaves where the terrain beside it was lowered.

### 3.7 Stability, time step, iterations

- The scheme is an explicit upwind advection of the terrain along flow lines. One iteration moves the incision front by `STEP * κ * dx`, at most `COURANT * dx`. With `COURANT = 0.5` a texel loses at most 0.71 times its largest N4 drop per iteration and stays above its lowest neighbour. The clamp to the receiver covers the case where the chosen receiver is not the lowest neighbour.
- There is no time step in seconds. The step per iteration is fixed in texels, so the number of iterations follows from the cell size alone:

```
total = duration * F * (CELERITY_CAP + TALUS_RATE) / COURANT        F = size * (res_0 − 1)
budget = levelBudget(total, level.count, DETAIL_ITERATIONS_FLUVIAL, 0.5)
```

- With the starting constants `total = 8.2 * duration * F`: 262 to 525 per unit of `duration` when the base level is selected by `size`.
- The fill converges from above only (6.3). Each erosion step is followed by `FILL_SWEEPS` sweeps warm-started from the previous surface.

### 3.8 Schedule on the ladder

`coarsestCell = size / FEATURE_CELLS`. Per level: router, then
`budget.iterations[index]` iterations of passes 1 to 3. Refinement:
`refineHeight` with jitter on, `salt = mixSeed(ctx.seed, fine.res)` and the
node's `detail`. The default schedule is in 2.5.

Estimated cost at 8129² on the development GPU: 44 loads per texel per
iteration, about 40 ms, from the measured 0.29 ms per 5-load pass at 2048²;
256 iterations take about 10 s. The router costs more than that at 8129²
(6.2). Both are **to calibrate**.

### 3.9 Invariants

With `uplift = 0`, `lakeFill = 0` and `detail = 0`:

1. `out <= in` at every texel, exactly.
2. On a single level, `out = in` exactly at every outlet that is not on the border ring. (A refinement interpolates the change of neighbouring texels onto outlets below sea level.)
3. `wear = in − out` within 1e-7.
4. With `mask` = 0 everywhere, `out` is bit-identical to `in`.

With `lakeFill = 1` and `uplift = 0`:

5. Monotone flow: every texel of `out` that is not an outlet has an N4 neighbour that is lower by at least half of `ROUTE_EPS`.

Always:

6. `flow` is positive, non-decreasing from a texel to its receiver, and its sum over the outlets is 1 within 1e-4.

### 3.10 Known artefacts and counter-measures

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Valleys aligned with the axes or diagonals | steepest-descent routing | one random lower N4 neighbour, chosen with probability proportional to the drop, with a per-texel random number that is constant over the run |
| Blurred, braided drainage | multiple flow directions | single receivers |
| Erosion stops in every pit | water has nowhere to go | routing on the filled surface `w`; exact router at each level start |
| A lake drains late after its outlet is cut | a sweep lowers a lake by one texel per sweep | `FILL_SWEEPS` sweeps per step; exact router at the next level start and before the outputs |
| Drainage area lags behind a changing network | one accumulation sweep per step | exact area at each level start; `flow` recomputed exactly at the end |
| Slot canyons | stream power acts only where area is large | slope-limit term |
| Knife-edge ridges | no hillslope diffusion in v1 | follow the node with `simulate/thermal-erosion` or a blur |
| Flat steps along a river bed | clamp to the receiver when a step is too large | `COURANT = 0.5` and the celerity cap keep the clamp rare |
| Trunk rivers under-eroded | celerity cap | raise `CELERITY_CAP` (costs iterations in proportion) |
| Rivers follow the blocks of the coarser level | bilinear upsampling | jittered upsampling |
| No new channels on a smooth input at fine levels | nothing breaks the symmetry | random receivers are drawn afresh at each level; `detail` adds noise |
| Pits in the output | no sediment is deposited | `lakeFill` |
| Wall along the border | border texels are fixed | border rule of `simulate/fluvial-erosion.finish` |
| Result depends on noise in the uplift map | one-sweep accumulation underestimates discharge under noisy uplift (FastFlow24) | the node adds no noise to uplift; the help text asks for a smooth `upliftMask` |

---

## 4. Virtual-pipe hydraulic erosion: `simulate/hydraulic-erosion`

### 4.1 Purpose and landforms

The meso-scale detailer. Rain falls on the terrain, runs off as a shallow layer
of water, picks up sediment where it is fast and steep and drops it where it
slows down. It produces gullies and rills on slopes, sediment-filled valley
floors, alluvial fans at slope breaks, smoothed hollows, and deposits in
depressions where water collects.

### 4.2 Interface

| Input | Type, role | Meaning |
| --- | --- | --- |
| `in` | field, height | terrain |
| `mask` | field, mask, optional | erodibility: scales erosion and the embedded talus; deposition is not masked |
| `precipitation` | field, mask, optional | where rain falls |

| Output | Role | Meaning | Produced |
| --- | --- | --- | --- |
| `out` | height | terrain after erosion and deposition | always |
| `wear` | data | height removed over the run, gross, in height units | when wanted |
| `deposit` | data | height laid down over the run, gross: `(out − in) + wear` | when wanted |
| `flow` | data | time-averaged discharge per unit width, m²/s | when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `seed` | seed | 0 | | erodibility jitter, refinement jitter |
| `size` | float, length (`param.size`) | 0.05 | 0.005..0.5, log | feature size: the scale of the largest gullies. Sets the base level |
| `duration` | float, none | 2 | 0.05..16, log | how far water at nominal speed travels, in feature sizes |
| `rain` | float, ratio | 0.24 | 0..1 | rainfall rate as a fraction of `RAIN_MAX` |
| `capacity` | float, none | 1 | 0.1..3 | sediment capacity coefficient `Kc` |
| `downcutting` | float, none | 0.5 | 0.1..2 | pick-up rate `Ks`, per second |
| `deposition` | float, none | 1 | 0.1..3 | settling rate `Kd`, per second |
| `talus` | float, angle (`param.slope`) | 35 | 5..90 | talus angle of the embedded thermal step; 90 disables |
| `detail` | float, ratio | 0 | 0..1 | fine noise injected at each refinement (2.4) |

Defaults and ranges of `rain`, `capacity`, `downcutting` and `deposition` are
the typical values and ranges of JT11 Table 2, **to calibrate** for terrains
measured in metres.

### 4.3 Model and units

The pipe model of Mei07 with the erosion and deposition step of JT11
(**published**). The restructuring into the passes of 4.5, the flux-form
sediment transport, the choice of the pipe cross-section and the open border
are **design, to validate**.

- Each texel exchanges water with its N4 neighbours through four virtual pipes. A pipe carries a one-way flux `F_k >= 0` in m³/s.
- Pipe length is `dx`. The pipe cross-section is `dx * H_REF`, so the wave speed of the model, `sqrt(G * H_REF)`, does not depend on the cell size, and the same simulated time moves water the same distance on every level. With `H_REF = 20 m` and `dx = 1 m` the model has JT11's pipe area of 20.
- Simulated seconds are not real time. The rates are artistic constants, as in JT11.

In this section `b`, `d`, `s` and `wear` denote stored, normalised values; `R * b`
and so on are metres.

### 4.4 State and memory

| Plane | Kind | Holds | At a refinement |
| --- | --- | --- | --- |
| `b` | field | terrain | `refineHeight`, jitter on |
| `s` | field | suspended sediment | `refinePlane`, no jitter |
| `spare` | field | the write target of the passes that cannot run in place | not carried |
| `d` | field | water depth | `refinePlane`, no jitter |
| `fluxE`, `fluxN`, `fluxW`, `fluxS` | field × 4 | pipe fluxes `F_0..F_3` | not carried; cleared to 0 |
| `g` | vec2 | `.x` = terrain change `δ` of this iteration, `.y` = water depth before the flow | not carried |
| `wear` | field | accumulated erosion; only when `wear` or `deposit` is wanted | `refinePlane` with the terrain's jitter and salt |
| `flow` | field | accumulated `speed * depth * dt`, m²; only when wanted | `refinePlane`, no jitter |

10 `field` + 1 `vec2` = 3172 MB at 8129² with every output wanted.

- `b`, `s` and `spare` rotate: pass 3 writes the new `s` into `spare` and the old `s` plane becomes `spare`; pass 4 writes the new `b` into `spare` and the old `b` plane becomes `spare`. Three planes serve two ping-pongs.
- The fluxes are four planar `field`s because they are updated in place, which only `field` supports. `g` is written whole every iteration and read by the next pass, so it is an ordinary output; `vec2` keeps both channels at full precision.
- After pass 5 the node releases `s`, `spare`, `d`, the fluxes and `g` before it allocates `deposit`.
- The inputs `mask` and `precipitation` are brought to each level with `levelInput` at the start of `simulate` and released at its end (2.7); at `ctx.res` they are the inputs themselves, so they add nothing to the peak state. An unconnected one is bound as `null` and reads 1.

### 4.5 Passes

Per iteration:

| # | Kernel | Reads | Writes | In place | Loads |
| --- | --- | --- | --- | --- | --- |
| 1 | `simulate/hydraulic-erosion.flux` | `b` own + N4, `d` own + N4 | | `fluxE`, `fluxN`, `fluxW`, `fluxS` | 10 |
| 2 | `simulate/hydraulic-erosion.water` | fluxes own (4) and one per N4 neighbour (4), `b` own + N4, `s` own, `mask` own | `g` | `d`, `flow` | 15 |
| 3 | `simulate/hydraulic-erosion.erode` | `g` own + N4, `s` own + N4, fluxes own (4) and one per N4 neighbour (4), `precipitation` own | `spare` (the new `s`) | `b`, `d`, `wear` | 19 |
| | swap `s`/`spare` | | | | |
| 4 | `simulate/talus.step` | `b` own + N8, `mask` own + N8 | `spare` (the new `b`) | `wear` | 18 |
| | swap `b`/`spare` | | | | |

After the last level:

| # | Kernel | Reads | Writes | In place |
| --- | --- | --- | --- | --- |
| 5 | `simulate/hydraulic-erosion.settle` | `s` own | | `b`, `flow` |
| 6 | `simulate/hydraulic-erosion.deposit`, when `deposit` is wanted | `in` own, `b` own, `wear` own | `deposit` | |

Why each in-place access is safe:

| Pass | In-place target | Other texels of that plane read in the pass |
| --- | --- | --- |
| 1 | the four fluxes | none: a texel's new fluxes depend on its own old fluxes and on `b`, `d` |
| 2 | `d`, `flow` | none: neighbours contribute through their fluxes |
| 3 | `b`, `d`, `wear` | none: the terrain change and the depth of the neighbours come from `g` |
| 4 | `wear` | none |
| 5 | `b`, `flow` | none |

Pass 3 has 4 writable textures, the limit.

### 4.6 Update equations

Constants: `G = 9.81`, `dt` from 4.7, `r = rain * RAIN_MAX` (m/s). A texel is a
sink when `b <= sea` (1.3).

**Pass 1, flux** (Mei07 eq. 2 to 5). For texel `i` and `k = 0..3` with
neighbour `q_k`:

```
ΔH_k = R * ((b_i − b_q) + (d_i − d_q))        if inGrid(q_k)
     = R * d_i                                otherwise: outside the grid is dry ground at this texel's height
F'_k = max(0, F_k + dt * G * H_REF * ΔH_k)
K    = min(1, R * d_i * dx² / max(dt * (F'_0 + F'_1 + F'_2 + F'_3), 1e-30))
F_k ← K * F'_k
sink: F_k ← 0
```

`K` uses `min`. JT11 eq. 4 prints `max`, which is a misprint: the factor exists
to stop a texel giving away more water than it holds.

**Pass 2, water, velocity, capacity, terrain change** (Mei07 eq. 6 to 10, JT11
eq. 10 and 12 to 13):

```
in_k   = F_opp(k)(q_k) if inGrid(q_k), else 0
d1     = R * d_i
dNew   = max(0, d_i + dt * (Σ in_k − Σ F_k) / (dx² * R))   // normalised: stored value plus change / R (1.2 rule 1)
d2     = R * dNew
Wx     = 0.5 * (in_2 − F_2 + F_0 − in_0)
Wy     = 0.5 * (in_3 − F_3 + F_1 − in_1)
dMean  = 0.5 * (d1 + d2)
speed  = dMean > D_MIN ? min(length(vec2f(Wx, Wy)) / (dx * dMean), V_MAX) : 0
slope  = slopeAt(b, px)                                    // m/m, central differences
sinA   = length(slope) / sqrt(1 + dot(slope, slope))
C      = capacity * max(sinA, SIN_MIN) * speed * saturate(dMean / KD_MAX)        // metres of sediment
E      = mask_i * (1 − ERODIBILITY_JITTER * ξ_i)           // ξ_i: stream 1 of 1.4
sM     = R * s_i

if C > sM:   Δ = min(min(dt * downcutting, 1) * E * (C − sM),  d2,  R * max(b_i − min_{k, inGrid} b(q_k), 0))
else:        Δ = −min(dt * deposition, 1) * (sM − C)

δ      = b_i − (b_i − Δ / R)            // the part of Δ the terrain plane can represent, normalised
if δ < 0:  δ = max(δ, −s_i)             // never lay down more than is suspended

g      ← (δ, d_i)
d      ← dNew
flow   ← flow + speed * dMean * dt
sink:  g ← (0, 0),  d ← 0
```

- `V_MAX = sqrt(2 * G * H_REF)`, the fastest speed the time step resolves.
- The capacity ramp `saturate(dMean / KD_MAX)` is the formula as JT11 prints it (eq. 10): capacity grows with depth up to `KD_MAX`. The paper's prose describes the opposite intent, limiting erosion in deep water, so the choice of the printed form is **design, to validate**. Its effect here is that a film of water does not carve.
- The three limits on erosion are: the rate, the water available (JT11), and the height above the lowest N4 neighbour (**design**: a texel never digs itself into a pit).
- `δ` is computed with the same float32 subtraction that pass 3 performs, so terrain, sediment and water change by exactly the same amount.

**Pass 3, apply and transport** (JT11 eq. 12c and 13c for the water; the
transport is **design, to validate** and replaces the semi-Lagrangian step of
Mei07 eq. 14, which loses sediment):

```
b    ← b_i − δ_i
wear ← wear_i + max(δ_i, 0)
d    ← max(0, d_i + δ_i) * (1 − min(KE * dt, 1)) + dt * r * precipitation_i / R

s1(j)   = s_j + δ_j                                   for j = i and its N4 neighbours
φ_k(j)  = dt * F_k(j) / (dx² * R * g.y_j)   if R * g.y_j > D_MIN, else 0
                                                      // share of j's water that left through pipe k
sNew_i  = s1(i) * max(0, 1 − Σ_k φ_k(i)) + Σ_{k, inGrid(q_k)} φ_opp(k)(q_k) * s1(q_k)

sink: b unchanged, d ← 0, sNew ← 0
```

- Adding the eroded height to the water and removing the deposited height keeps the water surface continuous. JT11 introduces it against ripples in long runs.
- Sediment leaves a texel with the water that leaves it. Both ends of a pipe compute the transferred amount from the same loads, so sediment is conserved exactly between texels. What flows over the border or into a sink leaves the simulation.
- Rain for the next iteration is added at the end, so `d` at the start of an iteration already contains it.
- A dry texel keeps its sediment in place; it settles over the following iterations at the rate `deposition`.

**Pass 4, embedded thermal step.** `simulate/talus.step` (5.6) on `b` with the
node's `talus`, `keep = 1` and the node's `mask`. JT11 runs thermal erosion
inside the hydraulic loop; it removes the spikes and the checkerboard that
erosion and deposition leave.

**Pass 5, settle.** `b ← b + s`; `flow ← flow / simulatedTime`, with
`simulatedTime = dt_0 * equivalent` (2.5). **Pass 6:**
`deposit = max((b − in) + wear, 0)`.

At a level start `d` is 0 on the base level; the fluxes are 0 on every level.

### 4.7 Stability, time step, iterations

- Gravity-wave bound (**design**, checked against JT11's range): linearising passes 1 and 2 gives a wave of speed `sqrt(G * H_REF)`; the explicit update is stable for `dt <= dx / sqrt(2 * G * H_REF)`. With JT11's values (`dx` = 1, area 20) the bound is 0.0505, the upper end of their range.

```
dt = PIPE_SAFETY * dx / sqrt(2 * G * H_REF)                 // 0.0252 * dx seconds with the starting constants
```

- `dt` is proportional to `dx`: it halves at each finer level, as Mei07 Table 1 does.
- The wave travels `WAVE_CELLS = PIPE_SAFETY / sqrt(2) = 0.354` texels per iteration. Water in a channel is slower; `NOMINAL_SPEED` is its assumed speed as a fraction of the wave speed.

```
total = duration * F / (WAVE_CELLS * NOMINAL_SPEED)         F = size * (res_0 − 1)
budget = levelBudget(total, level.count, DETAIL_ITERATIONS_HYDRAULIC, 0.5)
```

- With the starting constants `total = 11.3 * duration * F`: 362 to 724 per unit of `duration` when the base level is selected by `size`.
- `min(dt * rate, 1)` bounds the per-iteration fractions when `dx` is large.
- The flux scaling `K` guarantees `d >= 0`; `Σ φ_k <= 1` follows from it, up to float rounding, which the `max(0, …)` absorbs.

### 4.8 Schedule on the ladder

`coarsestCell = size / FEATURE_CELLS`. Refinement: terrain with jitter on,
`salt = mixSeed(ctx.seed, fine.res)`; `wear` with the same jitter and salt so
that `(b − in) + wear` stays the interpolated coarse deposit; `d`, `s` and
`flow` without jitter; fluxes cleared. Suspended sediment is carried between
levels and settled only at the end. The default schedule is in 2.5.

Estimated cost of the default build at 8129, from the measured 3.03 ms per
four-pass iteration at 2048² on the development GPU: 0.6 s, 1.2 s, 4.6 s and
18 s on the four levels, 25 s in all. The same work on the 8129 grid alone is
9196 iterations, about 440 s. **To calibrate**: the measured kernel is not the
pass structure of 4.5.

### 4.9 Invariants

1. `d >= 0`, `s >= 0` and every flux `>= 0` at all times; `wear >= 0`, `deposit >= 0`.
2. `out = in − wear + deposit` within 1e-6 wherever `(out − in) + wear >= 0`, and `(out − in) + wear >= −1e-6` everywhere.
3. Conservation, on a fixture whose border ring is higher than any water surface reached and with a single level: `|mean(out) − mean(in)| <= 2e-6 + 1e-4 * mean(wear)`.
4. With `detail = 0`: when `mask` is 0 everywhere, `out` is bit-identical to `in`; when `rain = 0` and `talus = 90`, `out` is bit-identical to `in`.

"Monotone flow" is not an invariant of this model: water has inertia and can
run uphill for a few iterations.

### 4.10 Known artefacts and counter-measures

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Ripples on water and bed in long runs | terrain changes without the water column changing | water gains what the bed loses (pass 3) |
| Pits and over-deep channel beds | capacity unbounded where water is fast | depth ramp; erosion limited to the height above the lowest neighbour |
| Runaway incision of the channel that already has the flow | positive feedback | talus step every iteration |
| Speckle in the sediment | transport through texels with almost no water | no transport out of a texel with less than `D_MIN` of water |
| No erosion on flat ground | `sinA` tends to 0 | `SIN_MIN` |
| Sediment mass drifts | semi-Lagrangian advection is not conservative | flux-form transport |
| Channels aligned with the axes | N4 pipes on a symmetric input | erodibility jitter; central-difference slope; refinement jitter |
| Checkerboard in the terrain | collocated grid, step too large | the `dt` bound, the water correction, the talus step |
| One-texel spikes of deposit | sediment dropped at once where water vanishes | settling at a rate, never instantly; talus step |
| Only narrow channels | uniform rain | `precipitation` input |
| Water drawn down near the border | open border | accepted; a closed border floods the map |
| Terrain below sea level changes slightly | passes 1 to 3 leave sinks alone, but the talus step and the refinement do not know the sea | accepted in v1 |
| Input roughness reappears on top of deposits after a refinement | the refinement adds back the input's fine detail everywhere | the talus step of the finer level; attenuation by deposit thickness is a later option |
| Smeared sediment fronts | first-order upwind transport | accepted in v1; a MacCormack correction (Stava08) is a later option |

---

## 5. Thermal erosion and mobile layers

### 5.1 Purpose and landforms

`simulate/thermal-erosion` moves material from slopes steeper than the talus angle to
the foot of the slope. It produces talus cones and scree aprons at a uniform
angle below cliffs, blunted peaks, straight slopes, and filled gully heads.

The same pairwise exchange, with a limiter, moves a loose layer over a fixed
bed. Every mobile layer uses it: sediment (`simulate/sediment`), snow (section
10), and later sand and debris.

### 5.2 Interface of `simulate/thermal-erosion`

| Input | Type, role | Meaning |
| --- | --- | --- |
| `in` | field, height | terrain |
| `mask` | field, mask, optional | where material may move: an exchange between two texels is scaled by the smaller of their mask values |

| Output | Role | Meaning | Produced |
| --- | --- | --- | --- |
| `out` | height | relaxed terrain | always |
| `wear` | data | `max(in − out, 0)` | when wanted |
| `deposit` | data | `max(out − in, 0)` | when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `talus` | float, angle (`param.slope`) | 35 | 5..89 | slopes steeper than this collapse |
| `size` | float, length (`param.size`, label Reach) | 0.02 | 0.001..0.25, log | width of the largest talus slope that forms completely. Sets the base level |
| `strength` | float, ratio (`param.strength`) | 1 | 0..1 | fraction of the iteration budget that runs |
| `removal` | float, ratio | 0 | 0..1 | fraction of the moved material that is removed instead of deposited |

Defaults are **to calibrate**.

### 5.3 Model

Per pair of neighbouring texels, the higher gives the lower a fraction of the
height by which their difference exceeds the talus slope (**published**:
Stava08 eq. 5). The gather form, in which each texel computes its own net
change from its N8 neighbourhood and writes only itself, and the stability
bound of the rate are **design, to validate**.

```
give(i → j) = TRANSFER * gate_ij * (dx / run_ij) * max(R * (h_i − h_j) − tanTalus * run_ij, 0)      // metres
gate_ij     = min(mask_i, mask_j)
net_i       = Σ_{j in N8, inGrid} ( keep * give(j → i) − give(i → j) )           keep = 1 − removal
h_i ← h_i + net_i / R
```

- `give` depends only on the two heights and on symmetric factors, so both texels of a pair compute the same number: what one loses the other gains.
- A neighbour outside the grid exchanges nothing: the border is closed.
- `dx / run` is 1 for axial and `1/√2` for diagonal neighbours.

### 5.4 State and memory

| Plane | Kind | Holds | At a refinement |
| --- | --- | --- | --- |
| `h`, `spare` | field × 2 | terrain, ping-pong | `h`: `refineHeight`, jitter off, detail 0 |

2 `field` in the loop. At the end the node releases `spare`, then allocates
`wear` and `deposit`: 3 `field` = 793 MB at 8129².

### 5.5 Passes

Per iteration:

| # | Kernel | Reads | Writes | In place | Loads |
| --- | --- | --- | --- | --- | --- |
| 1 | `simulate/talus.step` | `h` own + N8, `mask` own + N8 | `next` | `wear` (bound to `null` by this node) | 18 |
| | swap | | | | |

After the last level, when `wear` or `deposit` is wanted:

| # | Kernel | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 2 | `simulate/diff` | `before` own (the node input), `after` own | `wear` = `max(before − after, 0)`, `deposit` = `max(after − before, 0)`; either may be `null` | 2 |

### 5.6 The kernel

```ts
const talusStep = defineKernel({
  name: 'simulate/talus.step',
  inputs: { h: 'field', mask: MASK_INPUT },
  outputs: { next: 'field' },
  inPlace: { wear: 'field' },
  params: { talus: 'f32', keep: 'f32' },      // talus: tangent of the angle
  cost: 18,
  code: /* wgsl */ `
const TRANSFER = 0.1;

// Metres of material that the texel with height hFrom gives to the one with height hTo.
// Both texels of a pair call it with the same arguments, so they compute the same number.
fn give(hFrom: f32, hTo: f32, run: f32, gate: f32) -> f32 {
  return TRANSFER * gate * (frame.cellSize / run) * max((hFrom - hTo) * frame.heightRange - P.talus * run, 0.0);
}

fn compute(px: vec2i, uv: vec2f, cur: Cur) -> Out {
  let hp = h_at(px);
  let mp = mask_at(px);
  var gain = 0.0;
  var loss = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = px + vec2i(i, j);
      if ((i == 0 && j == 0) || !inGrid(q)) { continue; }
      let run = frame.cellSize * length(vec2f(vec2i(i, j)));
      let hq = h_at(q);
      let gate = min(mp, mask_at(q));
      gain += give(hq, hp, run, gate);
      loss += give(hp, hq, run, gate);
    }
  }
  let net = (gain * P.keep - loss) / frame.heightRange;
  return Out(hp + net, cur.wear + max(-net, 0.0));
}`,
});
```

The in-place `wear` accumulates the lowering of each iteration. It exists for
`simulate/hydraulic-erosion`, whose wear is gross; `simulate/thermal-erosion` binds it to
`null` and derives its outputs from the difference to the input.

### 5.7 Stability and iterations

- `TRANSFER <= 1/9` keeps a texel with eight lower neighbours of equal excess from overshooting (**design**). The constant is 0.1 and is not a parameter.
- Material moves one texel per iteration, and a slope relaxes by diffusion: forming a talus slope `W` texels wide takes on the order of `W²` iterations, not `W` (**design**; the constant is `RELAX`).

```
total  = strength * RELAX * F²                              F = size * (res_0 − 1)
budget = levelBudget(total, level.count, DETAIL_ITERATIONS_RELAX, 0.25)
coarsestCell = size / FEATURE_CELLS_RELAX
```

- With the starting constants `total` is 128 to 512 at `strength = 1` when the base level is selected by `size`, and every finer level runs at most 96 iterations.
- When `total < 0.5` (a reach of less than half a texel) the node outputs its input.

### 5.8 Invariants and artefacts

1. With `removal = 0`: `|mean(out) − mean(in)| <= 2e-6 + 1e-4 * mean(|out − in|)`.
2. With `removal = 1`: `out <= in` at every texel.
3. A terrain in which no N8 pair exceeds the talus slope is returned bit-identical.
4. With `mask` = 0 everywhere, `out` is bit-identical to `in`.
5. `wear` and `deposit` are never both positive at one texel, and `out = in − wear + deposit` within 1e-7.
6. On the cone fixture, with `size` at least the cone's radius: after the run no N8 pair exceeds the talus slope by more than 5 % of the tangent (**to calibrate** with `RELAX`).

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Run-to-run differences, mass loss | a texel pushing material into neighbours races on a GPU | gather form: a texel writes only itself |
| Octagonal talus cones | N8 exchange with unequal run lengths | weights `dx / run`; threshold `tanTalus * run` per direction |
| Large cliffs barely change at high resolution | diffusion needs `W²` iterations | coarse-to-fine: the base level holds the reach in 8 to 16 texels |
| Oscillation between two states | rate too high | `TRANSFER = 0.1` |
| Total height drifts by float rounding | each texel rounds its own sum | accepted; bounded by invariant 1 |

### 5.9 Mobile layers and `simulate/sediment`

A layer of thickness `s` lies on a bed `bed` that does not move. The surface is
`bed + s`. A texel cannot give more than it has, so the exchange runs in two
passes (**design, to validate**; the limiter has the form of the flux scaling
of Mei07):

```
give(i → j)  as in 5.3, on the surface R * (bed + s), with the layer's own repose tangent and gate = 1
out_i   = Σ_{j in N8, inGrid} give(i → j)
lim_i   = min(1, R * s_i / max(out_i, 1e-20))                                   // pass 1
s_i ← max(0, s_i + ( Σ_j lim_j * give(j → i) − lim_i * out_i ) / R + source_i)  // pass 2
```

| # | Kernel | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 1 | `simulate/layer.limit` | `bed` own + N8, `layer` own + N8 | `lim` | 18 |
| 2 | `simulate/layer.move` | `bed` own + N8, `layer` own + N8, `lim` own + N8, `source` own | `next` | 28 |
| | swap `layer`/`next` | | | |

- `source` is an optional input of `simulate/layer.move` with default 0: the layer gained or lost per iteration, in height units. `simulate/snow` uses it.
- The `max(0, …)` absorbs float rounding; without it the layer goes slightly negative where a texel empties.
- Budget and base level follow 5.7 with `strength = 1`. At a refinement the bed is `levelInput` of the fine level and the layer is refined with `refinePlane`, no jitter.
- A `mask` input of a node that uses the solver is brought to the level that reads it with `levelInput` and released when that level is done (2.7); at `ctx.res` it is the input itself.
- State: `layer`, `next`, `lim` = 3 `field`; the bed is the node's input.

**`simulate/sediment`** lays a uniform layer of loose material on the terrain and
lets it slide into the hollows.

| Port | Type, role | Meaning |
| --- | --- | --- |
| input `in` | field, height | bed |
| input `mask` | field, mask, optional | where material is laid down |
| output `out` | height | `in + depth` |
| output `depth` | data | thickness of the layer, in height units; when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `thickness` | float, height | 0.005 | 0..0.1, soft | thickness laid down where `mask` is 1 |
| `repose` | float, angle (`param.slope`) | 33 | 5..89 | angle of repose of the material (33° is dry sand, Nilles24) |
| `size` | float, length (`param.size`, label Reach) | 0.02 | 0.001..0.25, log | how far the material can slide |

The layer starts as `thickness * mask` on the base level, with `mask` brought
to that level by `levelInput`. Invariants:
`depth >= 0`; `out = in + depth` exactly; on a single level
`mean(depth) = thickness * mean(mask)` within `1e-5 * thickness`.

---

## 6. Depression filling and routing

### 6.1 The routing surface

Water cannot be routed across a terrain with pits. The **routing surface** `w`
of a terrain `z` is the lowest surface that is nowhere below `z` and on which
every texel that is not an outlet has an N4 neighbour lower by at least `eps`:

```
w(c) = z(c)                                             if c is an outlet (1.3)
w(c) = max( z(c), min_{k = 0..3} w(q_k) + eps )         otherwise
```

- For `eps > 0` this system has exactly one solution. Lakes of `z` become planes of `w` tilted by `eps` per texel towards their outlets.
- With `eps = 0` the system has several solutions; the routing surface is the lowest one, the classical filled terrain with level lakes.
- `w − z` is the lake depth.
- `eps` is a normalised height. For routing inside other nodes it is `ROUTE_EPS = max(0.001 / R, 5e-7)`: one millimetre per texel (a 2000-texel lake is tilted by 2 m), and never less than a few float32 steps of a height near 1. For heights above 8 a step of `5e-7` is below float32 resolution; such terrains are outside the supported range of routing.

There are two solvers. They are written to compute the same surface: both
perform the same float32 operations in the same order (6.3). That their
results are bit-identical on a given adapter is **design, to validate** on
every CI adapter: WGSL permits a compiler to fuse and reorder float
operations (`engine.md` 3.14 rule 5). The tests therefore allow one float32
step between them (6.5 item 3).

| Solver | Use | Cost |
| --- | --- | --- |
| Router task on the CPU (6.2) | every cold start: the standalone nodes of sections 6 to 9, the start of each level of `simulate/fluvial-erosion`. It is also the test oracle | one pass over the texels in height order |
| Sweep on the GPU (6.3) | keeping `w` current while the terrain changes a little per step, inside `simulate/fluvial-erosion` | one cheap pass per sweep; a few sweeps per step |

The sweep is the iteration of PD01 in Jacobi form. It lowers an over-estimate
by one texel per sweep and raises an under-estimate by only `eps` per sweep. Started cold it needs as many sweeps as
the longest drainage path has texels, several times the grid width. It is
therefore never started cold.

### 6.2 The router task

Priority-Flood with epsilon (**published**: Barnes14), on N4, in the exact
variant in which every texel passes through the priority queue; followed by
receiver selection and exact accumulation in flood order.

```ts
interface RouteArgs {
  readonly height: Float32Array;                       // res × res, the layout of ctx.read; consumed
  readonly res: number;
  readonly eps: number;                                // normalised; 0 gives level lakes
  readonly seaLevel: number;
  readonly routing: 'none' | 'single' | 'multiple';
  readonly seed: number;                               // u32: mixSeed(ctx.seed, 0); used by 'single'
  readonly weight?: Float32Array;                      // contribution of each texel; default 1 everywhere
}
interface RouteResult {
  readonly filled: Float32Array;                       // the routing surface w
  readonly area?: Float32Array;                        // drainage fraction; absent for routing 'none'
}
declare const route: CpuTask<RouteArgs, RouteResult>;  // name 'simulate/route'
```

Algorithm. All height arithmetic is float32 (`Math.fround`).

1. **Flood.** Every outlet gets `filled = height` and enters a min-heap ordered by (`filled`, texel index). Repeatedly pop the smallest texel `c`, append it to `order`, and for each N4 neighbour `q` not yet reached: `filled[q] = max(height[q], fround(filled[c] + eps))`, mark it reached, push it. With `eps = 0` a raised texel may go to a first-in-first-out queue that is drained before the heap (Barnes14's improved variant); the result is the same. With `eps > 0` it may not: the queue would give a valid but higher surface.
2. **Receivers** (`'single'`), for each texel `i` that is not an outlet:

```ts
// drops to the four N4 neighbours, in the order of 1.3; all values float32
const d = [0, 1, 2, 3].map((k) => Math.max(Math.fround(filled[i] - filled[nb(i, k)]), 0));
const total = Math.fround(Math.fround(Math.fround(d[0] + d[1]) + d[2]) + d[3]);
let pick = 4;
if (total > 0) {
  const t = Math.fround(hashUnit(hashCell(x, y, seed)) * total);
  let run = 0;
  for (let k = 0; k < 4; k++) {
    run = Math.fround(run + d[k]);
    if (d[k] > 0) { pick = k; if (run > t) break; }
  }
}
```

   One lower neighbour is chosen with probability proportional to the drop. On average the flow follows the gradient, without the axis alignment of steepest descent and without the blur of multiple directions (**published**: Jain24, Tzathas24, FastFlow24). On a surface with `eps > 0` every texel that is not an outlet has `total > 0`.
3. **Accumulation.** `area[i] = weight[i] / res²` in float64. Walk `order` backwards, from the highest texel to the lowest. `'single'`: add `area[i]` to the receiver. `'multiple'`: add `area[i] * d[k] / total` to each lower neighbour `k`. A receiver is strictly lower, so it comes later in the walk. The result is rounded to float32.

- Outlets keep the area that reached them; the sum of `area` over the outlets equals the sum of `weight / res²`.
- A node without a `seed` param calls the task with `routing: 'none'` and `seed: 0`.
- The task reports progress through `env.progress` and may be terminated at any time.
- Measured on the development machine for a comparable flood (N8, queue variant, in Node): 192 ms at 1025², 777 ms at 2049², 3.9 s at 4097², 232 ns per texel, which extrapolates to about 15 s at 8129². The exact variant with accumulation is slower. **To calibrate.**

A node calls it as:

```ts
const data = await ctx.read(z);
const r = await ctx.cpu(route, { height: data, res, eps, seaLevel, routing: 'single', seed: mixSeed(ctx.seed, 0) }, [data.buffer]);
ctx.write(w, r.filled);
ctx.write(area, r.area!);
```

### 6.3 The sweep and the receiver kernel

```ts
const fillSweep = defineKernel({
  name: 'simulate/route.sweep',
  inputs: { z: 'field', w: 'field' },
  outputs: { next: 'field' },
  params: { eps: 'f32', lift: 'f32', sea: 'f32' },
  cost: 5,
  code: /* wgsl */ `
fn compute(px: vec2i, uv: vec2f) -> f32 {
  let zp = z_at(px);
  let last = vec2i(frame.res) - vec2i(1);
  if (any(px == vec2i(0)) || any(px == last) || zp <= P.sea) { return zp; }
  let lowest = min(min(w_at(px + vec2i(1, 0)), w_at(px + vec2i(0, 1))), min(w_at(px - vec2i(1, 0)), w_at(px - vec2i(0, 1))));
  return max(zp, (lowest + P.lift) + P.eps);
}`,
});

const receivers = defineKernel({
  name: 'simulate/route.receivers',
  inputs: { z: 'field', w: 'field' },
  outputs: { rcv: 'field' },
  params: { sea: 'f32' },
  includes: [hash],
  cost: 6,
  code: /* wgsl */ `
fn n4(k: i32) -> vec2i {
  var o = array<vec2i, 4>(vec2i(1, 0), vec2i(0, 1), vec2i(-1, 0), vec2i(0, -1));
  return o[k];
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  let last = vec2i(frame.res) - vec2i(1);
  if (any(px == vec2i(0)) || any(px == last) || z_at(px) <= P.sea) { return 4.0; }
  let wp = w_at(px);
  var drop: array<f32, 4>;
  var total = 0.0;
  for (var k = 0; k < 4; k++) {
    drop[k] = max(wp - w_at(px + n4(k)), 0.0);
    total += drop[k];
  }
  if (total == 0.0) { return 4.0; }
  let t = hash_unit(hash_cell(px, seedFor(0u))) * total;
  var run = 0.0;
  var pick = 4.0;
  for (var k = 0; k < 4; k++) {
    run += drop[k];
    if (drop[k] > 0.0) {
      pick = f32(k);
      if (run > t) { break; }
    }
  }
  return pick;
}`,
});
```

Both kernels perform the float32 operations of the router in the same order.
On an adapter that neither fuses nor reorders them the results equal the
router's bit for bit; that this holds is **design, to validate** on every CI
adapter (6.1). A receiver code may differ from the router's where the random
threshold falls within a float32 step of a partial sum; nothing compares the
two. A texel that is not an outlet has four neighbours inside the grid,
because the border ring consists of outlets.

**Warm start** (**design, to validate**). The sweep keeps this property: `w` is
never below the routing surface of the current terrain.

1. At a level start `w` is the router's result: exact.
2. After the terrain has changed by one step, the first sweep runs with `lift` = the largest amount by which the step can have raised any texel, in height units. For `simulate/fluvial-erosion` that is the uplift per iteration. The following sweeps run with `lift = 0`.
3. Raising the old surface by `lift` gives a surface that is nowhere below the new exact one; a sweep of a surface that is not below the exact one is not below it either. The property holds after every sweep.
4. One sweep settles every texel whose receiver was already lower than the texel's new height, which is the ordinary case after an erosion step. The remaining sweeps drain lakes whose outlet was lowered, one texel per sweep.
5. A texel with `w > z` is treated as under a lake and is not eroded. A texel that has not settled yet is skipped for that step; it is never eroded wrongly.

### 6.4 `simulate/fill`

Fills the depressions of a terrain. Landforms: level or gently draining flats
where pits were; every remaining slope leads to the border or the sea.

| Port | Type, role | Meaning |
| --- | --- | --- |
| input `in` | field, height | terrain |
| output `out` | height | filled terrain |
| output `depth` | data | `out − in`, the depth of the fill; when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `tilt` | float, angle (`param.slope`) | 0 | 0..10 | slope of the filled areas towards their outlets; 0 gives level fills |

`eps = tilt > 0 ? max(tan(tilt) * dx / R, 5e-7) : 0`. The tilt is a physical
slope, so it is the same at every resolution.

The node runs the router at `ctx.res` with `routing: 'none'`, writes `filled`
into a new field (`out`) and computes `depth` with one kernel
(`simulate/fill.depth`: `max(out − in, 0)`). It does not use the driver: a
filled surface is not a refinement of a coarser one, because a notch or a dam
one texel wide moves a spill point. State: 2 `field` = 529 MB.

### 6.5 Invariants

For the router, and for `simulate/fill` through it:

1. `filled >= height` everywhere, and `filled = height` at every outlet.
2. With `eps > 0`, every texel that is not an outlet has an N4 neighbour whose `filled` is lower by at least `eps`, within one float32 step.
3. Fixed point: one run of `simulate/route.sweep` with `lift = 0` on the router's result changes no texel by more than one float32 step (the value before and the value after are equal or adjacent float32 numbers). On an adapter that neither fuses nor reorders the operations the result is bit-identical; the test reports which. This ties the two solvers together.
4. Upper bound: from a valid start, after any number of sweeps, `w >= ` the router's result for the same terrain.
5. `area > 0`; with `'single'` it is non-decreasing from a texel to its receiver; its sum over the outlets equals the sum of the weights divided by `res²`, within 1e-4.
6. With `eps = 0`, N4-adjacent texels inside one lake have equal `filled`.

### 6.6 Known artefacts

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Large depressions become tilted mesas | `eps` too large | `eps` is an absolute height per texel, 1 mm for routing |
| Flats that do not drain | `eps` below float32 resolution | floor of `5e-7` |
| Spill points differ between preview and build | a notch or a dam narrower than a preview texel | inherent; documented in the node help |
| The CPU pass takes seconds at build resolution | sequential algorithm | runs off the engine thread with progress; cost **to calibrate** |

---

## 7. Flow accumulation and derived maps: `simulate/flow`

Computes where water collects. Outputs for masks and for other nodes: stream
lines, wet valley floors, dry ridges.

| Port | Type, role | Meaning |
| --- | --- | --- |
| input `in` | field, height | terrain |
| input `precipitation` | field, mask, optional | contribution of each texel; default 1 |
| output `out` | data | drainage area as a fraction of the terrain area, in (0, 1]; weighted by `precipitation` when it is connected, then in [0, 1] |
| output `wetness` | data | topographic wetness index; when wanted |

| Param | Kind | Default | Options | Meaning |
| --- | --- | --- | --- | --- |
| `seed` | seed | 0 | | receiver choice |
| `routing` | enum | `single` | `single`, `multiple` | one random lower neighbour (crisp stream lines), or every lower neighbour in proportion to the drop (smooth) |

Steps: router at `ctx.res` with `eps = ROUTE_EPS`, `weight` = the
`precipitation` field when connected; upload `area` (it is `out`); then one
kernel for `wetness`:

```
wetness = ln( (out * T² / dx) / max(length(slopeAt(in, px)), 0.001) )        // specific catchment area over slope
```

- `out` spans many orders of magnitude; a consumer that wants a mask takes a logarithm or a threshold. A stream mask is `out >= threshold`.
- `out * T² / dx` is the area drained per metre of contour. In a channel one texel wide it doubles when `dx` halves, so `wetness` rises by `ln 2` per ladder level there. This is a property of the index.
- State: 2 `field`. Invariants: 6.5 item 5; `wetness` finite.

The exact accumulation is used, not sweeps on the GPU, because a thresholded
map shows every error of an approximate one. The node has no iterations and no
stability limit; its cost is the router's.

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Jagged stream lines | single receivers on N4 | random receiver choice; `routing: 'multiple'` for smooth maps |
| Parallel stripes across filled lakes | the routing surface is a tilted plane there | accepted; `simulate/lakes` identifies the lakes |
| Stream lines move between preview and build | finer terrain detail changes receivers | inherent to routing; the large streams are stable |

---

## 8. Rivers: `simulate/rivers`

The whole section is **design, to validate**, with defaults **to calibrate**.

### 8.1 Purpose and landforms

Extracts a river network from the terrain's drainage and carves its channels:
continuous channels from the first texel that drains enough area down to the
border, the sea or a lake; tributary junctions; beds that never rise
downstream; banks at a fixed angle; a level water surface in each cross
section.

### 8.2 Interface

| Input | Type, role | Meaning |
| --- | --- | --- |
| `in` | field, height | terrain |
| `headwaters` | field, mask, optional | where rivers may gather water; default everywhere |

| Output | Role | Meaning | Produced |
| --- | --- | --- | --- |
| `out` | height | terrain with carved channels | always |
| `river` | mask | 1 inside a channel | when wanted |
| `depth` | data | water depth in the channel, in height units | when wanted |
| `surface` | height | water surface inside channels, `out` elsewhere | when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `seed` | seed | 0 | | receiver choice |
| `catchment` | float, ratio | 0.002 | 0.00001..0.5, log | share of the terrain that must drain through a texel for it to be a river |
| `riverWidth` | float, length | 0.004 | 0..0.05 | width of a river that drains the whole terrain |
| `riverDepth` | float, height | 0.003 | 0..0.05 | depth of a river that drains the whole terrain |
| `bank` | float, angle (`param.slope`) | 30 | 5..80 | slope of the banks |

### 8.3 State and memory

| Plane | Kind | Holds |
| --- | --- | --- |
| `filled`, `area` | field × 2 | router results |
| `site`, `siteNext` | vec2 × 2 | texel coordinates of the nearest river texel, or (−1, −1); ping-pong |
| `out`, `river`, `depth`, `surface` | field × 4 | outputs |

6 `field` + 2 `vec2` = 2643 MB at 8129².

### 8.4 Steps

| # | Step | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 1 | router at `ctx.res`: `eps = ROUTE_EPS`, `routing: 'single'`, `weight` = `headwaters` | | `filled`, `area` (uploaded) | CPU |
| 2 | `simulate/rivers.site` | `area` own | `site` | 1 |
| 3 | `simulate/jump.step`, strides 1, then `2^(K−1)`, …, 2, 1 | `site` at 9 texels | `siteNext`; swap | 9 |
| 4 | `simulate/rivers.carve` | `in` own, `site` own, `area` and `filled` at the site | `out`, `river`, `depth`, `surface` | 4 |

Step 4 has 4 writable textures. Unwanted outputs are bound to `null`.

### 8.5 Equations

**River texels.** A texel is a river texel when `area >= catchment`. Because
`area` never decreases along receivers, everything downstream of a river texel
is a river texel: the network has no gaps.

**Channel size** from the drained fraction `a` (hydraulic geometry, exponents
of LM53 as commonly cited):

```
width(a) = riverWidth * T * a^0.5                       // metres
depth(a) = riverDepth * R * a^0.4 * saturate(width(a) / dx)
bed      = R * filled − depth(a)                        // at the river texel
```

- The factor `saturate(width / dx)` thins a channel narrower than a texel instead of carving it one texel wide, so a preview does not show wider rivers than the build.
- `filled` decreases and `a` grows along receivers, so `bed` never rises downstream.

**Nearest river texel** by jump flooding (**published**: RT06) with the extra
first pass of stride 1. `simulate/rivers.site` writes `vec2f(px)` at river
texels and `(−1, −1)` elsewhere. `simulate/jump.step` with stride `s` looks at
the nine texels `px + s * (i, j)`, `i, j` in −1..1, that are inside the grid,
and keeps the site nearest to `px`; of two sites at equal distance it keeps the
one with the smaller `y`, then the smaller `x`. `K = ceil(log2(reach))` with
`reach` the largest distance in texels at which a channel can still lower the
terrain:

```
reach = (riverWidth * T / 2 + riverDepth * R / tan(bank)) / dx
```

For `reach < 1`, the strides are just 1. Coordinates are stored as floats in a
`vec2`; they are exact up to 2^24.

**Cross section**, for a texel at distance `r` metres from its site, with
`W = width(a)`, `D = depth(a)` and `bed` taken at the site:

```
zc  = bed + D * (2r / W)²                          if r < W / 2          // parabolic channel
    = bed + D + tan(bank) * (r − W / 2)            otherwise             // bank
out = in − max(R * in − zc, 0) / R                                       // carve only

river   = saturate((W / 2 − r) / dx + 0.5)
depth   = river > 0 ? max(filled_site − out, 0) : 0
surface = river > 0 ? max(filled_site, out) : out
```

A texel without a site within `reach` is unchanged.

### 8.6 Invariants and artefacts

1. `out <= in` everywhere; `out = in` exactly where no site lies within `reach`.
2. The set of river texels is closed under taking receivers.
3. `depth >= 0`; `surface >= out`.

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Jagged, grid-following courses | routing on N4 | random receivers; a noise-warped site lookup is the first later extension, vector meanders a later one |
| Channels wider in the preview than in the build | one-texel minimum width | depth scaled by `saturate(width / dx)` |
| Rivers end in pits | no depression handling | routing on the filled surface; a channel crossing a lake lies at the lake's surface |
| A wrong nearest site for a few texels | jump flooding is approximate | the extra stride-1 pass |
| Bed steps at confluences | depth jumps with the drained area | accepted; follow with `simulate/thermal-erosion` for softer banks |

---

## 9. Lakes and sea level

### 9.1 `simulate/lakes`

Finds the depressions that hold water and describes them. It does not change
the terrain. Landforms: level lakes filled to their spill point.

| Port | Type, role | Meaning |
| --- | --- | --- |
| input `in` | field, height | terrain |
| output `out` | height | the input, unchanged (an alias) |
| output `water` | mask | 1 where a lake is; when wanted |
| output `depth` | data | water depth, in height units; when wanted |
| output `surface` | height | lake level inside lakes, terrain elsewhere; when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `minDepth` | float, height | 0.001 | 0..0.1 | lakes whose deepest point is shallower are dropped |
| `minSize` | float, length | 0.005 | 0..0.25 | lakes whose area is below `minSize²` of the terrain are dropped |

Steps:

1. Router at `ctx.res` with `eps = 0`, `routing: 'none'`: level lake surfaces. Texels at or below sea level are outlets, so the sea is not a lake.
2. Task `simulate/lakes.prune` (`{ height, filled, res, minDepth, minArea }` to `{ level: Float32Array }`; the node reads the input a second time for `height`, because the router consumes its copy): labels the N4-connected sets of texels with `filled > height`, measures each one's largest depth and its area, and returns `filled` for the lakes that pass both thresholds and `height` everywhere else.
3. Upload `level`; kernel `simulate/lakes.maps` reads `in` and `level` and writes `water = level > in ? 1 : 0`, `depth = max(level − in, 0)`, `surface = level`.

State: 4 `field`. Invariants: `depth >= 0`; `water` is 0 or 1; inside one lake
`surface` is one value; no lake texel is an outlet. The exact fill is
**published** (Barnes14); the pruning thresholds are **to calibrate**. The node
has no iterations and no stability limit.

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Speckle of one-texel ponds on a noisy terrain | every pit is a lake | `minDepth`, `minSize` |
| A lake appears or vanishes between preview and build | a notch or a dam narrower than a preview texel | inherent; documented in the node help |
| Hard, aliased shorelines in `water` | the mask is binary | derive a soft shore from `depth` |

### 9.2 `simulate/sea`

Describes the sea for materials and water rendering, and optionally reshapes
the coast.

| Port | Type, role | Meaning |
| --- | --- | --- |
| input `in` | field, height | terrain |
| output `out` | height | the input, or the reshaped terrain when `strength > 0` |
| output `water` | mask | 1 where the sea is; when wanted |
| output `depth` | data | `max(sea − out, 0)` under the sea, in height units; when wanted |
| output `surface` | height | `sea` under the sea, terrain elsewhere; when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `mode` | enum | `connected` | `connected`, `global` | `connected`: only water reachable from the border; inland basins below sea level stay dry. `global`: everything below sea level |
| `strength` | float, ratio (`param.strength`) | 0 | 0..1 | coastal reshaping; 0 leaves the terrain unchanged |
| `shoreSize` | float, length | 0.01 | 0.0005..0.1, log | width of the reshaped band on each side of the shoreline |
| `shoreHeight` | float, height | 0.005 | 0..0.05 | height of the band's top above, and of its bottom below, sea level |

The sea level is the project setting; the node has no level of its own.

**Sea mask.** A texel is below the sea when its height is `<= sea`, the test
that makes it an outlet (1.3). `global`: `water = in <= sea`. `connected`: task
`simulate/sea.connect` (`{ height, res, seaLevel }` to `{ water: Float32Array }`)
floods from the border-ring texels with `height <= seaLevel` through N4
neighbours with `height <= seaLevel`. Both are exact.

**Coastal reshaping** (`strength > 0`; **design, to validate**; there is no
published reference model):

1. Sites: sea texels with an N4 neighbour that is not sea. Jump flooding as in 8.5 with `reach = shoreSize * T / dx` gives every texel its distance `r` to the shoreline, counted positive on land and negative under the sea.
2. Target profile and blend, with `x = r / (shoreSize * T)` in −1..1:

```
target = sea + shoreHeight * x                          // a ramp through the shoreline: beach and shelf
weight = strength * (1 − |x|)²
land:  out = min(in, mix(in, target, weight))           // cut back: a platform and a scarp remain
sea:   out = mix(in, target, weight)
```

3. The reshaping kernel also writes `band = saturate(1 − |x|)`. `COAST_SWEEPS` iterations of `simulate/talus.step` at the angle `COAST_TALUS`, with `band` as its `mask`, relax the undercut scarp without touching the terrain outside the band.
4. Reshaping does not move the shoreline: land stays at or above sea level and the sea bed at or below it. `water` is the mask found before reshaping; `depth` and `surface` use `out`.

State without reshaping: 3 `field`. With it, at the peak: the sea mask, `out`,
`band` and the two site planes, 3 `field` + 2 `vec2` = 1850 MB at 8129². The
site planes are released before the `spare` plane of the talus sweeps is
allocated; `band` and `spare` are released before `depth` and `surface` are.

Invariants: with `strength = 0`, `out` is the input field; `depth >= 0`; in
`connected` mode every sea texel is joined to the border ring through sea
texels.

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| An inland basin floods through a one-texel gap | N4 connectivity through a narrow inlet | `mode: 'connected'` keeps basins without any gap dry; a remaining gap is terrain to fix upstream |
| Reshaped band with a visible seam at its edge | blend weight ends abruptly | the weight `(1 − \|x\|)²` and its slope are 0 at the band's edge |
| Reshaping lowers cliffs far inland | talus sweeps over the whole map | the sweeps are gated by `band` |

---

## 10. Snow: `simulate/snow`

The whole section is **design, to validate**, with defaults **to calibrate**.
The slip-off angle has no verified source.

### 10.1 Purpose and landforms

Covers the terrain with snow that falls above a snow line, slides off steep
faces, collects in hollows and at the foot of slopes, and melts on sunny and
low ground: snow caps, bare cliffs, filled gullies, drifts, a snow line that is
higher on the sunny side.

### 10.2 Interface

| Port | Type, role | Meaning |
| --- | --- | --- |
| input `in` | field, height | terrain |
| input `mask` | field, mask, optional | where snow falls |
| output `out` | height | `in + depth` |
| output `snow` | mask | `saturate(depth * R / SNOW_COVER)`: snow cover; when wanted |
| output `depth` | data | snow thickness, in height units; when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `snowfall` | float, height | 0.004 | 0..0.05, soft | thickness that falls where nothing limits it |
| `snowLine` | float, height | 0.5 | 0..1, soft | altitude above which snow falls |
| `band` | float, height | 0.05 | 0.001..0.5, log | half-width of the transition around the snow line |
| `slipAngle` | float, angle (`param.slope`) | 40 | 5..89 | snow slides off surfaces steeper than this |
| `melt` | float, ratio | 0.3 | 0..1 | share of the snowfall that melts on fully exposed ground at the snow line and above |
| `exposure` | float, ratio | 0.5 | 0..1 | how much the melt depends on facing the sun: 0 = uniform |
| `angle` | float, angle (`param.angle`) | 0 | 0..360 | direction from the terrain towards the sun |
| `size` | float, length (`param.size`, label Reach) | 0.02 | 0.001..0.25, log | how far snow can slide |

### 10.3 State, passes, equations

State: the layered solver of 5.9 with `bed` = the node input at the level and
`layer` = snow depth. Planes `layer`, `next`, `lim` = 3
`field`; at the end `lim` and `next` are released and `out`, `snow` allocated:
3 `field` = 793 MB at 8129².

Per iteration two passes: `simulate/layer.limit`, then `simulate/snow.move`,
which is `simulate/layer.move` with the source computed in the kernel instead
of read from an input:

| # | Kernel | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 1 | `simulate/layer.limit` | `bed` own + N8, `layer` own + N8 | `lim` | 18 |
| 2 | `simulate/snow.move` | `bed` own + N8, `layer` own + N8, `lim` own + N8, `mask` own | `next` | 28 |

```
h       = bed_i + layer_i                                           // surface, normalised
alt     = smoothstep(snowLine − band, snowLine + band, h)
share   = ratio^index / equivalent                                  // of the run's total, per iteration (2.5)
fall    = snowfall * share * mask_i * alt
n       = unit normal of the surface bed + layer (from its N4 neighbours)
L       = (cos(angle) * cos(SUN_ELEVATION), sin(angle) * cos(SUN_ELEVATION), sin(SUN_ELEVATION))
sun     = mix(1, saturate(dot(n, L)), exposure)
thaw    = melt * snowfall * share * sun * (2 − alt)
source  = fall − thaw
layer ← max(0, layer + exchange of 5.9 with tan(slipAngle) + source)
```

- Below the snow line nothing falls and snow that slid there melts at twice the rate.
- `mask` limits where snow falls, not where it slides. It is brought to each level with `levelInput` at the start of `simulate` and released at its end (2.7); at `ctx.res` it is the input itself.
- Budget and base level: 5.7 with `strength = 1`. Refinement: 5.9.

### 10.4 Invariants and artefacts

1. `depth >= 0`; `out = in + depth` exactly; `snow` in 0..1.
2. `mean(depth) <= snowfall`. With `melt = 0`, `mask` unconnected and `snowLine + band` below the whole terrain, on a single level: `mean(depth) = snowfall` within `1e-4 * snowfall`.
3. With `snowfall = 0`, `out` is bit-identical to `in`.
4. After the run on the cone fixture no N8 pair of the snow surface that still carries snow exceeds `tan(slipAngle)` by more than 5 %.

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Snow on vertical faces | accumulation ignores slope | the slide moves it off within the reach |
| Terraced snow line | abrupt altitude threshold | `band` |
| Thin speckled snow near the line | fall and thaw nearly cancel | `SNOW_COVER` threshold in the `snow` mask |

---

## 11. Designs after v1

These are outlines. Nothing in v1 depends on them; their node types are
reserved (1.1).

### 11.1 Dunes: `simulate/dunes`

The deterministic dune model of Nilles24 (**published**, MIT), adapted to
gather form (**design, to validate**).

- State, 9 `field`: `bedrock`, `sand`, `sandNext`, `slab`, `slabNext`, `shadow`, `windU`, `windV`, `lim`.
- Passes per step: wind field (1), wind shadow (1), saltation (2), reptation (1), avalanching (2 per sweep, the layered solver of 5.9).
- Published constants: wind speed-up `1 + 5e-3 * height`; wind shadow ramps from 10° to 15°, marched upwind over 10 m; sand repose 33°, bedrock 68°.
- Adaptations: the original moves airborne sand with a bilinear splat that needs float atomic adds, which WGSL lacks; the gather form advects the `slab` plane backwards along the wind and ping-pongs it. The original smooths gradients with an FFT; two coarse ladder levels of the height replace it.
- Cost reference (RTX 4080, published): 1000 steps take about 1 s at 1024² and 48 to 82 s at 4096²; avalanching is 35 to 85 % of a step and its sweeps double with resolution. The node therefore simulates on the ladder level nearest 1017 or 2033 and refines.

### 11.2 Glacier: `simulate/glacier`

Shallow-ice flow after the released shader of Argudo20 (**published**, MIT).

```
surface  = bed + ice
D        = ice³ * (Γd * ice² + Γs) * |∇surface|²            Γd = 7.26e-5, Γs = 3.27, time in years
ice ← max(0, ice + dt * (balance + div(D * ∇surface)))
balance  = β * (surface − ELA)                              accumulation above the equilibrium line, ablation below
```

- State: `bed` (input), `ice`, `iceNext`, plus inputs for the equilibrium-line altitude and the balance gradient.
- Stability: `dt <= dx² / (4 * Dmax)`. `Dmax` is a whole-field maximum; a step size taken from it would make the node `resolutionDependent`, so the node uses a bound computed from its parameters instead (**design, to validate**).
- The original uses doubles; `D` grows with the fifth power of the thickness. Whether float32 suffices is the first thing to test.
- Ice is smooth: the node simulates on a ladder level near 509 or 1017 and refines with `refinePlane`.
- Glacial carving of the bed (U-shaped valleys) has no verified model here.

### 11.3 Other reserved work

| Item | Note |
| --- | --- |
| `simulate/droplets` | Not on the GPU: the known GPU forms race or need float atomics. A deterministic CPU node at capped resolution is the candidate |
| `simulate/debris` | Debris-flow erosion of Jain24 on the routing of section 3 |
| Sediment transport in `simulate/fluvial-erosion` | FastFlow24 eq. 5; lake sedimentation of Jain24 eq. 22 |
| Meanders | noise-warped site lookup in 8.5 first; vector meander migration later |
| `A^(−h)` hillslope term | Tzathas24; rounds ridges inside `simulate/fluvial-erosion` |

---

## 12. Licences of reference code

Equations, constants and methods described in a paper are implemented from the
paper. Source code is a different matter:

| Source | Licence | Rule |
| --- | --- | --- |
| H-Schott/StreamPowerErosion, H-Schott/MultiScaleErosion | MIT | may be read and adapted; keep the notice with any adapted code |
| LanLou123/Webgl-Erosion, bshishov/UnityTerrainErosionGPU | MIT | same |
| SebLague/Hydraulic-Erosion, weigert/SimpleHydrology, weigert/SoilMachine | MIT | same |
| aparis69/Desertscapes-Simulation, aparis69/Meandering-rivers, Clocktown/CUDA-Dune-Simulation, oargudo/glaciers | MIT | same |
| GPU-Gang/WebGPU-Erosion-Simulation | BSD-3-Clause | may be read and adapted; keep the notice and the no-endorsement clause |
| r-barnes/richdem, fastscape-lem/fastscapelib | GPL-3.0 | reference for behaviour only. No code and no translated code |
| gitlab.inria.fr/landscapes: fastflow, debrisflow, analytical-terrains | not verified | do not read the code for implementation. Work from the papers (FastFlow24, Jain24, Tzathas24) |
| Axel Paris's thermal-erosion shaders (blog, vincentriche/Outerrain) | not stated | do not copy. The method is described in prose and in Stava08 |
| Shadertoy shaders without an explicit licence | not verified | do not derive from them |

1. No file of the engine is derived from a source whose licence is GPL or is not verified.
2. Code adapted from an MIT or BSD source carries that source's notice in the file header and is listed in the repository's third-party notices.
3. The Priority-Flood implementation is written from Barnes14, not from richdem.

---

## 13. Calibration register

Every number below is a named constant in one module of the `simulate`
category. No kernel or node contains another tuning literal. A value marked
**fixed** follows from a derivation in this document and is not tuned.

| Constant | Value | Unit | Used in | Status and source |
| --- | --- | --- | --- | --- |
| `FEATURE_CELLS` | 32 | texels | 3.8, 4.8 | to calibrate |
| `FEATURE_CELLS_RELAX` | 8 | texels | 5.7, 5.9, 10 | to calibrate |
| `DETAIL_SLOPE` | 0.1 | cell fraction | 2.4 | to calibrate |
| Jitter half-width | 0.25 | coarse texels | 2.4 | fixed; Tzathas24 |
| `COURANT` | 0.5 | texels per iteration | 3.6 | fixed; stability |
| `CELERITY_CAP` | 4 | none | 3.3 | to calibrate |
| `TALUS_RATE` | 0.1 | none | 3.3 | to calibrate; between the ratios implied by Jain24 (0.03) and Tzathas24 (0.2) at a 1 km feature |
| `DETAIL_ITERATIONS_FLUVIAL` | 256 | iterations | 3.7 | to calibrate; estimate 200 to 300 |
| `FILL_SWEEPS` | 4 | sweeps per step | 3.5 | to calibrate; range 2 to 8 |
| `ROUTE_EPS` | `max(0.001 / R, 5e-7)` | height | 6.1 | to calibrate; 1 mm per texel |
| `G` | 9.81 | m/s² | 4 | fixed |
| `H_REF` | 20 | m | 4.3 | to calibrate; JT11's pipe area at unit cell size |
| `PIPE_SAFETY` | 0.5 | none | 4.7 | fixed; stability |
| `NOMINAL_SPEED` | 0.25 | none | 4.7 | to calibrate |
| `RAIN_MAX` | 0.05 | m/s | 4.6 | to calibrate; top of JT11's range |
| `KE` | 0.015 | 1/s | 4.6 | to calibrate; JT11 typical |
| `KD_MAX` | 10 | m | 4.6 | to calibrate; JT11 typical |
| `SIN_MIN` | 0.02 | none | 4.6 | to calibrate; Mei07 requires a floor and gives no value |
| `D_MIN` | 1e-4 | m | 4.6 | to calibrate |
| `ERODIBILITY_JITTER` | 0.25 | none | 4.6 | to calibrate |
| `DETAIL_ITERATIONS_HYDRAULIC` | 384 | iterations | 4.7 | to calibrate; estimate 400 to 800 |
| `TRANSFER` | 0.1 | none | 5.3 | fixed; bound 1/9 to validate |
| `RELAX` | 2 | none | 5.7 | to calibrate |
| `DETAIL_ITERATIONS_RELAX` | 96 | iterations | 5.7 | to calibrate; estimate 100 |
| River exponents | 0.5, 0.4 | none | 8.5 | fixed; LM53 as commonly cited |
| `COAST_SWEEPS` | 32 | iterations | 9.2 | to calibrate |
| `COAST_TALUS` | 35 | degrees | 9.2 | to calibrate |
| `SUN_ELEVATION` | 45 | degrees | 10.3 | to calibrate |
| `SNOW_COVER` | 0.1 | m | 10.2 | to calibrate |

Parameter defaults and ranges of sections 3 to 10 are starting values of the
same standing.

**Measured reference points** (development machine: GTX 1660 Ti, Dawn on
Vulkan, Node 26). They are the only numbers in this document measured on this
project's hardware; everything derived from them is an estimate.

| Measurement | Value |
| --- | --- |
| 5-point stencil pass, `field` ping-pong, 2048² | 0.29 ms (14.3 G texel-passes per second); the same per texel at 1024² |
| Four-pass pipe-model iteration, 2048² | 3.03 ms with `field` and `aux` state; 2.49 ms with in-place flux and a compact velocity |
| Priority flood in Node (N8, queue variant) | 192 ms at 1025², 777 ms at 2049², 3.9 s at 4097² |
| Readback of a `field` | 853 MB/s |

**What calibration must settle before defaults are frozen:**

1. The `DETAIL_ITERATIONS_*` constants and `RELAX`: on three reference terrains, at the ladder levels 1017 and 4065, the constant is the smallest value for which doubling it changes `out` by less than 2 % rms of the standard deviation of `out − in`.
2. `FEATURE_CELLS`: the smallest value for which a run from the selected base level differs from a run started one level finer by less than 5 % rms of the same measure.
3. `FILL_SWEEPS`: whether lakes drain visibly late at 2, 4 and 8 sweeps per step.
4. The hydraulic rates (`H_REF`, `RAIN_MAX`, `KE`, `KD_MAX`, the three rate defaults) on terrains of 2 km and 16 km width, so that default parameters give gullies of the feature size and neither flood nor strip the terrain.
5. The time of the router at 8129² in the engine's CPU thread. If it exceeds the GPU work of the level it serves, the routing surface and the area of `simulate/fluvial-erosion`'s finest level are instead refined from the coarser level and corrected by sweeps; that change is made in this document first.
6. Whether float32 drainage area is adequate at 8129² (sums of 6.6e7 contributions; the router accumulates in float64, the per-step sweep in float32).
7. The `resolutionTol` of each node: the measured rms difference between its output at 513 and at 257 on the `terrain` fixture, relative to the standard deviation of the output, plus a margin.

---

## 14. Fixtures the invariants need

The harness, the fixtures and the tolerances of the conformance suite are
`testing.md`'s. The invariants of this document are asserted on these fixtures
of `testing.md` 2.2:

| Fixture | Invariants |
| --- | --- |
| `terrain` (band-limited, with closed depressions) | every node; the router invariants of 6.5 |
| `cone` (flank steeper than every talus default) | thermal 5.8 item 6; snow 10.4 item 4 |
| `bowl` (border ring highest) | hydraulic 4.9 item 3 |
| `notch` (a plane with one channel, no depression, nowhere steep) | fluvial monotone flow 3.9 item 5; rivers 8.6 item 2; thermal 5.8 item 3 |
| `basin` (a depression below the test sea level that does not touch the border) | lakes 9.1; sea `connected` against `global` 9.2 |

The fixed-point and upper-bound invariants (6.5 items 3 and 4) run the router
task and `simulate/route.sweep` on the same terrain at 257² and 513². Item 3
is compared with the tolerance it states, which is the row "a CPU task against
a GPU kernel" of `testing.md` 3.4.
