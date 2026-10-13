# Importing a build into Unreal Engine 5.8

You have built a project ([Building and exporting](building.md)) and hold a folder with a heightmap, layer
files, textures and the manifest `<Name>.orogen.json`. This page brings that folder into Unreal Engine 5.8 as
a Landscape.

**Importing by hand is the supported way.** It is about fifteen fields and one file per layer, every value
copied from the manifest. An experimental editor plugin can do the same in one call, but its source has
never been compiled (section 7).

**Read this before you trust anything here.** Unreal Engine's source is not public, and nothing of Orogen's
has been run in Unreal Engine: not this procedure, not the plugin, not a single file. The steps were written
from Epic's documentation for 5.8 and from other people's reports. The acceptance test of section 6 settles,
on your engine, the unconfirmed statements that matter.

| Section | |
| --- | --- |
| 1 to 3 | the import by hand |
| 4 | known problems of Unreal Engine and their workarounds |
| 5 | a worked example with the numbers of a real build |
| 6 | the acceptance test |
| 7 | the experimental plugin |
| 8 | everything that is still unverified, in one list |

Each statement about Unreal says how far it has been checked:

- **confirmed**: read in Epic's documentation or API reference for 5.8.
- **third party**: confirmed only by someone other than Epic.
- **derived**: computed from confirmed facts.
- **unconfirmed**: recalled, inferred, or reported by users; not confirmed for 5.8. The wording of menus and panels in the steps below was not checked item by item and is unconfirmed unless a step says otherwise.

Nobody at Orogen has run this procedure in Unreal Engine. Run the acceptance
test (section 6) once on your engine version before you trust an import.

## 1. Before you start

1. Build the project in Orogen into a folder of its own. The folder belongs to Orogen: each build replaces everything in it, and Orogen refuses to build into a folder that holds anything but an earlier build, so keep the project file and your own files elsewhere. You need `<Name>.orogen.json` (the manifest), `<Name>Height.png`, one `Layer<X>.png` per layer, and the `T_*.png` textures.
2. Do not rename the heightmap or layer files and do not copy other images into the folder. Their names are letters only on purpose (section 4, item 3).
3. Use Unreal Engine 5.8.3 or later. 5.8.2 fixed a crash when editing landscape layers in Landscape Mode (confirmed, hotfix notes). Earlier 5.8 versions have the material problem of section 4, item 2; whether 5.8.3 is free of it is unconfirmed.
4. Open the manifest in a text editor. Every number below is copied from it with all its digits. A horizontal scale shortened to two decimals moves the far edge of an 8 km terrain by about 40 cm (derived).
5. Make the landscape material first if you import layers. Target layers take their names from the layer names used in the landscape material (confirmed); names are case-insensitive and must equal the `name` values under `landscape.layers`. Whether the import panel offers a layer that the material does not name is unconfirmed.

## 2. Steps

1. Open or create the level. If the level uses World Partition and the landscape is 8129 × 8129, read section 4, item 1 first.
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

## 3. Importing a rebuilt terrain

There is no tested procedure for replacing the heights of a landscape that
already exists. Two facts bear on it:

- With Height range set to Measured, the scale and location in the manifest change with every build. Replacing only the heightmap of an existing landscape would then be wrong, and changing the actor's scale rescales everything sculpted on it. Set Height range to Fixed before the first import if you intend to re-import (derived).
- The editor can import into an existing landscape (confirmed); the steps are unconfirmed.

## 4. Known risks and workarounds

