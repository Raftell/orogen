// The plan of a build as the panel lays it out (export-unreal.md 3.3): every export target with its files,
// their format and size, and what the document says of its export nodes before the engine has planned anything.
// The panel never plans: the plan is the one the pipeline sent in `build-plan` (3.1). No DOM and no React.

import {
  normalizeParams,
  type BuildPlan, type BuildProblem, type ExportItem, type FileEncoding, type GraphDoc, type NodeRegistry, type PlannedFile,
} from '../../../../core/runtime.ts';
import { describeLayout } from './sizes.ts';

/** How a file is encoded, in the words of the user documentation (building.md, section 6). */
export const ENCODING_LABEL: Readonly<Record<FileEncoding, string>> = {
  'png-gray8': 'PNG, 8-bit gray',
  'png-gray16': 'PNG, 16-bit gray',
  'png-rgb8': 'PNG, 8-bit RGB',
  'raw-u8': 'Raw, 8-bit',
  'raw-u16': 'Raw, 16-bit',
  'raw-f32': 'Raw, 32-bit float',
  'exr-f32': 'OpenEXR, 32-bit float',
  'tiff-u16': 'TIFF, 16-bit',
  'tiff-f32': 'TIFF, 32-bit float',
  'json': 'JSON',
};

export interface PlanFileView {
  readonly path: string;
  readonly format: string;
  /** '1009 × 1009'; '' for a file that is no image. */
  readonly pixels: string;
  /** The exact size where the encoding fixes it; null for a PNG and for JSON, whose size is known when it is written. */
  readonly bytes: number | null;
}

export type PlanTargetKind = ExportItem['kind'] | 'base' | 'manifest';

export interface PlanTargetView {
  readonly key: string;
  readonly kind: PlanTargetKind;
  /** The export node; null for the base layer and the manifest, which no node of their own declares. */
  readonly nodeId: string | null;
  /** Whether `nodeId` is a node the document still holds. */
  readonly selectable: boolean;
  /** The node's title, as the pipeline names it in its problems. */
  readonly title: string;
  /** What the target is, in one line: 'Landscape Ridge', 'Layer Rock, weight-blended (advanced)'. */
  readonly detail: string;
  readonly files: readonly PlanFileView[];
}

export interface PlanView {
  /** False: the plan has an error, and a build of it stops before it computes or writes anything. */
  readonly ok: boolean;
  readonly resolution: number;
  /** The layout of the landscape as Unreal names it; null without a landscape, or for a size that has none. */
  readonly layout: string | null;
  readonly targets: readonly PlanTargetView[];
  readonly fileCount: number;
  /** The sum of the sizes that are known in advance, and how many files it leaves out. */
  readonly knownBytes: number;
  readonly unsizedFiles: number;
  /** Main memory the build holds for the weight-blended layers until they are written together (3.7). */
  readonly planeBytes: number;
}

function titleOf(doc: Pick<GraphDoc, 'nodes'>, registry: NodeRegistry, nodeId: string): string {
  const instance = Object.hasOwn(doc.nodes, nodeId) ? doc.nodes[nodeId] : undefined;
  if (!instance) return nodeId;
  return typeof instance.title === 'string' && instance.title !== '' ? instance.title : registry.get(instance.type)?.title ?? instance.type;
}

const IMAGE_FORMAT: Readonly<Record<string, string>> = {
  png8: 'PNG, 8 bits', png16: 'PNG, 16 bits', r16: 'raw, 16 bits', r32: 'raw, 32-bit float', exr: 'OpenEXR', tiff16: 'TIFF, 16 bits', tiff32: 'TIFF, 32-bit float',
};

