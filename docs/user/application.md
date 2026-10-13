# The desktop application

**Not yet built.** The repository holds no source of the application: no window, no graph editor, no
viewport. Nothing on this page can be run or tried today. It describes the application only as far as the
project's design documents fix it (`docs/contract/runtime.md`, sections 7 and 8), so that you know what the
command-line program is a stand-in for. Details that the design leaves to the people who will build the
panels are not described here, and what is described may change before it ships.

## What it is

One window on Electron, the same engine as the command-line program, and five panels that can be docked and
rearranged. The engine and the 3D viewport run in a worker beside the interface, so a long computation does
not freeze the window.

| Panel | Shows | You do there |
| --- | --- | --- |
| **Graph** | the nodes and their connections, a thumbnail and a status on every node, coloured groups | add, connect, move, copy, group, rename, bypass and delete nodes |
| **Viewport** | the terrain in 3D or from above, with a mask, a data field or a colour map drawn over it, and the height under the pointer | move the camera |
| **Inspector** | the parameters of the selected node, and the project settings | change values |
| **Library** | every node by category, with a search | drag a node into the graph |
| **Build** | the build settings, progress, the plan of a build with its problems, the files it wrote | start and cancel a build |

## What is fixed about how it behaves

**Selecting shows.** Selecting a node shows its first output in the viewport. A terrain becomes the terrain
shown. A mask, a data field or a colour map is drawn over the terrain that is already shown: a mask as a tint,
a data field through a colour ramp from its lowest to its highest value, a colour map as it is. The view can be
locked to a node, so that selecting other nodes does not change it. What the viewport shows is saved with the
project.

**The viewport shows the terrain as Unreal will.** Seen from above, the first row of the heightmap is at the
top, +X points right and +Y down the screen; no view is a mirror image. The viewport can draw the sea as a
plane at the project's sea level.

**Edits are answered at once, coarsely, then finely.** While you drag a value, the graph is computed at a
coarser level of the preview resolution and shown as a draft; when you let go, it is computed at the preview
resolution. Only the newest state of the project is computed: what you changed in between is skipped. While a
newer state is computed the viewport keeps showing the last result.

**Lengths and heights can be typed in metres.** A parameter that is a length or a height is stored as a
fraction of the terrain's width or of the height range. The inspector shows the value in metres beside the
fraction and accepts either: typing `500m` on a terrain 5 km wide stores 0.1.

**A direction control draws the direction as the viewport shows it**: 0° to the right, 90° down.

**Everything can be undone** except what is only a view: what the viewport shows, the position of the graph,
and the build and preview resolutions. A drag is one step however long it lasts. The history holds up to 500
steps.

**A build runs in the application as it does on the command line.** It uses the same pipeline and writes the
same files into an output folder you choose. While it runs, previews stop and the viewport keeps its last
picture; when it has ended, the preview is computed again. A second build cannot start while one runs.

**A lost graphics device is recovered.** If the driver resets, the application opens the device again, at
once, after one second and after five, and computes the project anew. Imported image files are read again
from disk. After three failures it stops trying and waits for you.

**Keys.** The defaults, which can be changed in the preferences. `Mod` is Ctrl on Windows.

| Key | Does | Where |
| --- | --- | --- |
| `Mod+N`, `Mod+O`, `Mod+S`, `Mod+Shift+S` | new, open, save, save as | everywhere |
| `Mod+Z`; `Mod+Shift+Z` or `Mod+Y` | undo; redo | everywhere |
| `Mod+Shift+P` or `F1` | the command palette | everywhere |
| `` ` `` (the key left of 1) | pause and resume computing | everywhere |
| `Mod+B` | start a build | everywhere |
| `F6` | switch the viewport to the view from above and back | everywhere |
| `Tab` | add a node | graph |
| `Delete` or `Backspace` | delete the selection | graph |
| `Mod+D` | duplicate | graph |
| `B` | bypass | graph |
| `F` | lock the view to the selected node | graph |
| `G` | use the selected node as the terrain shown | graph |
| `Mod+G` | group | graph |
| `F2` | rename | graph |
| `Mod+0` or `Home` | fit the graph into the panel | graph |
| `F` | frame the terrain | viewport |

## How it will be started

`npm run build` will build the application into the folder `dist`, and `electron .` in the repository's
folder will start it. Today `npm run build` fails, because there is nothing to build. A packaged Windows
version is planned.

## Until then

- Write the project file by hand: [Concepts](concepts.md#the-project-file).
- Look at a node, or at a node of your project, with `orogen render`: [command line](command-line.md#render).
- Build with `orogen build`: [Building and exporting](building.md).