1. **Repeated tiles after importing 8129 × 8129 into a World Partition level.** One user reports that importing a single 8129 × 8129 16-bit PNG into a World Partition level shows one part of the heightmap repeated 4 × 4 or 16 × 16 times, with a correct wireframe and wrong shading, on 5.7.0, 5.7.4 and 5.8.0; it worked on 5.5.4 and 5.6.1. Epic has not replied and there is no ticket (forum report of 2026-08-24; confirmed as a report, not reproduced by Orogen; the state on 5.8.3 is unknown). This is exactly an Orogen build at its largest size. The reporter's workaround: import into a level without World Partition, then convert the level to World Partition. Check with the acceptance test at 8129 before you rely on a World Partition import.
2. **Wrong output of the Landscape Layer Blend material node.** The node gave washed-out or wrong specular, and in some cases a grey Nanite landscape, on 5.8.0 to 5.8.2 (first report 2026-06-26, Epic ticket UE-386355). The ticket was closed as fixed; a user reported on 2026-08-26 that 5.8.2 did not fix it; Epic staff said on 2026-08-27 it would be reopened and on 2026-09-07 that it would be addressed in 5.8.3. The 5.8.3 notes do not mention it, so whether 5.8.3 fixes it is unconfirmed. Two workarounds reported by users on early 5.8, both unconfirmed: feed single attributes such as Specular through the blend node instead of Material Attributes; or use Final Weight Blending (Legacy) instead of Advanced Weight Blending. For the second, set Layer blend method to Final on Orogen's Unreal Landscape node and build again: the manifest then says `"blend": "final"`.
3. **Heightmap file names.** Users have met the import error `doesn't have proper pattern(ex: _x0_y0.png)` on ordinary single files and reported that it went away after removing digits from the file name, avoiding spaces and special characters, removing similarly named PNG files from the same folder, deleting temporary copies left by an image editor, or deleting the stale asset and importing again (forum threads about UE 5.0, posts from 2022 to 2024). The cause is unconfirmed, and none of it has been reproduced on 5.8. Orogen's file names and its rule of one folder per build are a precaution against it.
4. **Too many layers on a component.** A report for 5.8 says that merging edit layers makes each component inherit its left and top neighbours' layers, so that with about ten or more layers a component exceeds Direct3D 12's limit of 64 shader resources and silently falls back to the default material (forum report of 2026-08-12, no reply from Epic; unconfirmed). Keep the number of layers low: aim for at most 8, and Orogen warns above 12.
5. **World Partition Region Size 4.** On 5.5.4, creating a landscape with Region Size 4 fails an assertion; 5 and 8 work (forum report of 2026-07-31; the state on 5.8 is unknown). Orogen warns when the value is 4.
6. **Stale image size.** The editor caches an image file's resolution; after a build at another resolution it can keep the old size until another file is selected (third party, observed on 5.5.3). Select a different file and then the right one again.
7. **Slow imports.** QuadSpinner reports slow landscape imports since 5.5, most of all with World Partition, and attributes them to the engine (third party).

## 5. A worked example

`examples/ridge.orogen` is a mountain range on a terrain 2000 m wide with a height range of 500 m and the sea
level at height 0. It builds at 1009 × 1009 vertices, with one weight-blended layer, `Rock`, on its steep
ground, and a normal texture.

```
node src/cli/main.ts build docs/user/examples/ridge.orogen --out D:\Build\Ridge
```

The values below are those of `Ridge.orogen.json` from a build on Orogen's development machine (Linux, GTX
1660 Ti). They were checked against the files of that build. **Type the numbers of your own manifest**: the
ones that depend on the measured heights differ in their last digits from one graphics card to the next, and
change with the resolution.

