# Concepts

A project in Orogen is a **graph** of nodes and six **project settings**. The graph describes the shape of a
terrain in a box without units; the settings say how large that box is in the world. This page explains both,
and the file a project is stored in.

## The graph

A **node** does one thing: it makes a terrain, changes one, measures one, or says what a build writes. A node
has **inputs** on one side, **outputs** on the other, and **parameters**. A **connection** leads from an
output of one node to an input of another.

```
  Mountain Range ──out──┬──in── Unreal Landscape          writes the heightmap
                        ├──in── Slope ──out──in── Landscape Layer "Rock"
                        └──in── Normal Texture
```

That is `docs/user/examples/ridge.orogen`: a mountain range, a mask of its steep ground, and three export nodes.

Rules of the graph:

- An input takes one connection. An output feeds as many inputs as you like.
- The graph has no loops.
- A node is computed only when something needs it, and only once however many nodes read it.
- A node with an unconnected required input reports `missing input "<name>"`, and the nodes that read it are
  skipped.

### What travels along a connection

| Kind | What it holds | Notes |
| --- | --- | --- |
| **terrain** | a height at every point | Heights are normalised: 0 is the bottom of the project's height range and 1 its top. Values outside 0 to 1 are allowed inside the graph and are dealt with at export |
| **mask** | a value from 0 to 1 at every point | 0 means unaffected, 1 fully affected. A mask input that is not connected counts as 1 everywhere |
| **data** | a number at every point with a meaning of its own | a distance, an amount of flow. The node's description says what |
| **colour map** | a colour at every point | linear RGB |

Terrains, masks and data are all *fields*: one number per point. Any field output connects to any field
input, so a mask can be used as a terrain and a terrain as a mask (it is then limited to 0 to 1). A field
also connects to a colour input and a colour map to a field input: Orogen converts, a field to grey and a
colour to its brightness.

### Masks on every filter

Most nodes that change a terrain or a colour map are **maskable**: they have one more input, `mask`. Connect a
mask and the node's result is blended with its input, point by point: where the mask is 0 the input passes
unchanged, where it is 1 the node acts fully. The [node reference](nodes.md) marks these nodes.

### Bypass

A node whose first input and first output are of the same kind can be **bypassed**: it then hands its input
through unchanged and is not computed. In a project file this is the member `"bypass": true` of the node.

### Export nodes

The nodes named *Unreal Landscape*, *Landscape Layer*, *Color Texture*, *Mask Texture*, *Normal Texture* and
*Image File* have inputs and no output. They compute nothing. Each says what a build writes from the terrain,
mask or colour map connected to it. A build writes for every export node whose **Enabled** switch is on;
nothing else decides what is built. [Building and exporting](building.md) describes them.

## Units: the unit box

The graph describes a shape in a box of side 1. Every number a parameter stores is in one of five units, and
none of them is a pixel.

| Unit | A stored value of 1 is | Example |
| --- | --- | --- |
| **length** | the whole width of the terrain | a feature size of 0.25 is a quarter of the terrain: 500 m on a terrain 2000 m wide |
| **height** | the whole height range of the project | a height of 0.5 is 250 m with a height range of 500 m |
| **angle** | one degree | a direction from 0 to 360; a slope from 0 to 90 |
| **ratio** | all of it | a strength or a share from 0 to 1 |
| none | a plain number | a count, an exponent |

Consequences worth knowing:

- **The same graph gives the same shape at any size.** Change the terrain's width from 2 km to 8 km and every
  feature grows with it.
- **Slopes are physical.** A slope of 30 degrees is measured in real metres, from the terrain's width and
  height range. This is the one place where the size of the project changes what a graph does: on a project
  twice as steep, every node that works with slopes acts twice as hard.
- **Resolution does not change the terrain.** A radius of 0.01 covers the same ground at 1009 and at 8129
  vertices. A preview is the same terrain on a coarser grid.

### Directions

Orogen draws every terrain the way an image viewer draws its heightmap: the first row at the top, **+X to the
right, +Y down the screen**, height towards you. An angle of 0° points along +X (to the right), 90° along +Y
(down the screen), so increasing angles turn clockwise when you look from above. A direction says where
things go: a wind direction is where the wind blows to, and a light direction points from the ground towards
the light.

