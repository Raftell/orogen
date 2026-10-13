# Node catalog: the product's nodes for the first release

This document fixes which nodes exist, their type ids, their ports and what
each is for. It does not fix their algorithms or their full parameter lists:
those are the category owner's design, inside the conventions of `engine.md`
section 4 and `testing.md` section 6. Simulation nodes are specified in
`simulation.md` and export nodes in `export-unreal.md`; this catalog only lists
them.

Rules for owners:

- Every node listed for a category ships, with exactly this id, title, ports and flags. Ids and port names are permanent once released.
- A parameter named here is required, under that name, and so is every option listed for an `enum`. Owners add the others a node needs, and name them here once the node is built.
- An owner may add a node that is not listed when the category plainly lacks it. It is listed in the category's section under the heading `### Added by owners`, in a table of the same form; the owner asks for that row with a change request (`testing.md` 7.4), and until it is applied the catalog test fails for the category and names the node. An owner does not drop or merge listed nodes; a node that cannot be done well is reported, with the reason.
- Nodes of `adjust`, `filter`, `surface` and `color` whose `in` and `out` have the same type are `maskable`, unless the mask must act inside the algorithm (`testing.md` 6.5). The Flags column says which are.
- Quality bar: at default parameters each node's gallery picture shows plainly what it does (`testing.md` 6.6), and a generator's default output looks like the landform it is named for when lit in the 3D preview, not like tinted noise.

**The tables are read by a test.** `tests/unit/catalog.test.ts` parses them and
holds every category that has registered nodes to them: each listed node is
registered with the title, the ports and the flags of its row and has every
parameter and option the row names, and no node is registered that no row
lists. The cells are written so:

| Column | Form |
| --- | --- |
| Id | the node type in backticks. A table without the port columns lists nodes another document specifies. With a `Parameters` column it has one node a row, registered and with every parameter and option the row names; without one, several ids in one cell, of which only their being registered is checked |
| Inputs, Outputs | ports in declaration order, separated by `;`: the name in backticks, then the type: `field` (role `height`), `field, mask`, `field, data`, `color`, `any`, or `same as <input>` for an output of the kind of that input (`engine.md` 4.2); then `, optional` for an optional input. Empty: none |
| Parameters | names in backticks, separated by commas, in the order of the inspector; an `enum` is followed by its option values in parentheses. Empty: none |
| Flags | `maskable`, `resolutionDependent` (`engine.md` 4.6), in backticks. Empty: neither |
| Private index, Private modules | in the table of two owners who share a category: the file of the owner's private index, and the file names of the owner's other private modules, each in backticks, with `*` for any run of characters. Every file of the category whose name begins with `_` is one owner's index or matches a name of exactly one owner |

## 1. `generate`: 16 nodes

No required inputs. Two owners share the category by file, as in `simulate`
(section 4); each owns one private index module that `generate/index.ts`
concatenates:

| Owner | Private index | Nodes | Private modules |
| --- | --- | --- | --- |
| basics | `_basics.ts` | `constant`, `gradient`, `radial-gradient`, `shape`, `waves`, `fractal-noise`, `cellular-noise`, `eroded-noise` | `_noise*.ts`, `_shape*.ts` |
| landforms | `_landforms.ts` | `mountain`, `mountain-range`, `island`, `volcano`, `crater`, `crater-field`, `canyon`, `dunes` | `_land.ts`, `_land-*.ts` |

Each owner's WGSL libraries carry its own prefix (`generateNoise…`,
`generateLand…`: a library name has no slash or hyphen, `engine.md` 3.7), so
neither waits for the other; both build on the core noise and hash libraries
of `engine.md` 3.9.