| Step of section 2 | Field in Unreal | Member of the manifest | In this build |
| --- | --- | --- | --- |
| 3 | Heightmap File | `landscape.heightmap.png` | `RidgeHeight.png` |
| 6 | Section Size | `landscape.layout.quadsPerSection` | 63: 63x63 quads |
| 6 | Sections Per Component | `landscape.layout.sectionsPerComponent` | 2: 2x2 |
| 6 | Number of Components | `landscape.layout.components` | 8 x 8 |
| 6 | Overall Resolution | `resolution` | 1009 x 1009 |
| 7 | Scale X | `landscape.transform.scaleCm.x` | 198.4126984126984 |
| 7 | Scale Y | `landscape.transform.scaleCm.y` | 198.4126984126984 |
| 7 | Scale Z | `landscape.transform.scaleCm.z` | 73.20720416198763 |
| 8 | Location X | `landscape.transform.uiLocationCm.x` | 0 |
| 8 | Location Y | `landscape.transform.uiLocationCm.y` | 0 |
| 8 | Location Z | `landscape.transform.uiLocationCm.z` | 18741.044265468834 |
| 8 | Rotation | `landscape.transform.rotationDeg` | 0, 0, 0 |
| 10 | layer `Base` | `landscape.layers[0]` | `"blend": "advanced"`: Weight-Blended Layer, Advanced Weight Blending; file `LayerBase.png` |
| 10 | layer `Rock` | `landscape.layers[1]` | `"blend": "advanced"`: Weight-Blended Layer, Advanced Weight Blending; file `LayerRock.png` |
| 10 | Layer Alphamap Type | `landscape.alphamapType` | Additive |
| 11 | World Partition Grid Size | `landscape.worldPartition.gridSize` | 4 |
| 11 | World Partition Region Size | `landscape.worldPartition.regionSize` | 32 |
| 13 | the actor's Location, afterwards | `landscape.transform.actorLocationCm` | -100000, -100000, 18741.044265468834 |
| 13 | the actor's Scale, afterwards | `landscape.transform.scaleCm` | 198.4126984126984, 198.4126984126984, 73.20720416198763 |
| 16 | texture `T_Normal_1024.png` | `textures[0]` | `"srgb": false`: switch sRGB off. Extent = 2000 × 100 = 200000, so U = (WorldX + 100000) / 200000 and V = (WorldY + 100000) / 200000 |

Where the numbers come from (derived):

```
scale X, Y    200000 cm / 1008 quads                                   = 198.4126984126984
stored range  heights 0 to 0.749630331993103 of 500 m                  = 37481.51659965515 cm
scale Z       37481.51659965515 × 128 / 65535                          = 73.20720416198763
one level     scale Z / 128                                            = 0.5719312825155284 cm
location Z    world height of level 0 (0 cm) + 256 × scale Z           = 18741.044265468834
```

What the landscape should then look like. These follow from the manifest and the heightmap of this build by
the formulas of section 6 (derived); that Unreal agrees is what section 6 tests (unconfirmed):

- It spans X and Y from -100000 to +100000 cm.
- Its level ground lies at Z = 0 and its highest point at Z = 37481.52 cm, 374.8 m above it.
- The highest sample of the heightmap is at column 423, row 547. That is world X = -100000 + 423 ×
  198.4126984126984 = -16071.43 cm and Y = -100000 + 547 × 198.4126984126984 = 8531.75 cm.
- Layer `Rock` covers the steep flanks of the range and `Base` everything else; at every point the two total
  255.

Three things this example shows:

- **Copy every digit.** With the horizontal scale shortened to 198.41 the far edge of this small terrain
  would lie 2.7 cm short (derived); on 8 km it is about 40 cm.
- **The numbers belong to one build.** The same project built with `--res 4033` has Scale X = Y =
  49.6031746031746 and Scale Z = 73.22068526196045, because the finer grid finds a slightly higher summit. On
  a software adapter the build at 1009 has Scale Z = 73.20723326626218.
- **Level ground and Dither.** The plain around the range is exactly level, so with Dither on it is written
  as levels 0 and 1, which are 0.57 cm apart. If that shows in Unreal's shading, build with Dither off.

## 6. The acceptance test

The test settles the unconfirmed statements that an import depends on: which way round the landscape lies,
how a stored value becomes a height, what the panel's Location means, whether layers lie like the heights,
and whether the repeated-tile problem of section 4 affects you. Run it once per engine version, and again at
8129 before you trust an import into a World Partition level.

### 6.1 The pattern

```
node src/cli/main.ts unreal-test --out D:\Build\Marker
```

writes a complete build named `Marker`, without a project and without a graphics card. `--res` chooses its
resolution `N`: 1009 (the default), 2017, 4033 or 8129. `step` is 16, 8, 4, 2 for these.

Its heightmap, as stored values from 0 to 65535, without dither:

| Where in the image (columns × rows) | Stored value | Name |
| --- | --- | --- |
| everywhere else | 32768 | the plain |
| columns 0 to 63, rows 0 to 63 | 65535 | the tower: 64 × 64, at the image's top left |
| columns `N − 64` to `N − 1`, rows 0 to 31 | 0 | the pit: 64 wide and 32 rows deep, at the top right |
| all columns, rows `N − 32` to `N − 1` | `32768 + step × column` | the ramp: along the bottom edge, rising to the right |

