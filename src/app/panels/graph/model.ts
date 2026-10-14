// What the graph panel reads off a node definition and a document: what each port carries, which nodes lie on
// a cycle, and the names of the categories. The rules a panel shares with the evaluator are the core's own
// functions (runtime.md 4.3): `portLabel`, `inputsOf`, `canBypass`, `inputSources` with `inputKey`, and
// `missingInputs`. Pure: no DOM, no React.

import type { Category, NodeDef, PortDef } from '../../../core/api.ts';
import { inputKey, inputsOf, type GraphDoc, type NodeInstance, type NodeRegistry, type PortRef } from '../../../core/runtime.ts';

/** The order of engine.md 4.1: the order of the palette's categories. */
export const CATEGORIES: readonly Category[] = ['generate', 'adjust', 'filter', 'simulate', 'select', 'color', 'surface', 'io', 'ref'];

export const CATEGORY_TITLES: Readonly<Record<Category, string>> = {
  generate: 'Generate',
  adjust: 'Adjust',
  filter: 'Filter',
  simulate: 'Simulate',
  select: 'Select',
  color: 'Color',
  surface: 'Surface',
  io: 'Import and Export',
  ref: 'Reference',
};

/** What a port carries, as the theme colours it: the three roles of a field, a colour, or not known yet. */
export type PortTone = 'height' | 'mask' | 'data' | 'color' | 'any';

export const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

export function nodeTitle(instance: NodeInstance, def: NodeDef | undefined): string {
  return instance.title ?? def?.title ?? instance.type;
}

/** The tone a port has by its declaration alone; null when it follows what is connected (an `any` input, a `sameAs` output). */
export function declaredTone(port: PortDef): PortTone | null {
  if (port.type === 'color') return 'color';
  if (port.type === 'field') return port.role ?? 'height';
  return null;
}

/** Whether an edge is one the evaluator uses as far as its ends go: rule 1 of runtime.md 4.3. */
export function edgeEndsExist(doc: GraphDoc, registry: NodeRegistry, from: PortRef, to: PortRef): boolean {
  if (from.node === to.node) return false;
  const source = own(doc.nodes, from.node);
  const target = own(doc.nodes, to.node);
  if (!source || !target) return false;
  const sourceDef = registry.get(source.type);
  const targetDef = registry.get(target.type);
  if (!sourceDef || !targetDef) return false;
  return sourceDef.outputs.some((port) => port.name === from.port) && inputsOf(targetDef).some((port) => port.name === to.port);
}

/**
 * `<node>\n<port>`: a key for an output, or for an end of a drawn wire, in a map of this panel. A node id may hold
 * any character, a port name of a known type no line break. The inputs the evaluator finds connected are keyed by
 * the core's `inputKey`, which is what `inputSources` returns them under.
 */
export const portKey = (node: string, port: string): string => `${node}\n${port}`;

/**
 * The nodes that lie on a cycle of the edges the evaluator uses (`sources` is the core's `inputSources`). The
 * editor makes no cycle (4.3 rule 3), but a file may hold one (rule 5), and the engine names it only on the nodes
 * it is asked for: the graph says it of every node of it, from the document. Tarjan's algorithm without
 * recursion: a file may hold a chain of any length. The core's own `cycleNodes` is not exported by its entry
 * modules; a unit test holds this one to it.
 */
export function cycleNodes(doc: GraphDoc, sources: ReadonlyMap<string, PortRef>): Set<string> {
  const next = new Map<string, string[]>();
  for (const [key, from] of sources) {
    // `inputKey` is the JSON of [node, port].
    const to = (JSON.parse(key) as [string, string])[0];
    const list = next.get(from.node);
    if (list) list.push(to);
    else next.set(from.node, [to]);
  }
  const found = new Set<string>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  for (const start of Object.keys(doc.nodes)) {
    if (index.has(start)) continue;
    // Each entry is a node and how many of its successors were looked at: every node is entered once and every edge once.
    const walk: { node: string; at: number }[] = [{ node: start, at: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (walk.length > 0) {
      const frame = walk[walk.length - 1]!;
      const successors = next.get(frame.node) ?? [];
      if (frame.at < successors.length) {
        const to = successors[frame.at++]!;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter++);
          stack.push(to);
          onStack.add(to);
          walk.push({ node: to, at: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(to)!));
        }
        continue;
      }
      walk.pop();
      const parent = walk[walk.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      // The root of a component: everything above it on the stack is in it. One node alone is no cycle (an edge from a node to itself is not used).
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === frame.node) break;
      }
      if (component.length > 1) for (const member of component) found.add(member);
    }
  }
  return found;
}

/** How the node takes part in what the viewport shows (runtime.md 7.4). */
export type Shown = 'terrain' | 'overlay' | 'both' | null;

export function shownAs(doc: GraphDoc, nodeId: string): Shown {
  const view = doc.ui.view;
  const terrain = view?.height?.node === nodeId;
  const overlay = view?.overlay?.ref.node === nodeId;
  return terrain && overlay ? 'both' : terrain ? 'terrain' : overlay ? 'overlay' : null;
}

/**
 * The tone of every output of the document, in one pass. A declared output has its role's tone or a colour's. A
 * `sameAs` output has the kind `outputKind` (4.3) finds through the connections, and as a field it is a height,
 * the default role, as the view takes it (7.4); a cycle of such outputs has no kind. `outputKind` itself is not
 * asked once per output: it walks every edge each time, which with 300 nodes is tens of milliseconds at every
 * connection made. A test holds the two to the same answer. `sources` is the core's `inputSources`.
 */
export function outputTones(doc: GraphDoc, registry: NodeRegistry, sources: ReadonlyMap<string, PortRef>): Map<string, PortTone> {
  const tones = new Map<string, PortTone>();
  const settle = (start: PortRef): void => {
    const chain: string[] = [];
    const walked = new Set<string>();
    let at = start;
    let found: PortTone = 'any';
    // Every round adds an output to the chain or ends the walk: at most one round per output of the document.
    for (;;) {
      const key = portKey(at.node, at.port);
      const known = tones.get(key);
      if (known !== undefined) {
        found = known;
        break;
      }
      if (walked.has(key)) break;
      const node = own(doc.nodes, at.node);
      const port = node ? registry.get(node.type)?.outputs.find((candidate) => candidate.name === at.port) : undefined;
      if (!port) break;
      const declared = declaredTone(port);
      if (declared !== null) {
        tones.set(key, declared);
        found = declared;
        break;
      }
      chain.push(key);
      walked.add(key);
      const from = typeof port.type === 'object' ? sources.get(inputKey({ node: at.node, port: port.type.sameAs })) : undefined;
      if (!from) break;
      at = from;
    }
    // What a "same as" output carries has the kind of what came in and no role of its own.
    const carried: PortTone = found === 'color' ? 'color' : found === 'any' ? 'any' : 'height';
    for (const key of chain) tones.set(key, carried);
  };
  for (const [id, instance] of Object.entries(doc.nodes)) {
    for (const port of registry.get(instance.type)?.outputs ?? []) settle({ node: id, port: port.name });
  }
  return tones;
}
