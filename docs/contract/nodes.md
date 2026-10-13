# Node catalog: the product's nodes for the first release

This document fixes which nodes exist, their type ids, their ports and what
each is for. It does not fix their algorithms or their full parameter lists:
those are the category owner's design, inside the conventions of `engine.md`
section 4 and `testing.md` section 6. Simulation nodes are specified in
`simulation.md` and export nodes in `export-unreal.md`; this catalog only lists
them.

Rules for owners:

- Every node listed for a category ships, with exactly this id and these ports. Ids and port names are permanent once released.
- A parameter named here is required, under that name. Owners add the others a node needs.
- An owner may add a node that is not listed when the category plainly lacks it, and reports it. An owner does not drop or merge listed nodes; a node that cannot be done well is reported, with the reason.
- "any → same" means an input `in` of type `any` and an output `out` declared `sameAs: 'in'` (`engine.md` 4.2). "field" without a role means role `height`.
- Nodes of `adjust`, `filter`, `surface` and `color` whose `in` and `out` have the same type are `maskable` unless noted (`testing.md` 6.5).
- Quality bar: at default parameters each node's gallery picture shows plainly what it does (`testing.md` 6.6), and a generator's default output looks like the landform it is named for when lit in the 3D preview, not like tinted noise.

## 1. `generate`: 16 nodes

No required inputs. Output `out` (field). All but `constant`, `gradient`,
`radial-gradient`, `shape` and `waves` take `seed`.

Two owners share the category by file, as in `simulate` (section 4); each owns
one private index module that `generate/index.ts` concatenates:

| Owner | Private index | Nodes | Private modules |
| --- | --- | --- | --- |
| basics | `_basics.ts` | `constant`, `gradient`, `radial-gradient`, `shape`, `waves`, `fractal-noise`, `cellular-noise`, `eroded-noise` | names beginning `_noise`, `_shape` |
| landforms | `_landforms.ts` | `mountain`, `mountain-range`, `island`, `volcano`, `crater`, `crater-field`, `canyon`, `dunes` | names beginning `_land` |

Each owner's WGSL libraries carry its own prefix (`generateNoise…`,
`generateLand…`: a library name has no slash or hyphen, `engine.md` 3.7), so
neither waits for the other; both build on the core noise and hash libraries
of `engine.md` 3.9.

| Id | Title | What it makes | Named parameters and notes |
| --- | --- | --- | --- |
| `generate/constant` | Constant | A flat field at one height | `height` |
| `generate/gradient` | Gradient | A linear ramp across the terrain | `angle`, `size` (length of the ramp), `offset`, `mode`: `linear`, `mirrored`, `smooth` |
| `generate/radial-gradient` | Radial Gradient | A radial falloff around a point | `center`, `radius`, `mode`: `cone`, `dome`, `bell`, `ring` |
| `generate/shape` | Shape | A filled analytic shape with a soft edge; output role `mask` | `mode`: `ellipse`, `rectangle`, `polygon`; `center`, `extent` (vec2, length: half-width and half-height), `angle`, `feather`, `count` (polygon sides) |
| `generate/waves` | Waves | Parallel waves: a periodic profile along a direction | `mode`: `sine`, `triangle`, `saw`, `square`; `size` (wavelength), `angle`, `offset`, optional warp (`warpSize`, `warpStrength`) |
| `generate/fractal-noise` | Fractal Noise | Fractal gradient noise, the workhorse for base terrain | `mode`: `fbm`, `ridged`, `billow`; `size`, `octaves`, `gain`, `lacunarity`, `warpStrength`, `warpSize`. Keywords: perlin, simplex, fbm |
| `generate/cellular-noise` | Cellular Noise | Cell patterns from scattered feature points | `mode`: `distance`, `second`, `edge`, `cell`; `size`, `jitter`. Keywords: voronoi, worley |
| `generate/eroded-noise` | Eroded Noise | Fractal noise whose fine octaves are suppressed on slopes and valley floors, with gullies that run down the slopes in their place, giving smooth valleys and sharp, rough crests without simulation | `size`, `octaves`, `gain`, `erosion` (ratio) |
| `generate/mountain` | Mountain | One massif: a peak with ridges radiating from it | `center`, `size` (base width), `height`, `sharpness`, `ridges` (ratio) |
| `generate/mountain-range` | Mountain Range | An elongated chain of peaks with spurs | `angle`, `size` (width of the range), `length`, `height`, `count` (peaks) |
| `generate/island` | Island | A landmass with an irregular coast that falls below sea level at the borders; second output `water` (mask) | `size`, `coast` (ratio, irregularity), `height`. Uses the project's sea level |
| `generate/volcano` | Volcano | A cone with a crater and gullied flanks | `center`, `size`, `height`, `craterSize`, `craterDepth` |
| `generate/crater` | Crater | One impact crater: bowl, raised rim, optional central peak and ejecta | optional input `in` (terrain to stamp into; without it a flat field at `height` 0.5), `center`, `radius`, `depth`, `rim`, `peak` |
| `generate/crater-field` | Crater Field | Many craters of varied size | optional input `in`, `count`, `radiusMin`, `radiusMax`, `depth` |
| `generate/canyon` | Canyon | A plateau cut by branching, winding canyons | `size`, `depth`, `width`, `branching` (ratio), `levels` (wall terraces) |
| `generate/dunes` | Dunes | A field of wind-shaped dunes with asymmetric profiles | `mode`: `transverse`, `barchan`, `star`; `size`, `angle` (wind), `height`, `irregularity` |

