// The document `render` and `gallery` evaluate (testing.md 8.6): one instance of a node type with its inputs
// wired by the rule of testing.md 2.4, which the harness's registryDoc follows too, or a project file with one
// of its nodes named. Pure: no device, no file access.

import type { Category, NodeDef, ParamValue, PortDef } from '../core/api.ts';
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
/** Adds the ground to a landform that stands on it. */
const SUMS = 'ref/combine';

/**
 * The mask that feeds mask inputs: the parameters of the terrain it is a slope mask of, and of the slope mask.
 * `type`: the mask is made of a terrain of this type instead of the first terrain's own.
 */
export interface MaskFeed { readonly type?: string; readonly terrain: Readonly<Record<string, ParamValue>>; readonly slopes: Readonly<Record<string, ParamValue>> }

/** A first terrain: its type, its parameters beside the defaults of the type, and the mask made of it. */
export interface FirstTerrain {
  readonly type: string;
  readonly params: Readonly<Record<string, ParamValue>>;
  /**
   * The landform stands on gentle ground and not on the floor of the height range: a ref/fbm with these
   * parameters is added to it, `strength` of its height, by a ref/combine. Ground at height 0 is the lowest a
   * project can hold; whatever a node cuts into it lies below the range and is drawn as out of it.
   */
  readonly ground?: { readonly params: Readonly<Record<string, ParamValue>>; readonly strength: number };
  /**
   * The mask is a slope mask of the terrain's broad shape, between two angles that select about half of it, in
   * regions. The slopes of a whole terrain are speckle at the scale of a texel, and under a mask of speckle no
   * picture shows what a node does.
   */
  readonly mask: MaskFeed;
}

/**
 * The terrains a node can be shown on (testing.md 2.4).
 *
 * - `eroded`: smooth valley floors under rough crests, relief everywhere. Its broad shape is in its first two
 *   octaves; the third already cuts gullies.
 * - `range`: a chain of peaks on gentle ground, a seventh of the height range up and rolling by a few degrees.
 *   Detail that belongs on gentle ground and detail that belongs on steep ground both have somewhere to be, and
 *   the ground between the spurs shows what a node adds by itself.
 * - `island`: a landmass that drains to its coast on every side, in a sea that lies below its valley floors
 *   and covers the borders. Water has somewhere to run and somewhere to end; nothing is drowned inland.
 * - `fractal`: the reference noise, rough everywhere. What is left where the registry lacks the others.
 */
const TERRAINS = {
  eroded: { type: 'generate/eroded-noise', params: {}, mask: { terrain: { octaves: 2 }, slopes: { slopeMin: 40, slopeMax: 55 } } },
  // The range has slopes only where it stands: a mask of them would hide what a node does on the ground around
  // it. Its mask is that of the reference noise, whose regions lie across the range and the ground alike.
  range: {
    type: 'generate/mountain-range', params: {}, ground: { params: { seed: 9, size: 0.5, octaves: 2 }, strength: 0.3 },
    mask: { type: HEIGHTS, terrain: { octaves: 3 }, slopes: { slopeMin: 35, slopeMax: 50 } },
  },
  island: { type: 'generate/island', params: { size: 1 }, mask: { terrain: { size: 1, erosion: 0 }, slopes: { slopeMin: 10, slopeMax: 25 } } },
  fractal: { type: HEIGHTS, params: {}, mask: { terrain: { octaves: 3 }, slopes: { slopeMin: 35, slopeMax: 50 } } },
} as const satisfies Readonly<Record<string, FirstTerrain>>;

/**
 * The one table of the wiring rule that depends on what is rendered: the first terrain of a node, by the node's
 * category. A category is shown on the terrain that shows what it is for. The eroded noise is steep and rough
 * everywhere, and at the sea level of the pictures a fifth of it is drowned valleys: surface detail has no
 * gentle ground to lie on there, and no river a coast to reach.
 */
