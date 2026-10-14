# The desktop application

The application is built: a graph editor, a 3D viewport, an inspector, a node library with example projects, and
a build panel that writes the files Unreal Engine imports. A terrain can be made in it from an empty project to
a finished build without the command line.

**What it has and has not been run on.** Everything on this page was checked on Linux (GTX 1660 Ti), in a
window that is never shown, with input that the tests send to the page. On Windows the automated checks pack it
and start it once, hidden, on a machine without a graphics card. **Nobody has seen its window on Windows, no
test has looked at it in a visible window, and no real mouse has driven it.** Where a sentence below rests on
something else than such a test, it says so. [First run on Windows](first-run-on-windows.md) is the list of what
to try first on such a machine.

![The application with the Alpine Range example open](images/application.png)

## A first session

1. Start it: `Orogen.exe` of the Windows build, or `npm start` in the repository's folder
   ([getting started](getting-started.md)). It opens with a project of one Mountain Range node, shown in 3D.
2. In the **Library** panel, at the lower right, press **Examples**, and **Open** on *Alpine Range*. The example
   opens as a new project without a file. Its graph is fitted into the Graph panel; at that size the nodes are
   blocks in the colours of their categories and the names you can read are those of their groups.
3. Turn the wheel over the graph to come nearer: the nodes get their names, and nearer still their thumbnails
   and the labels of their ports. Press a node: the **Inspector**, above the Library, shows its parameters and
   the viewport shows its output.
4. Drag across a number in the inspector. While you drag, the viewport shows a coarser draft and says *Draft*;
   when you let go it is computed at the preview resolution. `Ctrl+Z` takes the drag back.
5. Press the **Build** tab, beside the Library's. It lists what a build would write, before anything is built.
   Choose a resolution and an output folder, and press **Build**. When the build has finished, the panel lists
   the files and, under *Unreal Import*, every number the New Landscape panel of Unreal Engine asks for, each
   with a button that copies it.
6. `Ctrl+S` saves the project as a `.orogen` file.

## The window

A menu bar, five panels, and a status bar.

| Part | Holds |
| --- | --- |
| Menu bar | **File**, **Edit**, **View**, **Engine**, then one menu for each of **Viewport**, **Graph**, **Inspector** and **Library**, and **Help**. In the middle the project's name, with *(unsaved)* while it has changes. At the right a button that pauses and resumes previews, and one for the preferences |
| Panels | **Viewport** above **Graph** at the left; at the right a column with the **Inspector** above, and **Library** and **Build** as two tabs below it. Drag a tab to rearrange; the layout is kept for the next start, and **View → Reset Layout** brings this one back |
| Status bar | the graphics device and its adapter; what is being computed, with its progress; the resolution of the picture, and *Draft*, *Updating*, *Paused* or *Out of date* when the picture is not the project as it is; graphics memory in use against its budget; and, when there is something to say, *n nodes failed*, *n nodes lack an input* or *Messages*, which open the list |

The Inspector is always in view: selecting a node shows its parameters whichever of Library and Build is in
front. Of those two one is in front at a time, and a command that shows something in the Library
(**Library → Find Node…**, **Show Node Library**, **Show Example Projects**) brings its tab to the front.

**Help** holds the *User Guide*, the *Unreal Import Guide* and the *First-Run Checklist*, which are these pages,
shown in a reader inside the application: links between the pages work there, and nothing has to be installed
to read them. *About Orogen* says the version, the graphics adapter and the memory budget.

Every command is in a menu and in the command palette (`Ctrl+Shift+P` or `F1`), which lists them all with the
panel each belongs to and finds one by a few of its letters.

## Graph

| You want to | Do this |
| --- | --- |
| add a node | `Tab` opens a palette where the pointer is: type a few letters of its name, of a keyword, or of the name another tool has for it (`erosion2`, `combiner`), then `Enter`. Or drag a node in from the Library, or double-click it there. The palette and the Library list the same 86 nodes and search them the same way |
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