| Id | Title | Inputs | Outputs | Parameters | Flags | What it makes |
| --- | --- | --- | --- | --- | --- | --- |
| `generate/constant` | Constant | | `out` field | `height` | | A flat field at one height |
| `generate/gradient` | Gradient | | `out` field | `mode` (`linear`, `mirrored`, `smooth`), `angle`, `size`, `offset` | | A linear ramp across the terrain; `size` is the length of the ramp |
| `generate/radial-gradient` | Radial Gradient | | `out` field | `mode` (`cone`, `dome`, `bell`, `ring`), `center`, `radius`, `width` | | A radial falloff around a point, or a ring of the given `width` around it |
| `generate/shape` | Shape | | `out` field, mask | `mode` (`ellipse`, `rectangle`, `polygon`), `center`, `extent`, `angle`, `feather`, `count` | | A filled analytic shape with a soft edge. `extent` is a vec2 length, half-width and half-height; `count` the sides of a polygon |
| `generate/waves` | Waves | | `out` field | `mode` (`sine`, `triangle`, `saw`, `square`), `size`, `angle`, `offset`, `warpStrength`, `warpSize` | | Parallel waves: a periodic profile along a direction, `size` its wavelength, straight or bent by a warp |
| `generate/fractal-noise` | Fractal Noise | | `out` field | `mode` (`fbm`, `ridged`, `billow`), `size`, `octaves`, `gain`, `lacunarity`, `warpStrength`, `warpSize`, `seed` | | Fractal gradient noise, the workhorse for base terrain. Keywords: perlin, simplex, fbm |
| `generate/cellular-noise` | Cellular Noise | | `out` field | `mode` (`distance`, `second`, `edge`, `cell`), `size`, `jitter`, `seed` | | Cell patterns from scattered feature points. Keywords: voronoi, worley |
| `generate/eroded-noise` | Eroded Noise | | `out` field | `size`, `erosion`, `octaves`, `gain`, `seed` | | Fractal noise whose fine octaves are suppressed on slopes and valley floors, with gullies that run down the slopes in their place, giving smooth valleys and sharp, rough crests without simulation. The first terrain of every gallery picture (`testing.md` 2.4) |
| `generate/mountain` | Mountain | | `out` field | `center`, `size`, `height`, `sharpness`, `ridges`, `erosion`, `seed` | | One massif: a peak with ridges radiating from it; `size` is its base width |
| `generate/mountain-range` | Mountain Range | | `out` field | `angle`, `size`, `length`, `height`, `count`, `sharpness`, `erosion`, `seed` | | An elongated chain of `count` peaks with spurs; `size` is the width of the range |
| `generate/island` | Island | | `out` field; `water` field, mask | `size`, `coast`, `height`, `erosion`, `seed` | | A landmass with an irregular coast that falls below sea level at the borders, and the mask of its sea. Uses the project's sea level |
| `generate/volcano` | Volcano | | `out` field | `center`, `size`, `height`, `craterSize`, `craterDepth`, `erosion`, `seed` | | A cone with a crater and gullied flanks |
| `generate/crater` | Crater | `in` field, optional | `out` field | `center`, `radius`, `depth`, `rim`, `peak`, `ejecta`, `height`, `flatten`, `seed` | | One impact crater: bowl, raised rim, optional central peak and ejecta, stamped into the terrain at `in`; without it, into level ground at `height`. `flatten` wipes out the terrain inside the rim, down to the slope the crater lies on |
| `generate/crater-field` | Crater Field | `in` field, optional | `out` field | `count`, `radiusMin`, `radiusMax`, `depth`, `height`, `flatten`, `seed` | | Many craters of varied size and age, stamped as `generate/crater` stamps one |
| `generate/canyon` | Canyon | | `out` field | `size`, `depth`, `width`, `branching`, `levels`, `erosion`, `seed` | | A plateau cut by branching, winding canyons; `levels` are the terraces of their walls |
| `generate/dunes` | Dunes | | `out` field | `mode` (`transverse`, `barchan`, `star`), `size`, `angle`, `height`, `irregularity`, `seed` | | A field of wind-shaped dunes with asymmetric profiles; `angle` is where the wind blows to |

## 2. `adjust`: 11 nodes

