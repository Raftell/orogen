# Building and exporting

A **build** computes the whole graph at the project's build resolution and writes the files Unreal Engine
imports. This page says what decides the files, where they go, what is in them, and what can go wrong.
[Importing into Unreal Engine 5.8](unreal-import.md) takes over where this page ends.

The build pipeline is built and tested on Linux, on an NVIDIA card and on a software adapter, and its tests
pass on Windows' software adapter in the project's automated checks, the swap of the output folder included.
It has not been run on a Windows machine with a graphics card, nor beside the programs such a machine runs.
What the files do in Unreal Engine has not been tried by anyone at Orogen: wherever this page says what Unreal
will do with a file, the import guide says how far that has been checked.

## 1. Export nodes decide what is written

A build writes for every **export node** of the graph whose **Enabled** switch is on. Nothing else matters:
not which node is selected, not where a node sits. The build computes exactly the nodes that lead to those
export nodes.

| Node | Type | Takes | Writes |
| --- | --- | --- | --- |
| **Unreal Landscape** | `io/export-landscape` | a terrain | the landscape's heightmap, and with it everything that is one per landscape: scale, location, layout. At most one per build |
| **Landscape Layer** | `io/export-layer` | a mask | one landscape target layer, the weights a landscape material paints with |
| **Color Texture** | `io/export-color` | a colour map | a colour texture for materials; with **Content** Data, a texture of three data channels: a normal map or packed masks made in the graph |
| **Mask Texture** | `io/export-mask` | a mask | a grey texture for materials, 8 or 16 bits |
| **Normal Texture** | `io/export-normal` | a terrain | a normal map computed from the terrain's real slopes |
| **Image File** | `io/export-field` | any field | one image for other tools: PNG, raw, OpenEXR or TIFF |

