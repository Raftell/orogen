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

/** What feeds the inputs of a rendered node type: realistic terrains, a mask of the first, a colouring of each. */
const HEIGHTS = 'ref/fbm';
const MASKS = 'ref/slope-mask';
const COLORS = 'ref/colorize';
/**
 * The first terrain, where the registry has it: smooth valleys under rough crests. ref/fbm is rough everywhere,
 * and a node that tells smooth ground from rough, or flattens the middle heights, has nothing to show on it.
 */
const FIRST_TERRAIN = 'generate/eroded-noise';

/**
 * The feature sizes of the terrains that feed a node, in turn. The first terrain is at the defaults of its type;
 * each further one is a ref/fbm with a seed and a size of its own, so that a node with two inputs is not shown
 * its first input twice.
 */
const TERRAIN_SIZES: readonly number[] = [0.25, 0.1, 0.5, 0.05];

/** The node type of terrain `index`: the first is generate/eroded-noise where the registry holds it, every other one ref/fbm. */
export function terrainType(registry: NodeRegistry, index: number): string {
  return index === 0 && registry.get(FIRST_TERRAIN) ? FIRST_TERRAIN : HEIGHTS;
}

/** The parameters of terrain `index` beside the defaults of its type: none for the first. */
export function terrainParams(index: number): Readonly<Record<string, ParamValue>> {
  return index === 0 ? {} : { seed: index, size: TERRAIN_SIZES[index % TERRAIN_SIZES.length]! };
}

/** The mask that feeds mask inputs: the parameters of the terrain it is a slope mask of, and of the slope mask. */
export interface MaskFeed { readonly terrain: Readonly<Record<string, ParamValue>>; readonly slopes: Readonly<Record<string, ParamValue>> }

/**
 * The mask is a slope mask of the first terrain's broad shape: its first octaves alone, selected between two
 * angles, which is about half the terrain, in regions (0.43 of ref/fbm and 0.49 of generate/eroded-noise at 513).
 * The slopes of all eight octaves are speckle at the scale of a texel, and under a mask of speckle no picture
 * shows what a node does. The eroded noise has its broad shape in two octaves, the third already cuts gullies,
 * and its slopes are steeper.
 */
const MASK_FEEDS: Readonly<Record<string, MaskFeed>> = {
  [HEIGHTS]: { terrain: { octaves: 3 }, slopes: { slopeMin: 35, slopeMax: 50 } },
  [FIRST_TERRAIN]: { terrain: { octaves: 2 }, slopes: { slopeMin: 40, slopeMax: 55 } },
};

/** What makes the mask in a document of this registry. */
export function maskFeed(registry: NodeRegistry): MaskFeed {
  return MASK_FEEDS[terrainType(registry, 0)]!;
}

/** What feeds one input: terrain `index`, the mask of the first terrain, or the colouring of terrain `index`. */
export type Feed =
  | { readonly kind: 'terrain'; readonly index: number }
  | { readonly kind: 'mask' }
  | { readonly kind: 'color'; readonly index: number };

/** Whether the node has a connected variant: an optional input of its own, or the mask `maskable` gives it. */
export function hasConnectedVariant(def: NodeDef): boolean {
  return def.maskable === true || def.inputs.some((port) => port.optional === true);
}

/**
 * The feed of every input of `def`, by port name; null: left unconnected (testing.md 2.4).
 *
 * - The k-th input that takes a height, a data field or either kind gets terrain k: each a terrain of its own.
 * - A mask input gets the mask: a slope mask of the broad shape of the first terrain.
 * - The k-th colour input gets the colouring of terrain k.
 * - An optional input is connected in the connected variant only, and so is the `mask` of a maskable node: the
 *   plain picture shows the node as a user sees it on dropping it into a graph, with its own defaults, and the
 *   connected one what its optional inputs and a mask do to that. Inputs are counted whether or not they are
 *   connected, so that an input has the same feed in both variants.
 */
export function inputFeeds(def: NodeDef, connected: boolean): Readonly<Record<string, Feed | null>> {
  const feeds: Record<string, Feed | null> = {};
  let terrains = 0, colors = 0;
  for (const port of def.inputs) {
    const feed: Feed = port.type === 'color' ? { kind: 'color', index: colors++ }
      : port.type === 'field' && port.role === 'mask' ? { kind: 'mask' }
      : { kind: 'terrain', index: terrains++ };
    feeds[port.name] = port.optional === true && !connected ? null : feed;
  }
  if (def.maskable) feeds.mask = connected ? { kind: 'mask' } : null;
  return feeds;
}