**How much a node shows depends on the zoom.** From 55 % up everything is drawn. Between 30 % and 55 % the
labels of the ports and the status line are left out. Below 75 % the names of the nodes are drawn larger than
the rest, so that they stay readable (9 to 12 pixels high on screen), and below 55 % the names of the groups
are drawn at the screen's size. Below 30 % the nodes are blocks in the colours of their categories, with the
groups' names.

Things to know:

- **A node added from the Library continues from the selected node.** With one node selected, `Enter`, a double
  click or **Add** in the Library puts the new node to the right of it and connects the selected node's first
  output to it; the new node is then the selected one, so that adding nodes one after the other builds a chain.
  With nothing selected, or several nodes, the new node is not connected and goes to the middle of the Graph
  panel. Either way it is put where it covers no other node. A node that is dragged in, or added with `Tab`,
  goes where the pointer is.
- Thumbnails are made in idle moments, for the nodes that are large enough on screen to show one.
- Nodes cannot be reached with the keyboard alone, and there is no snapping, alignment or automatic layout.

## Viewport

| You want to | Do this |
| --- | --- |
| turn the camera | drag with the left or the middle button; the arrow keys turn it in steps. `Ctrl` with any drag moves a quarter as far, for fine work |
| pan | `Alt` or `Shift` with the middle button; on a trackpad, two fingers |
| come nearer | the wheel, towards the point under the pointer; `Alt` with the right button; `+` and `-`; on a trackpad a pinch, and with a mouse `Ctrl` and the wheel |
| fly | hold the right button and use `W` `A` `S` `D`, `Q` and `E` for down and up; the wheel changes the speed |
| centre a point | double-click it |
| see the whole terrain | `F` frames it and keeps the direction; `Home` also returns to the direction a new session looks from |
| look from above | `F6`, or **Top** in the toolbar: the heightmap's first row is at the top, +X to the right and +Y down the screen, as Unreal lays it out |
| move the sun | hold `Shift` and drag in the view, or open **Sun** in the toolbar |

The toolbar chooses 3D or top view, the shading (*Material* or *Clay*; in the top view *Hillshade*, *Height* or
*Overlay*), the overlay with its opacity and palette, the sun, the vertical scale of the picture (*Height ×*;
the terrain itself keeps its heights), and whether the sea is drawn at the project's sea level. At its right
end it names the output that is shown, a word when the picture is not current (*Draft*, *Updating*, *Paused*,
*Waiting*, *Out of date*, *Missing input*, *Node failed*, *Overlay failed*, *Device lost*), and the resolution.
Under a resting pointer the view reads out the position in metres and the height. Where there is no picture to
trust, the view is covered and says why in two lines: what is the matter, and what to do about it.

A trackpad and a mouse wheel send the same kind of event, and the application tells them apart by the size of
the steps: a wheel that sends very small steps (a high-resolution or smooth-scrolling one) is taken for two
fingers and pans. Neither has been tried with a real device.

**Selecting shows** (the rule is the same everywhere). A terrain that is selected becomes the terrain shown,
without an overlay. A mask, a data field or a colour map that is selected is drawn over the terrain that is
already shown: a mask as a tint, a data field through a colour ramp from its lowest to its highest value, a
colour map as it is. `F` in the graph locks the view to a node, so that selecting other nodes changes the
inspector and not the picture; `G` makes the selected node the terrain shown even then. What the viewport
shows, and the place of the graph, are saved with the project.

**What is kept.** With the project, in its file: whether the view is 3D or from above, both cameras once you
have moved them, the sun, the vertical scale and whether the sea is drawn. With you, in the preferences: the
shading, the style of the top view and the palette of the overlays. A project that is only opened and looked at
is not changed by this.

## Inspector

With nothing selected it shows the project settings: terrain size, height range, sea level, seed, build
resolution and preview level, and under them the resolution previews run at. With a node selected it shows the node's title (type a new one; `F2`), a
*Bypass* box, what the node does, its status, the range and mean of its output, and its parameters. With
several nodes of one type it edits them together; with nodes of different types it lists them.

