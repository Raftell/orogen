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
| Holmgren94 | Holmgren: Multiple flow direction algorithms for runoff modelling in grid based elevation models, 1994 (the exponent form as commonly cited; not checked against the paper) |
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
| `simulate/rivers` | river extraction and carving | no | `simulate/route`, `simulate/water-course` | 8 |
| `simulate/lakes` | lakes | no | `simulate/route`, `simulate/lakes.prune` | 9.1 |
| `simulate/sea` | sea mask and depth; coastal reshaping | no | `simulate/sea.connect` (mode `connected`) | 9.2 |
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
| talus (`_talus.ts`) | `simulate/talus.step` | `TALUS_PAIRS`, `talusLoad`: the eight pairs of a texel and the slope at the middle of each, as WGSL text, which the layer module uses too | 5.3, 5.6 |
| (in `fluvial-erosion.ts`) | the library `simulateFluvial`, shared by that node's `spread` and `erode` kernels | | 3.6 |
| layer (`_layer.ts`) | `simulate/layer.limit`, `simulate/layer.move`; the library `simulateLayer` | | 5.9 |
| route (`_route.ts`) | task `simulate/route`; `simulate/route.receivers`, `simulate/route.sweep`, `simulate/route.weight` | `routeEps`, `routeWeight` | 6 |
| water-jump (`_water-jump.ts`) | `simulate/water-jump.step`, `simulate/water-jump.rivers` | `nearestSites`, `jumpStrides` | 8.5 |
| water-course (`_water-course.ts`) | task `simulate/water-course` | `COURSE_WGSL`, the form in which the task hands a river's sites to kernels; `VALLEY_WGSL`, the measures and the cross section of a river's valley | 8.5 |
| diff (`_diff.ts`) | `simulate/diff` | | 5.5 |
| constants (`_constants.ts`, `_water-constants.ts`) | | every constant of section 13; `wgsl(value)`, a constant as a WGSL float literal | 13 |

The refine module is `_refine.ts`. It and `_constants.ts`, with the constants
it uses, exist before the nodes do (`nodes.md` section 4). A kernel or task is
named for the file that defines it (`testing.md` section 4, `kernel-name`), so
the jump-flooding module of the hydrology owner, whose files begin `_route` or
`_water`, is `_water-jump.ts` and its kernels are `simulate/water-jump.*`.

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

The router uses N4 everywhere: filling, receivers and accumulation agree on the
connectivity, so a filled surface always has a receiver for every texel that is
not an outlet. The loop of `simulate/fluvial-erosion` shares its drainage area
over N8 on that surface (3.6): a texel with a lower N4 neighbour has a lower
N8 neighbour.

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
| 2 | the random share of the flow partition (`simulate/fluvial-erosion`, 3.6) |
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
| `simulate/hydraulic-erosion` | 9 `field` + 1 `vec2` | 2907 MB | 83 % |
| `simulate/rivers` | 7 `field` + 2 `vec2` | 2907 MB | 83 % |
| `simulate/fluvial-erosion` | 7 `field` | 1850 MB | 53 % |
| `simulate/sea` with coastal reshaping | 3 `field` + 2 `vec2` | 1850 MB | 53 % |
| `simulate/lakes`, `simulate/thermal-erosion`, `simulate/sediment`, `simulate/snow`, `simulate/sea` without coast | 3 `field` | 793 MB | 23 % |
| `simulate/fill`, `simulate/flow` | 2 `field` | 529 MB | 15 % |

Each section lists the planes. Rules that keep these figures true:

1. Within a level, a node allocates every plane before the level's first `ctx.loop`.
2. A node releases scratch planes before it allocates the fields of its secondary outputs.
3. During refinement (2.6) coarse planes are released one by one as their fine replacements are encoded. The peak of a refinement stays below the peak of the level it leads to.
4. A run with several levels allocates its top-level state in the last refinement. The coarser levels cost a small share of the run (2.3), so a state that does not fit the budget fails early in the node's work.

The router task (6.2) holds its arrays in ordinary memory, not in textures:
14 bytes per texel at the peak with `routing: 'single'`, measured (section 13):
the surface in place of the heights (4), a byte of marks and receiver codes
(1), the float64 sums of the accumulation (8), and the lists of the flood,
which are gone before the sums are taken. What the flats need (6.2 step 3)
lies in the bytes of the sums until those are taken. That is 0.93 GB at 8129²,
and 4 bytes per texel more with a `weight`. The course task of
`simulate/rivers` (8.5) holds the terrain, the routing surface, the area and
the receiver codes it is given, 13 bytes per texel, and 4 more for the plane
it adds: 1.12 GB at 8129². Beside that it keeps about 170 bytes for each river
texel. At 4033 on `generate/eroded-noise`, 0.3 % of the texels are river
texels at the default `catchment` and 6.3 % at the smallest; rivers are lines,
so the share halves with every ladder level, and at 8129² that is 17 MB and
0.36 GB. The task takes 0.2 s and 0.9 s at 4033.

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

- `P.jitter` is 0.5 with jitter, twice `JITTER_HALF_WIDTH`, and 0 without. `P.noiseSeed` is `mixSeed(salt, 1)`.
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
| `simulate/fluvial-erosion` | `refineHeight`, jitter on, then `simulate/fluvial-erosion.settle` (3.6) | none | routing surface, drainage area, partition weights |
| `simulate/hydraulic-erosion` | `refineHeight`, jitter on | water, sediment and flow: `refinePlane`, no jitter | flux (cleared), scratch |
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
   A node that must do something in every run whatever the reach (snow falls even where it cannot slide) takes `max(total, 1)`, one iteration on the base level.
2. `equivalent` equals `total` up to the rounding of `nBase`, whatever the number of levels. A preview and a build therefore simulate the same distance, the same duration and the same totals; they differ in how much of it runs on fine grids.
3. A quantity that must sum to a given total over the run (uplift, snowfall, simulated time) is applied per iteration in proportion to `ratio^i / equivalent`.
4. `perLevel` is the algorithm's `DETAIL_ITERATIONS_*` constant. It bounds the work per finer level: the cost of a run is dominated by that many iterations at `ctx.res`.
5. When `total < 0.5` no level simulates; refinement of an unchanged terrain returns the input bit for bit (1.7).

Starting schedules for a build at 8129 with default parameters:

| Node | Defaults | Levels | Iterations per level | Same work on 8129 alone |
| --- | --- | --- | --- | --- |
| `simulate/fluvial-erosion` | size 0.125, duration 1 | 1017 to 8129 | 818, 256, 256, 256 | 8331 |
| `simulate/hydraulic-erosion` | size 0.05, duration 2 | 2033 to 8129 | 2011, 384, 384 | 9196 |
| `simulate/thermal-erosion` | size 0.005, strength 1 | 2033 to 8129 | 383, 96, 96 | 6606 |

