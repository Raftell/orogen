# The command-line program

`orogen` on this page stands for `node src/cli/main.ts`, run from the repository's folder:

```
node src/cli/main.ts <subcommand> [options]
```

It is one process that computes on the graphics card. Every command on this page was run on the development
machine (Linux) while this page was written. On Windows the project's automated checks run `probe`, `render`,
`gallery`, `build` and `unreal-test` as part of the engine's tests, on the software adapter. On the target
machine `probe` and `unreal-test` were typed into PowerShell; the others have not been, and what this page says
of PowerShell and Command Prompt beyond that comes from how those shells are documented to pass arguments.

```
orogen probe [--profile <core|max>] [--adapter <substring>]
orogen render <type> [--res <n>] [--param <name>=<json>]... [--max-params] [--seed <n>] [--connected] [--crop <size>]
orogen render <project.orogen> --node <id> [--res <n>] [--crop <size>]
              [--out <dir>] [--budget-mb <n>] [--profile <core|max>] [--adapter <substring>]
orogen gallery [--category <category>] [--res <n>]
               [--out <dir>] [--budget-mb <n>] [--profile <core|max>] [--adapter <substring>]
orogen build <project.orogen> --out <dir> [--res <n>] [--seed <n>] [--budget-mb <n>]
             [--profile <core|max>] [--adapter <substring>] [--json] [--quiet]
orogen unreal-test --out <dir> [--res <n>]
orogen unreal-test --check <file> [--res <n>]
```

`orogen --help` prints this list, and `orogen help <subcommand>` or `orogen <subcommand> --help` the line of
one subcommand. An option is written `--name value` or `--name=value`.

**On Windows.** A path is written as Windows writes it, `D:\Build\Ridge`, or with `/`; one with a space goes
in double quotes. An environment variable is set for the session before the command: in PowerShell
`$env:OROGEN_GPU_ADAPTER = 'NVIDIA'`, in Command Prompt `set OROGEN_GPU_ADAPTER=NVIDIA`. Every variable has an
option that does the same, and the option is the simpler way. `npm run orogen -- <subcommand> ...` starts the
same program, and PowerShell is known to take the `--` for itself: use the form with `node`.

## Options that several subcommands share

| Option | Default | Meaning |
| --- | --- | --- |
| `--profile <core or max>` | the environment variable `OROGEN_GPU_PROFILE`, else `max` | How the graphics device is opened. `max` asks the card for its own limits, stores some internal state more compactly and times the work on the card. `core` uses only what every WebGPU device has, and is what the project's automated checks run with. The example of this guide builds to identical files under both |
| `--adapter <substring>` | `OROGEN_GPU_ADAPTER`, else the system's default adapter | A part of the adapter's name, with the same capitals. Use it when a machine has several adapters |
| `--out <dir>` | for `render` and `gallery`: `OROGEN_TEST_OUTPUT`, else `test-output` | Where files are written. A relative path is taken from the folder you are in. `build` and `unreal-test` have no default: they need `--out` |
| `--budget-mb <n>` | 60 % of the card's memory; 2457 where it is not known | The most graphics memory Orogen's fields may take, in MiB (`render`, `gallery`, `build`). The graphics library reports no amount, on Linux or on Windows; on an NVIDIA card Orogen asks `nvidia-smi`, which NVIDIA's driver installs on both (on Windows from `C:\Windows\System32`, else `C:\Program Files\NVIDIA Corporation\NVSMI`). The development machine's card has 6144 MiB, so the default there is 3686; a card of 10240 MiB gets 6144. Where nvidia-smi is missing, fails, does not answer within 3 seconds or does not name the card, the default is 2457, too little for a large simulation at 8129 × 8129: pass what your card can spare, for example `--budget-mb 6000` on a card with 10 GB. `render`, `gallery` and `build` print the budget and where the card's memory came from |
| `--res <n>` | see each subcommand | A resolution, in vertices per side |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | a node failed, or a build ended with errors |
| 2 | the arguments were wrong, or a project file could not be read. Nothing was computed or written |
| 3 | no usable graphics device, or the device was lost while working |
| 130 | cancelled with Ctrl+C |

## probe

```
orogen probe
```

Prints the capabilities of the graphics device as JSON: the adapter's name, whether it is a software adapter,
its features and its limits. Run it first on a new machine, and attach its output when you report a problem.

At its end, `vramBytes` is the card's memory in bytes and `vramSource` where Orogen learnt it: `nvidia-smi`, or
`adapter` when the graphics library reports it, which it has done on no machine so far. Both are `null` when
nothing said it, and the default budget is then 2457 MiB (see `--budget-mb`). On the development machine:

```
  "vramBytes": 6442450944,
  "vramSource": "nvidia-smi"
```

## render

Draws the outputs of one node to PNG files, so that you can look at a node or at a step of a project without
the application.

```
orogen render generate/mountain-range
orogen render generate/mountain-range --res 513 --param count=3 --param height=0.8 --seed 5
orogen render docs/user/examples/ridge.orogen --node steep
```

**A node type** (first two lines) is drawn as one node at its default parameters. Inputs it needs are fed
from sample terrains: each terrain input from a terrain of its own, a mask from a slope mask, a colour from a
colouring of the terrain. The first terrain is chosen to show what the node's category is for: a mountain
range on gentle ground for the `surface` nodes, an island in its sea for `simulate` and `color`, an eroded
noise for the others. An input named `stamp` is given a volcano, and the optional inputs `flow` and `snow`
the drainage of the terrain and the snow on it. The project settings are fixed: a terrain 4096 m wide with a
height range of 1024 m, project seed 1, sea level 0.25.

| Option | Meaning |
| --- | --- |
| `--res <n>` | default 513. Any preview or build resolution: 129, 257, 513, 1009, 2017, 4033, 8129 and the halvings of a build resolution down to 33 |
| `--param <name>=<json>` | sets a parameter by its name in the [node reference](nodes.md); repeat it for several. The value is JSON: a number is `0.25`, a switch `true`, a pair `[0.5,0.5]`. A choice, or a text of one word (letters, digits, `-` and `_`, beginning with a letter), is written as it is in every shell: `--param mode=ridged`. Any other text is a JSON string, whose double quotes must reach the program: in bash `--param file='"C:/My Maps/heights.png"'`; on Windows (untried) in Command Prompt `--param "file=\"C:/My Maps/heights.png\""`, in PowerShell 7.3 or later `--param 'file="C:/My Maps/heights.png"'`, and in Windows PowerShell 5 `--param 'file=\"C:/My Maps/heights.png\"'`. A value outside the parameter's range is refused |
| `--max-params` | puts every number parameter at the top of its range, before any `--param` |
| `--seed <n>` | sets the node's seed |
| `--connected` | also connects the node's optional inputs and, for a maskable node, its mask |
| `--crop <size>` | also writes the middle `size` × `size` vertices at one vertex per pixel |

**A node of a project** (third line) is drawn with the parameters and connections the project stores.
`--node` takes the node's id. The default resolution is the project's preview resolution, and `--param`,
`--max-params`, `--seed` and `--connected` are refused. A colour map of a node that reads no terrain itself,
the last blend of two colour maps for one, is drawn over the terrain the project shows in its viewport, as it
was when the project was saved.

Files, under the output folder:

```
nodes/<category>/<name>/<output>-<res>.png            every output
nodes/<category>/<name>/<output>-<res>-3d.png         a colour map drawn over its terrain
nodes/<category>/<name>/<output>-<res>-crop.png       with --crop
nodes/<category>/<name>/<output>-<res>-connected.png  with --connected
```

A terrain is drawn as three pictures side by side: its values as grey, a shaded map seen from above, and a lit
3D view. A mask or a data output is drawn in colour over the terrain it belongs to. A data output is drawn
from its smallest value (black) to its largest (white); one whose largest value is more than a hundred times
its mean, such as a flow map or the depth of rivers, is drawn on a logarithmic scale, or its picture would be
black but for a few points. A colour map over its terrain is lit from the viewer's side. On standard output the
command prints one line of JSON with the time, the peak graphics memory and the paths of the files:

```
{"type":"generate/mountain-range","res":513,"wallMs":18.192,"gpuMs":0.918,"longestSliceMs":0.918,"peakBytes":1052676,"files":["…/nodes/generate/mountain-range/out-513.png"]}
```

