# First run on Windows: what to try and what to send back

Orogen has never been started on a Windows desktop. It was built and tested on Linux, in a window that is never
shown, with input that tests send. On Windows the project's automated checks run the engine's tests on a
software adapter, pack the application, and start it once, hidden, on a machine without a graphics card. This
page is the short list of what to try first on the target machine (Windows 11, RTX 3080), in the order that
finds the worst problems first, and what to send back for each step.

Work down the list. **When a step fails, stop there and report it**: the later steps depend on the earlier ones,
and a report of the first failure is worth more than a list of everything that followed from it.

## Before you start

| Have ready | Why |
| --- | --- |
| The Windows build: the artifact `Orogen-windows-x64` of the latest green `ci` run ([getting started](getting-started.md#1-the-windows-build-without-installing-anything)) | steps 1 to 10 need nothing else |
| The repository checked out with Node.js, as [getting started](getting-started.md#2-from-the-repository) describes | steps 11 to 13: the command-line program writes the acceptance pattern and runs the tests |
| Unreal Engine 5.8.3 or later | steps 11 and 12 |
| Task Manager, **Performance**, **GPU**: the graph *Dedicated GPU memory* | the memory figures of steps 9 and 10 |
| `Win+Shift+S` | a screenshot of the whole window, with the status bar at its foot, says more than a description |

Write down the version of Windows (`winver`), the graphics driver's version (NVIDIA Control Panel, *System
Information*), and the display's resolution and scaling (Settings, *Display*).

## The list

| # | Do | Expected | Send back |
| --- | --- | --- | --- |
| 1 | Unpack the artifact and start `Orogen.exe`. Windows will say that it protected your PC, because the build is unsigned: **More info**, **Run anyway** | One window opens within a few seconds, dark, with a menu bar at the top, a 3D view, a graph below it and, at the right, the **Inspector** above the two tabs **Library** and **Build**. The whole window is on the screen | How long until the window appeared. A screenshot. If nothing appears: [nothing opens](#if-nothing-opens) |
| 2 | Read the status bar, at the foot of the window, left | `Ready`, then the adapter: it should name the RTX 3080. For a few seconds after the start it may say `Starting graphics device` | The exact text. `Software adapter: everything is slow` or a name with `Microsoft Basic Render Driver` means Orogen is not on the card: stop. `Graphics device failed`: hold the pointer over it for the reason, press **Retry** once, and say whether that helped. `No graphics device`, with a window *Orogen found no graphics device it can use*: the card offered Orogen nothing; write down the driver's version, and do not choose *Restart with Software Rendering* for this test |
| 3 | Read the status bar, right: *GPU memory … of …* | a budget near 6 GB, which is 60 % of the card's dedicated memory. `of 2.4 GB` means the card's memory is not reported to the application, and Orogen assumes 4 GB | The two numbers. If it says 2.4 GB, set the memory in **Edit → Preferences… → Graphics** and say that you had to |
| 4 | Look at the 3D view | A lit mountain range on a green plain, cut out as a slab, and in the graph one node, *Mountain Range*, with a small picture of its terrain. The **Inspector**, at the top right, shows the project settings | A screenshot if the view is black, empty, flickers, or shows the terrain upside down or in wrong colours |
| 5 | Resize the window: drag an edge, maximise it, restore it, drag it to another monitor if there is one | The picture follows, and the status bar keeps saying `Ready` | Whether the status bar said `Graphics device lost, recovering` at any point, and whether the picture came back. **This is the one thing known to go wrong in the tests' never-shown window; nobody knows what a visible one does.** Then close Orogen and start it again: say whether the window came back at the place and the size it had |
| 6 | Turn the camera: drag in the 3D view; turn the wheel; press `F6` and `F6` again; hold the right button and press `W` | The view turns, comes nearer, switches to the view from above and back, and flies forward | Whether it is smooth. Anything that does not respond, jumps, or responds only after another click |
| 7 | In the **Library** panel, at the lower right: **Examples**, **Open** on *Alpine Range* | The example opens; the status bar shows `Computing` with a progress and then goes quiet; the view shows a snow-capped range in colour. The graph is fitted into its panel: at that size its nodes are blocks in the colours of their categories, without names or thumbnails, and what can be read are the names of the groups | The seconds from the click until the status bar is quiet (on the development machine's GTX 1660 Ti a few seconds). A screenshot |
| 8 | Turn the wheel over the graph: the nodes get their names, and nearer still their thumbnails. Press the node *Gullies and Fans*, and in the **Inspector** drag across the number *Rain*; let go; press `Ctrl+Z` | While you drag the view shows a coarser picture and says `Draft`; after you let go it is computed finely; `Ctrl+Z` puts the old value back | Whether the drag feels direct, and how long the fine picture takes after letting go |
| 9 | **Build** tab, beside the Library's. Under *Plan* it lists the 14 files a build would write, before anything is built. Leave *Resolution* at 4033 × 4033. **Choose…** a folder that is new or empty, on a disk with a few hundred megabytes free and outside what OneDrive synchronises (not under *Documents* or *Desktop* if those are backed up): `D:\Build\Alpine`, say. **Build** | The panel shows the stages with their progress, then `Build finished` and the time, the files, and *Unreal Import* with the values for Unreal's panel | The time the panel states, the peak of *Dedicated GPU memory* in Task Manager, the number and total size of the files. On the development machine: 52 s, 14 files, 147 MB (the folder holds 15: the build's report is not counted). Any `Graphics device lost`. Then press **Build** once more with the same folder, with an Explorer window open on that folder: say whether the second build also finishes (it replaces the folder, which Windows refuses while another program holds something in it) |
| 10 | In the **Build** tab choose *Resolution* 8129 × 8129. The previews stay about as they were: the panel says that they run at 1017 × 1017. **Build** into another new folder | The same as step 9, later | The time, the peak of *Dedicated GPU memory*, the peak memory of the Orogen processes, whether the window stayed usable, and whether the device was lost. Windows resets a graphics device that does not answer for two seconds; Orogen cuts its work into short pieces to stay below that, and this build is the first real test of it |
| 11 | In the repository: `node src/cli/main.ts unreal-test --out D:\Build\Marker`. Import `D:\Build\Marker` into Unreal Engine by [the steps of the import guide](unreal-import.md#2-steps), with the values of `Marker.orogen.json` | The 13 checks of [the acceptance test](unreal-import.md#62-expected-result) | For each check: passed or what you saw. The engine's exact version. This decides whether Orogen's conventions for orientation, location and heights are right; **nobody has imported anything of Orogen's into Unreal** |
| 12 | Import the build of step 9 the same way. The values are under *Unreal Import* in the Build panel, each with a copy button, and **Import Guide** opens the steps | A landscape that looks like the terrain in Orogen's view from above (`F6`), with its layers | A screenshot from Unreal next to one of Orogen's top view. Every field of Unreal's panel whose name or behaviour differs from the guide. Whether a pasted number arrived whole: a Windows set to a decimal comma may read `198.4126984126984` differently |
| 13 | In the repository, from PowerShell: `node src/cli/main.ts probe`, then `npm run test:gpu`, `npm run test:gpu:max`, `npm run build`, `npm run test:electron`, `npm run test:ui` | Every case passes. The suites take a while, and the last two start the application many times in windows that are never shown: leave the machine alone meanwhile | The output of `probe`, and for each suite the last twelve lines (`tests`, `pass`, `fail`) and the name and message of every failing case |

Steps 9 and 10 are worth doing twice: a second build of an unchanged project should write the same bytes.

## What to send back, in one place

1. Windows version, driver version, display resolution and scaling.
2. For each step: what the *Send back* column asks for. A step that simply worked needs one word.
3. For the first step that failed: a screenshot of the whole window, the text of the status bar, the log file
   (below), and the list of messages: **View → Show Errors** opens *Errors and Messages*, whose text can be selected and copied. (The
   status bar shows *n nodes failed*, *n nodes lack an input* or *Messages* at its right end when the list
   holds something, and a click there opens it too.)
4. The output of `node src/cli/main.ts probe` if the repository is checked out: it is what Orogen sees of the
   graphics device, as JSON, and it is the first thing asked for in any report about the device.

**The log file.** Orogen appends what went wrong to `%APPDATA%\orogen\logs\orogen.log` (paste that path into
Explorer's address bar): errors of the application and of its interface, and every time one of its processes
ended unexpectedly, the graphics process among them, each with its time. Send it with any report. (The file is
new and has not been looked at on Windows; if it is not there, say so.) Beside it:

| Source | How |
| --- | --- |
| The messages of the application | **View → Show Errors** (above): failed nodes with their details, the problems of the last build, a graphics device that could not be opened, and the notices of the session |
| The console of the page and of the engine | `Ctrl+Shift+I` should open the developer tools (the native menu holds the command; untried on Windows). Their **Console** tab holds the errors of the interface and of the engine worker; right-click, *Save as…* |
| Chromium's own log, which includes errors of the graphics process | start from PowerShell in the unpacked folder: `.\Orogen.exe --enable-logging=file --log-file="$env:TEMP\orogen-chromium.log"`. These are switches of Electron itself, not of Orogen; untried here |
| What the automated check saw | each `ci` run starts the packaged application once on a Windows machine without a graphics card and keeps what it saw as the artifact `launch-check-windows` |

## If nothing opens

1. Look in Task Manager, **Details**, for `Orogen.exe`. Several entries and no window: note it, end them, and start
   again from PowerShell with the logging switches of the table above; send the log.
2. No entry at all: Windows or a virus scanner stopped it. Right-click the downloaded zip, **Properties**,
   **Unblock**, unpack it again, and start again. Say which of the two it was.
3. An error box titled *Orogen* says what failed: `The interface did not load` or `The application did not
   start`, with a reason. Send its text.
4. The page shows *Orogen could not start* and a message: send the message.

## Known before you start

These are not defects to report; they are what the code does today.

| What | Detail |
| --- | --- |
| `.orogen` files are not connected to Orogen | neither the zip nor the portable executable registers the extension. **Open with**, *Choose another app*, `Orogen.exe` should work, since the application opens the file it is started with; nobody has tried it |
| One Orogen runs at a time | a second `Orogen.exe` brings the window of the first forward and ends; given a project file, it has the first open that file. Untried on Windows |
| The window | opens where it was closed, at the size it had. A first start asks for 1600 × 1000 and takes less on a display whose usable area is smaller (1920 × 1080 at 125 % scaling, for one). Say what you saw |
| The portable executable is slow to start | it unpacks itself into the temporary folder every time, with nothing on the screen meanwhile. The unpacked folder has nothing to unpack |
| Orogen's own files | the folder `%APPDATA%\orogen`: `preferences.json` (the layout, the keys, the recent projects, the graphics memory, the viewport's shading, the library's recent nodes and each project's output folder), `window.json` (where the window was), `recovery.json` while a project has unsaved changes, and `logs`. Deleting `preferences.json`, with Orogen closed, is the reset. (The folder follows from Electron's rule for an application named `orogen`; it has not been looked at on Windows.) |
| After a crash | when Orogen ended without a save (it was ended from Task Manager, the machine lost power), the next start asks whether to restore the unsaved changes. If the interface stops while Orogen runs, a dialog offers to reload the window. Neither has been seen on Windows: if it happens, say what appeared |
| The camera, the sun, the vertical scale and the sea | are saved with the project, once the project is saved. The shading and the overlay's palette are kept with your preferences |
| Help | **Help → User Guide** shows these pages inside the application |