## 2. `adjust`: 11 nodes

| Id | Title | Ports | What it does; named parameters |
| --- | --- | --- | --- |
| `adjust/levels` | Levels | any → same | Black point, white point, gamma, output range: `inMin`, `inMax`, `gamma`, `outMin`, `outMax` |
| `adjust/curve` | Curve | any → same | Remaps values through a curve: `curve` |
| `adjust/clamp` | Clamp | any → same | Limits values to a range, hard or with a soft knee: `min`, `max`, `softness` |
| `adjust/bias-gain` | Bias and Gain | any → same | Pushes values toward one end (`bias`) and toward or away from the middle (`gain`) |
| `adjust/invert` | Invert | any → same | Mirrors values around a pivot: `pivot` (default 0.5) |
| `adjust/autolevel` | Auto Level | field → field | Stretches the measured minimum and maximum to 0..1. `resolutionDependent` |
| `adjust/equalize` | Equalize | field → field | Redistributes heights so every height band covers the same area: `strength`. `resolutionDependent` |
| `adjust/math` | Math | `in` (field), `b` (field, optional) → field | One arithmetic operation with a constant or a second field: `mode`: `add`, `subtract`, `multiply`, `divide`, `power`, `absolute`, `minimum`, `maximum`, `modulo`, `fold`; `value`. Not maskable (it has two inputs of its own meaning) |
| `adjust/combine` | Combine | `a`, `b` (any; a `b` of the other kind is converted as a connection is, `runtime.md` 5.6), `mask` (optional) → same as `a` | Blends two inputs: `mode`: `mix`, `add`, `subtract`, `multiply`, `screen`, `overlay`, `maximum`, `minimum`, `difference`, `smooth-maximum`, `smooth-minimum`; `strength`, `smoothness` |
| `adjust/height-blend` | Height Blend | `a`, `b` (field), `mask` (optional) → field; second output `weight` (mask) | Lets the higher of two terrains win with a soft transition, as a material height blend does: `contrast`, `offset` |
| `adjust/switch` | Switch | `a` (any), `b`, `c`, `d` (any, optional) → same as `a` | Passes one input through: `mode`: `a`, `b`, `c`, `d`. A choice with nothing connected passes `a`; a choice of the other kind is converted as a connection is (`runtime.md` 5.6). Not maskable |

## 3. `filter`: 14 nodes

All any → same and maskable unless noted.

| Id | Title | What it does; named parameters |
| --- | --- | --- |
| `filter/blur` | Blur | Gaussian blur: `radius` |
| `filter/smart-blur` | Smart Blur | Smooths gentle ground and keeps cliffs and ridges (edge-preserving): `radius`, `threshold` (height). Field only |
| `filter/directional-blur` | Directional Blur | Blurs along one direction: `radius`, `angle` |
| `filter/slope-blur` | Slope Blur | Smears each point downhill along the slope of a guide terrain, giving gullied, eroded-looking streaks: input `guide` (field, optional; default the input itself), `radius`, `strength` |
| `filter/sharpen` | Sharpen | Unsharp mask: `radius`, `strength` |
| `filter/high-pass` | High Pass | Keeps detail smaller than a radius, centred on 0.5: `radius` |
| `filter/median` | Median | Removes spikes and pits: `radius` (bounded to a small window). Field only |
| `filter/grow-shrink` | Grow / Shrink | Morphological dilate, erode, open, close: `mode`: `grow`, `shrink`, `open`, `close`; `radius`. Field only. Keywords: dilate, erode |
| `filter/warp` | Warp | Displaces the picture by a noise or by a guide: input `guide` (field, optional), `distance` (length: how far the picture moves at most), `size`, `seed` |
| `filter/slope-warp` | Slope Warp | Pushes features along the terrain's own slope: `distance` (length), `mode`: `downhill`, `uphill`; `radius` (smoothing of the slope). Field only |
| `filter/transform` | Transform | Moves, rotates and scales: `offset`, `angle`, `zoom`, `edge`: `clamp`, `mirror`, `repeat`, `constant` |
| `filter/flip` | Flip | Mirrors or turns by quarter turns: `mode`: `horizontal`, `vertical`, `both`, `turn-90`, `turn-270`, `transpose`. Not maskable |
| `filter/twirl` | Twirl | Twists around a point: `center`, `radius`, `angle` |
| `filter/edge-fade` | Edge Fade | Fades to a level toward the terrain's borders: `width` (length), `height` (target level), `mode`: `square`, `round`. Field only |

