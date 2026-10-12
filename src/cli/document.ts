// The document `render` and `gallery` evaluate (testing.md 8.6): one instance of a node type with its inputs
// wired by the rule of testing.md 2.4, which the harness's registryDoc follows too, or a project file with one
// of its nodes named. Pure: no device, no file access.

import type { NodeDef, ParamValue, PortDef } from '../core/api.ts';
import {
  addNode, connect, DocFormatError, newDoc, normalizeParams, parseDoc, setParam, setSettings,
  type DocDraft, type GraphDoc, type NodeRegistry, type PortRef, type ProjectSettings,
} from '../core/runtime.ts';
import { UsageError, type ParamArg } from './args.ts';

/** The settings of a node type's document; the others keep the defaults of a new document. */
export const RENDER_SETTINGS = { terrainSize: 4096, heightRange: 1024, seed: 1, seaLevel: 0.25 } as const satisfies Partial<ProjectSettings>;

/** What feeds the inputs of a rendered node type: realistic fractal terrains, a mask of the first, a colouring of each. */
const HEIGHTS = 'ref/fbm';
const MASKS = 'ref/slope-mask';
const COLORS = 'ref/colorize';

/**
 * The feature sizes of the terrains that feed a node, in turn. The first terrain is ref/fbm at its defaults; each
 * further one has a seed and a size of its own, so that a node with two inputs is not shown its first input twice.
 */
const TERRAIN_SIZES: readonly number[] = [0.25, 0.1, 0.5, 0.05];

/** The parameters of terrain `index` beside the defaults of ref/fbm: none for the first. */
export function terrainParams(index: number): Readonly<Record<string, ParamValue>> {
  return index === 0 ? {} : { seed: index, size: TERRAIN_SIZES[index % TERRAIN_SIZES.length]! };
}

/**
 * The mask that feeds mask inputs is a slope mask of the first terrain's broad shape: its first three octaves
 * alone, selected between these angles, which is about half the terrain, in regions. The slopes of all eight
 * octaves are speckle at the scale of a texel, and under a mask of speckle no picture shows what a node does.
 */
export const MASK_TERRAIN: Readonly<Record<string, ParamValue>> = { octaves: 3 };
export const MASK_SLOPES: Readonly<Record<string, ParamValue>> = { slopeMin: 35, slopeMax: 50 };

/** What feeds one input: terrain `index`, the mask of the first terrain, or the colouring of terrain `index`. */
export type Feed =
  | { readonly kind: 'terrain'; readonly index: number }
  | { readonly kind: 'mask' }
  | { readonly kind: 'color'; readonly index: number };

/**
 * A mask that modifies what a node does: an input of role `mask` that is optional and not the node's first
 * input. The first input is the node's subject whatever its role (the `r` of a node that packs channels).
 */
const isOptionalMask = (port: PortDef, index: number): boolean => index > 0 && port.type === 'field' && port.role === 'mask' && port.optional === true;

/** Whether the node has a masked variant: an optional mask input of its own, or the one `maskable` gives it. */
export function hasMaskedVariant(def: NodeDef): boolean {
  return def.maskable === true || def.inputs.some(isOptionalMask);
}

/**
 * The feed of every input of `def`, by port name; null: left unconnected (testing.md 2.4).
 *
 * - The k-th input that takes a height, a data field or either kind gets terrain k: each a terrain of its own.
 * - A mask input gets the mask: a slope mask of the broad shape of the first terrain. An optional one that is
 *   not the node's first input is connected in the masked variant only, and so is the `mask` of a maskable
 *   node: the plain picture shows the node's full effect, the masked one the mask acting.
 * - The k-th colour input gets the colouring of terrain k.
 */
export function inputFeeds(def: NodeDef, masked: boolean): Readonly<Record<string, Feed | null>> {
  const feeds: Record<string, Feed | null> = {};
  let terrains = 0, colors = 0;
  for (const [index, port] of def.inputs.entries()) {
    if (port.type === 'color') feeds[port.name] = { kind: 'color', index: colors++ };
    else if (port.type === 'field' && port.role === 'mask') feeds[port.name] = isOptionalMask(port, index) && !masked ? null : { kind: 'mask' };
    else feeds[port.name] = { kind: 'terrain', index: terrains++ };
  }
  if (def.maskable) feeds.mask = masked ? { kind: 'mask' } : null;
  return feeds;
}

