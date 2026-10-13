// Connections in the editor (runtime.md 4.3). Whether a connection is legal is `validateConnection` and nothing
// else; this module turns what the node-graph library proposes into port references, words the refusal of a
// connection the library itself would not even ask about, says which node types a dragged wire can end at, and
// plans the insertion of a node into a wire. Pure: no DOM, no React.

import type { NodeDef, PortDef } from '../../../core/api.ts';
import { connect, validateConnection, type DocDraft, type GraphDoc, type NodeRegistry, type PortRef } from '../../../core/runtime.ts';
import { parseFlowId, parseHandleId } from './flow.ts';
import { declaredTone, inputsOf, nodeTitle, own, type PortTone } from './model.ts';

/** One end of a wire: a port and the side of its node it is on. */
export interface PortEnd { readonly node: string; readonly side: 'in' | 'out'; readonly port: string }

/** The end a dragged wire is fixed at: an output it comes from, or an input it goes to. */
export type Pending = { readonly from: PortRef; readonly to?: undefined } | { readonly to: PortRef; readonly from?: undefined };

/** A port of the library's node and handle ids; null for ids that are not a node's port. */
export function portEnd(flowNodeId: string | null | undefined, handle: string | null | undefined): PortEnd | null {
  const node = typeof flowNodeId === 'string' ? parseFlowId(flowNodeId) : null;
  const port = parseHandleId(handle);
  return node && node.kind === 'node' && port ? { node: node.id, side: port.side, port: port.port } : null;
}

/** The connection the library proposes, from an output to an input; null when it is not between two ports. */
export function connectionRefs(connection: {
  readonly source: string | null; readonly sourceHandle?: string | null; readonly target: string | null; readonly targetHandle?: string | null;
}): { readonly from: PortRef; readonly to: PortRef } | null {
  const from = portEnd(connection.source, connection.sourceHandle);
  const to = portEnd(connection.target, connection.targetHandle);
  if (!from || !to || from.side !== 'out' || to.side !== 'in') return null;
  return { from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } };
}

/**
 * Why a wire between two ports is refused, in one sentence; null when the connection is legal. Between an
 * output and an input the answer is `validateConnection`'s.
 */
export function refusal(doc: GraphDoc, registry: NodeRegistry, a: PortEnd, b: PortEnd): string | null {
  if (a.side === b.side) return a.side === 'out' ? 'An output connects to an input, not to another output' : 'An input connects to an output, not to another input';
  const [from, to] = a.side === 'out' ? [a, b] : [b, a];
  return validateConnection(doc, registry, { node: from.node, port: from.port }, { node: to.node, port: to.port });
}

/** Whether the port takes what the wire carries without conversion. A mask input is for masks: a terrain is not led into it unasked. */
function carries(port: PortDef, tone: PortTone | null): boolean {
  if (tone === null || tone === 'any' || port.type === 'any' || typeof port.type === 'object') return true;
  if ((port.type === 'color') !== (tone === 'color')) return false;
  return port.role !== 'mask' || tone === 'mask';
}

/**
 * The port of a node of type `def` that a dragged wire ends at: the first that takes what the wire carries
 * without conversion, else the first. Every combination of field and colour connects (4.3 rule 4), so a type
 * with a port on the right side always has one. Null: the type has no port on that side.
 */
export function portForWire(def: NodeDef, pending: Pending, tone: PortTone | null = null): string | null {
  const ports = pending.from ? inputsOf(def) : def.outputs;
  return (ports.find((port) => carries(port, tone)) ?? ports[0])?.name ?? null;
}

/** Whether the palette offers the type for a dragged wire. */
export function acceptsWire(def: NodeDef, pending: Pending | null): boolean {
  return pending === null || portForWire(def, pending) !== null;
}

/** The connection of a new node `nodeId` to the fixed end of a dragged wire. */
export function pendingConnection(def: NodeDef, nodeId: string, pending: Pending, tone: PortTone | null = null): { readonly from: PortRef; readonly to: PortRef } | null {
  const port = portForWire(def, pending, tone);
  if (port === null) return null;
  return pending.from ? { from: pending.from, to: { node: nodeId, port } } : { from: { node: nodeId, port }, to: pending.to };
}