## 4. `simulate`: 10 nodes

Specified in `simulation.md`. Two owners share the category by file; each owns
one private index module that `simulate/index.ts` concatenates:

| Owner | Private index | Nodes | Private modules |
| --- | --- | --- | --- |
| erosion | `_erosion.ts` | `simulate/fluvial-erosion`, `simulate/hydraulic-erosion`, `simulate/thermal-erosion`, `simulate/sediment`, `simulate/snow` | `_refine*.ts`, `_constants.ts`, `_talus*.ts`, `_pipes*.ts`, `_stream*.ts`, `_layers*.ts` and others not beginning with `_route`, `_water` |
| hydrology | `_hydrology.ts` | `simulate/fill`, `simulate/flow`, `simulate/rivers`, `simulate/lakes`, `simulate/sea` | `_route*.ts`, `_water*.ts` |

Two private modules exist from the start, written by the integrator:
`_refine.ts`, the refine module of `simulation.md` section 2 (`levelInput`,
`refineHeight`, `refinePlane`, `levelBudget` and the kernels
`simulate/refine.height` and `simulate/refine.plane`), and `_constants.ts`, the
calibration register of `simulation.md` section 13, which starts with the two
constants the refine module uses. The erosion owner owns both from then on and
adds its rows of the register to `_constants.ts`; the hydrology owner keeps the
rows that only sections 6 to 9 use in a `_route*.ts` or `_water*.ts` module of
its own. `tests/engine/ops/refine.test.ts` and `coarse-to-fine.test.ts` hold
the refine module to what `simulation.md` states of it: a change of its
behaviour is a change of that document first.

The erosion nodes use the routing of `simulation.md` section 6 where it says
so. The hydrology owner delivers the router first and the two agree on its
module interface as `simulation.md` 6 prints it; until it exists the erosion
owner works on thermal and hydraulic erosion, which do not need it.

## 5. `select`: 10 nodes

Input `in` (field, the terrain) unless noted; output `out` (field, role
`mask`) unless noted. Not maskable. Each has `invert`, which gives the
complement of the mask; in `select/peaks` it selects the opposite landform
instead, because the complement of "above its surroundings" is every slope and
plain as well as the valley floors.

| Id | Title | What it selects; named parameters |
| --- | --- | --- |
| `select/height` | Height | A height band: `heightMin`, `heightMax`, `feather` (height) |
| `select/slope` | Slope | A band of physical slope angle: `slopeMin`, `slopeMax`, `feather` (angle), `radius` (smoothing before measuring) |
| `select/curvature` | Curvature | Convex ground (ridges, crests) or concave ground (gullies, hollows): `mode`: `convex`, `concave`, `both`; `radius`, `strength` |
| `select/aspect` | Aspect | Slopes that face a compass direction: `angle`, `spread` (angle), `slopeMin` |
| `select/exposure` | Exposure | Ground lit by a sun at a given direction and elevation, with cast shadows: `angle`, `elevation` (angle), `softness` |
| `select/occlusion` | Occlusion | Sheltered ground: hollows, valley floors, cliff feet (ambient occlusion): `radius`, `strength` |
| `select/peaks` | Peaks | Ground that stands above its surroundings: summits and ridge tops; with `invert`, ground that lies below them: valley floors: `radius`, `feather` (height: how far above its surroundings ground stands before it is fully selected) |
| `select/roughness` | Roughness | Rough ground against smooth: local variation of height: `radius` |
| `select/distance` | Distance | Input `in` (field, role `mask`): distance from the mask's edge, as a soft band: `distance` (length), `mode`: `outside`, `inside`, `both`. Second output `raw` (data, the distance as a length) |
| `select/edge` | Edge | Input `in` (field, role `mask`): a band along the mask's boundary: `width` (length), `feather` |

