# OrogenBridge: an experimental Unreal Engine editor plugin

**This source has never been compiled, loaded or run.** It was written on a machine without Unreal Engine, and
the project's hosted CI has no Unreal Engine either, so neither can build it. No binary is shipped. Treat it as a
careful first draft: expect to fix compile errors before it builds, and expect its behaviour to differ from this
description until somebody has run it.

**The supported way to bring an Orogen build into Unreal is by hand**, with the steps of
[`docs/user/unreal-import.md`](../../docs/user/unreal-import.md). This plugin is an option for people who can
compile and debug an editor plugin.

| | |
| --- | --- |
| Written against | Unreal Engine **5.8**: Epic's C++ API reference pages labelled 5.8, read on 2026-10-12, with hotfix 5.8.3 in mind. The engine's source was not available |
| Also follows | the source of QuadSpinner's open-source Gaea2Unreal plugin, as read on the same day. Its announcement names Unreal 5.3 to 5.5, and nothing readable says that it builds on 5.8 |
| Compiled against | no engine. The three `.cpp` files were only parsed by a C++ compiler against stand-in declarations that restate what their author assumed of the engine. That shows the code is consistent with those assumptions, and nothing about Unreal Engine |
| Run on | nothing |
| Other engine versions | refused: `OrogenLandscapeCompat.cpp` stops the compiler on any engine other than 5.8 |

## What it does

One function, `UOrogenImportLibrary::ImportTerrain`, reads the manifest of an Orogen build
(`<Name>.orogen.json`) and creates one new Landscape in the level that is open in the editor:

- the heights, from the build's `.r16` file;
- one target layer and one layer info asset for every layer of the manifest, from the `.r8` files;
- the actor's location and scale, exactly as the manifest states them;
- the landscape material you name;
- the World Partition grid size of the manifest, when the level uses World Partition.

It reads `.r16` and `.r8` directly. It does not read the PNG files, and it never lets the engine pad, crop or
resample: a manifest whose layout does not give its resolution is refused.

It does **not** do any of this: re-import into a landscape that exists, tiled or region-by-region import,
Nanite, the build's textures, water bodies or splines, runtime virtual textures. It has no user interface and
no runtime module. The manifest's `worldPartition.regionSize` is not used.

## Installing and compiling

1. Copy the folder `unreal/OrogenBridge` of the Orogen repository to `<YourProject>/Plugins/OrogenBridge`.
2. The project must be a C++ project, and the machine needs the tools Epic requires for building C++ projects
   with 5.8. The research for Orogen names Visual Studio 2022 with the C++ game development workload; that was
   not checked against Epic's requirements for 5.8 (unconfirmed). Follow Epic's own set-up page for your engine
   version.
3. Generate the project files and build the project's editor target. The plugin's module is of type `Editor`.
4. Enable the plugin in the editor's Plugins window if it is not enabled; it is listed as experimental.

### What to expect on the first compile

Compile errors are likely. They should all be of these kinds:

| Where | What may be wrong | Why it could not be checked |
| --- | --- | --- |
| `OrogenLandscapeCompat.cpp`, the `#include` lines | A landscape type is declared in another header than the one included. Only `LandscapeProxy.h`, `LandscapeLayerInfoObject.h` and `LandscapeSubsystem.h` were read on the API reference | the reference was read for a handful of classes; the source is private |
| `OrogenLandscapeCompat.cpp`, calls marked `[E]` | Nothing, if the API reference is right: these declarations were read on the 5.8 pages (`Import`, `AddTargetLayer`, `GetLandscapeInfo`, `UpdateLayerInfoMap`, `SetLayerName`, `SetBlendMethod`, `IsGridBased`, `ChangeGridSize`, `GetEditLayer`, `GetLandscapeExtent`, the two layer structs and the two enums). The reference shows no default arguments, so every argument is written out | |
| `OrogenLandscapeCompat.cpp`, calls marked `[U]` | The member is no longer public (`LandscapeMaterial`, `StaticLightingLOD`), or the function has other parameters (`IAssetTools::CreateAsset`, `FindObject`, `FPackageName::DoesPackageExist`, `LoadObject`, `SpawnActor`, `RegisterAllComponents`, `EditorDestroyActor`, `FActorLabelUtilities::SetActorLabelUnique`) | they follow Gaea2Unreal or the research's sketch, or are long-standing engine calls; none was read on a 5.8 page |
| the linker | An unresolved symbol for a landscape function. `ULandscapeSubsystem` is declared `MinimalAPI`, so only the functions Epic exports one by one can be called from a plugin | the reference does not show which functions are exported |
| `OrogenManifest.cpp`, `OrogenImportLibrary.cpp` | A `Json` or `Core` call has another signature | written from long-standing engine API, not re-read for 5.8 |
| `OrogenBridge.uplugin`, `OrogenBridge.Build.cs`, the `UCLASS` header | A descriptor key, a build setting or a reflection macro is not accepted | written in the long-standing plugin layout, not checked for 5.8 |

