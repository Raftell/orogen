# Getting started on Windows 11

There are two ways to run Orogen on Windows. The **Windows build** is the desktop application, packed by the
project's automated checks: download, unpack, start. The **repository** has everything: the application built
from source, the command-line program, the example projects and the tests. There is no installer.

**What has and has not been run on Windows.** Orogen is developed on Linux with an NVIDIA GTX 1660 Ti. On
Windows, the project's automated checks run the engine's tests on Windows' software graphics adapter (WARP,
"Microsoft Basic Render Driver"), which proves that the shaders compile and compute correctly through Direct3D
12, and they pack the application and start it once, hidden, on a machine without a graphics card. On
2026-10-15 the application, builds and the test suites ran on one Windows machine with a graphics card, the
target machine with its RTX 3080: [First run on Windows](first-run-on-windows.md#the-first-run-2026-10-15)
records what each step showed, and is the list of what to try, in order, on another machine, and what to send
back.

## 1. The Windows build, without installing anything

1. On GitHub, open the repository, then **Actions**, the workflow **ci**, and the latest run on `main` whose job
   `package-windows` is green. You must be signed in with access to the repository.
2. At the foot of the run's page, under **Artifacts**, download **`Orogen-windows-x64`**. It arrives as
   `Orogen-windows-x64.zip`. GitHub keeps the artifacts of a run for 90 days unless the repository says otherwise.
3. Right-click the zip, **Properties**, tick **Unblock** if the box is there, then unpack it into a folder of its
   own, for example `D:\Orogen`.
4. Start `Orogen.exe` in that folder. The build is unsigned, so Windows says that it protected your PC: **More
   info**, then **Run anyway**.

| Artifact | Holds | Use it when |
| --- | --- | --- |
| `Orogen-windows-x64` | the application's folder: `Orogen.exe` and what it needs beside it | always, unless you want one file |
| `Orogen-windows-x64-portable` | one file, `Orogen-<version>-win-x64-portable.exe` | you want one file to carry around. It unpacks itself into the temporary folder at every start, with nothing on the screen meanwhile |
| `launch-check-windows` | what the automated check saw when it started the build: a small JSON file | you report a problem |

What the automated check proves of a build before you download it: it was packed; `Orogen.exe` started on a
Windows machine without a graphics card and loaded its window, hidden. Whether its engine found a graphics
device there is in the run's step *Its engine opens a GPU device* and is not required: a machine without a card
says little about yours. (These steps are new. Look at the run to see how they came out.)

The Windows build is the application only. The command-line program, and with it the acceptance pattern for
Unreal Engine, needs the repository.

## 2. From the repository

### What you need

| | |
| --- | --- |
| Windows 11, 64-bit | The package that gives Node.js its graphics access ships binaries for Windows on x64 and on ARM64 |
| A graphics card with a current driver | Orogen computes with WebGPU, which uses Direct3D 12 on Windows. The target machine of the project is an RTX 3080 with 10 GB. Without a usable card Orogen can run on WARP: correct, and very slow |
| Node.js 24 or later | The project is developed and checked with Node 26 |
| Git | to check the repository out |
| About 1 GB of disk | The installed packages take about 650 MB (measured on Linux). A build at 8129 × 8129 writes a few hundred megabytes more |

### Install

In a terminal, in the folder where you want Orogen:

```
git clone <address of the repository> orogen
cd orogen
npm ci
```

- The repository says of itself (`.gitattributes`) that its text files keep their line ends on every system,
  so Git for Windows needs no setting. A copy whose line ends were converted fails 17 of the unit tests, the
  ones that read the project's documents (measured on Linux with a converted copy); the application and the
  command-line program do not depend on line ends.
- `npm ci` installs exactly the versions the repository's lock file names, into the folder `node_modules`.
  Electron, which the desktop application runs on, downloads its program the first time it is started.
- **PowerShell may refuse `npm`** with *running scripts is disabled on this system*: Windows' default policy
  blocks the script `npm.ps1`. Type `npm.cmd` in place of `npm`, or use Command Prompt, or allow scripts for
  your account once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### First run

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
| `microsoft-basic-render-driver`, `"software": true` | Orogen chose Windows' software adapter | name your card, for example `node src/cli/main.ts probe --adapter NVIDIA`. `--adapter` takes any part of the adapter's name, with the same capitals: on the development machine `NVIDIA` and `GTX` select the card and `nvidia` selects nothing. On the target machine the default was the card, `nvidia-geforce-rtx-3080`, without `--adapter` |
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

### The command-line program

Everything Orogen computes can be computed without a window, through one program:

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
time limit of 30 minutes, which a long build can exceed, and it cannot start `npm` there: do not use it.

### Starting the application

```
npm start
```

run in the repository's folder, builds the application into the folder `dist` and starts it; `npm run build`
followed by `npx electron .` does the same in two steps. `npx electron . D:\Terrains\ridge.orogen` starts it
with that project.

`npm run dist:win` packs what the automated checks pack, into the folder `release`: the application's folder
`win-unpacked`, the same as a zip, and the portable executable, all unsigned. Run on Windows; it has been run
there by the automated checks only.

### The tests

```
npm run check
npm run test:unit
npm run test:gpu
npm run build
npm run test:electron
npm run test:ui
```

The first two need no graphics device. The third runs the engine and every node on your card and takes a
while. The last two start the built application many times, in windows that are never shown. Of these, only
`test:gpu` has run on Windows, in the automated checks, on the software adapter.

## 3. The first ten minutes in the application

What opens is one window: the terrain of a first project in a 3D viewport, the graph of its nodes below it,
and at the right the inspector, with the node library and the build panel as two tabs below it.

![The application with the Alpine Range example: the viewport, the graph, and the library's examples](images/application.png)

(The development machine, in the tests' never-shown window.)

1. **Read the status bar** at the foot of the window: `Ready` and the name of your graphics card. `Software
   adapter: everything is slow` means Orogen is not on the card. `Graphics device failed` has a **Retry** button.
   `No graphics device` means Windows offered Orogen no card it can use: a window says why, and links to
   [troubleshooting the graphics device](application.md#troubleshooting-the-graphics-device). On Windows Orogen
   cannot run without the card: there is no software rendering to fall back on.
2. **Open an example.** In the **Library** panel, at the lower right: **Examples**, **Open** on *First Terrain*
   (three nodes) or *Alpine Range* (twenty-one).
3. **Look.** Drag in the viewport to turn the camera, turn the wheel to come nearer, `F6` for the view from
   above. Turn the wheel over the graph until you can read the nodes, and press one: the viewport shows its
   output and the **Inspector**, above the Library, its parameters.
4. **Change something.** Drag across a number in the inspector and let go; `Ctrl+Z` takes it back. With a node
   selected, type `terr` in the Library and press `Enter`: Terraces is added to the right of the selected node,
   connected to it. Or press `Tab` in the graph, type `terr`, `Enter`, and drag a wire from an output to the
   new node's input.
5. **Build.** The **Build** tab, beside the Library's, lists what a build would write. Choose a resolution and
   an output folder that is new or empty, and press **Build**. The panel then lists the files and the values
   Unreal's import panel asks for.
6. **Save** with `Ctrl+S`.

[The desktop application](application.md) describes every panel, gesture and key.

It has been tested on Linux only, and only in a window that is never shown, with input sent by tests. If the
window stays empty or says that it could not start, [First run on Windows](first-run-on-windows.md#if-nothing-opens)
says what to look at and what to send.

## 4. Where to go next

- [First run on Windows](first-run-on-windows.md): the checklist for the first session on your machine.
- [The desktop application](application.md), for everything the window does.
- [Concepts](concepts.md), to understand the graph, the units and what a project file says.
- [Building and exporting](building.md), then [Importing into Unreal Engine 5.8](unreal-import.md).