| Control | How it works |
| --- | --- |
| a number | drag across it to change it (`Shift` for fine steps, `Ctrl` to snap); press it once to type. A typed value may be arithmetic (`0.2 + 0.1`) or a change of the value (`+=5`); an amount from 0 to 1 may be typed as a percentage (`25%`). A comma between two digits is read as the decimal point, so `0,5` is 0.5. An entry that is not understood stays in the field with a red border and changes nothing |
| a length or a height | stored as a fraction of the terrain's width or of the height range, shown with its metres beside it. Type the fraction, the metres or a percentage: on a terrain 5 km wide `500m`, `0.1` and `10%` all store 0.1. A bare number is the fraction, not metres: `99` in a length field is 99 terrain widths |
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
Terraces; `export` and `output` find the export nodes, Unreal Landscape first). Several words are found in any
order, a plural is found by its singular, and `colour` is read as `color`. Select a node to read its ports and
what it does; `Enter`, a double click or **Add** puts it into the graph (see Graph for where), and it can be
dragged there. The nodes used most recently are listed first, and are remembered for the next start.

**Examples** holds six complete projects: First Terrain, Alpine Range, Temperate Hills, Volcanic Island, Desert
Canyons and Cratered Highland. Each opens as a new project without a file, after asking about unsaved changes.
**File → Open Example…** shows the same list in a dialog.

## Build

| Part | Says |
| --- | --- |
| Resolution | 1009, 2017, 4033 or 8129 vertices a side (a project file with another size keeps it), the metres per vertex, the landscape layout Unreal gives that size, and the resolution previews run at |
| GPU memory | the least a build at that size holds at once, against the budget. It is a lower bound: it can say that a build will not fit, not that it will |
| Output folder | chosen once for each project file and remembered. The folder belongs to the build: every build replaces everything in it, and a folder that holds anything else is refused and not touched |
| Plan | what a build of the project as it is would write, before Build is pressed: every export node with its files, their formats and sizes, the node that feeds it, and every problem that would stop the build (nothing to export, an export without an input, a name used twice, a size no landscape has). A project that exports textures or images and no terrain is told so: *No Unreal Landscape node: this build writes no heightmap* |
| Build, Cancel | `Ctrl+B` starts. While a build runs, the panel shows each stage and each target with its progress and time; previews pause and the viewport keeps its last picture |
| Result | the files with their sizes, the time each stage took, and under *Unreal Import* the values for the New Landscape panel in its order, each with a copy button. **Show Folder** opens the output folder and **Import Guide** the steps of [the import by hand](unreal-import.md) |

Two things to know:

- **Changing the build resolution leaves the previews about as they were.** Previews run at a level of the
  build resolution, and when another build resolution is chosen, the level nearest to the resolution they had
  is chosen with it: with previews at 1009, a build at 1009 previews at 1009 and a build at 8129 at 1017. The
  panel and the inspector's project settings say the resolution previews run at; the *Preview* setting there
  changes it.
- **The plan is of the project as it is now.** It follows every change after a moment. After a build, the
  panel shows that build's plan and result until the project changes; then the plan is the new project's
  again, and the result says that the project has changed since.

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
drag that was under way goes on. After three failures in a row, or a third loss within two minutes, it stops
trying by itself: **Engine → Retry Graphics Device**. (Tested on Linux by killing the GPU process: once, twice
ten seconds apart, and while the engine was starting. A driver reset on Windows has not been tried.)

**An engine that has stopped answering is said.** When the engine has answered nothing for about twenty
seconds, the status bar says *Engine not responding* with a **Restart Engine** button; **Engine → Restart
Engine** does the same at any time. The project is not in the engine, so nothing of it is lost. A build that
was running when the engine is restarted has stopped: the Build panel says so, and the output folder holds
what it held before.

**A software adapter is said** in the status bar for as long as the application runs on one: everything is then
slow. If the engine comes back on a software adapter after it had the graphics card, a notice says so and that
restarting Orogen brings the card back.