This is also how the terrain is meant to lie in Unreal Engine, whose world is left-handed like this picture:
image columns along Unreal's +X and image rows along +Y. That mapping is one of the unconfirmed statements
that [the acceptance test](unreal-import.md#6-the-acceptance-test) exists to settle.

### Random numbers

A node that uses random numbers has a **seed**. The project has a seed too, and the two are combined: change
the project seed and every random node changes; change one node's seed and only that node does. A copy of a
node gives the same result as the original until you change its seed.

## Project settings

| Setting | In a project file | Default | Valid | Meaning |
| --- | --- | --- | --- | --- |
| Terrain size | `terrainSize` | 4032 | 1 to 1 000 000 | metres across the terrain, from its first vertex to its last |
| Height range | `heightRange` | 1008 | 1 to 100 000 | metres that the height 1.0 stands for |
| Seed | `seed` | 0 | a whole number from 0 to 4 294 967 295 | the project seed |
| Build resolution | `buildResolution` | 4033 | 1009, 2017, 4033, 8129, or a custom value (below) | vertices per side of a build |
| Preview level | `previewLevel` | 2 | a whole number from 0 | how many times the build resolution is halved for previews |
| Sea level | `seaLevel` | 0 | any number | a normalised height |

- **The default project** is one metre per vertex at its build resolution (4032 m across 4033 vertices), which
  is Unreal's 100 cm per quad, and a quarter as high as it is wide. The defaults of every node are tuned on a
  project of that proportion.
- **Build resolutions.** 1009, 2017, 4033 and 8129 are sizes Epic recommends for landscapes. A custom value is
  a whole number from 129 to 8192 that is one above a multiple of 16. Not every custom value is a size an
  Unreal landscape can have: 2049 is not, and a project with an Unreal Landscape node then refuses to build
  and names the nearest sizes that are.
- **Preview resolution.** Previews run at `(buildResolution − 1) / 2^previewLevel + 1` vertices per side: with
  the defaults, 1009. Coarser grids are exact subsets of finer ones.
- **Sea level.** Ground at or below the sea level is sea for the nodes that work with water, and by default
  an export puts this height at world height 0 in Unreal. The default 0 is the bottom of the height range. A
  value below the lowest ground, for example −1, means a project without a sea.

## The project file

A project is one text file with the extension `.orogen`, holding JSON. The desktop application writes it when
you save; it can also be written in a text editor. This is the whole of `docs/user/examples/ridge.orogen` except
three of its nodes:

```json
{
  "format": "orogen",
  "version": 1,
  "settings": {
    "terrainSize": 2000,
    "heightRange": 500,
    "seed": 7,
    "buildResolution": 1009,
    "previewLevel": 1,
    "seaLevel": 0
  },
  "nodes": {
    "range": {
      "id": "range",
      "type": "generate/mountain-range",
      "version": 1,
      "position": { "x": 0, "y": 0 },
      "params": {}
    },
    "landscape": {
      "id": "landscape",
      "type": "io/export-landscape",
      "version": 1,
      "position": { "x": 520, "y": 0 },
      "params": { "name": "Ridge" }
    }
  },
  "edges": {
    "e-landscape": {
      "id": "e-landscape",
      "from": { "node": "range", "port": "out" },
      "to": { "node": "landscape", "port": "in" }
    }
  },
  "groups": {},
  "ui": {}
}
```

| Member | Holds |
| --- | --- |
| `format`, `version` | always `"orogen"` and `1` |
| `settings` | the six project settings |
| `nodes` | the nodes, each under its id. An id is any name you choose; it must equal the node's `id` member |
| a node's `type` | the type from the [node reference](nodes.md), such as `generate/mountain-range` |
| a node's `version` | the version of the node type the parameters were written for: 1, unless the node's entry in the reference names another |
| a node's `params` | the parameters you changed, by the **Name** column of the reference. A parameter you leave out has its default |
| a node's `position` | where the node sits in the graph editor. It has no effect on the terrain |
| a node's `title`, `bypass` | optional: your own label; `true` to bypass the node |
| `edges` | the connections, each under its id, `from` an output `to` an input |
| `groups`, `ui` | what the graph editor stores: the frames around nodes, the place of the graph, and what the viewport shows. Leave them empty in a file you write by hand |

How Orogen reads a file:

- A parameter outside its range is brought back into it, and one of the wrong kind falls back to its default.
  `orogen build` prints a warning for each.
- A choice (a parameter of kind *choice*) with a value the node does not know stops that node with an error.
- A node of a type this version of Orogen does not have is kept as it is, and reported.
- A file written by a newer version of the format is refused.
- The path of an image for an import node is stored in the node's `file` parameter. A path without a drive or
  leading slash is taken from the folder of the project file. The application stores a file that lies in the
  project's folder, or below it, relative to the project file and with `/`, so that the folder can be moved or
  copied to another machine whole; a file elsewhere, or on another drive, is stored with its full path.
- The file is UTF-8; line ends of either kind are read, and so is a byte order mark at its start, which
  Windows PowerShell 5 and some editors write. Orogen writes none.

## Same input, same output

Two builds of the same project at the same resolution, on the same graphics card and with the same version
of Orogen, write the same bytes: this was checked for `docs/user/examples/ridge.orogen` on the development
machine.
Another graphics card computes the same terrain with differences in the seventh digit. That is too small to
see, and it does change the last digits of the numbers in a manifest. Always take the numbers from the
manifest of the build you import.
