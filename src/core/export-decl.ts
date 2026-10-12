// Pure types, and nothing else (export-unreal.md section 1). The declaration types of export nodes are
// re-exported by api.ts; the build types that cross the session boundary by runtime.ts.

import type { ParamDef, ParamsOf } from './graph/param-types.ts';
import type { PortDef } from './graph/ports.ts';

// ---- export-unreal.md 2.1 ----

/** The field connected to one input of one export node. */
export interface ExportSource {
  readonly node: string;    // node instance id
  readonly input: string;   // input port name of that node
}

export interface ExportContext<
  P extends readonly ParamDef[] = readonly ParamDef[],
  I extends readonly PortDef[] = readonly PortDef[],
> {
  /** Normalised parameter values of the instance, as in EvalContext.params. */
  readonly params: ParamsOf<P>;
  readonly nodeId: string;
  /** The instance's title when the user gave one, else the definition's title. */
  readonly title: string;
  /** Whether the input is connected. */
  connected(input: I[number]['name']): boolean;
  /** The source for a connected input. Throws an Error when the input is not connected. */
  source(input: I[number]['name']): ExportSource;
}

export type ExportHook<
  P extends readonly ParamDef[] = readonly ParamDef[],
  I extends readonly PortDef[] = readonly PortDef[],
> = (ctx: ExportContext<P, I>) => readonly ExportItem[];

// ---- export-unreal.md 2.2 ----

export type HeightRange =
  | { readonly mode: 'measured'; readonly headroom: number }
  | { readonly mode: 'fixed'; readonly min: number; readonly max: number };

/** The landscape heightmap and everything that is one per landscape. At most one per build. */
export interface LandscapeItem {
  readonly kind: 'landscape';
  readonly source: ExportSource;                 // a 'field' holding heights
  readonly name: string;
  readonly range: HeightRange;
  readonly dither: boolean;
  readonly zeroAt: 'seaLevel' | 'bottom';
  readonly origin: 'center' | 'corner';
  readonly baseLayer: string;
  readonly layerBlend: 'advanced' | 'final';
  readonly layerFloor: number;
  readonly layerLimit: number;
  readonly worldPartition: { readonly enabled: boolean; readonly gridSize: number; readonly regionSize: number };
}

/** One landscape target layer, 8 bits, at landscape resolution. */
export interface LayerItem {
  readonly kind: 'layer';
  readonly source: ExportSource;                 // a 'field' holding a mask
  readonly layer: string;                        // Unreal target layer name
  readonly weightBlended: boolean;
}

/** A companion texture for materials: power-of-two size, texel-centred. */
export interface TextureItem {
  readonly kind: 'texture';
  readonly source: ExportSource;                 // 'color' for content 'color', else 'field'
  readonly name: string;
  readonly content: 'color' | 'mask' | 'normal';
  readonly size: 'auto' | 1024 | 2048 | 4096 | 8192;
  readonly bits: 8 | 16;
}

/** A single-channel image at build resolution on the vertex grid, for other tools. */
export interface ImageItem {
  readonly kind: 'image';
  readonly source: ExportSource;                 // a 'field'
  readonly name: string;
  readonly format: 'png8' | 'png16' | 'r16' | 'r32' | 'exr' | 'tiff16' | 'tiff32';
  readonly map: 'unit' | 'measured';
}

export type ExportItem = LandscapeItem | LayerItem | TextureItem | ImageItem;

// ---- export-unreal.md 5.2 ----

export interface LandscapeLayout {
  readonly quadsPerSection: 7 | 15 | 31 | 63 | 127 | 255;
  readonly sectionsPerComponent: 1 | 2;
  readonly components: number;        // per side, 1 .. 32
  readonly totalComponents: number;   // components squared
}

// ---- export-unreal.md 3.3 ----

export type FileEncoding =
  | 'png-gray8' | 'png-gray16' | 'png-rgb8'
  | 'raw-u8' | 'raw-u16' | 'raw-f32'
  | 'exr-f32' | 'tiff-u16' | 'tiff-f32' | 'json';

