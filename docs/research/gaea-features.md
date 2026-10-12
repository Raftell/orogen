# Gaea 2.x feature inventory (and what rivals do better) - input for Orogen

Research date: 2026-10-12. Author: research subagent. Scope: QuadSpinner Gaea 2.x (current production build **2.3.1.0, released 2026-09-24**), with notes on Gaea 3 Early Access and on World Creator, World Machine, Houdini heightfields and Instant Terra.

## 0. How to read this report

### 0.1 Source tiers and confidence tags

| Tag | Meaning |
|---|---|
| **[P]** | Primary source: QuadSpinner docs/site/blog, the public docs repo, the Gaea2Unreal source code, vendor pages of rivals. |
| **[P-data]** | Machine-readable node definitions in the public docs repo (`source/.flubs/*.json` = parameter name/type/enum values, `source/.meta/*.json` = family, toolbox, shortcode, flags). Names, types and enum values are authoritative. Several *descriptions* in these files read as auto-generated and should not be trusted for behaviour. |
| **[3P]** | Third-party reverse engineering (community MCP servers that read/write `.terrain` files). Good for port names and file format; not vendor-confirmed. |
| **[U]** | User reports (forum posts, GitHub issues). Evidence of pain points, not of root cause. |
| **UNVERIFIED** | I could not confirm it. Do not hard-code. |
| **[OROGEN]** | Our own design proposal or inference. Not a statement about Gaea. |

Primary repositories used (cite paths below relative to these):

- Docs repo: https://github.com/QuadSpinner/Gaea2-Docs (branch `master`, last push 2026-09-25). Published at https://docs.gaea.app. A page `source/X/Y.md` is published as `https://docs.gaea.app/X/Y.html`.
- Gaea2Unreal: https://github.com/QuadSpinner/Gaea2Unreal (branch `main`, last push 2026-01-02, plugin `VersionName 2.2.0.7`, `EngineVersion 5.7.0`).
- Editions/prices: https://quadspinner.com/Order . Download/changelog: https://quadspinner.com/download . FAQ: https://quadspinner.com/FAQ . Gaea 3: https://quadspinner.com/gaea3 .
- Third-party: https://github.com/yushimatenjin/gaea-mcp (`src/node-types.ts`, ports scanned from the 59 example files shipped with Gaea 2.0) and https://github.com/aguai2018/gaea-mcp (`skill/gaea-terrain/reference/*.md`, hand-verified against Gaea 2.3.0.1).

### 0.2 Version timeline (all [P])

| Date | Release | Notes |
|---|---|---|
| 2024-08-01 | Gaea 2.0 | Full rewrite; free Community Edition. https://blog.quadspinner.com/gaea-2-0-now-available/ |
| 2025-03-11 | Gaea2Unreal open-sourced | https://blog.quadspinner.com/gaea2unreal-now-open-source/ |
| 2025-07-14 | Gaea 2.2 | Erosion2 algorithm upgrade (orographic controls, precipitation mask), Glacier, Snowfield, IceFloe, Scree, Shrubs, Distress, BlobRemover, Shape, Var, Heal; CLI `--silent`, `buildpath`, SwarmHost. `source/history/gaea-2.2/2.2.0.0.md` |
| 2025-12-24 | Gaea 2.2.7 | Draw node, cache and async improvements. |
| 2026-05-20 | Gaea 2.3 | Macros, Lake "Simple" mode, 2D viewport gizmos, ColorThreshold, 16K baking, Erosion2 "Extra Deposits" and "No Erosion". https://blog.quadspinner.com/gaea-2-3-now-available/ |
| 2026-08-27 | Gaea 3 Early Access starts | Pre-order customers only. https://talk.gaea.app/t/early-access-is-here/1860 |
| 2026-09-24 | Gaea 2.3.1.0 | Bug-fix build; current "Production Ready". https://quadspinner.com/download |
| est. 2026-10 | Gaea 3.0 (estimate on vendor page) | World space, vector tools, sand solver, new renderer, USD, SDK. Gaea 2 maintained to end of 2027. https://quadspinner.com/gaea3 |

### 0.3 Editions (Gaea 2.3, https://quadspinner.com/Order, read 2026-10-12) [P]

| | Community | Indie | Professional | Enterprise |
|---|---|---|---|---|
| Price (perpetual) | free | $99 | $199 | $299 |
| Commercial use | no | yes, < $100K gross/yr | yes, < $1M/yr | > $1M/yr |
| Max single build | 1024 (create/view up to 4096) | 8192 | 16384 (flagged experimental) | 16384 |
| Split build into tiles | no | yes | yes | yes |
| Tiled world builds | no | no | up to 262,144 x 262,144 | same |
| Regions | no | no | yes | yes |
| Macros | no | use only | create + use | create + use |
| Variables, expressions, automation/batch | no | no | yes | yes |
| Gaea2Unreal bridge | no | yes | yes | yes |
| Gaea2Houdini | no | no | yes | yes |