Its manifest states the transform directly: scale (100, 100, 100), `actorLocationCm` (0, 0, 0) and
`uiLocationCm` (`50 × (N − 1)`, `50 × (N − 1)`, 0), which is (50400, 50400, 0) at 1009. That is a terrain of
`N − 1` metres with its first vertex at the world origin, 100 cm per quad, and the plain at world height 0.

Its layers are `Base` (weight-blended, the remainder), `Left` (weight-blended; full where the column is below
`(N − 1) / 2`, else empty) and `Top` (not weight-blended; full where the row is below `(N − 1) / 2`). Its
texture `T_Marker_1024.png` is red in the quarter of the tower, green in the quarter of the pit, blue in the
bottom-left quarter and white in the bottom-right quarter.

The files `orogen unreal-test` writes at 1009 were read back and hold exactly this.

### 6.2 Expected result

Import the build as in section 2 (or with the plugin), then check in the editor, with the pointer's world
position or with an actor you place. Checks 10 to 12 need a way to see the layers and the texture: a
landscape material that names the layers `Base`, `Left` and `Top` and samples `T_Marker_1024.png`.

Heights follow this formula (derived from two statements of Epic's documentation; that the engine's own
constants have these values is unconfirmed):

```
world Z = actor Z + (stored value − 32768) / 128 × scale Z
```

| # | Check | Expected | A different result means |
| --- | --- | --- | --- |
| 1 | The Landscape actor's Location and Scale after the import | (0, 0, 0) and (100, 100, 100) | Location = `uiLocationCm`: the panel's Location is the actor's origin, not the centre. Use `actorLocationCm` on the actor (section 2, step 13) |
| 2 | The landscape's extent | X and Y from 0 to `100 × (N − 1)` cm: 100800 at 1009 | another extent: the size or the XY scale was changed by the importer |
| 3 | Where the tower is | at the corner of smallest X and smallest Y; its top spans X 0 to 6300, Y 0 to 6300 | at smallest X, largest Y: rows are flipped. At largest X, smallest Y: columns are flipped. At largest X and Y: both |
| 4 | Where the pit is | at largest X, smallest Y, longer along X (6300 cm) than along Y (3100 cm) | at smallest X, largest Y and longer along Y: X and Y are exchanged |
| 5 | Where the ramp is | along the edge of largest Y, rising with X | along smallest Y: rows are flipped. Along an X edge: X and Y are exchanged |
| 6 | Height of the plain | Z = 0 | Z ≠ 0: the stored value 32768 is not the actor's Z |
| 7 | Height of the tower's top | Z = +25599.22 cm | another value: the height formula is wrong |
| 8 | Depth of the pit's floor | Z = −25600 cm | another value: the height formula is wrong |
| 9 | Height on the ramp at column `c` | Z = `0.78125 × step × c` cm; at 1009, X = 80000 cm gives Z = 10000 cm exactly | a proportional error: the Z scale formula is wrong |
| 10 | Layer `Left` (layer visualisation, or a material showing it) | covers the half of smallest X | the other half: layers are oriented differently from heights |
| 11 | Layer `Top` | covers the half of smallest Y | |
| 12 | The texture, sampled with the formula of section 2, step 16 | red on the tower's quarter, green on the pit's | exchanged colours: the texture's U or V runs the other way |
| 13 | The whole landscape, at 8129 in a World Partition level | one tower, one pit, one unbroken ramp | several towers or a sawtooth ramp: the repeated-tile problem of section 4, item 1 |

Checks 3 to 5 tell apart all eight ways an image can be mirrored, turned or transposed, because the three
markers sit on different corners and edges and the pit is not square.

### 6.3 Round trip

Export the landscape's heightmap from Unreal as a 16-bit PNG or `.r16` (Unreal exports both: confirmed) and
run

```
node src/cli/main.ts unreal-test --check D:\Build\Exported.png
```

It decodes the file, makes the pattern again and prints how many samples differ and the largest difference.
Exit code 0 means every sample is identical. The pattern's resolution is taken from the size of the file.
That an unmodified import exports identical values is the expectation under test (unconfirmed).