Every `[U]` call in the source carries a comment that begins `OPEN QUESTION`. Fix what the compiler reports in
`OrogenLandscapeCompat.cpp` and keep the other files free of landscape headers: that file is the one place that
changes from one engine version to the next.

## Calling it

```cpp
static ALandscape* ImportTerrain(const FString& ManifestPath, const FString& MaterialPath,
                                 const FString& LayerInfoFolder, FString& OutError);
```

| Argument | Meaning |
| --- | --- |
| `ManifestPath` | The file `<Name>.orogen.json` of a build. The data files are looked for beside it |
| `MaterialPath` | Object path of the landscape material, for example `/Game/Materials/M_Landscape`, or empty for none |
| `LayerInfoFolder` | Content folder for the layer info assets, for example `/Game/Orogen/LayerInfos`. Needed when the build has layers |
| `OutError` | One sentence when the function returns no landscape |

The function is `BlueprintCallable`, so an Editor Utility Widget and Python should be able to call it
(unconfirmed). A Python driver, with Epic's documented command line (confirmed for 5.8):

```
UnrealEditor-Cmd.exe "<project>.uproject" -ExecutePythonScript="<script>.py"
```

```python
import unreal
unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level("/Game/Maps/World")
landscape, error = unreal.OrogenImportLibrary.import_terrain(
    r"D:/Build/Alps/Alps.orogen.json", "/Game/Materials/M_Landscape", "/Game/Orogen/LayerInfos")
if not landscape:
    raise RuntimeError(error)
unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)
```

That the output parameter arrives as the second element of a tuple, and that this script runs unattended to its
end, is unconfirmed. Whether a landscape import completes in commandlet mode (`-run=pythonscript`) is
unconfirmed; use the full-editor form above.

What a call leaves behind:

- **On success:** one Landscape actor labelled `Orogen_<Name>`, unsaved, and one layer info asset
  `<Layer>_LayerInfo` per layer in `LayerInfoFolder`, unsaved. Save the level and the assets yourself.
- **A layer info asset that already exists** under that name is reused, and its layer name and blend method are
  set from the manifest. Another kind of asset under that name stops the import.
- **On failure:** no actor. Everything that can be checked is checked before the actor is spawned: the
  manifest, the sizes of the data files, the material, the layer infos. Layer info assets created before a
  later failure stay in the editor as unsaved assets.
- The plugin opens no transaction. Whether the import can be undone with the editor's Undo is not known.

## What it does, call by call

The marks are those of the source: `[E]` the declaration was read on the 5.8 API reference (the signature
only, never the behaviour); `[U]` unverified for 5.8.

