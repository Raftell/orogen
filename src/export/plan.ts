// Planning a build (export-unreal.md 2.3, 2.5, 2.6, 3.3): which export items a document declares, whether they
// can be built, and every file a complete build writes. Pure and synchronous: no Node module, no GPU, no I/O.

import type { ExportContext, ExportItem, ExportSource, ImageItem, LandscapeItem, LayerItem, NodeDef, ParamValue, TextureItem } from '../core/api.ts';
import {
  normalizeParams,
  type BuildPlan, type BuildProblem, type BuildProblemCode, type Edge, type FileEncoding, type GraphDoc, type NodeRegistry,
  type PlannedFile, type PlannedLayer,
} from '../core/runtime.ts';
import { landscapeLayout, nearestLandscapeSizes, textureSide } from './unreal.ts';

// ---- 2.6 file names ----------------------------------------------------------------------------------------------

/** Removes every character that is not an ASCII letter, then upper-cases the first character. */
export function lettersOnly(text: string): string {    // 'alps 01 (wet)' -> 'Alpswet'
  const letters = String(text).replace(/[^A-Za-z]/g, '');
  return letters.charAt(0).toUpperCase() + letters.slice(1);
}
/** Removes every character that is not an ASCII letter or digit. */
export function alnumOnly(text: string): string {      // 'Rock_Wet 2' -> 'RockWet2'
  return String(text).replace(/[^A-Za-z0-9]/g, '');
}

/** The pattern of a target layer's name (2.2). */
export const LAYER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const NAME_MAX = 64;
/**
 * The base names Windows reads as devices whatever follows the first dot: `Con.orogen.json` and `NUL.r16` cannot
 * be made there, or opened. Ignoring case.
 */
export const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** `Name` of a build without a landscape item. */
const NAME_WITHOUT_LANDSCAPE = 'Export';
const WEIGHT_BLENDED_MAX = 15;
const LAYERS_WARNED_ABOVE = 12;

export const heightFiles = (name: string): { readonly png: string; readonly r16: string } => ({ png: `${name}Height.png`, r16: `${name}Height.r16` });
export const layerFiles = (layer: string): { readonly png: string; readonly r8: string } => ({ png: `Layer${lettersOnly(layer)}.png`, r8: `Layer${lettersOnly(layer)}.r8` });
export const textureFile = (item: TextureItem, resolution: number): string => `T_${alnumOnly(item.name)}_${textureSide(item.size, resolution)}.png`;
export const manifestFile = (name: string): string => `${name}.orogen.json`;
export const reportFile = (name: string): string => `${name}.report.json`;

const IMAGE_FORMATS: Readonly<Record<ImageItem['format'], { readonly ext: string; readonly encoding: FileEncoding }>> = {
  png8: { ext: 'png', encoding: 'png-gray8' },
  png16: { ext: 'png', encoding: 'png-gray16' },
  r16: { ext: 'r16', encoding: 'raw-u16' },
  r32: { ext: 'r32', encoding: 'raw-f32' },
  exr: { ext: 'exr', encoding: 'exr-f32' },
  tiff16: { ext: 'tif', encoding: 'tiff-u16' },
  tiff32: { ext: 'tif', encoding: 'tiff-f32' },
};
export const imageFile = (item: ImageItem): string => `${alnumOnly(item.name)}.${IMAGE_FORMATS[item.format].ext}`;
export const imageEncoding = (format: ImageItem['format']): FileEncoding => IMAGE_FORMATS[format].encoding;
export const textureEncoding = (item: TextureItem): FileEncoding => (item.content === 'mask' ? (item.bits === 16 ? 'png-gray16' : 'png-gray8') : 'png-rgb8');

/** Rows per strip of a TIFF file (4.6). */
export const TIFF_ROWS_PER_STRIP = 64;
/** The offset of the samples in a TIFF file of `height` rows: 146 with one strip, else behind the two strip tables. */
export function tiffDataOffset(height: number): number {
  const strips = Math.ceil(height / TIFF_ROWS_PER_STRIP);
  return strips === 1 ? 146 : 146 + 8 * strips;
}
/** The offset of the chunk offset table in an OpenEXR file of 4.5, whatever the image size. */
export const EXR_HEADER_BYTES = 277;