function describeItem(item: ExportItem, plan: BuildPlan): string {
  switch (item.kind) {
    case 'landscape':
      return `Landscape ${plan.name}: heights ${item.range.mode === 'fixed' ? 'over a fixed range' : 'over the measured range'}${item.dither ? ', dithered' : ''}`;
    case 'layer': {
      const blend = plan.layers.find((layer) => layer.name === item.layer && !layer.base)?.blend ?? (item.weightBlended ? 'advanced' : 'none');
      return item.weightBlended ? `Layer ${item.layer}: weight-blended (${blend})` : `Layer ${item.layer}: an independent mask`;
    }
    case 'texture':
      return item.content === 'color' ? 'Color texture: sRGB color'
        : item.content === 'data' ? 'Data texture: three channels as they are, no sRGB'
          : item.content === 'mask' ? `Mask texture: ${item.bits} bits, no sRGB`
            : 'Normal texture: X, Y and Z in the landscape\'s axes, no sRGB';
    case 'image':
      return `Image at the build resolution: ${IMAGE_FORMAT[item.format] ?? item.format}`;
    default:
      return '';
  }
}

function viewFile(file: PlannedFile): PlanFileView {
  return {
    path: file.path,
    format: ENCODING_LABEL[file.encoding] ?? file.encoding,
    pixels: file.width > 0 && file.height > 0 ? `${file.width} × ${file.height}` : '',
    bytes: file.bytes,
  };
}

/**
 * The plan, target by target. The files of an export node are those the plan gives its node id; what is left
 * without a node is the base layer (the weights the other layers leave) and the manifest.
 */
export function viewPlan(plan: BuildPlan, doc: Pick<GraphDoc, 'nodes'>, registry: NodeRegistry): PlanView {
  // A plan without an item lists the manifest all the same, and a build never writes a manifest alone (2.5).
  if (plan.items.length === 0) {
    return { ok: plan.ok, resolution: plan.resolution, layout: null, targets: [], fileCount: 0, knownBytes: 0, unsizedFiles: 0, planeBytes: 0 };
  }
  const targets: PlanTargetView[] = [];
  const taken = new Set<PlannedFile>();
  for (const [index, { nodeId, item }] of plan.items.entries()) {
    const files = plan.files.filter((file) => file.nodeId === nodeId && !taken.has(file));
    for (const file of files) taken.add(file);
    targets.push({
      key: `${index}:${nodeId}`,
      kind: item.kind,
      nodeId,
      selectable: Object.hasOwn(doc.nodes, nodeId),
      title: titleOf(doc, registry, nodeId),
      detail: describeItem(item, plan),
      files: files.map(viewFile),
    });
  }
  const rest = plan.files.filter((file) => !taken.has(file));
  const base = plan.layers.find((layer) => layer.base);
  const baseFiles = rest.filter((file) => file.encoding !== 'json');
  if (baseFiles.length > 0) {
    // The base layer follows the landscape it belongs to, as its files do in the plan.
    const at = Math.max(0, targets.findIndex((target) => target.kind === 'landscape') + 1);
    targets.splice(at, 0, {
      key: 'base',
      kind: 'base',
      nodeId: null,
      selectable: false,
      title: base ? base.name : 'Base',
      detail: `The base layer: what the weight-blended layers leave${base ? ` (${base.blend})` : ''}. At every point the group totals 255`,
      files: baseFiles.map(viewFile),
    });
  }
  const manifest = rest.filter((file) => file.encoding === 'json');
  if (manifest.length > 0) {
    targets.push({
      key: 'manifest',
      kind: 'manifest',
      nodeId: null,
      selectable: false,
      title: 'Manifest',
      detail: 'Which file is which, and every number Unreal needs. Written last, so a folder without it is no build',
      files: manifest.map(viewFile),
    });
  }
  return {
    ok: plan.ok,
    resolution: plan.resolution,
    layout: plan.layout ? describeLayout(plan.layout) : null,
    targets,
    fileCount: plan.files.length,
    knownBytes: plan.estimate.knownFileBytes,
    unsizedFiles: plan.files.filter((file) => file.bytes === null).length,
    planeBytes: plan.estimate.planeBytes,
  };
}

// ---- before a plan exists ----------------------------------------------------------------------------------------------

