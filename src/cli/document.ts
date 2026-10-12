// The document `render` and `gallery` evaluate (testing.md 8.6): one instance of a node type with its inputs
// wired as the harness's registryDoc wires them, or a project file with one of its nodes named. Pure: no
// device, no file access.

import type { NodeDef, PortDef } from '../core/api.ts';
import {
  addNode, connect, DocFormatError, newDoc, normalizeParams, parseDoc, setParam, setSettings,
  type DocDraft, type GraphDoc, type NodeRegistry, type PortRef, type ProjectSettings,
} from '../core/runtime.ts';
import { UsageError, type ParamArg } from './args.ts';

/** The settings of a node type's document; the others keep the defaults of a new document. */
export const RENDER_SETTINGS = { terrainSize: 4096, heightRange: 1024, seed: 1 } as const satisfies Partial<ProjectSettings>;

/** What feeds the inputs of a rendered node type: realistic fractal terrain, a mask of it, a colouring of it. */
const HEIGHTS = 'ref/fbm';
const MASKS = 'ref/slope-mask';
const COLORS = 'ref/colorize';

export interface RenderPlan {
  readonly doc: GraphDoc;
  readonly nodeId: string;
  readonly type: string;
  /** null: the registry has no such type. The evaluation reports it. */
  readonly def: NodeDef | null;
  /** The output connected to the node's first height input, when a mask, a data field or a colour is drawn over that terrain. */
  readonly terrain: PortRef | null;
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
 * then each of `params`, then `seed`. Heights, data and `any` inputs come from a ref/fbm, masks from a
 * ref/slope-mask of it and colours from a ref/colorize of it; where the registry lacks one of the two, the
 * ref/fbm itself is connected and the evaluator converts. Throws UsageError for what the arguments get wrong.
 */
export function typeDocument(
  registry: NodeRegistry, type: string,
  opts: { readonly params?: readonly ParamArg[]; readonly maxParams?: boolean; readonly seed?: number | null } = {},
): RenderPlan {
  const def = registry.get(type);
  if (!def) throw new UsageError(unknownType(registry, type), 'render');
  if (def.outputs.length === 0) throw new UsageError(`${type} has no outputs: there is nothing to draw`, 'render');
  if (!registry.get(HEIGHTS)) throw new Error(`The registry lacks ${HEIGHTS}, which feeds the inputs of a rendered node (testing.md 10.1)`);

  const draft = structuredClone(newDoc()) as DocDraft;
  setSettings(draft, RENDER_SETTINGS);
  const nodeId = addNode(draft, registry, type, { x: 640, y: 0 });

  const wiring = new Map<string, string>();
  const feed = (wiringType: string, from: (() => string) | null): string => {
    let id = wiring.get(wiringType);
    if (id !== undefined) return id;
    id = addNode(draft, registry, wiringType, { x: from ? 320 : 0, y: 160 * wiring.size });
    wiring.set(wiringType, id);
    const input = registry.get(wiringType)!.inputs[0];
    if (from && input) connect(draft, registry, { node: from(), port: 'out' }, { node: id, port: input.name });
    return id;
  };
  const heights = (): string => feed(HEIGHTS, null);
  const masks = (): string => (registry.get(MASKS) ? feed(MASKS, heights) : heights());
  const colors = (): string => (registry.get(COLORS) ? feed(COLORS, heights) : heights());

  let terrain: PortRef | null = null;
  for (const port of def.inputs) {
    const from: PortRef = { node: port.type === 'color' ? colors() : port.type === 'field' && port.role === 'mask' ? masks() : heights(), port: 'out' };
    connect(draft, registry, from, { node: nodeId, port: port.name });
    if (terrain === null && isHeight(port)) terrain = from;
  }

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

  return { doc: draft as GraphDoc, nodeId, type, def, terrain: def.outputs.some(drawnOverTerrain) ? terrain : null, warnings: [] };
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
  return { doc, nodeId, type: node.type, def, terrain, warnings };
}