The [node reference](nodes.md#io) lists every parameter. Rules:

- An enabled export node with nothing connected stops the build (`E_INPUT_MISSING`).
- A Landscape Layer needs an Unreal Landscape node in the same build. Textures and image files do not.
- A build that would write nothing is an error, never an empty success.

## 2. Running a build

```
node src/cli/main.ts build docs/user/examples/ridge.orogen --out D:\Build\Ridge
```

[The command-line page](command-line.md#build) lists the options and exit codes. In the desktop application the
**Build** panel runs the same pipeline: it has the resolution, the output folder of the project, **Build**
(`Ctrl+B`, also **Engine → Build**) and **Cancel**, the progress, the list of files that were written and the
values Unreal's import panel asks for, read from the manifest. The first build of a project asks for its
output folder; later builds use the same one until you choose another
([the desktop application](application.md#build)).

### The output folder belongs to Orogen

Give every project a build folder of its own, and keep nothing else in it.

- Orogen builds into a folder that **does not exist**, is **empty**, or holds **an earlier Orogen build and
  nothing else**. Each successful build replaces everything in it, so a file left over from an earlier build
  with other layer names cannot survive.
- Any other folder is refused, with `E_OUT_DIR`, and nothing in it is touched:

  ```
  orogen build: error E_OUT_DIR: Cannot build into this folder: D:\Projects\Ridge holds files and no Orogen
  build manifest (*.orogen.json); the output folder belongs to Orogen, which replaces everything in it, so
  choose an empty or a new folder, or move what is not the build's away.
  ```

  So do not build into the folder that holds your project file, and do not save your own files into a build
  folder: a build folder with a foreign file in it is refused too.
- While a build runs, Orogen writes into a folder beside the output folder, `<dir>.partial`, and swaps it in
  when everything has succeeded. For a moment the old build is kept as `<dir>.previous`. Both names beside
  your output folder are Orogen's; the disk holds the old and the new build until the swap.
- **A build that fails or is cancelled changes nothing in the output folder.** When it got as far as
  computing, its report is in `<dir>.partial`, and the next build removes that folder.
- **On Windows, close what holds the folder.** The swap renames the output folder, which Windows refuses while
  another program holds the folder or a file in it: a terminal whose current folder it is, an image viewer, a
  virus scanner or a cloud-sync client that is still reading what was just written, possibly Unreal Engine
  after an import. Orogen does not try again. Build into a folder that is not synchronised: on Windows 11 the
  folders *Documents* and *Desktop* often are, by OneDrive. The build then ends with `E_COMMIT_FAILED`, the complete build stays in `<dir>.partial`,
  and the old one is put back; close the other program and build again. A file that cannot be given its name
  while the build writes ends it with `E_WRITE_FAILED`. Neither has been seen on Windows: nobody has built there
  with other programs open.

## 3. What a build writes

`<Name>` is the Unreal Landscape node's **Name**, reduced to its letters and with a capital first letter:
`alps 01 (wet)` becomes `Alpswet`. Without a landscape node it is `Export`.

| File | From | Contents |
| --- | --- | --- |
| `<Name>Height.png` | Unreal Landscape | the heightmap as a 16-bit grey PNG. This is the file you choose in Unreal |
| `<Name>Height.r16` | Unreal Landscape | the same values as raw 16-bit numbers, little-endian, first row first, no header |
| `Layer<X>.png`, `Layer<X>.r8` | every layer, the base layer included | the layer's weights, 8 bits, at exactly the landscape's resolution, as PNG and as raw bytes. `<X>` is the layer name reduced to its letters |
| `T_<name>_<size>.png` | Color, Mask and Normal Texture | a square texture whose side is a power of two |
| `<name>.png`, `.r16`, `.r32`, `.exr`, `.tif` | Image File | one image at the build resolution |
| `<Name>.orogen.json` | every successful build | **the manifest**: which file is which, and every number for the import |
| `<Name>.report.json` | every build that got as far as computing | times, measured heights, warnings |

The example writes `RidgeHeight.png`, `RidgeHeight.r16`, `LayerBase.png`, `LayerBase.r8`, `LayerRock.png`,
`LayerRock.r8`, `T_Normal_1024.png`, `Ridge.orogen.json` and `Ridge.report.json`: nine files in the folder.
**The number of files a build states is one less**, eight here: it counts what the manifest lists, the
manifest included, and not the report, which is about the build and no part of it. The command line, the Build
panel and the tables of this guide all count that way.

**Why the names are so plain.** The files Unreal's landscape importer reads have names made of letters only.
Users have reported import errors that went away when digits, spaces and similar file names were removed
(unconfirmed, and not reproduced on 5.8; [known risks](unreal-import.md#4-known-risks-and-workarounds), item
3). One consequence: two layers named `Rock1` and `Rock2` would both be `LayerRock.png`, and the build refuses
them (`E_FILE_COLLISION`). Name them `RockA` and `RockB`.

**Names Windows keeps for itself.** An Image File named `con`, `prn`, `aux`, `nul`, `com1` to `com9` or
`lpt1` to `lpt9`, and an Unreal Landscape whose name reduces to one of these words, would be written as
`nul.png` or `Con.orogen.json`: Windows has long treated such names as devices, whatever follows the dot.
Orogen does not refuse them. Choose another name.

**The manifest is the only authority** on which file is which. Nothing is ever told apart by its position in
a folder listing.

## 4. Heights

A heightmap stores 65536 levels. Which heights of your terrain become the lowest and the highest level is the
choice **Height range** of the Unreal Landscape node:

| Height range | Stores | Use it when |
| --- | --- | --- |
| **Measured** (default) | exactly from the terrain's lowest to its highest point, measured during the build. No level is wasted | you import once |
| **Fixed** | from **Lowest height** to **Highest height**, as you set them. Terrain outside is clipped, and the build warns with the number of clipped samples (`W_HEIGHT_CLIPPED`) | you will build and import again. With Measured, the scale and location that go into Unreal change with every build, because the measured extremes change |

- **Headroom** (Measured only) widens the stored range by a share of itself at both ends, leaving room to
  sculpt above the summits and below the valleys in Unreal.
- A terrain flatter than 1 m is stored over a range of 1 m around its middle (`W_FLAT`).
- **Dither** (on by default) adds noise of one level before rounding. Without it, gentle slopes become
  terraces: with 2400 m of relief one level is 3.66 cm, and over quads of 98 cm that is a smallest slope of
  2.1 degrees. With it, ground that is exactly level is written as two or three neighbouring levels: in the
  example's build, 58 % of the samples are level 0 and 8 % level 1, where one level is 0.57 cm. Turn Dither
  off for a terrain with large, exactly level surfaces.
- **Zero height** says which height lies at world height 0 in Unreal: the project's sea level (default) or
  the bottom of the height range.
- **Origin** says which point lies at the world origin: the terrain's centre (default) or the corner of the
  first row and column.

From these the build computes what Unreal needs, and writes it to the manifest:

```
scale X = scale Y = terrain size in cm / (resolution − 1)          cm per quad
scale Z           = stored height range in cm × 128 / 65535
location          = the corner of the first row and column, at the middle level 32768
```

The arithmetic is checked by Orogen's tests. That Unreal places a landscape by its first corner at the middle
level, and reads one level as 1/128 of the Z scale, comes from Epic's documentation only in part (statements
2 and 3 in [the list of what is unverified](unreal-import.md#8-what-is-still-unverified)).

For exactly 100 cm per quad, set the terrain size to the resolution minus one, in metres: 8128 m at 8129.

## 5. Layers

A **Landscape Layer** node writes one target layer. Its **Layer name** must equal the layer name used in your
landscape material; names are letters, digits and underscores, begin with a letter, and must differ in more
than capitals.

- **Weight-blended** layers (the default) share the weight of every point. The build adds one more layer, the
  **base layer** (named `Base`; the Unreal Landscape node's **Base layer** changes the name), which receives
  whatever the others leave. At every point the weights of the base layer and the weight-blended layers total
  exactly 255, so no ground is unpainted. Weights that total 255 satisfy both of Unreal's weight blending
  methods as they are (derived from Epic's description of the two). Where your masks total more than 1, they
  are scaled down in proportion and the base gets nothing.
- A layer with **Weight-blended** off is an independent mask from 0 to 255: the vehicle for masks that a
  material reads, such as flow, wetness or snow.
- **Layer floor** sets weights below a small share (0.8 % by default) to zero, and **Layers per point** keeps
  only the strongest layers at each point. Both exist because computed masks are a little above zero almost
  everywhere, which would keep every layer alive on every component of the landscape, where Unreal otherwise
  drops the layers a component does not use (derived). The defaults are starting values that nobody has
  tuned in Unreal.
- **Layer blend method** (Advanced or Final) is the weight blending method the manifest names for the base
  and the weight-blended layers. Data that totals 255 suits both.
- A build takes at most 15 weight-blended layers, and warns above 12 layers in all (`W_MANY_LAYERS`). Aim for
  far fewer: [known risks](unreal-import.md#4-known-risks-and-workarounds), item 4.

## 6. Textures and image files

**Color, Mask and Normal Texture** write textures for materials. They are not landscape data, so they are
resampled to a power of two: **Size** Auto is the smallest power of two that is at least the build resolution
minus one, from 1024 to 8192 (1024 for a build at 1009, 4096 at 4033, 8192 at 8129).

- A texture covers the landscape from its first to its last vertex. A material samples it with
  `U = (WorldX − location X) / extent`, `V = (WorldY − location Y) / extent`, where the location is the
  manifest's `actorLocationCm` and the extent the terrain size in centimetres.
- A colour texture holds sRGB colour; a mask or a normal texture holds data. The manifest says which
  (`srgb`), and you switch sRGB off in Unreal for the data textures.
- **Content** of a Color Texture says what its three channels are. **Color**, the default, is a colouring:
  the file is sRGB-encoded, as a base colour texture is. **Data** is for a colour map that holds numbers
  and no colour: a normal map made with a Normal Map node, or masks packed into red, green and blue with
  Pack Channels. The file then holds the values as they are and the manifest says `"srgb": false`. Left on
  Color, such a texture would come out too bright in Unreal: a level normal's 0.5 would be stored as 188
  instead of 128. The alpha channel is not written in either case: a texture has three channels.
- A normal texture stores the normal's X, Y and Z in red, green and blue, in the landscape's own axes.
  Whether Unreal's default handling of normal maps expects the green channel this way is unconfirmed; if
  lighting from the texture is inverted along Y, flip the green channel in Unreal. Unreal shades a landscape
  from its heightmap without any normal map (confirmed); this texture is an extra for materials.

**Image File** writes one field as it is, at the build resolution, for other programs: `PNG, 8 bits`, `PNG,
16 bits`, `Raw, 16 bits`, `Raw, 32-bit float`, `OpenEXR, 32-bit float`, `TIFF, 16 bits` or `TIFF, 32-bit
float`. The float formats keep the values unchanged. The whole-number formats store either 0 to 1 or, with
**Value range** Measured, the field's own lowest to highest value; the manifest records which two values
became black and white.

## 7. Resolutions a landscape can have

An Unreal landscape is made of components of fixed sizes, so only certain resolutions fit. Orogen's four
presets, with these layouts, are rows of Epic's table of recommended landscape sizes (confirmed):

| Build resolution | Section size | Sections per component | Components | Quads per side |
| --- | --- | --- | --- | --- |
| 1009 | 63 × 63 quads | 2 × 2 | 8 × 8 | 1008 |
| 2017 | 63 × 63 quads | 2 × 2 | 16 × 16 | 2016 |
| 4033 | 63 × 63 quads | 2 × 2 | 32 × 32 | 4032 |
| 8129 | 127 × 127 quads | 2 × 2 | 32 × 32 | 8128 |

A custom build resolution that no layout fits stops a build with an Unreal Landscape node:

```
orogen build: error E_SIZE_NOT_LANDSCAPE: Unreal Landscape: 2049 x 2049 is not a size an Unreal landscape
can have; the nearest valid build resolutions are 2033 and 3025.
```

Orogen never pads, crops or resamples a heightmap to make it fit, and writes one file whatever the size:
there is no tiled export.

## 8. The manifest and the report

`<Name>.orogen.json` is written last, so a folder without it is not a build. It is plain JSON; open it in a
text editor. The members you use:

| Member | Holds |
| --- | --- |
| `resolution` | vertices per side |
| `terrain` | the project's terrain size and height range in metres, and its sea level |
| `landscape.layout` | section size, sections per component and number of components |
| `landscape.heightmap` | the two heightmap files; which normalised heights (`valueMin`, `valueMax`) and which world heights in metres (`heightMinM`, `heightMaxM`) the lowest and highest level stand for; the measured extremes; the number of clipped samples; whether the heights are dithered |
| `landscape.transform.scaleCm` | the scale to type into Unreal |
| `landscape.transform.uiLocationCm` | the location to type into the import panel: the terrain's centre |
| `landscape.transform.actorLocationCm` | the location the Landscape actor must show afterwards: its first corner |
| `landscape.seaLevelZCm` | the world height of the project's sea level |
| `landscape.worldPartition` | the World Partition grid and region sizes from the Unreal Landscape node |
| `landscape.layers` | every layer: its name, its two files, its blend method (`advanced`, `final` or `none`), whether it is the base layer, and its mean weight |
| `textures`, `images` | every texture and image file with its size and whether it holds sRGB colour |
| `files` | every file of the build with its size in bytes |

Numbers are written with all their digits. Copy them whole.

`<Name>.report.json` holds what happened: start and end time, the time each export took, the time the layer
weights took (`weightsMs`) and the time it took to finish the files and put them in place (`commitMs`), the
most graphics memory the build held at once (`peakPoolBytes`, in bytes), the measured lowest and highest
height, every warning and error. The manifest holds no time, so that the same project builds to
the same bytes.

## 9. Problems a build reports

Every problem has a code and one sentence that names the node. Errors stop the build; warnings do not.

| Code | Means |
| --- | --- |
| `E_NOTHING_TO_EXPORT` | no enabled export node |
| `E_INPUT_MISSING` | an enabled export node has nothing connected |
| `E_RESOLUTION` | the build resolution is not a valid one |
| `E_SIZE_NOT_LANDSCAPE` | the resolution is not a size a landscape can have |
| `E_SEVERAL_LANDSCAPES` | more than one enabled Unreal Landscape node |
| `E_LAYER_WITHOUT_LANDSCAPE` | a Landscape Layer without an Unreal Landscape node |
| `E_NAME_INVALID` | a name has no usable character, or too many, or is one Windows keeps for a device (`Con`, `Nul`, `Aux`, `Prn`, `Com1`, `Lpt1` and the like) |
| `E_LAYER_NAME_INVALID`, `E_LAYER_NAME_DUPLICATE` | a layer name breaks the rule above, or two differ only in capitals |
| `E_TOO_MANY_LAYERS` | more than 15 weight-blended layers |
| `E_RANGE_INVALID` | a fixed height range whose highest is not above its lowest |
| `E_FORMAT_INVALID` | another setting of an export node is not valid |
| `E_FILE_COLLISION` | two exports would write the same file |
| `E_HOOK_FAILED` | an export node could not say what it exports; the sentence says why |
| `E_NODE_FAILED` | a node of the graph failed while computing |
| `E_NON_FINITE` | a terrain, mask or colour to export holds a value that is not a number |
| `E_WRITE_FAILED` | a file could not be written |
| `E_OUT_DIR` | the output folder cannot be used (section 2) |
| `E_COMMIT_FAILED` | the finished build could not be moved into place, typically because a file is open in another program. The complete build is then in `<dir>.partial` |
| `E_DEVICE_LOST` | the graphics device was lost. The build is not resumed; build again |
| `E_INTERNAL` | anything else |
| `W_HEIGHT_CLIPPED` | with a fixed range: samples lay outside it |
| `W_FLAT` | the stored height range was under 1 m and was widened |
| `W_LAYER_EMPTY` | a layer is 0 everywhere |
| `W_MANY_LAYERS` | more than 12 layers in all |
| `W_GRID_SIZE` | the number of components per side is not a multiple of the World Partition grid size |
| `W_REGION_SIZE` | the World Partition region size is 4 ([known risks](unreal-import.md#4-known-risks-and-workarounds), item 5) |

## Time and memory

Measured on the development machine: Linux, GTX 1660 Ti with 6 GB, 16 GB of memory. *Files* is the build's
count, without the report: the folder holds one file more.

| Project | Resolution | Time | Files | Peak graphics memory of Orogen's fields | Peak process memory |
| --- | --- | --- | --- | --- | --- |
| `docs/user/examples/ridge.orogen` | 1009 | 0.54 s | 8 files, 5.7 MB | 15.4 MB | 390.5 MB |
| `docs/user/examples/ridge.orogen` with `--res 4033` | 4033 | 4.59 s | 8 files, 87.7 MB | 213.1 MB | 523.8 MB |
| a mountain range with one layer (measured by the pipeline's authors) | 8129 | 12.0 s | 7 files, 305.3 MB | 836.8 MB | 631.4 MB |

These graphs are small: a generator and a mask. A graph with erosion takes much longer, and the largest
simulations at 8129 need more graphics memory than the command line's default budget allows; pass
`--budget-mb` ([command line](command-line.md#options-that-several-subcommands-share)).

At 8129 one field is 264 MB on the card and one colour map 529 MB. Each weight-blended layer is also held in
main memory, 132 MB, until all of them have been written together at the end of the build.
