# Node reference

This page is generated from the node registry by `tools/node-reference.ts`. Do not edit it by hand: change the
node, then run `tools/guard node tools/node-reference.ts` (on Windows `node tools/guard.mjs node
tools/node-reference.ts`). It lists the nodes this checkout of Orogen registers.

96 nodes are registered: 86 nodes of the product, which the Library panel and the add-node palette of
the desktop application offer and the command-line program takes, and 10 reference nodes, which the
command-line program takes as well and the application offers nowhere (the last section says what they are for).

## How to read an entry

- The line under the title is the node's type, the name a project file stores and `orogen render` takes.
- **Ports.** A *terrain* is a field of heights, a *mask* a field of values from 0 (unaffected) to 1 (fully
  affected), *data* a field with a meaning of its own that the node states, and a *colour map* a colour per
  point. A field output connects to any field input, and a field connects to a colour input and back: the
  engine converts.
- **Name** is the name of a parameter in a project file and on the command line (`--param name=value`).
- **Unit** says what a stored number means (see [Concepts](concepts.md#units-the-unit-box)):

  | Unit | A stored value of 1 means |
  | --- | --- |
  | length | the whole width of the terrain: 0.25 is a quarter of it |
  | height | the whole height range of the project: 0.5 is half of it |
  | angle | one degree. Directions run from 0 to 360, slopes from 0 to 90 |
  | ratio | all of it: an amount, strength or share from 0 to 1 |
  | (none) | a plain number |

- **Range.** A value outside the range is brought back into it. Where the range is that of the slider only,
  a typed value may lie outside it.

## Contents

- [Generate](#generate) (16)
- [Adjust](#adjust) (11)
- [Filter](#filter) (14)
- [Simulate](#simulate) (10)
- [Select](#select) (10)
- [Color](#color) (8)
- [Surface](#surface) (9)
- [Import and export](#io) (8)
- [Reference nodes](#ref) (10)

<a id="generate"></a>

## Generate

Nodes that need no input and make a terrain or a mask: noises, gradients, shapes and whole landforms.

[Canyon](#generate-canyon) · [Cellular Noise](#generate-cellular-noise) · [Constant](#generate-constant) · [Crater](#generate-crater) · [Crater Field](#generate-crater-field) · [Dunes](#generate-dunes) · [Eroded Noise](#generate-eroded-noise) · [Fractal Noise](#generate-fractal-noise) · [Gradient](#generate-gradient) · [Island](#generate-island) · [Mountain](#generate-mountain) · [Mountain Range](#generate-mountain-range) · [Radial Gradient](#generate-radial-gradient) · [Shape](#generate-shape) · [Volcano](#generate-volcano) · [Waves](#generate-waves)

### Canyon

<a id="generate-canyon"></a>`generate/canyon`

Generates a plateau cut by winding canyons that branch upstream, with flat floors and walls of cliffs and benches.

Also found by: gorge, ravine, mesa, plateau, badlands, drainage.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Spacing | `size` | number | length | 0.2 | 0.1 to 1 on the slider; any number can be typed | Larger values set the canyons further apart and make their bends broader. |
| Depth | `depth` | number | height | 0.55 | 0 to 1 on the slider; any number can be typed | Larger values cut the main canyon deeper below the plateau. |
| Width | `width` | number | length | 0.2 | 0.01 to 0.5 on the slider; any number can be typed | Larger values widen the main canyon from rim to rim; side canyons are narrower, and narrowest at their heads. |
| Branching | `branching` | number | ratio | 0.6 | 0 to 1 | Larger values let smaller side canyons cut back into the plateau; 0 leaves the main canyon alone. |
| Terraces | `levels` | whole number |  | 4 | 1 to 16 | How many beds of rock the walls of the main canyon step down through, each a cliff above a bench. |
| Erosion | `erosion` | number | ratio | 0.6 | 0 to 1 | Larger values cut deeper side gullies into the walls, which scallop the cliffs and benches. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Cellular Noise

<a id="generate-cellular-noise"></a>`generate/cellular-noise`

Generates a pattern of cells around scattered points: pits, mounds, a web of walls or flat plates.

Also found by: voronoi, worley, cells, cracks, honeycomb, scales, crystal, mosaic, noise.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Distance | Distance (`distance`), Second distance (`second`), Edge distance (`edge`), Cell value (`cell`) | Height by the distance to the nearest point, to the second nearest, or to the wall of the cell, or one random height per cell. |
| Feature size | `size` | number | length | 0.125 | 0.001 to 4 on the slider; any number can be typed | Larger values give larger cells. |
| Jitter | `jitter` | number | ratio | 1 | 0 to 1 | Larger values scatter the points more freely. Without jitter the cells are a honeycomb. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Constant

<a id="generate-constant"></a>`generate/constant`

Generates a flat terrain at one height.

Also found by: flat, plane, level, fill, uniform, solid.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Height | `height` | number | height | 0.5 | 0 to 1 on the slider; any number can be typed | Larger values raise the whole terrain. |

### Crater

<a id="generate-crater"></a>`generate/crater`

Stamps one impact crater into the terrain: a bowl with a raised rim, terraced walls, a central peak and a blanket of ejecta.

Also found by: impact, meteor, bowl, rim, ejecta, moon.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | optional |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Center | `center` | two numbers | length | 0.5, 0.5 | each 0 to 1 on the slider; any number can be typed | Where the impact struck. |
| Radius | `radius` | number | length | 0.25 | 0.005 to 1 on the slider; any number can be typed | Larger values widen the crater; the rim lies this far from the center. |
| Depth | `depth` | number | height | 0.2 | 0 to 1 on the slider; any number can be typed | Larger values sink the floor further below the ground the impact struck. |
| Rim height | `rim` | number | height | 0.07 | 0 to 0.25 on the slider; any number can be typed | Larger values raise the rim further above the ground around the crater. |
| Central peak | `peak` | number | ratio | 0.4 | 0 to 1 | Larger values raise a taller peak in the middle, flatten the floor around it and step the walls, as in large craters; 0 leaves a plain bowl. |
| Ejecta | `ejecta` | number | ratio | 0.5 | 0 to 1 | Larger values throw rougher streaks and hummocks of debris out around the rim. |
| Ground level | `height` | number | height | 0.5 | 0 to 1 on the slider; any number can be typed | The height of the level ground the crater is cut into when no terrain is connected. |
| Flatten | `flatten` | number | ratio | 1 | 0 to 1 | Larger values wipe out more of a connected terrain inside the rim, down to the slope the crater lies on; 0 only adds the crater to it. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Crater Field

<a id="generate-crater-field"></a>`generate/crater-field`

Stamps many impact craters of varied size and age into the terrain, the younger ones over the older.

Also found by: impact, meteor, moon, lunar, bombardment, craters.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | optional |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Craters | `count` | whole number |  | 160 | 1 to 512 | How many impacts struck the terrain. |
| Smallest radius | `radiusMin` | number | length | 0.015 | 0.002 to 0.5 on the slider; any number can be typed | The radius of the smallest craters, which are the most numerous. |
| Largest radius | `radiusMax` | number | length | 0.18 | 0.002 to 0.5 on the slider; any number can be typed | The radius of the largest craters, which are rare. |
| Depth | `depth` | number | height | 0.18 | 0 to 1 on the slider; any number can be typed | Larger values deepen every crater; this is the depth of a fresh crater of the largest radius. |
| Ground level | `height` | number | height | 0.5 | 0 to 1 on the slider; any number can be typed | The height of the level ground the craters are cut into when no terrain is connected. |
| Flatten | `flatten` | number | ratio | 1 | 0 to 1 | Larger values wipe out more of a connected terrain inside each rim, down to the slope the crater lies on; 0 only adds the craters to it. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Dunes

<a id="generate-dunes"></a>`generate/dunes`

Generates a field of wind-shaped dunes with gentle windward slopes and steep slip faces.

Also found by: sand, desert, barchan, erg, wind, ripples.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Dune type | `mode` | choice |  | Transverse ridges | Transverse ridges (`transverse`), Barchans (`barchan`), Star dunes (`star`) | Long ridges across the wind, separate crescents with horns downwind, or pyramids with arms. |
| Dune spacing | `size` | number | length | 0.11 | 0.01 to 1 on the slider; any number can be typed | Larger values set the dunes further apart and make each one broader. |
| Wind direction | `angle` | number | angle | 20 | 0 to 360 | The direction the wind blows to: slip faces look that way. |
| Height | `height` | number | height | 0.07 | 0 to 0.25 on the slider; any number can be typed | Larger values pile the dunes higher, which also steepens their faces. |
| Irregularity | `irregularity` | number | ratio | 0.5 | 0 to 1 | Larger values bend the crests, vary the dunes in size and break their ranks; 0 gives a perfectly regular field. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Eroded Noise

<a id="generate-eroded-noise"></a>`generate/eroded-noise`

Generates mountains as erosion leaves them: gullies running down the slopes, sharp crests and smooth valley floors.

Also found by: erosion, mountains, ridges, valleys, gullies, alpine, fbm, noise.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Feature size | `size` | number | length | 0.25 | 0.001 to 4 on the slider; any number can be typed | Larger values give broader features. |
| Erosion | `erosion` | number | ratio | 1 | 0 to 1 | Larger values cut deeper gullies into the slopes and clear more of the valley floors. At 0 the result is plain fractal noise. |
| Octaves | `octaves` | whole number |  | 8 | 1 to 16 | The first two layers shape the mountains. Each further one adds finer gullies and finer detail on the crests. |
| Roughness | `gain` | number | ratio | 0.5 | 0 to 1 | Larger values make the fine gullies and the detail on the crests stronger. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Fractal Noise

<a id="generate-fractal-noise"></a>`generate/fractal-noise`

Generates rolling, ridged or billowing terrain from layers of noise, each finer than the one before.

Also found by: perlin, simplex, fbm, noise, ridged, billow, turbulence, multifractal, warp, hills.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Rolling | Rolling (`fbm`), Ridged (`ridged`), Billow (`billow`) | Rolling gives hills and hollows alike, Ridged sharp crests over smooth valley floors, Billow round hills over sharp creases. |
| Feature size | `size` | number | length | 0.25 | 0.001 to 4 on the slider; any number can be typed | Larger values give broader features. |
| Octaves | `octaves` | whole number |  | 8 | 1 to 16 | Larger values add finer layers of detail. |
| Roughness | `gain` | number | ratio | 0.5 | 0 to 1 | Larger values keep more of the fine detail and give a rougher surface. |
| Lacunarity | `lacunarity` | number |  | 2 | 1.5 to 4 | How much finer each layer is than the one before. Larger values leave wider gaps between the sizes of the features. |
| Warp | `warpStrength` | number | ratio | 0 | 0 to 1 | Larger values bend and swirl the features further out of shape. Section Warp. |
| Warp size | `warpSize` | number | length | 0.5 | 0.001 to 4 on the slider; any number can be typed | Larger values bend the features in broader curves and move them further. Section Warp. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Gradient

<a id="generate-gradient"></a>`generate/gradient`

Generates a straight ramp that rises across the terrain in one direction.

Also found by: ramp, linear, slope, tilt, incline, falloff.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Linear | Linear (`linear`), Mirrored (`mirrored`), Smooth (`smooth`) | Linear rises evenly, Mirrored rises to the middle of the ramp and falls again, Smooth eases in and out. |
| Direction | `angle` | number | angle | 0 | 0 to 360 | The direction in which the ramp rises. Larger values turn it clockwise in the top view. |
| Length | `size` | number | length | 1 | 0.001 to 4 on the slider; any number can be typed | Larger values stretch the ramp over a longer distance. |
| Offset | `offset` | two numbers | length | 0, 0 | each -1 to 1 on the slider; any number can be typed | Moves the ramp away from the center of the terrain. |

### Island

<a id="generate-island"></a>`generate/island`

Generates an island of ridges, valleys and lowland behind a shore of bays and headlands at sea level, and marks the sea.

Also found by: coast, shore, archipelago, atoll, landmass, sea.

- Reads the project's sea level.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |
| Output | `water` | Water | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Island width | `size` | number | length | 0.7 | 0.05 to 2 on the slider; any number can be typed | Larger values spread the land over more of the terrain; the borders stay under water. |
| Coast irregularity | `coast` | number | ratio | 0.45 | 0 to 1 | Larger values cut deeper bays, push out longer headlands and break off small islands; 0 gives a round island. |
| Height | `height` | number | height | 0.65 | 0 to 1 on the slider; any number can be typed | Larger values raise the high ground further above sea level. |
| Erosion | `erosion` | number | ratio | 0.6 | 0 to 1 | Larger values cut deeper gullies from the ridges down to the shore. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Mountain

<a id="generate-mountain"></a>`generate/mountain`

Generates one massif: a summit with ridges and spurs that fall away into gullied valleys.

Also found by: peak, massif, summit, alpine, ridge.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Center | `center` | two numbers | length | 0.5, 0.5 | each 0 to 1 on the slider; any number can be typed | Where the summit stands on the terrain. |
| Base width | `size` | number | length | 0.9 | 0.05 to 2 on the slider; any number can be typed | Larger values spread the massif over more of the terrain. |
| Height | `height` | number | height | 0.9 | 0 to 1 on the slider; any number can be typed | Larger values raise the summit. |
| Sharpness | `sharpness` | number | ratio | 0.5 | 0 to 1 | Larger values give a pointed summit and knife-edged crests; smaller ones a rounded, worn massif. |
| Ridges | `ridges` | number | ratio | 0.5 | 0 to 1 | Larger values make the ridges stand higher above the valleys between them. |
| Erosion | `erosion` | number | ratio | 0.6 | 0 to 1 | Larger values cut deeper gullies into the flanks. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Mountain Range

<a id="generate-mountain-range"></a>`generate/mountain-range`

Generates an elongated chain of peaks along one crest, with spurs that fall away to both sides.

Also found by: chain, cordillera, sierra, ridge, alpine, peaks.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Direction | `angle` | number | angle | 0 | 0 to 360 | The direction the crest of the range runs in. |
| Width | `size` | number | length | 0.55 | 0.05 to 2 on the slider; any number can be typed | Larger values make the range wider, from foot to foot. |
| Length | `length` | number | length | 1.3 | 0.1 to 4 on the slider; any number can be typed | Larger values make the chain longer; a range longer than the terrain runs off both borders. |
| Height | `height` | number | height | 0.75 | 0 to 1 on the slider; any number can be typed | Larger values raise the highest peak. |
| Peaks | `count` | whole number |  | 6 | 1 to 12 | How many peaks stand along the crest. |
| Sharpness | `sharpness` | number | ratio | 0.5 | 0 to 1 | Larger values give pointed peaks and knife-edged crests; smaller ones a rounded, worn range. |
| Erosion | `erosion` | number | ratio | 0.6 | 0 to 1 | Larger values cut deeper gullies into the flanks. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Radial Gradient

<a id="generate-radial-gradient"></a>`generate/radial-gradient`

Generates a round hill that falls from a center point to its radius, or a ring around that point.

Also found by: cone, dome, bell, ring, circle, falloff, hill, radial.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Cone | Cone (`cone`), Dome (`dome`), Bell (`bell`), Ring (`ring`) | The profile from the center outwards: a straight cone, a half sphere, a bell that eases in and out, or a ring. |
| Center | `center` | two numbers | length | 0.5, 0.5 | each 0 to 1 on the slider; any number can be typed | Where the middle of the shape lies on the terrain. |
| Radius | `radius` | number | length | 0.5 | 0.001 to 2 on the slider; any number can be typed | Larger values make the shape reach further from its center. |
| Ring width | `width` | number | length | 0.2 | 0.001 to 1 on the slider; any number can be typed | Larger values make the ring broader, inwards from the radius. Shown while Mode is Ring. |

### Shape

<a id="generate-shape"></a>`generate/shape`

Generates the mask of an ellipse, a rectangle or a regular polygon with a soft edge.

Also found by: ellipse, circle, rectangle, square, box, polygon, hexagon, triangle, disc, mask.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Ellipse | Ellipse (`ellipse`), Rectangle (`rectangle`), Polygon (`polygon`) | The outline that is filled. A polygon has its first corner at the top and fits the ellipse of the same extent. |
| Center | `center` | two numbers | length | 0.5, 0.5 | each 0 to 1 on the slider; any number can be typed | Where the middle of the shape lies on the terrain. |
| Extent | `extent` | two numbers | length | 0.3, 0.2 | each 0 to 1 on the slider; any number can be typed | Half the width and half the height of the shape. Larger values make it bigger. |
| Angle | `angle` | number | angle | 0 | 0 to 360 | Larger values turn the shape clockwise in the top view. |
| Feather | `feather` | number | length | 0.02 | 0.001 to 0.5 on the slider; any number can be typed | Larger values fade the edge over a wider band, centered on the outline. |
| Sides | `count` | whole number |  | 6 | 3 to 16 | Larger values give the polygon more corners. Shown while Mode is Polygon. |

### Volcano

<a id="generate-volcano"></a>`generate/volcano`

Generates a volcanic cone with a summit crater and gullies that run down its flanks.

Also found by: cone, crater, stratovolcano, caldera, cinder cone.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Center | `center` | two numbers | length | 0.5, 0.5 | each 0 to 1 on the slider; any number can be typed | Where the crater lies on the terrain. |
| Base width | `size` | number | length | 0.9 | 0.05 to 2 on the slider; any number can be typed | Larger values spread the cone over more of the terrain. |
| Height | `height` | number | height | 0.8 | 0 to 1 on the slider; any number can be typed | Larger values raise the rim of the crater. |
| Crater width | `craterSize` | number | length | 0.16 | 0.005 to 1 on the slider; any number can be typed | Larger values open a wider crater, up to a caldera that takes most of the cone. |
| Crater depth | `craterDepth` | number | height | 0.16 | 0 to 1 on the slider; any number can be typed | Larger values sink the crater floor further below the rim. |
| Erosion | `erosion` | number | ratio | 0.6 | 0 to 1 | Larger values cut deeper gullies into the flanks. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Waves

<a id="generate-waves"></a>`generate/waves`

Generates parallel waves that repeat one profile along a direction, straight or bent by a warp.

Also found by: sine, stripes, ripples, bands, periodic, sawtooth, triangle, square, furrows.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Sine | Sine (`sine`), Triangle (`triangle`), Saw (`saw`), Square (`square`) | The profile of one wave: a smooth sine, straight flanks, a ramp with a cliff, or flat steps. |
| Wavelength | `size` | number | length | 0.25 | 0.001 to 4 on the slider; any number can be typed | Larger values put the crests further apart. |
| Direction | `angle` | number | angle | 0 | 0 to 360 | The direction across the crests. Larger values turn the waves clockwise in the top view. |
| Offset | `offset` | two numbers | length | 0, 0 | each -1 to 1 on the slider; any number can be typed | Moves the waves, and the pattern that warps them, across the terrain. |
| Warp | `warpStrength` | number | ratio | 0 | 0 to 1 | Larger values bend the crests further out of line. Section Warp. |
| Warp size | `warpSize` | number | length | 0.5 | 0.001 to 4 on the slider; any number can be typed | Larger values bend the crests in broader curves and move them further. Section Warp. |

<a id="adjust"></a>

## Adjust

Changes to single values and combinations of two inputs: levels, curves, clamping, arithmetic and blends.

[Auto Level](#adjust-autolevel) · [Bias and Gain](#adjust-bias-gain) · [Clamp](#adjust-clamp) · [Combine](#adjust-combine) · [Curve](#adjust-curve) · [Equalize](#adjust-equalize) · [Height Blend](#adjust-height-blend) · [Invert](#adjust-invert) · [Levels](#adjust-levels) · [Math](#adjust-math) · [Switch](#adjust-switch)

### Auto Level

<a id="adjust-autolevel"></a>`adjust/autolevel`

Stretches a terrain so that its lowest point is at 0 and its highest at 1, whatever range it had.

Also found by: normalize, levels, stretch, range, fit, full range.

- Maskable: connect a mask to limit where the node acts.
- Its result depends on measurements of the whole field, so a preview and the build can differ slightly.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

No parameters.

### Bias and Gain

<a id="adjust-bias-gain"></a>`adjust/bias-gain`

Pushes the values between 0 and 1 toward one end of that range, and toward or away from its middle.

Also found by: schlick, midtones, contrast, gamma, shape, remap.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Bias | `bias` | number | ratio | 0.25 | 0 to 1 | The level a value of one half is moved to. Larger values lift the ground toward the top; smaller values press it toward the bottom and leave sharp peaks. |
| Gain | `gain` | number | ratio | 0.5 | 0 to 1 | Larger values push values away from the middle, toward the two ends; smaller values gather them around the middle. One half changes nothing. |

### Clamp

<a id="adjust-clamp"></a>`adjust/clamp`

Limits values to a range, with a hard edge or a soft knee where they reach the limit.

Also found by: limit, clip, saturate, range, plateau, soft clip.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Minimum | `min` | number | height | 0.35 | 0 to 1 on the slider; any number can be typed | Nothing in the result lies below this level. Larger values fill more of the low ground to a flat floor. |
| Maximum | `max` | number | height | 0.65 | 0 to 1 on the slider; any number can be typed | Nothing in the result lies above this level. Smaller values cut more of the high ground to a flat top. |
| Softness | `softness` | number | ratio | 0.25 | 0 to 1 | Larger values round the edge of the floor and of the top over a wider band of heights. At 0 the edge is a crease. |

### Combine

<a id="adjust-combine"></a>`adjust/combine`

Blends two terrains or two color maps by mixing, adding, multiplying, or taking the higher or the lower with a hard or a smooth seam.

Also found by: blend, mix, merge, composite, layer, average, union, smooth max, smooth min.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `a` | A | a field or a colour map | required |
| Input | `b` | B | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional |
| Output | `out` | Out | the kind connected to `a` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Mix | Mix (`mix`), Add (`add`), Subtract (`subtract`), Multiply (`multiply`), Screen (`screen`), Overlay (`overlay`), Maximum (`maximum`), Minimum (`minimum`), Difference (`difference`), Smooth maximum (`smooth-maximum`), Smooth minimum (`smooth-minimum`) | How the second input is combined with the first. Mix replaces the first by the second; the others compute with both. |
| Strength | `strength` | number | ratio | 0.5 | 0 to 1 | How much of the combination replaces the first input. Larger values show more of it; a mask scales it from place to place. |
| Smoothness | `smoothness` | number | height | 0.1 | 0 to 1 on the slider; any number can be typed | Larger values round the seam where the two inputs cross over a taller band. At 0 the seam is a crease. Shown while Mode is Smooth maximum or Smooth minimum. |

### Curve

<a id="adjust-curve"></a>`adjust/curve`

Remaps values through a curve, which reshapes the profile of a terrain: flat valley floors, steeper flanks, rounded tops.

Also found by: remap, profile, tone, spline, transfer, contrast.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Curve | `curve` | curve |  | (0, 0) (0.3, 0.06) (0.7, 0.94) (1, 1) | points with x and y in 0 to 1 | The new value for every value, from 0 on the left to 1 on the right. Values outside that range take the value of the nearer end of the curve. |

### Equalize

<a id="adjust-equalize"></a>`adjust/equalize`

Redistributes heights between the lowest and the highest point so that every band of height covers the same area of the terrain.

Also found by: histogram, flatten, distribution, contrast, hypsometry, rank.

- Maskable: connect a mask to limit where the node acts.
- Its result depends on measurements of the whole field, so a preview and the build can differ slightly.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | Larger values move every height further toward its place in an even distribution; at 0 the terrain is left as it is. |

### Height Blend

<a id="adjust-height-blend"></a>`adjust/height-blend`

Merges two terrains so that the higher one wins, with a soft transition where they cross, and outputs where the second one shows.

Also found by: height lerp, material blend, merge, union, layer, max.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `a` | A | a terrain (heights) | required |
| Input | `b` | B | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional |
| Output | `out` | Out | a terrain (heights) | |
| Output | `weight` | Weight | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Contrast | `contrast` | number | ratio | 0.8 | 0 to 1 | Larger values narrow the band of heights in which the two terrains blend. At the top of the slider the higher terrain wins outright. |
| Offset | `offset` | number | height | 0 | -1 to 1 on the slider; any number can be typed | Raises the second terrain before the two are compared. Larger values let more of it show; negative values sink it below the first. |

### Invert

<a id="adjust-invert"></a>`adjust/invert`

Mirrors values around a pivot level, so that peaks become pits and valleys become ridges.

Also found by: negate, flip, negative, mirror, upside down.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Pivot | `pivot` | number | height | 0.5 | 0 to 1 on the slider; any number can be typed | The level that stays where it is. Larger values raise the whole mirrored result. |

### Levels

<a id="adjust-levels"></a>`adjust/levels`

Stretches the values between a black point and a white point onto an output range, with a gamma for the values between.

Also found by: contrast, remap, range, gamma, black point, white point, brightness.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Black point | `inMin` | number | height | 0.25 | 0 to 1 on the slider; any number can be typed | Values at this level become the output minimum. Larger values turn more of the low ground into a flat floor. |
| White point | `inMax` | number | height | 0.75 | 0 to 1 on the slider; any number can be typed | Values at this level become the output maximum. Smaller values turn more of the high ground into a flat top. |
| Gamma | `gamma` | number |  | 1 | 0.1 to 10 | Larger values lift what lies between the two points; smaller values press it down. |
| Output minimum | `outMin` | number | height | 0 | 0 to 1 on the slider; any number can be typed | The level the black point is moved to. Larger values raise the low end of the result. |
| Output maximum | `outMax` | number | height | 1 | 0 to 1 on the slider; any number can be typed | The level the white point is moved to. Smaller values lower the high end of the result. |
| Clamp | `clamp` | switch |  | on |  | Keeps the result within the output range. When off, values beyond the two points continue in a straight line. |

### Math

<a id="adjust-math"></a>`adjust/math`

Applies one arithmetic operation to every height, with a constant or with a second terrain as the other operand.

Also found by: arithmetic, add, multiply, scale, offset, power, modulo, abs, ping-pong.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `b` | Operand | a terrain (heights) | optional |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Operation | `mode` | choice |  | Multiply | Add (`add`), Subtract (`subtract`), Multiply (`multiply`), Divide (`divide`), Power (`power`), Absolute difference (`absolute`), Minimum (`minimum`), Maximum (`maximum`), Modulo (`modulo`), Fold (`fold`) | What is done with each height and the operand. Dividing by 0 gives 0, a power keeps the sign of a negative height, and Fold bounces heights between 0 and the operand. |
| Value | `value` | number |  | 0.5 | -2 to 2 on the slider; any number can be typed | The operand where no second input is connected: what is added, the factor, the divisor, the exponent or the level compared with. |

### Switch

<a id="adjust-switch"></a>`adjust/switch`

Passes one of up to four inputs through unchanged, so that variants of a terrain can be compared by flipping one setting.

Also found by: select, choose, toggle, variant, route, compare.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `a` | A | a field or a colour map | required |
| Input | `b` | B | a field or a colour map | optional |
| Input | `c` | C | a field or a colour map | optional |
| Input | `d` | D | a field or a colour map | optional |
| Output | `out` | Out | the kind connected to `a` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Input | `mode` | choice |  | A | A (`a`), B (`b`), C (`c`), D (`d`) | Which input is passed through. An input with nothing connected passes the first input instead. |

<a id="filter"></a>

## Filter

Operations on a neighbourhood and on the geometry of the picture: blurring, sharpening, warping, moving and turning.

[Blur](#filter-blur) · [Directional Blur](#filter-directional-blur) · [Edge Fade](#filter-edge-fade) · [Flip](#filter-flip) · [Grow / Shrink](#filter-grow-shrink) · [High Pass](#filter-high-pass) · [Median](#filter-median) · [Sharpen](#filter-sharpen) · [Slope Blur](#filter-slope-blur) · [Slope Warp](#filter-slope-warp) · [Smart Blur](#filter-smart-blur) · [Transform](#filter-transform) · [Twirl](#filter-twirl) · [Warp](#filter-warp)

### Blur

<a id="filter-blur"></a>`filter/blur`

Blurs a terrain or a color map with a Gaussian of the given radius.

Also found by: gaussian, smooth, soften.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.01 | 0.0001 to 0.25 on the slider; any number can be typed | Larger values smooth away broader features. |

### Directional Blur

<a id="filter-directional-blur"></a>`filter/directional-blur`

Blurs a terrain or a color map along one direction, which draws its features out into streaks.

Also found by: motion blur, streak, linear, wind.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.02 | 0.0001 to 0.25 on the slider; any number can be typed | Larger values draw the features out into longer streaks. |
| Direction | `angle` | number | angle | 0 | 0 to 360 | The direction of the streaks. Larger values turn it clockwise in the top view. |

### Edge Fade

<a id="filter-edge-fade"></a>`filter/edge-fade`

Fades a terrain to one level toward its borders, so that it ends in a plain, a seabed or a plateau.

Also found by: border, falloff, vignette, island, frame.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Width | `width` | number | length | 0.15 | 0.001 to 0.5 on the slider; any number can be typed | How far in from the borders the fade reaches. Larger values leave less of the terrain untouched. |
| Level | `height` | number | height | 0 | 0 to 1 on the slider; any number can be typed | The height the terrain has at its borders. Larger values end it on higher ground. |
| Shape | `mode` | choice |  | Square | Square (`square`), Round (`round`) | Square fades along the four borders; round fades outside a circle that touches them, corners included. |

### Flip

<a id="filter-flip"></a>`filter/flip`

Mirrors a terrain or a color map, or turns it by quarter turns, without resampling it.

Also found by: mirror, rotate, turn, transpose, reflect.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Horizontal | Horizontal (`horizontal`), Vertical (`vertical`), Both (`both`), Turn 90° (`turn-90`), Turn 270° (`turn-270`), Transpose (`transpose`) | Horizontal swaps left and right, vertical top and bottom, both is a half turn. The turns are clockwise in the top view; transpose swaps the two axes. |

### Grow / Shrink

<a id="filter-grow-shrink"></a>`filter/grow-shrink`

Widens the high or the low ground of a terrain or a mask by a radius, or removes what is narrower than it.

Also found by: dilate, erode, morphology, expand, contract, inflate.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Grow | Grow (`grow`), Shrink (`shrink`), Open (`open`), Close (`close`) | Grow widens peaks and ridges, shrink widens pits and valleys. Open removes peaks narrower than the radius, close fills pits narrower than it. |
| Radius | `radius` | number | length | 0.01 | 0.0005 to 0.05 | How far the high or the low ground is widened. In open and close, the width of what is removed. |

### High Pass

<a id="filter-high-pass"></a>`filter/high-pass`

Keeps the detail finer than a radius and flattens everything broader to the level 0.5.

Also found by: detail, frequency, flatten, extract.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.02 | 0.0001 to 0.25 on the slider; any number can be typed | Features broader than this are flattened; larger values keep more of the shape. |

### Median

<a id="filter-median"></a>`filter/median`

Removes spikes and pits narrower than a radius by giving each point the median height of its surroundings.

Also found by: despeckle, denoise, outlier, rank, clean.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.012 | 0.0005 to 0.05 | Spikes, pits and ridges narrower than this are removed. Larger values also round off broader features. |

### Sharpen

<a id="filter-sharpen"></a>`filter/sharpen`

Sharpens a terrain or a color map by exaggerating the detail finer than a radius.

Also found by: unsharp mask, crisp, detail, enhance.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.01 | 0.0001 to 0.25 on the slider; any number can be typed | Detail finer than this is exaggerated; larger values sharpen broader features. |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | Larger values exaggerate the detail more. |

### Slope Blur

<a id="filter-slope-blur"></a>`filter/slope-blur`

Smears a terrain or a color map downhill along the slopes of a guide terrain, which draws gullies and streaks into it.

Also found by: smear, flow, streak, gully, erode, drag, rill.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `guide` | Guide | a terrain (heights) | optional |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.1 | 0.001 to 0.25 on the slider; any number can be typed | How far downhill a point is smeared. Larger values draw longer gullies and streaks. |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | Larger values replace more of the picture by its smear. |
| Mode | `mode` | choice |  | Gullies | Gullies (`gullies`), Smear (`smear`) | Gullies draws every low point of the fine detail down the slope as a channel and never raises the ground. Smear averages the whole picture down the slope. |
| Guide smoothing | `guideRadius` | number | length | 0.03 | 0.0001 to 0.25 on the slider; any number can be typed | Features smaller than this do not steer the smear, and gullies are cut from them. Larger values give straighter, broader streaks. |

### Slope Warp

<a id="filter-slope-warp"></a>`filter/slope-warp`

Pushes the features of a terrain down or up its own slopes, which swells ridges and pinches valleys or the reverse.

Also found by: displace, inflate, pinch, push, distort.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Distance | `distance` | number | length | 0.02 | 0.0005 to 0.25 on the slider; any number can be typed | How far the features are pushed on steep ground. Larger values swell or pinch them more. |
| Direction | `mode` | choice |  | Downhill | Downhill (`downhill`), Uphill (`uphill`) | Downhill spreads the heights down the slopes: ridges and peaks swell, valleys narrow to creases. Uphill does the reverse. |
| Slope smoothing | `radius` | number | length | 0.01 | 0.0001 to 0.25 on the slider; any number can be typed | The slope is measured on the terrain smoothed by this much. Larger values follow the broad shape and ignore small bumps. |

### Smart Blur

<a id="filter-smart-blur"></a>`filter/smart-blur`

Smooths gentle ground and keeps cliffs and ridges, where heights differ by more than a threshold.

Also found by: edge preserving, guided, bilateral, surface blur, denoise.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.01 | 0.0001 to 0.25 on the slider; any number can be typed | Larger values smooth away broader features where the ground is gentle. |
| Threshold | `threshold` | number | height | 0.05 | 0.001 to 0.5 on the slider; any number can be typed | Ground whose heights differ by less than this within the radius is smoothed. Larger values smooth steeper ground too. |

### Transform

<a id="filter-transform"></a>`filter/transform`

Moves a terrain or a color map, turns it and scales it about its center.

Also found by: move, translate, rotate, scale, zoom, offset, pan.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Offset | `offset` | two numbers | length | 0, 0 | each -1 to 1 on the slider; any number can be typed | How far the picture is moved, to the right and down in the top view. |
| Angle | `angle` | number | angle | 30 | 0 to 360 | Larger values turn the picture further clockwise in the top view. |
| Zoom | `zoom` | number |  | 1 | 0.1 to 10 | Larger values enlarge the picture about its center; values below 1 shrink it. |
| Edge | `edge` | choice |  | Clamp | Clamp (`clamp`), Mirror (`mirror`), Repeat (`repeat`), Constant (`constant`) | What fills the area the picture no longer covers: its border stretched outward, its mirror image, its repetition, or one level. |
| Fill level | `height` | number | height | 0 | 0 to 1 on the slider; any number can be typed | The height of the area the picture no longer covers. A color map is filled with the gray of this level. Shown while Edge is Constant. |

### Twirl

<a id="filter-twirl"></a>`filter/twirl`

Twists a terrain or a color map around a point, most at the point and not at all beyond a radius.

Also found by: twist, swirl, spiral, vortex, whirl.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Angle | `angle` | number | angle | 120 | 0 to 360 | How far the picture is turned at the center. Larger values wind the spiral tighter. |
| Radius | `radius` | number | length | 0.4 | 0.01 to 1 on the slider; any number can be typed | Larger values twist a wider area around the center. |
| Center | `center` | two numbers | length | 0.5, 0.5 | each 0 to 1 on the slider; any number can be typed | The point the picture is twisted around, from the left and from the top of the terrain. |
| Direction | `mode` | choice |  | Clockwise | Clockwise (`clockwise`), Counterclockwise (`counterclockwise`) | The way the picture is turned, as seen in the top view. |

### Warp

<a id="filter-warp"></a>`filter/warp`

Distorts a terrain or a color map by pushing it about, along a noise or down the slopes of a guide.

Also found by: distort, displace, domain warp, turbulence, perturb.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `guide` | Guide | a terrain (heights) | optional |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Distance | `distance` | number | length | 0.04 | 0.0005 to 0.25 on the slider; any number can be typed | How far the picture is pushed where the push is strongest: where the noise peaks, or where the guide is steep. Larger values distort it more. |
| Feature size | `size` | number | length | 0.2 | 0.001 to 4 on the slider; any number can be typed | Larger values bend the picture in broader sweeps of the noise. Unused with a guide. |
| Octaves | `octaves` | whole number |  | 3 | 1 to 8 | Larger values add finer wrinkles to the distortion. Unused with a guide. |
| Guide smoothing | `guideRadius` | number | length | 0.03 | 0.0001 to 0.25 on the slider; any number can be typed | Features of the guide smaller than this do not push the picture. Larger values follow its broad shape and distort the picture more gently. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

<a id="simulate"></a>

## Simulate

Simulations that run in steps, and the routing of water: erosion, snow, depression filling, flow, rivers, lakes and the sea.

[Fill Depressions](#simulate-fill) · [Flow](#simulate-flow) · [Fluvial Erosion](#simulate-fluvial-erosion) · [Hydraulic Erosion](#simulate-hydraulic-erosion) · [Lakes](#simulate-lakes) · [Rivers](#simulate-rivers) · [Sea](#simulate-sea) · [Sediment](#simulate-sediment) · [Snow](#simulate-snow) · [Thermal Erosion](#simulate-thermal-erosion)

### Fill Depressions

<a id="simulate-fill"></a>`simulate/fill`

Fills every pit and hollow up to its rim, so that all ground drains to the border or the sea; depth is the height added.

Also found by: pit, sink, depression, basin, pond, drain, priority flood.

- Reads the project's sea level.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a terrain (heights) | |
| Output | `depth` | Fill depth | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Tilt | `tilt` | number | angle | 0 | 0 to 10 | Slope of the filled ground towards its outlet: 0 leaves it level, larger values let water run off it. |

### Flow

<a id="simulate-flow"></a>`simulate/flow`

Maps where water gathers: the share of the terrain that drains through each point, and how wet the ground there is.

Also found by: flow map, accumulation, drainage, catchment, stream, watershed, wetness, twi.

- Reads the project's sea level.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `precipitation` | Precipitation | a mask (0 to 1) | optional |
| Output | `out` | Out | data | |
| Output | `wetness` | Wetness | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Routing | `routing` | choice |  | Single | Single (`single`), Multiple (`multiple`) | Single sends all water of a point to one lower neighbor and gives crisp stream lines; multiple shares it among all lower neighbors and gives soft ones. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Changes which lower neighbor each point drains to, and with it the course of the small streams. |

### Fluvial Erosion

<a id="simulate-fluvial-erosion"></a>`simulate/fluvial-erosion`

Carves branching river valleys with ridges between, as running water does over ages; wear is the height removed, flow the drained share.

Also found by: river, valley, stream power, drainage, dendritic, canyon, ridge, uplift, erode.

- Reads the project's sea level.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional |
| Input | `upliftMask` | Uplift mask | a mask (0 to 1) | optional |
| Output | `out` | Out | a terrain (heights) | |
| Output | `wear` | Wear | data | |
| Output | `flow` | Flow | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Feature size | `size` | number | length | 0.125 | 0.01 to 1 on the slider; any number can be typed | Width of the catchments whose valleys are cut at the reference speed. Larger values carve fewer, broader valleys. |
| Duration | `duration` | number |  | 1 | 0.05 to 8 | How long the rivers cut, as the distance their valleys work back into the terrain in feature sizes. Longer runs reach the ridges and lower them. |
| Concavity | `concavity` | number |  | 0.4 | 0.2 to 0.8 | Low values erode small streams and large rivers alike; high values keep the erosion to the large rivers and leave the slopes. |
| Talus angle | `talus` | number | angle | 30 | 5 to 90 | Valley sides steeper than this are worn back. At the largest value the rivers cut slots with standing walls. |
| Uplift | `uplift` | number | height | 0 | 0 to 1 on the slider; any number can be typed | Height the ground rises during the run where the uplift mask is 1, while the rivers cut into it. Grows ranges from level ground. |
| Lake fill | `lakeFill` | number | ratio | 1 | 0 to 1 | How far the hollows that remain are filled with sediment: 1 leaves every valley draining, 0 leaves the pits open. |
| Detail | `detail` | number | ratio | 0 | 0 to 1 | Fine roughness added each time the simulation moves to a finer grid, which seeds new small channels on smooth ground. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Changes which way the small streams turn, and with them the course of every valley. |

### Hydraulic Erosion

<a id="simulate-hydraulic-erosion"></a>`simulate/hydraulic-erosion`

Lets rain run off the terrain, cutting gullies where the water is fast and laying sediment down as fans and valley floors where it slows.

Also found by: rain, water, gully, rill, alluvial, fan, sediment, runoff, erode, virtual pipes.

- Reads the project's sea level.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional |
| Input | `precipitation` | Precipitation | a mask (0 to 1) | optional |
| Output | `out` | Out | a terrain (heights) | |
| Output | `wear` | Wear | data | |
| Output | `deposit` | Deposit | data | |
| Output | `flow` | Flow | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Feature size | `size` | number | length | 0.05 | 0.005 to 0.5 on the slider; any number can be typed | Scale of the largest gullies. Larger values let the water gather over wider slopes and cut broader, deeper channels. |
| Duration | `duration` | number |  | 2 | 0.05 to 16 | How long it rains, as the distance running water covers in feature sizes. Longer runs cut deeper and fill the valleys more. |
| Rain | `rain` | number | ratio | 0.24 | 0 to 1 | How hard it rains. More water reaches further up the slopes, runs faster and moves more material. |
| Sediment capacity | `capacity` | number |  | 1 | 0.1 to 3 | How much sediment running water can carry. Higher values deepen the gullies and enlarge the deposits. |
| Downcutting | `downcutting` | number |  | 0.5 | 0.1 to 2 | How quickly water picks material up. Higher values cut sharper, deeper channels close to where the water gathers. |
| Deposition | `deposition` | number |  | 1 | 0.1 to 3 | How quickly sediment settles when the water slows. Higher values drop it sooner, as fans at the foot of the slopes. |
| Removal | `removal` | number | ratio | 0.4 | 0 to 1 | Share of the eroded material that the water carries away for good. Higher values leave the gullies and lay down smaller fans. |
| Talus angle | `talus` | number | angle | 45 | 5 to 90 | Banks steeper than this slump while the water cuts. At the largest value nothing slumps and the channels keep their walls. |
| Detail | `detail` | number | ratio | 0 | 0 to 1 | Fine roughness added each time the simulation moves to a finer grid, which gives the water new paths to find. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Changes the small differences in hardness that decide where the water starts to cut. |

### Lakes

<a id="simulate-lakes"></a>`simulate/lakes`

Finds the hollows that hold water up to where they spill: a mask of the lakes, their depth and their surface, with the terrain unchanged.

Also found by: lake, pond, water, depression, basin, tarn, priority flood.

- Reads the project's sea level.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a terrain (heights) | |
| Output | `water` | Water | a mask (0 to 1) | |
| Output | `depth` | Water depth | data | |
| Output | `surface` | Water surface | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Minimum depth | `minDepth` | number | height | 0.003 | 0 to 0.1 on the slider; any number can be typed | Lakes whose deepest point is shallower than this are left out: larger values keep only the deep ones. |
| Minimum size | `minSize` | number | length | 0.02 | 0 to 0.25 on the slider; any number can be typed | Lakes that cover less than a square of this side are left out: larger values remove ponds and puddles. |

### Rivers

<a id="simulate-rivers"></a>`simulate/rivers`

Finds where the terrain's water gathers into rivers and cuts their valleys and channels, larger the more ground they drain.

Also found by: river, stream, channel, creek, valley, drainage, water, network.

- Reads the project's sea level.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `headwaters` | Headwaters | a mask (0 to 1) | optional |
| Output | `out` | Out | a terrain (heights) | |
| Output | `river` | River | a mask (0 to 1) | |
| Output | `depth` | Water depth | data | |
| Output | `surface` | Water surface | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Catchment | `catchment` | number | ratio | 0.001 | 0.00001 to 0.5 | The share of the terrain that must drain through a point for a river to begin there: smaller values give more and finer tributaries. |
| Valley depth | `valleyDepth` | number | height | 0.2 | 0 to 0.5 | How deep a river that drained the whole terrain would cut its valley into the ground; smaller rivers cut shallower ones, and 0 leaves only the channel. |
| River width | `riverWidth` | number | length | 0.05 | 0 to 0.25 | The width a river would have that drained the whole terrain; a river is narrower by the square root of its share. |
| River depth | `riverDepth` | number | height | 0.03 | 0 to 0.25 | The depth of the water in a river that drained the whole terrain; smaller rivers are shallower. |
| Bank slope | `bank` | number | angle | 30 | 5 to 80 | Steeper banks keep the valley narrow; gentler ones cut its sides further back. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Changes which lower neighbor each point drains to, and with it the course of the small rivers. |

### Sea

<a id="simulate-sea"></a>`simulate/sea`

Marks the sea at the project's sea level, with its depth and surface, and shapes the coast into a beach and a shelf.

Also found by: ocean, water, coast, shore, beach, sea level, bathymetry.

- Reads the project's sea level.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a terrain (heights) | |
| Output | `water` | Water | a mask (0 to 1) | |
| Output | `depth` | Water depth | data | |
| Output | `surface` | Water surface | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Connected | Connected (`connected`), Global (`global`) | Connected floods only what the sea reaches from the border and leaves inland basins dry; global floods everything below sea level. |
| Coast shaping | `strength` | number | ratio | 1 | 0 to 1 | Larger values cut the coast back into a beach that rises from the waterline and a shelf that falls away under it; 0 leaves the terrain as it is. |
| Shore width | `shoreSize` | number | length | 0.02 | 0.0005 to 0.1 | Larger values shape a broader band of beach and shelf along the waterline. |
| Shore height | `shoreHeight` | number | height | 0.005 | 0 to 0.05 | How far the beach rises above the waterline at the inland edge of the band, and the shelf falls below it at the seaward edge. |

### Sediment

<a id="simulate-sediment"></a>`simulate/sediment`

Lays loose material on the terrain and lets it slide off the slopes into the hollows; depth is the thickness that came to rest.

Also found by: fill, deposit, sand, soil, silt, debris, scree, settle, repose.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional |
| Output | `out` | Out | a terrain (heights) | |
| Output | `depth` | Depth | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Thickness | `thickness` | number | height | 0.02 | 0 to 0.1 on the slider; any number can be typed | Thickness of the layer laid down before it slides. More material fills the hollows higher and buries more of the relief. |
| Angle of repose | `repose` | number | angle | 33 | 5 to 89 | The steepest slope the material rests on. A lower angle lets it run further and settle flatter. |
| Reach | `size` | number | length | 0.02 | 0.001 to 0.25 on the slider; any number can be typed | How far the material can slide. A longer reach empties longer slopes and fills wider hollows. |

### Snow

<a id="simulate-snow"></a>`simulate/snow`

Covers high ground with snow that slides off steep faces, gathers in hollows and melts in the sun; snow is the cover, depth its thickness.

Also found by: snowfall, snow cover, snow line, drift, avalanche, glacier, ice, winter, alpine.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional |
| Output | `out` | Out | a terrain (heights) | |
| Output | `snow` | Snow | a mask (0 to 1) | |
| Output | `depth` | Depth | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Snowfall | `snowfall` | number | height | 0.02 | 0 to 0.1 on the slider; any number can be typed | Thickness of the snow that falls where nothing limits it. More snow buries more of the small relief. |
| Snow line | `snowLine` | number | height | 0.5 | 0 to 1 on the slider; any number can be typed | Altitude above which snow falls. Snow that slides below it melts. |
| Transition | `band` | number | height | 0.05 | 0.001 to 0.5 | Half the height over which the snow line fades in. A wider band gives a ragged, gradual snow line. |
| Slip angle | `slipAngle` | number | angle | 50 | 5 to 89 | Snow slides off surfaces steeper than this. A lower angle bares more rock and fills the hollows below it deeper. |
| Melt | `melt` | number | ratio | 0.2 | 0 to 1 | Share of the snowfall that melts on ground fully turned to the sun. More melt thins the cover and raises the snow line. |
| Sun exposure | `exposure` | number | ratio | 0.5 | 0 to 1 | How much the melt depends on facing the sun: 0 melts all slopes alike, 1 leaves the shaded slopes their snow. |
| Sun direction | `angle` | number | angle | 0 | 0 to 360 | Direction from the terrain towards the sun that melts the snow. Slopes facing it keep less. |
| Reach | `size` | number | length | 0.02 | 0.001 to 0.25 on the slider; any number can be typed | How far snow can slide. A longer reach empties longer faces and builds deeper drifts at their foot. |

### Thermal Erosion

<a id="simulate-thermal-erosion"></a>`simulate/thermal-erosion`

Collapses slopes steeper than a talus angle into even scree slopes; wear and deposit are the heights taken and laid down.

Also found by: talus, scree, slump, thermal, landslide, rockfall, debris, collapse.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional |
| Output | `out` | Out | a terrain (heights) | |
| Output | `wear` | Wear | data | |
| Output | `deposit` | Deposit | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Talus angle | `talus` | number | angle | 35 | 5 to 89 | Slopes steeper than this collapse. A lower angle flattens more of the terrain. |
| Reach | `size` | number | length | 0.005 | 0.001 to 0.25 on the slider; any number can be typed | Width of the largest scree slope that forms completely. A longer reach lets taller cliffs collapse all the way. |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | How far the collapse proceeds: lower values stop it early and leave cliffs partly standing. |
| Removal | `removal` | number | ratio | 0 | 0 to 1 | Share of the fallen material that is carried away instead of piling up at the foot of the slope. |

<a id="select"></a>

## Select

Masks and measurements read from a terrain: height, slope, curvature, exposure, distance.

[Aspect](#select-aspect) · [Curvature](#select-curvature) · [Distance](#select-distance) · [Edge](#select-edge) · [Exposure](#select-exposure) · [Height](#select-height) · [Occlusion](#select-occlusion) · [Peaks](#select-peaks) · [Roughness](#select-roughness) · [Slope](#select-slope)

### Aspect

<a id="select-aspect"></a>`select/aspect`

Selects the slopes that face a direction, most where they face it squarely and none beyond a spread to either side.

Also found by: facing, orientation, compass, direction, north, south, windward, leeward.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Direction | `angle` | number | angle | 180 | 0 to 360 | The direction the selected slopes face, as seen from above: 0 faces +X, and larger values turn clockwise. |
| Spread | `spread` | number | angle | 60 | 0 to 180 | How far a slope may turn away from the direction before it is left out: larger values select a wider fan of slopes. |
| Lower slope | `slopeMin` | number | angle | 10 | 0 to 90 | Ground no steeper than this faces nowhere and is left out. |
| Feather | `feather` | number | angle | 10 | 0 to 45 | Larger values bring slopes in more gradually above the lower slope. |
| Radius | `radius` | number | length | 0.005 | 0.0001 to 0.25 on the slider; any number can be typed | Smooths the terrain before its slopes are measured: larger values follow the broad shape and ignore small detail. |
| Invert | `invert` | switch |  | off |  | Selects what was left out and leaves out what was selected. |

### Curvature

<a id="select-curvature"></a>`select/curvature`

Selects convex ground such as ridges and crests, or concave ground such as gullies and hollows, at the scale of a radius.

Also found by: convex, concave, ridge, crest, gully, crease, cavity, laplacian.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Convex | Convex (`convex`), Concave (`concave`), Both (`both`) | Convex selects ridges and crests, concave selects gullies and hollows, both selects every bend of the ground. |
| Radius | `radius` | number | length | 0.01 | 0.0001 to 0.25 on the slider; any number can be typed | The scale the bend is measured at: larger values pick out broader ridges and valleys and ignore small detail. |
| Strength | `strength` | number | ratio | 0.5 | 0 to 1 | Larger values select gentler bends, until every bend of the chosen kind is fully selected. |
| Invert | `invert` | switch |  | off |  | Selects what was left out and leaves out what was selected. |

### Distance

<a id="select-distance"></a>`select/distance`

Fades a mask over a distance from its edge, outwards, inwards or both; raw is that distance as a fraction of the terrain width.

Also found by: distance field, sdf, falloff, grow, shrink, feather, proximity, edt.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a mask (0 to 1) | required |
| Output | `out` | Out | a mask (0 to 1) | |
| Output | `raw` | Raw distance | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Distance | `distance` | number | length | 0.02 | 0.001 to 0.5 on the slider; any number can be typed | How far from the edge of the mask the result fades: larger values give a broader, gentler ramp. |
| Mode | `mode` | choice |  | Outside | Outside (`outside`), Inside (`inside`), Both (`both`) | Outside keeps the selection and fades outwards from its edge, inside fades inwards from it, both softens the edge to either side. |
| Invert | `invert` | switch |  | off |  | Selects what was left out and leaves out what was selected. |

### Edge

<a id="select-edge"></a>`select/edge`

Selects a band of a given width along the edge of a mask, half of it on either side, fading out over a feather.

Also found by: outline, border, boundary, contour, rim, stroke, shoreline.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a mask (0 to 1) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Width | `width` | number | length | 0.01 | 0.0005 to 0.25 on the slider; any number can be typed | How wide the band is that is fully selected, across the edge of the mask: larger values give a broader band. |
| Feather | `feather` | number | length | 0.005 | 0.0005 to 0.25 on the slider; any number can be typed | Larger values fade the band out over a wider margin on both of its sides. |
| Invert | `invert` | switch |  | off |  | Selects what was left out and leaves out what was selected. |

### Exposure

<a id="select-exposure"></a>`select/exposure`

Selects the ground a sun at a given direction and elevation lights, by how squarely it is lit and with cast shadows.

Also found by: sunlight, insolation, shadow, shade, light, sun, illumination, hillshade.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Direction | `angle` | number | angle | 180 | 0 to 360 | The direction from the terrain towards the sun, as seen from above: 0 is +X, and larger values turn clockwise. |
| Elevation | `elevation` | number | angle | 30 | 0 to 90 | The height of the sun above the horizon: larger values shorten the shadows and light level ground more. |
| Softness | `softness` | number | ratio | 0.2 | 0 to 1 | Larger values blur the edges of cast shadows more, as a wider sun does, and more the farther the shadow falls. |
| Radius | `radius` | number | length | 0.005 | 0.0001 to 0.25 on the slider; any number can be typed | Smooths the terrain before it is lit: larger values light the broad shape and ignore small detail. |
| Invert | `invert` | switch |  | off |  | Selects what was left out and leaves out what was selected. |

### Height

<a id="select-height"></a>`select/height`

Selects the terrain between two heights, fading out over a feather below and above the band.

Also found by: altitude, elevation, band, range, snow line, level.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Lower height | `heightMin` | number | height | 0.5 | 0 to 1 on the slider; any number can be typed | Terrain from this height upwards is fully selected. |
| Upper height | `heightMax` | number | height | 0.75 | 0 to 1 on the slider; any number can be typed | Terrain up to this height is fully selected. |
| Feather | `feather` | number | height | 0.05 | 0 to 0.5 on the slider; any number can be typed | Larger values fade the selection out over a taller margin below and above the band. |
| Invert | `invert` | switch |  | off |  | Selects what was left out and leaves out what was selected. |

### Occlusion

<a id="select-occlusion"></a>`select/occlusion`

Selects sheltered ground: hollows, valley floors and the feet of cliffs, where the ground about a radius away stands higher.

Also found by: ambient occlusion, ao, cavity, sheltered, hollow, valley, crevice, shade.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.04 | 0.0001 to 0.25 on the slider; any number can be typed | The distance at which higher ground shelters a point most: larger values find whole valleys, smaller ones only creases. |
| Strength | `strength` | number | ratio | 0.5 | 0 to 1 | Larger values count shallower hollows as sheltered, until every hollow is fully selected. |
| Invert | `invert` | switch |  | off |  | Selects what was left out and leaves out what was selected. |

### Peaks

<a id="select-peaks"></a>`select/peaks`

Selects ground that stands above its surroundings within a radius, such as summits and ridge tops, or below them when inverted.

Also found by: summit, ridge, prominence, relative height, valley, hollow, tpi.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.04 | 0.0001 to 0.25 on the slider; any number can be typed | The size of the surroundings a point is compared with: larger values select whole massifs, smaller ones every knoll. |
| Feather | `feather` | number | height | 0.05 | 0 to 0.5 on the slider; any number can be typed | How far above its surroundings ground stands before it is fully selected: larger values keep only the most prominent tops. |
| Invert | `invert` | switch |  | off |  | Selects ground that lies below its surroundings instead: valley floors and hollows. |

### Roughness

<a id="select-roughness"></a>`select/roughness`

Selects rough ground against smooth: where the height varies within a radius about its smoothed surface.

Also found by: rugged, ruggedness, variation, deviation, texture, relief, bumpy, smooth.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.01 | 0.0001 to 0.25 on the slider; any number can be typed | The scale of the roughness: relief narrower than this counts and broader shapes do not. |
| Strength | `strength` | number | ratio | 0.5 | 0 to 1 | Larger values count gentler ground as rough, until every unevenness is fully selected. |
| Invert | `invert` | switch |  | off |  | Selects what was left out and leaves out what was selected. |

### Slope

<a id="select-slope"></a>`select/slope`

Selects the terrain whose physical slope lies between two angles, measured after smoothing over a radius.

Also found by: steepness, angle, gradient, cliff, flat, incline.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Lower slope | `slopeMin` | number | angle | 40 | 0 to 90 | Terrain at least this steep is fully selected. |
| Upper slope | `slopeMax` | number | angle | 70 | 0 to 90 | Terrain no steeper than this is fully selected. |
| Feather | `feather` | number | angle | 5 | 0 to 45 | Larger values fade the selection out over a wider margin of angles below and above the band. |
| Radius | `radius` | number | length | 0.005 | 0.0001 to 0.25 on the slider; any number can be typed | Smooths the terrain before its slope is measured: larger values follow the broad shape and ignore small detail. |
| Invert | `invert` | switch |  | off |  | Selects what was left out and leaves out what was selected. |

<a id="color"></a>

## Color

Everything that makes or changes a colour map.

[Solid Color](#color-constant) · [Extract Channel](#color-extract-channel) · [Gradient Map](#color-gradient-map) · [Hillshade](#color-hillshade) · [Hue / Saturation](#color-hue-saturation) · [Natural Color](#color-natural) · [Normal Map](#color-normal-map) · [Pack Channels](#color-pack-channels)

### Solid Color

<a id="color-constant"></a>`color/constant`

Fills the whole terrain with one opaque color.

Also found by: constant, fill, flat, uniform, tint, swatch.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a colour map | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Color | `color` | colour |  | linear RGB 0.3, 0.2, 0.11 | each channel 0 to 1 | The color every point of the terrain gets. |

### Extract Channel

<a id="color-extract-channel"></a>`color/extract-channel`

Takes one channel of a color, or its luminance, as a field.

Also found by: split, separate, red, green, blue, alpha, luma, grayscale, unpack.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a colour map | required |
| Output | `out` | Out | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Channel | `channel` | choice |  | Red | Red (`red`), Green (`green`), Blue (`blue`), Alpha (`alpha`), Luminance (`luminance`) | Which channel of the color becomes the field. Luminance is the brightness of the color as the eye weighs red, green and blue. |

### Gradient Map

<a id="color-gradient-map"></a>`color/gradient-map`

Colors a field through a gradient: the input minimum gets the left end, the input maximum the right end.

Also found by: ramp, colorize, palette, lut, clut, tint, hypsometric, false color.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | data | required |
| Output | `out` | Out | a colour map | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Gradient | `gradient` | gradient |  | 0: 0.015, 0.05, 0.027; 0.125: 0.05, 0.147, 0.042; 0.25: 0.195, 0.323, 0.078; 0.375: 0.539, 0.479, 0.144; 0.5: 0.479, 0.323, 0.122; 0.625: 0.275, 0.156, 0.072; 0.75: 0.205, 0.144, 0.112; 0.875: 0.451, 0.413, 0.381; 1: 0.905, 0.905, 0.888 | stops at 0 to 1, colours in linear RGB | The colors of the field, from the input minimum on the left to the input maximum on the right. |
| Input minimum | `inMin` | number |  | 0 | 0 to 1 on the slider; any number can be typed | The value that gets the left end of the gradient. Larger values move every color towards higher values. |
| Input maximum | `inMax` | number |  | 1 | 0 to 1 on the slider; any number can be typed | The value that gets the right end of the gradient. Smaller values press the colors into a narrower range. |

### Hillshade

<a id="color-hillshade"></a>`color/hillshade`

Renders a terrain lit by a sun, with cast shadows and darkened hollows, over a base color or in white.

Also found by: relief, shading, shaded relief, lighting, shadow, minimap, overview, sun, ambient occlusion.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `base` | Base | a colour map | optional |
| Output | `out` | Out | a colour map | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Direction | `angle` | number | angle | 225 | 0 to 360 | The direction from the terrain towards the sun, as seen from above: 0 is +X, and larger values turn clockwise. |
| Elevation | `elevation` | number | angle | 40 | 0 to 90 | The height of the sun above the horizon: larger values shorten the shadows and light level ground more. |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | How strongly the light and the shadows show over the base color: 0 leaves the base as it is. |

### Hue / Saturation

<a id="color-hue-saturation"></a>`color/hue-saturation`

Shifts the hue of a color and changes its saturation, lightness and contrast.

Also found by: hsl, hsv, tint, vibrance, desaturate, grayscale, brightness, color correction, grade.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a colour map | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Hue shift | `hue` | number | angle | 0 | 0 to 360 | Turns every color around the color wheel by this angle: 120 turns red into green, green into blue and blue into red. |
| Saturation | `saturation` | number |  | 1.5 | 0 to 2 on the slider; any number can be typed | Larger values make colors more vivid, up to the pure color of the same brightness. 1 leaves them as they are and 0 leaves gray. |
| Lightness | `lightness` | number |  | 0 | -1 to 1 | Positive values blend every color towards white, negative values towards black. 0 leaves them as they are. |
| Contrast | `contrast` | number |  | 1 | 0 to 2 | Larger values push colors away from middle gray, the dark ones darker and the light ones lighter. 1 leaves them as they are. |

### Natural Color

<a id="color-natural"></a>`color/natural`

Colors a terrain as a landscape: rock on steep ground, vegetation and soil by height and shelter, wet valley lines and snow.

Also found by: biome, texture, satellite, landscape, vegetation, rock, snow, colorize, satmap, albedo, forest, grass.

- Reads the project's sea level.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `flow` | Flow | data | optional |
| Input | `snow` | Snow | a mask (0 to 1) | optional |
| Output | `out` | Out | a colour map | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Landscape | `mode` | choice |  | Alpine | Alpine (`alpine`), Temperate (`temperate`), Desert (`desert`), Volcanic (`volcanic`), Arctic (`arctic`) | The kind of landscape: its palette of rock, soil and vegetation, and the heights and slopes each of them covers. |
| Variation | `variation` | number | ratio | 0.5 | 0 to 1 | Larger values break the cover into patches and mottle its colors; 0 colors the terrain by its shape alone. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Normal Map

<a id="color-normal-map"></a>`color/normal-map`

Encodes the surface normals of a terrain as a normal map in the convention Unreal Engine reads, from its physical slopes.

Also found by: normals, tangent space, bump, directx, unreal, relief, shading.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a colour map | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | Scales the slopes the normals are made from: 1 gives the normals of the terrain as it is, smaller values a flatter map, and 0 a level one. |
| Radius | `radius` | number | length | 0.002 | 0.0001 to 0.25 on the slider; any number can be typed | Smooths the terrain before its normals are taken: larger values keep the broad shape and leave out small detail. |

### Pack Channels

<a id="color-pack-channels"></a>`color/pack-channels`

Packs up to four fields into the red, green, blue and alpha of one color; a channel left open is 0, and the alpha 1.

Also found by: combine, merge, rgba, splat, packed masks, channels, orm.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `r` | Red | a terrain (heights) | optional |
| Input | `g` | Green | a terrain (heights) | optional |
| Input | `b` | Blue | a terrain (heights) | optional |
| Input | `a` | Alpha | a terrain (heights) | optional |
| Output | `out` | Out | a colour map | |

No parameters.

<a id="surface"></a>

## Surface

Detail and structure added to a terrain without simulation: terraces, strata, rocks, scattered stamps.

[Cracks](#surface-cracks) · [Faults](#surface-fault) · [Outcrops](#surface-outcrops) · [Ripples](#surface-ripples) · [Roughen](#surface-roughen) · [Scatter](#surface-scatter) · [Stones](#surface-stones) · [Strata](#surface-strata) · [Terraces](#surface-terraces)

### Cracks

<a id="surface-cracks"></a>`surface/cracks`

Cuts a connected net of cracks into the ground, around plates of varied size, as in dried mud or jointed rock.

Also found by: fissures, mud, joints, crevasses, fractures, polygons, desiccation, voronoi.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Plate size | `size` | number | length | 0.1 | 0.001 to 4 on the slider; any number can be typed | How far apart the main cracks lie. Many plates between them break into smaller ones. |
| Depth | `depth` | number | height | 0.05 | 0 to 1 on the slider; any number can be typed | How deep the main cracks are cut. The cracks between smaller plates are shallower. |
| Width | `width` | number | length | 0.012 | 0.0005 to 0.1 on the slider; any number can be typed | How wide the main cracks are from lip to lip. The cracks between smaller plates are narrower. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Faults

<a id="surface-fault"></a>`surface/fault`

Breaks the ground along straight faults: one side is thrown up against the other across a flat scarp, and both tilt back to their level.

Also found by: fault, scarp, fracture, tectonic, rift, graben, horst, offset, shear.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Count | `count` | whole number |  | 6 | 1 to 32 | How many faults break the ground. More faults leave the first ones where they are. |
| Throw | `height` | number | height | 0.25 | 0 to 1 on the slider; any number can be typed | How far the ground on one side of the largest fault stands above the other side. Smaller faults throw half as much or more. |
| Direction | `angle` | number | angle | 20 | 0 to 360 | The direction the fault lines run in. Larger values turn it clockwise in the top view. |
| Spread | `spread` | number | angle | 20 | 0 to 90 | How far a fault may be turned off the direction, to either side. At 0 all faults are parallel. |
| Reach | `reach` | number | length | 0.6 | 0.01 to 4 on the slider; any number can be typed | How far from a fault the ground is moved. Larger values tilt broader blocks; smaller ones leave a ridge and a trench along the scarp. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Outcrops

<a id="surface-outcrops"></a>`surface/outcrops`

Breaks angular blocks of rock out of steep ground, large and small, with flat tops and steep faces; coverage is where the rock shows.

Also found by: rock, crag, cliff, ledge, bedrock, blocks, boulders, scarp, exposed.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |
| Output | `coverage` | Coverage | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Block size | `size` | number | length | 0.06 | 0.001 to 4 on the slider; any number can be typed | How wide the largest blocks are. Larger blocks stand further out of the slope, and smaller ones break out beside them. |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | Larger values let the blocks stand further out of the ground. |
| Lower slope | `slopeMin` | number | angle | 30 | 0 to 90 | Rock comes out of ground steeper than this, and in full a little above it. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Ripples

<a id="surface-ripples"></a>`surface/ripples`

Lays small ripples across gentle ground, as wind leaves them in sand: a long windward side, a short lee side, crests that end and fork.

Also found by: sand, wind, waves, dunes, aeolian, ridges, corrugation, washboard.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Ripple length | `size` | number | length | 0.04 | 0.001 to 4 on the slider; any number can be typed | How far it is from one crest to the next. |
| Wind direction | `angle` | number | angle | 0 | 0 to 360 | The direction the wind blows to. The crests lie across it, and the short, steep side of every ripple faces that way. |
| Height | `height` | number | height | 0.016 | 0 to 1 on the slider; any number can be typed | How far a crest stands above the trough beside it. |
| Irregularity | `irregularity` | number | ratio | 0.5 | 0 to 1 | Larger values let the crests wander, end and fork. At 0 they are straight and even. |
| Upper slope | `slopeMax` | number | angle | 55 | 0 to 90 | Ripples lie on ground no steeper than this, and fade towards it. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Roughen

<a id="surface-roughen"></a>`surface/roughen`

Adds fine roughness in several layers of detail, more of it on steep ground than on level ground.

Also found by: detail, noise, bumps, grain, texture, rugged, displace, microdetail.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Feature size | `size` | number | length | 0.05 | 0.001 to 4 on the slider; any number can be typed | How broad the broadest bumps are. Finer layers of detail are added below it, and the bumps grow taller with it. |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | Larger values make the bumps taller and the surface rougher. |
| Slope bias | `slopeBias` | number | ratio | 0.6 | 0 to 1 | Larger values keep the roughness for steep ground and leave gentle ground smoother. At 0 all ground is equally rough. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Scatter

<a id="surface-scatter"></a>`surface/scatter`

Stamps round copies of a second terrain over the first, each at a random place, size and turn, and as tall for its width as the stamp.

Also found by: stamp, instances, copies, distribute, place, clone, populate, sprinkle.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `stamp` | Stamp | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Count | `count` | whole number |  | 24 | 1 to 256 | How many copies are stamped. More copies leave the first ones where they are. |
| Smallest size | `sizeMin` | number | length | 0.08 | 0.005 to 1 | How wide the smallest copies are. A copy is as much lower than the stamp as it is narrower. |
| Largest size | `sizeMax` | number | length | 0.3 | 0.005 to 1 | How wide the largest copies are. At 1 a copy is as large as the stamp. |
| Mode | `mode` | choice |  | Add | Add (`add`), Maximum (`maximum`), Subtract (`subtract`) | Add piles the copies on the terrain and on each other, maximum lets the taller of two overlapping copies stand, subtract carves them out. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Stones

<a id="surface-stones"></a>`surface/stones`

Scatters stones and boulders of varied size over gentle ground, in patches, each a faceted body lying on it; coverage is where they lie.

Also found by: boulders, rocks, rubble, scree, pebbles, debris, scatter, erratics.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |
| Output | `coverage` | Coverage | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Stone size | `size` | number | length | 0.04 | 0.001 to 4 on the slider; any number can be typed | How wide the largest stones are. Most stones are smaller, down to a third of this. |
| Density | `density` | number | ratio | 0.6 | 0 to 1 | Larger values put more stones on the ground, which lie in patches. At 1 they lie about a stone apart everywhere. |
| Height | `height` | number | height | 0.06 | 0 to 1 on the slider; any number can be typed | How far the tallest stones stand above the ground. Smaller stones are lower in proportion. |
| Upper slope | `slopeMax` | number | angle | 50 | 0 to 90 | Stones lie on ground no steeper than this, and get smaller towards it. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Strata

<a id="surface-strata"></a>`surface/strata`

Lays tilted rock layers of varying hardness into steep ground: hard beds stand out as cliffs and soft ones lie back as benches.

Also found by: layers, beds, sediment, stratify, cliffs, ledges, rock, cuesta, geology.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Thickness | `thickness` | number | height | 0.1 | 0.002 to 0.5 on the slider; any number can be typed | How thick a layer is, measured upwards. Larger values give fewer, taller cliffs. |
| Dip direction | `angle` | number | angle | 0 | 0 to 360 | The direction in which the layers slope down. Larger values turn it clockwise in the top view. |
| Tilt | `tilt` | number | angle | 15 | 0 to 80 | How steeply the layers slope down. At 0 they lie level. |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | Larger values let the hard beds stand further out of the slope, which makes taller cliffs and flatter benches. |
| Lower slope | `slopeMin` | number | angle | 15 | 0 to 90 | The layers show on ground steeper than this, and in full a little above it. Gentler ground stays as it is. |
| Warp strength | `warpStrength` | number | ratio | 0.4 | 0 to 1 | Larger values fold the layers into deeper waves and make their edges more ragged. |
| Warp size | `warpSize` | number | length | 0.3 | 0.001 to 4 on the slider; any number can be typed | Larger values fold the layers in broader waves. |
| Edge smoothing | `radius` | number | length | 0.004 | 0.0001 to 0.25 on the slider; any number can be typed | Features of the terrain smaller than this do not shape the edges of the layers. Larger values draw them in cleaner lines. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

### Terraces

<a id="surface-terraces"></a>`surface/terraces`

Steps the terrain into level benches with steep risers between them, at uneven heights.

Also found by: steps, benches, stairs, plateau, mesa, quantize, posterize, stratify.

- Maskable: connect a mask to limit where the node acts.
- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Levels | `levels` | whole number |  | 8 | 1 to 64 | How many steps lie between the bottom and the top of the height range. Larger values give more and lower steps. |
| Sharpness | `sharpness` | number | ratio | 0.8 | 0 to 1 | Larger values widen the benches and steepen the risers between them. At 0 the terrain stays as it is. |
| Irregularity | `irregularity` | number | ratio | 0.6 | 0 to 1 | Larger values make the steps less even in height and let the edges of the benches stray further from the contour lines. |
| Irregularity size | `size` | number | length | 0.25 | 0.001 to 4 on the slider; any number can be typed | Larger values let the edges of the benches stray from the contour lines in broader sweeps. |
| Edge smoothing | `radius` | number | length | 0.004 | 0.0001 to 0.25 on the slider; any number can be typed | Features of the terrain smaller than this do not shape the edges of the benches. Larger values draw the steps in cleaner lines. |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |

<a id="io"></a>

## Import and export

Nodes that read image files, and the export nodes that say what a build writes. An export node has no output: it is the end of a branch of the graph.

[Color Texture](#io-export-color) · [Image File](#io-export-field) · [Unreal Landscape](#io-export-landscape) · [Landscape Layer](#io-export-layer) · [Mask Texture](#io-export-mask) · [Normal Texture](#io-export-normal) · [Import Image](#io-import-color) · [Import Heightmap](#io-import-field)

### Color Texture

<a id="io-export-color"></a>`io/export-color`

Exports a color map, or three channels of data, as a texture that covers the landscape, for use in its material.

Also found by: unreal, texture, albedo, diffuse, base color, packed masks, linear, srgb, png, export, output.

- An export node: it has no output and takes part in a build while its Enabled switch is on.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a colour map | required |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Enabled | `enabled` | switch |  | on |  | Include this node in builds. |
| Name | `name` | text |  | `Color` | at most 64 characters | Names the texture file. Only its letters and digits are used. |
| Size | `dimension` | choice |  | Auto | Auto (`auto`), 1024 (`1024`), 2048 (`2048`), 4096 (`4096`), 8192 (`8192`) | The side of the texture. Auto is the power of two that holds the build resolution, from 1024 to 8192. |
| Content | `content` | choice |  | Color | Color (`color`), Data (`data`) | Color is stored sRGB-encoded, as a base color is. Data is stored as it is, for a normal map or packed masks: switch sRGB off for that texture in Unreal. |

### Image File

<a id="io-export-field"></a>`io/export-field`

Exports a terrain, a mask or a data map as a one-channel image at build resolution, for other tools.

Also found by: save, write, heightmap, exr, tiff, png, raw, r16, r32, export, output, image.

- An export node: it has no output and takes part in a build while its Enabled switch is on.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Enabled | `enabled` | switch |  | on |  | Include this node in builds. |
| Name | `name` | text |  | `Field` | at most 64 characters | Names the image file. Only its letters and digits are used. |
| Format | `format` | choice |  | OpenEXR, 32-bit float | PNG, 8 bits (`png8`), PNG, 16 bits (`png16`), Raw, 16 bits (`r16`), Raw, 32-bit float (`r32`), OpenEXR, 32-bit float (`exr`), TIFF, 16 bits (`tiff16`), TIFF, 32-bit float (`tiff32`) | The file format. The float formats store the values as they are; the others store whole numbers of 8 or 16 bits. |
| Value range | `rangeMode` | choice |  | Zero to one | Zero to one (`unit`), Measured (`measured`) | Which values the whole-number formats store as black and white: zero and one, or the lowest and highest value found. |

### Unreal Landscape

<a id="io-export-landscape"></a>`io/export-landscape`

Exports a terrain as the heightmap of an Unreal Engine landscape, with the scale and location to import it at.

Also found by: unreal, heightmap, build, r16, png, world partition, export, output, terrain.

- An export node: it has no output and takes part in a build while its Enabled switch is on.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Enabled | `enabled` | switch |  | on |  | Include this node in builds. |
| Name | `name` | text |  | `Orogen` | at most 64 characters | Names the files of the build. Only its letters are used, because Unreal is reported to refuse other file names. |
| Height range | `rangeMode` | choice |  | Measured | Measured (`measured`), Fixed (`fixed`) | Measured stores the terrain between its own lowest and highest point. Fixed stores a range you set, so the scale in Unreal stays the same from build to build. |
| Headroom | `headroom` | number | ratio | 0 | 0 to 1 | Widens the stored range by this share of itself above and below the terrain, leaving room to sculpt in Unreal. Shown while Height range is Measured. |
| Lowest height | `heightMin` | number | height | 0 | 0 to 1 on the slider; any number can be typed | The height stored as the lowest value. Terrain below it is clipped. Shown while Height range is Fixed. |
| Highest height | `heightMax` | number | height | 1 | 0 to 1 on the slider; any number can be typed | The height stored as the highest value. Terrain above it is clipped. Shown while Height range is Fixed. |
| Dither | `dither` | switch |  | on |  | Adds noise of one height step so that gentle slopes do not become terraces. Turn it off for a terrain with large, exactly level surfaces. |
| Zero height | `zeroAt` | choice |  | Sea level | Sea level (`seaLevel`), Bottom (`bottom`) | Which height of the terrain the build places at world height zero in Unreal: the sea level of the project, or the bottom of its height range. |
| Origin | `origin` | choice |  | Center | Center (`center`), Corner (`corner`) | Which point of the terrain the build places at the world origin in Unreal: its center, or the corner of the first row and column. |
| Base layer | `baseLayer` | text |  | `Base` | at most 63 characters | Name of the layer that receives the weight the weight-blended layers leave, so that no ground is unpainted. Section Layers. |
| Layer blend method | `layerBlend` | choice |  | Advanced | Advanced (`advanced`), Final (`final`) | The weight blending method the manifest names for the weight-blended layers. Final is the legacy method of Unreal. Section Layers. |
| Layer floor | `layerFloor` | number | ratio | 0.008 | 0 to 0.25 | Layer weights below this are set to zero, which lets Unreal drop layers from the parts of the landscape that do not show them. Section Layers. |
| Layers per point | `layerLimit` | whole number |  | 0 | 0 to 16 | The most weight-blended layers kept at one point; the weakest are dropped. Zero keeps all of them. Section Layers. |
| World Partition | `partition` | switch |  | on |  | Marks the landscape as meant for a World Partition level. The two sizes below are written for the import either way. Section World Partition. |
| Grid size | `gridComponents` | whole number |  | 4 | 1 to 16 | Landscape components along one side of a streaming proxy. Larger values make fewer and larger proxies. Section World Partition. |
| Region size | `regionComponents` | whole number |  | 32 | 4 to 64 | Landscape components along one side of a region. Larger values make fewer and larger regions. Section World Partition. |

### Landscape Layer

<a id="io-export-layer"></a>`io/export-layer`

Exports a mask as an Unreal landscape target layer.

Also found by: unreal, weightmap, splat, paint layer, export, output, splatmap, mask.

- An export node: it has no output and takes part in a build while its Enabled switch is on.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a mask (0 to 1) | required |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Enabled | `enabled` | switch |  | on |  | Include this node in builds. |
| Layer name | `layer` | text |  | `Layer` | at most 63 characters | Name of the landscape target layer. It must equal the layer name used in the landscape material. |
| Weight-blended | `weightBlended` | switch |  | on |  | On: the layer shares the total weight with the other weight-blended layers. Off: an independent mask. |

### Mask Texture

<a id="io-export-mask"></a>`io/export-mask`

Exports a mask as a grayscale texture that covers the landscape, for use in its material.

Also found by: unreal, texture, grayscale, data, png, export, output.

- An export node: it has no output and takes part in a build while its Enabled switch is on.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a mask (0 to 1) | required |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Enabled | `enabled` | switch |  | on |  | Include this node in builds. |
| Name | `name` | text |  | `Mask` | at most 64 characters | Names the texture file. Only its letters and digits are used. |
| Size | `dimension` | choice |  | Auto | Auto (`auto`), 1024 (`1024`), 2048 (`2048`), 4096 (`4096`), 8192 (`8192`) | The side of the texture. Auto is the power of two that holds the build resolution, from 1024 to 8192. |
| Bit depth | `bits` | choice |  | 8 bits | 8 bits (`8`), 16 bits (`16`) | Bits of the texture. Sixteen keeps smooth gradients free of steps and makes the file larger. |

### Normal Texture

<a id="io-export-normal"></a>`io/export-normal`

Exports the surface normals of a terrain as a texture that covers the landscape, for use in its material.

Also found by: unreal, texture, normal map, macro normal, png, export, output.

- An export node: it has no output and takes part in a build while its Enabled switch is on.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Enabled | `enabled` | switch |  | on |  | Include this node in builds. |
| Name | `name` | text |  | `Normal` | at most 64 characters | Names the texture file. Only its letters and digits are used. |
| Size | `dimension` | choice |  | Auto | Auto (`auto`), 1024 (`1024`), 2048 (`2048`), 4096 (`4096`), 8192 (`8192`) | The side of the texture. Auto is the power of two that holds the build resolution, from 1024 to 8192. |

### Import Image

<a id="io-import-color"></a>`io/import-color`

Loads a PNG, TIFF or OpenEXR image file as a color map, and fails while no file is selected.

Also found by: load, open, file, texture, picture, photo, png, tiff, exr, satellite.

- Reads a file: until one is selected the node reports "No file selected".

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a colour map | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| File | `file` | file |  | no file | .png, .tif, .tiff, .exr | The image to load. PNG and whole-number TIFF files are read as sRGB colors, OpenEXR and float TIFF files as linear ones. Transparency is ignored. |
| Fit | `fit` | choice |  | Stretch | Stretch (`stretch`), Contain (`contain`), Cover (`cover`) | How an image that is not square is placed: stretched to the terrain, shown whole with level ground beside it, or filling the terrain with its ends cut off. |
| Filter | `filter` | choice |  | Cubic | Nearest (`nearest`), Linear (`linear`), Cubic (`cubic`) | How an image coarser than the terrain is read between its pixels: as blocks, with straight lines, or with smooth curves. A finer image is averaged, except with Nearest. |

### Import Heightmap

<a id="io-import-field"></a>`io/import-field`

Loads a PNG, TIFF, OpenEXR or raw image file as a terrain or a mask, and fails while no file is selected.

Also found by: load, open, file, image, png, tiff, exr, raw, r16, dem.

- Reads a file: until one is selected the node reports "No file selected".

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| File | `file` | file |  | no file | .png, .tif, .tiff, .exr, .r16, .r32, .r8, .raw | The image to load: PNG, TIFF, OpenEXR, or raw samples in a square file (.r16 and .raw 16 bits, .r8 8 bits, .r32 floats). |
| Channel | `channel` | choice |  | Red | Red (`red`), Green (`green`), Blue (`blue`), Alpha (`alpha`), Brightness (`luma`) | Which channel of a color image is read. Brightness weighs red, green and blue as the eye does. A gray image has one channel, which all but Alpha read. |
| Input minimum | `inMin` | number |  | 0 | 0 to 1 on the slider; any number can be typed | The value in the file that becomes height 0. Whole-number formats hold 0 to 1; a float file may hold meters. |
| Input maximum | `inMax` | number |  | 1 | 0 to 1 on the slider; any number can be typed | The value in the file that becomes height 1, the top of the height range. Below the minimum, it turns the image upside down. |
| Fit | `fit` | choice |  | Stretch | Stretch (`stretch`), Contain (`contain`), Cover (`cover`) | How an image that is not square is placed: stretched to the terrain, shown whole with level ground beside it, or filling the terrain with its ends cut off. |
| Filter | `filter` | choice |  | Cubic | Nearest (`nearest`), Linear (`linear`), Cubic (`cubic`) | How an image coarser than the terrain is read between its pixels: as blocks, with straight lines, or with smooth curves. A finer image is averaged, except with Nearest. |

<a id="ref"></a>

## Reference nodes

Small nodes the engine itself ships with. They are the templates node authors copy and the fixtures the tests use. They are not offered in the application: neither the Library panel nor the add-node palette lists them. A project file may name one, the command-line program draws one by its type, and a node of one that a file holds is drawn and computed like any other.

[Auto Level (Reference)](#ref-autolevel) · [Blur (Reference)](#ref-blur) · [Colorize (Reference)](#ref-colorize) · [Combine (Reference)](#ref-combine) · [Distance (Reference)](#ref-distance) · [Fail (Reference)](#ref-fail) · [Fractal Noise (Reference)](#ref-fbm) · [Image (Reference)](#ref-image) · [Slope Mask (Reference)](#ref-slope-mask) · [Talus (Reference)](#ref-talus)

### Auto Level (Reference)

<a id="ref-autolevel"></a>`ref/autolevel`

Stretches a terrain so that its lowest point is 0 and its highest is 1; the reference node for whole-field statistics.

Also found by: normalize, levels, stretch, range.

- Its result depends on measurements of the whole field, so a preview and the build can differ slightly.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a terrain (heights) | |

No parameters.

### Blur (Reference)

<a id="ref-blur"></a>`ref/blur`

Blurs a terrain or a color map with a Gaussian of the given radius; the reference node for separable filters.

Also found by: gaussian, smooth, soften.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a field or a colour map | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | the kind connected to `in` | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Radius | `radius` | number | length | 0.005 | 0.0001 to 0.25 on the slider; any number can be typed | Larger values spread the effect over a wider area. |

### Colorize (Reference)

<a id="ref-colorize"></a>`ref/colorize`

Colors a terrain by its height through a gradient, over an optional base color; the reference node for color nodes.

Also found by: gradient, ramp, tint, palette.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `base` | Base | a colour map | optional |
| Output | `out` | Out | a colour map | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Gradient | `gradient` | gradient |  | 0: 0.05, 0.12, 0.05; 0.2: 0.15, 0.25, 0.07; 0.4: 0.35, 0.33, 0.12; 0.6: 0.3, 0.2, 0.12; 0.8: 0.3, 0.29, 0.28; 1: 0.9, 0.92, 0.95 | stops at 0 to 1, colours in linear RGB | The colors of the terrain, from its lowest height on the left to its highest on the right. |
| Strength | `strength` | number | ratio | 1 | 0 to 1 | Larger values apply more of the effect. |

### Combine (Reference)

<a id="ref-combine"></a>`ref/combine`

Combines two terrains by mixing, adding, multiplying or taking the higher or lower; the reference node for two inputs.

Also found by: blend, mix, math, merge.

- Version 2: a project file stores this number as the node's `version`.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `a` | A | a terrain (heights) | required |
| Input | `b` | B | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Mode | `mode` | choice |  | Mix | Mix (`mix`), Add (`add`), Multiply (`multiply`), Maximum (`max`), Minimum (`min`) | How the second input is combined with the first. |
| Strength | `strength` | number | ratio | 0.5 | 0 to 1 | Larger values apply more of the effect. |

### Distance (Reference)

<a id="ref-distance"></a>`ref/distance`

Measures the distance to the nearest selected point, as a fraction of the terrain width; the reference node for CPU tasks.

Also found by: distance field, edt, proximity, falloff.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a mask (0 to 1) | required |
| Output | `out` | Out | data | |

No parameters.

### Fail (Reference)

<a id="ref-fail"></a>`ref/fail`

Raises the error typed into it, or passes its input on when there is none; the reference node for documented errors.

Also found by: error, throw, test.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Message | `message` | text |  | empty | at most 256 characters | The error the node raises. Left empty, the node passes its input on. |

### Fractal Noise (Reference)

<a id="ref-fbm"></a>`ref/fbm`

Generates fractal gradient noise; the reference node for generators.

Also found by: perlin, fbm, noise.

- Random: the node's seed is combined with the project seed.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Seed | `seed` | seed |  | 0 | 0 to 4294967295 | Another value gives another random variation of the same kind. |
| Feature size | `size` | number | length | 0.25 | 0.001 to 4 on the slider; any number can be typed | Larger values give broader features. |
| Octaves | `octaves` | whole number |  | 8 | 1 to 16 | Larger values add finer layers of detail. |
| Roughness | `gain` | number | ratio | 0.5 | 0 to 1 | Larger values keep more of the fine detail and give a rougher surface. |

### Image (Reference)

<a id="ref-image"></a>`ref/image`

Loads the first channel of a PNG image as a terrain, and fails while no file is selected; the reference node for file inputs.

Also found by: import, heightmap, png, file.

- Reads a file: until one is selected the node reports "No file selected".

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Output | `out` | Out | a terrain (heights) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| File | `file` | file |  | no file | .png | The image to load. Black is the lowest height and white the highest. |

### Slope Mask (Reference)

<a id="ref-slope-mask"></a>`ref/slope-mask`

Selects terrain by its slope, from 0 at the lower angle to 1 at the upper; the reference node for mask producers.

Also found by: steepness, angle, cliff, select.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Output | `out` | Out | a mask (0 to 1) | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Lower slope | `slopeMin` | number | angle | 20 | 0 to 90 | Terrain no steeper than this is left out. |
| Upper slope | `slopeMax` | number | angle | 45 | 0 to 90 | Terrain at least this steep is fully selected. |

### Talus (Reference)

<a id="ref-talus"></a>`ref/talus`

Relaxes slopes steeper than the talus angle and maps the height that crossed each texel; the reference node for iterative simulations.

- Maskable: connect a mask to limit where the node acts.

| | Port | Label | Carries | |
| --- | --- | --- | --- | --- |
| Input | `in` | In | a terrain (heights) | required |
| Input | `mask` | Mask | a mask (0 to 1) | optional; limits the node's effect on `out` to where the mask is set |
| Output | `out` | Out | a terrain (heights) | |
| Output | `moved` | Moved | data | |

| Parameter | Name | Kind | Unit | Default | Range or choices | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| Talus angle | `talus` | number | angle | 35 | 0 to 90 | Slopes steeper than this collapse. |
| Reach | `reach` | number | length | 0.02 | 0.001 to 0.25 | How far material can travel downslope. |