| Id | Title | Inputs | Outputs | Parameters | Flags | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| `adjust/levels` | Levels | `in` any | `out` same as in | `inMin`, `inMax`, `gamma`, `outMin`, `outMax`, `clamp` | `maskable` | Black point, white point, gamma, output range; `clamp` keeps the result inside that range |
| `adjust/curve` | Curve | `in` any | `out` same as in | `curve` | `maskable` | Remaps values through a curve |
| `adjust/clamp` | Clamp | `in` any | `out` same as in | `min`, `max`, `softness` | `maskable` | Limits values to a range, hard or with a soft knee |
| `adjust/bias-gain` | Bias and Gain | `in` any | `out` same as in | `bias`, `gain` | `maskable` | Pushes values toward one end (`bias`) and toward or away from the middle (`gain`) |
| `adjust/invert` | Invert | `in` any | `out` same as in | `pivot` | `maskable` | Mirrors values around a pivot, 0.5 by default |
| `adjust/autolevel` | Auto Level | `in` field | `out` field | | `maskable`, `resolutionDependent` | Stretches the measured minimum and maximum to 0..1 |
| `adjust/equalize` | Equalize | `in` field | `out` field | `strength` | `maskable`, `resolutionDependent` | Redistributes heights so every height band covers the same area |
| `adjust/math` | Math | `in` field; `b` field, optional | `out` field | `mode` (`add`, `subtract`, `multiply`, `divide`, `power`, `absolute`, `minimum`, `maximum`, `modulo`, `fold`), `value` | | One arithmetic operation with a constant or a second field. Not maskable: it has two inputs of its own meaning |
| `adjust/combine` | Combine | `a` any; `b` any; `mask` field, mask, optional | `out` same as a | `mode` (`mix`, `add`, `subtract`, `multiply`, `screen`, `overlay`, `maximum`, `minimum`, `difference`, `smooth-maximum`, `smooth-minimum`), `strength`, `smoothness` | | Blends two inputs. A `b` of the other kind is converted as a connection is (`runtime.md` 5.6). `smoothness` is shown for the two smooth modes |
| `adjust/height-blend` | Height Blend | `a` field; `b` field; `mask` field, mask, optional | `out` field; `weight` field, mask | `contrast`, `offset` | | Lets the higher of two terrains win with a soft transition, as a material height blend does; `weight` is where the second shows |
| `adjust/switch` | Switch | `a` any; `b` any, optional; `c` any, optional; `d` any, optional | `out` same as a | `mode` (`a`, `b`, `c`, `d`) | | Passes one input through. A choice with nothing connected passes `a`; a choice of the other kind is converted as a connection is (`runtime.md` 5.6) |

## 3. `filter`: 14 nodes

| Id | Title | Inputs | Outputs | Parameters | Flags | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| `filter/blur` | Blur | `in` any | `out` same as in | `radius` | `maskable` | Gaussian blur |
| `filter/smart-blur` | Smart Blur | `in` field | `out` field | `radius`, `threshold` | `maskable` | Smooths gentle ground and keeps cliffs and ridges (edge-preserving); `threshold` is a height |
| `filter/directional-blur` | Directional Blur | `in` any | `out` same as in | `radius`, `angle` | `maskable` | Blurs along one direction |
| `filter/slope-blur` | Slope Blur | `in` any; `guide` field, optional | `out` same as in | `radius`, `strength`, `mode` (`gullies`, `smear`), `guideRadius` | `maskable` | Smears each point downhill along the slope of a guide terrain, giving gullied, eroded-looking streaks. Without a `guide` the input steers itself. `gullies` carves the fine detail down the slope and never raises the ground; `smear` averages along it. `guideRadius` smooths the guide |
| `filter/sharpen` | Sharpen | `in` any | `out` same as in | `radius`, `strength` | `maskable` | Unsharp mask |
| `filter/high-pass` | High Pass | `in` any | `out` same as in | `radius` | `maskable` | Keeps detail smaller than a radius, centred on 0.5 |
| `filter/median` | Median | `in` field | `out` field | `radius` | `maskable` | Removes spikes and pits narrower than `radius` |
| `filter/grow-shrink` | Grow / Shrink | `in` field | `out` field | `mode` (`grow`, `shrink`, `open`, `close`), `radius` | `maskable` | Morphological dilate, erode, open, close. Keywords: dilate, erode |
| `filter/warp` | Warp | `in` any; `guide` field, optional | `out` same as in | `distance`, `size`, `octaves`, `guideRadius`, `seed` | `maskable` | Displaces the picture by a noise, or down the slopes of a guide when one is connected. `distance` is how far the picture moves at most; `size` and `octaves` shape the noise, `guideRadius` smooths the guide |
| `filter/slope-warp` | Slope Warp | `in` field | `out` field | `distance`, `mode` (`downhill`, `uphill`), `radius` | `maskable` | Pushes features along the terrain's own slope by up to `distance`; `radius` smooths the slope |
| `filter/transform` | Transform | `in` any | `out` same as in | `offset`, `angle`, `zoom`, `edge` (`clamp`, `mirror`, `repeat`, `constant`), `height` | `maskable` | Moves, rotates and scales; `edge` says what lies beyond the border, and `height` is the level of `constant` |
| `filter/flip` | Flip | `in` any | `out` same as in | `mode` (`horizontal`, `vertical`, `both`, `turn-90`, `turn-270`, `transpose`) | | Mirrors or turns by quarter turns. Not maskable |
| `filter/twirl` | Twirl | `in` any | `out` same as in | `angle`, `radius`, `center`, `mode` (`clockwise`, `counterclockwise`) | `maskable` | Twists around a point |
| `filter/edge-fade` | Edge Fade | `in` field | `out` field | `width`, `height`, `mode` (`square`, `round`) | `maskable` | Fades to the level `height` toward the terrain's borders, over `width` |