/** The exact size of a file whose encoding states it in advance (4.2); null for PNG and JSON. */
export function encodedBytes(encoding: FileEncoding, width: number, height: number): number | null {
  switch (encoding) {
    case 'raw-u8': return width * height;
    case 'raw-u16': return 2 * width * height;
    case 'raw-f32': return 4 * width * height;
    case 'exr-f32': return EXR_HEADER_BYTES + height * (16 + 4 * width);
    case 'tiff-u16': return tiffDataOffset(height) + 2 * width * height;
    case 'tiff-f32': return tiffDataOffset(height) + 4 * width * height;
    default: return null;
  }
}

// ---- 2.3 rules for export nodes ----------------------------------------------------------------------------------

/** The source of a function without comments and white space: `evaluate(){}` for an empty method. */
function bareSource(fn: unknown): string {
  return Function.prototype.toString.call(fn).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
}

/** The rules of 2.3 a definition breaks; empty for a valid export node. */
export function checkExportNode(def: NodeDef): string[] {
  const out: string[] = [];
  if (def.category !== 'io' || !def.type.startsWith('io/export-')) {
    out.push(`an export node has the category "io" and a type that begins with "io/export-", not "${def.type}"`);
  }
  if (def.outputs.length !== 0) out.push('an export node has no outputs');
  if (def.kernels.length !== 0) out.push('an export node lists no kernels');
  if (typeof def.evaluate !== 'function' || !/^(async)?(function)?(evaluate)?\(\)(=>)?\{\}$/.test(bareSource(def.evaluate))) {
    out.push('the evaluate of an export node is "evaluate() {}": it is never called');
  }
  if ((def.cpuTasks ?? []).length !== 0) out.push('an export node lists no cpuTasks');
  if (def.maskable) out.push('an export node is not maskable');
  if (def.resolutionDependent) out.push('an export node is not resolutionDependent');
  if ((def.uses ?? []).length !== 0) out.push('an export node uses no project setting');
  if (def.externalKey !== undefined) out.push('an export node has no externalKey');
  if (def.params.some((param) => param.kind === 'seed')) out.push('an export node has no seed param');
  const first = def.params[0];
  if (!first || first.kind !== 'bool' || first.name !== 'enabled' || first.label !== 'Enabled' || first.default !== true) {
    out.push('the first parameter of an export node is the bool "enabled" with the label "Enabled" and the default true');
  }
  const input = def.inputs[0];
  if (!input || input.name !== 'in' || input.optional === true) out.push('inputs[0] of an export node is named "in" and is required');
  if (typeof def.export !== 'function') out.push('an export node has an export hook');
  return out;
}

// ---- edges -------------------------------------------------------------------------------------------------------

/**
 * The edge the evaluator uses for an input (runtime.md 4.3 rule 5): the first edge of doc.edges, in record order,
 * into that input whose source is an output of an existing node of a known type. null: the input is unconnected.
 */
export function edgeInto(doc: GraphDoc, registry: NodeRegistry, node: string, input: string): Edge | null {
  for (const edge of Object.values(doc.edges)) {
    if (edge?.to?.node !== node || edge.to.port !== input || edge.from?.node === node) continue;
    const source = Object.hasOwn(doc.nodes, edge.from.node) ? doc.nodes[edge.from.node] : undefined;
    const def = source ? registry.get(source.type) : undefined;
    if (def?.outputs.some((port) => port.name === edge.from.port)) return edge;
  }
  return null;
}

// ---- 3.3 the plan ------------------------------------------------------------------------------------------------

/** engine.md 1.5: 1009, 2017, 4033, 8129, or an integer B with 129 <= B <= 8192 and (B − 1) divisible by 16. */
export function isBuildResolution(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 129 && n <= 8192 && (n - 1) % 16 === 0;
}