/** A connected input of a rendered node type, for the picture of what the node was given. */
export interface PlannedInput {
  /** The input port of the node. */
  readonly port: string;
  /** The output that feeds it. */
  readonly from: PortRef;
  /** What that output is: a terrain, the mask or a colouring. */
  readonly kind: Feed['kind'];
}

export interface RenderPlan {
  readonly doc: GraphDoc;
  readonly nodeId: string;
  readonly type: string;
  /** null: the registry has no such type. The evaluation reports it. */
  readonly def: NodeDef | null;
  /**
   * The terrain a mask, a data field or a colour is drawn over when the node's first output is none: the output
   * connected to the node's first height input, or, for a node without one, the terrain its mask or its colour
   * was made of. null: the node's first output is a height, over which its other outputs are drawn, or the node
   * reads no terrain at all.
   */
  readonly terrain: PortRef | null;
  /** The document is the connected variant: optional inputs and the mask of a maskable node are connected (testing.md 2.4). */
  readonly connected: boolean;
  /** The connected inputs of a node type, in the order of its ports and with the mask of a maskable node last; none for a project file. */
  readonly inputs: readonly PlannedInput[];
  /** What the project file's loader reported. */
  readonly warnings: readonly string[];
}

const isHeight = (port: PortDef): boolean => port.type === 'field' && (port.role ?? 'height') === 'height';

/**
 * Whether the pictures of the node need a terrain beside its own outputs: some output is no height, and the
 * first is none either. A node whose first output is a height has its other outputs drawn over that.
 */
const needsTerrain = (def: NodeDef): boolean => def.outputs.some((port) => !isHeight(port)) && !isHeight(def.outputs[0]!);

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
 * then each of `params`, then `seed`. Its inputs are fed as inputFeeds says: the first terrain is a
 * generate/eroded-noise where the registry has one and every other terrain a ref/fbm, the mask a ref/slope-mask
 * of the first terrain's broad shape and a colour a ref/colorize of its terrain; where the registry lacks one of
 * the two, the terrain itself is connected and the evaluator converts. With `connected`, the optional inputs
 * and the mask of a maskable node are connected too. Throws UsageError for what the arguments get wrong.
 */
export function typeDocument(
  registry: NodeRegistry, type: string,
  opts: { readonly params?: readonly ParamArg[]; readonly maxParams?: boolean; readonly seed?: number | null; readonly connected?: boolean } = {},
): RenderPlan {
  const def = registry.get(type);
  if (!def) throw new UsageError(unknownType(registry, type), 'render');
  if (def.outputs.length === 0) throw new UsageError(`${type} has no outputs: there is nothing to draw`, 'render');
  if (!registry.get(HEIGHTS)) throw new Error(`The registry lacks ${HEIGHTS}, which feeds the inputs of a rendered node (testing.md 10.1)`);
  const connected = opts.connected === true;
  if (connected && !hasConnectedVariant(def)) {
    throw new UsageError(`--connected connects the optional inputs of a node and the mask of a maskable one, and ${type} has no optional input and is not maskable`, 'render');
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
  const mask = maskFeed(registry);
  const terrainOf = (index: number): string => feedNode(`terrain ${index}`, terrainType(registry, index), 0, terrainParams(index), null);
  const sourceOf = (feed: Feed): string => {
    if (feed.kind === 'terrain') return terrainOf(feed.index);
    if (feed.kind === 'mask') return registry.get(MASKS) ? feedNode('mask', MASKS, 1, mask.slopes, feedNode('mask terrain', terrainType(registry, 0), 0, mask.terrain, null)) : terrainOf(0);
    return registry.get(COLORS) ? feedNode(`color ${feed.index}`, COLORS, 1, {}, terrainOf(feed.index)) : terrainOf(feed.index);
  };

  let terrain: PortRef | null = null;
  let behind: PortRef | null = null;
  const inputs: PlannedInput[] = [];
  for (const [port, feed] of Object.entries(inputFeeds(def, connected))) {
    if (feed === null) continue;
    const from: PortRef = { node: sourceOf(feed), port: 'out' };
    connect(draft, registry, from, { node: nodeId, port });
    inputs.push({ port, from, kind: feed.kind });
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

  return { doc: draft as GraphDoc, nodeId, type, def, terrain: needsTerrain(def) ? terrain : null, connected, inputs, warnings: [] };
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
  const heightPort = def && needsTerrain(def) ? def.inputs.find(isHeight) : undefined;
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
  return { doc, nodeId, type: node.type, def, terrain, connected: false, inputs: [], warnings };
}