const FIRST_TERRAIN: Readonly<Record<Category, keyof typeof TERRAINS>> = {
  generate: 'eroded',
  adjust: 'eroded',
  filter: 'eroded',
  simulate: 'island',
  select: 'eroded',
  color: 'island',
  surface: 'range',
  io: 'eroded',
  ref: 'eroded',
};

/**
 * The first terrain of a node of `category` in a document of this registry: that of the table where the registry
 * holds its type, else the eroded noise, else the reference noise. null: a document that holds nodes of every
 * category (the harness's registryDoc), which has the eroded noise for all of them.
 */
export function firstTerrain(registry: NodeRegistry, category: Category | null): FirstTerrain {
  const wanted = TERRAINS[category === null ? 'eroded' : FIRST_TERRAIN[category]];
  return [wanted, TERRAINS.eroded].find((terrain) => registry.get(terrain.type)) ?? TERRAINS.fractal;
}

/**
 * The feature sizes of the terrains that feed a node, in turn. The first terrain is that of the node's category;
 * each further one is a ref/fbm with a seed and a size of its own, so that a node with two inputs is not shown
 * its first input twice.
 */
const TERRAIN_SIZES: readonly number[] = [0.25, 0.1, 0.5, 0.05];

/** The node type of terrain `index`: the first is that of the category, every other one ref/fbm. */
export function terrainType(registry: NodeRegistry, index: number, category: Category | null = null): string {
  return index === 0 ? firstTerrain(registry, category).type : HEIGHTS;
}

/** The parameters of terrain `index` ≥ 1 beside the defaults of ref/fbm; those of the first are firstTerrain's. */
export function terrainParams(index: number): Readonly<Record<string, ParamValue>> {
  return index === 0 ? {} : { seed: index, size: TERRAIN_SIZES[index % TERRAIN_SIZES.length]! };
}

/** What makes the mask in a document of this registry. */
export function maskFeed(registry: NodeRegistry, category: Category | null = null): MaskFeed {
  return firstTerrain(registry, category).mask;
}

/**
 * Inputs that are fed by what they are named for and not by their type alone (the port names of testing.md 6.3):
 * a terrain would do for each, and shows nothing of what the node is for.
 *
 * - `stamp`, a height: a landform on level ground, which is what is stamped. A terrain that fills its field has
 *   no outline to stamp.
 * - `flow`, a data field: the drainage of the first terrain, from the product's own flow node. A second terrain
 *   read as a drainage area puts rivers where no water runs.
 * - `snow`, a mask: the snow the product's snow node lays on the first terrain, and not its steep slopes, where
 *   snow does not lie.
 */
const NAMED = {
  stamp: { type: 'generate/volcano', port: 'out', role: 'height', reads: false },
  flow: { type: 'simulate/flow', port: 'out', role: 'data', reads: true },
  snow: { type: 'simulate/snow', port: 'snow', role: 'mask', reads: true },
} as const;
export type NamedFeed = keyof typeof NAMED;

/**
 * What feeds one input: terrain `index`, the mask of the first terrain, or the colouring of terrain `index`.
 * `named`: the input is one the wiring knows by its name, and takes that feed where the registry has its node;
 * the feed by type is what it takes otherwise, so an input counts the same in every registry.
 */
export type Feed =
  | { readonly kind: 'terrain'; readonly index: number; readonly named?: NamedFeed }
  | { readonly kind: 'mask'; readonly named?: NamedFeed }
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
 * - A field input named `stamp`, `flow` or `snow` with the role of that name is marked: it takes the landform,
 *   the drainage or the snow instead, where the registry has the node that makes it.
 * - An optional input is connected in the connected variant only, and so is the `mask` of a maskable node: the
 *   plain picture shows the node as a user sees it on dropping it into a graph, with its own defaults, and the
 *   connected one what its optional inputs and a mask do to that. Inputs are counted whether or not they are
 *   connected, so that an input has the same feed in both variants.
 */