export interface ExportNodeView {
  readonly nodeId: string;
  /** The node's title, the user's when it has one. */
  readonly title: string;
  /** The title of its type, when the user's title hides it: 'Unreal Landscape'. */
  readonly typeTitle: string;
  /**
   * What the node calls what it exports: the value of its first text parameter, which is the layer's name on a
   * Landscape Layer and the name of the files on the others. '' for a node that has none. It tells apart the
   * layers of a project, whose nodes bear one title and often one source.
   */
  readonly name: string;
  readonly enabled: boolean;
  /** The title of the node whose output its input `in` is wired to; null: nothing is connected. */
  readonly source: string | null;
}

const TYPE_ORDER: readonly string[] = ['io/export-landscape', 'io/export-layer', 'io/export-color', 'io/export-mask', 'io/export-normal', 'io/export-field'];

/**
 * The export nodes of the document: what a build targets (export-unreal.md 2.5). This reads the document and
 * the node definitions only. It calls no export hook and derives no file: which files a build writes, and
 * whether it can, is the plan's to say.
 */
export function exportNodes(doc: Pick<GraphDoc, 'nodes' | 'edges'>, registry: NodeRegistry): ExportNodeView[] {
  const found = Object.keys(doc.nodes).sort().filter((nodeId) => typeof registry.get(doc.nodes[nodeId]!.type)?.export === 'function');
  if (found.length === 0) return [];
  // The edge the evaluator uses for an input is the first, in record order, whose source is an output of a node
  // the document holds (runtime.md 4.3 rule 5). One pass over the edges serves every export node.
  const wanted = new Set(found);
  const sources = new Map<string, string>();
  for (const edge of Object.values(doc.edges)) {
    const to = edge?.to?.node;
    if (to === undefined || !wanted.has(to) || sources.has(to) || edge.to.port !== 'in' || edge.from?.node === to) continue;
    const from = Object.hasOwn(doc.nodes, edge.from.node) ? doc.nodes[edge.from.node] : undefined;
    if (!from || !registry.get(from.type)?.outputs.some((port) => port.name === edge.from.port)) continue;
    sources.set(to, titleOf(doc, registry, edge.from.node));
  }
  const views: (ExportNodeView & { readonly rank: number })[] = [];
  for (const nodeId of found) {
    const instance = doc.nodes[nodeId]!;
    const def = registry.get(instance.type)!;
    const params = normalizeParams(def, instance.params);
    const named = def.params.find((param) => param.kind === 'text');
    const name = named && params.error === null ? params.values[named.name] : undefined;
    const rank = TYPE_ORDER.indexOf(instance.type);
    views.push({
      nodeId,
      title: titleOf(doc, registry, nodeId),
      typeTitle: def.title,
      name: typeof name === 'string' ? name : '',
      enabled: params.error === null ? params.values.enabled !== false : true,
      source: sources.get(nodeId) ?? null,
      rank: rank < 0 ? TYPE_ORDER.length : rank,
    });
  }
  // The landscape first, then what belongs to it, then textures and images: the order a plan lists them in.
  const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  views.sort((a, b) => a.rank - b.rank || by(a.name.toLowerCase(), b.name.toLowerCase()) || by(a.title, b.title) || by(a.nodeId, b.nodeId));
  return views.map(({ rank: _rank, ...view }) => view);
}

/**
 * What the document alone settles of a plan, in the plan's own codes (export-unreal.md 2.5): a build without
 * an export node that is switched on writes nothing, and one that is switched on with nothing connected stops
 * the build. Everything else a plan checks (names, files, sizes, the layout) needs the plan: nothing here says
 * that a build will succeed, only that it will not.
 */
export function knownProblems(nodes: readonly ExportNodeView[]): BuildProblem[] {
  const active = nodes.filter((node) => node.enabled);
  if (active.length === 0) {
    return [{
      severity: 'error', code: 'E_NOTHING_TO_EXPORT',
      message: nodes.length === 0 ? 'The project has no export node, so a build would write nothing.' : 'Every export node is switched off, so a build would write nothing.',
    }];
  }
  return active.filter((node) => node.source === null).map((node) => ({
    severity: 'error', code: 'E_INPUT_MISSING', message: `${node.title}: nothing is connected to its input.`, nodeId: node.nodeId,
  }));
}