// ---- a wire onto a node ----------------------------------------------------------------------------------------------

/**
 * Where a wire that was let go over a node, off its ports, is connected. From an output: the node's first free
 * input that takes what the wire carries; an input that has a wire already is never taken over this way. From an
 * input: the node's output of the kind the input is for, else its first. Returns the connection, or the reason
 * in one sentence when there is none, or null for a node the wire has nothing to do with (its own, one of an
 * unknown type). `ignoreEdge` is the wire being moved: the input it holds counts as free.
 */
export function wireOntoNode(
  doc: GraphDoc, registry: NodeRegistry, from: PortEnd, nodeId: string, tone: PortTone | null = null, ignoreEdge: string | null = null,
): { readonly from: PortRef; readonly to: PortRef } | string | null {
  const node = own(doc.nodes, nodeId);
  const def = node ? registry.get(node.type) : undefined;
  if (!node || !def || from.node === nodeId) return null;
  const title = nodeTitle(node, def);
  const fixed = { node: from.node, port: from.port };
  let refs: { readonly from: PortRef; readonly to: PortRef };
  if (from.side === 'out') {
    const taken = new Set(Object.values(doc.edges).filter((edge) => edge.to.node === nodeId && edge.id !== ignoreEdge).map((edge) => edge.to.port));
    const port = inputsOf(def).find((candidate) => !taken.has(candidate.name) && carries(candidate, tone));
    if (!port) return inputsOf(def).length === 0 ? `${title} has no input` : `${title} has no free input for this wire`;
    refs = { from: fixed, to: { node: nodeId, port: port.name } };
  } else {
    const port = def.outputs.find((candidate) => tone !== null && declaredTone(candidate) === tone) ?? def.outputs[0];
    if (!port) return `${title} has no output`;
    refs = { from: { node: nodeId, port: port.name }, to: fixed };
  }
  return validateConnection(doc, registry, refs.from, refs.to) ?? refs;
}

// ---- a node into a wire ----------------------------------------------------------------------------------------------

export interface InsertPlan { readonly edgeId: string; readonly input: string; readonly output: string }

/**
 * How the node goes into the wire: the wire's source into the node's first input, the node's first output into
 * the wire's target. Null when the node has no input or no output, when either is in use already, when the wire
 * is the node's own, or when one of the two connections is refused.
 */
export function insertPlan(doc: GraphDoc, registry: NodeRegistry, nodeId: string, edgeId: string): InsertPlan | null {
  const node = own(doc.nodes, nodeId);
  const edge = own(doc.edges, edgeId);
  const def = node ? registry.get(node.type) : undefined;
  if (!node || !edge || !def) return null;
  if (edge.from.node === nodeId || edge.to.node === nodeId) return null;
  const input = inputsOf(def)[0]?.name;
  const output = def.outputs[0]?.name;
  if (input === undefined || output === undefined) return null;
  for (const other of Object.values(doc.edges)) {
    if (other.to.node === nodeId && other.to.port === input) return null;
    if (other.from.node === nodeId && other.from.port === output) return null;
  }
  if (validateConnection(doc, registry, edge.from, { node: nodeId, port: input }) !== null) return null;
  if (validateConnection(doc, registry, { node: nodeId, port: output }, edge.to) !== null) return null;
  return { edgeId, input, output };
}

/** Puts the node into the wire. The second connection replaces the wire itself: an input has one edge (4.3 rule 2). */
export function applyInsert(draft: DocDraft, registry: NodeRegistry, nodeId: string, plan: InsertPlan): void {
  const edge = own(draft.edges, plan.edgeId);
  if (!edge) return;
  const from = { node: edge.from.node, port: edge.from.port };
  const to = { node: edge.to.node, port: edge.to.port };
  connect(draft, registry, from, { node: nodeId, port: plan.input });
  connect(draft, registry, { node: nodeId, port: plan.output }, to);
}