const ERRORS: ReadonlySet<BuildProblemCode> = new Set<BuildProblemCode>([
  'E_NOTHING_TO_EXPORT', 'E_INPUT_MISSING', 'E_HOOK_FAILED', 'E_RESOLUTION', 'E_SIZE_NOT_LANDSCAPE', 'E_SEVERAL_LANDSCAPES',
  'E_LAYER_WITHOUT_LANDSCAPE', 'E_NAME_INVALID', 'E_LAYER_NAME_INVALID', 'E_LAYER_NAME_DUPLICATE', 'E_TOO_MANY_LAYERS', 'E_RANGE_INVALID',
  'E_FORMAT_INVALID', 'E_FILE_COLLISION',
]);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (v: unknown, min: number, max: number): boolean => finite(v) && v >= min && v <= max;
const integerWithin = (v: unknown, min: number, max: number): boolean => within(v, min, max) && Number.isInteger(v);
const oneOf = (v: unknown, values: readonly unknown[]): boolean => values.includes(v);
/** UTF-16 code unit order, which is how `<` compares strings. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Collected {
  readonly nodeId: string;
  readonly title: string;
  readonly def: NodeDef;
  readonly item: ExportItem;
}

/** Why a value the hook returned is no item of 2.2, or null. */
function notAnItem(item: unknown, nodeId: string, sources: ReadonlySet<string>): string | null {
  if (typeof item !== 'object' || item === null) return 'returned something that is no export item';
  const { kind, source } = item as { kind?: unknown; source?: unknown };
  if (!oneOf(kind, ['landscape', 'layer', 'texture', 'image'])) return `returned an item of the unknown kind ${JSON.stringify(kind)}`;
  const { node, input } = (source ?? {}) as { node?: unknown; input?: unknown };
  if (node !== nodeId || typeof input !== 'string' || !sources.has(input)) return 'returned an item whose source does not come from ctx.source() of the same call';
  return null;
}