The same nodes in a preview at 1017 run 1042, 1150 and 104 iterations, each
on the one level 1017: the base level of the first, and a level coarser than
the base level of the other two (2.8 item 3).

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
      const tangent = Math.tan((talus * Math.PI) / 180);
      const params = { talus: tangent, fan: tangent, keep: 1 - removal };
      await ctx.loop(budget[level.index]!, () => {
        ctx.run(talusStep, { in: { h: s.h, mask: gate }, out: { next: s.spare }, params, cost: 18 });
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
| `seed` | seed | 0 | | the random share of the flow partition, refinement jitter; the receivers of the `flow` output |
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
| Fresh catchments | on a level finer than the base, `κ = max(κ, min(κ * boost * min(aFresh / a, 1), CELERITY_CAP))`, with `aFresh = (2 * FRESH_CELLS / (res − 1))²` and `boost` of 3.6 | A finer level is the first to hold catchments a few of its texels wide, and has a small share of the run to cut them in: at the defaults a 4033 build spends 256 of some 6500 iterations' worth there. Seen side by side at 2049, one to one, on `generate/mountain`: without the term the build is the picture of its base level enlarged, sharp ridges with smooth facets between the valleys, while a run on the one level 2049 has fine parallel valleys on every slope. With the term the valley sides carry short side valleys, fewer and shallower than in the one-level run. The large valleys, which the coarser levels have cut, are left |
| Erodibility | both terms are multiplied by `mask` | |
| Base level | ground above the sea is never lowered to it: no lower than `sea + ROUTE_EPS` | A texel that drains into the sea would otherwise be cut down to the sea floor beside it, and be sea at the next level |

**Routing** (**design, to validate**; the partition by a power of the slope is
**published**, Holmgren94). Every texel shares its drainage area among all of
its lower N8 neighbours on the routing surface, in proportion to the fall per
unit of run to the power `FLOW_SPREAD`, times a random factor of its own for
each neighbour (3.6). The first version of the node drew one receiver among
the four axial neighbours, as Jain24 and Tzathas24 do on their grids. Its
owner reported, from the 4033 crop, short straight valleys along the rows and
columns on every slope that faces within some ten degrees of one, which a
channel-head threshold, a wear of convex ground and a smoothing at each
refinement reduced and did not remove. Measured on the `cone` fixture with
that version, the flanks that face a row or a column were cut 12 to 24 %
deeper than those that face a diagonal (three seeds). With the shared
partition the same measure is 0 to 2 %, the 4033 crop shows side valleys that
follow the fall line in every direction and none along a row or column, and a
smooth input (the `terrain` fixture) is cut into a feathered network by the
random factor alone. The three reducing terms are gone with their cause.
Exponents of 1, 1.5 and 2.5 gave the same picture at 1025.

Slope exponents other than 1, deposition of the eroded material, linear
hillslope diffusion and the `A^(−h)` hillslope term of Tzathas24 are not in v1.

### 3.4 State and memory

| Plane | Kind | Holds | At a refinement |
| --- | --- | --- | --- |
| `z`, `zNext` | field × 2 | terrain, ping-pong | `z`: `refineHeight`, jitter on |
| `area`, `areaNext` | field × 2 | drainage fraction `a`, ping-pong | recomputed by the router |
| `w`, `wNext` | field × 2 | routing surface (6.1), ping-pong | recomputed by the router |
| `tot` | field | the sum of a texel's partition weights (3.6); 0 for an outlet | recomputed every iteration |

7 `field` = 1850 MB at 8129². In a refinement the terrain passes through one more field of the fine level,
which `simulate/fluvial-erosion.settle` reads and the node then releases, before the scratch planes of that level are
allocated. After the loop `simulate/fluvial-erosion.finish` writes
`out` into the spare terrain plane; the node then releases the other terrain
plane, `areaNext`, `wNext`, `tot` and `w` before it allocates `wear`. `flow` is
the `area` plane. The inputs `mask` and `upliftMask` are brought to each level
with `levelInput` at the start of `simulate` and released at its end (2.7); at
`ctx.res` they are the inputs themselves. An unconnected one is bound as
`null` and reads 1. These per-level copies are in addition to the 7 planes: at
most 2 `field` of the level's size, and none at `ctx.res`.

### 3.5 Passes

At the start of each level that has iterations, in `simulate` (not a pass):
read `z`, run the router (6.2) with `routing: 'multiple'`, write `w` and
`area`. The loop shares the area among all lower neighbours, so the area it
starts from is shared so too; the router's partition is over N4 and by the
fall alone, and the sweeps of the first iterations bring it to the loop's own.

Per iteration:

| # | Kernel | Reads | Writes | In place | Loads |
| --- | --- | --- | --- | --- | --- |
| 1 | `simulate/fluvial-erosion.spread` | `z` own, `w` own + N8 | `tot` | | 12: 10 loads, and eight powers and hashes |
| 2 | `simulate/fluvial-erosion.erode` | `z` own, `w` own + N8, `area` own + N8, `tot` own + N8, `mask` own, `upliftMask` own | `zNext`, `areaNext` | | 34: 30 loads, and eight powers and hashes |
| | swap `z`/`zNext`, `area`/`areaNext` | | | | |
| 3 | `simulate/route.sweep`, `FILL_SWEEPS` times, swapping `w`/`wNext` after each | `z` own, `w` N4 | `wNext` | | 5 |

After the last level:

| # | Step | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 4 | router once more on `z`, with `routing: 'single'`, when `lakeFill > 0` or `flow` is wanted: exact `w`, and the `area` of single receivers | | | CPU |
| 5 | `simulate/fluvial-erosion.finish` | `z` own and the neighbour one texel inwards, `in` at that neighbour, `w` own | `out` (the spare terrain plane) | 4 |
| 6 | `simulate/diff`, when `wear` is wanted | `in` own, `out` own | `wear` (`deposit` bound to `null`) | 2 |

In a refinement, after `refineHeight`:

| Kernel | Reads | Writes | Loads |
| --- | --- | --- | --- |
| `simulate/fluvial-erosion.settle` | the refined terrain own, `fineBase` own | `z` of the fine level | 2 |

No pass has more than 2 writable textures. Nothing is updated in place.

### 3.6 Update equations

`simulate/route.sweep` is defined in section 6.

The partition, in the library `simulateFluvial` of the node's file. For a
texel `i` and its N8 neighbour `q`, `steps` being 1 for an axial and `√2` for
a diagonal neighbour:

```
weight(i → q) = (max(w_i − w_q, 0) / steps)^FLOW_SPREAD * (1 + FLOW_JITTER * (2 ξ(i, q) − 1))
ξ(i, q)       = hash_unit(hash_cell(3 * i + (q − i), seedFor(2)))           // one number per texel and neighbour, constant over a level
```

`simulate/fluvial-erosion.spread`: `tot_i = Σ_{q in N8} weight(i → q)`, and 0
for an outlet. A neighbour outside the grid cannot be lower than a texel that
is not an outlet, because the border ring consists of outlets.

`simulate/fluvial-erosion.erode`, for texel `i` with N4 neighbours `q_k`:

```
areaNext_i = 1 / res² + Σ_{q in N8, inGrid(q), tot_q > 0} area(q) * min(weight(q → i) / tot_q, 1)

if outlet(i):                         zNext_i = z_i
else if tot_i = 0 or w_i > z_i:       zNext_i = z_i + lift * upliftMask_i        // a pit of w, or under a lake
else:
    gx  = R * max(0, w_i − w(q_0), w_i − w(q_2)) / dx
    gy  = R * max(0, w_i − w(q_1), w_i − w(q_3)) / dx
    S   = sqrt(gx² + gy²)                                                         // upwind slope, Jain24 eq. 18
    law = min((area_i / size²)^m, CELERITY_CAP)
    κ   = max(law, min(law * boost * min(aFresh / area_i, 1), CELERITY_CAP))      // fresh catchments, 3.3
    e   = STEP * dx * (κ * S + TALUS_RATE * max(S − tanTalus, 0))                 // metres
    z1  = max(z_i − mask_i * e / R, min(z_i, max(min_k w(q_k), land)))            // never below the lowest N4 neighbour, never down to the sea
    zNext_i = z1 + lift * upliftMask_i

STEP   = COURANT / (CELERITY_CAP + TALUS_RATE)
lift   = uplift * ratio^index / equivalent                                        // per iteration, normalised height (2.5)
land   = sea + ROUTE_EPS                                                          // the lowest height of ground above the sea
alone  = duration * size * (res − 1) * (CELERITY_CAP + TALUS_RATE) / COURANT      // the iterations of a run on this level alone
boost  = max(FRESH_BOOST * alone / iterations, 1) on a level finer than the base; 1 on the base level
aFresh = (2 * FRESH_CELLS / (res − 1))²                                           // a catchment FRESH_CELLS texels of the coarser level wide
```

- The slope and the clamp use the routing surface `w`. Where a texel is eroded, `w_i = z_i`.
- A texel and the neighbour it gives to compute the weight of the gift from the same loads, so the area a texel passes on is the area its neighbours receive, up to the rounding of each texel's own sum. The upwind slope is **published** (Jain24, Tzathas24). One accumulation sweep per erosion step is **published** (Schott23, Jain24).
- An outlet never changes: it is the base level.
- Ground above the sea stays above it by `ROUTE_EPS`, so it still has a lower neighbour in the sea it drains to and is not itself an outlet at the next level.
- The random factor makes the output depend on the seed on a single level too, and lets valleys form on ground that is the same in every direction.

`simulate/fluvial-erosion.settle`, on the terrain `r` that `refineHeight` returns:

```
fineBase_i <= sea:   z_i = fineBase_i                          // the sea and its floor are the input
otherwise:           z_i = max(r_i, min(fineBase_i, land))
```

The sea takes no part in what the coarser level did (**design, to
validate**). The interpolation brings the lowering of a coarse texel to every
fine texel around it. At the foot of a mountain that stands on ground at sea
level it drew a moat 45 m deep into that ground, which the finer level, where
the moat is sea, then kept. (A first version also smoothed the change with a
1-2-1 filter, against creases along the rows and columns of the coarser
level. Drawn with and without it at 2049, with the routing above, the two
pictures cannot be told apart: the kernel no longer smooths.)

`simulate/fluvial-erosion.finish`:

```
interior texel:                 out_i = z_i + lakeFill * max(w_i − z_i, 0)
border ring, z_i <= sea:        out_i = z_i
border ring, otherwise:         out_i = max(z_i − max(in_n − z_n, 0), min(z_i, land))        n = the neighbour one texel inwards (diagonally, at a corner)
```

A border texel is fixed during the run. The border rule gives it the lowering
of its inward neighbour afterwards, which removes the one-texel wall that a
fixed border leaves where the terrain beside it was lowered.

### 3.7 Stability, time step, iterations

- The scheme is an explicit upwind advection of the terrain along flow lines. One iteration moves the incision front by `STEP * κ * dx`, at most `COURANT * dx`. With `COURANT = 0.5` a texel loses at most 0.71 times its largest N4 drop per iteration and stays above its lowest neighbour; the speed of a fresh catchment is under the same cap. The clamp to the lowest N4 neighbour is a safeguard beside that.
- There is no time step in seconds. The step per iteration is fixed in texels, so the number of iterations follows from the cell size alone:

```
total = duration * F * (CELERITY_CAP + TALUS_RATE) / COURANT        F = size * (res_0 − 1)
budget = levelBudget(total, level.count, DETAIL_ITERATIONS_FLUVIAL, 0.5)
```

- With the constants of section 13 `total = 8.2 * duration * F`: 525 to 1050 per unit of `duration` when the base level is selected by `size`.
- The fill converges from above only (6.3). Each erosion step is followed by `FILL_SWEEPS` sweeps warm-started from the previous surface.

### 3.8 Schedule on the ladder

`coarsestCell = size / FEATURE_CELLS`. Per level: router, then
`budget.iterations[index]` iterations of passes 1 to 3. Refinement:
`refineHeight` with jitter on, `salt = mixSeed(ctx.seed, fine.res)` and the
node's `detail`, then `simulate/fluvial-erosion.settle`. The default schedule
is in 2.5.

`FEATURE_CELLS` is 64 (section 13). It was raised from 32 with the first
routing, to make the valleys of the base level finer; with the routing of 3.3
and the fresh catchments the comparison of item 2 of section 13 is still to
make, and 32 may do.

Cost at 8129² on the development GPU, estimated: 66 loads per texel per
iteration, about 60 ms, from the measured 0.29 ms per 5-load pass at 2048²;
256 iterations take about 16 s. The router costs as much at 8129² (6.2). Both
are **to calibrate**. Measured: 4.3 s for the node at 2049² (levels 513, 1025,
2049) and 16.7 s at 4033² (505 to 4033), routers included; the longest slice
of the 4033 run is 78 ms, 112 ms with every parameter at its maximum.

### 3.9 Invariants

With `uplift = 0`, `lakeFill = 0` and `detail = 0`:

1. `out <= in` at every texel, exactly.
2. `out = in` exactly at every texel at or below the sea level that is not on the border ring, on one level and across refinements, and no texel above the sea level is lowered to it.
3. `wear = in − out` within 1e-7.
4. With `mask` = 0 everywhere, `out` is bit-identical to `in`.

With `lakeFill = 1` and `uplift = 0`:

5. Monotone flow: every texel of `out` that is not an outlet has an N4 neighbour that is lower by at least half of `ROUTE_EPS`.

Always:

6. `flow` is positive, non-decreasing from a texel to its receiver, and its sum over the outlets is 1 within 1e-4.

On the `cone` fixture, without a sea:

7. The flanks that face a row or a column and those that face a diagonal are worn alike: the mean `wear` within 10° of the axes is 0.9 to 1.1 times that within 10° of the diagonals, on the flank between 16 and 56 texels from the tip at 257.

### 3.10 Known artefacts and counter-measures

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Valleys aligned with the axes or diagonals | steepest-descent routing; one receiver among four neighbours | the water is shared among all lower N8 neighbours by the fall per unit of run (3.3); invariant 7 |
| Blurred, braided drainage | water shared evenly among many neighbours | the partition follows the fall to the power `FLOW_SPREAD`; not seen at 1, 1.5 or 2.5 |
| Erosion stops in every pit | water has nowhere to go | routing on the filled surface `w`; exact router at each level start |
| A lake drains late after its outlet is cut | a sweep lowers a lake by one texel per sweep | `FILL_SWEEPS` sweeps per step; exact router at the next level start and before the outputs |
| Drainage area lags behind a changing network | one accumulation sweep per step | exact area at each level start; `flow` recomputed exactly at the end |
| Slot canyons | stream power acts only where area is large | slope-limit term |
| A build is its preview enlarged: smooth slopes between the valleys of the base level | a finer level has a small share of the run | fresh catchments (3.3) |
| Knife-edge ridges | no hillslope diffusion in v1 | follow the node with `simulate/thermal-erosion` |
| A moat around a landmass that stands in the sea | the refinement interpolates the lowering of the coast onto the sea floor | `simulate/fluvial-erosion.settle` |
| A hard rim along a coast | the land beside the sea is cut down to `ROUTE_EPS` above it, and the sea floor is the input | accepted in v1; `simulate/sea` reshapes a coast |
| Coast cut down to the sea floor | the lowest neighbour of a coastal texel is a sea texel, which may lie far below the sea level | ground above the sea stays `ROUTE_EPS` above it |
| Flat steps along a river bed | clamp to the lowest neighbour when a step is too large | `COURANT = 0.5` and the celerity cap keep the clamp rare |
| Trunk rivers under-eroded | celerity cap | raise `CELERITY_CAP` (costs iterations in proportion) |
| Rivers follow the blocks of the coarser level | bilinear upsampling | jittered upsampling |
| No new channels on a smooth input | nothing breaks the symmetry | the random share of the partition (3.6); `detail` adds noise |
| The `flow` output is lines one texel wide while the valleys were cut by shared water | `flow` is the area of single receivers, as `simulate/flow` gives it | intended: a mask of stream lines |
| Pits in the output | no sediment is deposited | `lakeFill` |
| Wall along the border | border texels are fixed | border rule of `simulate/fluvial-erosion.finish` |
| With `uplift`, a frame along the border: the ground falls to the border over a few texels | the border ring is the base level and does not rise | accepted: it is the boundary of the model. An `upliftMask` that fades towards the border hides it |
| A long `duration` planes the terrain off | without uplift the law has no other end: at `duration` 4 a mountain half the terrain wide is gone, on one level as on three | intended; long runs are for use with `uplift` |
| Result depends on noise in the uplift map | one-sweep accumulation underestimates discharge under noisy uplift (FastFlow24) | the node adds no noise to uplift; the help text asks for a smooth `upliftMask` |

---

## 4. Virtual-pipe hydraulic erosion: `simulate/hydraulic-erosion`

### 4.1 Purpose and landforms

The meso-scale detailer. Rain falls on the terrain, runs off as a shallow layer
of water, picks up sediment where enough of it has gathered and runs fast and
steep, and drops it where it slows down. It produces gullies on slopes, whose
banks slump into V-shaped cuts with spurs between, sediment-filled valley
floors, fans where the gullies reach gentle ground, and deposits in
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
| `wear` | data | `max(in − out, 0)`: height removed, in height units | when wanted |
| `deposit` | data | `max(out − in, 0)`: height laid down | when wanted |
| `flow` | data | time-averaged discharge per unit width, m²/s | when wanted |

`wear` and `deposit` are net, as those of `simulate/thermal-erosion` are: a
texel has one or the other. (The first version gave them gross: what was
taken and what was laid down over the run, of which a stream bed has both.
The gross wear cost a plane of state and a rounding rule of its own.)

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `seed` | seed | 0 | | erodibility jitter, refinement jitter |
| `size` | float, length (`param.size`) | 0.05 | 0.005..0.5, log | feature size: the scale of the largest gullies. Water cuts where it has run together; a gully that drains a square half the feature size across under the default rain is cut to the full depth, `CUT_SHARE` of the size, and one that drains less to less. Sets the base level |
| `duration` | float, none | 2 | 0.05..16, log | how far water at nominal speed travels, in feature sizes |
| `rain` | float, ratio | 0.24 | 0..1 | rainfall rate as a fraction of `RAIN_MAX` |
| `capacity` | float, none | 1 | 0.1..3 | sediment capacity coefficient `Kc` |
| `downcutting` | float, none | 0.5 | 0.1..2 | pick-up rate `Ks`, per second |
| `deposition` | float, none | 1 | 0.1..3 | settling rate `Kd`, per second |
| `removal` | float, ratio | 0.4 | 0..1 | share of the ground the water cuts that leaves the terrain instead of being suspended; 0 conserves it, 1 lays nothing down. What was laid down and is taken up again is suspended whole |
| `talus` | float, angle (`param.slope`) | 45 | 5..90 | banks the water cut steeper than this slump; 90 disables |
| `detail` | float, ratio | 0 | 0..1 | fine noise injected at each refinement (2.4) |

Defaults and ranges of `rain`, `capacity`, `downcutting` and `deposition` are
the typical values and ranges of JT11 Table 2. What they mean on a terrain
measured in metres is set by the constants of the capacity (4.6): `CARRY`,
`CARRY_POWER`, `HEAD_RAIN`, `GATHER_MAX`, `PICKUP`, `SETTLE`, `SETTLE_BAND`,
`CUT_SHARE`, `CUT_POWER` and `CUT_SLOPE`. Section 13 says which of them are
calibrated and which are still starting values.

### 4.3 Model and units

The pipe model of Mei07 with the erosion and deposition step of JT11
(**published**). The restructuring into the passes of 4.5, the flux-form
sediment transport, the choice of the pipe cross-section, the open border, the
form of the capacity (its channel head by the discharge through a texel, its
growth with the water gathered, its slope taken from the input), the depth a
gully is held to, the room a deposit needs, the removal, the sea that fills,
the end of the run, the slump that spares the input's own slopes and the slide
and creep of what was laid down are **design, to validate**.

- Each texel exchanges water with its N4 neighbours through four virtual pipes. A pipe carries a one-way flux `F_k >= 0` in m³/s.
- Pipe length is `dx`. The pipe cross-section is `dx * H_REF`, so the wave speed of the model, `sqrt(G * H_REF)`, does not depend on the cell size, and the same simulated time moves water the same distance on every level. With `H_REF = 20 m` and `dx = 1 m` the model has JT11's pipe area of 20.
- Simulated seconds are not real time. The rates are artistic constants, as in JT11.
- **The water is thin, and the ground it takes does not become water** (**design, to validate**). JT11 adds what a texel erodes to its water column and takes what it lays down from it (eq. 12c, 13c), against ripples in long runs. With loads of tens of metres of sediment in a run of a thousand iterations that term was the simulation: measured on `generate/mountain` at 1009, four fifths of the water that ran was ground the water had eroded, the valleys stood under metres of it from wall to wall, and the wear was a sheet across every basin that had begun to erode and nothing beside it. Without the term the mean wear of that run fell to a tenth and lay in lines along the valleys. The rain is a hundredth of JT11's as well (`RAIN_MAX`): at JT11's rate the runoff of a slope 1500 m long is a sheet a metre deep at its foot, deeper than the rills it should run in.

In this section `b`, `d` and `s` denote stored, normalised values; `R * b`
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
| `flow` | field | accumulated `speed * depth * dt`, m²; only when wanted | `refinePlane`, no jitter |

9 `field` + 1 `vec2` = 2907 MB at 8129² with every output wanted: the loop holds 8 `field` and the `vec2` with `flow`, and at the end `b`, `flow`, `wear` and `deposit` remain.

- `b`, `s` and `spare` rotate: pass 2 writes the sediment after the texel's own change into `spare`, pass 3 reads it there and writes the new `s` into the plane of the old, which no pass reads after pass 2; pass 4 writes the new `b` into `spare` and the old `b` plane becomes `spare`. Three planes serve two ping-pongs. Pass 5 writes `out` into `spare`.
- The fluxes are four planar `field`s because they are updated in place, which only `field` supports. `g` is written whole every iteration and read by the next pass, so it is an ordinary output; `vec2` keeps both channels at full precision.
- After pass 5 the node releases `b`, `s`, `d`, the fluxes and `g` before it allocates `wear` and `deposit`.
- The inputs `mask` and `precipitation` are brought to each level with `levelInput` at the start of `simulate` and released at its end (2.7); at `ctx.res` they are the inputs themselves, so they add nothing to the peak state. An unconnected one is bound as `null` and reads 1.
- Passes 2 and 4 also read `base`, the node's input on the level (`levelInput`, the `coarseBase` and `fineBase` of the refinement): at `ctx.res` it is the input itself, and on a coarser level one more `field` of that level, which the refinement releases.

### 4.5 Passes

Per iteration:

| # | Kernel | Reads | Writes | In place | Loads |
| --- | --- | --- | --- | --- | --- |
| 1 | `simulate/hydraulic-erosion.flux` | `b` own + N4, `d` own + N4 | | `fluxE`, `fluxN`, `fluxW`, `fluxS` | 14 |
| 2 | `simulate/hydraulic-erosion.water` | fluxes own (4) and one per N4 neighbour (4), `b` own + N4, `base` own + N4, `s` own, `mask` own | `g`, `spare` (the sediment `s1` after the texel's own change) | `d`, `flow` | 23 |
| 3 | `simulate/hydraulic-erosion.erode` | `g` own + N4, `s1` own + N4, fluxes own (4) and one per N4 neighbour (4), `precipitation` own | the plane of the old `s` (the new `s`) | `b`, `d` | 21 |
| 4 | `simulate/talus.step` | `b` own + N8, `mask` own + N8, `base` own + N8 (its `rest`) | `spare` (the new `b`) | | 27 |
| | swap `b`/`spare` | | | | |

After the last level:

| # | Kernel | Reads | Writes | In place |
| --- | --- | --- | --- | --- |
| 5 | `simulate/hydraulic-erosion.settle` | `b` own + N4, `s` own | `spare` (`out`) | `flow` |
| 6 | `simulate/diff` (5.5), when `wear` or `deposit` is wanted | `in` own, `out` own | `wear`, `deposit`; either may be `null` | |

Why each in-place access is safe:

| Pass | In-place target | Other texels of that plane read in the pass |
| --- | --- | --- |
| 1 | the four fluxes | none: a texel's new fluxes depend on its own old fluxes and on `b`, `d` |
| 2 | `d`, `flow` | none: neighbours contribute through their fluxes |
| 3 | `b`, `d` | none: the terrain change and the depth of the neighbours come from `g` |
| 5 | `flow` | none |

No pass has more than 4 writable textures; passes 1 and 2 have four. The loads count
the own texel of every in-place target, which the pass reads too.

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
Q      = length(vec2f(Wx, Wy))                             // m³/s through the texel
speed  = dMean > D_MIN ? min(Q / (dx * dMean), V_MAX) : 0
slope  = slopeAt(base, px)                                 // m/m, central differences, of the input on this level
sinA   = max(length(slope) / sqrt(1 + dot(slope, slope)), SIN_MIN)
n      = clamp(Q / Qhead − 1, 0, GATHER_MAX)                // the water passing, in channel heads beyond the first
C      = capacity * CARRY * sinA * (speed / V_MAX) * (n / GATHER_MAX)^CARRY_POWER      // metres of sediment
deep   = max(CUT_SHARE * size * T * min(sinA / CUT_SLOPE, 1) * (n / GATHER_MAX)^CUT_POWER, 1e-6)   // metres: how deep this water may cut
E      = mask_i * (1 − ERODIBILITY_JITTER * ξ_i) * saturate(1 − R * (base_i − b_i) / deep)  // ξ_i: stream 1 of 1.4
sM     = R * s_i
low    = min_{k, inGrid} b(q_k)

if C > sM:                    Δ = min(min(dt * downcutting * PICKUP, 1) * E * (C − sM),  R * max(b_i − low, 0))
else if sM > SETTLE_BAND * C: Δ = −max(min(min(dt * deposition * SETTLE, 1) * (sM − SETTLE_BAND * C),  R * (low − b_i) + tan(FAN_ANGLE) * dx), 0)
else:                         Δ = 0

δ      = round(Δ / R / QUANTUM) * QUANTUM                  // Δ in whole steps of the terrain plane, normalised
if δ < 0:  δ = −min(−δ, floor(s_i / QUANTUM) * QUANTUM)    // never lay down more than is suspended
if δ > 0 and b_i − δ <= sea:  δ = max(floor((b_i − sea) / QUANTUM) − 1, 0) * QUANTUM      // land stays land

loose  = max(b_i − base_i, 0)                              // what was laid down here earlier
s1     = s_i + (δ <= loose or removal = 0 ? δ : loose + (1 − removal) * (δ − loose))

g      ← (δ, d_i)
spare  ← s1
d      ← dNew
flow   ← flow + speed * dMean * dt
sink:  g ← (0, 0),  spare ← 0,  d ← 0

Qhead  = HEAD_RAIN * size * T * max(size * T / FEATURE_CELLS, dx)      // m³/s: the runoff of a strip one feature size long under the rain HEAD_RAIN
```

- `V_MAX = sqrt(2 * G * H_REF)`, the fastest speed the time step resolves.
- **The capacity** (**design, to validate**; its constants are in section 13). JT11 prints `Kc * sin(α) * |v| * saturate(d / Kd_max)` (eq. 10). What did not survive terrains measured in metres, and what stands in its place:
  - *A channel head, counted by the water through a texel.* With a capacity that grows with the depth from 0, the film of water on every slope carries, and the terrain is stripped to smooth sheets. The capacity here is 0 until the water passing a texel is that of a channel head, `Qhead`: what a strip one feature size long sheds under the rain `HEAD_RAIN`. The strip is as wide as the coarsest cell a base level has (`size * T / FEATURE_CELLS`), so a channel a texel wide counts the same on every level that resolves it, and the gullies of a build are those of its base level; on a coarser grid the strip is one texel wide, and there the even runoff of a slope is no channel. (Counted per metre of a texel's width, as the first calibration did, a channel a texel wide carried twice the heads at twice the resolution.)
  - *More than in proportion to the water gathered.* The capacity grows with the heads beyond the first to the power `CARRY_POWER`, up to `GATHER_MAX` of them. A capacity in proportion to the water wears an even slope evenly: where the transport grows no faster than the discharge, water that runs together cuts no more than the same water spread out, and nothing makes a rill (the condition of Smith and Bretherton, as commonly cited). The first calibration was full at three heads beyond the first, and a long even slope wore as a sheet below the first two feature sizes of its length. With the power 1.5 the water of an even slope runs together: the plane of the `notch` fixture at 1025 is cut into rills two to four texels apart, with ground between them that holds a tenth of their flow or less.
  - *The speed as a share of `V_MAX`.* The pipes have no friction, so water on any slope runs near `V_MAX` and the speed says where water runs and where it stands, not how fast.
  - *The slope of the input.* With the slope of the bed as it changes, a deposit that steepens carries more at its front and less behind it, and the valley floors came out as ripples and concentric terraces a few texels apart. The slope of `base` does not answer to the bed, so sediment settles smooth; a fan still lies where the input's slope breaks.
- **The depth of a gully** (**design, to validate**). The more water runs in a cut, the faster it deepens, without end. A cut is therefore held to a depth below the ground the run found: `CUT_SHARE` of the feature size for water of `GATHER_MAX` channel heads on ground of at least `CUT_SLOPE`, less by the power `CUT_POWER` of the heads for less water, and less in proportion for gentler ground, which has little fall to cut into. A rill stays shallow, a gully is deep, and a gully deepens down the slope as its water gathers. (The first calibration reached the full depth at three heads: every gully that had any water was as deep as every other, and with banks at one angle as wide.)
- **Slow pick-up.** `PICKUP` is the share of the pick-up rate that acts: a gully deepens over the whole run, and how deep the smaller ones get is a matter of `capacity`, `downcutting` and `duration`. The water available is no limit on the pick-up, as it is in JT11: the ground a texel takes is not added to its water (4.3).
- **Settling** (**design, to validate**). Water lays down what it holds beyond `SETTLE_BAND` times its capacity, at the rate `deposition * SETTLE`: a capacity that wavers by a part along a channel leaves no row of heaps. And it lays down no more than leaves the bed within the slope `tan(FAN_ANGLE)` of its lowest N4 neighbour: sediment has room only on ground that gentle. It comes to rest from the foot of a slope upwards, as a fan does, fills a hollow level, and is never a heap where the water happened to drop it; on a steep reach it stays in the water. At `deposition` 1 a load that has lost its capacity settles within some tens of metres, at 0.1 it runs out as a thin sheet over hundreds.
- The two limits on erosion are the rate and the height above the lowest N4 neighbour (**design**: a texel never digs itself into a pit). Ground above the sea is never cut down to it: it would be a sink from then on.
- `QUANTUM` is `2^-23`, one float32 step of a height between 1 and 2 (**fixed**). A `δ` of whole steps makes the subtraction of pass 3 exact for every height below 2, so terrain and sediment change by exactly the same amount. (`b − (b − Δ / R)` says the same in exact float32 arithmetic. Measured with that form on NVIDIA, with a plane that summed the erosion: 249 texels of the `terrain` fixture at 257 lost more than the sum recorded, up to 1.9 times as much, which exact arithmetic cannot give and a compiler that shortens the expression to `Δ / R` does. With whole steps the count is 0.) A change below half a step per iteration, 0.06 mm with a height range of 1 km, is lost, as 1.2 rule 4 accepts.
- **Removal** (**design, to validate**). Of the ground a texel cuts, the share `removal` is not suspended: it has left the terrain, as the fine part of a real load leaves a catchment in the water. What the water laid down earlier, the ground above `base`, it takes up again whole: a deposit that is moved on is not lost by the share at every move, as it was when the share was taken of everything eroded.

**Pass 3, apply and transport** (the transport is **design, to validate** and
replaces the semi-Lagrangian step of Mei07 eq. 14, which loses sediment):

```
b    ← b_i − δ_i
d    ← d_i * (1 − min(KE * dt, 1)) + dt * r * precipitation_i / R

φ_k(j)  = dt * F_k(j) / (dx² * R * g.y_j)   if R * g.y_j > D_MIN, else 0
                                                      // share of j's water that left through pipe k
sNew_i  = s1(i) * max(0, 1 − Σ_k φ_k(i)) + Σ_{k, inGrid(q_k)} φ_opp(k)(q_k) * s1(q_k)

sink:   landed = Σ_{k, inGrid(q_k)} φ_opp(k)(q_k) * s1(q_k)
        steps  = floor(landed / QUANTUM),   room = floor(max(sea − b_i, 0) / QUANTUM) + 1
        steps < room:   b ← b_i + steps * QUANTUM,  sNew ← 0,  d ← 0
        otherwise:      b ← b_i + room * QUANTUM,   sNew ← landed − room * QUANTUM,  d ← 0
```

- Sediment leaves a texel with the water that leaves it. Both ends of a pipe compute the transferred amount from the same loads, so sediment is conserved exactly between texels. What flows over the border leaves the simulation.
- Rain for the next iteration is added at the end, so `d` at the start of an iteration already contains it.
- A dry texel keeps its sediment in place; it settles over the following iterations at the rate `deposition`, where the ground has room for it.
- **The sea fills** (**design, to validate**). What the water brings into a sink settles there and fills the sea up to its level and no higher: a texel it lifts out of the sea, by one step of the terrain plane, is land from the next iteration on, and what did not fit stays in the water that will run over it. A mountain that stands on ground at the sea level, as the landforms of the generators do at the default sea level of 0, lays its fans on that ground; a stream that reaches a deeper sea builds a delta up to the waterline. (The sea took everything that reached it before, and at the default sea level `deposit` was empty.)

**Pass 4, embedded thermal step.** `simulate/talus.step` (5.6) on `b` with the
node's `talus`, `fan = tan(FAN_ANGLE)`, `creep = CREEP`, `keep = 1`, the node's
`mask`, and `base` as its `rest`. JT11 runs thermal erosion inside the
hydraulic loop; it removes the spikes and the checkerboard that erosion and
deposition leave. Here it does two more things (**design, to validate**):

- *It turns a slot into a gully.* The water cuts a line one or two texels wide; its banks slump back to the talus angle, across the slope, and its head works up the slope to the divide. With `rest` the step leaves a slope of the input as it found it, and a bank cut into a face may stand at the talus angle in its cross-section however steep the face is (5.6): a gully on a face of 55 degrees is a V as it is on one of 20.
- *It spreads what was laid down.* Sediment above the rest height slides wherever the surface is steeper than `FAN_ANGLE`, and creeps on any slope by the share `CREEP` of a height difference, no more of it than there is: a bar or a levee a texel wide is evened out, and a fan is smooth.

**Pass 5, the end of the run** (**design, to validate**).

```
room = max((min_{k, inGrid} b(q_k) − b_i) + tan(FAN_ANGLE) * dx / R, 0)
laid = min(s_i, room) + (s_i − min(s_i, room)) * (1 − removal)^FLUSH_POWER        // all of s_i when removal = 0
out  = b_i + laid
flow ← flow / simulatedTime,     simulatedTime = dt_0 * equivalent (2.5)
```

The sediment still in the water comes to rest where the ground has room for
it, as in pass 2. What is in water that runs too steeply to drop it leaves the
terrain with that water. A run moves in a thousand iterations what a river
moves in an age, so its water holds tens of metres of sediment in a texel
while it runs, and by the time the water takes down a flank 1500 m long, a
third to two thirds of the run, that share of what the gullies gave is still
on its way when the run ends: laid down where it is, as it
was before, it filled the gullies again and stood as rows of heaps along every
stream (measured on `generate/mountain` at 1009: heaps of 100 m on a valley
floor). With `removal` 0 nothing may leave, and all of it is laid down in
place: the run conserves the terrain to the last step (4.9 item 3), and its
gullies are the worse for it. **Pass 6:** `simulate/diff` (5.5) on the node's
input and `out`.

At a level start `d` is 0 on the base level; the fluxes are 0 on every level.

### 4.7 Stability, time step, iterations

- Gravity-wave bound (**design**, checked against JT11's range): linearising passes 1 and 2 gives a wave of speed `sqrt(G * H_REF)`; the explicit update is stable for `dt <= dx / sqrt(2 * G * H_REF)`. With JT11's values (`dx` = 1, area 20) the bound is 0.0505, the upper end of their range.

```
dt = PIPE_SAFETY * dx / sqrt(2 * G * H_REF)                 // 0.0252 * dx seconds with the starting constants
```

- `dt` is proportional to `dx`: it halves at each finer level, as Mei07 Table 1 does.
- The wave travels `WAVE_CELLS = PIPE_SAFETY / sqrt(2) = 0.354` texels per iteration. Water in a channel is slower; `NOMINAL_SPEED` is its assumed speed as a fraction of the wave speed.

```
total = min(duration, TRAVEL_MAX / size) * F / (WAVE_CELLS * NOMINAL_SPEED)         F = size * (res_0 − 1)
budget = levelBudget(total, level.count, DETAIL_ITERATIONS_HYDRAULIC, 0.5)
```

- A run lasts no longer than water at the nominal speed takes to cross `TRAVEL_MAX` terrain widths (**design, to validate**): by then the runoff of every slope has left the terrain. At the default `size` every `duration` of the range is below that; at `size` 0.5 a `duration` above 2 runs as 2. Without the limit the two at their maxima asked for 11 600 iterations on a base level of 129 texels, which a software adapter (WARP on the Windows runner) did not finish in the 300 s a test has: the `params` check of the conformance suite ended there.
- With the constants of section 13 `total = 11.3 * duration * F`: 724 to 1448 per unit of `duration` when the base level is selected by `size`.
- `min(dt * rate, 1)` bounds the per-iteration fractions when `dx` is large.
- The flux scaling `K` guarantees `d >= 0`; `Σ φ_k <= 1` follows from it, up to float rounding, which the `max(0, …)` absorbs.

### 4.8 Schedule on the ladder

`coarsestCell = size / FEATURE_CELLS`. Refinement: terrain with jitter on,
`salt = mixSeed(ctx.seed, fine.res)`; `d`, `s` and `flow` without jitter;
fluxes cleared. Suspended sediment is carried between
levels and settled only at the end. The default schedule is in 2.5.

Estimated cost of the default build at 8129, from 85 loads per texel per
iteration and the measured 0.29 ms per 5-load pass at 2048²: 9 s, 7 s and
27 s on the three levels, 43 s in all. The same work on the 8129 grid alone is
9196 iterations, about 650 s. **To calibrate**. Measured at the defaults:
1.5 to 2.0 s at 1009² (one level) and 27 to 29 s at 4033² (levels 2017 and
4033), with a longest slice of 143 ms.

### 4.9 Invariants

1. `d >= 0`, `s >= 0` and every flux `>= 0` at all times; `wear >= 0`, `deposit >= 0`, and never both above 0 at one texel.
2. `out = in − wear + deposit` within 1e-7.
3. Conservation, with `removal = 0`, on a fixture whose border ring is higher than any water surface reached and with a single level: `|mean(out) − mean(in)| <= 2e-6 + 1e-4 * mean(wear)`. With `removal = 1` on the same fixture no texel rises and `deposit` is 0.
4. With `detail = 0`: when `mask` is 0 everywhere, `out` is bit-identical to `in`; when `rain = 0` and `talus = 90`, `out` is bit-identical to `in`.
5. On one level, with `talus = 90`, no texel at or below the sea level is lowered, no texel above it is cut down to it, and `flow` is 0 at every texel of `out` at or below it. (A sea texel may rise, and be land with a flow from then on: what the water brings fills the sea up to its level, and what was laid down beside it slides into it.)

"Monotone flow" is not an invariant of this model: water has inertia and can
run uphill for a few iterations.

### 4.10 Known artefacts and counter-measures

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| The valleys stand under water from wall to wall, and the wear is a sheet across every basin | the ground a texel erodes is added to its water (JT11 eq. 12c), and with loads of tens of metres that is most of the water there is | the ground the water takes does not become water (4.3) |
| Pits and over-deep channel beds | capacity unbounded where water is fast | the capacity is full at `GATHER_MAX` channel heads; erosion limited to the height above the lowest neighbour |
| Runaway incision of the channel that already has the flow | positive feedback: more water, a deeper cut, more water | the depth a gully is held to (4.6) |
| The terrain stripped to smooth sheets | the film of water on every slope carries | no capacity below one channel head |
| A long even slope wears as a sheet; gullies of one width | a capacity in proportion to the water, full at a few heads: water that runs together cuts no more than water spread out | the capacity grows with the power `CARRY_POWER` of the water gathered, and the depth of a gully with the power `CUT_POWER`, up to `GATHER_MAX` heads (4.6) |
| An even slope cut into rills a few texels apart from one end to the other | what the counter-measure above does where nothing but the grid sets a width: seen on the `notch` fixture, a plane, at 1025 | accepted: a generator's slope has valleys that gather the water first. The spacing is that of the base level, a sixty-fourth of the feature size or less |
| Ripples and concentric terraces in the deposits | the capacity answers to the slope of the bed it is changing | the slope of the input (4.6) |
| Rows of heaps along the streams, gullies filled again | sediment on its way down when the run ends is laid down where it is: tens of metres to a texel | what cannot rest where it is leaves with the water (pass 5) |
| A row of heaps along a stream during the run | a capacity that wavers along a channel, and a settling many times as fast as the pick-up | water lays down only what it holds beyond `SETTLE_BAND` times its capacity, and only where the ground has room |
| The whole terrain slumps to the talus angle | the embedded thermal step meets an input steeper than its angle | the input is the step's `rest` |
| A whole slope comes down between its gullies, as facets | on a face steeper than `talus` a bank could keep no slope across the face | a bank keeps the talus slope in its cross-section, on a face of any steepness (5.6) |
| Deposits bury the lower slopes as smooth sheets | everything eroded is laid down within the reach of the run | `removal` |
| `deposit` is empty at the default sea level | the level ground the generators' landforms stand on is at the sea level, and the sea took what reached it | the sea fills up to its level (pass 3) |
| No distinct fans: the deposits are thin sheets over all level ground | a capacity that stays full on level ground wherever a few heads of water run, and a slow settling | the capacity falls with the water as it spreads; `SETTLE` 1; the deposit's room (4.6). The fans of neighbouring gullies run together into an apron along the foot of a range, as they do in nature |
| `deposition` changes little | where sediment came to rest was set by the slide more than by where it settled | it sets how far a load runs out: seen on `generate/mountain` at 1009 and measured on the `cone` fixture (section 13, `SETTLE`) |
| Level fills in closed hollows, with a sharp shore | sediment settles in standing water and fills from the bottom | accepted: it is what a filled lake is |
| Little is laid down on a terrain that is steep everywhere (`generate/fractal-noise`: 4 % of the texels) | sediment has room only on ground gentler than `FAN_ANGLE` and in hollows, and what is on its way when the run ends leaves | accepted; a longer `duration` and a lower `removal` fill more of the hollows |
| Speckle in the sediment | transport through texels with almost no water | no transport out of a texel with less than `D_MIN` of water |
| No erosion on flat ground | `sinA` tends to 0 | `SIN_MIN` | 0.005 | none | 4.6 | calibrated by eye on `generate/mountain` at 1009: at 0.02 the streams that leave a fan cut lines of up to three metres into the level ground beyond it. Mei07 requires a floor and gives no value |
| Streams scratch thin lines into level ground beyond a fan | `SIN_MIN` lets a stream of many heads cut a little on the flat | `SIN_MIN` 0.005: such a cut is under a metre deep at the defaults |
| Sediment mass drifts | semi-Lagrangian advection is not conservative | flux-form transport |
| Channels aligned with the axes | N4 pipes on a symmetric input | erodibility jitter; central-difference slope; refinement jitter |
| Checkerboard in the terrain | collocated grid, step too large | the `dt` bound, the talus step |
| One-texel spikes of deposit | sediment dropped at once where water vanishes | settling at a rate, into the room there is; the creep of what was laid down |
| Only narrow channels | uniform rain | `precipitation` input |
| Water drawn down near the border | open border | accepted; a closed border floods the map |
| A coarse preview wears its slopes more evenly than the build | below the base level a texel is wider than a channel head's strip, and a slope's runoff through it counts as more of a channel (4.6) | the strip is a texel wide there; measured on `generate/mountain`, the mean wear is 0.0011 at 253, 0.0014 at 505, 0.0015 at 1009 and 0.0011 at 2017 |
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
| `size` | float, length (`param.size`, label Reach) | 0.005 | 0.001..0.25, log | width of the largest talus slope that forms completely. Sets the base level |
| `strength` | float, ratio (`param.strength`) | 1 | 0..1 | fraction of the iteration budget that runs |
| `removal` | float, ratio | 0 | 0..1 | fraction of the moved material that is removed instead of deposited |

Defaults are **to calibrate**.

### 5.3 Model

Per pair of neighbouring texels, the higher gives the lower a fraction of the
height by which their difference exceeds the talus slope (**published**:
Stava08 eq. 5). The gather form, in which each texel computes its own net
change from its N8 neighbourhood and writes only itself, the slope taken at
the middle of the pair, and the stability bound of the rate are **design, to
validate**.

```
steep_ij    = the slope of the terrain at the middle of the pair, m/m (below)
give(i → j) = TRANSFER * gate_ij * (dx / run_ij) * R * max(h_i − h_j, 0) * max(steep_ij − tanTalus, 0) / steep_ij      // metres
gate_ij     = min(mask_i, mask_j)
net_i       = Σ_{j in N8, inGrid} ( keep * give(j → i) − give(i → j) )           keep = 1 − removal
h_i ← h_i + net_i / R
```

The slope at the middle of a pair, from the 3 × 3 neighbourhood either texel
of the pair has around it. With `a` the difference of the two heights:

```
axial pair, e the unit step across it:
    c        = ( (h(i + e) + h(j + e)) − (h(i − e) + h(j − e)) ) / 4          // the mean of the two central differences across the pair
    steep_ij = R * sqrt(a² + c²) / dx
diagonal pair, p and q the two other texels of the cell the pair shares:
    steep_ij = R * sqrt((a² + (h_p − h_q)²) / 2) / dx
```

- A pair gives the share of its height difference by which the slope there is above the talus slope: on a plane that falls along the pair, exactly the excess of the difference over `tanTalus * run`, the form of Stava08.
- **Why the slope at the middle, and not that of the pair alone.** A slope that faces between a row and a diagonal is, between any two neighbours, gentler than it is: by up to 8 %, at 22.5°. With the threshold taken between the two texels alone, such a slope rested steeper than one that faces a row; a cone came to rest as an octagon (its contour 6 % further out along the axes and diagonals than between them, at 257); and, one to one in a build, rows of a slope that faces a row had nothing to even them out across the slope and showed as straight streaks and facets down the fall line: faintly in thermal erosion, plainly in the snow. With the slope at the middle the contour of the relaxed cone is round within half a texel; the 4033 crop of the snow is free of streaks and that of thermal erosion nearly.
- `give` depends only on the two heights and on sums and squared differences both texels form from the same texels, so both compute the same number: what one loses the other gains. A read beyond the border clamps for both alike.
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
| 1 | `simulate/talus.step` | `h` own + N8, `mask` own + N8 (`rest` unbound) | `next` | | 18: the run passes `cost: 18`; the kernel declares the 27 of a run with `rest` |
| | swap | | | | |

After the last level, when `wear` or `deposit` is wanted:

| # | Kernel | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 2 | `simulate/diff` | `before` own (the node input), `after` own | `wear` = `max(before − after, 0)`, `deposit` = `max(after − before, 0)`; either may be `null` | 2 |

### 5.6 The kernel

The kernel reads the 3 × 3 neighbourhoods of `h`, `rest` and `mask` into named
values (`h00` to `h22`, the texel itself `h11`; `engine.md` 3.15 rule 4 on
arrays) and writes the eight pairs out one by one. The text of a pair comes
from `TALUS_PAIRS` of the module, which the layer solver shares: for each
neighbour its offset, the name of its value, its run in texels and the squared
slope at the middle of the pair as 5.3 gives it.

```ts
const talusStep = defineKernel({
  name: 'simulate/talus.step',
  inputs: { h: 'field', mask: MASK_INPUT, rest: { kind: 'field', default: 0 } },
  outputs: { next: 'field' },
  params: { talus: 'f32', fan: 'f32', keep: 'f32', creep: 'f32' },      // talus, fan: tangents of the two angles
  cost: 27,
  code: /* wgsl */ `
const TRANSFER = 0.1;

// Metres of material that the higher texel of a pair gives the lower. over: the metres by which it stands above
// it. steep: the slope at the middle of the pair. kept: the slope the pair may keep. loose: the metres of loose
// material on the giver. Both texels of a pair call it with the same arguments, so they compute the same number.
fn give(over: f32, steep: f32, kept: f32, loose: f32, steps: f32, gate: f32) -> f32 {
  if (over <= 0.0 || steep <= 0.0) { return 0.0; }
  let slump = over * max(steep - kept, 0.0) / steep;
  let slide = min(over * max(max(steep - P.fan, 0.0) / steep, P.creep), loose);
  return TRANSFER * gate * max(slump, slide) / steps;
}

// The slope a pair may keep whose ground at rest has the slope rested: the talus slope across the slope it had.
fn kept(rested: f32) -> f32 {
  if (rested <= 0.0) { return P.talus; }
  return sqrt(P.talus * P.talus + rested * rested);
}

fn compute(px: vec2i, uv: vec2f) -> f32 {
  // let h00 … h22, r00 … r22, m00 … m22: the neighbourhoods of h, rest and mask
  let metres = frame.heightRange;
  let perTexel = frame.heightRange / frame.cellSize;      // a difference of heights between neighbours, as a slope
  let loose = max(h11 - r11, 0.0) * metres;
  var gain = 0.0;
  var loss = 0.0;
  // for each of the eight neighbours, here the one at (1, 0), whose values are h21, r21, m21:
  if (inGrid(px + vec2i(1, 0))) {
    let steps = 1.0;
    let steep = sqrt(/* squared slope of h at the middle of the pair */) * perTexel;
    let rested = sqrt(/* the same of rest */) * perTexel;
    let theirs = max(h21 - r21, 0.0) * metres;
    let gate = min(m11, m21);
    gain += give((h21 - h11) * metres, steep, kept(rested - theirs / (steps * frame.cellSize)), theirs, steps, gate);
    loss += give((h11 - h21) * metres, steep, kept(rested - loose / (steps * frame.cellSize)), loose, steps, gate);
  }
  return h11 + (gain * P.keep - loss) / metres;
}`,
});
```

**`rest`** (**design, to validate**) is the ground at rest, for a simulation
that must not collapse the slopes it was given. A pair then exchanges the
larger of two amounts. The *slump*: the share of its height difference by
which the slope at its middle is above

```
sqrt( tanTalus² + r² ),      r = max( steep_ij(rest) − R * max(h_from − rest_from, 0) / run,  0 )
```

the talus slope laid across the slope the pair had at rest, that slope less
the loose material on the giver, as a slope over the run of the pair. A bank a
simulation cuts into a face runs across the face: it may stand at the talus
angle in its cross-section, however steep the face is. (With the larger of the
two slopes, as the first version had it, a bank on a face steeper than the
talus angle could keep no slope across the face at all: every gully on such a
face widened until the face came down between two of them, and the
generators' terrains stand at 45 to 60 degrees.) The *slide*: the share by
which the slope is above `fan`, the slope the loose material rests at, or the
share `creep` on any slope, and no more than the giver carries above its rest
height. Three cases follow:

| Ground | Slope it may keep | Effect |
| --- | --- | --- |
| a face of the input steeper than the talus angle, unchanged | the slope it has, and the talus slope across it | stays as it is |
| a bank a simulation cut into it | the talus slope across the slope at rest | slumps back to it |
| material laid on ground, level or steep | the slope `fan`; with `creep`, none for good | slides until it rests at that slope or the giver has none left, and creeps into the hollows beside it |

Unbound, `rest` reads 0 everywhere: its slope is 0 and the loose material is
the whole height, so the slump is the exchange of 5.3, when `fan` is given the
talus tangent too and `creep` 0 (the slide is then never the larger).
`simulate/thermal-erosion` leaves `rest` unbound and passes its `talus` for
both and no creep; `simulate/hydraulic-erosion` binds its input on the level
and passes `tan(FAN_ANGLE)` and `CREEP` (4.6 pass 4).

(The first version of the kernel also summed the lowering of each iteration
in an in-place plane, for the gross wear of `simulate/hydraulic-erosion`.
Both nodes now derive their outputs from the difference to the input, with
`simulate/diff`.)

### 5.7 Stability and iterations

- `TRANSFER <= 1/9` keeps a texel with eight lower neighbours of equal excess from overshooting (**design**): a pair gives at most `TRANSFER` of its height difference, and of a diagonal one `1/√2` of that. The constant is 0.1 and is not a parameter.
- Material moves one texel per iteration, and a slope relaxes by diffusion: forming a talus slope `W` texels wide takes on the order of `W²` iterations, not `W` (**design**; the constant is `RELAX`).

```
total  = strength * RELAX * F²                              F = size * (res_0 − 1)
budget = levelBudget(total, level.count, DETAIL_ITERATIONS_RELAX, 0.25)
coarsestCell = size / FEATURE_CELLS_RELAX
```

- With the constants of section 13 `total` is 256 to 1024 at `strength = 1` when the base level is selected by `size`, and every finer level runs at most 96 iterations.
- When `total < 0.5` (a reach of less than half a texel) the node outputs its input.

### 5.8 Invariants and artefacts

1. With `removal = 0`, on a single level: `|mean(out) − mean(in)| <= 2e-6 + 1e-4 * mean(|out − in|)`. Across a refinement the mean drifts by more: the exchange counts every texel alike, and the interpolation of 2.4 gives the border ring of the coarse grid the weight of half a cell, so the change on that ring enters the mean twice as much on the coarse grid as on the fine one. The drift is bounded by `mean(|out − in|)` times the share of the coarse grid's texels on its ring, `4 / res_coarse`; measured 5e-4 of `mean(|out − in|)` from 129 to 257 on the `terrain` fixture.
2. With `removal = 1`: `out <= in` at every texel.
3. A terrain that is nowhere steeper than the talus slope, at the middle of any N8 pair, is returned bit-identical: the `notch` fixture, and a plane 6 % gentler than the talus slope whichever way it faces. A plane 6 % steeper gives way, also where it faces 22.5° off a row.
4. With `mask` = 0 everywhere, `out` is bit-identical to `in`.
5. `wear` and `deposit` are never both positive at one texel, and `out = in − wear + deposit` within 1e-7.
6. On the cone fixture, with `size` at least the cone's radius and the default `talus`: after the run no N8 pair exceeds the talus slope by more than 5 % of the tangent. Calibrated with `RELAX` 4 (section 13): 4.2 % at 257, where the run has four levels, and 1.1 % on a single level. At a lower `talus` the cone has further to spread and is left steeper: 10 % above the tangent at 20°.
7. On the same fixture the relaxed cone is round: its contour at height 0.1 lies within 1.5 texels of one radius along the axes, the diagonals and between them, at `talus` 35 and 20 (measured 0.5; 3.75 with the threshold taken between two texels alone).

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Run-to-run differences, mass loss | a texel pushing material into neighbours races on a GPU | gather form: a texel writes only itself |
| Octagonal talus cones; streaks down the fall line of a slope, one to one in a build | a threshold taken between two texels alone: a slope between a row and a diagonal is gentler between any two neighbours than it is | the slope at the middle of the pair (5.3); weights `dx / run`; invariant 7 |
| Large cliffs barely change at high resolution | diffusion needs `W²` iterations | coarse-to-fine: the base level holds the reach in 8 to 16 texels |
| A slope left a few percent steeper than the talus angle after a refinement | the refinement adds back the input's detail the coarse level could not hold: on the cone its tip and the kink at its foot. What slumps off them has a whole slope at the threshold to cross, in 96 iterations | accepted; invariant 6 bounds it |
| Oscillation between two states | rate too high | `TRANSFER = 0.1` |
| Total height drifts by float rounding | each texel rounds its own sum | accepted; bounded by invariant 1 |

### 5.9 Mobile layers and `simulate/sediment`

A layer of thickness `s` lies on a bed `bed` that does not move. The surface is
`bed + s`. A texel cannot give more than it has, so the exchange runs in two
passes (**design, to validate**; the limiter has the form of the flux scaling
of Mei07):

```
give(i → j)  = TRANSFER * (dx / run_ij) * R * max(h_i − h_j, 0) * max( max(steep_ij − tanRepose, 0) / steep_ij,  creep * saturate(s_i / full) )
             on the surface h = bed + s, with the slope at the middle of the pair as in 5.3
out_i   = Σ_{j in N8, inGrid} give(i → j)
lim_i   = min(1, R * s_i / max(out_i, 1e-20))                                   // pass 1
s_i ← max(0, s_i + ( Σ_j lim_j * give(j → i) − lim_i * out_i ) / R + source_i)  // pass 2
```

| # | Kernel | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 1 | `simulate/layer.limit` | `bed` own + N8, `layer` own + N8 | `lim` | 18 |
| 2 | `simulate/layer.move` | `bed` own + N8, `layer` own + N8, `lim` own + N8, `source` own | `next` | 28 |
| | swap `layer`/`next` | | | |

Both kernels take the params `repose` (a tangent), `creep` and `full` (a height).

- The exchange is the private library `simulateLayer` of `_layer.ts` (`simulateLayer_give`, `simulateLayer_creep`, `simulateLayer_gifts`, `simulateLayer_limit`, `simulateLayer_net`), which `simulate/snow.move` includes too. It is written over the pairs of the talus module (`TALUS_PAIRS`, 5.6). A texel's gift to a neighbour and the neighbour's gain from it are the same product `lim * give`, so the layer is conserved up to the rounding of each texel's own sum.
- `source` is an optional input of `simulate/layer.move` with default 0: the layer gained or lost per iteration, in height units. `simulate/snow` uses it.
- **Creep** (**design, to validate**). With `creep` above 0 a layer also evens out that share of a height difference on a slope it does not slide off: it drifts off the crests into the hollows. A layer thinner than `full` creeps by its share of that thickness: its flux is then in proportion to its thickness, a thin film moves no faster than the layer it left, and the edge of the layer is a front that stands, where a creep of one share for every thickness sent a film ahead at a texel per iteration (measured on the `rampX` fixture: 2 % of the snowfall lay 600 m below the snow line, from end to end). Both texels of a pair read the giver's thickness, so the exchange is still one number. `simulate/sediment` passes `creep` 0: its material rests where the slope lets it.
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
| `thickness` | float, height | 0.02 | 0..0.1, soft | thickness laid down where `mask` is 1 |
| `repose` | float, angle (`param.slope`) | 33 | 5..89 | angle of repose of the material (33° is dry sand, Nilles24) |
| `size` | float, length (`param.size`, label Reach) | 0.02 | 0.001..0.25, log | how far the material can slide |

The layer starts as `thickness * mask` on the base level, with `mask` brought
to that level by `levelInput` (kernel `simulate/sediment.lay`). After the last
level `simulate/sediment.finish` writes `out = in + depth` into the spare
plane of the ping-pong, and `depth` is the layer plane. Invariants:
`depth >= 0`; `out = in + depth` exactly; on a single level
`mean(depth) = thickness * mean(mask)` within `1e-5 * thickness`. A plane 6 %
steeper than the repose slope sheds the layer alike whichever way it faces
(the thinnest layer left on it is the same share of `thickness` within 0.03,
facing 0°, 22.5°, 45° and 112.5°), and one 6 % gentler keeps it as laid.

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
every CI adapter (measured: bit-identical on NVIDIA Vulkan and on lavapipe at
257² and 513², `tests/nodes/simulate/route.test.ts`): WGSL permits a compiler to fuse and reorder float
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
  readonly receivers?: boolean;                        // also return the receiver codes; with 'single' only
  readonly sea?: 'all' | 'connected';                  // default 'all'
}
interface RouteResult {
  readonly filled: Float32Array;                       // the routing surface w
  readonly area?: Float32Array;                        // drainage fraction; absent for routing 'none'
  readonly receivers?: Uint8Array;                     // the N4 index of each texel's receiver, 4 for none; when asked for
}
declare const route: CpuTask<RouteArgs, RouteResult>;  // name 'simulate/route'
```

Algorithm. All height arithmetic is float32 (`Math.fround`), and `eps` and
`seaLevel` are taken as the float32 nearest to them, the numbers a kernel
receives as `f32` params.

1. **Flood.** With `sea: 'connected'` the outlets are the border ring and the texels at or below the sea level that the ring reaches through N4 neighbours at or below it; ground below the sea level that the sea does not reach is then no outlet, and fills to where it spills like any other hollow. `simulate/rivers` asks for it (8.5); every other caller takes the outlets of 1.3. Every outlet gets `filled = height` and enters a min-heap ordered by (`filled`, texel index). Repeatedly pop the smallest texel `c`, append it to `order`, and for each N4 neighbour `q` not yet reached: `filled[q] = max(height[q], fround(filled[c] + eps))`, mark it reached, push it. With `eps = 0` a raised texel may go to a first-in-first-out queue that is drained before the heap (Barnes14's improved variant); the result is the same. With `eps > 0` it may not: the queue would give a valid but higher surface.
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
3. **Flats** (`'single'`; **design, to validate**). A texel that is not an outlet and none of whose four drops is above `ROUTE_FLAT_DROPS * eps` lies on a **flat**: a filled lake, level ground, a floor that falls by less than two millimetres a texel. Its drops are those of the `eps` the flood tilted it by, in steps of N4, and say nothing of the ground: a receiver drawn from them takes all the water of a lake to the row and the column of its outlet, and a river across it along a wall. A flat texel gets its receiver here instead, and step 2 leaves it out.
   - A flat is an N4-connected set of flat texels. An **exit** of a flat texel `c` is an N4 neighbour `d` that is no flat texel (an outlet, or a texel with a drop above the limit) with `filled[d] <= filled[c]`; of several, the lowest, and of those the first in the order of 1.3. The receiver of such a texel may be `d`.
   - `steps(c)`: the least number of N4 steps over flat texels from `c` to a flat texel that has a neighbour off its flat, 0 for such a texel, and no more than `ROUTE_FLAT_SHORE`.
   - `cost(c) = base + floor(base * ROUTE_FLAT_JITTER * r / 256)` with `base = floor(ROUTE_FLAT_COST / (steps(c) + 1))` and `r` the top 8 bits of `hashCell(x, y, seed)`, the texel's random number of step 2: a whole number from 4 to 1021. A step onto a texel costs less the farther the texel lies from the edge of its flat, and the random part lets a way across open level ground wind.
   - The exits are taken in the order of their level, and those of one level together. From them Dijkstra's algorithm runs over the flat texels that have no receiver yet: the distance of a texel beside its exit is its own cost and its receiver is the exit; a texel reached from a flat texel `p` has the distance of `p` plus its own cost, and `p` for its receiver. Of two entries at one distance the one entered first is taken first; entries are made in the order of the texels for the exits, and in the order of 1.3 for the neighbours of a texel.
   - So a flat drains as a lake does, through the lowest texel beside it, and the first exit to reach a flat takes all of it: the lowest exit of a flat is no higher than any of its texels, because the way out the flood gave each texel leads to one. Exits of one level share a flat by cost. The water gathers along the middle of a valley floor and of a lake.
   - A receiver on a flat may be higher on the routing surface than the texel, by a few `eps`. The receivers still form no ring: off a flat every step goes down, and what enters a flat leaves it through an exit that lies below every texel of the flat.
   - With `eps = 0` a level lake is a flat with drops of 0, and its water reaches the outlets too.
4. **Accumulation.** `area[i] = weight[i] / res²` in float64. `'single'`: donors first, a texel adds its `area` to its receiver when every texel that drains into it has. `'multiple'`: walk `order` backwards, from the highest texel to the lowest, and add `area[i] * d[k] / total` to each lower neighbour `k`; a lower neighbour comes later in the walk, and the flats are not treated apart. The result is rounded to float32.

- Outlets keep the area that reached them; the sum of `area` over the outlets equals the sum of `weight / res²`.
- A `weight` below 0, or one that is no number, counts as 0. A node whose weight is a mask input reads it saturated, with `routeWeight(ctx, mask)` (one run of `simulate/route.weight`, then `ctx.read`).
- **What the task runs.** The steps above define the result; `tests/nodes/simulate/_route-reference.ts` is those steps as written, and the task is held to it: `filled` and the receiver codes bit for bit, `area` within one float32 step. The task finds the same surface with less work. A texel that has a settled neighbour lower by `eps` or more keeps its own height whatever the order, because `max(height, lowest neighbour + eps)` is then its height: it is settled at once, from a stack. A texel a settled neighbour would raise is noted, and when the stack is empty and it is still open it enters a monotone priority queue (a radix heap over the bits of the float32 level) with the lowest level its settled neighbours give it; the lowest level waiting is then final, as in Dijkstra's algorithm. On a slope nearly every noted texel is settled from below first, so only pits and their rims pass through the queue. The costs of step 3 are whole numbers below 1024, so its Dijkstra runs over 1024 slots of distances modulo 1024, each a list in the order of entry, and no heap. The area is summed in a topological order of the receivers as step 4 says, in another order of the texels than the reference takes: that is the float32 step.
- A node without a `seed` param calls the task with `routing: 'none'` and `seed: 0`.
- The task reports progress through `env.progress` and may be terminated at any time.
- Measured on the development machine (i5-9300H, Node 26, one thread, the first call of a process), `routing: 'single'`, on fractal terrains of which 21 to 34 % of the texels lie on flats: 0.68 to 0.87 s at 2033² (164 to 210 ns per texel) and 2.6 to 3.5 s at 4065² (156 to 214 ns per texel); `'none'` takes 1.3 s and `'multiple'` 2.3 s at 4065². The same rate gives 10 to 14 s at 8129². Step 3 is a quarter of that: without it the same terrains take 0.55 s and 2.1 s. Peak memory is what it was without step 3: 14 bytes per texel beside the array the task returns, 60 MB at 2033² and 222 MB at 4065². A first version of the task, in which every texel a settled neighbour reached before it could be settled itself went through a binary heap, took 340 to 450 ns per texel.

A node calls it as:

```ts
const data = await ctx.read(z);
const r = await ctx.cpu(route, { height: data, res, eps, seaLevel, routing: 'single', seed: mixSeed(ctx.seed, 0) }, [data.buffer]);
ctx.write(w, r.filled);
ctx.write(area, r.area!);
```

`receivers: true` is for a node that follows the rivers on the CPU
(`simulate/rivers`, 8.5): the codes cost a byte per texel, which the task holds
anyway.

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
threshold falls within a float32 step of a partial sum, and it does differ on a
flat: the kernel sees four texels and draws from the drops there too, while the
router resolves a flat as a whole (6.2 step 3). Nothing compares the two.
`simulate/fluvial-erosion` erodes no texel under a lake, and on a flat the
drops are a few `eps`, so the kernel's receivers there move no ground; its
`flow` output is the router's. A texel that is not an outlet has four neighbours inside the grid,
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
5. `area > 0`; with `'single'` every texel that is not an outlet has a receiver, `area` is non-decreasing from a texel to its receiver, and the receiver is lower on the routing surface except on a flat (6.2 step 3); its sum over the outlets equals the sum of the weights divided by `res²`, within 1e-4.
6. With `eps = 0`, N4-adjacent texels inside one lake have equal `filled`.

### 6.6 Known artefacts

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Large depressions become tilted mesas | `eps` too large | `eps` is an absolute height per texel, 1 mm for routing |
| Flats that do not drain | `eps` below float32 resolution | floor of `5e-7` |
| Spill points differ between preview and build | a notch or a dam narrower than a preview texel | inherent; documented in the node help |
| The CPU pass takes seconds at build resolution | sequential algorithm | runs off the engine thread with progress; cost **to calibrate** |
| Water crosses a lake or level ground along a row and a column | the drops of a flat are those of the `eps` it is tilted by, in steps of N4 | 6.2 step 3: a flat drains through its lowest exit by the cheapest way over it, along its middle |
| On a slope that `simulate/fill` tilted by more than `ROUTE_FLAT_DROPS * ROUTE_EPS` water still runs along rows and columns | such a slope is a tilted plane in steps of N4 and no flat | fill with `tilt` 0 before routing; a tilt is for a terrain that is not routed again |

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
| `routing` | enum | `single` | `single`, `multiple` | one random lower neighbour (crisp stream lines), or every lower neighbour in proportion to the drop (smooth) |
| `seed` | seed | 0 | | receiver choice; without effect with `multiple` |

Steps: router at `ctx.res` with `eps = ROUTE_EPS`, `weight` = the
`precipitation` field when connected; upload `area` (it is `out`); then one
kernel for `wetness`:

```
wetness = ln( max(out * T² / dx, WETNESS_AREA_MIN * dx) / max(length(slopeAt(in, px)), WETNESS_SLOPE_MIN) )   // specific catchment area over slope
```

- `precipitation` is read as a mask, saturated (`routeWeight`, 6.2). Where it leaves a texel without any area, `out` is 0 and the catchment per metre of contour counts as `WETNESS_AREA_MIN` of one cell's, so that `wetness` stays finite.

- `out` spans many orders of magnitude; a consumer that wants a mask takes a logarithm or a threshold. A stream mask is `out >= threshold`.
- `out * T² / dx` is the area drained per metre of contour. In a channel one texel wide it doubles when `dx` halves, so `wetness` rises by `ln 2` per ladder level there. This is a property of the index.
- State: 2 `field`. Invariants: 6.5 item 5; `wetness` finite.
- Both outputs are lines one texel wide and the area through a texel of a slope halves with the cell: at shared vertices 257 and 513 differ by 1.0 (`out`) and 0.7 (`wetness`) standard deviations on the `terrain` fixture, so the node skips the `resolution` check (2.8 item 5), and its own test compares what leaves the terrain through each of 8 × 8 blocks, which agrees within 4 %.

The exact accumulation is used, not sweeps on the GPU, because a thresholded
map shows every error of an approximate one. The node has no iterations and no
stability limit; its cost is the router's.

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Jagged stream lines | single receivers on N4 | random receiver choice; `routing: 'multiple'` for smooth maps |
| Parallel stripes across filled lakes with `routing: 'multiple'` | the routing surface is a tilted plane there, and `multiple` shares the water by the drops | with `single` a lake drains along its middle (6.2 step 3); `simulate/lakes` identifies the lakes |
| Stream lines move between preview and build | finer terrain detail changes receivers | inherent to routing; the large streams are stable |

---

## 8. Rivers: `simulate/rivers`

The whole section is **design, to validate**, with defaults **to calibrate**.

### 8.1 Purpose and landforms

Extracts a river network from the terrain's drainage and cuts its valleys and
channels: continuous rivers from the first texel that drains enough area down
to the border, the sea or a lake; tributary junctions at the level of the
river joined; courses that are lines and not stairs of texels; rivers that
begin as trickles and widen downstream; water levels that never rise
downstream; valleys whose sides ease out from the bank slope at the water and
keep the relief of the ground they lower; a level water surface in each cross
section.

### 8.2 Interface

| Input | Type, role | Meaning |
| --- | --- | --- |
| `in` | field, height | terrain |
| `headwaters` | field, mask, optional | where rivers may gather water; default everywhere |

| Output | Role | Meaning | Produced |
| --- | --- | --- | --- |
| `out` | height | terrain with the valleys and channels cut | always |
| `river` | mask | the share of a texel a river's water covers | when wanted |
| `depth` | data | water depth in the channel, in height units | when wanted |
| `surface` | height | water surface inside channels, `out` elsewhere | when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `catchment` | float, ratio | 0.001 | 0.00001..0.5, log | share of the terrain that must drain through a texel for it to be a river |
| `valleyDepth` | float, height | 0.2 | 0..0.5 | how deep a river that drains the whole terrain cuts its valley; 0 leaves only the channel |
| `riverWidth` | float, length | 0.05 | 0..0.25 | width of a river that drains the whole terrain |
| `riverDepth` | float, height | 0.03 | 0..0.25 | depth of the water in a river that drains the whole terrain |
| `bank` | float, angle (`param.slope`) | 30 | 5..80 | slope of the banks at the water; a valley's sides ease out from it over `VALLEY_REACH` times the width a side at that slope would have |
| `seed` | seed | 0 | | receiver choice |

The defaults are calibrated by eye (section 13). No river drains the whole
terrain: one that drains 1 % of it is a tenth as wide as `riverWidth` and 0.16
times as deep as `riverDepth` and `valleyDepth`: 20 m wide and 5 m deep in a
valley of 32 m that reaches 130 m to either side, on a terrain of 4096 m with
a height range of 1024 m. The valley is what a picture of the whole terrain
shows.

### 8.3 State and memory

| Plane | Kind | Holds |
| --- | --- | --- |
| `water`, `share`, `place` | field × 3 | what the course task says of each site, in the texel the site lies in: the river's level, the share a river of its width drains, where in the texel the site lies |
| `site`, the spare site plane | vec2 × 2 | the place of the nearest river's site, or (−1, −1); ping-pong |
| the links | field | the texels of the sites before and after each site, and how far the river lies below the routing surface: in the plane of `out` until `out` is written, then in a plane of its own, which is allocated after the spare site plane is released |
| `out`, `river`, `depth`, `surface` | field × 4 | outputs |

7 `field` + 2 `vec2` = 2907 MB at 8129², while the sites are flooded and
corrected (steps 4 and 5). The two
task results, `filled` and `area`, are never fields: the course task takes
them as they come from the router.

### 8.4 Steps

| # | Step | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 1 | router at `ctx.res`: `eps = ROUTE_EPS`, `routing: 'single'`, `weight` = `headwaters`, `receivers: true`, `sea: 'connected'` | | `filled`, `area`, the receiver codes | CPU |
| 2 | task `simulate/water-course` on those and on the terrain, read a second time | | `water`, `share`, `place`, the links (uploaded) | CPU |
| 3 | `simulate/rivers.site` | `share`, `place` own | `site` | 2 |
| 4 | `simulate/water-jump.rivers`, strides 1, then `2^(K−1)`, …, 2, 1 | `site` at 9 texels; `share` and the links at their sites | the spare; swap | 27 |
| 5 | `simulate/rivers.along`, `COURSE_REFINE` times | `site` own; `share`, `place`, the links at the site and at the two beside it | the spare; swap | 9 |
| 6 | `simulate/rivers.carve` | `in` own, `site` own; `water`, `share`, `place`, the links at the site and at the two beside it | `out`, `river`, `depth`, `surface` | 14 |

The measures of a river (its width and depth from its share, the depth and the reach of its valley, the cross section) are one piece of WGSL text, `VALLEY_WGSL` of `_water-course.ts`, which steps 4 and 6 share.

Step 6 has 4 writable textures. Unwanted outputs are bound to `null`.

### 8.5 Equations

**River texels.** A texel is a river texel when `area >= catchment`. Because
`area` never decreases along receivers, everything downstream of a river texel
is a river texel: the network has no gaps.

**The sea a river ends in** is the sea the border reaches (`sea: 'connected'`
of the router, 6.2), as `simulate/sea` takes it by default. Ground below the
sea level that the sea does not reach is a hollow like any other: it fills to
where it spills and its river runs on. With every texel at or below the sea
level an outlet, a terrain with such ground inland had a river end in every
basin of it: many, and short.

**The course task** (`simulate/water-course`, in `_water-course.ts`) follows
the rivers as lines, which no kernel can: every river texel with its receiver
and with its **main donor**, the river texel that drains into it and has the
largest `area`. From the outlets upstream it gives each river texel a width, a
place, a valley and a level, and hands the rivers on as **sites**.

```
interface CourseArgs  { height, filled, area: Float32Array; receivers: Uint8Array; res, seaLevel, catchment: number;
                        cell, range: number;            // metres between two texels; metres of a height of 1
                        width, depth, valley: number;   // riverWidth * T, riverDepth * R, valleyDepth * R
                        bank: number }                  // tan(bank)
interface Course      { level, share, course, place: Float32Array; deepest: number }
```

`height`, `filled` and `area` are consumed and come back as `course`, `level`
and `share`; `deepest` is the most a river lies below the routing surface, in
metres.

*Smoothing along a river.* Several steps below take, at a river texel, the mean
of a quantity over the river downstream and over the river upstream along the
main donors, each side weighted by `(1 − b)^k` at `k` texels, and then the mean
of the two. With `b = 1 / (1 + n)` each side reaches about `n` texels. On an
even course the mean is the value itself. Beyond the end of a river the values
go on as they came over the last `min(n, 16)` texels.

1. **Width** (hydraulic geometry, exponents of LM53 as commonly cited):

```
whole(a) = riverWidth * T * a^0.5                      // metres, a = area of the river texel
W        = min( whole(a), max over the donors of W + RIVER_TAPER * dx )   // from the springs down; 0 above a spring
W        = W smoothed along the river, twice, over n = max(COURSE_SMOOTHING * W / dx, COURSE_SMOOTHING_MIN) texels
share    = (W / (riverWidth * T))^2                    // the share a river of this width drains
```

   - A river begins as a trickle and grows no faster along its course than `RIVER_TAPER`, also where a tributary makes its share jump. By its share alone it would begin at full width, `riverWidth * T * catchment^0.5`, which is six texels across in a build of 4033 at the defaults: a channel with a blunt, round head.
   - The share of a river grows by what every texel of its banks adds, in lumps. The edge of the river is what a texel is measured to (below): an edge that turned a little at every texel would be met at another place from one texel to the next, and the valley's side would be cut in ripples. Hence the smoothing.
2. **Course.** The place of a river texel is its own position smoothed along the river, twice, over the same `n`, and held within `max(COURSE_SLACK * W / dx, COURSE_SLACK_MIN)` texels of the river texel along each axis. A course that steps from texel to texel along a diagonal becomes the diagonal, a random stair a line that winds, and a wide river loses the turns that are shorter than it is wide. Two rounds leave of a stair less than a thousandth of a texel; one round leaves a hundredth, which turns the line by a degree at every texel, and a texel thirty texels away is then measured to a place a third of a texel up or down the river from one texel to the next.
3. **Confluence.** Routing takes a tributary on to the middle of the river it joins. Its places within half that river's width of the place where it joins are **inside** the river: they keep the river's level and are no sites a texel may take. Left as sites they would hand the texels of the channel to the tributary.
4. **Valley and level.**

```
cut   = max( valleyDepth * R * share^0.4,
             cut of the receiver − VALLEY_GRADE * tan(bank) * dx − R * max(filled − filled of the receiver, 0) )   // metres
level = sea                                   at a mouth: a river texel that is an outlet at or below the sea level
      = level of the receiver                 inside another river
      = max( filled − cut / R, sea )          otherwise
```

   - A river lies a valley's depth below the routing surface, and never below the sea. A lake on the way is lowered as its outlet is cut: where its bed lies below the river's, the bed is not cut (8.6).
   - Up a tributary the valley shallows no faster than `VALLEY_GRADE` times the bank slope: the tributary meets the river it joins at that river's level and does not hang above it. It also shallows by what the ground rises, so a stream that falls over a cliff into a deep valley does not carry that valley up the cliff.
5. **Long profile.** The routing surface along a river falls in steps: every hollow on the way is a pool filled to its rim. With `S` the level smoothed along the river once, over `n = PROFILE_SMOOTHING * max(W, dx) / dx` texels (beyond a mouth the sea is level, and above a spring the level is the spring's):

```
excess = max(S − level, 0)
near   = the largest excess along the river, each weighted by (1 − b)^k at k texels up or down it
level  = max( S − near, level − PROFILE_DEPTH * W / R, sea )           // not at a mouth, not inside another river
```

   - `S − near` is nowhere above the level, has no step where the level has one, and passes under a flight of pools along their floors: the river cuts through the rims and keeps its level on an even slope.
   - The river is lowered by `PROFILE_DEPTH` widths at the most: it saws through the rim of a pool, not through a cliff. A waterfall stays a step in the level.
   - Then, from the mouths up: inside another river that river's level; `cut` as in step 4, taken from the levels as they are now; and no level below the level of the receiver. The level never rises downstream.
6. **Sites.** Along every course, from each river texel's place to its receiver's, points at most `SITE_SPACING` texels apart. A point makes a site in the texel it lies in, unless that texel is the one of the site before it on the course or another river's site has taken it. A site knows the texel of the site before it and of the site after it on the main course (a link; none where the two texels do not touch). In the texel of a site the task writes:

| Plane | Holds |
| --- | --- |
| `level` | the river's water level at the site, between those of the two river texels |
| `share` | the share likewise; below 0 for a site inside another river |
| `place` | where in the texel the site lies, in 4096 steps along each axis: `x + 4096 * y` |
| `course` | the two links, each one of the nine offsets `(dy + 1) * 3 + (dx + 1)` with 4 for none, and how far the river lies below the routing surface as a part of `deepest`, in 65536 steps: `down + 9 * (up + 9 * rise)` |

   All four are whole numbers below 2^24 or plain floats: exact in a `field`. `COURSE_WGSL` reads them in a kernel.

   How far a river lies below the routing surface is the depth of its valley (below), and the routing surface along a river is a stair of texels and of pools: taken as each texel gives it, the valley was cut in ribs across the river. It is smoothed along the river as the width is, twice, over the same `n`, before it is written.

**The river a texel belongs to** is found by jump flooding (**published**:
RT06) with the extra first pass of stride 1. `simulate/water-jump.step` with
stride `s` looks at the nine texels `px + s * (i, j)`, `i, j` in −1..1, that
are inside the grid, and keeps the site nearest to `px`; of two sites at equal
distance it keeps the one with the smaller `y`, then the smaller `x`.
`simulate/rivers` runs the variant `simulate/water-jump.rivers`, which keeps
the site with the largest claim (**design, to validate**):

```
W      = riverWidth * T * share^0.5                   D = riverDepth * R * share^0.4 * saturate(W / dx)
beyond = distance * dx − W / 2                        // metres from the river's edge; below 0 inside the channel
total  = D + BANK_RISE * rise                         // the depth of the valley and of the channel in it
valley(beyond) = total * (1 − beyond * tan(bank) / (VALLEY_REACH * total))²      for beyond below the reach, else 0

claim  = 2e9                      in the texel the site itself lies in
       = 1e9 − beyond             inside the channel
       = valley(beyond)           beside it
```

and of two sites with one claim, as beyond the reach of every valley, the one
whose river's edge is nearer. A texel thus belongs to the river whose valley
is deepest at it: where two valleys meet, both are equally deep, and ground
that stands high above both rivers has no step between them. (Ground that
stands lower than twice the depth is lowered by a share that its height above
each river's water sets, and keeps a seam a texel wide where the two rivers
lie at different levels: 8.6.) A texel inside a channel belongs to that
river whatever valley it lies in, so a tributary is whole down to the river
it joins. (By the nearest edge alone, as before, two valleys met in a seam
wherever their rivers lay at different levels.) A site lies in the texel that
holds its `share`, so `round(site)` is that texel. `K = ceil(log2(reach))`
with `reach` the largest distance in texels at which a river can still lower
the terrain:

```
reach = (riverWidth * T / 2 + VALLEY_REACH * (riverDepth * R + BANK_RISE * deepest) / tan(bank)) / dx + 1
```

For `reach < 1`, the strides are just 1.

The flood gives a texel its river by a site that need not be that river's
nearest: a site down the river has the deeper valley. `simulate/rivers.along`
moves a texel's site one link down or up its river when the edge of the river
is nearer there, `COURSE_REFINE` times; a texel that holds a site keeps it.

**Cross section** (`simulate/rivers.carve`; **design, to validate**). The
river is the line through its sites. The texel is measured to the stretches
from its site to the two sites linked to it, and to the site alone; of the
three it takes the point whose river's edge is nearest. Along a stretch the
level, the width and `rise` change evenly between the two sites, so the edge
of the river is a line that leaves the middle line at an angle; the point lies
where the way to the texel stands at that angle to the stretch. With `r` the
distance in metres from the texel to the middle of the river at that point,
and `W`, `level` and `rise` those of the point:

```
D      = riverDepth * R * (W / (riverWidth * T))^0.8 * saturate(W / dx)
above  = R * (in − level)                              // metres of ground over the water
inside the channel, r < W / 2:
    cut = max(above − D * ((2r / W)² − 1), 0)          // down to the parabolic bed
beside it, with beyond = r − W / 2, total = D + BANK_RISE * rise and over = max(above, 0):
    high = min(over / total, 2)
    wide = valley(beyond) * (high − high² / 4)         // the valley: the ground keeps its relief
    near = max(1 − beyond * tan(bank) / total, 0)      // the bank: one side's width at the bank slope
    cut  = wide + (over − wide) * near²
out   = in − cut / R                                   // cut only

river   = saturate(min((W / 2 − r) / dx + 0.5, W / dx))
depth   = river > 0 ? max(level − out, 0) : 0
surface = river > 0 ? max(level, out) : out
```

- The factor `saturate(W / dx)` thins a channel narrower than a texel instead of carving it one texel wide, so a preview does not show wider rivers than the build.
- **The valley lowers the ground; it does not replace it.** Ground beside a river is lowered by the depth of the valley there, which falls from `total` at the bank to 0 at the reach, as a square: its slope at the water is the bank slope, on ground that stood `total` above the water, and it meets the terrain without a crease. Ground that stands lower than twice the valley's depth is lowered by less, down to a share of its own height (`high − high² / 4` is 1 from `high` = 2 on, never above `high`, and has no crease), so no ground beside a river goes under its water and low ground keeps its relief, smaller. Within one side's width at the bank slope the height of the ground above the water is scaled down as well, to nothing at the waterline: ground of any height meets the water without a step. (The first design cut the sides as planes at the bank slope, as high as the river lay deep: beside a valley of some depth every side was a plane without the terrain's relief, the planes of two rivers met in a seam, and a valley of the 6 to 16 m the planes could bear did not show against relief of hundreds.)
- Taken from the nearest site alone, the level would change from one texel to the next abreast of a river: by more than the river is deep on a steep one, and its valley would be cut in rungs.
- A texel without a site within `reach` is unchanged, exactly: a cut of 0 leaves its bits.
- `river` is the share of the texel the water covers: a channel narrower than a texel marks its texel with `W / dx`, as its depth is thinned, and a river of no width marks nothing.

### 8.6 Invariants and artefacts

1. `out <= in` everywhere; `out = in` exactly where no site lies within `reach`.
2. The set of river texels is closed under taking receivers, and the level of a site is never above that of the site linked to it upstream.
3. `depth >= 0`; `surface >= out`.
4. With `riverWidth = 0` or `headwaters` 0 everywhere, `out` is the input bit for bit and `river` is 0.

`river` and `depth` are lines a few texels wide that finer detail moves: at
shared vertices 257 and 513 differ by 1.1 standard deviations in both, and by
0.009 in `out`. The node skips the `resolution` check (2.8 item 5); its own
test compares the width and the depth of one river at the two levels.

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Jagged, grid-following courses | routing on N4 | random receivers; the course is smoothed along the river (8.5 step 2), and the valley is measured to the line through its sites |
| Straight runs along a row or a column across a lake or level ground | the routing surface is tilted there in N4 steps | the router resolves a flat as a whole (6.2 step 3) |
| A wide river pinched where a tributary joins it | the nearest site is the tributary's | a texel inside a channel belongs to the river it lies deeper in, and a tributary's places inside the river are no sites (8.5 step 3) |
| A tributary that hangs above the river it joins | each river lies its own valley's depth below the ground | a valley shallows up a tributary no faster than `VALLEY_GRADE` allows (8.5 step 4) |
| A valley's side cut in rungs or ripples beside a steep river | the level of the nearest site changes from texel to texel; a course or a width that keeps a trace of the grid turns the line at every site | the texel is measured to the line through the sites, whose course and width are smoothed twice (8.5) |
| Ribs across a river, on both sides of its valley | the depth of the valley taken from the routing surface texel by texel, which is a stair along a river | that depth is smoothed along the river (8.5 step 6) |
| A flight of pools along a river | every hollow on the way is filled to its rim | the long profile is smoothed from below (8.5 step 5) |
| A river that begins with a blunt head as wide as its catchment makes it | the threshold on the drained share | `RIVER_TAPER` |
| Valley sides that are planes, without the relief of the terrain around them | the side cut down to a plane at the bank slope | the valley lowers the ground by its depth and leaves it its relief (8.5) |
| A seam where the valleys of two rivers meet | each texel takes the profile of the river whose edge is nearest, and the two rivers lie at different levels | a texel belongs to the river whose valley is deepest at it: at the line between two valleys both are equally deep. Reduced, not removed: on low ground between two rivers at different levels, as on the plateau of `generate/canyon` beside its canyons, a seam a texel wide remains, seen at 2017 and 4033 one to one and not in a picture of the whole terrain. Taking the river that lowers a texel most instead was tried at 2017: fewer seams on the plateau, and pockets of a far, lower river in the terraces of the canyon walls. Open: a texel would have to know two rivers |
| A tributary on a raised bed beside a much deeper river it runs along | its own channel is cut to its own level, and the ground beside it is lowered by the deeper river's valley | `VALLEY_GRADE` 0.2: a tributary keeps the depth of the valley it joins for two and a half times as far as before, and lies below that valley's side unless it runs within some twelve degrees of the river. Accepted beyond that; `simulate/fluvial-erosion` cuts valleys as a whole |
| Rivers that are short and many on a terrain with ground below the sea level inland | every texel at or below the sea level an outlet (1.3) | the rivers end in the sea the border reaches (8.5) |
| Rivers that end at the foot of a landform that stands on level ground at the sea level | that ground is sea: `generate/mountain` and `generate/mountain-range` at the default sea level of 0 | inherent; lower the sea level, or raise the landform |
| Channels wider in the preview than in the build | one-texel minimum width | depth scaled by `saturate(width / dx)` |
| Rivers end in pits | no depression handling | routing on the filled surface; a river that crosses a lake lies at the lake's level, lowered by its valley |
| A wrong site for a few texels | jump flooding is approximate, the more so for sites of unequal claim | the extra stride-1 pass, and `simulate/rivers.along` |

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
| `minDepth` | float, height | 0.003 | 0..0.1 | lakes whose deepest point is shallower are dropped |
| `minSize` | float, length | 0.02 | 0..0.25 | lakes whose area is below `minSize²` of the terrain are dropped |

Steps:

1. Router at `ctx.res` with `eps = 0`, `routing: 'none'`: level lake surfaces. Texels at or below sea level are outlets, so the sea is not a lake.
2. Task `simulate/lakes.prune` (`{ height, filled, res, minDepth, minArea }` to `{ level: Float32Array }`; the node reads the input a second time for `height`, because the router consumes its copy): walks each N4-connected set of texels with `filled > height` once, breadth first, measures its largest depth and its area, and returns `filled` for the lakes that pass both thresholds and `height` everywhere else. `minArea` is `minSize²`, a share of the terrain, of which a texel covers one cell, `1 / (res − 1)²`. `filled` is consumed and comes back as `level`.
3. Upload `level`; kernel `simulate/lakes.maps` reads `in` and `level` and writes `water = level > in ? 1 : 0` and `depth = max(level − in, 0)`. `surface` is the `level` field itself.

When no output but `out` is wanted the node does nothing. State: 3 `field`. Invariants: `depth >= 0`; `water` is 0 or 1; inside one lake
`surface` is one value; no lake texel is an outlet. The exact fill is
**published** (Barnes14); the pruning thresholds are calibrated by eye (section 13). The node
has no iterations and no stability limit. `water` is 0 or 1, so a shoreline
that moves across a flat shore changes whole texels: 257 and 513 differ by
0.090 of the standard deviation in `water` and by 0.007 in `depth`, and the
node declares a `resolutionTol` of 0.15.

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
| `strength` | float, ratio (`param.strength`) | 1 | 0..1 | coastal reshaping; 0 leaves the terrain unchanged |
| `shoreSize` | float, length | 0.02 | 0.0005..0.1, log | width of the reshaped band on each side of the shoreline |
| `shoreHeight` | float, height | 0.005 | 0..0.05 | height of the band's top above, and of its bottom below, sea level |

The sea level is the project setting; the node has no level of its own.

**Sea mask.** A texel is below the sea when its height is `<= sea`, the test
that makes it an outlet (1.3). `global`: `water = in <= sea`. `connected`: task
`simulate/sea.connect` (`{ height, res, seaLevel }` to `{ water: Float32Array }`)
floods from the border-ring texels with `height <= seaLevel` through N4
neighbours with `height <= seaLevel`. Both are exact.

**Coastal reshaping** (`strength > 0`; **design, to validate**; there is no
published reference model):

1. Sites: sea texels with an N4 neighbour that is not sea (`simulate/sea.shore`). Jump flooding as in 8.5 (`simulate/water-jump.step`) with `reach = shoreSize * T / dx` gives every texel its distance `d` to the nearest site. The shoreline lies half-way between a site and its neighbour on land: `r = d − dx / 2` on land and `r = −(d + dx / 2)` under the sea.
2. Target profile and blend, with `x = r / (shoreSize * T)` in −1..1:

```
target = sea + shoreHeight * x                          // a ramp through the shoreline: beach and shelf
weight = strength * (1 − smoothstep(COAST_FLAT, 1, |x|))
land:  out = min(in, mix(in, target, weight))           // cut back: a platform and a scarp remain
sea:   out = min(mix(in, target, weight), sea)
```

   Over the inner `COAST_FLAT` of the band the ground is the ramp itself, at full `strength`: a beach and a shelf that a picture of the terrain shows. With the weight `(1 − |x|)²` of the first design a quarter of the way into the band was drawn to the ramp by half, and the beach was two texels wide at 513.

   Land that stood above the sea level stays at least `max(|sea| * 1e-6, 1e-7)` above it, a few float32 steps, so that it is land to every reader of the sea level.

3. The reshaping kernel also writes `band = saturate(1 − |x|)`. `COAST_SWEEPS` iterations of `simulate/sea.relax` at the angle `COAST_TALUS` relax the undercut scarp without touching the terrain outside the band. The kernel is the exchange of 5.3 with `band` as its mask, `keep = 1` and the rate `COAST_TRANSFER`, which is `TRANSFER`; it also keeps a sea texel at or below the sea level and land above it, so that item 4 holds whatever slumps. It is the node's own because the hydrology nodes were written before the talus module of 5.6 existed; with a `mask` and without `wear` the two are one exchange, and `simulate/sea` can run `simulate/talus.step` followed by that clamp instead.
4. Reshaping does not move the shoreline: land stays at or above sea level and the sea bed at or below it. `water` is the mask found before reshaping; `depth` and `surface` use `out`.

State without reshaping: 3 `field`. With it, at the peak: the sea mask, `out`,
`band` and the two site planes, 3 `field` + 2 `vec2` = 1850 MB at 8129². The
site planes are released before the `spare` plane of the talus sweeps is
allocated; `band` and `spare` are released before `depth` and `surface` are.

Invariants: with `strength = 0`, `out` is the input field; `depth >= 0`; in
`connected` mode every sea texel is joined to the border ring through sea
texels; with any `strength`, a texel is at or below the sea level in `out`
exactly when it is in `in`, and land above the sea level is never raised by
the reshaping (the sweeps lay a little of a scarp on the foot of its beach).

The number of sweeps is a count of texels, not a length: 32 sweeps relax a
scarp over about four texels at any resolution, so a build slumps a narrower
foot than its preview. The scarp behind a beach is the outer part of the band,
where the weight falls: it is as wide as that at every resolution, and the
sweeps only round its foot. On the `terrain` fixture 257 and 513 differ by 0.0025
of the standard deviation in `out` and by 0.026 in `depth`, whose values all
lie near the shore; the node declares a `resolutionTol` of 0.04.

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| An inland basin floods through a one-texel gap | N4 connectivity through a narrow inlet | `mode: 'connected'` keeps basins without any gap dry; a remaining gap is terrain to fix upstream |
| Reshaped band with a visible seam at its edge | blend weight ends abruptly | the weight and its slope are 0 at the band's edge (a smooth step) |
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
| output `snow` | mask | `saturate(depth / (SNOW_COVER * snowfall))`: snow cover; 0 everywhere when `snowfall` is 0; when wanted |
| output `depth` | data | snow thickness, in height units; when wanted |

| Param | Kind, unit | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `snowfall` | float, height | 0.02 | 0..0.1, soft | thickness that falls where nothing limits it |
| `snowLine` | float, height | 0.5 | 0..1, soft | altitude above which snow falls |
| `band` | float, height | 0.05 | 0.001..0.5, log | half-width of the transition around the snow line |
| `slipAngle` | float, angle (`param.slope`) | 50 | 5..89 | snow slides off surfaces steeper than this |
| `melt` | float, ratio | 0.2 | 0..1 | share of the snowfall that melts on fully exposed ground at the snow line and above |
| `exposure` | float, ratio | 0.5 | 0..1 | how much the melt depends on facing the sun: 0 = uniform |
| `angle` | float, angle (`param.angle`) | 0 | 0..360 | direction from the terrain towards the sun |
| `size` | float, length (`param.size`, label Reach) | 0.02 | 0.001..0.25, log | how far snow can slide |

### 10.3 State, passes, equations

State: the layered solver of 5.9 with `bed` = the node input at the level and
`layer` = snow depth. Planes `layer`, `next`, `lim` = 3
`field`; at the end `simulate/snow.finish` writes `out` and `snow` into `next`
and `lim`, and `depth` is the layer plane:
3 `field` = 793 MB at 8129².

Per iteration two passes: `simulate/layer.limit`, then `simulate/snow.move`,
which is `simulate/layer.move` with the source computed in the kernel instead
of read from an input. Both run with `creep = SNOW_CREEP` and `full` = the
snowfall (5.9):

| # | Kernel | Reads | Writes | Loads |
| --- | --- | --- | --- | --- |
| 1 | `simulate/layer.limit` | `bed` own + N8, `layer` own + N8 | `lim` | 18 |
| 2 | `simulate/snow.move` | `bed` own + N8, `layer` own + N8, `lim` own + N8, `mask` own | `next` | 38: the exchange, and the surface once more for its normal |

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
layer ← max(0, layer + exchange of 5.9 with tan(slipAngle), SNOW_CREEP and full = snowfall + source)
```

- Below the snow line nothing falls and snow that slid there melts at twice the rate.
- **Snow drifts** (**design, to validate**). On a slope it does not slide off, snow still evens out a share of every height difference (the creep of 5.9): it leaves the crests and the convex ground within about a reach of them and gathers in the hollows and at the foot of a slope, an even slope keeps what fell on it, and the ground under the snow comes out rounded: at the default snowfall the gullies and the small relief of high ground are filled. Without it the snow was the same thickness wherever it did not slide, `out` was the input lifted by that thickness, and only the mask showed the node.
- `mask` limits where snow falls, not where it slides. It is brought to each level with `levelInput` at the start of `simulate` and released at its end (2.7); at `ctx.res` it is the input itself.
- Budget and base level: 5.7 with `strength = 1`, and at least one iteration when `snowfall > 0` (2.5 item 1): where the reach is below half a texel the snow falls and stays. Refinement: 5.9.
- The cover is a share of the snowfall, not a depth in metres: a face the snow is sliding off carries a few percent of the snowfall in transit when the run ends, and with a threshold of 0.1 m every face above the snow line read as covered once the snowfall was more than a few metres.

### 10.4 Invariants and artefacts

1. `depth >= 0`; `out = in + depth` exactly; `snow` in 0..1.
2. `mean(depth) <= snowfall`. With `melt = 0`, `mask` unconnected and `snowLine + band` below the whole terrain, on a single level: `mean(depth) = snowfall` within `1e-4 * snowfall`.
3. With `snowfall = 0`, `out` is bit-identical to `in`.
4. After the run on the cone fixture, with `size` at least the cone's radius and `slipAngle` 40, no N8 pair of the snow surface that carries snow at rest (more than 1/40 of the snowfall; less is in transit down a face) exceeds `tan(slipAngle)` by more than 5 %.
5. A plane 6 % steeper than the slip slope sheds its snow alike whichever way it faces, as the layer of 5.9 does. One 6 % gentler keeps what fell on it away from its borders: the snow creeps, and on an even slope as much arrives as leaves.
6. Below the snow line the snow ends: on the `rampX` fixture with `melt` 0, 28 texels (450 m) below the line less than `1e-9` lies, and from 68 texels below it none at all.

| Artefact | Cause | Counter-measure |
| --- | --- | --- |
| Snow on vertical faces | accumulation ignores slope | the slide moves it off within the reach |
| Straight streaks and facets in the snow, one to one in a build | the threshold of the slide taken between two texels alone | the slope at the middle of the pair (5.3) |
| Terraced snow line | abrupt altitude threshold | `band` |
| Thin speckled snow near the line | fall and thaw nearly cancel | `SNOW_COVER` threshold in the `snow` mask |
| Every face above the snow line reads as covered | snow in transit when the run ends | the cover is a share of the snowfall |
| `out` hardly differs from `in` | snow of one thickness wherever it does not slide | the snow drifts off the crests into the hollows (10.3); the default `snowfall` is 0.02, which fills the gullies of high ground |
| A film of snow far below the snow line | a creep that moves a thin layer as fast as a thick one | a layer creeps in proportion to its thickness (5.9) |
| Snow only in the gullies, every face bare | the terrain is steeper than the slip angle nearly everywhere above the snow line | the default `slipAngle` is 50: the generators' terrains stand at 45 to 60 degrees with the default proportions |

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

Every number below is a named constant of the `simulate` category: in
`_constants.ts`, or, for a row that only sections 6 to 9 use, in a constants
module of the hydrology owner (`nodes.md` section 4). No kernel or node
contains another tuning literal. A value marked
**fixed** follows from a derivation in this document and is not tuned.

| Constant | Value | Unit | Used in | Status and source |
| --- | --- | --- | --- | --- |
| `FEATURE_CELLS` | 64 | texels | 3.8, 4.6, 4.8 | to calibrate. Was 32; raised with the first routing of 3.3. With 64 the default fluvial feature starts on 513 at 513 and on 1017 at 8129. Not compared with 32 under the routing that replaced it; the measurement of item 2 below is still to make. Also the width of the strip a channel head of hydraulic erosion is counted over, the coarsest cell of a base level (4.6) |
| `FEATURE_CELLS_RELAX` | 8 | texels | 5.7, 5.9, 10 | to calibrate; unchanged |
| `DETAIL_SLOPE` | 0.1 | cell fraction | 2.4 | to calibrate |
| `JITTER_HALF_WIDTH` | 0.25 | coarse texels | 2.4 | fixed; Tzathas24 |
| `COURANT` | 0.5 | texels per iteration | 3.6 | fixed; stability |
| `CELERITY_CAP` | 4 | none | 3.3 | to calibrate; unchanged |
| `TALUS_RATE` | 0.1 | none | 3.3 | to calibrate; unchanged. At 1 the run removed 0.16 of the height range on average from `generate/fractal-noise` at 513 against 0.11, and took its highest point from 0.84 to 0.72: the slope limit then does more than the rivers. Between the ratios implied by Jain24 (0.03) and Tzathas24 (0.2) at a 1 km feature |
| `FLOW_SPREAD` | 1.5 | none | 3.6 | to calibrate. 1, 1.5 and 2.5 were drawn on `generate/mountain` at 1025, one to one, and the three pictures are alike. Holmgren94 as commonly cited recommends 4 to 6 for hydrology; that is for area maps, not for cutting |
| `FLOW_JITTER` | 0.5 | none | 3.6 | to calibrate; one value tried. Without it the output of a single level does not depend on the seed and a cone is worn without a valley. On the `cone` fixture the wear along the axes is 0.96 of that along the diagonals without it and 1.00 to 1.02 with it |
| `FRESH_CELLS` | 3 | texels of the coarser level | 3.3 | calibrated with `FRESH_BOOST` on `generate/mountain` at 2049, one to one, against a run on that one level. Without the term the build removes 7 % more than the one-level run and shows no small valleys; at 3 and 0.5 it removes 21 % more and shows some; at 4 and 1 it removes 47 % more and every valley side is a regular herringbone of side valleys |
| `FRESH_BOOST` | 0.5 | none | 3.3 | calibrated, as above. With it every finer level removes some 5 % more in all: the mean change on `generate/mountain` is 0.0268 at 513 (one level), 0.0281 at 1025 and 0.0293 at 2049, against 0.0241 for a run on the one level 2049. A build is cut a little deeper than its preview |
| `DETAIL_ITERATIONS_FLUVIAL` | 256 | iterations | 3.7 | to calibrate; estimate 200 to 300; unchanged |
| `FILL_SWEEPS` | 4 | sweeps per step | 3.5 | to calibrate; range 2 to 8 |
| `ROUTE_EPS` | `max(0.001 / R, 5e-7)` | height | 6.1 | to calibrate; 1 mm per texel. `routeEps(R)` of `_route.ts`, from `ROUTE_EPS_METRES` and `ROUTE_EPS_FLOOR` |
| `ROUTE_FLAT_DROPS` | 2 | `eps` | 6.2 | to calibrate; a drop of a filled texel is `eps` to within a float32 step, a fifth of `eps` at the floor |
| `ROUTE_FLAT_COST`, `ROUTE_FLAT_SHORE` | 256, 63 | none, texels | 6.2 | to calibrate; a step beside the edge of a flat costs 64 times one in its middle |
| `ROUTE_FLAT_JITTER` | 3 | none | 6.2 | to calibrate; by eye, on a level plain |
| `G` | 9.81 | m/s² | 4 | fixed |
| `H_REF` | 20 | m | 4.3 | to calibrate; JT11's pipe area at unit cell size; unchanged |
| `PIPE_SAFETY` | 0.5 | none | 4.7 | fixed; stability |
| `NOMINAL_SPEED` | 0.25 | none | 4.7 | to calibrate |
| `TRAVEL_MAX` | 1 | terrain widths | 4.7 | to calibrate; one value. Water runs two to four times the nominal speed, so at 1 it has crossed the terrain at least twice |
| `RAIN_MAX` | 0.005 | m/s | 4.6 | calibrated with `HEAD_RAIN`, which it is counted against: what matters of the two is how deep the water stands. Was 0.05, the top of JT11's range: the runoff of a flank 1500 m long was then a sheet a metre deep at its foot and stood in the valleys from wall to wall. At a tenth the wear of `generate/mountain` at 1009 lies in the lines the water runs in, and the mask of `flow` is a stream network. One value tried beside 0.05 |
| `KE` | 0.015 | 1/s | 4.6 | to calibrate; JT11 typical |
| `HEAD_RAIN` | 0.0006 | m/s | 4.6 | calibrated on `generate/mountain` at 1009 by the wear mask, with `GATHER_MAX`: half the default rain, so a channel head is the runoff of a strip half a feature size long, or of a hollow some 20 m square. At twice the default rain (0.0024, with `GATHER_MAX` 16) the wear lay in the trunk valleys alone, a tenth of the terrain; at 0.0006 the slopes between them carry gullies, 17 to 22 % of the terrain is worn, and a divide stays unworn. Was 0.024 with a rain ten times as hard |
| `GATHER_MAX` | 32 | channel heads | 4.6 | calibrated on `generate/mountain` at 1009 with `CARRY` and `CUT_SHARE`: 16, 24, 32 and 64 were drawn. A gully that drains a square half the feature size across under the default rain has 32 heads and the full depth. At 64 only the trunk gullies of a massif 3.6 km across reach it; at 3, the first calibration, every gully did, and they were of one depth and one width |
| `CARRY` | 250 | m | 4.6 | calibrated on `generate/mountain` at 1009: the load at `GATHER_MAX` heads on a vertical face at `capacity` 1. 100, 250 and 400 were measured without the limit of the water's depth on the pick-up: the mean wear is 0.0009, 0.0018 and 0.0025 of the height range, and its 99th percentile 16, 26 and 33 m. At 250 the gullies show in the 3D picture of the whole massif and `capacity` and `downcutting` still change the result: `capacity` 0.3 and 3 give 0.34 and 2.3 times the wear at 100, and 0.43 and 1.7 times at 400, where the larger gullies are held by their depth. With the final constants the mean wear at the defaults is 0.0015 and its 99th percentile 24 m |
| `CARRY_POWER` | 1.5 | none | 4.6 | to calibrate; above 1 so that water that runs together cuts more than the same water spread out. 1 and 1.5 were reasoned, 1.5 drawn: an even slope (the `notch` fixture at 1025) is cut into rills |
| `CUT_POWER` | 0.5 | none | 4.6 | calibrated on `generate/mountain` at 1009 against 1, with `GATHER_MAX` 64: with 1 a gully of a quarter of the heads may cut a quarter of the full depth, and the slopes between the trunk valleys showed nothing; with 0.5 it may cut half |
| `PICKUP` | 0.05 | none | 4.6 | to calibrate; one value tried beside 1. At 1 the load is the capacity within a texel |
| `SETTLE` | 1 | none | 4.6 | calibrated on `generate/mountain` at 1009 and on the `cone` fixture at 257. At 0.2 a load that had lost its capacity ran out over 200 m as a sheet a metre thick, whatever `deposition`. At 1, with `deposition` 3 the deposits are lobes at the mouths of the valleys and with 0.1 thin sheets over the plain: on the cone the deposit lies 76 texels from the tip on average with 1 and 3, and 86 with 0.1, where half of it covers twice as many texels (7243 against 3578) |
| `SETTLE_BAND` | 2 | none | 4.6 | to calibrate; 1 and 2 were drawn on `generate/mountain` at 1009, where 2 removed the heaps along the upper gullies. With the room a deposit needs (4.6) the two pictures are alike; 2 is kept |
| `CUT_SHARE` | 0.3 | share of the feature size | 4.6 | calibrated by eye on `generate/mountain` at 1009 between 0.2 and 0.3, with `CARRY`: the deepest cut is this share, 60 m at `size` 0.05 on a terrain 4032 m wide; measured 41 to 53 m over the study set at 1009. Was 0.2 |
| `CUT_SLOPE` | 0.25 | sine | 4.6 | to calibrate; set so that gently sloping ground (a coastal plain of `generate/island`) is not cut as deep as a mountainside by the water that crosses it. At 0.5 the mean change there was 0.0038 against 0.0040 |
| `FAN_ANGLE` | 6 | degrees | 4.6, 5.6 | calibrated by eye on `generate/mountain` at 1009 among 3, 6 and 8: the slope a deposit is built up to (its room) and slides back to. At 3 a fan is too low to show beside a massif; at 8 the heap at a valley's mouth is steep-sided. Was 8 |
| `CREEP` | 0.5 | none | 4.6, 5.6 | to calibrate; 0.1, 0.5 and 1 were drawn on `generate/mountain` at 1009. It evens out bars and levees a texel wide. Not compared one to one at 4033 |
| `FLUSH_POWER` | 8 | none | 4.6 | to calibrate; one value. At `removal` 0.4 the share of what cannot rest that is laid down in place is 0.017, at 0.1 it is 0.43, at 0 all of it |
| `SIN_MIN` | 0.02 | none | 4.6 | to calibrate; Mei07 requires a floor and gives no value |
| `D_MIN` | 1e-4 | m | 4.6 | to calibrate; unchanged |
| `QUANTUM` | `2^-23` | height | 4.6 | fixed; one float32 step of a height between 1 and 2. A literal of the kernel `simulate/hydraulic-erosion.water` |
| `ERODIBILITY_JITTER` | 0.25 | none | 4.6 | to calibrate |
| `DETAIL_ITERATIONS_HYDRAULIC` | 384 | iterations | 4.7 | to calibrate; estimate 400 to 800 |
| `TRANSFER` | 0.1 | none | 5.3 | fixed; bound 1/9 to validate |
| `RELAX` | 4 | none | 5.7 | calibrated on the cone fixture (5.8 item 6). Steepest pair over the talus tangent at 35°, single level and four levels: 1.049 and 1.071 at 2, 1.023 and 1.047 at 3, 1.011 and 1.042 at 4, 1.003 and 1.042 at 6. Was 2 |
| `DETAIL_ITERATIONS_RELAX` | 96 | iterations | 5.7 | to calibrate; estimate 100 |
| `WETNESS_SLOPE_MIN` | 0.001 | tangent | 7 | fixed; the index has no value on level ground |
| `WETNESS_AREA_MIN` | 0.1 | cells | 7 | to calibrate; keeps `wetness` finite where precipitation leaves no area |
| River exponents (`RIVER_WIDTH_EXPONENT`, `RIVER_DEPTH_EXPONENT`) | 0.5, 0.4 | none | 8.5 | fixed; LM53 as commonly cited |
| `RIVER_TAPER` | 0.1 | none | 8.5 | to calibrate; by eye: a river gains a tenth of the length of its course in width at the most |
| `COURSE_SMOOTHING`, `COURSE_SMOOTHING_MIN` | 1, 4 | river widths, texels | 8.5 | to calibrate; by eye, and by the evenness of a valley's side beside a steep river |
| `COURSE_SLACK`, `COURSE_SLACK_MIN` | 0.5, 2 | river widths, texels | 8.5 | to calibrate |
| `SITE_SPACING` | 0.75 | texels | 8.5 | fixed; below 1, so that the texels of two sites on a river touch |
| `COURSE_REFINE` | 8 | iterations | 8.5 | to calibrate; measured on `generate/island` and `generate/canyon` at 1009 and `generate/eroded-noise` at 2017: without the step 0.2 to 0.4 % of the cut texels differ, by up to 73 m; after two steps one texel does; after eight none differs from 32 |
| `VALLEY_GRADE` | 0.2 | of the bank slope | 8.5 | calibrated with the valley of 8.5, whose side falls away from the water at the bank slope and then more gently: a tributary lies below the side of the valley it joins unless it runs within some twelve degrees of the river. Was 0.5 |
| `PROFILE_SMOOTHING` | 3 | river widths | 8.5 | to calibrate; of the river texels of `generate/island` at 2017, 411 fall by more than their length on the routing surface and 150 to 240 after smoothing over 4 and 1.5 widths |
| `PROFILE_DEPTH` | 0.25 | river widths | 8.5 | to calibrate; by eye on `generate/canyon`, where streams fall over the rim |
| `BANK_RISE` | 1 | none | 8.5 | to calibrate; the depth of a valley is that of its channel and this many times what the river lies below the routing surface |
| `VALLEY_REACH` | 2 | none | 8.5 | calibrated by eye on `generate/canyon`, `generate/island` and `generate/fractal-noise` at 1009: the valley's depth falls to 0 as a square over twice the width a side at the bank slope would have, so that it has the bank slope at the water |
| `COAST_FLAT` | 0.3 | of the band | 9.2 | to calibrate; by eye |
| `COAST_SWEEPS` | 32 | iterations | 9.2 | to calibrate |
| `COAST_TALUS` | 35 | degrees | 9.2 | to calibrate |
| `COAST_TRANSFER` | 0.1 | none | 9.2 | fixed; `TRANSFER` of 5.3 |
| `SUN_ELEVATION` | 45 | degrees | 10.3 | to calibrate |
| `SNOW_COVER` | 0.25 | share of the snowfall | 10.2 | calibrated by eye: the faces snow slides off read as bare. Was 0.1 m (10.3) |
| `SNOW_CREEP` | 0.5 | none | 10.3 | calibrated by eye on `generate/mountain` and `generate/fractal-noise` at 1009: the snow leaves the crests, fills the gullies and the small relief of high ground, and `out` is visibly rounded where it lies. One value drawn, with the creep in proportion to the thickness (5.9) |

Parameter defaults and ranges were starting values of the same standing. Those
of sections 6 to 9 are calibrated by eye on `generate/eroded-noise` and
`generate/island` at 513 with the test settings and by the invariants; those
of sections 3 to 5 and 10 on the generators and resolutions each row of this
section names.

**The study set.** What the rows of this section that name it were judged on,
and what was looked at in the final state: `generate/mountain-range`,
`generate/mountain`, `generate/island`, `generate/canyon` and
`generate/fractal-noise` at their defaults, each through each of the ten
nodes at its defaults, with the settings of a new project (a terrain 4032 m
wide, a height range of 1008 m, the sea level 0) and the project seed 1, at
505 and at 1009, every output drawn by `orogen render` as grey, as hillshade
and in 3D from its one camera, beside the picture of the generator: 110
runs. At 4033, one to one in a crop of 768: hydraulic erosion over
`generate/mountain` and `generate/canyon`, rivers over `generate/canyon` and
`generate/island`, snow over `generate/fractal-noise` and
`generate/mountain`, fluvial erosion over `generate/mountain-range`, thermal
erosion over `generate/mountain`. At 8129: one build of fluvial, then
hydraulic, then thermal erosion over `generate/mountain-range` (below). With
the level ground of three of the five at the sea level, as a new project has
it. Not looked at in the final state: a connected `mask`, `precipitation`,
`upliftMask` or `headwaters` over the study set; a sea level above 0 but for
the coast of `generate/island` under fluvial erosion; `sediment`, `fill`,
`flow`, `lakes` and `sea` at 4033; thermal erosion at 4033 with its reach of
0.005 (the crop is that of 0.02, and still has faint streaks at two or three
spots).

| Node | Parameter | Was | Is | Why |
| --- | --- | --- | --- | --- |
| `simulate/rivers` | `catchment` | 0.002 | 0.001 | a network with its tributaries on a terrain whose rivers each drain a few percent |
| `simulate/rivers` | `riverWidth` | 0.004, 0..0.05 | 0.05, 0..0.25 | at 0.004 a river that drains 1 % is 1.6 m wide, a fifth of a texel at 513: no picture showed a channel. At 0.08 the trunk of `generate/canyon` filled the canyon's floor |
| `simulate/rivers` | `riverDepth` | 0.003, 0..0.05 | 0.03, 0..0.25 | at 0.003 the same river is half a metre deep |
| `simulate/rivers` | `valleyDepth` | none, then 0.1 | 0.2, 0..0.5 | a channel alone, 5 m deep in a river 20 m wide, shows in no picture of a terrain 4 km across: the valley is what reads as a river. At 0.1, with sides cut as planes, a river that drains 1 % lay in a valley of 16 m, which did not read against relief of hundreds; with the valley of 8.5, 0.1, 0.2 and 0.3 were drawn over the study set at 1009. At 0.2 the rivers of `generate/canyon`, `generate/island` and `generate/fractal-noise` lie in valleys the 3D picture of the whole terrain shows; at 0.3 the trunk valleys of `generate/fractal-noise` are a third as deep as its relief |
| `simulate/lakes` | `minDepth` | 0.001 | 0.003 | at the old values the water mask of `generate/eroded-noise` was a speckle of ponds; now it shows some twenty lakes |
| `simulate/lakes` | `minSize` | 0.005 | 0.02 | the same: a lake covers a square of 80 m at the least, 10 texels at 513 |
| `simulate/sea` | `strength` | 0 | 1 | at 0 the node's first output is its input (`testing.md` 6.6 rule 1) |
| `simulate/sea` | `shoreSize` | 0.01 | 0.02 | a band of 5 texels at 513 does not show |
| `simulate/sediment` | `thickness` | 0.005 | 0.02 | 5 m is less than a texel of the gallery's terrain is wide; at 0.02 the fills show in the 3D picture. (The picture at 0.005 was drawn and not looked at) |
| `simulate/snow` | `snowfall` | 0.004, 0..0.05 | 0.02, 0..0.1 | for the same reason. At 0.02 `out` still differs little from `in`; the `snow` mask shows the effect |
| `simulate/snow` | `slipAngle` | 40 | 50 | the generators' terrains stand at 45 to 60 degrees: at 50 the gentler high ground of `generate/eroded-noise` is covered and its steep faces are bare, at 513 and 1025. The mean cover there is 0.24 at 40 and 0.27 at 50, with `melt` 0.3 |
| `simulate/snow` | `melt` | 0.3 | 0.2 | more of the high ground keeps its cover; not compared by eye with 0.3 |
| `simulate/hydraulic-erosion` | `talus` | 35 | 45 | the generators' slopes stand at 45 to 60 degrees: at 35 and 40 the banks of neighbouring gullies meet and the slope between them comes down (4.6 pass 4); 35, 40, 45 and 55 were drawn at 1025 |
| `simulate/hydraulic-erosion` | `removal` | new, then 0.6 | 0.4 | 0.4 and 0.6 were drawn on `generate/mountain` at 1009 with the constants of this section: at 0.4 the fans at the foot of the massif show in its 3D picture. Over the study set at 1009 the mean `deposit` is 19 to 28 % of the mean `wear`, and 8 % on `generate/fractal-noise`, which has little ground a deposit can rest on. What is on its way when the run ends leaves as well (4.6 pass 5) |
| `simulate/thermal-erosion` | `size` | 0.02 | 0.005 | at 0.02 the node took every gully and spur off the study terrains and left a smooth massif, also of what fluvial and hydraulic erosion had cut before it; at 0.005, 20 m, the spurs and the valleys between them stand and their faces are scree. Drawn over the study set at 1009 and over hydraulic erosion on `generate/mountain` |

Unchanged: `tilt` 0, `routing` `single`, `bank` 30, `mode` `connected`,
`shoreHeight` 0.005; and every other default of
sections 3 to 5 and 10: fluvial `size` 0.125, `duration` 1, `concavity` 0.4,
`talus` 30, `lakeFill` 1; hydraulic `size` 0.05, `duration` 2, `rain` 0.24,
`capacity` 1, `downcutting` 0.5, `deposition` 1; thermal `talus` 35, `strength` 1,
`removal` 0; `repose` 33; snow `snowLine` 0.5, `band`
0.05, `exposure` 0.5. Thermal erosion at `talus` 35 collapses the faces of a
generator's terrain, which stands steeper than that almost everywhere at the
default proportions: that is what the angle means, and it is left; how much of
a face comes down is the reach.

**Resolution tolerances** (item 7 below), measured on the `terrain` fixture
between 257 and 513 at the defaults, as the rms difference at shared vertices
over the standard deviation of the output:

| Node | Measured | Declared |
| --- | --- | --- |
| `simulate/thermal-erosion` | `out` 0.0002, `wear` 0.019, `deposit` 0.014 | `resolutionTol` 0.04 |
| `simulate/sediment` | `out` 0.0002, `depth` 0.004 (0.012 between 129 and 257) | `resolutionTol` 0.02 |
| `simulate/snow` | `out` 0.0004, `snow` 0.032, `depth` 0.034; 0.002 for both between 513 and 1025 | `resolutionTol` 0.05 |
| `simulate/fluvial-erosion` | `out` 0.034, `wear` 0.24, `flow` 0.82 | `skip.resolution`: `flow` is stream lines one texel wide (2.8 item 5). The node's own test holds `out` to 0.08 and `wear` to 0.4 |
| `simulate/hydraulic-erosion` | `out` 0.004, `wear` 0.32, `deposit` 0.19, `flow` 0.38 | `skip.resolution`: gullies, fans and stream lines a few texels wide. The node's own test holds `out` to 0.02 and the mean of the three others to a factor of 2 |

**Measured reference points** (development machine: GTX 1660 Ti, Dawn on
Vulkan, Node 26). They are the only numbers in this document measured on this
project's hardware; everything derived from them is an estimate.

| Measurement | Value |
| --- | --- |
| 5-point stencil pass, `field` ping-pong, 2048² | 0.29 ms (14.3 G texel-passes per second); the same per texel at 1024² |
| Four-pass pipe-model iteration, 2048² | 3.03 ms with `field` and `aux` state; 2.49 ms with in-place flux and a compact velocity |
| Priority flood in Node (N8, queue variant) | 192 ms at 1025², 777 ms at 2049², 3.9 s at 4097² |
| Router task `simulate/route`, `routing: 'single'`, one thread, first call of a process | 0.68 to 0.87 s at 2033², 2.6 to 3.5 s at 4065² (156 to 214 ns per texel, by the share of texels on flats, 21 to 34 %); a quarter of it is the flats (6.2 step 3). 14 bytes per texel at the peak beside the array returned: 60 MB and 222 MB |
| `simulate/rivers` at 4033, defaults, on `generate/canyon` and `generate/island` | 2.7 and 2.8 s in all; longest slice 32 ms; 716 MB of fields at the peak |
| The ten nodes at their defaults over the study set, whole node, 1009², the preview of a new project | fluvial 1.7 to 3.4 s, hydraulic 1.5 to 2.0 s, thermal 0.04 s, sediment and snow 0.15 s; fill, flow, lakes and sea 0.3 to 1.2 s, rivers 0.6 to 1.5 s. Longest slice 81 ms (hydraulic) |
| The same at 4033² | fluvial 13.4 s (`generate/mountain-range`), hydraulic 27.3 and 28.9 s (`generate/mountain`, `generate/canyon`), thermal 0.8 s, snow 1.1 and 1.2 s, rivers 2.7 and 2.8 s; longest slice 103, 143, 78, 80 and 32 ms; peak state 0.46, 0.72, 0.20, 0.20 and 0.72 GB |
| One build of `generate/mountain-range`, then fluvial, hydraulic and thermal erosion at their defaults, 8129², with a pool budget of 5120 MiB on the 6 GB card | 156 s in all, status ok, no engine error: fluvial 71.2 s, of which 29.7 s on the GPU and the rest in the router of its four levels; hydraulic 73.8 s; thermal 4.0 s. Peak state 1850, 2643 (with `out` alone wanted; 2907 with every output) and 529 MB, each beside one input of 264 MB. Longest slice 138 ms (`simulate/talus.step`), of 2812 slices |
| Readback of a `field` | 853 MB/s |

**What calibration must settle before defaults are frozen:**

1. The `DETAIL_ITERATIONS_*` constants: on three reference terrains, at the ladder levels 1017 and 4065, the constant is the smallest value for which doubling it changes `out` by less than 2 % rms of the standard deviation of `out − in`. Not made. (`RELAX` is set by 5.8 item 6.)
2. `FEATURE_CELLS`: the smallest value for which a run from the selected base level differs from a run started one level finer by less than 5 % rms of the same measure. Not made: 64 was set by eye.
3. `FILL_SWEEPS`: whether lakes drain visibly late at 2, 4 and 8 sweeps per step.
4. The hydraulic rates (`H_REF`, `RAIN_MAX`, `KE`, `HEAD_RAIN`, `GATHER_MAX`, `CARRY`, `PICKUP`, `SETTLE`, the three rate defaults) on terrains of 2 km and 16 km width, so that default parameters give gullies of the feature size and neither flood nor strip the terrain. Calibrated on a terrain 4 km wide and 1 km high only. The channel head and the depth of a gully follow the feature size in metres, so they keep their proportion to the terrain; `CARRY` is in metres, so how fast a gully reaches its depth on a terrain of another size is not known.
5. The time of the router at 8129² in the engine's CPU thread. If it exceeds the GPU work of the level it serves, the routing surface and the area of `simulate/fluvial-erosion`'s finest level are instead refined from the coarser level and corrected by sweeps; that change is made in this document first. Measured up to 4065² (above): the rate gives 10 to 14 s at 8129², against the 10 s estimated for that level's 256 iterations (3.8). Measured in one build at 8129² (above): of the node's 71 s, 30 s are GPU work and 41 s the router's five calls, the readbacks and the uploads; the call of the finest level is not timed apart. The CPU side is the larger: the change is due.
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
| `cone` (flank steeper than every talus default) | thermal 5.8 item 6; snow 10.4 item 4 (at `slipAngle` 40); fluvial 3.9 item 7 |
| `bowl` (border ring highest) | hydraulic 4.9 item 3 |
| `notch` (a plane with one channel, no depression, nowhere steep) | fluvial monotone flow 3.9 item 5; rivers 8.6 item 2; thermal 5.8 item 3 |
| `basin` (a depression below the test sea level that does not touch the border) | lakes 9.1; sea `connected` against `global` 9.2 |

The fixed-point and upper-bound invariants (6.5 items 3 and 4) run the router
task and `simulate/route.sweep` on the same terrain at 257² and 513². Item 3
is compared with the tolerance it states, which is the row "a CPU task against
a GPU kernel" of `testing.md` 3.4.
