# Getting started on Windows 11

Orogen runs from its repository. There is no installer yet: you check the repository out, install its packages
with npm, and start the command-line program with Node.js. Node runs the TypeScript sources directly, so
nothing is compiled.

**What has and has not been run on Windows.** Orogen is developed on Linux with an NVIDIA GTX 1660 Ti. On
Windows, the engine's tests run in the project's automated checks on Windows' software graphics adapter (WARP,
"Microsoft Basic Render Driver"), which proves that the shaders compile and compute correctly through Direct3D
12. The build pipeline (`orogen build`) has been run on Linux only. Nothing has been run on a Windows machine
with a graphics card. The steps below are the ones the automated checks use; expect to be the first to try
them on your hardware.

## 1. What you need

| | |
| --- | --- |
| Windows 11, 64-bit | The package that gives Node.js its graphics access ships binaries for Windows on x64 and on ARM64 |
| A graphics card with a current driver | Orogen computes with WebGPU, which uses Direct3D 12 on Windows. The target machine of the project is an RTX 3080 with 10 GB. Without a usable card Orogen can run on WARP: correct, and very slow |
| Node.js 24 or later | The project is developed and checked with Node 26 |
| Git | to check the repository out |
| About 1 GB of disk | The installed packages take about 650 MB (measured on Linux). A build at 8129 × 8129 writes a few hundred megabytes more |

## 2. Install

In a terminal (PowerShell or Command Prompt), in the folder where you want Orogen:

```
git clone <address of the repository> orogen
cd orogen
npm ci
```

`npm ci` installs exactly the versions the repository's lock file names, into the folder `node_modules`;
among them is Electron, which the desktop application will use. `npm install` gives the same result and may
rewrite the lock file.

## 3. First run

```
node src/cli/main.ts probe
```

This prints what Orogen sees of the graphics device, as JSON. Look at the first lines:

```json
{
  "adapter": {
    "vendor": "nvidia",
    "architecture": "turing",
    "device": "nvidia-geforce-gtx-1660-ti",
    "description": "NVIDIA: 595.99.02 595.99.2.0",
    "isFallbackAdapter": false,
    "backend": null
  },
  "software": false,
```

(That is the development machine.) `adapter` should name your graphics card and `software` should be `false`.

| You see | Meaning | Do this |
| --- | --- | --- |
| your card, `"software": false` | Orogen computes on the card | carry on |
| `microsoft-basic-render-driver`, `"software": true` | Orogen chose Windows' software adapter | name your card, for example `node src/cli/main.ts probe --adapter NVIDIA`. `--adapter` takes any part of the adapter's name, with the same capitals: on the development machine `NVIDIA` and `GTX` select the card and `nvidia` selects nothing. Which adapter a Windows machine with a card picks by default, and what its card is called there, is not known: this has not been run on one |
| `No WebGPU adapter is available`, exit code 3 | no usable device | update the graphics driver |

Two lines that begin `Warning: maxDynamicUniformBuffersPerPipelineLayout` may appear before the output on
some drivers. They come from the graphics library and are harmless.

Then draw a node and build the example:

```
node src/cli/main.ts render generate/mountain-range
node src/cli/main.ts build docs/user/examples/ridge.orogen --out D:\Build\Ridge
```

The first writes `test-output\nodes\generate\mountain-range\out-513.png` under the folder you are in: the
node's output as grey values, as a shaded map and as a lit 3D view, side by side. The second writes the files
for Unreal into `D:\Build\Ridge` and prints the path of the manifest. Choose any folder that is new or empty;
[Building and exporting](building.md) says why it must be.

## 4. The command-line program

Every use of Orogen today goes through one program:

```
node src/cli/main.ts <subcommand> [options]
```

| Subcommand | Does |
| --- | --- |
| `probe` | prints the capabilities of the graphics device |
| `render` | draws the outputs of one node to PNG files |
| `gallery` | draws every node and writes a page per category |
| `build` | builds a project into the files Unreal Engine imports |
| `unreal-test` | writes, or checks, the acceptance pattern for Unreal Engine |

`node src/cli/main.ts --help` lists them with their options, and [the command-line page](command-line.md)
describes each. `npm run orogen -- <subcommand> [options]` starts the same program; the form with `node` is
used in this guide because it does not depend on how your shell hands `--` to npm.

On Linux, the project's own development rule is to start the program through its guard,
`tools/guard node src/cli/main.ts ...`, which caps the memory of the process. On Windows the guard only adds a
time limit of 30 minutes, which a long build can exceed: do not use it there.

## 5. Starting the application

**Its frame is built; its panels are not.** `npm start`, run in the repository's folder, builds the application
into the folder `dist` and starts it; `npm run build` followed by `npx electron .` does the same in two steps.

- What opens is the window with its menus, the command palette, the status bar and five docked panels. It
  computes the project and shows its terrain from above. The graph editor, the inspector, the node library and
  the build panel are empty: you can open, save and build a project in the window, and you cannot edit it there
  yet.
- `npx electron . D:\Terrains\ridge.orogen` starts it with that project.
- It has been tested on Linux only, and only in a window that is never shown. **Nobody has started it on
  Windows.**
- `npm run dist:win` packs it for Windows into the folder `release`, as a zip and a portable executable, both
  unsigned. That package **has never been built or started**.

[The desktop application](application.md) says what works today and what the design fixes of the rest.

## 6. Where to go next

- [Concepts](concepts.md), to understand what a project file says.
- [Building and exporting](building.md), then [Importing into Unreal Engine 5.8](unreal-import.md).