An export node has no output and cannot be rendered (`has no outputs: there is nothing to draw`, exit code
2). An import node needs its file: `--param file='"C:/Maps/heights.png"'` in bash. Write the path with `/`:
inside JSON a `\` begins an escape, so `C:\Maps` would have to be written `C:\\Maps`.

The command prints no progress while it works. Before it starts, it prints on standard error the graphics
memory it may use and where the card's memory figure came from:

```
orogen render: GPU memory budget 3686 MiB: 60 % of the card's 6144 MiB, which nvidia-smi reports
```

A simulation rendered at 4033 or 8129 can need more graphics memory than the default budget: see `--budget-mb`
above.

## gallery

```
orogen gallery
orogen gallery --category select --res 257
```

Renders every node that has an output, or the nodes of one category, as `render` does, and writes one HTML
page per category with the pictures of each node's outputs, its description, ports and parameters, its time
and its peak memory.
The categories are `generate`, `adjust`, `filter`, `simulate`, `select`, `color`, `surface`, `io` and `ref`.
The default resolution is 513. The pages are `gallery/<category>.html` and `gallery/index.html` under the
output folder; the command prints the path of the page to open. It exits with 1 when a node failed, except
for nodes that need a file and were drawn without one: an import node is drawn with the file its tests use
once they have run into the same output folder, and is listed with `No file selected` until then.

Without `--category` every category is drawn, the simulations included; that took about half a minute on the
development machine. Progress is printed on standard error, one line per node, after the line of the budget
that `render` prints too.

## build

```
orogen build docs/user/examples/ridge.orogen --out D:\Build\Ridge
```

Builds a project: computes the graph at the project's build resolution and writes, for every enabled export
node, the files Unreal Engine imports, with the manifest. [Building and exporting](building.md) describes
what is written; this section is the command.

| Argument | Meaning |
| --- | --- |
| `<project.orogen>` | the project file. Required |
| `--out <dir>` | the output folder. Required. It must not exist, be empty, or hold an earlier Orogen build and nothing else |
| `--res <n>` | builds at this resolution instead of the project's build resolution |
| `--seed <n>` | builds with this project seed instead of the project's |
| `--json` | writes every event of the build as one JSON object per line on standard output, and nothing else there |
| `--quiet` | prints no progress. Problems are still printed |

What a build prints, on standard error, and on standard output the path of the manifest. The first line is the
graphics memory the build may use, as `render` prints it (here on the development machine):

```
orogen build: GPU memory budget 3686 MiB: 60 % of the card's 6144 MiB, which nvidia-smi reports
orogen build: 8 files at 1009 x 1009 into D:\Build\Ridge
orogen build: evaluating 2 nodes
orogen build:   Mountain Range: 0.02 s, 4.1 MB
orogen build: [1/3] Unreal Landscape: RidgeHeight.png
orogen build:   targets 13 %
orogen build: [3/3] Normal Texture: T_Normal_1024.png
orogen build:   targets 38 %
orogen build:   Slope: 0.01 s, 8.1 MB
orogen build: [2/3] Landscape Layer: LayerRock.png
orogen build:   weights 88 %
orogen build:   commit 100 %
orogen build: done in 0.54 s: 8 files, 5.7 MB; peak GPU pool 15.4 MB, peak process memory 390.5 MB
D:\Build\Ridge\Ridge.orogen.json
```

The count of files is of what the manifest lists, the manifest included. The report, `Ridge.report.json`, lies
in the folder as well and is not counted: the folder holds nine files.

| Exit code | Meaning for a build |
| --- | --- |
| 0 | The output folder holds the build and its manifest |
| 1 | The build has errors, which are printed. The output folder is as it was before. When the build got as far as computing, its report is in the folder `<dir>.partial` beside the output folder |
| 2 | Wrong arguments, an unreadable project file, or a file that is not a project. Nothing was planned or written |
| 3 | No usable graphics device, or the device was lost during the build |
| 130 | Cancelled with Ctrl+C. The output folder is as it was before. A second Ctrl+C ends the program at once |

The exit code is 0 only when a manifest was written.

A build at 4033 or 8129 holds hundreds of megabytes of graphics memory and, for a short time, of main memory.
[Building and exporting](building.md#time-and-memory) gives measured figures.

## unreal-test

```
orogen unreal-test --out D:\Build\Marker
orogen unreal-test --out D:\Build\Marker8129 --res 8129
orogen unreal-test --check D:\Build\Exported.png
```

The first form writes the **acceptance pattern**: a complete build named `Marker`, made without a project
and without a graphics card, whose terrain is a flat plain with a tower in one corner, a pit in another and a
ramp along one edge. Imported into Unreal Engine it shows whether the landscape arrives the right way round,
at the right place and at the right heights. `--res` is 1009 (the default), 2017, 4033 or 8129.

The second form compares a heightmap that you exported from Unreal, a 16-bit PNG or a `.r16` file, with the
pattern, and prints how many samples differ:

```
0 of 1018081 samples differ from the pattern; the largest difference is 0 codes
```

Exit code 0 means that every sample is identical; 1 that samples differ, that the file is not a heightmap of
the pattern's size, or that the output folder was refused; 2 that the arguments were wrong.
[The import guide](unreal-import.md#6-the-acceptance-test) says what to do with both.