To settle how Unreal reads `.r16` (statement 4 of section 8), import the pattern once more from
`MarkerHeight.r16` instead of the PNG, export that landscape's heightmap as a PNG, and check the PNG. A PNG
states its own byte order, so a pass means that Unreal read the `.r16` as little-endian (derived).

### 6.4 What to do with the outcome

- **All checks pass:** the statements of section 8 that the test settles hold on your engine version. Note
  the version.
- **A check fails:** do not work around it in your project. A failed check is a defect of Orogen's
  conventions: the table says which one, and the fix belongs in Orogen's export, not in a node of your graph.
  Report it with the engine version and the number of the check.

Either way the result belongs in this page, in place of the word "unconfirmed" on the statements it settles.

## 7. The experimental plugin

`unreal/OrogenBridge` in the repository is the C++ source of an Unreal editor plugin with one function,
`ImportTerrain`, that reads a manifest and creates the landscape with its layers, its transform, its material
and its World Partition grid: steps 2 to 13 of section 2 in one call.

**Its source has never been compiled, loaded or run.** Orogen's development machine and its automated checks
have no Unreal Engine. No binary is shipped. It is an option only if you can compile and debug an editor
plugin, and it does not replace anything on this page:

- You need a C++ project and the tools Epic requires for building one with 5.8.
- Expect compile errors on the first build. The plugin keeps every landscape call in one file,
  `OrogenLandscapeCompat.cpp`, and marks each call whose signature or behaviour could not be verified.
- It was written against the API reference of 5.8 and refuses to compile on any other engine version.
- It reads Orogen's `.r16` and `.r8` files itself, not the PNG files, so what Unreal's own importer does with
  file names and with the byte order of `.r16` does not concern it.
- It does not import textures, enable Nanite, re-import into an existing landscape, or import region by
  region.
- Whether it avoids the repeated-tile problem of section 4, item 1 is unconfirmed.
- Everything in section 8 about orientation, location and heights applies to it as it does to the import by
  hand. Run the acceptance test with it first.

Its own page, [`unreal/OrogenBridge/README.md`](../../unreal/OrogenBridge/README.md), says how to install it,
how to call it from Python or an Editor Utility Widget, what to expect on the first compile, and which
questions only a run answers.

## 8. What is still unverified

These are the unconfirmed statements an import depends on, and what settles each.

| # | Statement | Used for | Settled by |
| --- | --- | --- | --- |
| 1 | Image columns run along +X and image rows along +Y, with pixel (0, 0) at the actor's origin and nothing mirrored | every file | section 6.2, checks 3 to 5 |
| 2 | The actor's location is vertex (0, 0) at the stored value 32768, and one stored step is 1/128 of the Z scale | scale and location | section 6.2, checks 6 to 9 |
| 3 | The New Landscape panel's Location is the landscape's centre | `uiLocationCm`, section 2, step 8 | section 6.2, check 1 |
| 4 | `.r16` is little-endian | the `.r16` file | section 6.3 with an `.r16` |
| 5 | Layer files are oriented like the heightmap | layers | section 6.2, checks 10 and 11 |
| 6 | Unreal's normal-map convention matches the way Orogen stores normals | the normal texture | a lighting check in your material |
| 7 | A single 8129 × 8129 import into a World Partition level works on your engine version | the largest size | section 6.2, check 13 |
| 8 | An unmodified import exports identical heights | importing again later | section 6.3 |
| 9 | Regular textures must be a power of two, and 8192 is safe as a regular texture | textures | importing a `T_*_8192.png` |
| 10 | The plugin's sequence of calls compiles and works on 5.8.3 | section 7 | compiling and running it |
| 11 | The plain file names are needed, or enough | file names | not testable by one check; kept as a precaution |
| 12 | The defaults of World Partition Grid Size and Region Size; what Region Size 4 does on 5.8; what Flip Y Axis does to a single file | section 2 | watching the import |

Also unverified, because Orogen itself has not been run there: building on Windows with a graphics card
([Getting started](getting-started.md)).