Other hard constraints [P] (https://quadspinner.com/FAQ): Windows only (Linux "being considered", no Mac); CPU must support AVX2; GPU compute needs CUDA 12.5+ (NVIDIA) or HIP 6.0+ (AMD) and is optional; licence must reach the internet at least once every 28 days (offline licence only for Enterprise at extra cost); purchases are non-refundable.

---

## (a) Node inventory

**Count:** 182 documented nodes in 9 toolboxes plus Macro (Gaea 2.3-era docs repo; marketing says "180+"). Counted from `source/.meta/*.json` [P-data]: Primitive 23, Terrain 14, Modify 40, Surface 21, Simulate 25, Derive 14, Colorize 13, Output 12, Utility 20.

**Conventions used in the tables**

- Parameter list = exact names from `source/.flubs/<Node>.json` [P-data]. Types: `f` float, `i` int, `b` bool, `f2` two-float range, `E{...}` enum with its values, `cmd` button. `[Group]` = UI group heading.
- **Numeric ranges and defaults are not published anywhere in the docs or the docs repo. Treat every Gaea range/default as UNVERIFIED unless a number is given.**
- Ports: every node has `In` (primary input; optional on generators) and `Out`. Extra ports listed are from [3P] unless marked [P]. Most processors also accept a `Mask` input (documented generally in `source/using/getting-started/basics/masks.md` [P]).
- `bake` = `RequiresBaking` flag in `.meta` [P-data]. Docs say such nodes "must be baked when executing Hybrid or Tiled builds" [U quoting docs, https://talk.gaea.app/t/tile-build-seams-showing-up-regardless-of-blend-percentage/536] - i.e. the node is not tile-safe.
- `usage` = the undocumented `Usage` integer in `.meta` [P-data]. It looks like a popularity count (Erosion2 = 2606, Perlin = 1794, Combine = 1222). Its definition is UNVERIFIED; I use it only as a rough priority signal.
- Shortcode in backticks (type in graph search; `m,e2,e2,tb,sm` chains nodes [P] `source/ui/graph/basic-workflow/graph-conveniences.md`).

`.meta` also carries a `Classification` per node: Generator, Processor, Mask, Colorizer, Export, Complex; and flags `IsSoftData` (set on Derive/Colorize/Render nodes; meaning UNVERIFIED - probably "cheap derived data, not baked"), `UsesAccumulation` + `AccumulationType` (Snow, Water/Shore, River, Debris, Trees), `HasCustomColorization`, `HasCustomUnderlay`, `CanCreatePorts` + `MaxPorts`, `OrderedPorts`.

### a.1 Primitive (23)

| Node | Purpose | Key parameters | Notes / ports |
|---|---|---|---|
| File `f` (usage 362, bake) | Load image/data as height or colour | File:s, Relative Path:b, Is RGB:b, Enforce Linear Gamma:b, Allow Unclamped:b, Crop to Square:b, [Caching] Purge Cache:cmd, Never Cache:b | Reads EXR, TIFF, PNG, RAW/R16/R32, GRAW, JPG, WebP, BMP, HDR, PFM, PSD, SVG [P] `.../technical-information/file-formats.md`. Docs also mention scale modes Raw / Normalized / Mapped. |
| Object `o` (bake) | Import mesh and rasterise to heightfield | Mesh:s, Relative Path:b, [Position] Drop to Floor:b, Offset X/Y/Z:f, [Scale] Scale:f, [Rotation] Pitch/Yaw/Roll:f, [Quality] Antialiasing:b | OBJ, FBX, DAE, glTF/GLB |
| TileInput `til` (bake) | Read a tile set 1:1 into a tiled build, or stitched | File:s, Relative Path:b, Enforce Linear Gamma:b, Flip Y:b, Purge Cache:cmd, Tile Info:s | |
| Constant `k` (usage 151, bake) | Flat height or colour | Output:E{Height,Color}, Height:f, Color | Height can be typed in metres (e.g. `500m`) [P] |
| Cracks `ck` (bake) | Large crack pattern | Style:E{Normal,Hard,Classic}, Octaves:i, Scale:f, Depth:f, Jitter:f, Warp Strength:f, Warp Size:f, Seed:i, Scale X/Y:f | |
| Draw `vm` (usage 203, bake) | Hand-painted strokes turned into mountain ranges / masks | Soften:f, Height:f, Open Painter:cmd, Stroke Data:s | The only freehand tool in Gaea 2. Painter window; stroke data stored in the node. |
| Gabor `g` (bake) | Anisotropic Gabor noise | Size:f, Entropy:f, Anisotropy:f, Azimuth:f, Gain:f, Seed:i | In: Modulation [3P] |
| LineNoise `ln` (bake) | Line sets for layered ridges | Bucket Size:E{X1..X4}, Style:E{Sharp,Soft,Flat,Vague}, Clamp:f, Direction:i, Seed:i | |
| Noise `kn` (bake) | Per-pixel noise | Noise Type:E{Random,Perlin,Gaussian,Fixed,Micro}, Height:f, Density:f, Relative Density:b, Blend Mode:E{Add,Multiply,Subtract}, Seed:i | |
| Pattern | Lines / engraving / grid / dots | Size:f, Dot Size:f, Spacing:f, Steps:i, Direction:i, Type:E{Lines,Engraving,Grid,Dots}, Pixel Size:i | |
| **Perlin `p`** (usage 1794, bake) | Core fractal noise | [Noise] Type:E{FBM,Ridged,Billowy}, Scale:f, Octaves:i, Gain:f, Height:f, Seed:i; [Warp] Type:E{None,Simple,Complex}, Frequency:f, Amplitude:f, Octaves:i; [Transform] Scale X/Y:f, X:f, Y:f | Second most used node |
| Shape `s` (bake) | Circle / rectangle / n-gon primitive | Geometry:E{Circle,Rectangle}, Sides:i, Uniform:b, Scale:f, Scale X/Y:f, Thickness:f, Height:f, X:f, Y:f | |
| Voronoi `v` (usage 77, bake) | Cellular pattern | [Noise] Scale:f, Jitter:f, Function:E{Euclidean,Manhattan}, Form:E{C,N,R,P,A,S,M,D}, Gain:f, Clamp:f, Seed:i; [Warp] same as Perlin; [Transform] same | 2D gizmo in 2.3 |
| Cellular `ll` (bake) | Extended cellular noise | Size:f, Density:i, Jitter:f, Metric Morph:f, Distance Metric:E{Euclidian_Manhattan,Euclidian_Chebyshev,Minkowski}, Coordinate Axes Jitter:f, CAJ Clustering:f, Anisotropy:f, Distance Function:E{Hash,DistanceInv,Distance2Inv,DistanceDiff,DistanceToEdge}, Seed:i | |
| Cellular3D `c3` (usage 129, bake) | Volumetric-looking cells (rock blocks) | Size:f, Gap:f, Jitter X/Y/Z:f, Scale X/Y/Z:f, Seed:i, Normalize Input:b | In: Gap; Out: Hashmap [3P] |
| DotNoise `do` (bake) | Speckle noise | Style:E{Dot,Square}, Iterations:i, Multiplier:f, Size:f2, Height:f, Blend Mode:E{None,Blend,Add,Subtract,Difference,Multiply,Screen,Max,Min}, Seed:i | |
| DriftNoise `dr` (bake) | Overlapping shelves (cliffs, cracks) | Passes:i, Chaos:f, Scale Large/Small:f, Turbulence Large/Small:f, Wind Direction Large/Small:f, Seed:i, Overlap Shapes:b | |
| MultiFractal `mf` (bake) | Rich multi-noise | [Fractal] Noise Type:E{FBM,Billowy,Ridged}, Auto Octaves:b, Octaves:i, Scale:f, Relative Feature Scale:f, Roughness:f, Edge smoothing:f, Seed:i; [Variation] Type:E{SecondaryFractal,SelfModulation}, Variation:f, Smoothness:f, Contrast:f, Damping:f, Bias:f; [Position] Rotation:f, Anisotropy:f, Offset X/Y:f; [Warp] Perturb:E{None,Simple,Complex}, Relative Size:f, Strength:f, Complexity:i, Roughness:f, Attenuation:f, Iterations:i, Relative Anisotropy:f | |
| WaveShine `ws` (bake) | Animated water ripples (frame-based) | [Global] Frame:i, Octaves:i, Seed:i; [Ripples] Animation Speed:f, Size:f, Amplitude:f, Direction:f, Speed:f; [Wind Patch] Intensity:f, Animation Speed:f, Size:f, Contrast:f; [Lighting] Brightness:f, Sun Azimuth:f, Sun Elevation:f | |
| Cone `con` (bake) | Conical gradient | Scale:f, Height:f, X:f, Y:f | |
| Hemisphere `do` (bake) | Dome gradient | Scale:f, Height:f, X:f, Y:f, Flatten:b | |
| LinearGradient `lg` (usage 96, bake) | Linear ramp | Scale:f, Direction:i, Edge Behavior:E{Clip,Repeat,Mirror} | |
| RadialGradient `rg` (usage 383, bake) | Radial ramp | Scale:f, Height:f, X:f, Y:f | Very common as island/mountain base |

### a.2 Terrain (14) - all Generators, all `bake`

| Node | Purpose | Key parameters |
|---|---|---|
| **Mountain `m`** (usage 735) | Single mountain from modulated Voronoi | Scale:f, Height:f, Style:E{Basic,Eroded,Old,Alpine,Strata}, Bulk:E{Low,Medium,High}, Reduce Details:b, Seed:i, X:f, Y:f |
| MountainRange `mr` | Full range tuned for erosion | Scale:f, Height:f, Style:E{Basic,Eroded,Stratified,Alpine}, Bulk:E{Low,Medium,High}, Seed:i |
| MountainSide `ms` (usage 109) | One slope or peak | Scale:f, Detail:f, Type:E{Slope,Peak}, Style:E{Basic,Eroded,Old,Alpine,Strata}, Direction:i, Seed:i |
| **Ridge `ri`** (usage 436) | Rugged ridgeline with fractures | Scale:f, Height:f, Definition:f, Seed:i, [Advanced] Scale X/Y:f |
| Slump `um` (usage 297) | Smooth hills with collapsed areas | Scale:f, Style:E{A,B,C,D}, Seed:i |
| Rugged `gg` | Rocky base | Style:E{A,B,C,D,E}, Scale:f, Seed:i |
| Plates `pl` | Flat plates between Perlin shapes | Scale:f, Range:f, Falloff:f, Warp:f, Angle:f, Seed:i |
| Uplift | Tectonic-style raised masses | Passes:i, Scale:f, Height:f, Octaves:i, Direction:i, Jitter:f, Seed:i |
| Canyon `ny` (usage 67) | Fast drainage-based canyon | [Structure] Style:E{Classic,Eroded,Eroded2,Strata,Both}, Scale:f, Slot:f, Valley:f, Surrounding:f, Depth:f, Structual Warp:f, Seed:i; [Formation] Detail Warp:f, Alternate Style:b. Out: Depth [3P] |
| CraterField `cf` | Field of craters | Scale:f, Depth:f, Density:f, Seed:i, X:f, Y:f |
| Crater `cra` | One crater (gizmo) | Style:E{New,Classic}, Scale:f, Formation:f, Height:f, Rim:E{Soft,Sharp}, Shape:f, X:f, Y:f, Seed:i |
| DuneSea `du` | Dune field base | Scale:f, Dune Type:E{A,B,C,D}, Chaos:E{None,Low,Medium,High}, Undulation:E{None,Low,Medium,High}, Direction:i, Height:f, Softness:i, Sharpness:f, Seed:i |
| Island `is` | Landmass base | Size:f, Chaos:f, Seed:i |
| Volcano `vo` | Cone with crater | Scale:f, Height:f, Mouth:f, Bulk:f, Surface:E{Smooth,Eroded}, X:f, Y:f, Seed:i |

### a.3 Modify (40)

| Node | Purpose | Key parameters / extra ports |
|---|---|---|
| **Adjust `fx`** (usage 500) | Swiss-army value adjust | Multiply:f, Shaper:f, Clamp:f2, Clip:f2, Drop:b, Autolevel:b, Equalize:b, Strong:b, Invert:b. In: Mask |
| Autolevel `lv` (bake) | Remap min..max to 0..1 | none. Not tile-safe (per-tile min/max). |
| Clamp `cl` | Squash / clip / extend heights | Mode:E{Standard,Normalized}, Value:f2, Drop:b |
| Clip `ci` | Cut at thresholds | Min:f, Max:f, Auto Clip:b |
| Denoise `dn` | Remove spikes | Type:E{OnePass,TwoPass,Pixels}, Amount:f, Passes:i |
| Equalize `eq` | Histogram equalise | Factor:f |
| Extend `xt` | Stretch elevation beyond limits | Value:f2 |
| Flip `fp` | Mirror | Type:E{X,Y,XY} |
| Match | Match height range or histogram to a reference | Mode:E{Height,Histogram}. In: Reference [P] `.../helpful-info/match-height.md` |
| Sharpen `sx` | Edge / frequency sharpen | Method:E{Edge,Frequency}, Amount:f |
| Threshold `th` | Binary-ish mask at a level | Level:f |
| Transpose `tx` (usage 75) | Transfer surface character of a reference terrain onto the input, preserving its volume; also Embed and Insert | Mode:E{Transpose,Embed,Insert}, Amount:f, Extend:f, Flatten:f, Threshold:f, Boundary:f. In: Reference (required), Mask [3P] |
| Blur `b` (usage 74) | Gaussian-style blur (also colour since 2.2) | Radius:f |
| Median `md` (usage 62) | Edge-preserving despeckle | Mode:E{Classic,Advanced,Advanced2}, Strength:E{X1,X2,X4,X8}, Horizontal:i, Vertical:i, Iterations:i, Quality:E{Low,Medium,High} |
| SlopeBlur `sb` | Blur along a guide's slope direction | Intensity:f, Iterations:i, Direction:f, Asymmetry:f, Normalized:b, Window:E{Bell,Box}, Quality:E{Low,Medium,High,Ultra}, Antialiasing:E{Off,x4,x16}. In: Guide (required) [3P] |
| VariableBlur `vb` | Blur with per-pixel radius | Radius:f (+ mask input) |
| Origami `or` | Diagonal multifold | Amount:f, Seed:i |
| Pixelate `px` | Blocky version | Size:f, Autosize:b, Antialias:b |
| Swirl `swi` | Vortex warp | Size:f, X:f, Y:f |
| Whorl `wh` | Many vortices | Type:E{Stretch,Spin}, Whorls:i, Power:f, Seed:i |
| Curve `cu` | Height remap by spline | Curve Spline (list), Mode:E{Absolute,Relative}, Fit Curve:cmd |
| Deflate `df` | Pull features inward | Amount:f |
| Filter `fl` | Frequency-domain EQ filter | Mode:E{LowPass,HighPass,LowShelf,HighShelf,BandPass,Notch,Bell}, Frequency:f, Gain:f, Q:f, Keep DC:b |
| Fold `fo` | Slants / folds (early in graph) | Waveform:E{Sine,Triangle,Sawtooth}, Folds:f, Symmetric:b. In: Folds [3P] |
| GraphicEQ `gq` | 7-band height-profile EQ | Band 1..Band 7:f. In: Mask |
| Recurve `rc` | Curvature-based inflate / deflate | Power:f, Scale:f, Iterations:i, Style:E{Inward,Outward} |
| Shaper `sp` | Bulk up / down, optional detail keep | Shape:f, Local Effect:b, Local Area:f, Maintain Fine Details:b, Detail Size:f |
| SoftClip `sc` | Soft compression above/below threshold | Clip Mode:E{AboveThreshold,BelowThreshold}, Threshold:f, Softness:f, Clipping:f |
| ThermalShaper `ts` | Fast GPU approximation of thermal erosion concavity | Influence:f, Shape:f, Scale:f, Microdetail Preservation:f. In: Intensity [3P] |
| Meshify `ms` | Faceted low-poly look | Vertices:f, Seed:i, Detail Sensitivity:f |
| Aperture `ap` | Morphological dilate/erode with shaped kernel | Mode:E{Dilation,Erosion}, Size:f, Shape:E{Disk,Polygon,Asterisk,Line,Corner}, Vertices Count:i, Corner Angle:i, Direction:i, Antialiased:b |
| Dilate `di` | Expand pixels | Size:f, Shape:f, Iterations:i, Kernel:E{Cross,Rectangle,Line,LineVertical}, Invert:b |
| Distance `rt` (usage 66) | Distance field from mask boundary | Method:E{Classic,RT}, Mode:E{Asterisk,Pyramid}, Directions:i, Skew:f, Angle:f, Angular Jitter:f, Falloff:f, Threshold:f, Falloff Jitter:f, [Options] Invert Input:b, Invert Output:b, Multiply by Input:b, Seed:i |
| Transform `t` (usage 117, bake) | Move / rotate / scale, with blend onto base | [Position] Offset X/Y/Z:f (range -1..+1 since 2.2), [Scale] Uniform:b, Scale:f, Scale X/Y:f, [Rotation] Angle:f, [Settings] Blend Mode:E{None,Blend,Add,Subtract,Difference,Multiply,Screen,Max,Min}, Edges:E{None,Thin,Wide,Soft}, Quality:E{Draft,Medium,High}. In: Base [3P]. Scale accepts metres. |
| Transform3D `t3` | Full 3D rotation of the heightfield | Drop to Floor:b, Offset X/Y/Z:f, Scale:f, Pitch/Yaw/Roll:f, Antialiasing:b |
| BlobRemover `blo` | Remove small fragments | Range:f, Connectivity:i, Enforce Quantization:b, Quantization:i |
| Heal `hl` | Rebuild low-bit-depth / damaged data | Reconstruction:f, Passes:i |
| DirectionalWarp `dw` | Uniform directional warp | Strength:f, Direction:f, Edge Behaviour:E{Edge,Mirror}. In: Custom [3P] |
| SlopeWarp `sw` (usage 64) | Warp along guide's slopes | Intensity:f, Iterations:i, Direction:f, Normalized:b, Quality, Antialiasing. In: Guide (required) [3P] |
| **Warp `w`** (usage 129) | Noise domain warp | Size:f, Strength:f, Z Scale:f, Warp Source:E{PerlinFBM,VoronoiR,VoronoiP,VoronoiA,VoronoiS,VoronoiM,VoronoiD}, Perturbation:f, Complexity:i, Roughness:f, Normalized:b, Edge Behaviour:E{Edge,Mirror}, Modulation:f, Modulation Direction:f, Seed:i, [Iterative] Iterations:i, Mode:E{Bitmap,VectorField,VectorFieldIntegral}. In: Modulator [3P] |

### a.4 Surface (21)

Design intent [P] (`source/using/using-gaea/crafting-the-surface/surface-nodes.md`): add or remove shapes at the surface while preserving overall volume and silhouette.

| Node | Purpose | Key parameters / extra ports |
|---|---|---|
| Contours `cn` | Map contour lines (mask) | Count:i, Subdivision:i, Accuracy:f, Line Intensity:f, Sub Intensity:f, Line Thickness:i |
| Grid `gr` (bake) | Grid pattern | Subdivision:i, Line Intensity:f, Sub Intensity:f, Line Thickness:i |
| Craggy `cg` (usage 123, bake) | Fragmented rock field | Size:f, Depth:f, Shape:f, Seed:i |
| **Outcrops `oc`** (usage 207) | Large rugged rock formations | Variations:i, Strata:f, Density:f, Shape:f, Chipped:b, Seed:i, [Variation Range] Size:f2, Height:f2, Rotation:f2 |
| RockNoise `rn` (bake) | Rock field with size variation | Size:f2, Variety:i, Octaves:i, Seed:i, Style:E{A,B,C} |
| Rockscape `rs` (bake) | Broad rocky formations | Size:f, Erosion:f, Breakage:f, Roughness:f, Jitter:f, Clusters:E{Off,Large,Small,Shattered}, Relief:E{Off,Sharp,Soft,Stratified}, Seed:i |
| Bomber `bo` (bake, up to 10 ports) | Stamp input heightfields randomly | Iterations:i, Multiplier:f, Size:f2, Size Distribution:f, Rotation:f2, Proportional:b, Variable Height:b, Height:f2, Distribution:E{Random,Grid}, Jitter:f, Seed:i, Fade Edges:b, Blend Mode, Quality:E{Draft,Medium,High} |
| Pockmarks `pck` | Scattered pits | Size:f2, Scale:f, Depth:f, Density:f, Multiplier:f, Invert:b, Seed:i |
| Stones `on` (bake) | Small superficial stones (random, not physical) | Scale:f, Height:f, Density:f, Seed:i |
| Bulbous `bu` | Inflate shapes respecting boundaries | Scale:f, Jitter:f |
| Shatter `tt` | Fracture simple shapes | Shatters:i, Size:f, Coverage:f, Seed:i |
| Shear `sh` | Rock shearing exposing strata | Strength:f, Seed:i |
| Distress `dst` | Superficial wear | Octaves:i, Scale:f, Depth:f, Influence:f, Formation:f, Scale X/Y:f, Seed:i |
| GroundTexture `gt` (usage 81) | Fine realism detail | Method:E{Harsh,Rocky,Rough}, Strength:f, Coverage:f, Density:f. In: Mask |
| Roughen `rog` | Fine roughness | Width:f, Depth:f, Oriented:b, Quality:E{Quarter,Third,Half,Full} |
| Sand `sd` (bake) | Small / medium sand ripples, dunes | Scale:f, Direction:i, Chaos:f, Softness:f, Height:f, Warp by Terrain:b, Seed:i |
| FractalTerraces `ft` (usage 58) | Low-level fractal stratification with tilt | Spacing:f, Octaves:i, Intensity:f, Shape:f, Seed:i, [Advanced] Shapes separation:b, Macro octaves:i, Micro shape:f, Character:f, Thickness uniformity:f, Hardness uniformity:f, Strata details:f, Protect Range:b, [Tilt] Apply Tilt:b, Tilt Amount:f, Direction:i, Tilt Seed:i, Warp Amount:f, Warp Size:f, Warp Style:E{A,B,C,D}. In: Modulation; Out: Layers [3P] |
| **Sandstone `ss`** (usage 416) | Multi-pass layered rock with chipping | Passes:i, Iterations:i, Spacing:f, Intensity:f, Convexity:f, Tilt:f, Direction:i, Chaos:f, Seed:i, Chipped:b, Chipping:f. Out: Layers [3P] |
| Steps `ste` | Stepped hard breaks | Scale:f, Density:f, Seed:i |
| **Stratify `ct`** (usage 241) | Large-scale broken non-linear strata, tilt | Spacing:f, Octaves:i, Intensity:f, Shape:f, Seed:i, Tilt Amount:f, Direction:i. Out: Layers [3P] |
| Terraces `st` | Classic terraces | Terraces:i, Uniformity:f, Steepness:f, Intensity:f, Seed:i. In: Modulation [3P] |

Docs recipe [P]: `Stratify > Sandstone > Stratify > Sandstone` for complex layered rock.

### a.5 Simulate (25) - details in section (b)

| Node | Family | Parameters [P-data] | Extra ports |
|---|---|---|---|
| **Erosion2 `e2`** (usage 2606) | Erosion | [General] Duration:f, Downcutting:f, Erosion Scale:f, Seed:i, NoErosion:b; [Sediment Discharge] Suspended Load:f + Discharge Angle:f, Bed Load:f + Discharge Angle:f, Coarse Sediments:f + Discharge Angle:f, DepositionBoost:f, ExtraDepositionBoost:f; [Shape] Shape:f, Shape Sharpness:f, Shape Detail Scale:f; [Orographic Influence] Enable:b, Directional Precipitation:b, Direction:i, Rain Shadow:f, Slope:f2, Altitude:f2, Reverse:b | In: Mask, Precipitation. Out: Flow, Wear, Deposits [3P x2; 4 outputs confirmed by [P] memory doc] |
| Erosion `ce` (classic) | Erosion | [Erosion] Duration:f, Rock Softness:f, Strength:f; [Downcutting] Downcutting:f, Inhibition:f, Base Level:f; [Scale] Feature Scale:i (m), Real Scale:b, Terrain Scale:i, Verticality:i; [Flow] Debris:f, Volume:f, Sediment Removal:f; [Selective Processing] Area Effect:E{ErosionStrength,RockSoftness,PrecipitationAmount,None}, Bias Type:E{Altitude,Slope}, Bias:f, Reverse:b; [Other] Seed:i, Aggressive Mode:b, Deterministic:b | In: Area (AreaMask), SedimentRemoval. Out: Wear, Deposits, Flow [P] |
| EasyErosion `ee` | Erosion | Style:E{Simple,Ancient,Ancient2,Alpine,Rocky,Exposed,Flows,Flows2,Flows3,Strata,Withered,SoftSoil,SoftSoil2,Dessicated,Thin}, Influence:f, Direction:i, Bias Angle:E{X,N,E,S,W}, Seed:i | |
| Wizard `z1` | Erosion | Strength, Density, Material, Channel Depth, Channel Width, Deposits, Removal, Bulk: each E{Low,Med,High,Ultra}; Seed:i | Out: Wear, Deposits, Flow [P] |
| Wizard2 `z2` | Erosion | Power, Depth, Scale, Deposits, Flow, Shape, Detail: each E{Low,Med,High,Ultra}; Seed:i; Convert:cmd (to Erosion2) | |
| Thermal2 `t2` (usage 166) | Erosion | [Erosion] Duration:f, Strength:f, Anisotropy:f; [Talus] Angle:f, Sediment Removal:f; [Scale] Feature Scale:f (m) | In: AreaMask, SedimentRemoval. Out: Wear, Deposits [3P] |
| Thermal `te` | Erosion | Duration:f, Strength:f, Anisotropy:f, Seed:i; [Talus] Angle:f, Settling:f, Sediment Removal:f; [Scale] Feature Scale:i, Real Scale:b, Terrain Scale:i, Verticality:i | |
| Crumble `cr` (usage 87) | Erosion | Duration:f, Strength:f, Coverage:f, Horizontal:f, Vertical:f, Rock Hardness:f, Edge:f, Downcutting:f, Depth:f, Direction:E{X,N,E,S,W} | In: AreaMask. Out: Wear [3P] |
| Sediments `sed` (usage 102) | Erosion | Type:E{Fine,Bulky,Classic}, Passes:i, Scale:f, Angle:f, Style:E{A,B}, Grainy Deposits:b | Out: Sediments, Deposits [3P] |
| Anastomosis `an` | Erosion | Impact:f, Width:f, Depth:f, Downcutting:E{Destructive,Pits,Flows,Rivers,Riversx2,Riversx4,Flooding,Floodingx2,Flooding_x4}, Quality:E{Quarter,Third,Half,Full}, Smooth Edges:b | Out: Flow [3P] |
| HydroFix `hf` | Erosion | Downcutting:f | |
| Hillify `hi` | Erosion | Coverage:f, Creep:E{Moderate,Aggressive}, Surface:E{Smooth,Eroded}, Seed:i | |
| Lichtenberg `lct` | Erosion | Style:E{A,B,C}, Scale:f, Complexity:i, Depth:f, Expand:f, Bias:f, Seed:i | |
| Debris `db` (usage 69) | Scatter | Debris Amount:i, Amount Multiplier:f, Scale:f, Friction:f, Restitution:f, Size:f2, Height:f, Seed:i, Shape:E{Rounded,Sharp}, Render Still Rocks:b, Distribution:E{Uniform,Natural}, Export Point Cloud:b | In: Emitter (+ removal input added in 2.3 [P]). Out: ColorIndex, Debris [3P]. Accumulation: Debris |
| Scree | Scatter | Scale:f, Height:f, Density:i, Spread:f, Edge:f, Seed:i | In: Guide. Out: Stones [3P] |
| Snow `sn` (usage 237) | Snow | [Snow] Duration:f, Intensity:f, Settle Duration:f; [Melt] Melt Type:E{Uniform,Directional}, Melt:f, Melt Remnants:f, Direction:i, Snow Line:f; [Advanced] Slip-off angle:f, Adhered snow mass:f, Model scale:f, Real Scale:b, Terrain Scale:i, Verticality:i, Seed:i | In: SnowMap, MeltMap. Out: Snow, Hard, Depth [3P]. Accumulation: Snow |
| Snowfield `sf` | Snow | Cascades:i, Duration:f, Intensity:f, Taper Snowfall:b, Taper Amount:f, Settle Duration:f, Melt:f, Snow Line:f; [Advanced] Slip-off angle:f, Adhered snow mass:f, Flows:b, Flows Depth:f, Seed:i, Sharp Buildup:b, Alternate Snowfall:b, Surface Details:f, Direction:E{X,N,E,S,W} | Out: Snow, Hard, Depth [3P] |
| Dusting `ds` | Snow | [Snowfall] Strength:f, Snowline:f, Falloff:f; [Distribution] Directional:b, Direction:f, Peaks:f, Coverage:f, Slope Coverage:f2, Flow:f; [Effects] Melt:f, Gritty:b, Include Existing Snow:b, Seed:i, Artistic Control:f | |
| Glacier `gl` | Snow | Scale:f, Scale 2:f, Thickness:f, Height:f, Direction:i, Breakage:f, Rough Edges:b, Seed:i; [Surface] Smooth:b, Secondary Breakage:b, Diagonal Breakage:b, Diagonal Breakage Direction:i, Breakage Count:i, Flow Breakage:b, Extreme:b, Flow Breakage Depth:f, Substructure:b, Substructure Density:f, Substructure Depth:f | In: Reference. Out: Snow [3P] |
| IceFloe `if` | Snow | Size:f, Density:f, Layers:f, Thickness:f, Shaper 1:f, Shaper 2:f, Reverse:b, Reverse 2:b, Seed:i | |
| Trees `tr` (usage 136) | Vegetation | [Trees] Output:E{Instances,AreaMask}, Count in Thousands:i, Is Relative:b, Tree Size:f, Trim Under:f, Shape:E{Point,Big,BigOnly}, Seed:i; [Growth] Seek Water:E{Seek,Avoid}, Avoid Trees:E{None,Previous,All}, Health:f, Patches:f, Spread:f, Random:f; [Aspect Inhibition] Slope:f2, Slope Falloff:f, Altitude:f2, Altitude Falloff:f, Peaks:f, Strict:b; [Snow Inhibition] Dead Flow:f, Consolidate Flows:f, Bias:f, Snowline:f; [Artistic Control] Chaos:f, Blur Edges:f, Visualize Data:b; [Custom Inhibitors] Custom Influence:f, Trim:f | In: Inhibition. Out: DeadZones, Trees, FreshWater [3P] |
| Shrubs `shr` | Vegetation | Same structure as Trees minus Output/Tree Size/Patches/Peaks; adds Simulation Bias:f | |
| Lake | Water | Type:E{Simple,Advanced}; [Simple] X:f, Y:f, Water Level:f, Render Surface:b, Accuracy:E{Low,Med,High,Ultra}; [Advanced] Precipitation:f, Small Lakes:f, Flood Control:b, Water Floor:f; [Shore Formation] Shore Size:f, Altitude Bias:f, Size Bias:f | In: Precipitation. Out: Water, Depth, Shore, Surface [3P]. Accumulation: Water, Shore |
| Rivers `rv` (usage 79) | Water | Water:f, Width:f, Depth:f, Downcutting:f, River Valley Width:E{minus4,minus2,zero,plus2,plus4}, Headwaters:i, Render Surface:b, Seed:i | In: Headwaters. Out: Rivers, Depth, Surface, Direction [3P]. Accumulation: River |
| Sea `sea` | Water | Sea:E{Global,Surrounding}, Level:f, Coastal Erosion:b, Shore Size:f, Shore Height:f, Variation:f, Uniform Variations:b, Extra Cliff Details:b, Render Surface:b | In: Edge [P]. Out: Water, Depth, Shore, Surface [3P] |

### a.6 Derive (14) - masks and data maps (all `IsSoftData` except Occlusion)

| Node | Purpose | Parameters |
|---|---|---|
| Height `h` (usage 86) | Altitude band mask | Range:f2, Falloff:f |
| Slope `sl` (usage 60) | Slope band mask | Range:f2, Falloff:f, Type:E{Accurate,Normalized}, Micro Accent:f |
| Angle `ang` | Aspect (facing direction) mask | Azimuth:f, Range:f2, Falloff:f |
| Curvature `cv` | Convexity / concavity mask | Range:f2, Type:E{Horizontal,Vertical,Average}, Falloff:f |
| Peaks `pk` | Highest protrusions | Falloff:f, Precise:b |
| ColorThreshold `cth` (new 2.3) | Mask from colour range | Start:Color, Falloff:f |
| Normals `nm` | Normal map | Type:E{Standard,Detail}, Width:f, Height:f, Detail Size:f, Handedness:E{Left,Right}, Up Axis:E{YUp,ZUp} |
| FlowMap `fl` (usage 98) | Flow accumulation map without modifying terrain | Flow Length:f, Flow Volume:f, Seed:i. In: Precipitation [3P] |
| FlowMapClassic `fl1` | Legacy flow map | Rainfall:f, Primary/Secondary/Tertiary/Quaternary:b, Simulate 2 X:b, Enhance:f, Quality:E{Quarter,Third,Half,Full} |
| Occlusion `ccl` | "Rock occlusion" favouring sedimentary crevices | Strength:f, Octaves:i |
| RockMap `km` | Rock coverage mask | Coverage:f, Density:f |
| Soil `so` | Soil collecting in crevices | Amount:f, Bias:f |
| TextureBase `tb` (usage 189) | Composite "natural material distribution" mask that feeds colour nodes | [Structure] Slope:f, Flows:f, Soil:f, Patches:f, Chaos:f, Peaks:f; [Processing] Accentuate:E{Off,Old,New}, Enhance:E{None,Autolevel,Equalize}, Reverse:b, Seed:i. In: Guide [3P] |
| Texturizer `tz` | Preset texture masks | Style:E{A..L}, Factor:f, Secondary:f, Seed:i, [Components] Flows:f, Slope:f, Soil:f |

### a.7 Colorize (13)

| Node | Purpose | Parameters / ports |
|---|---|---|
| **SatMap `sa`** (usage 770) | Apply one of 1400+ satellite-derived gradients through a mask | Library:E{New,Rock,Sand,Green,Blue,Color}, Randomize:cmd, Library Item:i, Range:f2, Bias:f, [Processing] Enhance:E{None,Autolevel,Equalize}, Reverse:b, Rough:E{None,Low,Med,High,Ultra}, Hue/Saturation/Lightness:f |
| CLUTer `clt` (usage 162) | User gradient (colour look-up) through a mask | Gradient Data, Autolevel Input:b, Reverse:b, Bias:f, Hue/Saturation/Lightness:f |
| Tint `ti` (usage 131) | Two-colour gradient | Start:Color, End:Color, H/S/L:f, Enhance, Reverse:b |
| SuperColor `sc` | Procedural colouring from texture/peaks/flow | [Texture] Texture:E{None,Texture,Peaks,Flow}, Strength:f, Warp:f, Seed:i; [Color] same as SatMap; [Process] Process:E{Basic,Erosion,Third}, Amount:E{Low,Med,High,Ultra}. In: Texture [3P] |
| Synth `sy` | Convert a bitmap into an editable gradient | Samples:E{8..2048}, Fuzzy:f, Offset:f, Seed:i, Synthesize Colors:cmd, Export JSON:cmd |
| WaterColor `wc` | Shallow / deep water colours from depth | Source:E{Port,Accumulation}, Restrict to Group:b, Palette:E{Generic,Jungle,Oasis,Dirty,OceanGreen,OceanBlue,Murky,Muddy,Custom}, Shallow/Deep:Color, Reverse:b, Waves:b, Refraction:b, Color Bias:f, Mask Bias:f, [Contributions] Stillwater:f, Rivers:f, H/S/L. In: Guide. Out: Color, Mask, Stillwater, Rivers [3P] |
| **ColorErosion `cx`** (usage 458) | Transport and deposit colour along sediment flow | Transport Distance:f, Sediment Density:f, Blend:f, Color Hold:f, Flow Volume:f, Laminar Flow:b, Diffusion:f, Seed:i, Version:E{V0,V1,V2}. In: Height, Precipitation [3P] |
| Weathering `we` (usage 190) | Dirt, fading, wear on colour | [Primary] Scale:f, Creep:f, Amount:f, Washed Out:b, Inverse:b, Dirt:f, Darker:b, H/S/L. In: Height [3P] |
| Gamma `ga` | Gamma | Gamma:f, Automatic:b |
| HSL `hu` | Hue/sat/lightness | Hue:f, Saturation:f, Lightness:f |
| RGBMerge `rm` | Pack 3 heightfields into RGB | Enhance R/G/B:E{None,Autolevel,Equalize}. In: In, In2, In3 |
| RGBSplit `rsp` | Split RGB | Autolevel Channels:b, Method:E{Average,BT601,BT709,RedChannel}. Out: R, G, B |
| Splat `spl` | Weighted sum of RGBA channels into one scalar | R/G/B/A:f, Autolevel:b, Clamp Product:b |

### a.8 Output (12)

| Node | Purpose | Parameters |
|---|---|---|
| **Export `ex`** | Write a map to disk | Format:E{GaeaRaw,HalfRaw,HalfRaw16,UshortRaw,UshortRaw16,FloatRaw,FloatRaw32,JPEG,PNG8,PNG16,PNG64,TIFF8,TIFF16,TIFF32,EXR}, Location:E{BuildFolder,Custom,Explicit}, Output Path:s, If File Exists:E{Overwrite,Increment} |
| **Unreal `ue`** (up to 20 ports) | Resample to UE landscape sizes, name files for the bridge, write definition JSON | Automatic Size:b, Target Size:E{x8129,x4033,x2017,x1009,x505,x253,x127}, Dont Resize Textures:b, Format:E{PNG,R16,RAW}, [Naming] Unreal Friendly Naming:b, Map 1..Map 10:E{Height,Mask,Color,Weight}, Add Input:cmd |
| Unity `un` (up to 20 ports) | Same for Unity | Target Size:E{x8193,x4097,x2049,x1025,x513} |
| Mesher `me` | Export mesh | Format:E{OBJ,FBX,DAE,GLTF,GLB}, Scale:E{Normalized,Meter,Kilometer}, Topology:E{Tris,Quads,AdaptiveTris}, Vertices Per Side:i, Artifact Reduction:E{None,Low,Med}, Create Normals:b, Create UVs:b, UV Origin:E{TopLeft,BottomLeft}, Create Walls:b, Center Pivot:b, Level of Detail:E{None,LOD1..LOD6} |
| PointCloud `pc` | Export points | Format:E{PLY,PLY_BINARY,XYZ,CSV}, Scale, Center Pivot:b, Ignore Zero Values:b |
| TextureBaker `txb` (ex-MeshWarp) | Bake tangent-space / warped maps | Generate Normals:b, Add Input:cmd |
| AO `ao` | Ambient occlusion map | Quality:E{Low,Medium,High,Ultra}, Enhance:f |
| LightX `lx` | Fully lit render (bakeable lightmap) | Direction Selection:E{Manual,Geographic}, North:f, Latitude:i, Day of Year:i, Solar Hour:f, Sun Azimuth/Elevation:f, Angular Diameter:f, Direct Light/Shadows/Ambient Light/Ambient Occlusion:b, Quality, [Light] Exposure, Sun Intensity, Ambient Intensity, Air Density, Haze, Ozone, [Colors] Automatic Colors:b, Sun Color, Ambient Color, Ground Brightness. Out: Diffuse, Shadow, AO [3P] |
| Shade | Hillshade-style render | Render Style:E{TableTop,HillShade,Occlusion,SoftLight}, Sun Azimuth/Elevation:f, Sunlight:f, Shade Bias:f, Soft Shadows:f, Reflected Light:b, High Quality:b |
| Sunlight `si` | Insolation integral over up to a year | North:f, Year:f2, Latitude:i |
| Cartography `crt` | Topographic map render | Map style, land/water palettes, contour counts, grid (see `.flubs/Cartography.json`) |
| Halftone | Halftone / dither render | Pattern:E{FloydSteinberg,Riemersma,O2X2..DIAG,HLINE}, Posterize:b, Depth:i |

### a.9 Utility (20)

| Node | Purpose | Parameters / ports |
|---|---|---|
| **Combine `c`** (usage 1222, up to 10 ports) | Blend two+ inputs with a blend mode and optional mask; colour-aware | Ratio:f, Mode:E{Blend,Add,Screen,Subtract,Difference,Multiply,Divide,Divide2,Max,Min,Hypotenuse,Overlay,Power,Exclusion,Dodge,Burn,SoftLight,HardLight,PinLight,GrainMerge,GrainExtract,Reflect,Glow,Phoenix}, Output:E{None,Clamp,Extend}, Swap Inputs:cmd, Add Input:cmd, Enhance:E{None,Autolevel,Equalize}. In: Input2..N, Mask. Clamps to 0..1 by default [P]. Formulas given in `.flubs/Combine.json`: Screen = 1-(1-A)(1-B); Hypotenuse = sqrt(A^2+B^2); Difference = |A-B|. |
| Mask `ma` | Post-mask: re-apply "before" over "after" through a mask, without rebuilding the effect | no params. In: In (after), In2 (before, optional - auto-detected), Mask [P]+[3P] |
| Mixer `mx` (usage 128, up to 33 ports) | Layer stack for colour with built-in height/slope masks, up to 15 layers | Blend Layers, Show Simplified:b, Preserve Masks:b. In: Terrain, LayerN, MaskN; Out: MaskOutN [3P] |
| Layers (up to 15 ports) | Stacked heightfield blending | Blend Layer 1..7:f |
| Chokepoint `cp` | Zero-memory pass-through to reduce rewiring | none |
| Gate `g8` (bake) | Baking boundary; "Bake Required Nodes" bakes all Gates | none |
| Switch `swt` | Boolean choose In vs Alternate | Switch Route:b, Discard Alt in Final Build:b |
| Route `ro` | Integer choose among up to 10 inputs | Choice:i |
| LoopBegin `lb` / LoopEnd `le` | Loop a sub-chain N times | LoopEnd: [Primed] Design Time:b, Build Time:b; [Loop] Loops:i, Mutate Seeds:b, Seed:i |
| Reseed | Override the seed of the upstream procedural node | Seed:i |
| Compare `cm` | A/B wipe in the viewport | A/B:f, Colorized:b, Perpendicular:b, Swap:b |
| MacroPort | Declare macro input/output | Direction:E{Input,Output}, Display:E{Heightfield,Mask,Color}, Is Optional:b, Fallback:E{Null,Black,White,Grey} |
| Edge `ed` | Fade terrain edges to zero | Style:E{Round,Square,Precise}, Size:f, Pixels:i, Softness:f |
| Repeat `rp` | Tile an input N times | Tiles:i, Compensate Height:b, Height:f. In: Color; Out: Texture [3P] |
| Seamless `sls` | Make any map tileable | Edge:f, Shift X:f, Shift Y:f, Preview Tiling:cmd |
| Accumulator `cc` | Collect same-kind maps from all sim nodes in the graph (or group) | Type:E{SnowMask,SnowDepth,Rivers,WaterMask,WaterDepth,ShoreMask,DebrisMask,DebrisColor,Trees,TreeDeadZones,TreeFreshwater}, Restrict to Group:b |
| DataExtractor `de` | Pull modifier masks, differences, boundaries, mixer masks | Data:E{ModifierMask,Difference,Boundary,MixerMask}, Layer:i, Level:f |
| Math `mx` | Per-pixel expression (exprtk-like syntax); inputs `a`,`b`,`c`, coords `x`,`y` | Expression:s, Normalized Coordinates:b |
| Var `var` | Read / modify a graph variable | Edit Mode:E{Consume,Modify}, Variable Name:s, Expression:s, Default Value:s |

Present in `.flubs` but not in the node map (hidden, legacy or unreleased - UNVERIFIED which): Construction, FileSequence, Pond, MeshWarp, Macro. A doc page `reference/nodes/modify/triplanardisplacement.md` exists without metadata (likely Gaea 3).

### a.10 Modifier stack (per-node post-process, not nodes) [P] `source/ui/interface/property-editor/modifier-stack.md`

| Height | Effects | Blend | Masks |
|---|---|---|---|
| Autolevel, Clamp, Drop, Equalize, Height Remap, Match Height, Strong | Blur, Warp, Shaper, Threshold | Max, Min, Difference, Invert | Influence, Height, Slope |

Key semantics: modifiers run after the node without rebuilding it; six modifiers cost the memory of one; `Min`/`Max` compare the node's result with its own input ("keep only where it got lower/higher") - the docs call these among the most powerful tools; `DataExtractor` can return the mask a modifier produced.

---

## (b) Simulation nodes: behaviour, parameters, visual results

**Caveat that applies to this whole section.** QuadSpinner does not publish its algorithms, parameter ranges or defaults. Parameter *names* and *meanings* below are [P]; numeric values are only those the docs print. "Visual result" lines combine the docs' wording with standard geomorphology; where I map a node to an algorithm family that is **[OROGEN]** inference for our implementation, not a claim about Gaea internals.

Common design traits across Gaea's simulations [P]:

- **Scale-aware.** Simulations read the Terrain Definition (width m, height m). Feature sizes are given in metres (`Feature Scale`, `Erosion Scale`). Classic nodes have `Real Scale` (on = use Terrain Definition; off exposes `Terrain Scale` and `Verticality`).
- **Resolution independence is a stated goal, not a guarantee.** The erosion docs claim a 512 preview keeps parity with a 4K or 8K build for all major erosion features (`understanding-erosion/index.md`), yet the Non-Determinism page admits output differs by resolution and recommends baking early shapes (`getting-started/important/non-determinism.md`).
- **Data maps as secondary outputs.** Wear = where material was removed, Deposits = where it came to rest, Flow = transport path. They are low-contrast; users autolevel/equalise them before use.
- **Two ways to restrict a simulation.** (1) Mask port / Mask node = composite the result through a mask (effect confined). (2) "Selective processing" / precipitation input = modulate a physical parameter; the effect can flow outside the mask. Docs stress these are different (`reference/nodes/simulate/erosion.md`).
- **Stacking is the intended workflow.** Several short erosion passes at decreasing scale rather than one long pass; large `Erosion Scale` nodes first, small after.

### b.1 Erosion2 (hydraulic, GPU or CPU) - the flagship

Source: `source/using/using-gaea/understanding-erosion/erosion_2/index.md`, `.../erosion_2-in-action.md`, `.flubs/Erosion2.json`, release notes 2.2.0.0 and 2.3.0.0.

| Parameter (UI) | Internal name seen in docs | Meaning | Values printed in the official "Erosion_2 in Action" table |
|---|---|---|---|
| Duration | `Duration` | Length of simulation. Prefer several short nodes to keep the input shape; long to let erosion design the shape. | 57.8 to 196.7 (so the unit is not 0..1) |
| Downcutting | `Downcutting` | How deep flowing water incises. | 0 to 0.711 |
| Erosion Scale | `ErosionScale` | Size of the largest gullies. Small = fine sharp gullies; large = broad ravines. | 16.7 to 20000 |
| Suspended Load + Discharge Angle | `SuspendedLoadDischargeAmount`, `...Angle` | Finest sediment (silt/sand). Most mobile; travels far, even on 0-24 degree slopes; adds ripples and branching in gullies; with high Duration + Downcutting can create new gully systems. | amount 0 to 0.171; angle 36.3 |
| Bed Load + Discharge Angle | `BedLoadDischargeAmount`, `...Angle` | Gravel / small rocks. Fills gullies, creates talus-like deposits; compensates high Downcutting; can overwhelm fine detail. | amount 0.039 to 1; angle 7.9 to 37.6 |
| Coarse Sediments + Discharge Angle | `CoarseSedimentsDischargeAmount`, `...Angle` | Boulders / debris. Settle fast, only near their discharge angle (docs example: 24 degrees). Produce scree, debris piles, alluvial fans. | amount 0.067 to 1; angle 15.8 to 31.4 |
| Deposition Boost / Extra Deposition Boost | `DepositionBoost`, `ExtraDepositionBoost` | Extra deposits ("Extra Deposits" added in 2.3). Undocumented. | - |
| Shape | `Shape` | 0 = keep original peaks; high = let erosion reshape peaks. Docs describe it as a light thermal-erosion pass embedded in the hydraulic simulation. | 0 to 1 |
| Shape Sharpness | `ShapeSharpness` | More concave, sharper ridges. | 0 to 1 |
| Shape Detail Scale | `ShapeDetailScale` | How much nested smaller detail is simulated (largest ravines down to finest gullies). Lower for distant terrain or when Surface nodes will add detail. | 0 to 1 |
| NoErosion | | "No Erosion" mode (2.3). Undocumented; presumably transport/deposit only. UNVERIFIED |
| Orographic: Enable, Directional Precipitation, Direction, Rain Shadow, Slope (range), Altitude (range), Reverse | | Limit where rain falls: directional rain with rain shadows behind peaks; rain only within a slope range and an altitude range. (The auto-generated descriptions of Slope/Altitude are swapped in the docs.) | - |
| Seed | | Pattern randomisation. | - |

- **Defaults: UNVERIFIED.** The table above lists only non-default values, so e.g. default Downcutting is not 0 and default Coarse amount is not 1.
- The three sediment classes "contribute equally... each about a third"; setting all to 1.0 does not triple deposition [P].
- Ports: In, Mask (in), Precipitation (in, added 2.2 as "Selective Precipitation mask input"), Out, Flow, Wear, Deposits. Memory doc confirms four outputs: at 4096 an Erosion2 node caches 256 MB vs 64 MB for a one-output node [P] `calculating-memory-requirements.md`.
- Deterministic; "up to 10x faster" than classic Erosion; falls back to CPU if the GPU runs out of VRAM [P].
- `.terrain` files must carry `"Version": 2` on Erosion2 nodes (2.2 algorithm) or the node fails to build [3P, aguai2018].
- Known behaviour to design around [3P]: Erosion2 roughens perfectly flat areas (a 7.15 m lake plane came out averaging 12.37 m) unless masked.

Visual features: dendritic gullies and ravines, V-shaped valleys, sharpened concave ridges, talus aprons, debris piles and **alluvial fans** where coarse load drops at slope breaks, smooth valley floors where suspended/bed load fills; rain-shadow asymmetry (one flank dissected, the other smooth).

**[OROGEN] implementation mapping.** A multi-class sediment hydraulic solver: grid shallow-water (virtual pipes, Mei et al. 2007) or a stream-power/flow-accumulation hybrid for the large `Erosion Scale` end, with (1) three sediment classes each with a settling slope threshold (the "discharge angle"), (2) an embedded thermal relaxation term (`Shape`), (3) a precipitation field = base x user mask x orographic term (directional occlusion along `Direction` for rain shadow, plus slope and altitude band-pass), (4) outputs accumulated per cell: `wear += max(0, -dh_bedrock)`, `deposits += max(0, dh_sediment)`, `flow += |discharge|`. Express `Erosion Scale` in metres and convert with `metresPerPixel = width / resolution` so previews match builds. Proposed parameter schema (ours, not Gaea's):

```ts
// [OROGEN] proposal - ranges are ours
interface HydraulicErosionParams {
  duration: number;            // 0..1 UI, mapped to iterations = lerp(50, 4000, duration^2) at 1 m/px, scaled by 1/mpp
  downcutting: number;         // 0..1
  featureScaleM: number;       // 10..20000 m, log slider
  sediment: { suspended: number; bed: number; coarse: number };          // 0..1 each
  reposeDeg: { suspended: number; bed: number; coarse: number };         // 0..45 deg; suggest 5 / 20 / 30
  shape: number; shapeSharpness: number; detailScale: number;            // 0..1
  rain: { directional: boolean; azimuthDeg: number; shadow: number;      // 0..1
          slopeDeg: [number, number]; altitude01: [number, number]; invert: boolean };
  seed: number;
}
// inputs: height (req), mask?, precipitation?, hardness?   outputs: height, flow, wear, deposits
```

### b.2 Erosion (classic, CPU) and its wrappers

Source: `reference/nodes/simulate/erosion.md`, `.flubs/Erosion.json`.

| Parameter | Meaning |
|---|---|
| Duration | Simulation length (docs example "high Duration of 30%" - so this one is a percentage). "Precipitation Amount" selective mode maps onto it. |
| Rock Softness | Softer rock erodes faster. Low softness = slower incision but sediment travels farther. |
| Strength | Fluvial strength = sediment transport capacity. Low strength = sediment dropped earlier. |
| Downcutting | Transports sediment far from origin; 0 for short transport / rapid erosion-deposition alternation. |
| Inhibition | Slows downcutting where undissolved sediment accumulates -> mix of deep channels and alluvial fans; more sediment at the bottom. |
| Base Level | Lowest elevation downcutting may reach before deposition -> fills valleys, forms valley floors. |
| Feature Scale (m) | Lateral size of the largest valleys/ridges. Docs example 2000 m. |
| Real Scale / Terrain Scale / Verticality | See above. |
| Volume | Treat flow as volumetric -> higher water level, wider channels, more deposits; valley floors without downcutting. |
| Debris | Amount of debris generated/transported (undocumented beyond that). |
| Sediment Removal (+ mask input) | Remove produced sediment, uniformly or by mask. |
| Area Effect {ErosionStrength, RockSoftness, PrecipitationAmount, None}, Bias Type {Altitude, Slope}, Bias, Reverse | Selective processing. A mask maps black->0 and white->the slider's value (Rock Softness 35% + mask => 0..35%). Built-in bias masks are normalised 0-100%. |
| Aggressive Mode | Faster, may leave soft artifacts; for previews. |
| Deterministic | Single core; otherwise parallelism makes small features differ run to run. |

Docs' layering recipe [P] (`understanding-erosion/erosion_1.md`): pass 1 Selective = Altitude, Duration 30% (strong guiding grooves); pass 2 defaults but Downcutting 100% and Base Level 100% (strong flow structures everywhere); pass 3 defaults (homogenise).

- **Wizard** = preset wrapper with two phases; 8 Low/Med/High/Ultra dials incl. `Bulk` (pre-inflate to prevent over-erosion of sharp peaks). **Wizard2** = same idea over Erosion2 with a `Convert` button. **EasyErosion** = 15 named styles (Ancient, Alpine, Rocky, Flows, Strata, SoftSoil, Dessicated, ...) plus direction bias.

### b.3 Thermal2 / Thermal (talus)

Source: `understanding-erosion/thermal_2.md`, `thermal-erosion.md`.

| Parameter | Meaning |
|---|---|
| Duration | Longer = more change. |
| Strength | Intensity of smoothing and displacement, strongest on steep slopes. |
| Anisotropy ("Thermal Stress Anisotropy") | Low keeps original terrain; high erodes sharp peaks heavily and builds stronger talus. |
| Talus Angle | Maximum stable slope before material moves. |
| Sediment Removal | High = cleaner, sharper rock (talus removed); low = more accumulation, smoother transitions. |
| Feature Scale (m) | Size of thermal features. |
| Thermal only: Settling, Seed, Real Scale, Terrain Scale, Verticality | Settling = how completely loose material settles. |

Ports [3P]: AreaMask, SedimentRemoval in; Wear, Deposits out. Visual: **talus cones / scree aprons** at cliff bases at a uniform repose angle, blunted peaks, straight rectilinear slopes, filled gully heads. Related: **ThermalShaper** (Modify) is a fast non-simulated approximation; **Crumble** collapses terrain from crevices and edges (horizontal bias toward flow origins vs deposits, vertical bias high vs low, Rock Hardness, Edge).

[OROGEN] mapping: iterative slope-limited mass transfer (`if slope > tan(talus): move k*(slope - tan(talus))` to lower neighbours), in a ping-pong compute pass; expose `sedimentRemoval` as a multiplier on deposited mass; output `wear` and `deposits`.

### b.4 Rivers

Source: `reference/nodes/simulate/rivers.md`, `.flubs/Rivers.json`.

- Generates a river network on any terrain with some slope; it slightly alters the terrain so every river has an unbroken downhill path (it contains a special version of HydroFix).
- Parameters: `Water` (amount in headwaters -> bigger rivers), `Width`, `Depth` (independent of Downcutting), `Downcutting` (incision as it flows), `River Valley Width` {-4,-2,0,+2,+4}, `Headwaters` (count of sources; many become tributaries), `Render Surface` (draw water surface or only output masks), `Seed`.
- Inputs: `Headwaters` mask confines where rivers start. Outputs [3P]: Rivers (mask), Depth, Surface, Direction. Feeds the River accumulator and WaterColor.
- Use early to carve valleys that later erosion respects, or late to add water.
- Limitations [P by omission; Gaea 3 roadmap confirms]: no user-drawn river course, no meander control - guided rivers that meander along a drawn path (with meander history) and vector tools are listed as Gaea 3 features.

Visual: continuous channels reaching the map edge or a lake, tributary junctions, river beds with flat water surface, widened valley floors.

[OROGEN] mapping: priority-flood depression breaching/filling -> D8 or MFD flow accumulation from seeded headwaters -> channel mask where accumulation > threshold -> carve `depth * f(accumulation)` with width proportional to `sqrt(accumulation)` -> outputs river mask, depth, water surface height, flow direction (2-channel).

### b.5 Lake, Sea (water bodies)

- **Lake** [P-data + 2.3 notes]: `Type` Simple (X, Y, Water Level, Accuracy, Render Surface - a point-and-fill lake, added 2.3) or Advanced (rainfall-driven, physically based lake formation: Precipitation, Small Lakes, Flood Control, Water Floor; Shore Size, Altitude Bias, Size Bias). Outputs [3P]: Water, Depth, Shore, Surface.
- **Sea** [P]: `Sea` Global (flood everything below Level) or Surrounding (fill inward from edges only, leaving inland basins dry; `Edge` mask chooses which edges). `Coastal Erosion` with Shore Size, Shore Height, Variation, Uniform Variations, Extra Cliff Details. Outputs [3P]: Water, Depth, Shore, Surface.
- **WaterColor** turns depth into shallow/deep colour; **Accumulator** merges Water/Depth/Shore masks from all water nodes.

Visual: beaches and wave-cut shore platforms, sea cliffs, lake shores, flat water surfaces with depth data for materials.

[OROGEN] mapping: Sea Global = threshold; Sea Surrounding = flood fill from border cells below level; Lake Advanced = priority-flood fill giving `fill - height` depth, pruned by minimum area/volume; shore = distance transform band around the waterline blended toward `level + shoreHeight`.

### b.6 Snow, Snowfield, Dusting, Glacier, IceFloe

Source: `using/using-gaea/simulations/snowfall.md`, `.flubs`.

- **Snow** = particle snowfall simulation covering clumping, adhesion, melt/thaw and settling. Signature idea: keep snowfall long and interleave melt cycles rather than just reducing snowfall. Parameters: Duration, Intensity, Settle Duration; Melt Type {Uniform, Directional}, Melt, Melt Remnants, Direction (sun/wind side loses snow first), Snow Line (no snow below); Slip-off angle (snow slides off steeper slopes), Adhered snow mass (how much sticks to steep faces), Model scale, Real Scale/Terrain Scale/Verticality, Seed. Inputs [3P]: SnowMap, MeltMap. Outputs [3P]: Snow (mask), Hard, Depth.
- **Snowfield** = heavy snow in `Cascades` (repeated snowfall periods; old and new snow interact), Taper, Flows (furrows from avalanching), Sharp Buildup, Direction.
- **Dusting** = light, non-simulated sprinkle: Snowline + Falloff, Directional, Peaks, Coverage, Slope Coverage range, Flow, Melt, Gritty.
- **Glacier** converts Snow (or any input) into thick ice sheets with directional grooves, breakage, substructure. **IceFloe** makes flat ice plates on water.

Visual: snow caps above a snowline, bare steep faces, drifts filling gullies, cornice-like buildup, melt patterns on sun-facing slopes, avalanche furrows.

[OROGEN] mapping: Snow = thermal-erosion-like relaxation of an added layer with slip-off angle as repose, plus altitude/aspect melt term; outputs `snowMask`, `snowDepth`. Dusting = pure function of altitude, slope, aspect, curvature, noise.

### b.7 Sediments, Sand, DuneSea (deposition and aeolian)

- **Sediments** [P-data only]: lays a thick generic sediment layer over the terrain, usable as sand or snow. Type {Fine, Bulky, Classic}, Passes, Scale, Angle, Style {A,B}, Grainy Deposits. Outputs [3P]: Sediments, Deposits. Parameter meanings are undocumented.
- **Sand** (Surface): pattern generator for ripples / small dunes - Scale, Direction, Chaos, Softness, Height, Warp by Terrain. **DuneSea** (Terrain): dune-field generator - Dune Type A-D, Chaos, Undulation, Direction, Height, Softness, Sharpness. Neither is a wind simulation in Gaea 2; a true wind-driven sand solver (ripples and dunes from wind direction and strength) is a Gaea 3 feature [P] https://quadspinner.com/gaea3.

Visual: fills in hollows at a repose angle (Sediments); barchan/transverse dune crests with slip faces (DuneSea); ripple overlays (Sand).

### b.8 Debris, Scree, Stones

- **Debris** [P] (`using-gaea/simulations/debris.md`): rigid-body style simulation of thousands to millions of rocks. `Friction` (energy lost sliding; higher = steeper, shorter slides) and `Restitution` (energy lost on impact). Docs constant: natural rock friction coefficient about **0.62, equal to a 32 degree slope of repose** (atan 0.62 = 31.8 deg). `Emitter` input mask (flow map or Erosion2 Wear recommended), Size range, Shape {Rounded, Sharp}, Distribution {Uniform, Natural}, Render Still Rocks, Export Point Cloud; per-rock colour index output. 2.3 added a removal input.
- **Scree**: non-physical scatter along slopes/edges (Scale, Height, Density, Spread, Edge; Guide in, Stones out). **Stones**: random superficial stones.

Visual: boulder fields below cliffs, scree "rivers" in gullies when emitted from flow, individually coloured rocks.

### b.9 Other simulate-family nodes

| Node | Behaviour | Visual |
|---|---|---|
| HydroFix | Small adjustments along flow zones to give long unbroken flows (depression fixing). One param: Downcutting. | Longer, coherent flow lines in FlowMap |
| Anastomosis | Flow-based downcutting from pits to rivers; modes Destructive, Pits, Flows, Rivers(x2,x4), Flooding(x2,x4); runs at quarter..full res | Braided / interconnected channels, roughened surfaces |
| Hillify | Soil creep | Rounded hills |
| Lichtenberg | Branching lightning-like fracture pattern | Dendritic cracks |
| Trees / Shrubs | Growth simulation along freshwater flows with slope/altitude/peak inhibitors and snow "dead zones"; `Avoid Trees` lets several species avoid each other; outputs instance heights or area mask, dead zones, freshwater | Forest canopy bumps in the heightfield; masks for foliage placement |

---

## (c) Build system

### c.1 Resolutions and memory

| Item | Value | Source |
|---|---|---|
| Internal data | 32-bit float heightfields, values nominally 0..1 mapped to 0..Terrain Height | [P] `dimensions-and-scale.md`, `file-formats.md` |
| Preview resolution | 512, 1024, 2048, 4096 | [P] `viewport-toolbar.md` |
| Bake resolution | 1024, 2048 (default), 4096, 8192; 16K baking added in 2.3 | [P] `baking-nodes/index.md`, 2.3 notes |
| Build resolution | up to 8192 (Indie), 16384 (Pro/Enterprise, "experimental", warns) | [P] Order page |
| Tiled world | up to 262,144 x 262,144 (Pro+) | [P] Order page |
| Cache per node output | 1024^2: 4 MB; 2048^2: 16 MB; 4096^2: 64 MB; 8192^2: 256 MB; 16384^2: 1024 MB (x3 for RGB; x number of output ports) | [P] `calculating-memory-requirements.md` |
| Rule of thumb | 20 nodes at 8K = 5-8 GB cache; 16 GB RAM bare minimum, 32 GB recommended. 16K: 64 GB minimum, 128 GB preferred | same |
| Terrain Definition | Width (m), Height (m = max elevation), derived Real Scale (m/px) and Height-Scale Ratio. Docs example and reported default 5000 m x 2500 m (ratio 0.5) | [P] `build-options/terrain.md`; default value [3P] |

Property fields that represent lengths accept metric entry: typing `500m` with a 5000 m terrain stores 0.1 [P] `property-editor/index.md`.

### c.2 Build Options window (tabs) [P] `source/ui/interface/build-options/*.md`

- **Resolution**: Region (whole terrain or a named region), Resolution, **Subdivision** {None, Faster, Balanced, Slower}, Output {Single Image, Tiled Images}, Tile Size, Blending %.
- **Build**: Build Destination with tokens, "Maintain a static folder with the latest copy" (creates a sibling `Latest` folder so downstream file links do not break), "Copy the .terrain file to the build folder", "Remove Primary port name in Build output", overwrite mode {Overwrite, Increment}.
- **Tiles**: Tile Suffix Pattern (default `_y%Y%_x%X%`), Add Leading Zeroes, Start Numbering from 1, Organization (e.g. folder per node), Flip Y Axis, Preserve Cache in Build Folder, Overlap Pixels.
- **Nodes**: per marked node - ports to export (`Out`, `Flow`, `Wear`, `Deposits`, ...), Primary Only, filename, format. Files are named `<NameOrNodeName>_<PortName>.<ext>`.
- **Script**: a post-build command line.
- **Terrain**: Terrain Definition. **Regions**: region rectangles. **Profiles**: named presets of all build settings. **Commands**: Execute Build, Copy Command Line.

Path tokens [P] `build-tokens.md`: `<FileLocation>`, `<Builds>`, `[Mutation]`, `[Region]`, `[Timestamp]`, `[Filename]`, `[Username]`, `[Domain]`, `[Machine]`, `[Time]`, `[Date]`, `[Resolution]`, `[+++]` (auto-increment folder 001, 002...). Default destination `<Builds>\[Filename]\[+++]`.

Build definition as stored in a `.terrain` file [3P, aguai2018 FILE_FORMAT.md]: `Type: "Standard"`, `Resolution`, `BakeResolution`, `TileResolution: 1024`, `BucketResolution: 2048`, `NumberOfTiles`, `EdgeBlending: 0.25`, `TileZeroIndex`, `TilePattern: "_y%Y%_x%X%"`, `OrganizeFiles: "NodeSubFolder"`.

### c.3 Tiled, hybrid and split builds [P] `source/using/using-gaea/build-and-export/tiled-builds.md`

- **Tiled build**: terrain processed as a grid of tiles to cap peak memory; outputs are already chunked.
- **Hybrid build**: build in large *buckets* (e.g. 4096) and subdivide into small export tiles (e.g. 512 => 64 tiles per bucket). Subdivision None is only available when the world fits in 8K or 16K.
- **Blending**: buckets are processed separately; increase blend between buckets to hide seams, "around 25% is often a good starting point".
- **Split build**: build the whole terrain once, cut into tiles afterwards (no seams, heavy on memory) [P] `resolution-tiles-without-seams.md`.
- **Why tiles differ from full builds**: generators and transforms that assume one canvas; filters sampling far outside the tile; anything auto-levelled/equalised per tile. Remedy: bake the "world stage" (macro shapes) at the closest full-world resolution, then run erosion/detail per tile. `Graph > Bake > Bake Required Nodes` bakes every node flagged as requiring it. The `Gate` node marks baking boundaries; a "TileGate" is mentioned in guides.
- **Reality check [U]**: thread "Tile Build Seams showing up regardless of blend percentage" (Gaea 2.2.9, opened 2026-03-15, 35 replies, unresolved 2026-06-04): seams at 0/25/50/100% blend even with everything baked; a ~1 px edge margin; users ask for a "+1 pixel" or pixel-bleed option. https://talk.gaea.app/t/tile-build-seams-showing-up-regardless-of-blend-percentage/536 . 2.3.1.0 changelog still fixes "Tile edge/corner classification could be wrong in some bucketed builds" and "Overlapping pixels overwrote data".

### c.4 Regions [P] `build-and-export/regions/index.md`

A region is a rectangle of the terrain rebuilt at its own (up to full) resolution, e.g. 1/6 of an 8K terrain rebuilt at 8K. Unlimited regions; preview a region from a dropdown next to the preview-resolution selector; initial generators must be baked first; 2.3 warns when a region build is under 4K. Pro+ only. Vendor guidance is nonetheless to *avoid* "zoom in later" for erosion-heavy terrain because feature scale drifts (`large-projects/separate-regions.md`).

### c.5 Build Swarm, profiles, mutations, reports

- **Build Swarm** = `Gaea.Swarm.exe`, a separate headless process the UI launches for full-resolution builds [P] `build-swarm/index.md`. It is a *local* process; I found no documented distributed/multi-machine mode (the `[Machine]` token text mentions "Build Swarm nodes" but nothing else describes networking - UNVERIFIED).
- **Profiles**: save all build settings under a name; `-p "<name>"` on the CLI; Batch Build Manager queues profiles and can save a `.bat`.
- **Mutations**: `--seed <int>` *adds that integer to every node's seed* unless the node is baked; "Add Mutation" in Batch Build Manager; `[Mutation]` path token. That is the whole variations system in Gaea 2 [P] `creating-mutations.md`. Related: `Reseed` node, LoopEnd "Mutate Seeds", Seed control with memory slots (2.2.4).
- **Reports**: `report.txt` and `report.json` in the build folder: Resolution, NodeCount, Result, StartTime, EndTime, Duration, per-node `SecondsTaken`, FastestNode, SlowestNode [P] `build-reports.md`.

### c.6 Command line [P] `source/developers/automation/cli/index.md`

```
Gaea.Swarm [[--Filename] <String>] [--ignorecache] [--interactive] [-p <String>]
           [-r <String>] [--safemode] [--seed <Int32>]
           [-v <String=String>...] [--va <String>...] [--vars <String>] [--verbose]
  --Filename   REQUIRED path to .terrain
  --ignorecache  ignore baked cache
  -p|--profile   build profile          -r|--region  region to build
  --seed         mutation seed
  -v key=value   repeatable variable assignment (docs: must be the last arguments)
  --va           comma-separated values in alphanumeric order of variable names
  --vars         path to .json or .txt (ini style key=value) with variables
Gaea [[-Path] <String>] [-Activate <String>] [-CPUOnly] [-Deactivate] [-NoStart]
     [-Proxy <String>] [-SafeMode] [-UseProxy] [-Verbose] [-Version]
```

- Release notes 2.2.0.0 add `--silent`, a `buildpath` option, setting resolution and licence server from the CLI, and a `SwarmHost` middleware (`Gaea.SwarmHost.exe`, used by Gaea2Houdini). These are not in the usage block above; exact spelling UNVERIFIED.
- **Bridge contract** [P] `building-bridges/*.md`: bind File node `Filename` and Export node `OutputPath` to variables; Export `Location` = Explicit takes a full path **without extension**; pass a JSON vars file; run Swarm; read the outputs.
- **Reported CLI traps [3P]**: Swarm exits with code 0 on most failures (trust `report.json` `Result`); with a single licence seat Swarm fails while the GUI holds it; a build with no Export/Mesher node "succeeds" writing nothing.
- **Variables / expressions / Math** [P] `scripting-and-expressions/*.md`: variable types Float, Int, Range (float2), Choice, Bool, Color, String; bind one variable to many properties; per-property expressions with `x` = incoming value (e.g. `x * 0.3`, `if(SomeVar, 0.3, 0.6)`); Math node language has arithmetic, comparisons, logic, trig, `clamp`, loops, `if-then-else`, `switch`. **Macros** (2.3): `.macro` packages built from a graph with `MacroPort` nodes and exposed variables; instances reference a central definition.

### c.7 Export formats

| Format (Export node enum) | Bit depth | Notes |
|---|---|---|
| EXR | 32f | Recommended for heightfields |
| TIFF8 / TIFF16 / TIFF32 | 8 / 16 / 32f | |
| PNG8 / PNG16 / PNG64 | 8 / 16 / "64-bit" (presumably 16 bits x 4 channels - UNVERIFIED) | PNG16 is the UE default path |
| UshortRaw, UshortRaw16 (`.raw` / `.r16`) | 16-bit unsigned, little-endian, headerless, square, 0..65535 | |
| FloatRaw, FloatRaw32 (`.r32`) | float32 LE, headerless, **normalised 0.0..1.0** | Best for Gaea round trips |
| HalfRaw, HalfRaw16 | half float | |
| GaeaRaw (`.graw`) | float32 + sidecar metadata | Recommended to split projects across files |
| JPEG | 8 | colour/reference only |
| Mesher | OBJ, FBX, DAE, glTF, GLB; Tris, Quads, AdaptiveTris ("Sophia", 20-40% fewer polys, up to 80% on flat terrain); LOD1-6; scale Normalized / Meter / Kilometer | |
| PointCloud | PLY, PLY binary, XYZ, CSV | |

Raw resolution is inferred as `sqrt(bytes / bytesPerSample)` [P] `file-formats.md`.

### c.8 Height range and normalisation [P]

- No per-export "min/max metres" setting. Height is a 0..1 float where 1 = Terrain Height. Values may leave 0..1 unless clamped (Combine `Output` None/Clamp/Extend; File `Allow Unclamped`; Clamp/Extend nodes).
- Normalising is done by the user with the **Autolevel** modifier/node, or automatically by the **Unreal node, which "autolevels the 32-bit height data before export"** so the 16-bit range is fully used; the viewport may then look different (`reference/nodes/output/unreal.md`).
- Vendor guidance (`helpful-info/normalized-output.md`): normalise before saving `v = (h - hmin)/(hmax - hmin)`, restore in the engine `h = v*(hmax - hmin) + hmin`, and "save the metadata" yourself. Using 10% of a 16-bit range leaves about 6553 levels (~12.7 bits).
- Per-tile autolevel creates seams; normalise before tiling.
- Importing DEMs: `Constant (metres) -> File (unclamped) -> Autolevel -> Match (Constant as reference)` (`match-height.md`).

---

## (d) Viewport and UX features people rely on

### d.1 Viewport [P] `source/ui/index.md`, `viewport-toolbar.md`, `measurement-tools.md`, `options/viewport.md`

| Feature | Detail |
|---|---|
| 3D view | Navigation modes Orbit, Free (WASD + Q/E), Orthographic; grid, bounds, compass, base marker; save/load camera; embedded or floating window; AA none/2x/4x/8x (default 4x); "conserve memory when displaying 4K terrains" |
| 2D view | Toggle `F6`; floating viewport for current node `Ctrl+F6`; 2D gizmos for node positions (2.3; option to disable 3D gizmos) |
| Preview resolution | 512 / 1024 / 2048 / 4096, independent of build resolution (Gaea 3 raises previews to 8K) |
| Render modes | Realistic, Clay (supports colour maps), Visualize Data (raw data, renderer off); lighting/sun/atmosphere editor ("Sky Editor") |
| Data-map visualisation | Mask gradient palettes Greyscale (default) / Red / Blue / Spectrum; "Autolevel Masks" toggle; masks are drawn over an **underlay** terrain |
| Underlay | Nearest heightfield ancestor is used automatically; `G` = "Use as Underlay" to pin one; "Exclude from Underlay" per node; `V` = temporary flat preview |
| Lock Preview (pin) | `F` pins the viewport to a node; editing upstream re-evaluates the chain up to the pinned node |
| Suspend engine | `` ` `` pauses all processing while editing several nodes |
| Height Picker | Hover/click in 2D view: metres, percent of max height, raw 0..1; copy in metric or percent |
| Measurement Tool | Two clicks: XYZ of both points, 2D distance, 3D distance, difference |
| Scale overlays | Preset and custom image overlays multiplied on the render; formula `px = metres * overlayRes / terrainWidth` |
| Compare node | A/B wipe |
| Screenshots | `F9` auto, `Ctrl+F9` manual |
| Stats tab | Per node: build time, resolution, channels, data type, size, **min / max / range** |

Several viewport doc pages (2D Viewport, Render Modes) are empty stubs in the docs repo, so finer behaviour is UNVERIFIED.

### d.2 Graph and editing [P] `graph-conveniences.md`, `portals-and-chokepoints.md`, `data-view.md`, `keyboard-shortcuts.md`

- **Creation**: `Tab` search; shortcodes; comma-chained creation (`m,e2,e2,tb,sm`); drop a node on a node or a wire to connect/insert; drag Out onto Out auto-creates a Combine; `F8` MultiMix selected nodes into Combine, `Ctrl+F8` into Mixer; presets searchable with `_` prefix; a fully local predictive system ranks suggested next nodes.
- **Organisation**: graph tabs (cross-tab links via portals), groups (`Ctrl+G`), Markdown notes, **portals** (any output port can become a named wireless source; `P` manage, `Ctrl+P` convert a wire), **Chokepoint** node, auto-layout `F4`, push nodes (`Ctrl+Shift` drag), navigate menu `,`, node bookmarks, select upstream/downstream, move to tab.
- **State**: bypass nodes; Mark for Export `F3`; node presets and per-type default override; undo menu doubles as a history readout (node, property, before/after); autosave every 10 min by default plus a disaster-recovery file every 5 s; migration backups when opening older files; `File > Repair`.
- **Data View tabs**: Terrain (tree of tabs > groups > nodes with filters: Marked for Export, Requires Baking, Nodes with Errors, Heavy Nodes, Orphan Nodes, Bypassed, Has Modifiers, By Type), Build, Stats, Vars.
- **Parametrics**: variables bound to properties ("exposed" parameters), expressions, Var and Math nodes, loops (LoopBegin/LoopEnd), Route/Switch, Reseed, macros.
- **Caching UX**: bake selected/required; "linchpin" loading (only the last baked node of a baked chain is loaded; ancestors drawn dotted); Smart Cache offloads idle 2K/4K caches to disk after 600 s; cache to disk on close.

### d.3 Sculpt / draw / mask tools

- Gaea 2 has **no 3D sculpt brushes and no vector/spline tools**. The only freehand tool is the **Draw** node (painter window; Soften, Height; 2.2.7 added height clamp and mouse-wheel shortcuts). Vector tools for rivers, lakes, roads and "Draw Tools 3.0" (brush + vector + reference overlay) are advertised as Gaea 3 features and called "long-awaited" by the vendor [P] https://quadspinner.com/gaea3 .
- Masking: Mask port on most nodes; post-masking **Mask** node; modifier masks (Influence, Height, Slope); Draw as painted mask; Transpose/Embed/Insert to seat hand-made pieces.
- Gizmos: 2D/3D gizmos for nodes with a position (Crater, Voronoi, Transform, ...).

---

## (e) The Gaea -> Unreal workflow

### e.1 Export side: the `Unreal` output node (Gaea 2.3) [P] `source/guides/use-in/engines/unreal.md`, `reference/nodes/output/unreal.md`, `.flubs/Unreal.json`

1. Connect the heightfield as the **primary** input; use `Add Input` for more maps (up to 20 ports; Map 1..10 each typed `Height | Mask | Color | Weight`).
2. `Target Size` resamples every map to a UE landscape size: **8129, 4033, 2017, 1009, 505, 253, 127** ("a 2048 x 2048 build will become 2017 x 2017"). `Automatic Size` picks the size nearest the build resolution. `Dont Resize Textures` leaves colour maps at build resolution.
3. `Format`: PNG (recommended), R16, RAW ("RAW is currently not fully supported").
4. The node **autolevels the height** to fill 16 bits.
5. `Unreal Friendly Naming`: `H_` prefix for the heightfield, `T_` for masks and textures [P]; the weight-map guide says weight maps carry a `W_` prefix [P] `importing-weight-maps.md`. File base names come from the *connected node's name*, so nodes must be renamed to avoid collisions (e.g. two Gamma nodes).
6. On build it writes the image files plus **a JSON definition file**.

### e.2 The definition JSON: what the importer actually reads [P] Gaea2Unreal `src/Source/GaeaUEToolsEditor/Public/GaeaSubsystem.h`

```cpp
USTRUCT() struct FGaeaJson {
  FString ID = TEXT("");
  int32   Resolution = 0;
  float   ScaleX = 1.0f;
  float   ScaleY = 1.0f;
  float   ScaleZ = 1.0f;   // parsed, not used by the importer
  float   Height = 0.0f;
  FString Unit = TEXT(""); // parsed, not used by the importer
};
```

Exact scale code (`GaeaSubsystem.cpp`, `ImportHeightmap`, identical in both reimport paths):

```cpp
Location = FVector(0, 0, GaeaDefinition.Height * 100 / 2);
Scale    = FVector(GaeaDefinition.ScaleX * 100 / GaeaDefinition.Resolution,
                   GaeaDefinition.ScaleY * 100 / GaeaDefinition.Resolution,
                   GaeaDefinition.Height * 100 / 512);
```

- Interpretation: `Height` = terrain height in metres, `ScaleX/ScaleY` = terrain width in metres, `Resolution` = exported pixel size. Z scale `H*100/512` is the standard UE rule (a 16-bit landscape spans 512 m at Z scale 100); the docs give the same manual formula: `Z scale = max height in metres x 100 x 0.001953125`. Z location `H*100/2` cm puts height value 0 at world Z = 0. (Field semantics are inferred from the formula; **I did not see a real definition file - sample values UNVERIFIED**.)
- [OROGEN] note: XY uses `/Resolution`, not `/(Resolution - 1)`; a landscape with N vertices has N-1 quads, so the imported landscape is narrower than the terrain width by a factor (N-1)/N (0.05% at 2017). We should emit `widthCm / (N - 1)`.
- File discovery: the user picks a heightmap (`*.r16; *.raw; *.png`); the importer then takes **every `*.png` in the same folder whose name contains `W_`** as a weight map and **the first `*.json` whose name contains `definition`** as the definition. Weight maps are PNG only.

### e.3 Import side: Gaea Landscape Importer (plugin 2.2.0.7, `main`, UE 5.7) [P] source + `importing-weight-maps.md`

| Step | Behaviour |
|---|---|
| Install | Unzip to `Engine/Plugins/GaeaUnrealTools` or `<Project>/Plugins/GaeaUnrealTools` (folder name must be exactly that or the toolbar icon breaks). Editor-only modules; depends on EditorScriptingUtilities. |
| Panel fields | Heightmap Filename, JSON Filename, Weightmap Filenames (reorderable), Flip Y Axis, Enable World Partition (default on), WorldPartitionGridSize (default 2, 1..16), Landscape Material, Landscape Layer Names (read from the material), Layer Info Folder, Location (default 0,0,100), Rotation, Scale (default 100,100,100 - overwritten from JSON) |
| Layers | Layer names are read from `LandscapeLayerBlend` nodes at the **top level** of the material (no recursion into material functions). Needs at least 2 layers. Creates one `ULandscapeLayerInfoObject` per layer in Layer Info Folder (blend method set to PremultipliedAlphaBlending in `main`). **The first layer gets no weight map**; weight-map count must equal layers minus 1 or "Create Landscape" is disabled. |
| Landscape creation | `FLandscapeImportHelper::GetHeightmapImportDescriptor` -> `ChooseBestComponentSizeForImport` (project default quads/sections) -> `TransformHeightmapImportData(..., ExpandCentered)` -> `ALandscape::Import(..., ELandscapeImportAlphamapType::Additive)`; if World Partition: `ULandscapeSubsystem::ChangeGridSize(LandscapeInfo, GridSize)` (source comment calls it "a partial WP solution" that is slower). |
| Reimport | A `UGaeaLandscapeComponent` on the actor stores heightmap, definition and weight-map paths; "Reimport" rewrites height and weights on edit layer 0 and requires identical resolution. |

Supported engines: branches `UE-5.3` .. `UE-5.7`; release "Gaea2Unreal 2.2" has zips for 5.3-5.7. **No UE 5.8 branch or build as of 2026-10-12**; issue #24 "UE 5.8 Support" (opened 2026-08-28) is open, with a user reporting the vendor answer was to compile it yourself. https://github.com/QuadSpinner/Gaea2Unreal/issues/24

### e.4 Typical pain points (evidence)

| # | Pain point | Evidence |
|---|---|---|
| 1 | Plugin trails every engine release; users must compile C++ themselves | [U] issues #8 (5.6), #14/#16 (5.7), #24 (5.8, open); [P] docs troubleshooting "Why don't you support the latest version of Unreal Engine?" |
| 2 | `.raw` / `.r16` import crashes the editor | [U] issues #9 (UE 5.5) and #22 (UE 5.7, array index out of bounds); docs say RAW "not fully supported" |
| 3 | Crash if Layer Info folder is unset or weight-map count != layers | [U] issue #21 (analysis of `CreateLandscapeActor`) and #3 |
| 4 | Tiled builds cannot be imported through the bridge (only the selected tile) | [U] issue #20 (2026-01-28, open) |
| 5 | Tile naming mismatch and World Partition tile import: UE wants `_x0_y0`; Gaea default is `_y%Y%_x%X%`; 16K as 256 tiles of 1009 imported into UE 5.7.1 repeats a handful of tiles (workaround: import without WP, then convert level) | [U] https://forums.unrealengine.com/t/gaea-and-ue-5-0-3/770901 , https://forums.unrealengine.com/t/major-problem-importing-tiled-heightmap-from-gaea/2706407 |
| 6 | 8129 single-image limit feels small for open worlds, while tiles are the broken path | [U] issue #20 comment |
| 7 | Material coupling: layer blend nodes must be top-level, first layer implicit, exactly N-1 weight maps, manual reordering | [P] `importing-weight-maps.md` |
| 8 | Heights: Unreal node autolevels silently; users report "Exported heightmap taller than in gaea, cutting off top of map" (16 replies, 2026-07) and ask for a "uniform range on exported heightmaps" | [U] bug-category listing https://talk.gaea.app/c/feedback/bugs ; https://talk.gaea.app/t/uniform-range-on-exported-heightmaps/2093 |
| 9 | Mixer masks connected to the Unreal node fail with a blank error unless "Preserve Masks" is on | [U] https://talk.gaea.app/t/note-to-self-regarding-error-on-the-unreal-export-node/2151 |
| 10 | World Partition import is slow | [P] docs troubleshooting |
| 11 | Weight maps are not normalised by the tool: nothing guarantees layers sum to 1 (the importer uses Additive alpha maps and implicit first layer) | [P] source; consequence is [OROGEN] inference |
| 12 | Bridge unavailable in the free edition | [P] Order page |

---

## (f) Top complaints and limitations (where Orogen can do better)

Ordered by how directly a solo UE developer feels them. Evidence tags as defined in 0.1.

| # | Limitation / complaint | Evidence | Orogen opportunity |
|---|---|---|---|
| 1 | Unreal hand-off is fragile and version-locked (see e.4) | [U][P] | Version-independent export: exact landscape sizes, sidecar with metres, normalised weight maps, a script-based importer instead of a compiled plugin |
| 2 | Tiled / hybrid builds seam, even when baked; per-tile normalisation; edge classification bugs | [U] 35-reply thread; [P] 2.3.1.0 changelog | World-space evaluation with halo padding and global min/max; and simply no tiling below 8129 |
| 3 | Preview and final build differ by resolution; classic Erosion non-deterministic unless single-threaded | [P] `non-determinism.md` | Metre-based parameters, fixed-seed GPU determinism, golden-image tests in the headless engine |
| 4 | Generators and several filters are not tile/region-safe and must be baked (`RequiresBaking` on every generator, Transform, Autolevel, Bomber, Stones...) | [P-data] | Sample all generators in world coordinates so regions "just work" |
| 5 | Memory hungry: every output port of every node is cached at full res; 20 nodes at 8K = 5-8 GB; 16K "experimental", 64-128 GB RAM | [P] | Lazy secondary outputs, VRAM budget with LRU eviction to disk, R16F/R8 masks, modifiers instead of nodes |
| 6 | Mostly CPU: per the vendor's engine blog, only heavy simulations such as erosion run on the GPU; blending/transforms/masks stay on CPU; GPU path needs CUDA or HIP | [P] blog `terrain-app1.md`, FAQ | All-GPU WebGPU pipeline, vendor neutral, interactive at 2K-4K |
| 7 | No vector tools: rivers cannot be drawn, no roads, no lake outlines; no 3D sculpting | [P] Gaea 3 roadmap ("long-awaited") | Spline rivers/roads and paint layers from day one |
| 8 | Square terrains only, 2.5D only (no overhangs) | [P] Gaea 3 roadmap ("no longer confined to a single square"), `file-formats.md` | Square is fine for UE landscapes; note as non-goal |
| 9 | Windows only; AVX2 required; no Mac; Linux "being considered" | [P] FAQ | Electron + Dawn already cross-platform |
| 10 | Licensing friction: online check every 28 days, offline only for Enterprise, no refunds, features gated by edition (regions, tiled worlds, variables, CLI automation at $199; 1K export cap in free edition); single floating seat blocks the CLI while the GUI is open | [P] FAQ, Order; [3P] | Not applicable to an in-house tool; keep CLI and GUI independent |
| 11 | Documentation gaps: no ranges, defaults or port lists; several pages are stubs (2D Viewport, Render Modes, Groups, Annotations, Tabs, Bookmarks); Sediments and Glacier parameters undescribed | [P] observed in docs repo 2026-10-12 | Generate node docs from the node schema; tooltips with units and defaults |
| 12 | Stability and regressions: long crash-fix lists every release; 2.2 broke Trees, Cellular3D, Debris, ThermalShaper compatibility; file migration failures; baked-cache corruption | [P] release notes; [3P] | Versioned node implementations (`Version` field per node), migration tests |
| 13 | Automation rough edges: Swarm returns exit code 0 on failure; build "succeeds" with nothing exported; `Gaea.exe -Path` crash; 8-bit mask PNG silently misread as 16-bit | [3P] aguai2018 notes for 2.3.0.1 | Non-zero exit codes, JSON report, strict input validation |
| 14 | Erosion roughens flat water/lake areas unless masked | [3P] | Water-aware erosion (protect below water level) |
| 15 | Mutations are only "add N to every seed" | [P] | Named variation sets, per-node seed locks, contact-sheet previews |
| 16 | Community/support friction: users say Discord was shut down and YouTube comments are disabled; unhappiness about Gaea 3 pre-orders while 2.x roadmap was unfinished (vendor acknowledges) | [U] issue #24 comment (single user claim); [P] blog `what-happens-to-gaea-2-0.md` | n/a |
| 17 | Preview capped at 4096; building 8K+ leaves the app for a separate Swarm run | [P] | Progressive refinement in the viewport up to 8129 where VRAM allows |
| 18 | Third-party drivers/overlays break the viewport (Nahimic), specific NVIDIA driver advice | [P] `common-issues-and-workarounds.md` | n/a (but test on both dev GPUs) |

I could not retrieve Reddit or Polycount threads in this session (search returned none); the complaint list therefore leans on the official forum, the plugin's GitHub issues, the Unreal forum and vendor documents. Treat frequency/ranking as my judgement.

---

## (g) Rivals: what an Unreal game developer would miss

### World Creator (BiteTheBytes) - latest release notes page 2026.4 [P] https://docs.world-creator.com , https://www.world-creator.com/en/features.phtml

- **Everything real time on the GPU**, no bake/build step; layer stack instead of a node graph.
- **Level-step generation**: terrain is synthesised from 2x2 upward, doubling each level (level 11 = 2048); filters have per-level strength, so large forms are shaped cheaply at low levels and detail at high levels. A "precision" setting decouples computed resolution from terrain size.
- **Direct manipulation**: sculpt brushes, vector Path / Polygon / River shape layers, 2D and 3D stamps, paintable biomes.
- **Biomes with objects**: scatter millions of instances; simulations for sand, snow, debris, fluid (water, lava, glaciers).
- **Real-world data** streaming (MapTiler heightmaps and satellite imagery).
- **Unreal Bridge 2.0**: one sync file; auto terrain setup from terrain size; imports material layers as landscape layers with a generated blending material; World Partition grid options; objects imported through PCG point clouds; "Reset Terrain on Resync" off keeps UE edit layers. Recommended max 16k x 16k. (Supported UE versions not on the docs page; news items mention 5.6 and 5.7 - 5.8 UNVERIFIED.)
- Exports splat, normal, roughness, AO, flow, cavity, slope and biome maps plus GIS formats; paintable holes for cave entrances with a hole mask.

### World Machine - "Dragontail Peak", builds 4059-4067 [P] https://www.world-machine.com/features.php , https://www.world-machine.com/purchase.php , https://help.world-machine.com/topics/releases/ (build 4059 dated May 2026 by a secondary news report, foro3d.com; official dates not on the release index)

- **Water toolset**: River Tool (draw a course; generates meanders, riffle-pool sequences and valley walls), Create Water (automatic or click-seeded river networks and lakes), Flow Restructure (guarantees drainage to sea level), Coastal Erosion; water exported as mesh with flow vector map.
- **Layout mode**: vector shapes with Bezier paths, per-vertex heights, falloff and boolean compositing.
- **Tiled export that resumes failed builds and merges finished tiles**, plus Tiled File Input with multi-resolution caching.
- **RGBA weightmap (splat) output** and select-by-ID; macros for bedrock/soil, vegetation, coast.
- **Code device**: user Slang compute shaders with Lua host. 3D VDM terrain for overhangs.
- Viewport: A:B comparison, slope overlay, contours, 8 camera slots, HDR lighting and fog.
- Simulation "up to 100x faster at high resolution" since the Hurricane Ridge rewrite (vendor claim).
- Price: Basic free (1K), Indie $119, Professional $299 (tiles, all cores, automation), Studio $1,999.

### Houdini heightfields + Houdini Engine for Unreal [P] https://www.sidefx.com/docs/houdini/heightfields/index.html , `.../nodes/sop/heightfield_erode.html` , `.../unreal/landscape/index.html`

- A heightfield is a set of **named 2D volume layers** (`height`, `mask`, and any number of user layers); every tool can read/write any layer. This is the most general data model of the four.
- **HeightField Erode** is time-stepped and scrubbable: Erosion Feature Size (metres, min 3 voxels), Erodability + mask, Hydro (Flow Force, Bank Angle, Rainfall Coverage, Slope Influence, Erosion/Deposition/Removal/Evaporation rates), Thermal (Weathering Force, Cut Angle, Repose Angle), outputs `sediment`, `debris`, `flow`, `flowdir` layers, with options to add debris/sediment back into height.
- HeightField Mask by Feature, Scatter, Project (geometry to heightfield), Shallow Water solver; PDG to split huge worlds into tiles.
- **In Unreal**: the HDA lives in the level; parameters are edited in the UE details panel and the landscape recooks; every named layer becomes a landscape layer; `unreal_material` and related attributes assign materials; landscapes and landscape splines can be *inputs* (round trip); streaming proxies via `unreal_landscape_tile_actor_type`.
- What users would miss in a file-export tool: live in-editor iteration and bidirectional editing.

### Instant Terra (Wysilab) [P] https://www.wysilab.com , https://www.wysilab.com/Editions_Pricing.html (read 2026-10-12)

- Selling point: edit any parameter and see the result "in real time ... in the final resolution"; terrains of "billions of quads" (32k and 64k examples); Python/C# automation and a C++ live link; custom Python and GPU nodes; tiled mask export; an Unreal plugin was announced in 2021.
- Status is unclear: the pricing page lists Instant Terra ($149, 8k) and Unlimited ($199) as "Not available" for purchase, PRO on request; the newest release I could find is 2.3 (July 2021). **Current maintenance status UNVERIFIED** - do not benchmark against it.

**Cross-rival takeaways for an Unreal developer** [OROGEN]: (1) drawn rivers/roads/lakes, (2) real-time feedback at working resolution, (3) splat/weight output that is ready for a landscape material, (4) object/foliage placement data that lands in PCG, (5) resumable large exports, (6) re-sync that preserves in-engine edits.

---

## Prioritised list for a first serious Orogen release

All of this section is **[OROGEN]** recommendation, derived from the evidence above (usage counts, pain points, rival features) and the fixed constraints (UE 5.8, single square landscape up to 8129, WebGPU, RTX 3080 10 GB).

### Sizing facts to design around

- One float32 layer at 8129 x 8129 = 66,080,641 samples = 264.3 MB (252 MiB); RGBA32F = 1.06 GB. At 4033: 65 MB; at 2017: 16.3 MB; at 1009: 4.1 MB.
- Gaea's own budget table (64 MB per output at 4096, 256 MB at 8192) and "Erosion2 = 4 outputs" imply a hydraulic node holds 1+ GB at 8K before working buffers.
- WebGPU default limits relevant here (from the spec as I remember it; **verify with the WebGPU research**): `maxTextureDimension2D` 8192 (8129 fits), `maxBufferSize` 256 MiB (an 8129^2 f32 buffer is 252 MiB - just fits), `maxStorageBufferBindingSize` 128 MiB (does **not** fit; use `r32float` textures or request a higher limit).

### MUST have (v1.0)

**Engine / data model**

1. Terrain Definition in metres (width, height range, optional sea level); all length parameters stored in metres; preview and build share the same world-space sampling.
2. Layer types: height (r32f), mask (r16f or r8), colour (rgba8/rgba16f), vector (rg16f for flow direction). Named secondary outputs per node, computed lazily only when connected or exported.
3. Deterministic evaluation (fixed seeds, no data races), node-level `version` field and graph schema version with migrations.
4. Cache with VRAM budget, LRU eviction to disk, dirty propagation; "suspend engine" toggle.
5. Headless CLI: `orogen build <file> [--resolution N] [--var k=v ...] [--vars file.json] [--seed N] [--out dir]`, non-zero exit code on any failure, `report.json` (per-node timings, min/max per output).

**Nodes (about 45)**

| Group | Nodes |
|---|---|
| Generate | Constant, Gradient (linear/radial/cone/dome), Shape, Noise (fBm/ridged/billow with domain warp), Voronoi/Cellular, File (PNG16, R16, R32, EXR, TIFF16/32), Mountain, Ridge, Island, Paint (brush strokes -> height or mask) |
| Shape / filter | Adjust (multiply, bias/gain, clamp, clip, invert, autolevel, equalise), Remap/Curve, Blur, Sharpen, Warp, Directional/Slope Warp, Transform (move/rotate/scale + blend), Terrace, Edge fade, Distance field, Dilate/Erode, Median/Denoise, Flip |
| Combine / route | Combine (blend modes + mask + clamp option), Mask (post-mask), Layers, Switch/Route, portals + reroute, Math expression |
| Simulate | Hydraulic Erosion (Erosion2-class; outputs Flow, Wear, Deposits; inputs mask, precipitation, hardness), Thermal (Wear, Deposits), Rivers (headwaters mask and spline input; outputs mask, depth, surface, direction), Lake (water, depth, shore), Sea (water, depth, shore, coastal shaping), Snow (mask, depth), Deposit/Sediment fill, Depression fix |
| Derive | Height, Slope, Curvature, Aspect, Peaks, Flow accumulation, Occlusion/AO, Normals, Soil/wetness, Texture base (composite) |
| Colour | Gradient map (CLUT), palette library, HSL, Mixer (layer stack with height/slope masks), RGB merge/split, ColorErosion-lite (advect colour along flow) |
| Output | Export (formats above), **Unreal Landscape** (below), Weight Set (normalise N masks so they sum to 1; first layer = remainder) |

**Unreal Landscape output (the differentiator)**

- Sizes: 127, 253, 505, 1009, 2017, 4033, 8129 (same list as Gaea's node).
- `H_<name>.png` 16-bit greyscale; `W_<layer>.png` 8-bit greyscale per layer, normalised; optional colour map; all square, same size.
- Sidecar `<name>.orogen.json` with: `resolution`, `widthM`, `heightMinM`, `heightMaxM`, `ueScaleXY = widthM*100/(resolution-1)`, `ueScaleZ = (heightMaxM-heightMinM)*100/512`, `ueLocationZcm = (heightMinM + (heightMaxM-heightMinM)/2)*100`, layer list in order, file hashes. Global (not per-tile) min/max.
- Also write a Gaea-compatible `definition.json` (`ID, Resolution, ScaleX, ScaleY, ScaleZ, Height, Unit`) only if we decide to interoperate with Gaea2Unreal; field semantics are inferred, so test before relying on it.
- Show the three UE numbers in the UI so a manual "Import from File" always works; importer automation should be a script, not an engine-version-locked C++ plugin (to be validated by the UE research).

**Viewport / UX**

3D view (orbit + fly) with clay and textured modes; 2D view; preview resolution selector 512-4096 with progressive refinement; pin (lock) preview; underlay for masks with palette choice and autolevel toggle; height picker (metres / 0..1) and distance tool; per-node stats (min, max, time, memory); A/B compare.

**Graph**

Search-create with short codes, insert on wire, drag-out suggestions, groups, notes, portals, bypass, presets, undo history, autosave + crash recovery, mark-for-export, per-node modifiers (Autolevel, Clamp, Height Remap, Blur, Invert, Min, Max, mask by height/slope).

### SHOULD have (v1.x)

- Nodes: Stratify / Sandstone-style layered rock, Outcrops / Craggy / Rockscape, Stones / Scree, particle Debris, Dunes + sand solver, Dusting, Snowfield, Glacier, Trees/vegetation density, Weathering, Crater, CraterField, Volcano, Canyon, MountainRange, Slump, Transpose/Embed/Insert, Bomber (stamp scatter), Repeat, Seamless, Filter/GraphicEQ, Recurve, ThermalShaper-style fast shaper, Splat packer (RGBA), Mesher (glTF/OBJ), Point cloud for foliage/PCG.
- Vector layer: splines for rivers and roads, polygons for lakes and plateaus (the feature Gaea 2 lacks and both rivals have).
- Variables bound to parameters, expressions, variation sets ("mutations") with contact sheet.
- Regions (render a rectangle at higher density), macros/subgraphs, loops.
- Orographic precipitation and rain shadow for erosion; water-aware erosion.
- UE re-sync that keeps edit layers; PCG-ready point outputs.

### NICE to have (later)

Tiled builds beyond 8129 with halo padding and resumable export; World Partition tile naming presets; Lichtenberg, Anastomosis, Crumble, IceFloe, Meshify, Origami, Pixelate, Whorl, WaveShine; cartography / halftone / hillshade / baked-lighting renders; sunlight (insolation) map; mesh-to-heightfield import; real-world DEM import helper (GeoTIFF, nodata handling, Match); Unity sizes; Houdini bridge; predictive node suggestions; user compute-shader node (WGSL "Code" node, cf. World Machine); localisation.

---

## Open questions (could not settle)

1. Gaea parameter **ranges and defaults** for every node (not published). If parity presets matter, they must be read from a licensed install (`<install>\Examples\*.terrain` store non-default values only).
2. Exact contents and file name of Gaea's Unreal **definition JSON** (sample values; whether `Height` is the autolevelled range or the Terrain Definition height; what `ScaleZ` and `Unit` hold).
3. Whether Gaea's `Usage` metadata is telemetry, example-file counts or something else.
4. Semantics of `IsSoftData`, `NoErosion`, `DepositionBoost`, Sediments `Type/Style`, Glacier parameters.
5. Whether Build Swarm has any multi-machine mode (nothing documented).
6. Port lists for nodes not present in the third-party scans (e.g. Dusting, Shrubs, Scree in 2.3, Debris removal input name).
7. State of Gaea2Unreal for UE 5.8 beyond "open issue, compile yourself"; whether community forks exist.
8. Reddit/Polycount sentiment (not retrievable this session).
9. Instant Terra's current status; World Creator bridge support for UE 5.8.
10. WebGPU limit values quoted above need confirmation against the Dawn build we ship.

## Source index

- Gaea docs repo (all `source/...` paths): https://github.com/QuadSpinner/Gaea2-Docs ; site https://docs.gaea.app ; node map https://docs.gaea.app/reference/node-map.html
- Release notes: `source/history/gaea-2.2/2.2.0.0.md`, `source/history/gaea-2.3/2.3.0.0.md`; https://blog.quadspinner.com/gaea-2-2-released/ ; https://blog.quadspinner.com/gaea-2-3-now-available/ ; https://quadspinner.com/download
- Vendor pages: https://quadspinner.com/Order ; https://quadspinner.com/FAQ ; https://quadspinner.com/gaea3 ; `source/blog/11-2025/terrain-app1.md` ; `source/blog/11-2025/what-happens-to-gaea-2-0.md`
- Gaea2Unreal: https://github.com/QuadSpinner/Gaea2Unreal (files `src/GaeaUnrealTools.uplugin`, `src/Source/GaeaUEToolsEditor/Public/GaeaSubsystem.h`, `.../Public/ImporterPanelSettings.h`, `.../Private/GaeaSubsystem.cpp`); issues https://github.com/QuadSpinner/Gaea2Unreal/issues
- Forum: https://talk.gaea.app (threads cited inline); Unreal forum threads cited inline
- Third-party: https://github.com/yushimatenjin/gaea-mcp/blob/main/src/node-types.ts ; https://github.com/aguai2018/gaea-mcp/tree/main/skill/gaea-terrain/reference
- Rivals: https://docs.world-creator.com (index https://docs.world-creator.com/llms.txt) ; https://www.world-creator.com/en/features.phtml ; https://www.world-machine.com/features.php ; https://www.world-machine.com/purchase.php ; https://help.world-machine.com/topics/releases/ ; https://www.sidefx.com/docs/houdini/heightfields/index.html ; https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_erode.html ; https://www.sidefx.com/docs/houdini/unreal/landscape/index.html ; https://www.wysilab.com ; https://www.wysilab.com/Editions_Pricing.html