/** The members of one item that break a rule of the table in 2.2, each with its problem code. */
function itemProblems(c: Collected): { readonly code: BuildProblemCode; readonly message: string }[] {
  const out: { code: BuildProblemCode; message: string }[] = [];
  const fail = (code: BuildProblemCode, message: string): void => { out.push({ code, message }); };
  /** `whole`: the cleaned name is the whole base name of a file (`<Name>.orogen.json`, `<name>.png`), which Windows then reads as a device. */
  const named = (text: unknown, clean: (text: string) => string, of: string, whole: boolean): void => {
    const cleaned = typeof text === 'string' ? clean(text) : '';
    const length = cleaned.length;
    if (length < 1 || length > NAME_MAX) {
      fail('E_NAME_INVALID', `${c.title}: the name ${JSON.stringify(text)} leaves ${length === 0 ? 'nothing' : `${length} characters`} for a file name; ${of} are needed`);
    } else if (whole && WINDOWS_DEVICE.test(cleaned)) {
      fail('E_NAME_INVALID', `${c.title}: the name ${JSON.stringify(text)} gives the file name ${cleaned}, which Windows keeps for a device and cannot open as a file; choose another name`);
    }
  };
  const inputType = c.def.inputs.find((port) => port.name === c.item.source.input)?.type;

  switch (c.item.kind) {
    case 'landscape': {
      const item: LandscapeItem = c.item;
      named(item.name, lettersOnly, '1 to 64 ASCII letters', true);
      const range = item.range as { mode?: unknown; headroom?: unknown; min?: unknown; max?: unknown } | null;
      if (range?.mode === 'measured') {
        if (!within(range.headroom, 0, 1)) fail('E_RANGE_INVALID', `${c.title}: the headroom ${String(range.headroom)} is not within 0..1`);
      } else if (range?.mode === 'fixed') {
        if (!finite(range.min) || !finite(range.max) || !(range.max > range.min)) {
          fail('E_RANGE_INVALID', `${c.title}: the fixed height range ${String(range.min)} to ${String(range.max)} is empty; the maximum must be above the minimum`);
        }
      } else fail('E_RANGE_INVALID', `${c.title}: the height range is neither measured nor fixed`);
      if (typeof item.baseLayer !== 'string' || !LAYER_NAME.test(item.baseLayer)) {
        fail('E_LAYER_NAME_INVALID', `${c.title}: the base layer name ${JSON.stringify(item.baseLayer)} is not a layer name: a letter, then up to 62 letters, digits and underscores`);
      }
      const wp = item.worldPartition as { enabled?: unknown; gridSize?: unknown; regionSize?: unknown } | null;
      const broken = typeof item.dither !== 'boolean' ? 'dither'
        : !oneOf(item.zeroAt, ['seaLevel', 'bottom']) ? 'zeroAt'
        : !oneOf(item.origin, ['center', 'corner']) ? 'origin'
        : !oneOf(item.layerBlend, ['advanced', 'final']) ? 'layerBlend'
        : !within(item.layerFloor, 0, 0.25) ? 'layerFloor (0..0.25)'
        : !integerWithin(item.layerLimit, 0, 16) ? 'layerLimit (an integer 0..16)'
        : typeof wp?.enabled !== 'boolean' ? 'worldPartition.enabled'
        : !integerWithin(wp.gridSize, 1, 16) ? 'worldPartition.gridSize (an integer 1..16)'
        : !integerWithin(wp.regionSize, 4, 64) ? 'worldPartition.regionSize (an integer 4..64)'
        : inputType !== 'field' ? 'source (a field)'
        : null;
      if (broken) fail('E_FORMAT_INVALID', `${c.title}: the landscape item has an invalid ${broken}`);
      break;
    }
    case 'layer': {
      const item: LayerItem = c.item;
      if (typeof item.layer !== 'string' || !LAYER_NAME.test(item.layer)) {
        fail('E_LAYER_NAME_INVALID', `${c.title}: ${JSON.stringify(item.layer)} is not a layer name: a letter, then up to 62 letters, digits and underscores`);
      }
      const broken = typeof item.weightBlended !== 'boolean' ? 'weightBlended' : inputType !== 'field' ? 'source (a field)' : null;
      if (broken) fail('E_FORMAT_INVALID', `${c.title}: the layer item has an invalid ${broken}`);
      break;
    }
    case 'texture': {
      const item: TextureItem = c.item;
      named(item.name, alnumOnly, '1 to 64 ASCII letters and digits', false);
      // A colour texture and a data texture are both made of a colour field: the first holds colour, the second three channels of data.
      const wanted = item.content === 'color' || item.content === 'data' ? 'color' : 'field';
      const broken = !oneOf(item.content, ['color', 'data', 'mask', 'normal']) ? 'content'
        : !oneOf(item.size, ['auto', 1024, 2048, 4096, 8192]) ? 'size'
        : !oneOf(item.bits, [8, 16]) ? 'bits'
        : item.bits === 16 && item.content !== 'mask' ? 'bits (16 only for a mask)'
        : inputType !== wanted ? `source (a ${wanted})`
        : null;
      if (broken) fail('E_FORMAT_INVALID', `${c.title}: the texture item has an invalid ${broken}`);
      break;
    }
    case 'image': {
      const item: ImageItem = c.item;
      named(item.name, alnumOnly, '1 to 64 ASCII letters and digits', true);
      const broken = !Object.hasOwn(IMAGE_FORMATS, item.format) ? 'format' : !oneOf(item.map, ['unit', 'measured']) ? 'map' : inputType !== 'field' ? 'source (a field)' : null;
      if (broken) fail('E_FORMAT_INVALID', `${c.title}: the image item has an invalid ${broken}`);
      break;
    }
  }
  return out;
}

