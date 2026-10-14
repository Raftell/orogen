# Orogen user guide

Orogen is a terrain generator for games. You describe a terrain as a graph of nodes: a mountain range here, an
erosion there, a mask of the steep ground, a colour map. Orogen computes the graph on the graphics card and
writes the files that the Landscape system of Unreal Engine 5.8 imports: a 16-bit heightmap up to 8129 × 8129,
weight layers for the landscape material, companion textures, and a small text file, the manifest, that holds
every number you type into Unreal's import panel.

This guide is for the person who uses the tool. It does not assume that you have read the project's contract
documents.

## What exists today

Read this table before you plan around Orogen.

| Part | State |
| --- | --- |
| The engine and the nodes | Built and tested. The [node reference](nodes.md) lists the 86 nodes of the product, and the 10 reference nodes the engine itself ships with, which the application does not offer |
| The command-line program `orogen` | Built: it probes the graphics card, draws nodes to pictures, builds a project and writes the acceptance pattern for Unreal ([command line](command-line.md)) |
| Building and exporting | Built and tested on Linux, on a graphics card and on a software adapter, and on Windows' software adapter in the automated checks. **Not yet run on a Windows machine with a graphics card** ([building](building.md)) |
| The desktop application (graph editor, 3D viewport, inspector, node library, build panel) | Built: a project is made, edited, looked at, built and saved in one window, and six example projects open from its library. Tested on Linux in a window that is never shown, with input sent by tests; **never seen on Windows, and never driven with a real mouse** ([the desktop application](application.md)) |
| The Windows build | Packed by the automated checks, unsigned, and started there once, hidden, on a machine without a graphics card. **Nobody has started it on a desktop** ([getting started](getting-started.md), [first run on Windows](first-run-on-windows.md)) |
| Importing into Unreal Engine | Written from Epic's documentation. **Nobody at Orogen has carried it out in Unreal Engine.** Every statement about Unreal in [the import guide](unreal-import.md) says how far it has been checked |
| The Unreal editor plugin | Experimental C++ source that **has never been compiled or run** ([plugin](../../unreal/OrogenBridge/README.md)) |

A project is made in the desktop application. It is also a text file that can be written by hand, and the
command-line program looks at one and builds it without a window.

## The pages

1. [Getting started](getting-started.md): the Windows build, running from the repository, and the first ten
   minutes in the application.
2. [First run on Windows](first-run-on-windows.md): what to try first on a machine nobody has run Orogen on, in
   order, and what to send back.
3. [Concepts](concepts.md): the graph, the unit box, project settings, the project file.
4. [The command-line program](command-line.md): every subcommand and option.
5. [The desktop application](application.md): its panels, gestures and keys, and what is not there yet.
6. [Node reference](nodes.md): every node with its ports and parameters. Generated from the nodes themselves.
7. [Building and exporting](building.md): export nodes, the output folder, the files and the manifest.
8. [Importing into Unreal Engine 5.8](unreal-import.md): the import by hand, a worked example, the acceptance
   test, known problems of Unreal and their workarounds, and the experimental plugin.

`docs/user/examples/ridge.orogen` is a small project that these pages build and import. The six example
projects of the application's library are the files of the folder `examples` at the root of the repository;
each also builds from the command line, for example
`node src/cli/main.ts build examples/alpine-range.orogen --out D:\Build\Alpine`.

## Five minutes

With Node.js installed and the repository checked out ([getting started](getting-started.md#2-from-the-repository)),
from the repository's folder:

```
npm ci
node src/cli/main.ts probe
node src/cli/main.ts render generate/mountain-range
node src/cli/main.ts build docs/user/examples/ridge.orogen --out D:\Build\Ridge
```

The first line installs the packages. The second prints what Orogen sees of your graphics card. The third
draws the Mountain Range node into `test-output/nodes/generate/mountain-range/out-513.png`. The fourth builds
the example into `D:\Build\Ridge` and prints the path of its manifest; [the import guide](unreal-import.md)
takes it from there.
