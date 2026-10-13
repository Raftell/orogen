# The desktop application

The application is built: a graph editor, a 3D viewport, an inspector, a node library with example projects, and
a build panel that writes the files Unreal Engine imports. A terrain can be made in it from an empty project to
a finished build without the command line.

**What it has and has not been run on.** Everything on this page was checked on Linux (GTX 1660 Ti), in a
window that is never shown, with input that the tests send to the page. **Nobody has started it on Windows, no
test has looked at it in a visible window, and no real mouse has driven it.** Where a sentence below rests on
something else than such a test, it says so.

## A first session

1. Start it: `npm start` in the repository's folder ([getting started](getting-started.md)). It opens with a
   project of one Mountain Range node, shown in 3D.
2. In the side column, press the **Library** tab, then **Examples**, and **Open** on *Alpine Range*. The example
   opens as a new project without a file. Its graph is fitted into the Graph panel; at that size the nodes are
   blocks in the colours of their categories and the names you can read are those of their groups.
3. Turn the wheel over the graph to come nearer. Press a node: the **Inspector** tab shows its parameters and
   the viewport shows its output.
4. Drag across a number in the inspector. While you drag, the viewport shows a coarser draft and says *Draft*;
   when you let go it is computed at the preview resolution. `Ctrl+Z` takes the drag back.
5. Press the **Build** tab, choose a resolution and an output folder, and press **Build**. When the build has
   finished, the panel lists the files and, under *Unreal Import*, every number the New Landscape panel of Unreal
   Engine asks for, each with a button that copies it.
6. `Ctrl+S` saves the project as a `.orogen` file.

## The window

A menu bar, five panels, and a status bar.

| Part | Holds |
| --- | --- |
| Menu bar | **File**, **Edit**, **View**, **Engine**, then one menu for each of **Viewport**, **Graph**, **Inspector** and **Library**. In the middle the project's name, with *(unsaved)* while it has changes. At the right a button that pauses and resumes previews, and one for the preferences |
| Panels | **Viewport** above **Graph** at the left; at the right one column with the tabs **Inspector**, **Library** and **Build**. Drag a tab to rearrange; the layout is kept for the next start, and **View → Reset Layout** brings this one back |
| Status bar | the graphics device and its adapter; what is being computed, with its progress; the resolution of the picture, and *Draft*, *Updating* or *Out of date* when the picture is not the project as it is; graphics memory in use against its budget; and, when there is something to say, *n nodes failed*, *n nodes lack an input* or *Messages*, which open the list |

Only one of Inspector, Library and Build is in front at a time. A command that shows something in the Library
(**Library → Find Node…**, **Show Node Library**, **Show Example Projects**) brings its tab to the front.

Every command is in a menu and in the command palette (`Ctrl+Shift+P` or `F1`), which lists them all with the
panel each belongs to and finds one by a few of its letters.

## Graph

| You want to | Do this |
| --- | --- |
| add a node | `Tab` opens a palette where the pointer is: type a few letters, `Enter`. Or drag a node in from the Library, or double-click it there |
| connect | drag from an output to an input. A wire the graph refuses says why, at the pointer |
| add a node at the end of a wire | drag a wire from a port and let go over the empty canvas: the palette opens with the nodes that fit, and the one you choose is connected |
| put a node into a wire | drop it on the wire; or select the wire and choose **Graph → Insert Node…** |
| move a wire to another input, or take it off | drag its end off the input, to another input or onto the canvas |
| cut wires | hold `Y` and drag across them, or hold `Ctrl` and drag with the right button |
| select | press a node; `Shift` or `Ctrl` adds to the selection; a drag over the canvas draws a box; `Ctrl+A` selects all. A press on one of several selected nodes, let go without a drag, selects that one alone |
| move | drag a node, or one of several selected ones to move them all. `Esc` during a drag puts everything back |
| pan and zoom | the wheel zooms about the pointer; drag with the middle button, or hold `Space` and drag, to pan; `Home` or `Ctrl+0` fits the graph |
| copy between projects | `Ctrl+C`, `Ctrl+X`, `Ctrl+V`: nodes, their wires and their groups travel as text, also to another running Orogen. (Checked through the page's clipboard events; the desktop's own clipboard path has not been exercised.) |
| group | `Ctrl+G` puts a frame around the selection; drag its title bar to move it with its contents, its corner to resize it, double-click its title to name it |
| rename, bypass, duplicate, delete, collapse | `F2`, `B`, `Ctrl+D`, `Delete` or `Backspace`, `H` |

A node shows a thumbnail of its first output and, at its foot, a status: the time its last run took, *Cached*,
a progress while it runs, *Bypassed*, *Missing input: …* in amber for an input nothing is connected to, or its
error in red. A small eye in the header marks the node the viewport shows.

A minimap appears in the corner while part of the graph lies outside the panel; `M` hides and shows it.

Two things to know:

- A mask that hangs behind a simulation and is not part of what the viewport shows has **an empty thumbnail
  until it is selected once**: thumbnails are made in idle moments only from nodes that are quick to compute.
- A node added by a double click in the Library lands in the middle of the Graph panel, on top of whatever is
  there. Nodes cannot be reached with the keyboard alone, and there is no snapping, alignment or automatic
  layout.

## Viewport

| You want to | Do this |
| --- | --- |
| turn the camera | drag with the left or the middle button; the arrow keys turn it in steps |
| pan | `Alt` or `Shift` with the middle button |
| come nearer | the wheel, towards the point under the pointer; `Alt` with the right button; `+` and `-` |
| fly | hold the right button and use `W` `A` `S` `D`, `Q` and `E` for down and up; the wheel changes the speed |
| centre a point | double-click it |
| see the whole terrain | `F` frames it and keeps the direction; `Home` also returns to the direction a new session looks from |
| look from above | `F6`, or **Top** in the toolbar: the heightmap's first row is at the top, +X to the right and +Y down the screen, as Unreal lays it out |
| move the sun | hold `Shift` and drag in the view, or open **Sun** in the toolbar |

The toolbar chooses 3D or top view, the shading (*Material* or *Clay*; in the top view *Hillshade*, *Height* or
*Overlay*), the overlay with its opacity and palette, the sun, the vertical scale of the picture (*Height ×*;
the terrain itself keeps its heights), and whether the sea is drawn at the project's sea level. At its right
end it names the output that is shown, a word when the picture is not current (*Draft*, *Updating*, *Out of
date*, *Missing input*, *Node failed*, *Overlay failed*, *Device lost*), and the resolution. Under a resting
pointer the view reads out the position in metres and the height.

**Selecting shows** (the rule is the same everywhere). A terrain that is selected becomes the terrain shown,
without an overlay. A mask, a data field or a colour map that is selected is drawn over the terrain that is
already shown: a mask as a tint, a data field through a colour ramp from its lowest to its highest value, a
colour map as it is. `F` in the graph locks the view to a node, so that selecting other nodes changes the
inspector and not the picture; `G` makes the selected node the terrain shown even then. What the viewport
shows, and the place of the graph, are saved with the project.

The camera, the sun, the vertical scale and the shading are **not** kept when the application closes.

## Inspector

With nothing selected it shows the project settings: terrain size, height range, sea level, seed, build
resolution and preview level. With a node selected it shows the node's title (type a new one; `F2`), a
*Bypass* box, what the node does, its status, the range and mean of its output, and its parameters. With
several nodes of one type it edits them together; with nodes of different types it lists them.

| Control | How it works |
| --- | --- |
| a number | drag across it to change it (`Shift` for fine steps, `Ctrl` to snap); press it once to type. A typed value may be arithmetic (`0.2 + 0.1`), a percentage, or a change of the value (`+=5`) |
| a length or a height | stored as a fraction of the terrain's width or of the height range, shown with its metres beside it. Type either: `500m` on a terrain 5 km wide stores 0.1 |
| a direction | a dial: 0° points right and 90° down, as the top view shows it |
| a colour | a swatch that opens a picker; the hex code beside it |
| a curve, a gradient | a press on the plot or the strip adds a point or a stop and goes on dragging it; one that is dragged well away is removed; `Shift` moves finely and `Ctrl` snaps. The curve has presets, the gradient palettes and a reversal; a double click on a stop opens its colour |
| a file | the dialog button chooses it; **Reload** reads it again. That a file is missing is known once its node has run |
| a row that differs from its default | is marked, with a button that resets it; the head of the panel resets all |

A drag is one undo step however long it lasts, and `Ctrl+Z` right after a drag takes it back. Two drags of the
same control within 0.6 s count as one step.

## Library

**Nodes** lists the 86 nodes by category, in the categories' colours. Type to search: the search looks at
titles, keywords, and the names other tools use (searching `terrace` or Gaea's `FractalTerraces` finds
Terraces). Select a node to read its ports and what it does; `Enter`, a double click or **Add** puts it into
the graph, and it can be dragged there. The nodes used most recently are listed first.

**Examples** holds six complete projects: First Terrain, Alpine Range, Temperate Hills, Volcanic Island, Desert
Canyons and Cratered Highland. Each opens as a new project without a file, after asking about unsaved changes.
**File → Open Example…** shows the same list in a dialog.

## Build

| Part | Says |
| --- | --- |
| Resolution | 1009, 2017, 4033 or 8129 vertices a side (a project file with another size keeps it), the metres per vertex, the landscape layout Unreal gives that size, and the resolution previews then run at |
| GPU memory | the least a build at that size holds at once, against the budget. It is a lower bound: it can say that a build will not fit, not that it will |
| Output folder | chosen once for each project file and remembered. The folder belongs to the build: every build replaces everything in it, and a folder that holds anything else is refused and not touched |
| Exports | every export node, by the name it exports under and the node that feeds it, with what is wrong that can be told before a build: nothing to export, or an export without an input |
| Build, Cancel | `Ctrl+B` starts. While a build runs, the panel shows each stage and each target with its progress and time; previews pause and the viewport keeps its last picture |
| Result | the files with their sizes, the time each stage took, and under *Unreal Import* the values for the New Landscape panel in its order, each with a copy button. **Show Folder** opens the output folder and **Import Guide** the steps of [the import by hand](unreal-import.md) |