| Step | File | Calls |
| --- | --- | --- |
| 1. Read and check the manifest | `OrogenManifest.cpp` | `Json` only. Refuses another schema than `orogen.unreal.landscape/1`, a status other than `complete`, a build without a landscape, a layout that does not give the resolution, an `.r16` that is not `SizeX · SizeY · 2` bytes and an `.r8` that is not `SizeX · SizeY` bytes |
| 2. Heights | `OrogenImportLibrary.cpp` | `FFileHelper::LoadFileToArray` `[U]`, then a copy into `TArray<uint16>`; index `X + Y · SizeX` |
| 3. Layers | `OrogenLandscapeCompat.cpp` | `FLandscapeImportLayerInfo(FName)` `[E]`; a `ULandscapeLayerInfoObject` asset through `IAssetTools::CreateAsset` `[U]`; `SetLayerName(Name, true)` and `SetBlendMethod(Method, true)` `[E]` with `None`, `FinalWeightBlending` or `PremultipliedAlphaBlending` for the manifest's `none`, `final`, `advanced` |
| 4. Actor | | `World->SpawnActor<ALandscape>` at `actorLocationCm`, `LandscapeMaterial`, `SetActorRelativeScale3D(scaleCm)`, `StaticLightingLOD`, all as Gaea2Unreal does it `[U]` |
| 5. Import | | `ALandscapeProxy::Import` with twelve arguments `[E]`, the heights and the layers each under a default `FGuid()`, `ELandscapeImportAlphamapType::Additive`, no import layers |
| 6. Target layers | | `GetLandscapeInfo()`, `UpdateLayerInfoMap(Landscape, false)` `[E]`; `RegisterAllComponents()` as Gaea2Unreal does `[U]`; `AddTargetLayer(Name, FLandscapeTargetLayerSettings(LayerInfo, SourceFile), true)` `[E]` |
| 7. World Partition | | When the manifest enables it and the world's `ULandscapeSubsystem` reports `IsGridBased()`: `ChangeGridSize(LandscapeInfo, gridSize)` `[E]` |
| 8. Label | | `FActorLabelUtilities::SetActorLabelUnique` `[U]` |

After step 6 the plugin writes a warning to the log, category `LogOrogenBridge`, when the landscape has no
edit layer or reports another extent than the one imported. Neither stops the import: the two checks are as
unverified as the import itself.

## Questions only a run answers

1. Does `Import` with no import layers create the default edit layer by itself? Look for the warning above.
2. Does the repeated-tile fault that users report for 8129 × 8129 imports into World Partition levels (item 1
   of the known risks in the import guide) appear through this path?
3. Is the sequence of calls complete? It follows Gaea2Unreal, and nothing readable says that plugin's calls
   work unchanged on 5.8.
4. Are orientation, location and height right? These rest on the same unverified assumptions as the import by
   hand.

Answer them with the acceptance test, which needs no project and no GPU:

```
node src/cli/main.ts unreal-test --out D:\Build\Marker
```

Import `D:\Build\Marker\Marker.orogen.json` with the plugin and go through the table of expected results in
[`docs/user/unreal-import.md`](../../docs/user/unreal-import.md#6-the-acceptance-test). Then export the
landscape's heightmap from Unreal and compare it:

```
node src/cli/main.ts unreal-test --check D:\Build\Exported.png
```

## The source

| File | Contains | Engine modules it includes |
| --- | --- | --- |
| `OrogenBridge.uplugin` | the plugin descriptor: one module of type `Editor` | |
| `Source/OrogenBridge/OrogenBridge.Build.cs` | the build rules: `Core`, `CoreUObject`, `Engine`, `Landscape`, `UnrealEd`, `AssetTools`, `AssetRegistry`, `Json`, `JsonUtilities` | |
| `Source/OrogenBridge/Public/OrogenImportLibrary.h` | the one exposed function | `Core`, `Engine` |
| `Source/OrogenBridge/Private/OrogenImportLibrary.cpp` | `ImportTerrain`: steps 1 and 2, then the hand-over; the module's declaration | `Core`, `Engine`, `UnrealEd` for the editor's world |
| `Source/OrogenBridge/Private/OrogenManifest.h`, `.cpp` | `FOrogenManifest`, a plain struct of what the plugin reads of a manifest; parsing and step 1 | `Core`, `Json` |
| `Source/OrogenBridge/Private/OrogenLandscapeCompat.h` | `FOrogenLandscapeDesc` and `OrogenCreateLandscape`. No landscape type but the forward-declared `ALandscape` | `Core` |
| `Source/OrogenBridge/Private/OrogenLandscapeCompat.cpp` | steps 3 to 8; every landscape and asset-tools call; the engine-version guard | all |
| `Fixtures/example.orogen.json` | the example manifest of the export contract. Orogen's own tests check that it validates against the manifest's schema and equals the contract's example, so the plugin's reader and Orogen's writer cannot drift apart unnoticed | |

The plugin is specified in `docs/contract/export-unreal.md`, section 8, and the research behind it, with the
log of what was verified and what was not, is `docs/research/unreal-landscape.md`.
