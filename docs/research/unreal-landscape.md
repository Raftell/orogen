# Importing Orogen terrain into Unreal Engine 5.8 Landscape — implementation-grade reference

Research date: 2026-10-12. Author: research subagent for the Orogen project.

## 0. Version status and how to read this report

- **UE 5.8 is released.** Full release on 2026-06-17 ([80.lv](https://80.lv/articles/unreal-engine-5-8-is-out-today-with-big-optimization-improvements-and-mesh-terrain)); hotfixes 5.8.1 (2026-07-28, [forum](https://forums.unrealengine.com/t/5-8-1-hotfix-released/2738864)), 5.8.2 (2026-08-25, [forum](https://forums.unrealengine.com/t/5-8-2-hotfix-released/2746335)) and 5.8.3 (2026-09-22, [forum](https://forums.unrealengine.com/t/5-8-3-hotfix-released/2833315)). 5.8.3 is the newest hotfix I found. (Release date also confirmed by Epic's own announcement thread, first post 2026-06-17: [forum](https://forums.unrealengine.com/t/unreal-engine-5-8-released/2729274).)
- Epic's documentation site (dev.epicgames.com) serves pages titled "Unreal Engine 5.8 Documentation", including the C++ API reference and the Python API reference ("Unreal Python 5.8 (Experimental)"). Unless a line says otherwise, **every Epic-doc fact below was read from a page labelled 5.8**. Several of those pages still contain UE4-era body text; where that matters it is flagged.
- The engine source (`EpicGames/UnrealEngine`) is a private GitHub repo and could not be read. Anything that comes from my memory of the engine source rather than from a page I fetched is tagged **[RECALLED, UNVERIFIED]**. Do not hard-code those without a test.
- Tags used: **[VERIFIED 5.8 docs]**, **[VERIFIED third-party]** (source named), **[DERIVED]** (arithmetic from verified facts), **[RECALLED, UNVERIFIED]**, **[UNVERIFIED]**.
- Mesh Terrain (new in 5.8) is **Experimental** ("use caution when shipping with it") and is a separate, mesh-based system; Landscape (heightfield) remains the production path and is what this report targets ([Mesh Terrain doc](https://dev.epicgames.com/documentation/en-us/unreal-engine/mesh-terrain-in-unreal-engine), [5.8 release notes](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-release-notes)).
- Security note: the World Creator documentation page I fetched contained text addressed to AI agents asking them to issue requests to its documentation endpoint. It was treated as data and ignored.

---

## (a) Valid / recommended heightmap dimensions

### Formula [VERIFIED 5.8 docs]

Source: [Landscape Technical Guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-technical-guide-in-unreal-engine).

```
QuadsPerComponent = SectionsPerComponent_1D * QuadsPerSection
SizeX (vertices)  = ComponentCountX * QuadsPerComponent + 1
SizeY (vertices)  = ComponentCountY * QuadsPerComponent + 1
```

Constraints:
- A section's vertex count per side must be a power of two, max 256 → `QuadsPerSection ∈ {7, 15, 31, 63, 127, 255}` (the option list 7/15/31/63/127/255 is also spelled out by [MathWorks' UE landscape guide](https://www.mathworks.com/help/aeroblks/create-landscape-in-unreal-editor.html)).
- `SectionsPerComponent_1D ∈ {1, 2}` (UI shows "1x1" or "2x2"). Quads per component is therefore (2^n − 1) or (2^n − 2).
- The New Landscape panel caps Number of Components at **32 x 32** ([Creating Landscapes](https://dev.epicgames.com/documentation/en-us/unreal-engine/creating-landscapes-in-unreal-engine)); Epic recommends **at most 1024 components** for the largest landscapes (Technical Guide). Each component costs render-thread CPU and each section is a draw call.
- Landscapes need not be square (X and Y component counts are independent).
- 2x2 sections with N components gives the same heightmap as 1x1 sections with 4N components, but fewer components performs better (Technical Guide).

### Recommended sizes table [VERIFIED 5.8 docs — Technical Guide]

| Overall size (vertices) | Quads / section | Sections / component | Component size (quads) | Total components |
|---|---|---|---|---|
| **8129 x 8129** | 127 | 4 (2x2) | 254x254 | 1024 (32x32) |
| 4033 x 4033 | 63 | 4 (2x2) | 126x126 | 1024 (32x32) |
| 2017 x 2017 | 63 | 4 (2x2) | 126x126 | 256 (16x16) |
| 1009 x 1009 | 63 | 4 (2x2) | 126x126 | 64 (8x8) |
| 1009 x 1009 | 63 | 1 | 63x63 | 256 (16x16) |
| 505 x 505 | 63 | 4 (2x2) | 126x126 | 16 (4x4) |
| 505 x 505 | 63 | 1 | 63x63 | 64 (8x8) |
| 253 x 253 | 63 | 4 (2x2) | 126x126 | 4 (2x2) |
| 253 x 253 | 63 | 1 | 63x63 | 16 (4x4) |
| 127 x 127 | 63 | 4 (2x2) | 126x126 | 1 |
| 127 x 127 | 63 | 1 | 63x63 | 4 (2x2) |

### Largest size per section setting at the 32x32 UI cap [DERIVED]

| QuadsPerSection | 1x1 sections | 2x2 sections |
|---|---|---|
| 63 | 2017 | 4033 |
| 127 | 4065 | **8129** |
| 255 | 8161 | 16321 |

Other useful valid sizes with 255-quad sections: 2041 (8 comps, 1x1), 4081 (16 comps, 1x1 or 8 comps 2x2), 8161, 16321.

### Layout chooser for Orogen (pseudo-code) [DERIVED]

```ts
// Returns layouts whose vertex count equals n exactly; pick the first.
function landscapeLayouts(n: number) {
  const out = [];
  for (const q of [255, 127, 63, 31, 15, 7])        // quads per section
    for (const s of [2, 1])                          // sections per component (1D)
      if ((n - 1) % (q * s) === 0) {
        const c = (n - 1) / (q * s);                 // components per side
        out.push({ quadsPerSection: q, sectionsPerComponent: s, components: c, total: c * c });
      }
  // prefer: total <= 1024, then fewest components, then q == 63 or 127 (Epic's table)
  return out.filter(l => l.components <= 32).sort((a, b) => a.total - b.total);
}
// landscapeLayouts(8129) -> [{127, 2, 32, 1024}]   (the 127/1x1/64x64 = 4096-component layout is rejected)
```

If the user's size is not valid, the importer will pad/crop/resample (`ELandscapeImportTransformType`: Original, Expand, Resample, Subregion — [API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/LandscapeEditor/ELandscapeImportTransformType)). Orogen should **only export valid sizes** and refuse or resample in-app otherwise.

---

## (b) Formats, bit depths, and the height mapping

### Heightmap file formats [VERIFIED 5.8 docs]

Sources: [Importing and Exporting Landscape Heightmaps](https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-and-exporting-landscape-heightmaps-in-unreal-engine), [Technical Guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-technical-guide-in-unreal-engine), [Custom heightmaps and layers](https://dev.epicgames.com/documentation/en-us/unreal-engine/creating-and-using-custom-heightmaps-and-layers-in-unreal-engine).

- Import: **16-bit grayscale PNG**, **16-bit grayscale `.r16`**, "8-bit grayscale r8" (listed by the docs alongside heightmaps; in practice the 8-bit raw is the weightmap format). These are "preferred because the bit depth is known and they are assumed to be square".
- `.raw` is also accepted **with a JSON sidecar of the same base name in the same folder**. The 5.8 Technical Guide prints the example as `{"width": 1024, "height": 1024, "bbp": 8}` — note the key is literally spelled `bbp` on the page; whether the engine key is `bbp` or `bpp` is **[UNVERIFIED]**. Avoid `.raw`+JSON; use `.r16` or PNG.
- Export from UE: 16-bit grayscale PNG or `.r16`.
- Native height data: single channel, 16 bits per pixel. `ILandscapeHeightmapFileFormat::Export` takes `TArrayView<const uint16>`; weightmaps `TArrayView<const uint8>` ([Custom importers](https://dev.epicgames.com/documentation/en-us/unreal-engine/creating-custom-landscape-importers-in-unreal-engine)).
- **Endianness of `.r16`/`.raw`: little-endian.** The 5.8 pages I read do not state it; [MathWorks](https://www.mathworks.com/help/aeroblks/create-landscape-in-unreal-editor.html) states "16-bit, grayscale RAW file in little-endian byte order", and a forum poster cites Epic's 5.1 docs as listing "16-bit grayscale little-endian RAW" ([forum, Nov 2023](https://forums.unrealengine.com/t/ue5-does-not-let-me-import-a-heightmap-please-help/604839)) **[VERIFIED third-party]**; consistent with my recollection that the RAW importer memcpy's the file into a `uint16` array on a little-endian host **[RECALLED]**. No header, row-major, first row first.
- PNG 16-bit samples are big-endian *inside the PNG stream* by the PNG specification; any conforming PNG encoder handles this. Write colour type 0 (grayscale), bit depth 16, no alpha, no gamma/sRGB chunks.
- No 32-bit float heightmap import exists in the stock importer (formats above are the complete documented list).

### Weightmap (target layer) file formats [VERIFIED 5.8 docs]

- PNG or RAW; "single-channel, grayscale, 8 bits per pixel". RGB works but colour is discarded and precision may drop ([Custom heightmaps and layers](https://dev.epicgames.com/documentation/en-us/unreal-engine/creating-and-using-custom-heightmaps-and-layers-in-unreal-engine)).
- Layer file resolution must equal the landscape's Overall Resolution exactly; otherwise the editor shows a warning with the required size and refuses (same page; ignore that page's odd 512→505/1024→1072 table, it is legacy text).
- Weights are 0–255 ([Landscape Paint Mode](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-paint-mode-in-unreal-engine)).

### How a 16-bit value becomes world height

Verified statements:
- "Unreal Engine calculates your heightmap's height by using values between **-256 and 255.992**, stored with 16-bit precision", then multiplied by the Z scale; Z scale 1 → about ±256 cm, default Z scale 100 → about ±256 m ([Technical Guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-technical-guide-in-unreal-engine)) **[VERIFIED 5.8 docs]**.
- Landscape Patch "Native Packed Height" encoding: values are stored as 16-bit integers packed into two bytes, mapping to **[-256, 256 − 1/128]** before applying landscape scale ([Landscape Patch System](https://dev.epicgames.com/documentation/unreal-engine/landscape-patch-system)) **[VERIFIED 5.8 docs]**. This pins the step at 1/128 and the zero at 32768. *(Fact-check correction: an earlier draft also quoted this page as saying it is "the same convention as values in landscape actors". That phrase is not on the 5.8 page; it is my recollection of the engine header comment and is **[RECALLED, UNVERIFIED]**. The equivalence to the landscape's own encoding rests on the numeric match with the Technical Guide's −256 … 255.992 statement, not on a quoted sentence.)*
- Empirical confirmation: at Z scale 100, +128 raw units = +1 m ([forum](https://forums.unrealengine.com/t/possible-wrong-document-about-landscapes-heightmap-z-scale/770270)) **[VERIFIED third-party]**.
- Engine constants `LANDSCAPE_ZSCALE = 1/128`, `LandscapeDataAccess::MidValue = 32768`, `MaxValue = 65535`, `GetLocalHeight(h) = (h − 32768) / 128` **[values RECALLED, UNVERIFIED by fetch; fully consistent with the three verified statements above]**. The *names* are verified: the 5.8 API index for the Landscape module lists `LandscapeDataAccess::MaxValue` (`int32`), `MidValue` (`float`), `MidNormalValue` (`float`), `float GetLocalHeight(uint16 Height)` and `uint16 GetTexHeight(float Height)` in `LandscapeDataAccess.h`, without printing values or bodies ([API index](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Landscape)). The `LANDSCAPE_ZSCALE` macro has no API page and could not be found in any public source.

Exact mapping (v = stored uint16, units cm):

```
local_z(v)  = (v - 32768) / 128                      // actor-local units, before scale
world_z(v)  = ActorLocation.Z + (v - 32768) / 128 * ActorScale.Z
```

| Quantity | Value |
|---|---|
| Mid value (local Z = 0) | 32768 |
| v = 0 | −256.0 × ScaleZ cm |
| v = 65535 | +255.9921875 × ScaleZ cm |
| Total range | 511.9921875 × ScaleZ cm (= 65535/128 × ScaleZ) |
| cm per unit at ScaleZ = 100 | 0.78125 cm (100/128) |
| Range at ScaleZ = 100 | −25600 cm … +25599.21875 cm (≈ 511.99 m total) |
| Vertical step in general | ScaleZ / 128 cm |

### Scale formulas (ready to use)

Let the heightfield be N_x × N_y samples (samples are **vertices**, pixel-is-point), real extent `Ex`, `Ey` in metres measured first-vertex to last-vertex, and Orogen map heights `[h_min, h_max]` metres linearly onto `[0, 65535]`:

```
v           = round( (h - h_min) / (h_max - h_min) * 65535 )        // + dither, see below

ScaleX      = Ex * 100 / (N_x - 1)                                   // cm per quad
ScaleY      = Ey * 100 / (N_y - 1)

Range_cm    = (h_max - h_min) * 100
ScaleZ      = Range_cm * 128 / 65535          // exact
            ≈ Range_cm / 512                  // Epic's documented formula (0.001953125), 1 LSB short at the top

ActorZ      = h_min * 100 + 256 * ScaleZ      // so that v = 0 lands exactly on h_min (world cm)
ActorX,Y    = world position of pixel (0,0)   // the actor origin is the min-X/min-Y corner vertex
                                              // centred terrain: ActorX = -Ex*100/2, ActorY = -Ey*100/2

VerticalStep_cm = ScaleZ / 128 = Range_cm / 65535
```

Epic's documented formula is `ZScale = max_height_m × 100 × 0.001953125` (= range_cm / 512) ([heightmap import doc](https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-and-exporting-landscape-heightmaps-in-unreal-engine)); the worked Mauna Kea example in the Technical Guide gives 4207 m → Z scale 821.6796875 and a range of −210,350 … +210,350 cm, i.e. the heightmap's full range is centred on the actor's Z. Gaea2Unreal uses exactly this: `Scale.Z = Height*100/512`, `Location.Z = Height*100/2` ([GaeaSubsystem.cpp](https://github.com/QuadSpinner/Gaea2Unreal/blob/main/src/Source/GaeaUEToolsEditor/Private/GaeaSubsystem.cpp)). The `/512` form treats the range as 65536 steps; the `×128/65535` form is exact and costs nothing. Either is fine; **write the one you used into the sidecar**.

Design notes:
- Use the terrain's actual min/max (plus optional headroom) so the 65536 levels are not wasted. With `ScaleZ = Range_cm×128/65535` nothing can be sculpted above h_max or below h_min in-editor; offer a "sculpt headroom %" option that widens `[h_min, h_max]` before quantisation.
- **Dither when quantising float → uint16.** At 2400 m range one step is 3.66 cm; at ~98 cm vertex spacing that is a 2.1° minimum representable slope, so gentle slopes become terraces and landscape normals (which UE derives from the heightmap) show banding. Add triangular-PDF noise of ±1 LSB (or blue noise) before rounding.
- Maximum representable relief at any ScaleZ is 511.992 × ScaleZ cm; ScaleZ is unconstrained in the docs (Mauna Kea example uses 821.68).

---

## (c) World Partition landscapes

### What exists [VERIFIED 5.8 docs]

- A World Partition landscape is one `ALandscape` actor plus many `ALandscapeStreamingProxy` actors that are loaded/unloaded by the editor and at runtime ([Landscape Overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-overview)).
- Import options ([heightmap import doc](https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-and-exporting-landscape-heightmaps-in-unreal-engine)):
  - **World Partition Grid Size** — number of landscape components per streaming proxy, per axis. `ULandscapeEditorObject::WorldPartitionGridSize` (`uint32`), `ClampMin=1, ClampMax=16, UIMin=1, UIMax=16`, tooltip "Number of components per landscape streaming proxies per axis" ([API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/LandscapeEditor/ULandscapeEditorObject)). Beware: the 5.8 heightmap-import doc page words it the other way round ("number of Landscape Streaming Proxies per landscape component"); the API tooltip is the authoritative meaning and is what this report uses. Default value: 2 **[RECALLED, UNVERIFIED — the API page shows no defaults]** (Houdini Engine's own default is 4, [SideFX](https://www.sidefx.com/docs/houdini/unreal/worldpartition/worldpartition.html)).
  - **World Partition Region Size** — number of landscape components per landscape region, per axis. `WorldPartitionRegionSize` (`uint32`), `ClampMin=4, ClampMax=64, UIMin=4, UIMax=64`, tooltip "Number of components per Landscape World Partition Region per axis." (same API page). Default 16 **[RECALLED, UNVERIFIED]**.
  - **Flip Y Axis** — "flips the Y coordinate of the imported file; used to resolve issues where tiled heightmaps do not fit together".
  - For importing into an *existing* World Partition landscape: Import Type = **Subregion**, Mode = All (or loaded regions only), snap gizmo None/Texel/Component.
  - Export: "Export Single File" false → one file per grid tile (World Partition only).
- Regions are World Partition loading regions implemented with `ALocationVolume` ("Used for World Partition loading regions", [API](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/ALocationVolume)). When a new landscape is larger than the region size, the editor creates and fills it region by region (load → import → save → unload) **[RECALLED, UNVERIFIED]**. If `RegionSize ≥ ComponentCount`, the whole landscape is one region and the simple path (import everything, then `ChangeGridSize`) applies — this is what Gaea2Unreal does.
- C++ entry points [VERIFIED 5.8 API docs]: `ULandscapeSubsystem::ChangeGridSize(ULandscapeInfo*, uint32 NewGridSizeInComponents)`, `ULandscapeSubsystem::IsGridBased()`, `FLandscapeConfigHelper::ChangeGridSize / PartitionLandscape / FindOrAddLandscapeStreamingProxy` ([ULandscapeSubsystem](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ULandscapeSubsystem), [FLandscapeConfigHelper](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Landscape/FLandscapeConfigHelper)). The `LandscapeRegionUtils` namespace (`CreateRegionVolume`, `ForEachRegion_LoadProcessUnload`, …) exists in my recollection and its header is included by Gaea2Unreal, but I could not find an API page **[RECALLED, UNVERIFIED]**.

### Tiled import: naming, tile sizes

- Epic's 5.8 page only says: "If your heightmap is tiled, Unreal asks if you would like to use the tiled image path." It does **not** document the naming rule.
- Naming rule: `<Base>_x<X>_y<Y>.<ext>`, X and Y zero-based integers; you pick the `_x0_y0` file in the Heightmap File field. Evidence: the engine's own error text as quoted by users on UE 5.0.1, "File 'T_Mountain_01_hm' doesn't have proper pattern(ex: _x0_y0.png)" ([forum, May 2022](https://forums.unrealengine.com/t/trouble-importing-png-for-heightmap-file-ue5-0/558022)), `FLandscapeImportHelper::ExtractCoordinates(const FString& BaseFilename, FIntPoint& OutCoord, FString& OutBaseFilePattern)` and `FLandscapeImportFileDescriptor::Coord` in the 5.8 API ([FLandscapeImportHelper](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/LandscapeEditor/FLandscapeImportHelper)), and a working UE 5.5.3 pipeline using `tile_x{X}_y{Y}.png` ([unrealcode.net, Jan 2025](https://www.unrealcode.net/NaniteLandscapeMaterials5/)) **[VERIFIED third-party]**. The exact regex (case sensitivity, zero padding, negative indices) is **[UNVERIFIED]**. Weightmap tiles use the same pattern per layer **[RECALLED, UNVERIFIED]**.
- **Filename hygiene for single-file imports (manual route).** Users hit the "proper pattern" error on ordinary single-file names and reported, anecdotally, that it went away after removing digits from the filename (several posters, thread 2 and thread 1), avoiding spaces/special characters, removing similarly named sibling PNGs from the folder (one poster had `Terrain_1.png` next to `Terrain_1_try2.png` and believed the editor was trying to read them as tiles), deleting image-editor temp copies (`~test.png`), or deleting the stale asset and re-importing (thread 1) ([thread 1](https://forums.unrealengine.com/t/trouble-importing-png-for-heightmap-file-ue5-0/558022), [thread 2](https://forums.unrealengine.com/t/ue5-does-not-let-me-import-a-heightmap-please-help/604839); threads tagged UE 5.0, posts 2022–2024) **[user reports VERIFIED as described; the mechanism is UNVERIFIED]**. *(Fact-check correction: an earlier draft stated as fact that "the same tile detector misfires on ordinary names". That is one forum poster's own guess, not an established mechanism; the error text itself only says the name lacks the `_x0_y0` pattern, and another poster made the error disappear by adding the `_x0_y0` suffix (the import still failed for other reasons). None of this has been reproduced on 5.8.)* As a cheap precaution Orogen should still write each export into its own fresh folder and name landscape-importer inputs with **letters only plus the extension** (e.g. `OrogenHeight.png`, `OrogenHeight.r16`, `LayerRock.png`) — no digits, no resolution suffix, no spaces. (Files read by our own plugin are not subject to this.)
- **Tiles do not overlap in UE5.** Total resolution = tiles-per-side × tile-size; four 1009² tiles are read as 2018², not 2017² ([forum, Nov 2023](https://forums.unrealengine.com/t/can-ue-5-import-a-tiled-landscape-properly/1394652); unrealcode.net cuts non-overlapping blocks: 11 × 1901 = 20911) **[VERIFIED third-party]**. This differs from UE4 World Composition, where neighbouring tiles shared an edge row. Consequence: tile size must divide a valid landscape size — e.g. 8129 = 11 × 739 only, so **8129 has no sensible tiling; export a single file**.
- The editor caches image resolution (`FLandscapeImageFileCache`); re-exporting a file at a different size can leave a stale cache until another file is selected (unrealcode.net) **[VERIFIED third-party]**.
- Tile Y order: `_y0` = top rows of the full image with Flip Y Axis off **[UNVERIFIED — consistent with the unrealcode.net gdal script; confirm with the corner test in section (g)]**.

### Practical and hard limits

| Limit | Value | Source / status |
|---|---|---|
| Epic's "feasible" heightmap size | up to 8192x8192 | [Landscape Overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-overview) [VERIFIED 5.8 docs] |
| Largest *recommended* size | 8129x8129 (1024 components) | Technical Guide [VERIFIED 5.8 docs] |
| New Landscape UI component cap | 32x32 → max 16321² with 255-quad 2x2 sections | Creating Landscapes [VERIFIED] + [DERIVED] |
| Component counts beyond 32x32 via import in World Partition | 82x82 and 164x164 components (20911², 41821²) imported in UE 5.5.3 | unrealcode.net [VERIFIED third-party, 5.5.3 only] |
| Tiles required / not loadable thresholds | tiles needed when vertices×2 bytes > int32; not loadable above ≈46340² (int32 indexing in `FLandscapeTiledImage::ReadRegion`) | unrealcode.net analysis [VERIFIED third-party, 5.5.3]; the same article's "largest importable 43351²" figure is not self-consistent — treat as approximate |
| World Creator bridge guidance | 16k recommended max; 32k "should work", larger untested | [World Creator docs](https://docs.world-creator.com/reference/export/bridge-tools/unreal-bridge) |
| Landscape memory | about 4 bytes per vertex (16-bit height + normal in the same texture) | Landscape Overview [VERIFIED 5.8 docs] |
| Edit layers | default max 8 (Project Settings → Landscape → Max Number of Layers) | [Edit Layers](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-edit-layers-in-unreal-engine) [VERIFIED 5.8 docs] |

### Known World Partition import problems (current as of Oct 2026)

- **UE 5.7.0, 5.7.4, 5.8.0: importing a single 8129x8129 16-bit PNG into a World Partition level renders one portion of the heightmap repeated 4x4 / 16x16 (wireframe correct, shading wrong).** Worked in 5.5.4 and 5.6.1. Reporter's workaround: import in a non-World-Partition level, then convert to World Partition. No Epic reply, no ticket, fix status unknown ([forum, 2026-08-24](https://forums.unrealengine.com/t/landscape-heightmap-import-duplicates-single-tile-in-world-partition-ue-5-7/2745963)). **This is exactly our headline case; it must be reproduced on 5.8.3 before we promise World Partition import.**
- UE 5.5: tiled heightmap+weightmap imports that worked in 5.4 broke (Epic tracker UE-241268; the page returned 403 to me, details from a search summary) **[UNVERIFIED]**.
- UE 5.5.4: creating a landscape with Region Size 4 asserts in `LandscapeEditLayers.cpp`; 5 and 8 work ([forum, 2026-07-31](https://forums.unrealengine.com/t/ue-5-5-4-crashes-when-creating-landscape-with-world-partition-region-size-4-landscapeeditlayers-cpp-line-2121/2739797)). Avoid region size 4.
- QuadSpinner reports slow terrain imports from UE 5.5 onward, especially with World Partition, attributed to the engine ([blog, 2025-03-11](https://blog.quadspinner.com/gaea2unreal-now-open-source/)).

---

## (d) Layers / weightmaps

### Concepts [VERIFIED 5.8 docs]

Sources: [Landscape Paint Mode](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-paint-mode-in-unreal-engine), [Landscape Materials](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-materials-in-unreal-engine), [Python `LandscapeLayerInfoObject`](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/LandscapeLayerInfoObject?application_version=5.8), [`LandscapeTargetLayerBlendMethod`](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/LandscapeTargetLayerBlendMethod?application_version=5.8).

- A **target layer** is a named weight channel. Names come from the landscape material (Landscape Layer Blend / Layer Weight / Layer Sample nodes); names are case-insensitive and must be unique. A material layer name with no matching target layer gets weight 0.
- Each target layer needs its own **Landscape Layer Info** asset (`ULandscapeLayerInfoObject`): every layer must have a layer info object assigned, and no two target layers may share one (Paint Mode page). A layer is not paintable without one. *(Fact-check correction: the earlier wording "without layer infos a layered material renders black" was presented as a docs fact but is on neither the 5.8 Paint Mode page nor the Landscape Materials page. The only "black" statement on the Paint Mode page concerns orphaned layers — areas painted with a layer later removed from the material likely appear black, depending on the material. A freshly created landscape whose layered material has no painted/filled layers showing black is commonly observed behaviour, but here it is **[RECALLED, UNVERIFIED]**; the importer avoids the case anyway by always assigning layer infos and a full-coverage base layer.)* Recommended to keep layer infos in a shared folder (the "Default Layer Assets Path" is remembered across levels).
- Layer Info properties: Layer Name (read-only from Python), Phys Material, Hardness, Minimum Collision Relevance Weight, **Weight Blending Method** (`blend_method`), **Weight Blend Group** (`blend_group`, only for advanced blending), debug colour, spline falloff modulation.
- Blend methods in 5.8:
  | UI name | Python enum | Behaviour |
  |---|---|---|
  | No Weight Blending | `NONE` (0) | No edit-time normalisation; final weight is the sum of edit-layer contributions. Use for independent masks. |
  | Final Weight Blending (Legacy) | `FINAL_WEIGHT_BLENDING` (1) | Normalised once at the end of the edit-layer stack so the legacy weight-blended layers always total 255, except where all of them are zero, in which case the total stays zero. Works poorly with edit layers: painting on an upper edit layer does not override what is beneath (Paint Mode page; Python enum page). |
  | Advanced Weight Blending | `PREMULTIPLIED_ALPHA_BLENDING` (2) — mapping **confirmed**: the 5.8 `ULandscapeLayerInfoObject` API page describes `BlendGroup` as only editable when `BlendMethod` is `PremultipliedAlphaBlending` (Advanced Weight Blending) ([API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ULandscapeLayerInfoObject)); Gaea2Unreal sets exactly this value | Blended at each edit layer so that the group's sum does not exceed 255 (100 %) — an upper bound, **not** a forced total of 255; a layer painted on top can override the weights beneath. Weight Blend Group restricts the adjustment to layers of the same group; it is optional — layers with an empty group name form one ordinary group. *(Fact-check correction: earlier draft said "normalised … needs a Weight Blend Group".)* |
- Creation helpers in the UI: per-layer "+" → Weight-Blended Layer (normal) / Non Weight-Blended Layer; "Create Layers From Materials"; "Auto-Fill Target Layer Assets" (Unassigned Layers Only / All Layers, optional "Create new assets").
- Import alphamap type (`ELandscapeImportAlphamapType`, [API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ELandscapeImportAlphamapType)):
  - **Additive** — "Three layers blended 50/30/20 represented as 0.5, 0.3, and 0.2 … All alpha maps for blended layers total to 1.0. This is the style used by UE internally."
  - **Layered** — same blend represented as 0.5, 0.6, 1.0; each map specifies the remainder from previous layers.

### Sum-to-one expectations

- For weight-blended layers the engine constrains the per-texel total: legacy Final Weight Blending forces it to 255 (or leaves it at 0 where every layer is 0); Advanced Weight Blending only guarantees it does not exceed 255 (Paint Mode page, see table above). Either way, any renormalisation at merge time means what the user sees is not what Orogen exported. **Export Additive weights that already sum to exactly 255 per texel** across the weight-blended group (largest-remainder rounding after quantising to 8 bits), and import with Alphamap Type = Additive — data that already sums to 255 satisfies both methods without change.
- Texels where every weight-blended layer is 0 are legal but should be avoided: under-covered areas shade as nothing/black with most layered materials **[DERIVED]**. Separately, the Landscape Materials page documents black spots with **LB Height Blend** where all painted layers have a height input of 0 at once (blend factor 0 for every layer → invalid (0,0,0) normal) and advises making sure an area carries a layer with non-zero weight ([Landscape Materials](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-materials-in-unreal-engine)). *(Fact-check correction: the earlier draft attributed the black result to zero weights alone; the doc's stated cause is the height-blend factor.)* Guarantee one base layer fills the remainder. (Gaea2Unreal fills material layer 0 with 255 everywhere and uses its `W_*` maps for layers 1..N.)
- Non-weight-blended layers (`NONE`) are independent 0–255 masks — the right vehicle for Orogen analysis masks (flow, wetness, slope, erosion, deposition, snow) that PCG and grass should read.

### File naming for automatic assignment

- **The stock editor has no documented filename-based auto-assignment of layer files** — each layer's file is browsed individually in the import panel (tiled layers are picked up via the `_x0_y0` pattern once the first tile is chosen). I found nothing in the 5.8 docs describing auto-assignment by name **[absence, not proof]**.
- Gaea convention (plugin-side, not engine): heightmap `H_*.png`, weightmaps `W_*.png`, plus a `*definition*.json`; the plugin collects every PNG in the folder whose name contains `W_` and assigns them **by index** to material layers 1..N ([Gaea docs](https://eadocs.quadspinner.com/gaea-unreal-tools/importing-weightmaps) via search summary; [source](https://github.com/QuadSpinner/Gaea2Unreal/blob/main/src/Source/GaeaUEToolsEditor/Private/GaeaSubsystem.cpp)).
- World Creator convention: `heightmap_x_y.raw` (raw uint16), `splatmap_x_y.tga` (4 layers per file in RGBA), `colormap_x_y.png`, `texturemap_x_y.png`, and `bridge.xml` listing resolution, size, min/max height, tile count and layer names ([bridge tools](https://docs.world-creator.com/reference/export/bridge-tools)).
- Recommendation: Orogen writes one file per layer (`.r8` for the plugin, optional letters-only `.png` for the manual route — see filename hygiene in (c)) and lists `name → file → blend method` explicitly in the JSON sidecar; assignment is by **name from the sidecar**, never by directory order.

### Layers per component

- Shaders are compiled per component and unused layers are stripped from that component's material instance; "erasing tiny traces can reduce complexity"; exceeding the per-component texture sample budget shows default grey squares ([Paint Mode](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-paint-mode-in-unreal-engine)).
- A new weightmap texture is added for every 4 target layers on a component (one layer per channel; paraphrase, not a verbatim quote); on most RHIs samplers are shared so there is no hard layer cap; ES3.1 mobile has a hard limit of 16 samplers ([Landscape Materials](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-materials-in-unreal-engine)).
- `ALandscapeProxy.max_painted_layers_per_component` exists (property; semantics of 0 = unlimited are **[RECALLED]**).
- UE 5.8 regression report: edit-layer merge now widens each component's input area to its left/top neighbours and the widened set is persisted as that component's weightmap allocations, so components inherit layers they never used; with ~10+ layers this hits the D3D12 64-SRV limit and the component silently falls back to the default material ([forum, 2026-08-12](https://forums.unrealengine.com/t/landscape-edit-layers-5-8-regression-neighbor-input-area-widening-for-seam-fix-leaks-into-persisted-weightmaplayerallocations-inflating-srv-usage/2743253)). No Epic response yet.
- Orogen guidance **[DERIVED]**: procedural masks are non-zero almost everywhere, which defeats per-component stripping. Before normalising, zero out weights below a threshold (e.g. < 2/255) and optionally keep only the top-K (K = 4) layers per texel; aim for ≤ 4 weight-blended layers per component and ≤ 8 material layers in total; warn above 12 layers in total.

### Edit layers [VERIFIED 5.8 docs]

Source: [Landscape Edit Layers](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-edit-layers-in-unreal-engine).

- Edit layers are "automatically enabled while creating new landscapes" and "All Landscapes are required to have at least one edit layer". The old `bCanHaveLayersContent` flag is now `bCanHaveLayersContent_DEPRECATED` in the 5.8 API ([ALandscape](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ALandscape)).
- Base layer is named "Layer". Each layer has a heightmap alpha and a weightmap alpha (negative height alpha = subtractive). Splines and Landscape Patches live in dedicated procedural edit layers. Collapse and Collapse All are available (Collapse All is destructive and removes Blueprint brushes).
- Imports target an edit layer: `landscape_import_heightmap_from_render_target(..., edit_layer_index=0)`; in C++ `FLandscapeEditDataInterface::SetEditLayer(Guid)` before `SetHeightData/SetAlphaData` (required from 5.6 per Gaea2Unreal source comments).
- Design consequence: import Orogen data into the **bottom edit layer only** and let the user sculpt in layers above it; a re-export from Orogen then replaces the bottom layer without destroying manual work.

### UE 5.8 material caveat

`Landscape Layer Blend` produced wrong output in 5.8.0–5.8.2 (washed-out/incorrect specular, grey Nanite landscape in some cases; first report 2026-06-26). Timeline from the thread: ticket UE-386355 was closed as fixed, a user reported on 2026-08-26 that 5.8.2 did not fix it, Epic staff said on 2026-08-27 the ticket would be reopened, and on 2026-09-07 the bug-reporter account stated it "will be addressed in 5.8.3"; another user reported it fixed in their project in 5.8.2 (possibly 5.8.1) ([forum thread](https://forums.unrealengine.com/t/ue5-8-material-landscape-layer-blend-broken/2731518)). The 5.8.3 notes (2026-09-22) do not mention UE-386355 or Landscape Layer Blend — re-checked during fact-check — so the fix status on 5.8.3 is **[UNVERIFIED]**. Test the sample material we ship on 5.8.3.

Two user-reported workarounds from that thread bear on our defaults (anecdotal, 5.8.0-era): (1) feed individual attributes (e.g. Specular) through the blend node rather than Material Attributes; (2) set the layer infos to **legacy Final Weight Blending instead of Advanced Weight Blending**, which one user said looked washed out. Because the OrogenBridge sketch below defaults to `PremultipliedAlphaBlending` (as Gaea2Unreal does), make the blend method a per-layer sidecar field with three values (`none` / `final` / `advanced`) rather than a boolean, so the default can be flipped without a plugin rebuild if 5.8.3 still misbehaves.

---

## (e) Automating the import

### Inventory of what is and is not scriptable in 5.8

**Python / Blueprint-exposed (verified on the 5.8 Python API pages)**

`unreal.LandscapeProxy` ([page](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/LandscapeProxy?application_version=5.8)):
- `landscape_import_heightmap_from_render_target(render_target, import_height_from_rg_channel=False, edit_layer_index=0) -> bool` — "Overwrites a landscape heightmap with render target data", editor only; RT format must be RTF_RGBA16f, RTF_RGBA32f or RTF_RGBA8; "using RTF_RGBA16f with InImportHeightFromRGChannel == false could have precision loss" ([Blueprint node page](https://dev.epicgames.com/documentation/unreal-engine/BlueprintAPI/Rendering/LandscapeImportHeightmapfromRend-)). The exact channel packing (RGBA8: R = high byte, G = low byte; float R-only = raw 0..65535) is **[RECALLED, UNVERIFIED]**.
- `landscape_import_weightmap_from_render_target(render_target, layer_name, edit_layer_index=0) -> bool` — editor only.
- `landscape_export_heightmap_to_render_target(render_target, export_height_into_rg_channel=False, export_landscape_proxies=True) -> bool`.
- `editor_apply_spline(spline_component, start_width=200.0, end_width=200.0, start_side_falloff=200.0, end_side_falloff=200.0, start_roll=0.0, end_roll=0.0, num_subdivisions=20, raise_heights=True, lower_heights=True, paint_layer=None, edit_layer_name='None') -> None` (widths/falloffs in the spline component's local space, rolls in degrees; defaults as printed on the 5.8 page).
- `set_landscape_material_{scalar,vector,texture}_parameter_value`, `delete_unused_layers()`, `get_landscape_actor()`.
- Properties: `landscape_material` (RW), `landscape_hole_material`, `runtime_virtual_textures`, `virtual_texture_num_lods`, `virtual_texture_lod_bias`, `virtual_texture_render_pass_type`, `max_painted_layers_per_component`, `nanite_lod_index`, `nanite_skirt_enabled`, `nanite_skirt_depth`, `nanite_position_precision`, `nanite_max_edge_length_factor` (RW); `target_layers` is **read-only**; `enable_nanite` is marked **Read-Only** in its property entry on the 5.8 page (the page's summary list labels it Read-Write — the page contradicts itself, so treat it as not settable until tested).

`unreal.Landscape` ([page](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/Landscape?application_version=5.8)): `render_heightmap(world_transform, extents, out_render_target)`, `render_weightmap(...)`, `render_weightmaps(...)`, `get_edit_layers_bp()`, `get_edit_layer_by_name_bp(name)`, `get_target_layer_names(include_visibility_layer=False)`, `force_layers_full_update()`, `get/set_grass_enabled`. Edit layers expose only `visible`, `locked`, `heightmap_alpha`, `weightmap_alpha`, `get_name_bp()`.

`unreal.LandscapeTexturePatch` (Landscape Patch plugin; Python page exists for 5.7, 404 for 5.8, but the [5.8 C++ page](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Plugins/LandscapePatch/ULandscapeTexturePatch) shows the functions are still `BlueprintCallable`): `set_height_source_mode`, `set_height_texture_asset` (virtual textures not supported), `set_height_encoding_mode` / `reset_height_encoding_mode` / `set_height_encoding_settings`, `set_zero_height_meaning`, `set_resolution`, `set_unscaled_coverage`, `set_blend_mode`, `set_falloff`, `snap_to_landscape`, `set_weight_patch_texture_asset`, `set_weight_patch_source_mode`, `get_height_render_target`, … (`AddWeightPatch` is deprecated in 5.8 in favour of `CreateWeightPatch`).

Water plugin: `unreal.WaterBodyRiverComponent.set_river_width_at_spline_input_key(key, width)`, `set_river_depth_at_spline_input_key(key, depth)`; `unreal.WaterBodyComponent.set_water_velocity_at_spline_input_key`, `set_audio_intensity_at_spline_input_key`, `affects_landscape`, `water_heightmap_settings`, `layer_weightmap_settings`; `unreal.WaterSplineComponent.k2_synchronize_and_broadcast_data_change()` ([river component](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/WaterBodyRiverComponent?application_version=5.8), [water body component](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/WaterBodyComponent?application_version=5.8), [spline](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/WaterSplineComponent?application_version=5.8)).

**Not exposed to Python/Blueprint (no page or no UFUNCTION specifier in the 5.8 references)**

- `ALandscapeProxy::Import(...)` — the only function that creates components from height data.
- `FLandscapeImportHelper` (file reading, `ChooseBestComponentSizeForImport`, tiled descriptors) — plain C++ static class in the `LandscapeEditor` module.
- `ULandscapeSubsystem` — no Python class page; every function on its API page has empty specifiers (`ChangeGridSize`, `BuildNanite`, `BuildAll`, `SaveModifiedLandscapes`, …).
- `FLandscapeConfigHelper`, `ALandscape::CreateLayer / CreateDefaultLayer`, `ALandscapeProxy::AddTargetLayer`, `ULandscapeInfo::UpdateLayerInfoMap`, `ULandscapeInfo::ExportHeightmap / ExportLayer`, `FLandscapeEditDataInterface`.
- Setting a Layer Info's layer name (`layer_name` is read-only in Python); enabling Nanite (`enable_nanite` read-only).
- Therefore: **a spawned `unreal.Landscape` actor cannot be given a heightmap from stock Python.** Spawning the class yields an actor without landscape components **[RECALLED, UNVERIFIED]**, and the render-target import functions only overwrite an already-existing landscape of the right size.

**Commandlets**

- No stock landscape-import commandlet exists. `WorldPartitionBuilderCommandlet` builders are HLODs, MiniMap, Rename/Duplicate, ResaveActors, Foliage, NavigationData, SmartObjectCollection, PCG, and an RVT builder ([reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-builder-commandlet-reference)).
- Python can be run unattended: `UnrealEditor-Cmd.exe "<proj>.uproject" -ExecutePythonScript="<script.py>"` (full editor, exits when done; needs Editor Scripting Utilities) or `UnrealEditor-Cmd.exe "<proj>.uproject" -run=pythonscript -script="<script.py>"` (commandlet; does not load a level — call `LevelEditorSubsystem.load_level` first). Embedded Python is 3.11.8. `init_unreal.py` in `Content/Python` auto-runs ([doc](https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-the-unreal-editor-using-python)).
- Landscape edit-layer merging is GPU-based **[RECALLED]**; whether a headless commandlet (even with `-AllowCommandletRendering`) completes a landscape import correctly is **[UNVERIFIED]** — prefer the full-editor form.

**Editor Utility Blueprints / Widgets** can call exactly the Blueprint-callable set above (render-target import, patches, water setters) and any `BlueprintCallable` function our own plugin adds. They cannot create a landscape by themselves.

**Landscape Patches** ([doc](https://dev.epicgames.com/documentation/unreal-engine/landscape-patch-system)): editor plugin; a `Landscape Texture Patch` component on any actor writes height/weights into a Patches edit layer; data is editor-only (no runtime cost); needs edit layers; source modes None / Internal Texture / Texture Backed Render Target / Texture Asset; height encodings Native Packed Height / Zero To One (with Zero In Encoding and World Space Encoding Scale) / World Units; Zero Height Meaning Patch Z / Landscape Z / World Zero; blend modes Alpha, Additive, Min, Max; falloff Circle / Rounded Rectangle; coverage is measured texel-centre to texel-centre. Good for *stamping regions onto an existing landscape non-destructively*; poor as the primary whole-terrain import (needs an existing landscape of the right size; non-virtual 8129² texture asset; resampling path and 16-bit fidelity through a texture asset are **[UNVERIFIED]**).

**Datasmith** has/had a landscape actor element (`FDatasmithActorImporter::ImportLandscapeActor`, documented for 4.26); whether a `.udatasmith` landscape still imports in 5.8 is **[UNVERIFIED]** — not recommended.

### How the existing bridges do it

**QuadSpinner Gaea2Unreal** — open source since 2025-03-11 under a modified MIT licence, branches for UE 5.3/5.4/5.5 and `main`; source comments reference 5.5 and 5.6 API changes ([repo](https://github.com/QuadSpinner/Gaea2Unreal), [announcement](https://blog.quadspinner.com/gaea2unreal-now-open-source/)). Read from [`GaeaSubsystem.cpp`](https://github.com/QuadSpinner/Gaea2Unreal/blob/main/src/Source/GaeaUEToolsEditor/Private/GaeaSubsystem.cpp), [`GaeaSubsystem.h`](https://github.com/QuadSpinner/Gaea2Unreal/blob/main/src/Source/GaeaUEToolsEditor/Public/GaeaSubsystem.h) and the Build.cs:

- Fact-check note on version coverage: `GaeaSubsystem.cpp` on `main` contains no `#if ENGINE_MINOR_VERSION` guards at all, the README names only `main`, `dev` and numbered branches (example `UE-5.3`), and the announcement names 5.3/5.4/5.5. Nothing I could read states that `main` builds against UE 5.7 or 5.8, so "the same calls work on 5.8" is **[UNVERIFIED]** — the per-function signature matches against the 5.8 API pages (below) are the evidence, not Gaea2Unreal.
- Editor module depending on `Landscape`, `LandscapeEditor`, `UnrealEd`, `AssetRegistry`, `Json`, `JsonUtilities`, `EditorScriptingUtilities`, `Foliage`, `MaterialEditor`, …
- Sidecar: a JSON whose filename contains "definition"; struct `FGaeaJson { FString ID; int32 Resolution; float ScaleX, ScaleY, ScaleZ, Height; FString Unit; }`. Only `Resolution`, `ScaleX`, `ScaleY`, `Height` are used.
- Scale: `FVector(ScaleX*100/Resolution, ScaleY*100/Resolution, Height*100/512)`; location `FVector(0, 0, Height*100/2)`.
- File reading: `FLandscapeImportHelper::GetHeightmapImportDescriptor(path, bSingleFile, bFlipYAxis, Descriptor, Msg)` → `ChooseBestComponentSizeForImport(W, H, QuadsPerSection, SectionsPerComponent, ComponentCount)` (seeded from `ULandscapeEditorObject` defaults) → `GetHeightmapImportData` → `TransformHeightmapImportData(..., ELandscapeImportTransformType::ExpandCentered)`; the same trio for weightmaps.
- Layer infos: `AssetTools.CreateAsset(Name, Path, ULandscapeLayerInfoObject::StaticClass(), nullptr)`, `SetLayerName(Name, true)`, `SetBlendMethod(ELandscapeTargetLayerBlendMethod::PremultipliedAlphaBlending, true)`.
- Actor: `World->SpawnActor<ALandscape>(Location + Offset, Rotation)` with `Offset = FTransform(Rotation, 0, Scale).TransformVector(-ComponentCount.X*QuadsPerComponent/2, -ComponentCount.Y*QuadsPerComponent/2, 0)` — i.e. the user-facing "Location" is the **centre**; the actor origin is the min corner. Then `LandscapeMaterial = …`, `SetActorRelativeScale3D(Scale)`.
- Import: `Landscape->Import(FGuid::NewGuid(), 0, 0, SizeX-1, SizeY-1, SectionsPerComponent, QuadsPerSection, HeightmapDataPerLayers, *HeightMapFileName, MaterialLayerDataPerLayers, ELandscapeImportAlphamapType::Additive, TArrayView<const FLandscapeLayer>())` with both maps keyed by a default `FGuid()`.
- After import: `StaticLightingLOD = DivideAndRoundUp(CeilLogTwo((SizeX*SizeY)/(2048*2048)+1), 2)`, `ULandscapeInfo::UpdateLayerInfoMap(Landscape)`, `RegisterAllComponents()`, `Landscape->AddTargetLayer(Name, FLandscapeTargetLayerSettings(LayerInfo, SourceFile))` ("required for weightmap import in 5.5+").
- World Partition: `if (LandscapeSubsystem->IsGridBased() && bIsWorldPartition) LandscapeSubsystem->ChangeGridSize(LandscapeInfo, WorldPartitionGridSize)` — whole-landscape import first, partition afterwards; no region loop.
- Reimport: `ULandscapeInfo::ForEachLandscapeProxy`, per proxy `FLandscapeEditDataInterface::SetEditLayer(Landscape->GetEditLayer(0)->GetGuid())` + `SetHeightData(...)` / `SetAlphaData(...)`, `ClearEditLayer`, `RequestLayersContentUpdateForceAll(ELandscapeLayerUpdateMode::Update_All)`.

**World Creator Unreal Bridge 2.0** — source is not public (distributed as a plugin folder through the customer portal). Documented behaviour only: World Creator "Sync" writes `bridge.xml` + `heightmap_x_y.raw` (uint16) + `splatmap_x_y.tga` (4 layers/file) + colour/texture maps into `Documents\World Creator\Sync\`; in UE, Window → World Creator Bridge → **Read XML Data** auto-fills Section Size, Sections per Component, Landscape Scale, World Partition, Grid Size, region size; options to import materials/layers, reset or keep edit layers on resync, and objects via PCG ([Unreal bridge](https://docs.world-creator.com/reference/export/bridge-tools/unreal-bridge), [bridge tools](https://docs.world-creator.com/reference/export/bridge-tools)). Which C++ APIs it calls is **[UNVERIFIED]**; as a compiled editor plugin it can only be using the same `ALandscape::Import`-centred path.

**Houdini Engine for Unreal** (also open source) exposes `unreal_landscape_partition_grid_size` (default 4) and cooks into temporary edit layers ([SideFX](https://www.sidefx.com/docs/houdini/unreal/worldpartition/worldpartition.html)).

### 5.8 C++ signatures we would depend on [VERIFIED 5.8 API docs]

```cpp
// ALandscapeProxy  (Runtime/Landscape, LandscapeProxy.h)
void Import(const FGuid& InGuid, int32 InMinX, int32 InMinY, int32 InMaxX, int32 InMaxY,
            int32 InNumSubsections, int32 InSubsectionSizeQuads,
            const TMap<FGuid, TArray<uint16>>& InImportHeightData, const TCHAR* const InHeightmapFileName,
            const TMap<FGuid, TArray<FLandscapeImportLayerInfo>>& InImportMaterialLayerInfos,
            ELandscapeImportAlphamapType InImportMaterialLayerType,
            const TArrayView<const struct FLandscapeLayer>& InImportLayers);
FLandscapeTargetLayerSettings& AddTargetLayer(const FName& Name, const FLandscapeTargetLayerSettings& Settings, bool bPostEditChange);
ULandscapeInfo* CreateLandscapeInfo(bool bMapCheck, bool bUpdateAllAddCollisions);
ULandscapeInfo* GetLandscapeInfo();

// FLandscapeImportLayerInfo: FName LayerName; TObjectPtr<ULandscapeLayerInfoObject> LayerInfo;
//                            FString SourceFilePath; TArray<uint8> LayerData;   ctor (FName InLayerName)
// FLandscapeTargetLayerSettings: TObjectPtr<ULandscapeLayerInfoObject> LayerInfoObj; FString ReimportLayerFilePath;
//                            ctors: () and (ULandscapeLayerInfoObject* InLayerInfo, const FString& InFilePath)
// ULandscapeLayerInfoObject (LandscapeLayerInfoObject.h):
//   void SetLayerName(const FName& InLayerName, bool bInModify);
//   void SetBlendMethod(ELandscapeTargetLayerBlendMethod InBlendMethod, bool bInModify);
//   void SetBlendGroup(const FName& InBlendGroup, bool bInModify);
//   (the page carries a TODO that the public properties become private in 5.9 -> always use the setters)

// ALandscape
int32 CreateLayer(FName InName, const TSubclassOf<ULandscapeEditLayerBase>& InEditLayerClass, bool bInIgnoreLayerCountLimit);
void  CreateDefaultLayer();
ULandscapeEditLayerBase* GetEditLayer(int32 InLayerIndex) const;      // also by FName / FGuid
void  RequestLayersContentUpdateForceAll(ELandscapeLayerUpdateMode InModeMask, bool bInUserTriggered);
void  ForceUpdateLayersContent(bool bIntermediateRender);
void  EnableNaniteSkirts(bool bInEnable, float InSkirtDepth, bool bInShouldDirtyPackage);
void  SetNanitePositionPrecision(int32 InPrecision, bool bInShouldDirtyPackage);

// ULandscapeInfo
bool UpdateLayerInfoMap(ALandscapeProxy* Proxy, bool bInvalidate);
void ForEachLandscapeProxy(TFunctionRef<bool(ALandscapeProxy*)> Fn) const;
bool GetLandscapeExtent(int32& MinX, int32& MinY, int32& MaxX, int32& MaxY) const;
void ExportHeightmap(const FString& Filename);                         // round-trip test hook
void ExportLayer(ULandscapeLayerInfoObject* LayerInfo, const FString& Filename);

// ULandscapeSubsystem (UCLASS(MinimalAPI); base UTickableWorldSubsystem -> UWorldSubsystem; LandscapeSubsystem.h)
bool IsGridBased();
void ChangeGridSize(ULandscapeInfo* LandscapeInfo, uint32 NewGridSizeInComponents);
void BuildNanite(UE::Landscape::EBuildFlags InBuildFlags, TArrayView<ALandscapeProxy*> InProxiesToBuild);
void BuildAll(UE::Landscape::EBuildFlags InBuildFlags);
void SaveModifiedLandscapes(UE::Landscape::EBuildFlags InBuildFlags);

// FLandscapeImportHelper (Editor/LandscapeEditor, LandscapeImportHelper.h) — optional, only if we let UE read PNG/tiles
static ELandscapeImportResult GetHeightmapImportDescriptor(const FString& FilePath, bool bSingleFile, bool bFlipYAxis,
                                                           FLandscapeImportDescriptor& Out, FText& OutMessage);
static ELandscapeImportResult GetHeightmapImportData(const FLandscapeImportDescriptor&, int32 DescriptorIndex,
                                                     TArray<uint16>& OutData, FText& OutMessage);
static void ChooseBestComponentSizeForImport(int32 Width, int32 Height, int32& InOutQuadsPerSection,
                                             int32& InOutSectionsPerComponent, FIntPoint& OutComponentCount);
```

Overloads also present on the 5.8 pages (re-read during fact-check): `ALandscapeProxy::AddTargetLayer()` (no arguments; unique name, no layer info), `ALandscape::ForceUpdateLayersContent()` (no arguments), `ULandscapeInfo::ExportHeightmap(const FString&, const FIntRect& ExportRegion)`, `ULandscapeInfo::ExportLayer(ULandscapeLayerInfoObject*, const FString&, const FIntRect& ExportRegion)`, `ULandscapeInfo::GetLandscapeExtent(FIntRect&)` and `GetLandscapeExtent(ALandscapeProxy*, FIntRect&)`, `FLandscapeImportHelper::GetWeightmapImportDescriptor(FilePath, bSingleFile, bFlipYAxis, FName LayerName, Out, OutMessage)` / `GetWeightmapImportData(Descriptor, Index, FName LayerName, TArray<uint8>&, OutMessage)`, `TransformHeightmapImportData(InData, OutData, CurrentResolution, RequiredResolution, ELandscapeImportTransformType, FIntPoint Offset)`, and `FLandscapeConfigHelper::ChangeGridSize(ULandscapeInfo*, uint32, TSet<AActor*>& OutActorsToDelete)` / `PartitionLandscape(UWorld*, ULandscapeInfo*, uint32)`. The API reference prints no default arguments; Gaea2Unreal calls `UpdateLayerInfoMap(Landscape)` with one argument and `TransformHeightmapImportData` with five, so defaults exist for the trailing parameters but their values are **[UNVERIFIED]** — pass every argument explicitly.

Sources: [ALandscapeProxy](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ALandscapeProxy), [ALandscape](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ALandscape), [ULandscapeInfo](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ULandscapeInfo), [ULandscapeSubsystem](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ULandscapeSubsystem), [FLandscapeImportLayerInfo](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Landscape/FLandscapeImportLayerInfo), [FLandscapeImportHelper](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/LandscapeEditor/FLandscapeImportHelper).

### The three candidate routes

**Route 1 — plain files + JSON sidecar + exact manual steps**
- Pros: zero engine-version coupling; works on any 5.x; trivially testable from Orogen's CLI; the user can always fall back to it; it is also the input contract for routes 2 and 3.
- Cons: ~15 manual fields for the landscape, plus one browse per layer; easy to mistype a scale with 7 significant digits; layer infos, water bodies, RVT, Nanite all manual; currently exposed to the 5.7/5.8 World Partition mosaic bug with no way to work around it in code.

**Route 2 — Python script only**
- Pros: no compiler needed on the user's machine; easy to ship/patch (a `.py` next to the export); fine for *post-import* chores (assign material, set scale/location on an existing actor, import textures, create RVT volumes, spawn water bodies and set per-point width/depth/velocity, run builders).
- Cons (decisive): stock Python **cannot create the landscape or load a heightmap file into it** (`Import`, `FLandscapeImportHelper`, `ULandscapeSubsystem`, `AddTargetLayer`, layer-info naming and Nanite enable are all unexposed). The only height write path is `landscape_import_heightmap_from_render_target`, which needs (i) a pre-existing landscape of exactly the right layout, (ii) an 8129² RGBA render target (≈1.06 GB as RGBA32f) and a GPU read-back, (iii) all proxies loaded, and has documented precision caveats for RGBA16f. Not robust enough to be the primary route.

**Route 3 — small C++ editor plugin ("OrogenBridge") — RECOMMENDED**
- Pros: the only route that reaches `ALandscape::Import`; same mechanism as the engine's own New Landscape panel, Gaea2Unreal and Houdini Engine; can read `.r16/.r8` directly (no PNG decode, no `FLandscapeImageFileCache` staleness, no dependency on `LandscapeEditor`); can create layer infos, target layers, partition for World Partition, enable/build Nanite, create water bodies, and expose one `BlueprintCallable` entry point that Python, Editor Utility Widgets and the command line can all call; supports non-destructive re-import into the bottom edit layer; lets us sidestep the editor-UI World Partition bug by choosing our own order of operations (to be tested).
- Cons: must be compiled per engine minor version (and re-validated per hotfix); the landscape C++ API churns almost every release (5.5 overhaul, 5.6 edit-layer GUID requirement, 5.8 deprecations) — Gaea2Unreal needed "overhauling large portions" for 5.5; a Blueprint-only project needs prebuilt binaries from us (build with `RunUAT BuildPlugin` against the launcher 5.8 build) or the user needs Visual Studio 2022 with the C++ game workload; more to test.
- Mitigation: keep the plugin tiny (one function library + one settings struct), isolate every engine call behind one `OrogenLandscapeCompat.cpp`, keep Route 1 always working from the same sidecar, and ship a round-trip self-test (`ULandscapeInfo::ExportHeightmap` → byte-compare with the source `.r16`).

**Recommendation:** Route 3 as the primary path, fed by Route 1's files and sidecar (which also serve as the manual fallback), with Python used only as a thin driver / post-processing layer (`unreal.OrogenImportLibrary.import_terrain(manifest)`).

### Sidecar proposal (`<name>.orogen.json`)

```jsonc
{
  "schema": "orogen.unreal.landscape/1",
  "generator": { "name": "Orogen", "version": "0.1.0" },
  "targetEngine": "5.8",
  "resolution": { "x": 8129, "y": 8129 },
  "layout": { "quadsPerSection": 127, "sectionsPerComponent": 2, "components": { "x": 32, "y": 32 } },
  "heightmap": {
    "r16": "OrogenHeight.r16",          // uint16 little-endian, row-major, row 0 first, no header
    "png": "OrogenHeight.png",          // optional, 16-bit grayscale, for the manual route (letters-only name)
    "heightMinM": -150.0, "heightMaxM": 2250.0,   // metres mapped to 0 and 65535
    "zScaleFormula": "range_cm*128/65535",
    "dither": "tpdf-1lsb"
  },
  "transform": {
    "scaleCm":         { "x": 98.4251968503937, "y": 98.4251968503937, "z": 468.757152666514 },
    "actorLocationCm": { "x": -400000.0, "y": -400000.0, "z": 105001.831082628 },  // actor origin = pixel (0,0)
    "uiLocationCm":    { "x": 0.0, "y": 0.0, "z": 105001.831082628 },              // New Landscape panel "Location" (centre) — see caveat
    "rotationDeg":     { "pitch": 0, "yaw": 0, "roll": 0 }
  },
  "orientation": { "pixel00": "minX_minY", "imageX": "+X", "imageY": "+Y", "flipYAxis": false },
  "worldPartition": { "enabled": true, "gridSize": 4, "regionSize": 32 },
  "alphamapType": "Additive",
  "layers": [
    // "blend": "none" | "final" | "advanced"  ->  ELandscapeTargetLayerBlendMethod::None | FinalWeightBlending | PremultipliedAlphaBlending
    //          (Python: NONE=0, FINAL_WEIGHT_BLENDING=1, PREMULTIPLIED_ALPHA_BLENDING=2). "blendGroup" only applies to "advanced".
    { "name": "Rock",  "r8": "LayerRock.r8",  "png": "LayerRock.png",  "blend": "advanced", "blendGroup": "Orogen" },
    { "name": "Grass", "r8": "LayerGrass.r8", "png": "LayerGrass.png", "blend": "advanced", "blendGroup": "Orogen" },
    { "name": "MaskFlow", "r8": "MaskFlow.r8", "png": "MaskFlow.png", "blend": "none" }
  ],
  "textures": [
    { "role": "albedo", "file": "T_Albedo_8192.png", "size": 8192, "srgb": true,  "covers": "landscapeExtent" },
    { "role": "normal", "file": "T_Normal_8192.png", "size": 8192, "srgb": false, "convention": "directx-y-down" }
  ],
  "splines": "splines.json",
  "nanite": { "enable": true, "skirt": true }
}
```

### Code sketch for the recommended route (UE 5.8; to be compiled and tested — not yet run)

```cpp
// OrogenImportLibrary.h  (module type: Editor; deps: Core, CoreUObject, Engine, UnrealEd, Landscape,
//                         AssetTools, AssetRegistry, Json, JsonUtilities)
UCLASS()
class UOrogenImportLibrary : public UBlueprintFunctionLibrary
{
    GENERATED_BODY()
public:
    /** Creates a Landscape in the current editor world from an Orogen sidecar. Callable from Python / EUW. */
    UFUNCTION(BlueprintCallable, Category = "Orogen")
    static ALandscape* ImportTerrain(const FString& ManifestPath, FString& OutError);
};

// OrogenImportLibrary.cpp
ALandscape* UOrogenImportLibrary::ImportTerrain(const FString& ManifestPath, FString& OutError)
{
    FOrogenManifest M;                                   // plain struct mirroring the JSON
    if (!LoadManifest(ManifestPath, M, OutError)) return nullptr;

    const int32 QuadsPerComponent = M.QuadsPerSection * M.SectionsPerComponent;      // 127 * 2 = 254
    const int32 SizeX = M.Components.X * QuadsPerComponent + 1;                      // 8129
    const int32 SizeY = M.Components.Y * QuadsPerComponent + 1;
    if (SizeX != M.ResX || SizeY != M.ResY) { OutError = TEXT("layout/resolution mismatch"); return nullptr; }

    // 1. Heights: raw uint16 LE, row-major; index = X + Y * SizeX.
    TArray<uint8> Raw;
    if (!FFileHelper::LoadFileToArray(Raw, *M.HeightR16) || Raw.Num() != (int64)SizeX * SizeY * 2)
    { OutError = TEXT("bad .r16 size"); return nullptr; }
    TArray<uint16> Heights; Heights.SetNumUninitialized(SizeX * SizeY);
    FMemory::Memcpy(Heights.GetData(), Raw.GetData(), Raw.Num());                    // host is little-endian

    // 2. Layers: one uint8 array per target layer + a ULandscapeLayerInfoObject asset each.
    TArray<FLandscapeImportLayerInfo> Layers;
    for (const FOrogenLayer& L : M.Layers)
    {
        FLandscapeImportLayerInfo Info{ FName(*L.Name) };
        Info.SourceFilePath = L.R8Path;
        Info.LayerInfo = FindOrCreateLayerInfo(L);       // AssetTools.CreateAsset(..., ULandscapeLayerInfoObject::StaticClass(), nullptr);
                                                         // SetLayerName(Name, true); SetBlendMethod(<None | FinalWeightBlending | PremultipliedAlphaBlending per sidecar "blend">, true);
                                                         // SetBlendGroup(Group, true) for "advanced"
        if (!FFileHelper::LoadFileToArray(Info.LayerData, *L.R8Path) || Info.LayerData.Num() != SizeX * SizeY)
        { OutError = FString::Printf(TEXT("bad layer %s"), *L.Name); return nullptr; }
        Layers.Add(MoveTemp(Info));
    }

    UWorld* World = GEditor->GetEditorWorldContext().World();
    FScopedSlowTask Slow(3, INVTEXT("Importing Orogen terrain")); Slow.MakeDialog();

    // 3. Spawn at the min corner (pixel 0,0), scale in cm per quad / cm per 128 height units.
    ALandscape* Landscape = World->SpawnActor<ALandscape>(M.ActorLocation, M.Rotation);
    Landscape->LandscapeMaterial = LoadObject<UMaterialInterface>(nullptr, *M.MaterialPath);
    Landscape->SetActorRelativeScale3D(M.Scale);
    Landscape->StaticLightingLOD =
        FMath::DivideAndRoundUp(FMath::CeilLogTwo((SizeX * SizeY) / (2048 * 2048) + 1), (uint32)2);

    // 4. Import into the default edit layer (maps keyed by a default FGuid, as the editor and Gaea2Unreal do).
    TMap<FGuid, TArray<uint16>> HeightPerLayer;                 HeightPerLayer.Add(FGuid(), MoveTemp(Heights));
    TMap<FGuid, TArray<FLandscapeImportLayerInfo>> MatPerLayer; MatPerLayer.Add(FGuid(), Layers);
    Slow.EnterProgressFrame();
    Landscape->Import(FGuid::NewGuid(), 0, 0, SizeX - 1, SizeY - 1,
                      M.SectionsPerComponent, M.QuadsPerSection,
                      HeightPerLayer, *M.HeightR16, MatPerLayer,
                      ELandscapeImportAlphamapType::Additive,
                      TArrayView<const FLandscapeLayer>());

    // 5. Register target layers.
    ULandscapeInfo* LInfo = Landscape->GetLandscapeInfo();
    LInfo->UpdateLayerInfoMap(Landscape, /*bInvalidate*/ false);
    for (const FLandscapeImportLayerInfo& L : Layers)
        if (L.LayerInfo) Landscape->AddTargetLayer(L.LayerName, FLandscapeTargetLayerSettings(L.LayerInfo, L.SourceFilePath), true);

    // 6. World Partition: split into streaming proxies of GridSize x GridSize components.
    Slow.EnterProgressFrame();
    if (ULandscapeSubsystem* LS = World->GetSubsystem<ULandscapeSubsystem>(); LS && LS->IsGridBased() && M.bWorldPartition)
        LS->ChangeGridSize(LInfo, M.GridSize);

    // 7. Optional: Nanite (set bEnableNanite via reflection + PostEditChangeProperty; EnableNaniteSkirts(...);
    //    LS->BuildNanite(...)), then save dirty packages (external actors).
    Slow.EnterProgressFrame();
    FActorLabelUtilities::SetActorLabelUnique(Landscape, TEXT("Orogen_Landscape"));
    return Landscape;
}
```

Python driver (full editor, unattended):

```python
# run: UnrealEditor-Cmd.exe "D:/Game/Game.uproject" -ExecutePythonScript="D:/Orogen/export/import_orogen.py"
import unreal
unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level("/Game/Maps/World")
landscape, err = unreal.OrogenImportLibrary.import_terrain(r"D:/Orogen/export/terrain.orogen.json")   # out-param returned as tuple
if not landscape:
    raise RuntimeError(err)
unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)
```

Fact-check update: the `SetLayerName(const FName&, bool)` / `SetBlendMethod(ELandscapeTargetLayerBlendMethod, bool)` signatures, the `FLandscapeTargetLayerSettings(ULandscapeLayerInfoObject*, const FString&)` constructor, the `FLandscapeImportLayerInfo(FName)` constructor, the 12-parameter `ALandscapeProxy::Import` and `UpdateLayerInfoMap(ALandscapeProxy*, bool)` were all re-read on the 5.8 API reference pages and match the sketch (declarations only — the API reference shows no default arguments and no behaviour, and no deprecation markers on any of them). Note that `bEnableNanite` does not appear as a public member on the 5.8 `ALandscapeProxy` API page and no `SetNaniteEnabled`-style setter is listed (only `IsNaniteEnabled()`, `EnableNaniteComponents(bool)`, `EnableNaniteSkirts`, `SetNanitePositionPrecision`), so step 7's "set via reflection" is the only route visible in the docs and is **[UNVERIFIED]**. Things in the sketch that still must be confirmed by compiling and running against 5.8.3: whether `Import` creates the default edit layer by itself when `InImportLayers` is empty (Gaea2Unreal relies on `GetEditLayer(0)` existing afterwards), and whether the World Partition mosaic bug reproduces through this path.

### Manual steps for Route 1 (UE 5.8 editor)

1. Open/create the level. Landscape Mode → Manage → New → **Import from File**.
2. Heightmap File → `OrogenHeight.png` (or `.r16`). Leave **Flip Y Axis** off. If the editor asks whether to use the tiled image path, answer No (single file).
3. Check the auto-filled layout against the sidecar: Section Size 127x127 Quads, Sections Per Component 2x2, Number of Components 32 x 32, Overall Resolution 8129 x 8129, Total Components 1024.
4. Enter Scale X/Y/Z from `transform.scaleCm`; enter Location from `transform.uiLocationCm` (the panel's Location is the landscape centre in X/Y — derived from the engine's centring offset as replicated in Gaea2Unreal; **confirm once on 5.8** and otherwise use `actorLocationCm` on the actor after creation).
5. Material → the landscape material; for each listed layer: create/assign the Layer Info ("+" → Weight-Blended or Non Weight-Blended) and browse its layer `.png`. Layer Alphamap Type = **Additive**.
6. World Partition level: set World Partition Grid Size and Region Size from the sidecar.
7. Import. Then verify: select the Landscape actor → Transform shows `actorLocationCm` and `scaleCm`.
8. Details → Nanite → Enable Nanite → Build Data (or Build → Build Landscape).

---

## (f) Other maps Unreal workflows consume

**Normals.** The landscape derives its vertex normals from the heightmap and stores them in the heightmap texture's spare channels ("Height uses 16 bits, and normals are stored in the remaining channels", [Overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-overview)). No normal map is needed for base shading. An exported normal map is only useful as a higher-than-vertex-resolution macro/detail normal sampled in the material. UE's convention is DirectX-style (green = −Y; OpenGL-style maps need "Flip Green Channel") **[RECALLED]**; import with sRGB off, Normalmap compression. Compute normals from heights in *world units* (dz in cm over dx = ScaleX cm), not from normalised 0..1 heights.

**Colour / albedo macro texture and Runtime Virtual Texture.**
- Any texture that must mip/stream must be **power-of-two**; Streaming Virtual Textures also require power-of-two dimensions ([SVT doc](https://dev.epicgames.com/documentation/en-us/unreal-engine/streaming-virtual-texturing-in-unreal-engine)). So export colour/normal/mask *textures* at 4096 / 8192 / 16384, **not** at 8129. Map them over the landscape extent in the material (UV = (WorldXY − LandscapeMinXY) / (Quads × ScaleXY), or `LandscapeLayerCoords`).
- RVT ([doc](https://dev.epicgames.com/documentation/en-us/unreal-engine/runtime-virtual-texturing-in-unreal-engine)): the landscape material writes through a **Runtime Virtual Texture Output** node and reads through **Runtime Virtual Texture Sample**; add the RVT asset to the landscape's "Draw in Virtual Textures" list; place a Runtime Virtual Texture Volume and use "Set Bounds" from the landscape; landscape `Virtual Texture Pass Type` = Always (or From Virtual Texture). Material types: Base Color (BC1); Base Color+Normal+Roughness+Specular (2×BC3); YCoCg variants (BC3+BC5+BC1, +~25 % memory); **World Height** (R16_UNORM normalised between the volume's min and max Z); Displacement (BC4); Mask4 (BC3). `Virtual Texture Num LODs` 0 renders each component as one quad. Low mips can be baked to a Streaming Virtual Texture (Build → Build Virtual Textures, or the RVT World Partition builder). Materials writing an RVT cannot sample other virtual textures. Non-Nanite landscape data is still required for RVT.
- Texture size limits: the D3D texture limit is 16384 per side (evidence: engine assertion "Requested texture2d x size too large: 32768, 16384", [forum](https://forums.unrealengine.com/t/ue4-crashing-requested-texture2d-x-size-too-large-32768-16384/484607)) **[VERIFIED third-party, UE4-era]**. Epic's 5.8-labelled texture page still describes 8192 as the supported non-VT maximum via LOD-group `MaxLODSize` (UE4-era text). "Auto Virtual Texturing Size" (Project Settings → Texture Import) converts large imports to VT; its default was reported as 4096 in an Epic bug report **[UNVERIFIED for 5.8]**. The maximum importable size of a single virtual texture and of UDIM sets in 5.8 is **[UNVERIFIED]**. UDIM naming is `Base.1001.png`, and UDIM tiles are flipped vertically on import ([SVT doc](https://dev.epicgames.com/documentation/en-us/unreal-engine/streaming-virtual-texturing-in-unreal-engine)).
- Practical rule: ≤ 8192 as regular streamed textures; 16384 only as a virtual texture; beyond that tile it (UDIM) or rely on procedural material layers. For 8 km, 8192 ≈ 0.98 m/texel and 16384 ≈ 0.49 m/texel. BC7 8192² ≈ 64 MB (+33 % mips); 16384² ≈ 256 MB.

**Masks for PCG, grass and foliage.**
- Best vehicle: import masks as **non-weight-blended landscape layers**. PCG's *Get Landscape Data* returns landscape data with per-layer weights when `get_layer_weights` is on ([`PCGLandscapeDataProps`](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/PCGLandscapeDataProps?application_version=5.8); also `get_height_only`, `get_physical_material`, `sample_virtual_textures`), and the Landscape Grass system reads layer weights through the material's grass output **[RECALLED]**. Cost: every such layer occupies a weightmap channel on every component it touches (see the layer budget in (d)).
- Alternative: mask textures sampled by PCG *Get Texture Data* → *Texture Sampler* ("requires a GPU to execute for most compressed texture types"; CPU-available textures and an editor-only "Force Editor Only CPU Sampling" option exist) ([PCG node reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/procedural-content-generation-framework-node-reference-in-unreal-engine)). Import masks with sRGB off, Masks/Grayscale compression, power-of-two size.
- `PCGWorldPartitionBuilder` can regenerate PCG headlessly ([commandlet reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-builder-commandlet-reference)).

**Flow maps.** No engine feature consumes a terrain flow-map file directly. Rivers in the Water plugin get flow from per-spline-point velocity, not from a texture ("Rivers do not use waves. Flow comes from the velocity map", [Water Body Actors](https://dev.epicgames.com/documentation/en-us/unreal-engine/water-body-actors-in-unreal-engine)). Export flow as (a) a single-channel accumulation mask (→ landscape layer or mask texture, drives wetness/riverbed materials and PCG), and (b) optionally a 2-channel direction texture (RG, 0.5 = zero, linear, BC5 or uncompressed) for custom materials. Document the axis convention: +R = +X, +G = +Y in landscape space.

**River / lake splines for the Water plugin.**
- Actors: `AWaterBodyRiver` / `AWaterBodyLake` / `AWaterBodyOcean` with a `UWaterSplineComponent` (a `USplineComponent`) and `UWaterSplineMetadata` holding per-point curves `Depth`, `RiverWidth` ("the width of the river (from center) in each direction" — i.e. a **half-width**), `WaterVelocityScalar` ("magnitude and direction"; sign sets flow direction) and `AudioIntensity` ([UWaterSplineMetadata](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/Water/UWaterSplineMetadata)). Units are not documented; treat width/depth as cm **[UNVERIFIED]**. Note the plugin's status: in 5.8 the Water headers still live under `/Engine/Plugins/Experimental/Water/` (header path printed on the `UWaterBodyRiverComponent` API page), so treat the Water plugin API as experimental and liable to change.
- Scriptable setters (BlueprintCallable, 5.8): `UWaterBodyRiverComponent::SetRiverWidthAtSplineInputKey(float InKey, float InWidth)`, `SetRiverDepthAtSplineInputKey(float InKey, float InDepth)` ([API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/Water/UWaterBodyRiverComponent)); `UWaterBodyComponent::SetWaterVelocityAtSplineInputKey`, `SetAudioIntensityAtSplineInputKey`; after adding points via the generic spline API call `K2_SynchronizeAndBroadcastDataChange()`.
- Water bodies carve the landscape through a water brush on an edit layer (requires edit layers); per-body `Affects Landscape`, curve settings (channel edge offset, curve ramp width, per-point depth), falloff (angle/width), blend modes Alpha/Min/Max/Additive. Lake and ocean points must share one height; river points may vary. Because Orogen's heightmap already contains the eroded channel, create rivers with **`affects_landscape = False`** (or Min blend) to avoid double carving — the right default needs an in-engine test.
- Recommended export: a JSON file (no native interchange format for water splines exists) —
  ```jsonc
  { "schema": "orogen.splines/1", "space": "unreal-world-cm",
    "rivers": [ { "name": "River_001",
        "points": [ { "pos": [x, y, z], "halfWidthCm": 600, "depthCm": 150, "velocity": 1.0 } ],
        "pointType": "curve" } ],
    "lakes":  [ { "name": "Lake_001", "surfaceZ": 12345.0, "points": [ [x, y], [x, y] ] } ] }
  ```
  Positions in Unreal world cm (already transformed with the sidecar's scale/offset) so the importer does no maths; resample the polyline to a point every 50–200 m (splines with thousands of points are slow to edit) and let UE compute tangents (curve points).
- For roads/paths: `ALandscapeProxy::EditorApplySpline(...)` deforms/paints along any `USplineComponent` and is BlueprintCallable; Landscape Splines themselves have little scripting exposure.

**Nanite landscape** ([doc](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-nanite-with-landscapes-in-unreal-engine)): tick **Enable Nanite** on the Landscape actor, then Details → Nanite → **Build Data** / Rebuild Data, or Build → **Build Landscape**. Settings documented on that page: Enable Nanite Skirt + Nanite Skirt Depth (hides seams between proxies). Nanite LOD Index, Position Precision and Max Edge Length Factor are **not** described on the 5.8 doc page; they exist as `ALandscapeProxy` properties (`nanite_lod_index`, `nanite_position_precision`, `nanite_max_edge_length_factor`, all Read-Write on the 5.8 Python page) — "LOD 0 preferred" is my own advice, not Epic's. Nanite and non-Nanite data both stay in memory and the page says twice the amount of data is streamed (paraphrase; the earlier draft put "roughly doubling streamed data" in quotation marks, which is not the page's wording); non-Nanite data remains required for RVT, water, etc.; stale Nanite data makes the editor fall back to the non-Nanite mesh and is rebuilt at cook time; tessellation needs displacement in the landscape material plus up-to-date Nanite data. CVars: `Landscape.RenderNanite` (1), `Landscape.Nanite.LiveRebuildOnModification` (0, experimental), `Landscape.Nanite.MultithreadedBuild` (1) — names and defaults as in the page's CVar table (the page's prose once spells the second one `Landscape.LiveRebuildNaniteOnModification`; trust the table, or check with the console's autocomplete). On Nanite landscapes the visibility mask has no material cost.

**Holes / visibility.** A Landscape Visibility Mask node outputs 0 where hidden; Texture Patches can target the visibility layer (`set_edit_visibility_layer`). Only relevant if Orogen ever exports cave entrances.

---

## (g) Coordinate conventions

- **Axes, handedness** [VERIFIED 5.8 docs]: left-handed, Z up; +X forward, +Y right, +Z up ([Coordinate System and Spaces](https://dev.epicgames.com/documentation/en-us/unreal-engine/coordinate-system-and-spaces-in-unreal-engine)).
- **Units**: 1 Unreal unit = 1 cm (the Technical Guide's "Z scale 1 → 256 cm" and "default scale 100 = distance between vertices" follow from it). Default landscape scale is (100, 100, 100) → 1 m per quad and 0.78125 cm per height unit.
- **Actor origin**: the Landscape actor's location is the position of vertex (0,0) — the min-X/min-Y corner — at stored height 32768. The New Landscape panel takes a centre location and offsets the actor by −half the extent (seen verbatim in Gaea2Unreal's replica of the editor code). A MathWorks example is consistent with the corner-origin of the *actor*: a 65x65 heightmap imported as one 63-quad component (overall resolution 64x64), with the landscape's Location and Scale then set to [0,0,0] and [100,100,10], has its far corner at X = Y = +6300 cm = 63 quads × 100 ([MathWorks, R2026b page, written against UE 4.27-era docs](https://www.mathworks.com/help/aeroblks/create-landscape-in-unreal-editor.html)) **[VERIFIED third-party]**. The page does not itself say "corner" or "centre", and it sets Location after the import (on the actor), so it says nothing about the New Landscape panel's Location field; the panel's centre semantics remain **[RECALLED + Gaea2Unreal replica, UNVERIFIED in docs]** — the 5.8 Creating Landscapes page only says Location is where the landscape is created.
- **Image → landscape mapping**: data is row-major with index = X + Y × SizeX (this is the exact indexing Gaea2Unreal uses when slicing the full-size array per proxy: `SrcIndex = SrcY * SizeX + SrcX`). Hence **image column i → +X, image row j (top to bottom) → +Y, pixel (0,0) (top-left) → actor origin; no mirroring**. Not stated in Epic's docs — **[high confidence, RECALLED + corroborated; verify with the test below]**.
  - Seen from above with +X pointing right, +Y points down the screen (left-handed, Z up), i.e. the landscape looks exactly like the image.
  - Unreal's Top viewport draws +X up and +Y right, so the same landscape appears rotated 90° counter-clockwise relative to the image — this is the "Unreal rotates my heightmap 90°" report that recurs on forums ([World Machine forum](https://forum.world-machine.com/t/issue-with-height-maps-exporting/3422)). It is a view convention, not a data flip.
  - With a north-up image (row 0 = north): +X = east, +Y = south.
  - Tools with a bottom-left origin (World Machine) need a vertical flip on export; Orogen (top-left origin, like PNG) does not.
- **Flip Y Axis** import option: documented only as "flips the Y coordinate of the imported file … used to resolve issues where tiled heightmaps do not fit together". Whether it reorders tiles only or also rows is **[UNVERIFIED]**; keep it off and export in the native orientation.
- **Pixel-is-point**: N samples span N−1 quads. Never divide the extent by N.
- **Textures over the landscape**: a W-texel colour/mask texture should cover the vertex-to-vertex extent `[0, (N−1)·Scale]`; U = (X_world − ActorX) / ((N_x − 1)·ScaleX), V likewise with Y; V increases with +Y, matching image rows, so no flip.

### Mandatory acceptance test (cheap, removes every UNVERIFIED above)

Generate a 505x505 test terrain: flat at v = 32768, a 16x16 block at v = 65535 in the top-left corner, an 8x8 block at v = 0 in the top-right corner, and a ramp along the bottom row. Import through each route, then assert: (1) top-left block is at actor origin (min X, min Y) and reaches `ActorZ + 255.992·ScaleZ`; (2) top-right block is at max X / min Y and reaches `ActorZ − 256·ScaleZ`; (3) `ULandscapeInfo::ExportHeightmap()` output is byte-identical to the source; (4) repeat in a World Partition level on 5.8.3 with the real 8129² file to check for the mosaic bug.

---

## Fully worked example: 8129 x 8129, 8 km x 8 km, 2400 m of relief

Assumptions: square terrain centred on the world origin; Orogen heights span h_min = −150 m … h_max = +2250 m relative to the game's sea level (2400 m relief; substitute your own h_min); "8 km" is measured first vertex to last vertex.

**Layout** [VERIFIED table]: 127 quads/section, 2x2 sections/component (254 quads), 32 x 32 components = 1024 components; 8128 quads per side; 66,080,641 vertices; 132,128,768 triangles at LOD0.

**Horizontal scale**
```
ScaleX = ScaleY = 800000 cm / 8128 = 98.4251968503937 cm
```
(1 component = 254 × 98.4252 cm = 250.000 m exactly; if a round 100 cm/quad is preferred the terrain is 8.128 km instead.)

**Vertical scale**
```
Range   = 2400 m = 240000 cm
ScaleZ  = 240000 × 128 / 65535 = 468.757152666514      (exact form)
        ≈ 240000 / 512         = 468.75                (Epic's doc formula; top comes out 3.66 cm low)
Step    = ScaleZ / 128 = 3.6621652552 cm per 16-bit unit
```

**Quantisation**
```
v = round( (h_m − (−150)) / 2400 × 65535 + tpdf_dither )     clamp 0..65535
h = −150 m → v = 0;   h = 0 m (sea level) → v = 4096 (4095.94 → 4096);   h = 2250 m → v = 65535
```

**Actor transform**
```
ActorZ = h_min_cm + 256 × ScaleZ = −15000 + 120001.831082628 = 105001.831082628 cm
ActorX = ActorY = −400000 cm                         (actor origin = image pixel (0,0))
Scale  = (98.4251968503937, 98.4251968503937, 468.757152666514)
New Landscape panel Location (centre) = (0, 0, 105001.831)      [confirm centre semantics once]
```
Check: world_z(0) = 105001.831 − 256 × 468.757153 = −15000.000 cm ✓; world_z(65535) = 105001.831 + 255.9921875 × 468.757153 = 225000.000 cm ✓.
With Epic's approximate form (ScaleZ 468.75, ActorZ = −15000 + 120000 = 105000) the top is 224996.34 cm.

**World footprint**: X, Y ∈ [−400000, +400000] cm; Z ∈ [−15000, +225000] cm. Pixel (i, j) → world (−400000 + i × 98.4252, −400000 + j × 98.4252).

**World Partition** [DERIVED from verified definitions]
| Grid Size (components per proxy side) | Proxies | Proxy footprint |
|---|---|---|
| 2 | 16 x 16 = 256 | 500 m |
| 4 | 8 x 8 = 64 | 1 km |
| 8 | 4 x 4 = 16 | 2 km |

Region Size 16 → 2 x 2 = 4 regions of 4 km; Region Size 32 (or 64) → one region, which keeps the import on the simple single-pass path. Suggested starting point: Grid Size 4, Region Size 32 (a tuning choice, not an Epic recommendation).

**Files and memory**
- `OrogenHeight.r16`: 8129 × 8129 × 2 = 132,161,282 bytes (126.0 MiB). Each `.r8` layer: 66,080,641 bytes (63.0 MiB).
- In-engine landscape texture data ≈ 4 bytes/vertex ≈ 264 MB before weightmaps (Epic's per-vertex figure); Nanite roughly doubles streamed data.
- Single file only: 8129 = 11 × 739, so the only even tiling would be 11 x 11 tiles of 739 px.

**Precision note**: 3.66 cm steps over 98.4 cm spacing = 2.13° slope quantum → dither is required for clean normals on plains and lake shores.

**Companion textures**: albedo/normal/mask textures at 8192² (0.977 m/texel over 8 km) as regular or virtual textures; 16384² (0.488 m/texel) only as virtual textures.

---

## Known 5.8 issues to test against (summary)

| Issue | Versions | Status | Source |
|---|---|---|---|
| Single 8129² PNG into a World Partition level renders a repeated mosaic | 5.7.0, 5.7.4, 5.8.0 (OK in 5.5.4, 5.6.1) | open, no Epic reply | [forum 2026-08-24](https://forums.unrealengine.com/t/landscape-heightmap-import-duplicates-single-tile-in-world-partition-ue-5-7/2745963) |
| Landscape Layer Blend node output wrong | 5.8.0–5.8.2 (UE-386355) | closed as fixed, reopened 2026-08-27; "will be addressed in 5.8.3" (2026-09-07); not listed in the 5.8.3 notes → fix unconfirmed | [forum](https://forums.unrealengine.com/t/ue5-8-material-landscape-layer-blend-broken/2731518) |
| Edit-layer merge leaks neighbour layers into weightmap allocations → SRV overflow → default material | 5.8 | open | [forum 2026-08-12](https://forums.unrealengine.com/t/landscape-edit-layers-5-8-regression-neighbor-input-area-widening-for-seam-fix-leaks-into-persisted-weightmaplayerallocations-inflating-srv-usage/2743253) |
| Landscape patch "reinitialize height/weights" failing first time | fixed in 5.8.3 | fixed | [5.8.3 notes](https://forums.unrealengine.com/t/5-8-3-hotfix-released/2833315) |
| Crash editing landscape layers in Landscape Mode | fixed in 5.8.2 | fixed | [5.8.2 notes](https://forums.unrealengine.com/t/5-8-2-hotfix-released/2746335) |
| Region Size 4 assertion | 5.5.4 | unknown on 5.8 | [forum](https://forums.unrealengine.com/t/ue-5-5-4-crashes-when-creating-landscape-with-world-partition-region-size-4-landscapeeditlayers-cpp-line-2121/2739797) |

## What could not be verified (do not hard-code without a test)

1. Engine source constant *values* (`LANDSCAPE_ZSCALE`, `MidValue`, `MaxValue`) and the tile-name matcher — only their observable behaviour and the identifiers `LandscapeDataAccess::MidValue/MaxValue/GetLocalHeight/GetTexHeight` and `FLandscapeImportHelper::ExtractCoordinates(BaseFilename, OutCoord, OutBaseFilePattern)` are verified. Do not assume the matcher is the regex `_x(\d+)_y(\d+)`: that expression was this report's shorthand, not engine text; whether the engine uses a regex at all, its case sensitivity, and its handling of zero padding or negative indices are unknown. Emit exactly `<Base>_x<int>_y<int>.<ext>` with lowercase `x`/`y`, no padding, non-negative indices.
2. Defaults for World Partition Grid Size (2?) and Region Size (16?); only the clamps 1–16 and 4–64 are verified.
3. Semantics of Flip Y Axis for single files; tile Y ordering.
4. Whether the New Landscape panel's Location is the centre in 5.8 (derived from Gaea2Unreal's replica of the editor code).
5. Render-target import channel packing and required RT size.
6. Whether commandlet mode can complete a landscape import; whether the C++ `Import` path reproduces the World Partition mosaic bug.
7. Maximum virtual-texture import dimensions in 5.8; default Auto Virtual Texturing Size.
8. Water spline width/depth units; best `Affects Landscape` setting for pre-eroded terrain.
9. World Creator bridge internals (closed source).
10. `.raw` JSON sidecar key spelling (`bbp` vs `bpp`).

---

## Verification log

Independent fact-check, 2026-10-12. Method: each claim below was re-read on the primary source (Epic's 5.8-labelled documentation, C++ API reference and Python API reference; Epic's forum announcement threads; the Gaea2Unreal source on GitHub) rather than taken from this report's citations, and every number in the worked example was recomputed. The engine source repository is private and no public copy of the relevant files was found, so anything that only the source can settle is listed as unverifiable. Corrections were made in place above and are marked "Fact-check correction" / "Fact-check note" / "Fact-check update".

Limits of this check: web pages were read through a fetch tool that returns an extract of the page rather than its raw text. Wherever a correction rests on something being *absent* from a page (C1, C4, C7 and the blend wording in C2/C3), the page was queried a second time with literal search strings; one first-pass "absent" finding (the `Terrain_1.png` example in C6) turned out to be present on the second query and was reinstated. Nothing was compiled or run in Unreal.

No arithmetic error and no wrong API name, flag, formula or version number was found. The corrections are misattributed or non-verbatim quotations, two overstated behavioural claims (weight-blend normalisation, the cause of the filename errors) and several precision upgrades.

### Confirmed

| # | Claim | Result | Primary source |
|---|---|---|---|
| 1 | UE 5.8 released 2026-06-17; hotfixes 5.8.2 on 2026-08-25 and 5.8.3 on 2026-09-22 | confirmed (first-post dates of Epic's own threads) | [5.8 released](https://forums.unrealengine.com/t/unreal-engine-5-8-released/2729274), [5.8.2](https://forums.unrealengine.com/t/5-8-2-hotfix-released/2746335), [5.8.3](https://forums.unrealengine.com/t/5-8-3-hotfix-released/2833315) |
| 2 | Recommended sizes table, all 11 rows, incl. 8129² = 127 quads/section, 2x2 sections, 254-quad components, 32x32 = 1024 components; "max 1024 components" advice; section vertex count power of two, max 256 | confirmed row by row | [Landscape Technical Guide (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-technical-guide-in-unreal-engine) |
| 3 | New Landscape "Number of Components" capped at 32 x 32 | confirmed | [Creating Landscapes (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/creating-landscapes-in-unreal-engine) |
| 4 | Height range −256 … 255.992 at 16-bit precision, times Z scale; Z-scale constant 0.001953125 (= 1/512); Mauna Kea 4207 m → 821.6796875, ±210,350 cm | confirmed; recomputed 420700/512 = 821.6796875 and × 256 = 210,350 | Technical Guide; [heightmap import doc (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-and-exporting-landscape-heightmaps-in-unreal-engine) |
| 5 | Native packed height maps to [−256, 256 − 1/128] before landscape scale (step 1/128, zero at 32768) | number range confirmed; see correction C1 for the quotation | [Landscape Patch System (5.8)](https://dev.epicgames.com/documentation/unreal-engine/landscape-patch-system) |
| 6 | Import formats 16-bit grayscale PNG, 8-bit r8, 16-bit r16; export PNG/.r16; `.raw` needs a same-name JSON whose example key is printed as `bbp`; Import Type options Original / Expand / Resample / Subregion; Export Single File; tiled-path prompt with no naming rule documented | confirmed | Technical Guide; heightmap import doc |
| 7 | `WorldPartitionGridSize` clamp 1–16, `WorldPartitionRegionSize` clamp 4–64, both `uint32`; `bFlipYAxis`; `ImportLandscape_AlphamapType` | confirmed (ClampMin/ClampMax/UIMin/UIMax as stated) | [ULandscapeEditorObject (5.8 API)](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/LandscapeEditor/ULandscapeEditorObject) |
| 8 | `ALandscapeProxy::Import` 12-parameter signature, `AddTargetLayer(const FName&, const FLandscapeTargetLayerSettings&, bool)`, `CreateLandscapeInfo(bool, bool)`, `EditorApplySpline` BlueprintCallable; no deprecation flags | confirmed verbatim | [ALandscapeProxy (5.8 API)](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ALandscapeProxy) |
| 9 | `ALandscape::CreateLayer / CreateDefaultLayer / GetEditLayer (index, name, guid) / RequestLayersContentUpdateForceAll / ForceUpdateLayersContent / EnableNaniteSkirts / SetNanitePositionPrecision`; `bCanHaveLayersContent_DEPRECATED` | confirmed | [ALandscape (5.8 API)](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ALandscape) |
| 10 | `ULandscapeInfo::UpdateLayerInfoMap(ALandscapeProxy*, bool)`, `ForEachLandscapeProxy`, `GetLandscapeExtent`, `ExportHeightmap`, `ExportLayer` | confirmed | [ULandscapeInfo (5.8 API)](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ULandscapeInfo) |
| 11 | `ULandscapeSubsystem::ChangeGridSize(ULandscapeInfo*, uint32)`, `IsGridBased()`, `BuildNanite`, `BuildAll`, `SaveModifiedLandscapes`; none carries a UFUNCTION specifier; no `unreal.LandscapeSubsystem` Python page (URL returns the docs 404) | confirmed (base class refined, see C8) | [ULandscapeSubsystem (5.8 API)](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ULandscapeSubsystem) |
| 12 | `FLandscapeImportHelper` statics (`ExtractCoordinates`, `GetHeightmapImportDescriptor`, `GetHeightmapImportData`, `ChooseBestComponentSizeForImport`, `TransformHeightmapImportData`, weightmap equivalents) in `LandscapeEditor/Public/LandscapeImportHelper.h`; `FLandscapeConfigHelper::ChangeGridSize / PartitionLandscape / FindOrAddLandscapeStreamingProxy` | confirmed | [FLandscapeImportHelper](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/LandscapeEditor/FLandscapeImportHelper), [FLandscapeConfigHelper](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Landscape/FLandscapeConfigHelper) |
| 13 | `FLandscapeImportLayerInfo` members and `(FName)` ctor; `FLandscapeTargetLayerSettings(ULandscapeLayerInfoObject*, const FString&)`; `ULandscapeLayerInfoObject::SetLayerName(const FName&, bool)`, `SetBlendMethod(ELandscapeTargetLayerBlendMethod, bool)` | confirmed (were listed as "to be confirmed by compiling"; now confirmed as declarations) | [FLandscapeImportLayerInfo](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Landscape/FLandscapeImportLayerInfo), [FLandscapeTargetLayerSettings](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/FLandscapeTargetLayerSettings), [ULandscapeLayerInfoObject](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ULandscapeLayerInfoObject) |
| 14 | Python: `landscape_import_heightmap_from_render_target(render_target, import_height_from_rg_channel=False, edit_layer_index=0) -> bool`, weightmap variant, export variant; RT formats RTF_RGBA16f / RTF_RGBA32f / RTF_RGBA8; RGBA16f precision warning; editor only | confirmed | [unreal.LandscapeProxy (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/LandscapeProxy?application_version=5.8), [Blueprint node (5.8)](https://dev.epicgames.com/documentation/unreal-engine/BlueprintAPI/Rendering/LandscapeImportHeightmapfromRend-) |
| 15 | Python enum `LandscapeTargetLayerBlendMethod`: `NONE` = 0, `FINAL_WEIGHT_BLENDING` = 1, `PREMULTIPLIED_ALPHA_BLENDING` = 2; `LandscapeLayerInfoObject.layer_name` Read-Only, `blend_method` / `blend_group` Read-Write | confirmed | [enum (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/LandscapeTargetLayerBlendMethod?application_version=5.8), [LandscapeLayerInfoObject (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/LandscapeLayerInfoObject?application_version=5.8) |
| 16 | Command lines `UnrealEditor-Cmd.exe "<proj>.uproject" -ExecutePythonScript="<script>"` and `-run=pythonscript -script="<script>"`; commandlet does not load a level; embedded Python 3.11.8; `init_unreal.py` in `Content/Python` | confirmed | [Scripting the editor using Python (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-the-unreal-editor-using-python) |
| 17 | `ELandscapeImportAlphamapType` Additive (0.5/0.3/0.2, engine-internal style) vs Layered (0.5/0.6/1.0) | confirmed | [API (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ELandscapeImportAlphamapType) |
| 18 | Edit layers: default limit 8 (Project Settings → Landscape → Max Number of Layers); enabled automatically; at least one required; base layer named "Layer"; Collapse All destructive | confirmed | [Landscape Edit Layers (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-edit-layers-in-unreal-engine) |
| 19 | Left-handed, Z up, +X forward, +Y right | confirmed | [Coordinate System and Spaces (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/coordinate-system-and-spaces-in-unreal-engine) |
| 20 | Heightmaps "up to 8192x8192" feasible; 4 bytes per vertex | confirmed | [Landscape Overview (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-overview) |
| 21 | One weightmap texture per 4 target layers; shared samplers on most RHIs; ES3.1 hard limit 16 samplers; layer names case-insensitive and unique; per-component shader compilation and grey-squares symptom | confirmed | [Landscape Materials (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-materials-in-unreal-engine), [Paint Mode (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-paint-mode-in-unreal-engine) |
| 22 | Nanite landscape: Enable Nanite → Build Data / Rebuild Data, or Build → Build Landscape; CVars `Landscape.RenderNanite` (1), `Landscape.Nanite.LiveRebuildOnModification` (0), `Landscape.Nanite.MultithreadedBuild` (1) | confirmed | [Using Nanite with Landscapes (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-nanite-with-landscapes-in-unreal-engine) |
| 23 | RVT material types and formats (BC1; 2×BC3; YCoCg BC3+BC5+BC1 with ~25 % more memory; World Height R16_UNORM normalised to the volume's Z range; Displacement BC4; Mask4 BC3); Num LODs 0 = one quad per component; no virtual-texture sampling in materials that fill an RVT | confirmed | [Runtime Virtual Texturing (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/runtime-virtual-texturing-in-unreal-engine) |
| 24 | Streaming VT needs power-of-two dimensions; UDIM naming `Base.1001.png`; UDIM tiles flipped vertically | confirmed | [Streaming Virtual Texturing (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/streaming-virtual-texturing-in-unreal-engine) |
| 25 | Water: `UWaterSplineMetadata` curves `Depth`, `RiverWidth` (from centre, each direction), `WaterVelocityScalar`, `AudioIntensity`; `SetRiverWidthAtSplineInputKey(float, float)` / `SetRiverDepthAtSplineInputKey(float, float)` BlueprintCallable; units undocumented | confirmed | [UWaterSplineMetadata](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/Water/UWaterSplineMetadata), [UWaterBodyRiverComponent](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/Water/UWaterBodyRiverComponent) |
| 26 | Gaea2Unreal: scale `(ScaleX*100/Resolution, ScaleY*100/Resolution, Height*100/512)`, location Z `Height*100/2`, `ExpandCentered`, `PremultipliedAlphaBlending`, the `Import(...)` call keyed by default `FGuid()`, centre-offset spawn, `StaticLightingLOD` formula, `AddTargetLayer` comment for 5.5, `ChangeGridSize` under `bIsGridBased && bIsWorldPartition`, `SrcIndex = SrcY * SizeX + SrcX`, `W_` / `definition` filename matching, layer 0 filled with 255, `FGaeaJson` fields; open-sourced 2025-03-11 under a "modified MIT" licence with 5.3/5.4/5.5 branches | confirmed line by line | [GaeaSubsystem.cpp](https://github.com/QuadSpinner/Gaea2Unreal/blob/main/src/Source/GaeaUEToolsEditor/Private/GaeaSubsystem.cpp), [GaeaSubsystem.h](https://github.com/QuadSpinner/Gaea2Unreal/blob/main/src/Source/GaeaUEToolsEditor/Public/GaeaSubsystem.h), [announcement](https://blog.quadspinner.com/gaea2unreal-now-open-source/) |
| 27 | World Partition mosaic bug: single 8129² 16-bit PNG, affected 5.7.0 / 5.7.4 / 5.8.0, fine in 5.5.4 / 5.6.1, workaround import in a non-WP level then convert; posted 2026-08-24; no Epic reply | confirmed as a single user report | [forum](https://forums.unrealengine.com/t/landscape-heightmap-import-duplicates-single-tile-in-world-partition-ue-5-7/2745963) |
| 28 | 5.8 weightmap-allocation regression (neighbour widening → D3D12 64-SRV limit → default material), posted 2026-08-12; Region Size 4 assertion in UE 5.5.4 (`LandscapeEditLayers.cpp` line 2121; 5 and 8 work), posted 2026-07-31; 5.8.3 fix for landscape-patch reinitialise; 5.8.2 fix for the crash editing landscape layers | confirmed as reported | [SRV thread](https://forums.unrealengine.com/t/landscape-edit-layers-5-8-regression-neighbor-input-area-widening-for-seam-fix-leaks-into-persisted-weightmaplayerallocations-inflating-srv-usage/2743253), [region-size thread](https://forums.unrealengine.com/t/ue-5-5-4-crashes-when-creating-landscape-with-world-partition-region-size-4-landscapeeditlayers-cpp-line-2121/2739797), hotfix threads above |
| 29 | Mesh Terrain is Experimental in 5.8 | confirmed | [Mesh Terrain (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/mesh-terrain-in-unreal-engine) |
| 30 | Tiled naming `<Base>_x<X>_y<Y>.<ext>`; UE 5.0.1 error text naming `_x0_y0.png`; tiles do not overlap (2x2 of 1009² read as 2018²); 11 × 1901 = 20911 and 82x82 / 164x164 component imports on UE 5.5.3; int32 limit ≈ 46340² | confirmed as third-party evidence only (no Epic doc states the rule) | [forum 2022](https://forums.unrealengine.com/t/trouble-importing-png-for-heightmap-file-ue5-0/558022), [forum 2023](https://forums.unrealengine.com/t/can-ue-5-import-a-tiled-landscape-properly/1394652), [unrealcode.net](https://www.unrealcode.net/NaniteLandscapeMaterials5/) |
| 31 | `.r16`/RAW little-endian | confirmed third-party only (MathWorks wording; a forum post quoting Epic's older docs); the 5.8 pages do not state byte order | [MathWorks](https://www.mathworks.com/help/aeroblks/create-landscape-in-unreal-editor.html) |
| 32 | No stock landscape-import builder/commandlet; builder list | confirmed (page lists HLODs, MiniMap, RenameDuplicate, ResaveActors, Foliage, NavigationData, SmartObjectCollection, PCG, and an RVT section whose sample command line repeats the PCG builder name — a docs copy error, so the RVT builder's `-Builder=` argument is not documented there) | [WP builder commandlet reference (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-builder-commandlet-reference) |
| 33 | PCG `PCGLandscapeDataProps`: `get_layer_weights`, `get_height_only`, `get_physical_material`, `sample_virtual_textures` | confirmed (also `get_actor_reference`, `get_component_coordinates`, `sample_virtual_texture_normals`) | [Python API (5.8)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/PCGLandscapeDataProps?application_version=5.8) |

### Worked example and derived numbers — recomputed

All recomputed independently with exact rational arithmetic; every figure in the report matches.

| Quantity | Report | Recomputed |
|---|---|---|
| 8129² vertices; `.r16` bytes; `.r8` bytes | 66,080,641; 132,161,282 (126.0 MiB); 66,080,641 (63.0 MiB) | 66,080,641; 132,161,282 (126.04 MiB); 63.02 MiB |
| Triangles at LOD0 | 132,128,768 | 2 × 8128² = 132,128,768 |
| ScaleX = 800000/8128 | 98.4251968503937 | 98.4251968503937; × 254 = 25,000 cm exactly |
| ScaleZ = 240000 × 128 / 65535 | 468.757152666514 | 468.75715266651406 |
| Step = ScaleZ/128 | 3.6621652552 cm | 3.662165255207 cm |
| ActorZ = −15000 + 256 × ScaleZ | 105001.831082628 | 105001.8310826276 |
| world_z(0), world_z(65535) | −15000, 225000 | −15000.0, 225000.0 (exact) |
| Sea level code | 4095.94 → 4096 | 4095.9375 → 4096 |
| Epic `/512` variant | ScaleZ 468.75, top 224996.34 | 468.75, 224996.3379 |
| Slope quantum | 2.13° | atan(3.66217/98.4252) = 2.1309° |
| 8129 − … factorisation | 11 × 739 | 11 × 739 (739 prime) |
| Layout chooser on 8129 | [{127, 2, 32, 1024}] | same; also checked 4033, 2017, 1009, 505, 253, 127, 4081, 8161, 16321 against Epic's table |
| Cap table | 2017 / 4033 / 4065 / 8129 / 8161 / 16321 | same |
| RGBA32f 8129² RT | ≈ 1.06 GB | 1,057,290,256 bytes (1.057 GB = 0.985 GiB) |
| 4 bytes/vertex | ≈ 264 MB | 264.3 MB |
| BC7 8192² / 16384² | 64 MB / 256 MB | 64 MiB / 256 MiB (base mip) |
| m/texel over 8 km | 0.977 / 0.488 | 0.9766 / 0.4883 |
| World Partition table | 256 / 64 / 16 proxies; 500 m / 1 km / 2 km | same |
| `StaticLightingLOD` for 8129² | (formula only) | 2 |

### Corrected (old → new)

| # | Where | Old | New | Source |
|---|---|---|---|---|
| C1 | (b) height mapping | Landscape Patch page quoted as saying native packed height is "the same convention as values in landscape actors" | That phrase is not on the 5.8 page; only the numeric range is. Phrase re-tagged as recalled, not quoted | [Landscape Patch System](https://dev.epicgames.com/documentation/unreal-engine/landscape-patch-system) (re-read twice) |
| C2 | (d) blend table | Advanced Weight Blending: "normalised at each edit layer; needs a Weight Blend Group"; name mapping "inferred" | Sum is bounded to at most 255, not forced to 255; blend group is optional (empty name = one ordinary group); mapping Advanced = `PremultipliedAlphaBlending` now confirmed | [Paint Mode](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-paint-mode-in-unreal-engine), [ULandscapeLayerInfoObject API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ULandscapeLayerInfoObject) |
| C3 | (d) sum-to-one | "the engine wants per-texel weights that total 255" for all weight-blended layers | True only for legacy Final Weight Blending; Advanced only caps at 255. Export recommendation (sum exactly 255) unchanged and valid for both | Paint Mode page |
| C4 | (d) concepts | "without layer infos a layered material renders black", presented as a docs fact | Not on the 5.8 Paint Mode or Landscape Materials pages (literal search for "black": one hit, about layers removed from the material). Docs fact is: every layer needs its own layer info. The black-without-layer-infos behaviour is re-tagged RECALLED, UNVERIFIED | Paint Mode page, Landscape Materials page |
| C5 | (d) sum-to-one | Zero-weight texels "render black with Height-Blend materials" attributed to the Materials page | The page's stated cause of black spots is all painted layers having height input 0 under LB Height Blend; zero-coverage black is re-tagged as derived | [Landscape Materials](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-materials-in-unreal-engine) |
| C6 | (c) filename hygiene | Stated as fact that "the same tile detector misfires on ordinary names", tagged VERIFIED third-party | Rewritten as anecdotal user reports with the mechanism UNVERIFIED: the "read as tiles" explanation is one poster's guess (the `Terrain_1.png` / `Terrain_1_try2.png` example is genuinely in thread 1 and is kept, attributed). Letters-only filenames kept as a harmless precaution | [thread 1](https://forums.unrealengine.com/t/trouble-importing-png-for-heightmap-file-ue5-0/558022), [thread 2](https://forums.unrealengine.com/t/ue5-does-not-let-me-import-a-heightmap-please-help/604839) |
| C7 | (f) Nanite | "roughly doubling streamed data" in quotation marks; LOD Index / Position Precision / Max Edge Length Factor attributed to the Nanite doc page | Not a verbatim quote (page says twice the data is streamed); those three settings are not on the doc page — they are confirmed only as Python properties | [Nanite landscapes](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-nanite-with-landscapes-in-unreal-engine), [unreal.LandscapeProxy](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/LandscapeProxy?application_version=5.8) |
| C8 | (e) signatures | `ULandscapeSubsystem (UWorldSubsystem)` | Base class is `UTickableWorldSubsystem` (which derives from `UWorldSubsystem`); `UCLASS(MinimalAPI)` | [ULandscapeSubsystem API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Landscape/ULandscapeSubsystem) |
| C9 | (e) Python inventory | `enable_nanite` read-only "seen on the 5.7 page" | Re-read on the 5.8 page: Read-Only in its property entry, Read-Write in the page's summary list (self-contradictory) → treat as not settable until tested | unreal.LandscapeProxy (5.8) |
| C10 | §0 | 5.8.1 "late July 2026" | 2026-07-28 | [5.8.1 thread](https://forums.unrealengine.com/t/5-8-1-hotfix-released/2738864) |
| C11 | (g) actor origin | MathWorks "64-vertex landscape … confirms" | Clarified: 65x65 heightmap → 64x64 overall resolution, Location/Scale set on the actor after import; supports corner origin of the actor, says nothing about the New Landscape panel field | MathWorks page |
| C12 | (d) material caveat + known-issues table | UE-386355 "will be addressed in 5.8.3" | Added timeline (closed as fixed → user says not fixed in 5.8.2 → reopened 2026-08-27 → "5.8.3" on 2026-09-07) and that the 5.8.3 notes do not list it → fix unconfirmed. Added the user-reported workaround of switching to legacy Final Weight Blending, and changed the sidecar `blend` field from `weight`/`none` to `none`/`final`/`advanced` so the default is switchable | [forum thread](https://forums.unrealengine.com/t/ue5-8-material-landscape-layer-blend-broken/2731518), 5.8.3 thread |
| C13 | (d) layers per component | "Each group of 4 target layers adds a weightmap texture" in quotation marks | Paraphrase, not verbatim; meaning unchanged | Landscape Materials page |
| C14 | "What could not be verified" item 1 | Implied the engine matcher is the regex `_x(\d+)_y(\d+)` | That regex was shorthand, not engine text; added an explicit emit rule (lowercase, no padding, non-negative) | — (source private) |

Additions that are not corrections: tooltip texts and full clamp metadata for the two World Partition properties, with a warning that the 5.8 import doc page words Grid Size the other way round; verified identifiers `LandscapeDataAccess::MaxValue / MidValue / GetLocalHeight / GetTexHeight`; extra overloads on the 5.8 API pages and the advice to pass every argument explicitly; `editor_apply_spline` defaults; the Water plugin's `Experimental` path in 5.8; a note that nothing readable says Gaea2Unreal `main` builds on 5.7/5.8; `bEnableNanite` is not listed on the 5.8 `ALandscapeProxy` API page.

### Unverifiable (no primary source found — keep the tags, test before hard-coding)

| # | Claim | Why |
|---|---|---|
| U1 | Values of `LANDSCAPE_ZSCALE` (1/128), `MidValue` (32768), `MaxValue` (65535) and the body of `GetLocalHeight` | Engine source is private; the API reference lists the identifiers without values. The observable mapping is pinned by two Epic doc statements (rows 4 and 5), which is what the formulas rely on |
| U2 | Defaults World Partition Grid Size = 2 and Region Size = 16 | API page prints no defaults; no doc page states them |
| U3 | Exact tile-name matching rule (regex or not, case, padding, negatives); that weightmap tiles follow the same pattern; tile Y order; Flip Y Axis semantics for single files | Not documented; source private |
| U4 | New Landscape panel "Location" is the landscape centre | 5.8 Creating Landscapes page only says it is where the landscape is created; evidence is Gaea2Unreal's replica of the editor code plus recollection |
| U5 | Image-to-landscape orientation (row 0 = min Y, column 0 = min X, no mirroring) | Not in Epic's docs; inferred from Gaea2Unreal's row-major indexing |
| U6 | `.raw` sidecar key spelling (`bbp` as printed vs `bpp`) | Only the doc page's example is available |
| U7 | Render-target import channel packing and required RT size | Blueprint/Python pages give formats only |
| U8 | Whether `ALandscape::Import` with an empty `InImportLayers` creates the default edit layer; whether the C++ path avoids the World Partition mosaic bug; whether commandlet mode can complete an import; whether the region-by-region path is taken above the region size | Behavioural; needs a 5.8.3 run |
| U9 | Setting Nanite on from code (`bEnableNanite` via reflection) | Property not listed on the 5.8 API page; no setter documented |
| U10 | Mechanism behind the "proper pattern" filename errors, and whether any of it reproduces on 5.8 | Anecdotal forum reports only |
| U11 | UE-386355 (Landscape Layer Blend) actually fixed in 5.8.3; UE-241268 details | 5.8.3 notes silent; tracker page not readable |
| U12 | Landscape section of the full 5.8 release notes (API changes, deprecations, new script exposure) | The release-notes page is about 357,000 characters as fetched and ends before any Landscape section; four chunks were read and none contains one. API-change statements in this report therefore rest on the API reference pages and the hotfix threads, not on the release notes |
| U13 | Texture limits: 16384 D3D limit as it applies to UE 5.8 imports, 8192 "supported non-VT maximum", default Auto Virtual Texturing Size, maximum VT/UDIM import size; "any texture that must mip/stream must be power-of-two" for regular (non-VT) textures in 5.8 | Not re-checked against a 5.8 primary source; only the Streaming VT power-of-two rule is confirmed. Exporting power-of-two companion textures is safe either way |
| U14 | World Creator bridge file conventions and size guidance; Houdini Engine default grid size 4; Gaea `H_*` heightmap naming; Datasmith landscape import; UE's DirectX-style normal-map convention | Not re-fetched (World Creator page deliberately not re-opened given the embedded agent-directed text reported in §0; Houdini default seen only in a search snippet) |
| U15 | Water spline width/depth units; best `Affects Landscape` setting for pre-eroded terrain | Undocumented; needs an in-engine test |