/** Collects and validates the export items of a document and derives every file. It collects every problem it finds. */
export function planBuild(doc: GraphDoc, registry: NodeRegistry, opts?: { resolution?: number }): BuildPlan {
  const problems: BuildProblem[] = [];
  const fail = (code: BuildProblemCode, message: string, nodeId?: string): void => {
    problems.push({ severity: ERRORS.has(code) ? 'error' : 'warning', code, message, ...(nodeId !== undefined ? { nodeId } : {}) });
  };

  // 1. The resolution.
  const resolution = opts?.resolution ?? doc.settings.buildResolution;
  const resolutionValid = isBuildResolution(resolution);
  if (!resolutionValid) {
    fail('E_RESOLUTION', `The build resolution ${String(resolution)} is not valid: it is 1009, 2017, 4033 or 8129, or a whole number from 129 to 8192 one above a multiple of 16.`);
  }

  // 2. The enabled export nodes, in ascending order of node id, and what their hooks declare.
  const collected: Collected[] = [];
  for (const nodeId of Object.keys(doc.nodes).sort(byText)) {
    const instance = doc.nodes[nodeId]!;
    const def = registry.get(instance.type);
    if (!def || typeof def.export !== 'function') continue;
    const title = typeof instance.title === 'string' && instance.title !== '' ? instance.title : def.title;
    const normal = normalizeParams(def, instance.params);
    if (normal.error !== null) {
      fail('E_HOOK_FAILED', `${title}: ${normal.error}.`, nodeId);
      continue;
    }
    if (Object.hasOwn(normal.values, 'enabled') && normal.values.enabled === false) continue;
    const violations = checkExportNode(def);
    if (violations.length > 0) {
      fail('E_HOOK_FAILED', `${title}: the node type ${def.type} breaks the rules for export nodes: ${violations[0]}.`, nodeId);
      continue;
    }
    if (edgeInto(doc, registry, nodeId, 'in') === null) {
      fail('E_INPUT_MISSING', `${title}: nothing is connected to its input, so it has nothing to export.`, nodeId);
      continue;
    }

    const sources = new Set<string>();
    const connected = (input: string): boolean => def.inputs.some((port) => port.name === input) && edgeInto(doc, registry, nodeId, input) !== null;
    const ctx: ExportContext = {
      params: normal.values as Readonly<Record<string, ParamValue>>,
      nodeId, title, connected,
      source(input: string): ExportSource {
        if (!connected(input)) throw new Error(`the input "${input}" is not connected`);
        sources.add(input);
        return { node: nodeId, input };
      },
    };
    let items: unknown;
    try {
      items = def.export(ctx);
    } catch (thrown) {
      fail('E_HOOK_FAILED', `${title}: its export declaration failed: ${thrown instanceof Error ? thrown.message : String(thrown)}.`, nodeId);
      continue;
    }
    if (!Array.isArray(items)) {
      fail('E_HOOK_FAILED', `${title}: its export declaration returned no list of items.`, nodeId);
      continue;
    }
    const broken = items.map((item) => notAnItem(item, nodeId, sources)).find((why) => why !== null);
    if (broken) {
      fail('E_HOOK_FAILED', `${title}: its export declaration ${broken}.`, nodeId);
      continue;
    }
    for (const item of items as ExportItem[]) collected.push({ nodeId, title, def, item });
  }

  // 3. The rules of 2.2 for each item, and the rules of 2.5 across items.
  for (const c of collected) {
    for (const problem of itemProblems(c)) fail(problem.code, `${problem.message}.`, c.nodeId);
  }
  const landscapes = collected.filter((c): c is Collected & { item: LandscapeItem } => c.item.kind === 'landscape');
  const layerItems = collected.filter((c): c is Collected & { item: LayerItem } => c.item.kind === 'layer');
  const landscape = landscapes[0] ?? null;
  if (collected.length === 0) {
    fail('E_NOTHING_TO_EXPORT', 'A build would write nothing: the project has no enabled export node that declares a file.');
  }
  if (landscapes.length > 1) {
    fail('E_SEVERAL_LANDSCAPES', `A build has one landscape, and ${landscapes.length} nodes export one: ${landscapes.map((c) => c.title).join(', ')}.`, landscapes[1]!.nodeId);
  }
  if (!landscape) {
    for (const c of layerItems) fail('E_LAYER_WITHOUT_LANDSCAPE', `${c.title}: a landscape layer belongs to a landscape, and no enabled node exports one.`, c.nodeId);
  }

  const blended = layerItems.filter((c) => c.item.weightBlended === true);
  const masks = layerItems.filter((c) => c.item.weightBlended !== true);
  const hasBase = landscape !== null && blended.length > 0;
  if (blended.length > WEIGHT_BLENDED_MAX) {
    fail('E_TOO_MANY_LAYERS', `${blended.length} weight-blended layers are exported; a landscape takes at most ${WEIGHT_BLENDED_MAX} beside its base layer.`, blended[WEIGHT_BLENDED_MAX]!.nodeId);
  }
  // Layer names are unique ignoring case, the base layer among them.
  const seen = new Map<string, string>();
  /** The layer nodes whose name is another layer's: their files collide for that one reason, which is said once. */
  const duplicateLayers = new Set<string>();
  if (hasBase && typeof landscape.item.baseLayer === 'string') seen.set(landscape.item.baseLayer.toLowerCase(), `the base layer of ${landscape.title}`);
  for (const c of layerItems) {
    if (typeof c.item.layer !== 'string') continue;
    const key = c.item.layer.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      fail('E_LAYER_NAME_DUPLICATE', `${c.title}: the layer name "${c.item.layer}" is also used by ${first}; layer names differ by more than case.`, c.nodeId);
      duplicateLayers.add(c.nodeId);
    } else seen.set(key, c.title);
  }

  const layout = landscape && resolutionValid ? landscapeLayout(resolution) : null;
  if (landscape && resolutionValid && layout === null) {
    const { below, above } = nearestLandscapeSizes(resolution);
    const nearest = [below, above].filter((size) => size !== null).join(' and ');
    fail('E_SIZE_NOT_LANDSCAPE', `${landscape.title}: ${resolution} x ${resolution} is not a size an Unreal landscape can have; the nearest valid build resolutions are ${nearest}.`, landscape.nodeId);
  }

  // 4. Processing order.
  const layerOrder = (a: Collected & { item: LayerItem }, b: Collected & { item: LayerItem }): number =>
    byText(String(a.item.layer).toLowerCase(), String(b.item.layer).toLowerCase()) || byText(a.nodeId, b.nodeId);
  blended.sort(layerOrder);
  masks.sort(layerOrder);
  const safeResolution = resolutionValid ? resolution : 0;
  const textures = collected
    .filter((c): c is Collected & { item: TextureItem } => c.item.kind === 'texture')
    .map((c) => ({ c, file: oneOf(c.item.size, ['auto', 1024, 2048, 4096, 8192]) ? textureFile(c.item, safeResolution) : `T_${alnumOnly(String(c.item.name))}_.png` }))
    .sort((a, b) => byText(a.file, b.file) || byText(a.c.nodeId, b.c.nodeId));
  const images = collected
    .filter((c): c is Collected & { item: ImageItem } => c.item.kind === 'image')
    .map((c) => ({ c, file: Object.hasOwn(IMAGE_FORMATS, c.item.format) ? imageFile(c.item) : alnumOnly(String(c.item.name)) }))
    .sort((a, b) => byText(a.file, b.file) || byText(a.c.nodeId, b.c.nodeId));
  const ordered: Collected[] = [...landscapes, ...blended, ...masks, ...textures.map((t) => t.c), ...images.map((i) => i.c)];

  // 6. The layers: the base, the weight-blended ones, the others.
  const blend = landscape?.item.layerBlend === 'final' ? 'final' : 'advanced';
  const layers: PlannedLayer[] = [];
  if (hasBase) layers.push({ name: landscape.item.baseLayer, blend, base: true, nodeId: null });
  for (const c of blended) layers.push({ name: c.item.layer, blend, base: false, nodeId: c.nodeId });
  for (const c of masks) layers.push({ name: c.item.layer, blend: 'none', base: false, nodeId: c.nodeId });
  if (layers.length > LAYERS_WARNED_ABOVE) {
    fail('W_MANY_LAYERS', `The landscape has ${layers.length} layers, the base layer included; more than ${LAYERS_WARNED_ABOVE} is reported to exceed what a landscape component can shade.`);
  }
  if (landscape && layout) {
    const wp = landscape.item.worldPartition;
    if (integerWithin(wp?.gridSize, 1, 16) && layout.components % wp.gridSize !== 0) {
      fail('W_GRID_SIZE', `${landscape.title}: the landscape has ${layout.components} components a side, which is not a multiple of the World Partition grid size ${wp.gridSize}.`, landscape.nodeId);
    }
    if (wp?.regionSize === 4) {
      fail('W_REGION_SIZE', `${landscape.title}: a World Partition region size of 4 is reported to fail in Unreal Engine; 5 or more is safer.`, landscape.nodeId);
    }
  }

  // 5. The files, and collisions among them.
  const letters = landscape && typeof landscape.item.name === 'string' ? lettersOnly(landscape.item.name) : '';
  const name = letters.length >= 1 && letters.length <= NAME_MAX ? letters : NAME_WITHOUT_LANDSCAPE;
  const files: PlannedFile[] = [];
  const owners: string[] = [];
  const add = (path: string, encoding: FileEncoding, width: number, height: number, nodeId: string | null, owner: string): void => {
    files.push({ path, encoding, width, height, bytes: encodedBytes(encoding, width, height), nodeId });
    owners.push(owner);
  };
  if (landscape) {
    const paths = heightFiles(name);
    add(paths.png, 'png-gray16', safeResolution, safeResolution, landscape.nodeId, landscape.title);
    add(paths.r16, 'raw-u16', safeResolution, safeResolution, landscape.nodeId, landscape.title);
    for (const layer of layers) {
      if (typeof layer.name !== 'string') continue;
      const paths8 = layerFiles(layer.name);
      const owner = layer.nodeId === null ? `the base layer of ${landscape.title}` : collected.find((c) => c.nodeId === layer.nodeId)!.title;
      add(paths8.png, 'png-gray8', safeResolution, safeResolution, layer.nodeId, owner);
      add(paths8.r8, 'raw-u8', safeResolution, safeResolution, layer.nodeId, owner);
    }
  }
  for (const { c, file } of textures) {
    const side = oneOf(c.item.size, ['auto', 1024, 2048, 4096, 8192]) ? textureSide(c.item.size, safeResolution) : 0;
    add(file, textureEncoding(c.item), side, side, c.nodeId, c.title);
  }
  for (const { c, file } of images) {
    add(file, Object.hasOwn(IMAGE_FORMATS, c.item.format) ? imageEncoding(c.item.format) : 'raw-f32', safeResolution, safeResolution, c.nodeId, c.title);
  }
  add(manifestFile(name), 'json', 0, 0, null, 'the manifest');
  // The report is no planned file, and it has a name of its own, which nothing else may take.
  const taken = new Map<string, string>([[reportFile(name).toLowerCase(), 'the build report']]);
  for (const [i, file] of files.entries()) {
    const key = file.path.toLowerCase();
    const first = taken.get(key);
    if (first !== undefined) {
      if (file.nodeId !== null && duplicateLayers.has(file.nodeId)) continue;
      fail('E_FILE_COLLISION', `${owners[i]} and ${first} would both write the file ${file.path}; give them names that differ in letters.`, file.nodeId ?? undefined);
    } else taken.set(key, owners[i]!);
  }

  const known = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
  return {
    ok: !problems.some((problem) => problem.severity === 'error'),
    resolution,
    name,
    items: ordered.map((c) => ({ nodeId: c.nodeId, item: c.item })),
    targets: ordered.map((c) => c.item.source),
    layout,
    layers,
    files,
    problems,
    estimate: { planeBytes: blended.length * safeResolution * safeResolution * 2, knownFileBytes: known },
  };
}