export interface RenderPlan {
  readonly doc: GraphDoc;
  readonly nodeId: string;
  readonly type: string;
  /** null: the registry has no such type. The evaluation reports it. */
  readonly def: NodeDef | null;
  /**
   * The terrain a mask, a data field or a colour is drawn over: the output connected to the node's first height
   * input, or, for a node without one, the terrain its mask or its colour was made of. null: every output is a
   * height, or the node reads no terrain at all.
   */
  readonly terrain: PortRef | null;
  /** The document is the masked variant: optional mask inputs are connected (testing.md 2.4). */
  readonly masked: boolean;
  /** What the project file's loader reported. */
  readonly warnings: readonly string[];
}

const isHeight = (port: PortDef): boolean => port.type === 'field' && (port.role ?? 'height') === 'height';

/** Whether a picture of this output is drawn over a terrain: every output that is not itself a height. */
const drawnOverTerrain = (port: PortDef): boolean => !isHeight(port);

function listed(names: readonly string[], limit = 24): string {
  return names.length <= limit ? names.join(', ') : `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`;
}

function unknownType(registry: NodeRegistry, type: string): string {
  const types = registry.list().map((def) => def.type);
  const category = type.split('/')[0]!;
  const siblings = types.filter((known) => known.startsWith(`${category}/`));
  if (siblings.length > 0) return `Unknown node type "${type}"; the nodes of "${category}" are ${listed(siblings)}`;
  const categories = [...new Set(types.map((known) => known.split('/')[0]!))];
  return `Unknown node type "${type}"; the registry has nodes in ${listed(categories)}`;
}

/** The value normalizeParams would store differs from the one given: what is wrong with it, without what was done instead. */
function refusal(problem: string): string {
  return problem.replace(/^param "[^"]*": /, '').split(';')[0]!;
}

/**
 * One instance of `type` at its defaults, then `maxParams` (every float, int and vec2 parameter at its max),
 * then each of `params`, then `seed`. Its inputs are fed as inputFeeds says: a terrain is a ref/fbm, the mask a
 * ref/slope-mask of the first terrain's broad shape and a colour a ref/colorize of its terrain; where the
 * registry lacks one of the two, the terrain itself is connected and the evaluator converts. With `masked`, the optional mask
 * inputs are connected too. Throws UsageError for what the arguments get wrong.
 */
export function typeDocument(
  registry: NodeRegistry, type: string,
  opts: { readonly params?: readonly ParamArg[]; readonly maxParams?: boolean; readonly seed?: number | null; readonly masked?: boolean } = {},
): RenderPlan {
  const def = registry.get(type);
  if (!def) throw new UsageError(unknownType(registry, type), 'render');
  if (def.outputs.length === 0) throw new UsageError(`${type} has no outputs: there is nothing to draw`, 'render');
  if (!registry.get(HEIGHTS)) throw new Error(`The registry lacks ${HEIGHTS}, which feeds the inputs of a rendered node (testing.md 10.1)`);
  const masked = opts.masked === true;
  if (masked && !hasMaskedVariant(def)) {
    throw new UsageError(`--masked connects the optional mask inputs of a node, and ${type} has none and is not maskable`, 'render');
  }

  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, RENDER_SETTINGS);
  const nodeId = addNode(draft, registry, type, { x: 640, y: 0 });

  // One node per feed, made when an input first asks for it.
  const made = new Map<string, string>();
  const feedNode = (key: string, wiringType: string, column: number, params: Readonly<Record<string, ParamValue>>, from: string | null): string => {
    let id = made.get(key);
    if (id !== undefined) return id;
    id = addNode(draft, registry, wiringType, { x: 320 * column, y: 160 * made.size });
    made.set(key, id);
    for (const [name, value] of Object.entries(params)) setParam(draft, registry, id, name, value);
    const input = registry.get(wiringType)!.inputs[0];
    if (from !== null && input) connect(draft, registry, { node: from, port: 'out' }, { node: id, port: input.name });
    return id;
  };
  const terrainOf = (index: number): string => feedNode(`terrain ${index}`, HEIGHTS, 0, terrainParams(index), null);
  const sourceOf = (feed: Feed): string => {
    if (feed.kind === 'terrain') return terrainOf(feed.index);
    if (feed.kind === 'mask') return registry.get(MASKS) ? feedNode('mask', MASKS, 1, MASK_SLOPES, feedNode('mask terrain', HEIGHTS, 0, MASK_TERRAIN, null)) : terrainOf(0);
    return registry.get(COLORS) ? feedNode(`color ${feed.index}`, COLORS, 1, {}, terrainOf(feed.index)) : terrainOf(feed.index);
  };

  let terrain: PortRef | null = null;
  let behind: PortRef | null = null;
  for (const [port, feed] of Object.entries(inputFeeds(def, masked))) {
    if (feed === null) continue;
    connect(draft, registry, { node: sourceOf(feed), port: 'out' }, { node: nodeId, port });
    const declared = def.inputs.find((input) => input.name === port);
    if (terrain === null && declared && isHeight(declared)) terrain = { node: terrainOf(feed.kind === 'mask' ? 0 : feed.index), port: 'out' };
    // What a mask, a data field or a colour was made of, for a node without a height input.
    behind ??= { node: terrainOf(feed.kind === 'mask' ? 0 : feed.index), port: 'out' };
  }
  terrain ??= behind;

  if (opts.maxParams) {
    for (const param of def.params) {
      if (param.kind === 'float' || param.kind === 'int') setParam(draft, registry, nodeId, param.name, param.max);
      else if (param.kind === 'vec2') setParam(draft, registry, nodeId, param.name, [param.max, param.max]);
    }
  }
  for (const { name, value } of opts.params ?? []) {
    if (!def.params.some((param) => param.name === name)) {
      const names = def.params.map((param) => param.name);
      throw new UsageError(`${type} has no parameter "${name}"; ${names.length > 0 ? `its parameters are ${listed(names)}` : 'it has none'}`, 'render');
    }
    const { problems, error } = normalizeParams(def, { [name]: value });
    const wrong = error ?? problems[0];
    if (wrong !== undefined) throw new UsageError(`--param ${name} of ${type}: ${refusal(wrong)}`, 'render');
    setParam(draft, registry, nodeId, name, value);
  }
  if (opts.seed !== undefined && opts.seed !== null) {
    if (!def.params.some((param) => param.kind === 'seed')) throw new UsageError(`--seed sets the node's seed, and ${type} has no seed parameter`, 'render');
    setParam(draft, registry, nodeId, 'seed', opts.seed);
  }

  return { doc: draft as GraphDoc, nodeId, type, def, terrain: def.outputs.some(drawnOverTerrain) ? terrain : null, masked, warnings: [] };
}