**A graphics device that was not found is said too.** When the engine finds no adapter as it starts, it asks
again after one second and after five. If there is still none, the status bar says *Graphics device failed*
with a **Retry** button, which starts the engine anew.

**Unsaved work is kept for a run that ends badly.** A project with changes that are not saved is kept, in the
application's own folder, three seconds after a change and at once when a build starts. If Orogen then ends
without a save (its interface stops, the machine loses power, it is ended from outside), the next start asks
*Restore the unsaved changes to …?* **Restore** opens the project with those changes, unsaved, under the name
of its file, which is not touched until you save; **Discard** removes what was kept. What is kept is removed
when the project is saved and when the window is closed in the ordinary way. If the interface's own process
ends while the application runs, a dialog offers to reload the window, which then asks the same question. (The
reload and the question are tested on Linux by killing that process; the dialog before it has not been seen.)

**A project file that changed elsewhere is not overwritten without a question.** If another program, or a copy
of the project opened elsewhere, has saved the file since Orogen opened or last saved it, **Save** asks first:
*Overwrite*, *Save As…* or *Cancel*.

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

From the Windows build: `Orogen.exe` ([getting started](getting-started.md#1-the-windows-build-without-installing-anything)).
From the repository: `npm start` builds the application into the folder `dist` and starts it; `npm run build`
and then `npx electron .`, both in the repository's folder, do the same in two steps. Either way the first
argument is a project to open: `Orogen.exe D:\Terrains\ridge.orogen`, `npx electron . D:\Terrains\ridge.orogen`.
`npm run dist:win` packs the application for Windows into the folder `release`, as a folder, a zip and a
portable executable.

How it behaves as a program on the desktop (none of this has been seen on Windows):

- **One Orogen runs at a time.** A second start brings the window of the first forward and ends; when it was
  given a project file, the first opens that file, after asking about unsaved changes.
- It registers no file type: a double click on a `.orogen` file does not start it. **Open with** and `Orogen.exe`
  does, since the file arrives as the first argument, also when Orogen is running already.
- **The window opens where it was closed**, at the size it had, as long as that place is still on a screen;
  a first start asks for 1600 × 1000 and takes less where the screen's usable area is smaller (1920 × 1080 at
  125 % scaling, for one).
- **It keeps a log file**, `logs\orogen.log` in the folder below: errors of the application and of its
  interface, and every time one of its processes ended unexpectedly, the graphics process among them. It is the
  file to send when something went wrong. **View → Show Errors** lists what the running application knows.

The application's own files are in one folder under the user's application data: `%APPDATA%\orogen` on Windows
and `~/.config/orogen` on Linux, by Electron's rule for an application of that name (neither folder has been
looked at: the tests keep theirs in a temporary folder). It holds `preferences.json` (the layout, the keys, the
recent projects, the graphics memory settings, the viewport's shading and what the panels remember: the
library's recent nodes and each project's output folder), `window.json` (where the window was), `recovery.json`
while a project has unsaved changes, and `logs`. Deleting `preferences.json` while the application is closed
resets the layout, the keys and the list of recent projects; one that cannot be read is replaced by a fresh one
and kept beside it as `preferences.json.bad`.

## Known gaps

- Not run on a Windows desktop, on Direct3D 12 hardware, on the RTX 3080, or in a visible window. The packed
  Windows build is started once by the automated checks, hidden, on a machine without a graphics card.
- Resizing the *window* has not been tested: in a window that is never shown it ends the graphics process, and
  whether a visible window does the same is unknown. Dragging the dividers between panels is tested and harmless.
- No custom build resolution in the interface, no reroute nodes.
- The export to Unreal Engine has not been imported into Unreal Engine by anybody: the Build panel and the
  import guide say so where it matters, and [first run on Windows](first-run-on-windows.md) asks for exactly
  that test.
- An import node that has no file yet is shown as a failed node (*No file selected*, in red), not as an
  unfinished one.
- After a build at the preview's own resolution the preview is computed once more, although nothing changed.
- Saving does not notice that the file changed elsewhere until something is saved: a project that shows as
  saved may not be what its file holds, when another program wrote the file in between.
