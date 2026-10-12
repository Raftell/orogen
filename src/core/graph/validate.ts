import { own, type Edge, type GraphDoc, type PortRef } from './doc.ts';
import { inputsOf } from './ports.ts';
import type { NodeRegistry } from './registry.ts';

const inputKey = (to: PortRef): string => JSON.stringify([to.node, to.port]);

/** Rule 1 of runtime.md 4.3: `from` names an output of an existing node of a known type, `to` an input of another. null when it holds. */
export function endpointProblem(doc: GraphDoc, registry: NodeRegistry, from: PortRef, to: PortRef): string | null {
  const source = own(doc.nodes, from.node);
  if (!source) return 'The source node does not exist';
  const sourceDef = registry.get(source.type);
  if (!sourceDef) return `Unknown node type "${source.type}"`;
  if (!sourceDef.outputs.some((p) => p.name === from.port)) return `${sourceDef.title} has no output "${from.port}"`;

  const target = own(doc.nodes, to.node);
  if (!target) return 'The target node does not exist';
  const targetDef = registry.get(target.type);
  if (!targetDef) return `Unknown node type "${target.type}"`;
  if (!inputsOf(targetDef).some((p) => p.name === to.port)) return `${targetDef.title} has no input "${to.port}"`;

  if (from.node === to.node) return 'A node cannot be connected to itself';
  return null;
}

/** Whether `edges` lead from the node `from` to the node `to`. A node reaches itself. */
export function reaches(edges: readonly Edge[], from: string, to: string): boolean {
  if (from === to) return true;
  const next = successors(edges);
  // Each node is pushed once, when it is first seen, so the search ends after at most one round per node.
  const seen = new Set<string>([from]);
  const stack = [from];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    for (const target of next.get(node) ?? []) {
      if (target === to) return true;
      if (seen.has(target)) continue;
      seen.add(target);
      stack.push(target);
    }
  }
  return false;
}

/** Whether some of `edges` form a cycle; an edge from a node to itself is one. */
export function hasCycle(edges: readonly Edge[]): boolean {
  const component = strongComponents(successors(edges));
  return edges.some((edge) => component.get(edge.from.node) === component.get(edge.to.node));
}

/**
 * Whether an edge from `from` into `to` would close a cycle: whether `to.node` already reaches `from.node`.
 * Every edge of the document counts, also one the evaluator ignores, so a document made by the commands never
 * holds a cycle of any kind. The edge `connect` replaces, the one into `to`, cannot be part of such a path.
 */
export function createsCycle(doc: GraphDoc, from: PortRef, to: PortRef): boolean {
  return reaches(Object.values(doc.edges), to.node, from.node);
}

/** null when the connection is legal, else a one-sentence reason. */
export function validateConnection(doc: GraphDoc, registry: NodeRegistry, from: PortRef, to: PortRef): string | null {
  return endpointProblem(doc, registry, from, to) ?? (createsCycle(doc, from, to) ? 'The connection would create a cycle' : null);
}

export interface EdgeProblem {
  readonly edgeId: string;
  readonly rule: 1 | 2 | 3;      // the first rule of runtime.md 4.3 the edge breaks
  readonly message: string;
}

/** Every edge of the document in record order: used by the evaluator, or breaking rule 1 or rule 2 (4.3 rule 5). */
function classify(doc: GraphDoc, registry: NodeRegistry): { readonly used: readonly (readonly [edgeId: string, edge: Edge])[]; readonly ignored: readonly EdgeProblem[] } {
  const used: (readonly [string, Edge])[] = [];
  const ignored: EdgeProblem[] = [];
  const taken = new Set<string>();
  for (const [edgeId, edge] of Object.entries(doc.edges)) {
    const endpoint = endpointProblem(doc, registry, edge.from, edge.to);
    const input = inputKey(edge.to);
    if (endpoint !== null) ignored.push({ edgeId, rule: 1, message: endpoint });
    else if (taken.has(input)) ignored.push({ edgeId, rule: 2, message: `The input "${edge.to.port}" already has a connection` });
    else {
      taken.add(input);
      used.push([edgeId, edge]);
    }
  }
  return { used, ignored };
}

/**
 * The edges the evaluator uses, in record order: those that do not break rule 1, and of several into one input
 * the first (4.3 rule 5).
 */
export function usedEdges(doc: GraphDoc, registry: NodeRegistry): Edge[] {
  return classify(doc, registry).used.map(([, edge]) => edge);
}

/** The nodes that lie on a cycle of used edges: the evaluator reports `Part of a cycle` on each (5.8). */
export function cycleNodes(doc: GraphDoc, registry: NodeRegistry): Set<string> {
  const edges = usedEdges(doc, registry);
  const component = strongComponents(successors(edges));
  // Rule 1 leaves no used edge from a node to itself, so a node is on a cycle exactly when a used edge stays inside its component.
  const onCycle = new Set<string>();
  for (const edge of edges) {
    if (component.get(edge.from.node) !== component.get(edge.to.node)) continue;
    onCycle.add(edge.from.node);
    onCycle.add(edge.to.node);
  }
  return onCycle;
}