export function inputFeeds(def: NodeDef, connected: boolean): Readonly<Record<string, Feed | null>> {
  const feeds: Record<string, Feed | null> = {};
  let terrains = 0, colors = 0;
  for (const port of def.inputs) {
    const role = port.type === 'field' ? port.role ?? 'height' : null;
    const named = Object.hasOwn(NAMED, port.name) && NAMED[port.name as NamedFeed].role === role ? { named: port.name as NamedFeed } : {};
    const feed: Feed = port.type === 'color' ? { kind: 'color', index: colors++ }
      : role === 'mask' ? { kind: 'mask', ...named }
      : { kind: 'terrain', index: terrains++, ...named };
    feeds[port.name] = port.optional === true && !connected ? null : feed;
  }
  if (def.maskable) feeds.mask = connected ? { kind: 'mask' } : null;
  return feeds;
}

/** What an input is given, for the picture of it: a terrain, the mask, a colouring, or one of the named feeds. */
export type Given = 'terrain' | 'mask' | 'color' | NamedFeed;

/** One node the wiring adds to a document, and what it reads. */
export interface FeedNode {
  /** Two feeds with one key are one node. */
  readonly key: string;
  readonly type: string;
  /** Beside the defaults of the type. */
  readonly params: Readonly<Record<string, ParamValue>>;
  /** What the inputs of the node read, by input port; an input not named is unconnected. Empty: the node is given nothing. */
  readonly reads: Readonly<Record<string, FeedNode>>;
  /** The output that feeds. */
  readonly port: string;
}

/**
 * The node that makes `feed` in a document of this registry, with the nodes it reads. `category` is that of the
 * node being fed, which decides its first terrain; null for a document of every category. Where the registry
 * lacks ref/slope-mask or ref/colorize the terrain itself feeds the input and the evaluator converts, and where
 * it lacks the node of a named feed the input takes the feed its type gives it.
 */
export function feedSource(registry: NodeRegistry, feed: Feed, category: Category | null): { readonly node: FeedNode; readonly given: Given } {
  const first = firstTerrain(registry, category);
  /** A node that reads `from` at its first input. */
  const reading = (key: string, type: string, params: Readonly<Record<string, ParamValue>>, from: FeedNode, port = 'out'): FeedNode =>
    ({ key, type, params, reads: { [registry.get(type)!.inputs[0]!.name]: from }, port });
  const source = (key: string, type: string, params: Readonly<Record<string, ParamValue>>): FeedNode => ({ key, type, params, reads: {}, port: 'out' });
  const terrain = (index: number): FeedNode => {
    if (index > 0) return source(`terrain ${index}`, HEIGHTS, terrainParams(index));
    const combine = first.ground ? registry.get(SUMS) : undefined;
    if (!first.ground || !combine || combine.inputs.length < 2) return source('terrain 0', first.type, first.params);
    // The landform and the ground it stands on, added: both are what terrain 0 is made of, and neither is it.
    const [a, b] = combine.inputs;
    return {
      key: 'terrain 0', type: SUMS, params: { mode: 'add', strength: first.ground.strength }, port: 'out',
      reads: { [a!.name]: source('terrain 0 landform', first.type, first.params), [b!.name]: source('terrain 0 ground', HEIGHTS, first.ground.params) },
    };
  };
  if (feed.kind !== 'color' && feed.named !== undefined && registry.get(NAMED[feed.named].type)) {
    const named = NAMED[feed.named];
    const node = named.reads ? reading(feed.named, named.type, {}, terrain(0), named.port) : { ...source(feed.named, named.type, {}), port: named.port };
    return { node, given: feed.named };
  }
  if (feed.kind === 'terrain') return { node: terrain(feed.index), given: 'terrain' };
  if (feed.kind === 'mask') {
    if (!registry.get(MASKS)) return { node: terrain(0), given: 'mask' };
    return { node: reading('mask', MASKS, first.mask.slopes, source('mask terrain', first.mask.type ?? first.type, first.mask.terrain)), given: 'mask' };
  }
  if (!registry.get(COLORS)) return { node: terrain(feed.index), given: 'color' };
  return { node: reading(`color ${feed.index}`, COLORS, {}, terrain(feed.index)), given: 'color' };
}

