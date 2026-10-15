// The text of the import guide: the legend and sections 1 to 4 of docs/user/unreal-import.md, word for word.
// Written by tests/ui/build/make-guide.ts; do not edit it by hand. tests/ui/build/unit/guide.test.ts fails when
// the document says something else.

import type { GuideSection } from './guide.ts';

export const GUIDE_DOCUMENT = "docs/user/unreal-import.md";

/** How far a statement about Unreal has been checked, and how far the procedure has been run. */
export const GUIDE_LEGEND: { readonly lead: string; readonly marks: readonly string[]; readonly warning: string } = {
  "lead": "Each statement about Unreal says how far it has been checked:",
  "marks": [
    "**confirmed**: read in Epic's documentation or API reference for 5.8; or, where the statement says \"seen on 5.8.3\", seen in Unreal Engine 5.8.3 in the run of section 6.5.",
    "**third party**: confirmed only by someone other than Epic.",
    "**derived**: computed from confirmed facts.",
    "**unconfirmed**: recalled, inferred, or reported by users; not confirmed for 5.8. The wording of menus and panels in the steps below was not checked item by item, and the run of section 6.5 was made in a French editor: it is unconfirmed unless a step says otherwise."
  ],
  "warning": "This procedure has been run once, on one machine, with Unreal Engine 5.8.3 (section 6.5). Run the acceptance test (section 6) once on your engine version before you trust an import."
};

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  {
    "number": 1,
    "title": "Before you start",
    "before": [],
    "list": "ordered",
    "items": [
      {
        "text": "Build the project in Orogen into a folder of its own. The folder belongs to Orogen: each build replaces everything in it, and Orogen refuses to build into a folder that holds anything but an earlier build, so keep the project file and your own files elsewhere. You need `<Name>.orogen.json` (the manifest), `<Name>Height.png`, one `Layer<X>.png` per layer, and the `T_*.png` textures."
      },
      {
        "text": "Do not rename the heightmap or layer files and do not copy other images into the folder. Their names are letters only on purpose (section 4, item 3)."
      },
      {
        "text": "Use Unreal Engine 5.8.3 or later. 5.8.2 fixed a crash when editing landscape layers in Landscape Mode (confirmed, hotfix notes). Earlier 5.8 versions have the material problem of section 4, item 2; whether 5.8.3 is free of it is unconfirmed."
      },
      {
        "text": "Open the manifest in a text editor. Every number below is copied from it with all its digits. A horizontal scale shortened to two decimals moves the far edge of an 8 km terrain by about 40 cm (derived). Orogen writes numbers with a decimal point, and they arrive whole in an editor whose language writes a decimal comma: in a French editor the numbers of Orogen's Build panel showed in the actor's Transform with a comma and the same digits, to the six decimals the field displays (confirmed, seen on 5.8.3)."
      },
      {
        "text": "Make the landscape material first if you import layers. Target layers take their names from the layer names used in the landscape material (confirmed); names are case-insensitive and must equal the `name` values under `landscape.layers`. Whether the import panel offers a layer that the material does not name is unconfirmed."
      }
    ],
    "after": []
  },
  {
    "number": 2,
    "title": "Steps",
    "before": [],
    "list": "ordered",
    "items": [
      {
        "text": "Open or create the level. If the level uses World Partition, give the layers on the New Landscape panel, as step 10 says, and at 8129 × 8129 read section 4, item 1 first."
      },
      {
        "text": "Open Landscape Mode, the Manage tab, New, and choose Import from File."
      },
      {
        "text": "Heightmap File: choose `<Name>Height.png`. Unreal imports 16-bit greyscale PNG and 16-bit `.r16` heightmaps (confirmed). The `.r16` file holds the same data; that Unreal reads it as little-endian is third party, so prefer the PNG."
      },
      {
        "text": "Leave Flip Y Axis off. The option exists (confirmed); what it does to a single file is unconfirmed."
      },
      {
        "text": "If Unreal asks whether to use the tiled image path, answer No. Unreal asks this when it considers the heightmap tiled (confirmed); an Orogen build is one file."
      },
      {
        "text": "Compare the layout the panel shows with `landscape.layout` in the manifest and correct the panel if it differs: Section Size = `quadsPerSection`, Sections Per Component = 1x1 or 2x2 for `sectionsPerComponent` 1 or 2, Number of Components = `components`, Overall Resolution = `resolution`. As an example, a build at 8129 has 127x127 quads, 32 x 32 components and 8129 x 8129; your build has the values of its own manifest. These values are confirmed for the four sizes Orogen offers; that the panel fills them in by itself is unconfirmed."
      },
      {
        "text": "Scale: type `landscape.transform.scaleCm` x, y and z (derived)."
      },
      {
        "text": "Location: type `landscape.transform.uiLocationCm`. The panel's Location is the centre of the landscape in X and Y (confirmed, seen on 5.8.3: check 1 of the acceptance test, and a build at 4033); step 13 shows the result. Leave Rotation at 0."
      },
      {
        "text": "Material: choose your landscape material."
      },
      {
        "text": "Layers. For each entry of `landscape.layers`, in the row of the target layer with the same name:",
        "bullets": [
          "create its layer info with the \"+\" button: Weight-Blended Layer when `blend` is `advanced` or `final`, Non Weight-Blended Layer when it is `none` (confirmed: every layer needs its own layer info asset, and these are the two choices);",
          "open the layer info and set Weight Blending Method to Advanced Weight Blending for `advanced`, Final Weight Blending (Legacy) for `final`, No Weight Blending for `none` (the three methods are confirmed);",
          "choose the layer's `png` file. Each layer's file is chosen by hand; nothing found in Epic's pages assigns files by name (unconfirmed, an absence)."
        ],
        "more": [
          "Set Layer Alphamap Type to Additive (confirmed: Additive means the blended layers' maps total 1, which is how Orogen writes them). A layer file must have exactly the landscape's resolution or Unreal refuses it (confirmed); Orogen's always have.",
          "In a World Partition level, give the layers here, while the landscape is created. Importing them later onto the landscape, from the Paint tab, counts only the part of the landscape that is loaded: a French editor answered a layer file of 4033 × 4033 with \"La taille de l'importation (4033x4033) ne correspond pas à l'étendue actuelle du paysage (2x2), si vous continuez, elle sera complétée/coupée pour s'adapter\", in English \"the import size (4033x4033) does not match the landscape's current extent (2x2); if you continue, it will be padded or cropped to fit\" (seen on 5.8.3; the English editor's own words were not seen). Do not continue: the layer would be padded or cropped to the loaded part (derived). Dragging a selection in the World Partition window, to load the whole landscape first, highlighted no region there (seen on 5.8.3), so whether a loaded landscape takes such an import whole is unconfirmed. Layers given on this panel imported whole on 5.8, five of them at 4033, in a level that kept the landscape in one piece; that they do the same in a World Partition level is unconfirmed."
        ]
      },
      {
        "text": "World Partition levels only: set World Partition Grid Size and World Partition Region Size to `landscape.worldPartition.gridSize` and `regionSize`, here: a landscape whose level is converted to World Partition afterwards keeps the grid size the conversion gives it (section 4, item 1). Both options exist with ranges 1 to 16 and 4 to 64 (confirmed). Grid Size is the number of components per streaming proxy along one side, as the API reference says; Epic's import page describes it the other way round (confirmed, seen on 5.8.3: Grid Size 4 split a landscape of 32 x 32 components into 8 x 8 streaming proxies). The panel's own default values are unconfirmed."
      },
      {
        "text": "Click Import."
      },
      {
        "text": "Select the Landscape actor. Its Transform must show Location = `landscape.transform.actorLocationCm` and Scale = `scaleCm` (confirmed, seen on 5.8.3). If the Location shows `uiLocationCm` instead, the panel did not centre the landscape: type `actorLocationCm` into the actor's Location (derived)."
      },
      {
        "text": "Look at the terrain. Seen from above with +X pointing to the right of the screen, +Y points down the screen and the terrain looks like `<Name>Height.png` as an image viewer shows it (confirmed, seen on 5.8.3: checks 3 to 5 of the acceptance test). Unreal's Top viewport shows it turned a quarter turn; that is how the viewport is drawn, not an error. On 5.8 the Top viewport's axis indicator showed +X down the screen and +Y to the left, which turns the terrain a quarter turn clockwise against the image (seen on 5.8.3, in one editor; that every Top viewport is drawn so is unconfirmed). If the terrain is mirrored, or turned in a way the axis indicator does not explain, stop and run the acceptance test."
      },
      {
        "text": "Nanite, if you want it: on the Landscape actor's Details panel, Nanite, tick Enable Nanite and press Build Data, or use Build, Build Landscape (confirmed). Nanite and non-Nanite data are both kept, and about twice the data is streamed (confirmed)."
      },
      {
        "text": "Textures: import the `T_*.png` files as ordinary textures. Switch sRGB off for every texture whose manifest entry says `\"srgb\": false`: a mask, a normal texture, and a Color Texture whose Content is Data. Sample them in the landscape material with `U = (WorldX − actorLocationCm.x) / extent`, `V = (WorldY − actorLocationCm.y) / extent`, where `extent` is `terrain.sizeM × 100` (derived; confirmed, seen on 5.8.3: check 12 of the acceptance test). Unreal shades a landscape from the heightmap without any normal map (confirmed); `T_Normal` is an optional macro normal, and whether its green channel needs flipping is unconfirmed."
      },
      {
        "text": "Save the level and the layer info assets."
      }
    ],
    "after": [
      "Sculpt in a new edit layer above the imported one, not in the imported one. All landscapes have edit layers in 5.8, and the base layer is named \"Layer\" (confirmed)."
    ]
  },
  {
    "number": 3,
    "title": "Importing a rebuilt terrain",
    "before": [
      "There is no tested procedure for replacing the heights of a landscape that already exists. Two facts bear on it:"
    ],
    "list": "bullets",
    "items": [
      {
        "text": "With Height range set to Measured, the scale and location in the manifest change with every build. Replacing only the heightmap of an existing landscape would then be wrong, and changing the actor's scale rescales everything sculpted on it. Set Height range to Fixed before the first import if you intend to re-import (derived)."
      },
      {
        "text": "The editor can import into an existing landscape (confirmed); the steps are unconfirmed. In a World Partition level such an import counts only the part of the landscape that is loaded (seen on 5.8.3: section 2, step 10)."
      }
    ],
    "after": []
  },
  {
    "number": 4,
    "title": "Known risks and workarounds",
    "before": [],
    "list": "ordered",
    "items": [
      {
        "text": "**Repeated tiles after importing 8129 × 8129 into a World Partition level.** One user reports that importing a single 8129 × 8129 16-bit PNG into a World Partition level shows one part of the heightmap repeated 4 × 4 or 16 × 16 times, with a correct wireframe and wrong shading, on 5.7.0, 5.7.4 and 5.8.0; it worked on 5.5.4 and 5.6.1. Epic has not replied and there is no ticket (forum report of 2026-08-24; confirmed as a report, not reproduced by Orogen). This is exactly an Orogen build at its largest size. It did not happen in the run of section 6.5: the acceptance pattern at 8129, one 16-bit PNG imported directly into a World Partition level with Grid Size 4 and Region Size 32, showed one tower, one pit and one unbroken ramp (seen on 5.8.3). The report is about 5.7.0 to 5.8.0 and the run was on 5.8.3, so the fault looks fixed in 5.8.3 for this import; that rests on one run on one machine. The reporter's workaround: import into a level without World Partition, then convert the level to World Partition. It costs the grid size: on 5.8 the World Partition grid size of the landscape could not be changed after the conversion, so the landscape keeps the grid size the conversion gives it, not the manifest's `gridSize` (seen on 5.8.3). Check with the acceptance test at 8129, on your engine version, before you rely on a World Partition import."
      },
      {
        "text": "**Wrong output of the Landscape Layer Blend material node.** The node gave washed-out or wrong specular, and in some cases a grey Nanite landscape, on 5.8.0 to 5.8.2 (first report 2026-06-26, Epic ticket UE-386355). The ticket was closed as fixed; a user reported on 2026-08-26 that 5.8.2 did not fix it; Epic staff said on 2026-08-27 it would be reopened and on 2026-09-07 that it would be addressed in 5.8.3. The 5.8.3 notes do not mention it, so whether 5.8.3 fixes it is unconfirmed. Two workarounds reported by users on early 5.8, both unconfirmed: feed single attributes such as Specular through the blend node instead of Material Attributes; or use Final Weight Blending (Legacy) instead of Advanced Weight Blending. For the second, set Layer blend method to Final on Orogen's Unreal Landscape node and build again: the manifest then says `\"blend\": \"final\"`."
      },
      {
        "text": "**Heightmap file names.** Users have met the import error `doesn't have proper pattern(ex: _x0_y0.png)` on ordinary single files and reported that it went away after removing digits from the file name, avoiding spaces and special characters, removing similarly named PNG files from the same folder, deleting temporary copies left by an image editor, or deleting the stale asset and importing again (forum threads about UE 5.0, posts from 2022 to 2024). The cause is unconfirmed, and none of it has been reproduced on 5.8. Orogen's file names and its rule of one folder per build are a precaution against it."
      },
      {
        "text": "**Too many layers on a component.** A report for 5.8 says that merging edit layers makes each component inherit its left and top neighbours' layers, so that with about ten or more layers a component exceeds Direct3D 12's limit of 64 shader resources and silently falls back to the default material (forum report of 2026-08-12, no reply from Epic; unconfirmed). Keep the number of layers low: aim for at most 8, and Orogen warns above 12."
      },
      {
        "text": "**World Partition Region Size 4.** On 5.5.4, creating a landscape with Region Size 4 fails an assertion; 5 and 8 work (forum report of 2026-07-31; the state on 5.8 is unknown). Orogen warns when the value is 4."
      },
      {
        "text": "**Stale image size.** The editor caches an image file's resolution; after a build at another resolution it can keep the old size until another file is selected (third party, observed on 5.5.3). Select a different file and then the right one again."
      },
      {
        "text": "**Slow imports.** QuadSpinner reports slow landscape imports since 5.5, most of all with World Partition, and attributes them to the engine (third party)."
      }
    ],
    "after": []
  }
];