export interface PlannedFile {
  readonly path: string;
  readonly encoding: FileEncoding;
  readonly width: number;                        // 0 for JSON
  readonly height: number;
  readonly bytes: number | null;                 // exact size when it is known in advance (4.4 to 4.6); null for PNG and JSON
  readonly nodeId: string | null;                // the export node; null for the base layer and the manifest
}

export interface PlannedLayer {
  readonly name: string;
  readonly blend: 'none' | 'final' | 'advanced';
  readonly base: boolean;
  readonly nodeId: string | null;
}

export type BuildProblemCode =
  | 'E_NOTHING_TO_EXPORT' | 'E_INPUT_MISSING' | 'E_HOOK_FAILED' | 'E_RESOLUTION' | 'E_SIZE_NOT_LANDSCAPE'
  | 'E_SEVERAL_LANDSCAPES' | 'E_LAYER_WITHOUT_LANDSCAPE' | 'E_NAME_INVALID' | 'E_LAYER_NAME_INVALID'
  | 'E_LAYER_NAME_DUPLICATE' | 'E_TOO_MANY_LAYERS' | 'E_RANGE_INVALID' | 'E_FORMAT_INVALID' | 'E_FILE_COLLISION'
  | 'W_MANY_LAYERS' | 'W_GRID_SIZE' | 'W_REGION_SIZE'
  | 'E_NODE_FAILED' | 'E_NON_FINITE' | 'E_WRITE_FAILED' | 'E_DEVICE_LOST' | 'E_OUT_DIR' | 'E_COMMIT_FAILED' | 'E_INTERNAL'
  | 'W_HEIGHT_CLIPPED' | 'W_FLAT' | 'W_LAYER_EMPTY';

export interface BuildProblem {
  readonly severity: 'error' | 'warning';
  readonly code: BuildProblemCode;
  readonly message: string;                      // one sentence for the user, naming the node by title
  readonly nodeId?: string;
}

export interface BuildPlan {
  readonly ok: boolean;                          // no problem of severity 'error'
  readonly resolution: number;
  readonly name: string;                         // <Name> of 2.6
  readonly items: readonly { readonly nodeId: string; readonly item: ExportItem }[];   // in processing order
  readonly targets: readonly ExportSource[];     // items[i].item.source, same order
  readonly layout: LandscapeLayout | null;       // 5.2; null without a landscape item
  readonly layers: readonly PlannedLayer[];      // base first; empty without layer items
  readonly files: readonly PlannedFile[];        // every file of a complete build, report excluded, manifest last
  readonly problems: readonly BuildProblem[];
  readonly estimate: {
    readonly planeBytes: number;                 // CPU memory held for weight-blended layers (3.7)
    readonly knownFileBytes: number;             // sum of the non-null PlannedFile.bytes
  };
}

// ---- export-unreal.md 3.1 ----

export interface BuildResult {
  readonly requestId: number;
  readonly status: 'ok' | 'errors' | 'aborted' | 'device-lost';
  readonly problems: readonly BuildProblem[];    // errors and warnings, plan problems first
  readonly files: readonly { readonly path: string; readonly bytes: number }[];   // every file made visible except the report, in the order of plan.files, the manifest last; empty unless ok
  readonly manifest: string | null;              // path of the manifest in the sink; null unless ok
  readonly report: string | null;                // path of the report in the sink; null when the plan had an error
  readonly outDir: string | null;                // buildToFolder only: the folder that holds the files
}

// ---- export-unreal.md 3.9 ----

export type BuildEvent =
  | { readonly type: 'build-plan'; readonly requestId: number; readonly plan: BuildPlan }
  | { readonly type: 'build-target'; readonly requestId: number; readonly index: number; readonly count: number;
      readonly nodeId: string; readonly label: string }
  | { readonly type: 'build-progress'; readonly requestId: number;
      readonly phase: 'targets' | 'weights' | 'commit'; readonly fraction: number }
  | { readonly type: 'build-problem'; readonly requestId: number; readonly problem: BuildProblem }
  | { readonly type: 'build-result'; readonly requestId: number; readonly result: BuildResult };