/**
 * The project file `text` with its node `nodeId` to render. `file` names the file in messages. Throws UsageError
 * when the text is no project, when it has no such node, and when the node has no output to draw.
 */
export function projectDocument(registry: NodeRegistry, text: string, nodeId: string, file: string): RenderPlan {
  let parsed: ReturnType<typeof parseDoc>;
  try {
    parsed = parseDoc(text, registry);
  } catch (thrown) {
    if (thrown instanceof DocFormatError) throw new UsageError(`${file} is not a project file: ${thrown.message}`, 'render');
    throw thrown;
  }
  const { doc } = parsed;
  const node = Object.hasOwn(doc.nodes, nodeId) ? doc.nodes[nodeId] : undefined;
  if (!node) {
    const ids = Object.keys(doc.nodes);
    throw new UsageError(`${file} has no node "${nodeId}"; ${ids.length > 0 ? `its nodes are ${listed(ids)}` : 'it has no nodes'}`, 'render');
  }
  const def = registry.get(node.type) ?? null;
  if (def && def.outputs.length === 0) throw new UsageError(`The node "${nodeId}" is a ${node.type}, which has no outputs: there is nothing to draw`, 'render');

  let terrain: PortRef | null = null;
  const heightPort = def?.outputs.some(drawnOverTerrain) ? def.inputs.find(isHeight) : undefined;
  if (heightPort) {
    // Where an input has several edges the evaluator uses the first in record order (runtime.md 4.3 rule 5).
    const edge = Object.values(doc.edges).find((candidate) => candidate.to.node === nodeId && candidate.to.port === heightPort.name);
    const source = edge && Object.hasOwn(doc.nodes, edge.from.node) ? doc.nodes[edge.from.node] : undefined;
    // An edge from a node of unknown type, or from an output its type lacks, is one the evaluator ignores.
    if (edge && source && source.id !== nodeId && registry.get(source.type)?.outputs.some((port) => port.name === edge.from.port)) {
      terrain = { node: edge.from.node, port: edge.from.port };
    }
  }

  const warnings = parsed.problems.map((problem) => {
    const where = problem.nodeId !== undefined ? `node "${problem.nodeId}": ` : problem.edgeId !== undefined ? `edge "${problem.edgeId}": ` : '';
    return `${where}${problem.message}`;
  });
  return { doc, nodeId, type: node.type, def, terrain, masked: false, warnings };
}