/**
 * The edges of a document that break a rule of runtime.md 4.3, in record order, each under the first rule it
 * breaks: rule 1 (the evaluator ignores the edge), rule 2 (an earlier edge into the same input is the one
 * used), rule 3 (the edge is used and lies on a cycle of used edges).
 */
export function invalidEdges(doc: GraphDoc, registry: NodeRegistry): EdgeProblem[] {
  const { used, ignored } = classify(doc, registry);
  const problems = new Map<string, EdgeProblem>();
  for (const problem of ignored) problems.set(problem.edgeId, problem);
  const component = strongComponents(successors(used.map(([, edge]) => edge)));
  for (const [edgeId, edge] of used) {
    // An edge lies on a cycle exactly when its target reaches its source: when both are in one component.
    if (component.get(edge.from.node) === component.get(edge.to.node)) problems.set(edgeId, { edgeId, rule: 3, message: 'Part of a cycle' });
  }
  return Object.keys(doc.edges).flatMap((edgeId) => problems.get(edgeId) ?? []);
}

/** Node id → the nodes its edges lead to. Every node an edge names has an entry. */
function successors(edges: readonly Edge[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  const of = (node: string): string[] => {
    let targets = next.get(node);
    if (!targets) next.set(node, targets = []);
    return targets;
  };
  for (const edge of edges) {
    of(edge.from.node).push(edge.to.node);
    of(edge.to.node);
  }
  return next;
}

/**
 * Tarjan's algorithm without recursion: node id → the number of its strongly connected component. Two nodes
 * have one number exactly when each reaches the other.
 *
 * Every round of the inner loop enters a node (once per node), follows an edge (once per edge) or leaves a
 * node (once per node). `rounds` holds it to that count, so a mistake in the bookkeeping throws instead of
 * running on.
 */
function strongComponents(next: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const index = new Map<string, number>();       // discovery order; a node with an index has been entered
  const low = new Map<string, number>();
  const component = new Map<string, number>();
  const open: string[] = [];                     // entered nodes whose component is not complete
  const isOpen = new Set<string>();
  const path: { readonly node: string; readonly targets: readonly string[]; at: number }[] = [];
  let components = 0;
  let rounds = 2 * next.size;
  for (const targets of next.values()) rounds += targets.length;
  const broken = (what: string): Error => new Error(`Internal error in the cycle search: ${what}`);

  const enter = (node: string): void => {
    index.set(node, index.size);
    low.set(node, index.size - 1);
    open.push(node);
    isOpen.add(node);
    path.push({ node, targets: next.get(node) ?? [], at: 0 });
  };

  for (const root of next.keys()) {
    if (index.has(root)) continue;
    enter(root);
    for (let frame = path.at(-1); frame !== undefined; frame = path.at(-1)) {
      if (rounds-- <= 0) throw broken('it visits more than every node and every edge');
      if (frame.at < frame.targets.length) {
        const target = frame.targets[frame.at++]!;
        if (!index.has(target)) enter(target);
        else if (isOpen.has(target)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        continue;
      }
      path.pop();
      const parent = path.at(-1);
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      // frame.node is the first node of its component that was entered: the component is that node and everything opened after it.
      let member: string | undefined;
      do {
        member = open.pop();
        if (member === undefined) throw broken(`node "${frame.node}" completes a component it is not part of`);
        isOpen.delete(member);
        component.set(member, components);
      } while (member !== frame.node);
      components++;
    }
  }
  return component;
}

/** The edge the evaluator uses for an input: the first in record order that does not break rule 1 (4.3 rule 5). */
export function inputEdge(doc: GraphDoc, registry: NodeRegistry, to: PortRef): Edge | null {
  for (const edge of Object.values(doc.edges)) {
    if (edge.to.node === to.node && edge.to.port === to.port && endpointProblem(doc, registry, edge.from, edge.to) === null) return edge;
  }
  return null;
}

/** The kind an output carries: resolves `sameAs` through the connections. null: not determinable (unconnected `any` input, unknown type). */
export function outputKind(doc: GraphDoc, registry: NodeRegistry, ref: PortRef): 'field' | 'color' | null {
  // Built when the first `sameAs` is met, so that a chain of them costs one pass over the edges, not one per link.
  let sources: Map<string, PortRef> | null = null;
  const visited = new Set<string>();
  let at: PortRef = ref;
  for (;;) {
    const node = own(doc.nodes, at.node);
    const port = node && registry.get(node.type)?.outputs.find((p) => p.name === at.port);
    if (!port) return null;
    if (port.type === 'field' || port.type === 'color') return port.type;
    if (typeof port.type !== 'object') return null;
    // A cycle of sameAs outputs has no kind. Each round adds a key, so the loop ends after at most one round per output.
    const key = inputKey(at);
    if (visited.has(key)) return null;
    visited.add(key);
    sources ??= new Map(usedEdges(doc, registry).map((edge) => [inputKey(edge.to), edge.from]));
    const from = sources.get(inputKey({ node: at.node, port: port.type.sameAs }));
    if (!from) return null;
    at = from;
  }
}