## 4. `simulate`: 10 nodes

Specified in `simulation.md`. Two owners share the category by file; each owns
one private index module that `simulate/index.ts` concatenates:

| Owner | Private index | Nodes | Private modules |
| --- | --- | --- | --- |
| erosion | `_erosion.ts` | `fluvial-erosion`, `hydraulic-erosion`, `thermal-erosion`, `sediment`, `snow` | `_refine*.ts`, `_constants.ts`, `_talus*.ts`, `_layer*.ts`, `_diff.ts` |
| hydrology | `_hydrology.ts` | `fill`, `flow`, `rivers`, `lakes`, `sea` | `_route*.ts`, `_water*.ts` |

The ports, and what each parameter means, are in `simulation.md`; the names
are listed here as the owners built them. Two are beyond the first design of
their node: `removal` of `simulate/hydraulic-erosion`, the share of the eroded
material that leaves the terrain, and `valleyDepth` of `simulate/rivers`, how
deep a river cuts the valley around its channel.

| Id | Parameters | Specified in |
| --- | --- | --- |
| `simulate/fluvial-erosion` | `size`, `duration`, `concavity`, `talus`, `uplift`, `lakeFill`, `detail`, `seed` | `simulation.md` section 3 |
| `simulate/hydraulic-erosion` | `size`, `duration`, `rain`, `capacity`, `downcutting`, `deposition`, `removal`, `talus`, `detail`, `seed` | `simulation.md` section 4 |
| `simulate/thermal-erosion` | `talus`, `size`, `strength`, `removal` | `simulation.md` section 5 |
| `simulate/sediment` | `thickness`, `repose`, `size` | `simulation.md` 5.9 |
| `simulate/snow` | `snowfall`, `snowLine`, `band`, `slipAngle`, `melt`, `exposure`, `angle`, `size` | `simulation.md` section 10 |
| `simulate/fill` | `tilt` | `simulation.md` 6.4 |
| `simulate/flow` | `routing` (`single`, `multiple`), `seed` | `simulation.md` section 7 |
| `simulate/rivers` | `catchment`, `valleyDepth`, `riverWidth`, `riverDepth`, `bank`, `seed` | `simulation.md` section 8 |
| `simulate/lakes` | `minDepth`, `minSize` | `simulation.md` 9.1 |
| `simulate/sea` | `mode` (`connected`, `global`), `strength`, `shoreSize`, `shoreHeight` | `simulation.md` 9.2 |