/** A connected input of a rendered node type, for the picture of what the node was given. */
export interface PlannedInput {
  /** The input port of the node. */
  readonly port: string;
  /** The output that feeds it. */
  readonly from: PortRef;
  /** What that output is: a terrain, the mask, a colouring, or a named feed. */
  readonly kind: Given;
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
   * was made of; in a project, the terrain the project shows. null: the node's first output is a height, over
   * which its other outputs are drawn, or there is no terrain to draw it over.
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
 * then each of `params`, then `seed`. Its inputs are fed as inputFeeds and feedSource say: the first terrain is
 * that of the node's category and every other terrain a ref/fbm, the mask a ref/slope-mask of the first
 * terrain's broad shape, a colour a ref/colorize of its terrain, and an input the wiring knows by name what it
 * is named for. With `connected`, the optional inputs and the mask of a maskable node are connected too.
 * Throws UsageError for what the arguments get wrong.
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

  // One node per feed, made when an input first asks for it, with the nodes it reads before it.
  const made = new Map<string, string>();
  const depthOf = (node: FeedNode): number => Object.values(node.reads).reduce((depth, read) => Math.max(depth, 1 + depthOf(read)), 0);
  const instantiate = (node: FeedNode): string => {
    let id = made.get(node.key);
    if (id !== undefined) return id;
    const read = Object.entries(node.reads).map(([port, from]) => ({ port, from: { node: instantiate(from), port: from.port } }));
    id = addNode(draft, registry, node.type, { x: 320 * depthOf(node), y: 160 * made.size });
    made.set(node.key, id);
    for (const [name, value] of Object.entries(node.params)) setParam(draft, registry, id, name, value);
    for (const { port, from } of read) connect(draft, registry, from, { node: id, port });
    return id;
  };
  const category = def.category;
  const terrainOf = (index: number): PortRef => {
    const { node } = feedSource(registry, { kind: 'terrain', index }, category);
    return { node: instantiate(node), port: node.port };
  };

  let terrain: PortRef | null = null;
  let behind: PortRef | null = null;
  const inputs: PlannedInput[] = [];
  for (const [port, feed] of Object.entries(inputFeeds(def, connected))) {
    if (feed === null) continue;
    const source = feedSource(registry, feed, category);
    const from: PortRef = { node: instantiate(source.node), port: source.node.port };
    connect(draft, registry, from, { node: nodeId, port });
    inputs.push({ port, from, kind: source.given });
    const declared = def.inputs.find((input) => input.name === port);
    if (terrain === null && declared && isHeight(declared) && source.given === 'terrain') terrain = from;
    // What a mask, a data field or a colour was made of, for a node without a height input: the terrain of its
    // number, and the first terrain for the mask, the drainage and the snow. A stamp is a landform of its own.
    if (source.given !== 'stamp') behind ??= terrainOf(feed.kind === 'mask' || source.given !== feed.kind ? 0 : feed.index);
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
  // A node that reads no terrain, a blend of two colour maps for one, is drawn over the terrain the project
  // shows (runtime.md 7.4), where that is an output of another node the evaluator would find.
  if (terrain === null && def && needsTerrain(def)) {
    const viewed = doc.ui.view?.height;
    const source = viewed && typeof viewed.node === 'string' && Object.hasOwn(doc.nodes, viewed.node) ? doc.nodes[viewed.node] : undefined;
    if (viewed && source && source.id !== nodeId && registry.get(source.type)?.outputs.some((port) => port.name === viewed.port)) {
      terrain = { node: viewed.node, port: viewed.port };
    }
  }

  const warnings = parsed.problems.map((problem) => {
    const where = problem.nodeId !== undefined ? `node "${problem.nodeId}": ` : problem.edgeId !== undefined ? `edge "${problem.edgeId}": ` : '';
    return `${where}${problem.message}`;
  });
  return { doc, nodeId, type: node.type, def, terrain, connected: false, inputs: [], warnings };
}