Two things to know:

- **The preview resolution follows the build resolution.** Previews run at a level of the build resolution
  (a quarter by default). Choosing 1009 in place of 4033 therefore takes the previews from 1009 to 253. Raise
  the *Preview* setting in the inspector's project settings if that is too coarse.
- **The files, their sizes and most problems are known only once a build has planned**, which is its first
  step, before anything is computed or written. A name used twice is found by pressing Build, not before.

The build of the Alpine Range example at 4033 × 4033 took 52 s from the application on the development machine
(14 files, 147 MB), with the window in use throughout.

## What holds everywhere

**Edits are answered at once, coarsely, then finely.** While you drag a value, the graph is computed at a
coarser level and shown as a draft; when you let go, it is computed at the preview resolution. Only the newest
state of the project is computed.

**Everything can be undone** except what is only a view: what the viewport shows, the place of the graph, and
the build and preview resolutions. The history holds up to 500 steps.

**An unfinished node is not a failed one.** A node whose input is not connected yet says *Missing input* in the
graph, in the inspector, in the viewport and in the status bar, in amber. A node that failed says so in red in
the same four places, and the list behind the status bar's count has the details. Both clear in all of them
when the cause is gone.

**A lost graphics device is recovered.** If the driver resets, the application opens the device again, at once,
after one second and after five, computes the project anew and draws the viewport and the thumbnails again; a
drag that was under way goes on. After three failures it stops trying: **Engine → Retry Graphics Device**.
**Engine → Restart Engine** starts the engine anew when it hangs; the project is not in the engine, so nothing
is lost. (Killing the GPU process and restarting the engine in the middle of a drag are tested on Linux.)

**A software adapter is said** in the status bar for as long as the application runs on one: everything is then
slow.

## Keys

The defaults; **Edit → Preferences… → Keys** changes them. `Mod` is Ctrl on Windows and Linux. A key of a panel
works while that panel has the focus, which a press in it gives. While text is being typed, letters are
letters.

| Key | Does | Where |
| --- | --- | --- |
| `Mod+N`, `Mod+O`, `Mod+S`, `Mod+Shift+S` | new, open, save, save as | everywhere |
| `Mod+Z`; `Mod+Shift+Z` or `Mod+Y` | undo; redo | everywhere |
| `Mod+,` | the preferences | everywhere |
| `Mod+Shift+P` or `F1` | the command palette | everywhere |
| `` ` `` (the key left of 1) | pause and resume previews | everywhere |
| `Mod+B` | start a build | everywhere |
| `F6` | the view from above, and back | everywhere |
| `Tab` | add a node | graph |
| `Delete` or `Backspace` | delete the selection | graph |
| `Mod+D` | duplicate | graph |
| `B` | bypass | graph, inspector |
| `F` | lock the view to the selected node | graph |
| `G` | use the selected node as the terrain shown | graph |
| `Mod+G` | group | graph |
| `F2` | rename | graph, inspector |
| `Mod+0` or `Home` | fit the graph into the panel | graph |
| `Mod+A`, `H`, `M` | select all, collapse or expand, the minimap | graph |
| `F` | frame the terrain | viewport |
| `Home` | reset the view | viewport |
| `Mod+F` | find a node | library |

## Preferences

**Edit → Preferences…** (`Ctrl+,`) has three pages. *Graphics*: the share of the graphics memory Orogen may
use, and the amount of that memory where the system does not report it. *Keys*: the key of every command.
*General*: the reset of the layout, of the list of recent projects and of the changed keys.

## How it is started

`npm start` builds the application into the folder `dist` and starts it; `npm run build` and then
`npx electron .`, both in the repository's folder, do the same in two steps. `npx electron . D:\Terrains\ridge.orogen`
starts it with that project. `npm run dist:win` packs a zip and a portable executable for Windows into the
folder `release`; that package has never been started.

## Known gaps

- Not run on Windows, on Direct3D 12, on the RTX 3080, or in a visible window.
- Resizing the *window* has not been tested: in a window that is never shown it ends the graphics process, and
  whether a visible window does the same is unknown. Dragging the dividers between panels is tested and harmless.
- No plan before a build (see Build), no custom build resolution in the interface, no reroute nodes.
- The viewport's camera and display options, the library's recent nodes and the build folders are kept in the
  application's own storage or not at all, and not in the project file.
- The panels cannot say that previews are *paused*: the status bar says it; the inspector says *Not computed*
  and the viewport *Out of date*.