Two private modules exist from the start, written by the integrator:
`_refine.ts`, the refine module of `simulation.md` section 2 (`levelInput`,
`refineHeight`, `refinePlane`, `levelBudget` and the kernels
`simulate/refine.height` and `simulate/refine.plane`), and `_constants.ts`, the
calibration register of `simulation.md` section 13, which starts with the two
constants the refine module uses. The erosion owner owns both from then on and
adds its rows of the register to `_constants.ts`; the hydrology owner keeps the
rows that only sections 6 to 9 use in `_water-constants.ts`. The other private
modules are `_talus.ts` (the pairwise exchange of thermal erosion), `_layer.ts`
(the mobile layers) and `_diff.ts` (wear and deposit) of the erosion owner, and
`_route.ts` (the router), `_water-course.ts` and `_water-jump.ts` (the courses
of rivers) of the hydrology owner; `simulation.md` 1.1 lists what each holds.
The virtual pipes and the stream-power solver have no module of their own:
their kernels belong to one node each and are in its file.
`tests/engine/ops/refine.test.ts` and `coarse-to-fine.test.ts` hold the refine
module to what `simulation.md` states of it: a change of its behaviour is a
change of that document first.

The erosion nodes use the routing of `simulation.md` section 6 where it says
so. The hydrology owner delivers the router first and the two agree on its
module interface as `simulation.md` 6 prints it; until it exists the erosion
owner works on thermal and hydraulic erosion, which do not need it.

## 5. `select`: 10 nodes

Not maskable. Each has `invert`, which gives the complement of the mask; in
`select/peaks` it selects the opposite landform instead, because the
complement of "above its surroundings" is every slope and plain as well as the
valley floors. The `radius` of `select/slope`, `select/aspect` and
`select/exposure` smooths the terrain before it is measured (`ops.smooth`,
`engine.md` section 5); in the other nodes it is the scale of what is measured.

| Id | Title | Inputs | Outputs | Parameters | Flags | What it selects |
| --- | --- | --- | --- | --- | --- | --- |
| `select/height` | Height | `in` field | `out` field, mask | `heightMin`, `heightMax`, `feather`, `invert` | | A height band; `feather` is a height |
| `select/slope` | Slope | `in` field | `out` field, mask | `slopeMin`, `slopeMax`, `feather`, `radius`, `invert` | | A band of physical slope angle; `feather` is an angle |
| `select/curvature` | Curvature | `in` field | `out` field, mask | `mode` (`convex`, `concave`, `both`), `radius`, `strength`, `invert` | | Convex ground (ridges, crests) or concave ground (gullies, hollows) at the scale of `radius` |
| `select/aspect` | Aspect | `in` field | `out` field, mask | `angle`, `spread`, `slopeMin`, `feather`, `radius`, `invert` | | Slopes that face a compass direction, within `spread` of it and steeper than `slopeMin`; `feather` is an angle above that slope |
| `select/exposure` | Exposure | `in` field | `out` field, mask | `angle`, `elevation`, `softness`, `radius`, `invert` | | Ground lit by a sun at a given direction and elevation, with cast shadows (`ops.shadow`) |
| `select/occlusion` | Occlusion | `in` field | `out` field, mask | `radius`, `strength`, `invert` | | Sheltered ground: hollows, valley floors, cliff feet (ambient occlusion, `ops.occlusion`) |
| `select/peaks` | Peaks | `in` field | `out` field, mask | `radius`, `feather`, `invert` | | Ground that stands above its surroundings: summits and ridge tops; with `invert`, ground that lies below them: valley floors. `feather` is a height: how far above its surroundings ground stands before it is fully selected |
| `select/roughness` | Roughness | `in` field | `out` field, mask | `radius`, `strength`, `invert` | | Rough ground against smooth: local variation of height |
| `select/distance` | Distance | `in` field, mask | `out` field, mask; `raw` field, data | `distance`, `mode` (`outside`, `inside`, `both`), `invert` | | Distance from the mask's edge, as a soft band; `raw` is the distance as a length |
| `select/edge` | Edge | `in` field, mask | `out` field, mask | `width`, `feather`, `invert` | | A band along the mask's boundary |

## 6. `color`: 8 nodes