## 6. `color`: 8 nodes

| Id | Title | Ports | What it does; named parameters |
| --- | --- | --- | --- |
| `color/constant` | Solid Color | → color | One colour: `color` |
| `color/gradient-map` | Gradient Map | `in` (field, role `data`) → color | Colours a field through a gradient: `gradient`, `inMin`, `inMax`. Not maskable (types differ) |
| `color/natural` | Natural Color | `in` (field, the terrain), `flow` (field, data, optional), `snow` (field, mask, optional) → color | A plausible landscape colouring from height, slope, occlusion and, when connected, water flow and snow: `mode`: `alpine`, `temperate`, `desert`, `volcanic`, `arctic`; `variation`, `seed` |
| `color/hue-saturation` | Hue / Saturation | color → color | `hue` (angle shift), `saturation`, `lightness`, `contrast` |
| `color/normal-map` | Normal Map | `in` (field) → color | Tangent-space normals from physical slopes, in the convention Unreal expects (green channel as DirectX): `strength`, `radius` |
| `color/hillshade` | Hillshade | `in` (field), `base` (color, optional) → color | A lit rendering with shadows and occlusion, for overviews and minimaps: `angle`, `elevation`, `strength` |
| `color/pack-channels` | Pack Channels | `r`, `g`, `b`, `a` (field, all optional) → color | Four fields into the channels of one colour field (packed masks) |
| `color/extract-channel` | Extract Channel | `in` (color) → `out` (field, data) | One channel of a colour field, or its luminance: `channel`: `red`, `green`, `blue`, `alpha`, `luminance`. Not maskable (types differ) |

## 7. `surface`: 9 nodes

Input `in` (field), output `out` (field); maskable; all take `seed` unless
noted.

| Id | Title | What it adds; named parameters |
| --- | --- | --- |
| `surface/terraces` | Terraces | Steps the terrain into flat benches with steep risers: `levels`, `sharpness`, `irregularity`, `size` (of the irregularity) |
| `surface/strata` | Strata | Tilted rock layers of varying hardness that stand out on slopes: `thickness` (height), `angle`, `tilt` (angle), `strength`, `warpStrength` |
| `surface/outcrops` | Outcrops | Angular rock faces breaking out of steep ground: `size`, `strength`, `slopeMin`. Second output `coverage` (mask) |
| `surface/stones` | Stones | Scattered stones and boulders: `size`, `density` (ratio), `height`, `slopeMax`. Second output `coverage` (mask) |
| `surface/roughen` | Roughen | Fine multi-scale roughness, stronger on steep ground: `size`, `strength`, `slopeBias` (ratio) |
| `surface/cracks` | Cracks | A network of fissures: dried mud, jointed rock: `size`, `depth` (height), `width` (length) |
| `surface/ripples` | Ripples | Small directional ripples such as wind-blown sand: `size`, `angle`, `height`, `irregularity` |
| `surface/fault` | Faults | Straight fault lines that offset the ground on either side: `count`, `height` (throw), `angle`, `spread` (angle) |
| `surface/scatter` | Scatter | Stamps copies of a second input over the terrain with random place, size and turn: input `stamp` (field), `count`, `sizeMin`, `sizeMax`, `mode`: `add`, `maximum`, `subtract` |

## 8. `io`: 8 nodes

Owned by the export owner (`testing.md` 7.1).

| Id | Title | Ports | Notes |
| --- | --- | --- | --- |
| `io/import-field` | Import Heightmap | → field | A PNG (8 or 16 bit), TIFF, OpenEXR or raw file as heights or a mask: `file`, `channel`, `inMin`, `inMax` (range of file values mapped to 0..1), `fit`: `stretch`, `contain`, `cover`, `filter`: `nearest`, `linear`, `cubic`. Cache key through `externalKey` (`engine.md` 4.12) |
| `io/import-color` | Import Image | → color | A colour image, with the same fitting options; sRGB to linear on input |
| `io/export-landscape`, `io/export-layer`, `io/export-mask`, `io/export-field`, `io/export-color`, `io/export-normal` | | | `export-unreal.md` section 2 |

## 9. Not in the first release

Recorded so their names are not taken for something else: a paint node (brush
strokes as a height or mask source; needs an editing tool in the viewport),
vector layers for rivers, roads and lakes, a layer-stack compositor, colour
advected along flow, a user-shader node, the simulations `simulation.md`
section 11 lists (dunes, glacier, debris, droplets), seamless tiling, and mesh
and point-cloud outputs.
