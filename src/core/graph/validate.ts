import { own, type Edge, type GraphDoc, type PortRef } from './doc.ts';
import { inputsOf } from './ports.ts';
import type { NodeRegistry } from './registry.ts';

/** Rule 1 of runtime.md 4.3: `from` names an output of an existing node of a known type, `to` an input of another. */
function endpointProblem(doc: GraphDoc, registry: NodeRegistry, from: PortRef, to: PortRef): string | null {
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

/**
 * Whether an edge from `from` into `to` would close a cycle: whether `to.node` already reaches `from.node`.
 * Every edge of the document counts, also one the evaluator ignores, so a document made by the commands never
 * holds a cycle of any kind. The edge `connect` replaces, the one into `to`, cannot be part of such a path.
 */
export function createsCycle(doc: GraphDoc, from: PortRef, to: PortRef): boolean {
  if (from.node === to.node) return true;
  const next = new Map<string, string[]>();
  for (const edge of Object.values(doc.edges)) {
    const targets = next.get(edge.from.node);
    if (targets) targets.push(edge.to.node);
    else next.set(edge.from.node, [edge.to.node]);
  }
  const seen = new Set<string>([to.node]);
  const stack = [to.node];
  while (stack.length > 0) {
    for (const node of next.get(stack.pop()!) ?? []) {
      if (node === from.node) return true;
      if (!seen.has(node)) {
        seen.add(node);
        stack.push(node);
      }
    }
  }
  return false;
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

/**
 * The edges of a document that break a rule of runtime.md 4.3, in record order, each under the first rule it
 * breaks: rule 1 (the evaluator ignores the edge), rule 2 (an earlier edge into the same input is the one
 * used), rule 3 (the edge is used and lies on a cycle of used edges).
 */
export function invalidEdges(doc: GraphDoc, registry: NodeRegistry): EdgeProblem[] {
  const problems = new Map<string, EdgeProblem>();
  const taken = new Set<string>();
  const used: (readonly [edgeId: string, edge: Edge])[] = [];
  for (const [edgeId, edge] of Object.entries(doc.edges)) {
    const endpoint = endpointProblem(doc, registry, edge.from, edge.to);
    const input = JSON.stringify([edge.to.node, edge.to.port]);
    if (endpoint !== null) problems.set(edgeId, { edgeId, rule: 1, message: endpoint });
    else if (taken.has(input)) problems.set(edgeId, { edgeId, rule: 2, message: `The input "${edge.to.port}" already has a connection` });
    else {
      taken.add(input);
      used.push([edgeId, edge]);
    }
  }
  const component = strongComponents(used.map(([, edge]) => edge));
  for (const [edgeId, edge] of used) {
    if (component.has(edge.from.node)) {
      problems.set(edgeId, { edgeId, rule: 3, message: 'Part of a cycle' });
    }
  }
  return Object.keys(doc.edges).flatMap((edgeId) => problems.get(edgeId) ?? []);
}

/** Tarjan's algorithm without recursion: node id → the index of its strongly connected component. */
function strongComponents(edges: readonly Edge[]): Map<string, number> {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (!next.has(edge.to.node)) next.set(edge.to.node, []);
    const targets = next.get(edge.from.node);
    if (targets) targets.push(edge.to.node);
    else next.set(edge.from.node, [edge.to.node]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const component = new Map<string, number>();
  const open: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;
  let components = 0;
  for (const root of next.keys()) {
    if (index.has(root)) continue;
    const frames: { node: string; child: number }[] = [{ node: root, child: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    open.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = next.get(frame.node)!;
      if (frame.child < targets.length) {
        const target = targets[frame.child++]!;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter++);
          open.push(target);
          onStack.add(target);
          frames.push({ node: target, child: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        for (;;) {
          const member = open.pop()!;
          onStack.delete(member);
          component.set(member, components);
          if (member === frame.node) break;
        }
        components++;
      }
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
  const visited = new Set<string>();
  let at: PortRef = ref;
  for (;;) {
    const node = own(doc.nodes, at.node);
    const port = node && registry.get(node.type)?.outputs.find((p) => p.name === at.port);
    if (!port) return null;
    if (port.type === 'field' || port.type === 'color') return port.type;
    if (typeof port.type !== 'object') return null;
    // A cycle of sameAs outputs has no kind.
    const key = JSON.stringify([at.node, at.port]);
    if (visited.has(key)) return null;
    visited.add(key);
    const edge = inputEdge(doc, registry, { node: at.node, port: port.type.sameAs });
    if (!edge) return null;
    at = edge.from;
  }
}