| Id | Title | Inputs | Outputs | Parameters | Flags | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| `color/constant` | Solid Color | | `out` color | `color` | | One colour |
| `color/gradient-map` | Gradient Map | `in` field, data | `out` color | `gradient`, `inMin`, `inMax` | | Colours a field through a gradient. Not maskable: the types differ |
| `color/natural` | Natural Color | `in` field; `flow` field, data, optional; `snow` field, mask, optional | `out` color | `mode` (`alpine`, `temperate`, `desert`, `volcanic`, `arctic`), `variation`, `seed` | | A plausible landscape colouring from height, slope, occlusion (`ops.occlusion`) and, when connected, water flow and snow. `flow` is a drainage area as a share of the terrain (`simulate/flow`); an unconnected `snow` is no snow. Uses the project's sea level: ground below it is coloured as seabed, with a beach above it, and the height zones start at it; a sea level of 0 is a project without a sea |
| `color/hue-saturation` | Hue / Saturation | `in` color | `out` color | `hue`, `saturation`, `lightness`, `contrast` | `maskable` | `hue` is an angle shift |
| `color/normal-map` | Normal Map | `in` field | `out` color | `strength`, `radius` | | Tangent-space normals from physical slopes, in the convention Unreal expects (green channel as DirectX); `radius` smooths the terrain first (`ops.smooth`). Each component is stored as `n · 0.5 + 0.5`, as `export-unreal.md` 5.9 maps it, and `strength` scales the slopes: 0 is a level map |
| `color/hillshade` | Hillshade | `in` field; `base` color, optional | `out` color | `angle`, `elevation`, `strength` | | A lit rendering with shadows and occlusion (`ops.shadow`, `ops.occlusion`), for overviews and minimaps |
| `color/pack-channels` | Pack Channels | `r` field, optional; `g` field, optional; `b` field, optional; `a` field, optional | `out` color | | | Four fields into the channels of one colour field (packed masks). An unconnected channel is 0 and an unconnected alpha 1; the alpha is the fourth field, so the node opts out of the `alpha` check (`testing.md` 3.6) |
| `color/extract-channel` | Extract Channel | `in` color | `out` field, data | `channel` (`red`, `green`, `blue`, `alpha`, `luminance`) | | One channel of a colour field, or its luminance (`convert_luma`, `engine.md` 3.9). Not maskable: the types differ |

## 7. `surface`: 9 nodes

| Id | Title | Inputs | Outputs | Parameters | Flags | What it adds |
| --- | --- | --- | --- | --- | --- | --- |
| `surface/terraces` | Terraces | `in` field | `out` field | `levels`, `sharpness`, `irregularity`, `size`, `radius`, `seed` | `maskable` | Steps the terrain into flat benches with steep risers; `size` is that of the irregularity, and features of the terrain smaller than `radius` do not shape the edges of the benches |
| `surface/strata` | Strata | `in` field | `out` field | `thickness`, `angle`, `tilt`, `strength`, `slopeMin`, `warpStrength`, `warpSize`, `radius`, `seed` | `maskable` | Tilted rock layers of varying hardness that stand out on slopes; `thickness` is a height, `tilt` an angle. The layers show on ground steeper than `slopeMin`; `warpSize` is the width of the folds `warpStrength` gives them, and features of the terrain smaller than `radius` do not shape their edges |
| `surface/outcrops` | Outcrops | `in` field | `out` field; `coverage` field, mask | `size`, `strength`, `slopeMin`, `seed` | `maskable` | Angular rock faces breaking out of steep ground |
| `surface/stones` | Stones | `in` field | `out` field; `coverage` field, mask | `size`, `density`, `height`, `slopeMax`, `seed` | `maskable` | Scattered stones and boulders; `density` is a ratio |
| `surface/roughen` | Roughen | `in` field | `out` field | `size`, `strength`, `slopeBias`, `seed` | `maskable` | Fine multi-scale roughness, stronger on steep ground; `slopeBias` is a ratio |
| `surface/cracks` | Cracks | `in` field | `out` field | `size`, `depth`, `width`, `seed` | `maskable` | A network of fissures: dried mud, jointed rock; `depth` is a height, `width` a length |
| `surface/ripples` | Ripples | `in` field | `out` field | `size`, `angle`, `height`, `irregularity`, `slopeMax`, `seed` | `maskable` | Small directional ripples such as wind-blown sand, on ground no steeper than `slopeMax` |
| `surface/fault` | Faults | `in` field | `out` field | `count`, `height`, `angle`, `spread`, `reach`, `seed` | `maskable` | Straight fault lines that offset the ground on either side; `height` is the throw, `spread` an angle, and `reach` how far from a fault the ground is moved |
| `surface/scatter` | Scatter | `in` field; `stamp` field | `out` field | `count`, `sizeMin`, `sizeMax`, `mode` (`add`, `maximum`, `subtract`), `seed` | `maskable` | Stamps copies of a second input over the terrain with random place, size and turn |

