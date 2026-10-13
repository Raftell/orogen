# Orogen user guide

Orogen is a terrain generator for games. You describe a terrain as a graph of nodes: a mountain range here, an
erosion there, a mask of the steep ground, a colour map. Orogen computes the graph on the graphics card and
writes the files that the Landscape system of Unreal Engine 5.8 imports: a 16-bit heightmap up to 8129 × 8129,
weight layers for the landscape material, companion textures, and a small text file, the manifest, that holds
every number you type into Unreal's import panel.

This guide is for the person who uses the tool. It does not assume that you have read the project's contract
documents.

## What exists today

Orogen is being built. Read this table before you plan around it.

| Part | State |
| --- | --- |
| The engine and the nodes | Built and tested. The [node reference](nodes.md) lists the nodes this checkout registers |
| The command-line program `orogen` | Built: it probes the graphics card, draws nodes to pictures, builds a project and writes the acceptance pattern for Unreal ([command line](command-line.md)) |
| Building and exporting | Built and tested on Linux, on a graphics card and on a software adapter. **Not yet run on Windows** ([building](building.md)) |
| The desktop application (graph editor, 3D viewport, inspector) | **Its frame is built; its panels are not.** The window with its menus, the command palette, the status bar, project files, undo and redo and the preferences exists, and shows the terrain of a project from above. The graph editor, the inspector, the node library, the build panel and the 3D camera are empty, so a project cannot be edited in the window yet. Tested on Linux in a window that is never shown; **not yet run on Windows** ([the desktop application](application.md)) |
| Importing into Unreal Engine | Written from Epic's documentation. **Nobody at Orogen has carried it out in Unreal Engine.** Every statement about Unreal in [the import guide](unreal-import.md) says how far it has been checked |
| The Unreal editor plugin | Experimental C++ source that **has never been compiled or run** ([plugin](../../unreal/OrogenBridge/README.md)) |

Until the graph editor exists, a project is a text file that you write by hand or copy from an example,
and the command-line program is the way to look at it and to build it.

## The pages

1. [Getting started](getting-started.md): installing on Windows 11 and running Orogen for the first time.
2. [Concepts](concepts.md): the graph, the unit box, project settings, the project file.
3. [The command-line program](command-line.md): every subcommand and option.
4. [The desktop application](application.md): what is built of it today, and what it will be.
5. [Node reference](nodes.md): every node with its ports and parameters. Generated from the nodes themselves.
6. [Building and exporting](building.md): export nodes, the output folder, the files and the manifest.
7. [Importing into Unreal Engine 5.8](unreal-import.md): the import by hand, a worked example, the acceptance
   test, known problems of Unreal and their workarounds, and the experimental plugin.

`examples/ridge.orogen` is a small project that these pages build and import.

## Five minutes

With Node.js installed and the repository checked out ([getting started](getting-started.md)), from the
repository's folder:

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