## 8. `io`: 8 nodes

Owned by the export owner (`testing.md` 7.1).

| Id | Title | Inputs | Outputs | Parameters | Flags | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| `io/import-field` | Import Heightmap | | `out` field | `file`, `channel` (`red`, `green`, `blue`, `alpha`, `luma`), `inMin`, `inMax`, `fit` (`stretch`, `contain`, `cover`), `filter` (`nearest`, `linear`, `cubic`) | | A PNG (8 or 16 bit), TIFF, OpenEXR or raw file as heights or a mask; `inMin` and `inMax` are the range of file values mapped to 0..1, without clamping. A raw file is told by its extension (`.r16` and `.raw` 16 bits, `.r8` 8 bits, `.r32` floats) and is square. `fit` places an image that is not square: stretched, whole in the middle of level ground at height 0, or cut to its middle square. `filter` reads an image coarser than the grid; a finer one is averaged, except with `nearest`. Cache key through the default `externalKey` of a `file` parameter (`engine.md` 4.12) |
| `io/import-color` | Import Image | | `out` color | `file`, `fit` (`stretch`, `contain`, `cover`), `filter` (`nearest`, `linear`, `cubic`) | | A colour image (PNG, TIFF, OpenEXR), with the same fitting options; sRGB to linear on input for whole-number samples, while an OpenEXR file and a float TIFF hold linear values and are taken as they are. The output is opaque: a file's alpha is not kept, and `contain` sets the image on black |

| Id | Parameters | Specified in |
| --- | --- | --- |
| `io/export-landscape` | `enabled`, `name`, `rangeMode` (`measured`, `fixed`), `headroom`, `heightMin`, `heightMax`, `dither`, `zeroAt` (`seaLevel`, `bottom`), `origin` (`center`, `corner`), `baseLayer`, `layerBlend` (`advanced`, `final`), `layerFloor`, `layerLimit`, `partition`, `gridComponents`, `regionComponents` | `export-unreal.md` 2.4 |
| `io/export-layer` | `enabled`, `layer`, `weightBlended` | `export-unreal.md` 2.4 |
| `io/export-mask` | `enabled`, `name`, `dimension` (`auto`, `1024`, `2048`, `4096`, `8192`), `bits` (`8`, `16`) | `export-unreal.md` 2.4 |
| `io/export-field` | `enabled`, `name`, `format` (`png8`, `png16`, `r16`, `r32`, `exr`, `tiff16`, `tiff32`), `rangeMode` (`unit`, `measured`) | `export-unreal.md` 2.4 |
| `io/export-color` | `enabled`, `name`, `dimension` (`auto`, `1024`, `2048`, `4096`, `8192`), `content` (`color`, `data`) | `export-unreal.md` 2.4 |
| `io/export-normal` | `enabled`, `name`, `dimension` (`auto`, `1024`, `2048`, `4096`, `8192`) | `export-unreal.md` 2.4 |

## 9. Not in the first release

Recorded so their names are not taken for something else: a paint node (brush
strokes as a height or mask source; needs an editing tool in the viewport),
vector layers for rivers, roads and lakes, a layer-stack compositor, colour
advected along flow, a user-shader node, the simulations `simulation.md`
section 11 lists (dunes, glacier, debris, droplets), seamless tiling, and mesh
and point-cloud outputs.
