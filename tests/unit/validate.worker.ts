// The worker of the test "graphs of 20 000 nodes" in validate.test.ts: it builds each graph, runs the graph
// functions on it and posts numbers. The test starts it with a heap limit and a deadline, so a traversal that
// does not end or that hoards memory fails that one test, at the deadline at the latest.
//
// Only counts cross the thread boundary. A list of 20 000 problems must never reach an assertion: when a
// deepEqual of a long list fails, node:assert builds a diff whose memory grows with the square of its length.

import { parentPort, workerData } from 'node:worker_threads';
import type { Edge, GraphDoc, NodeInstance } from '../../src/core/graph/doc.ts';
import { newDoc } from '../../src/core/graph/serialize.ts';
import { cycleNodes, invalidEdges, outputKind, usedEdges, validateConnection } from '../../src/core/graph/validate.ts';
import { registry } from './graph-fixtures.ts';

/** The number of nodes of each graph, stated by the test that starts this worker. */
const NODES: number = (workerData as { nodes: number } | null)?.nodes ?? 0;

export type Counts = Readonly<Record<string, number | string | null>>;
export type WorkerReport = { readonly name: string; readonly counts: Counts } | { readonly done: true };

class Builder {
  readonly nodes: Record<string, NodeInstance> = {};
  readonly edges: Record<string, Edge> = {};
  private count = 0;
  node(id: string, type: string): void {
    this.nodes[id] = { id, type, version: 1, position: { x: 0, y: 0 }, params: {} };
  }
  edge(from: string, fromPort: string, to: string, toPort: string): void {
    const id = `e${this.count++}`;
    this.edges[id] = { id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } };
  }
  doc(): GraphDoc {
    return { ...newDoc(), nodes: this.nodes, edges: this.edges };
  }
}

function measure(doc: GraphDoc): Record<string, number> {
  const invalid = invalidEdges(doc, registry);
  return {
    edges: Object.keys(doc.edges).length,
    used: usedEdges(doc, registry).length,
    rule1: invalid.filter((p) => p.rule === 1).length,
    rule2: invalid.filter((p) => p.rule === 2).length,
    rule3: invalid.filter((p) => p.rule === 3).length,
    cycleNodes: cycleNodes(doc, registry).size,
  };
}

const last = `n${NODES - 1}`;

const cases: Readonly<Record<string, () => Counts>> = {
  /** g -> n0 -> n1 -> ... : one path, no cycle. */
  chain() {
    const b = new Builder();
    b.node('g', 'ref/gen');
    for (let i = 0; i < NODES; i++) b.node(`n${i}`, 'ref/soften');
    b.edge('g', 'out', 'n0', 'in');
    for (let i = 1; i < NODES; i++) b.edge(`n${i - 1}`, 'out', `n${i}`, 'in');
    const doc = b.doc();
    return {
      ...measure(doc),
      closing: validateConnection(doc, registry, { node: last, port: 'out' }, { node: 'n0', port: 'mask' }),
      onward: validateConnection(doc, registry, { node: 'g', port: 'out' }, { node: last, port: 'mask' }),
      kind: outputKind(doc, registry, { node: last, port: 'out' }),
    };
  },

  /** n0 -> n1 -> ... -> n0: every node and every edge is on the one cycle. */
  ring() {
    const b = new Builder();
    b.node('g', 'ref/gen');
    for (let i = 0; i < NODES; i++) b.node(`n${i}`, 'ref/soften');
    for (let i = 0; i < NODES; i++) b.edge(`n${i}`, 'out', `n${(i + 1) % NODES}`, 'in');
    const doc = b.doc();
    return {
      ...measure(doc),
      kind: outputKind(doc, registry, { node: 'n0', port: 'out' }),
      // The search for a path from n0 back to g goes once round the ring and finds none.
      outside: validateConnection(doc, registry, { node: 'g', port: 'out' }, { node: 'n0', port: 'mask' }),
    };
  },

  /**
   * A chain n(i-1) -> n(i).a with a skip n(i-3) -> n(i).mask, and for every i divisible by 100 the edge
   * n(i+7) -> n(i).b back. The 200 blocks n(i) .. n(i+7) are the cycles: 8 nodes each, and inside each
   * 7 chain edges, 5 skip edges and the edge back.
   */
  braid() {
    const b = new Builder();
    for (let i = 0; i < NODES; i++) b.node(`n${i}`, 'ref/combine');
    for (let i = 1; i < NODES; i++) b.edge(`n${i - 1}`, 'out', `n${i}`, 'a');
    for (let i = 3; i < NODES; i++) b.edge(`n${i - 3}`, 'out', `n${i}`, 'mask');
    for (let i = 0; i + 7 < NODES; i += 100) b.edge(`n${i + 7}`, 'out', `n${i}`, 'b');
    return measure(b.doc());
  },

  /** The chain, closed by a second edge into n0.in: the evaluator ignores that edge, so nothing is on a cycle. */
  ignored() {
    const b = new Builder();
    b.node('g', 'ref/gen');
    for (let i = 0; i < NODES; i++) b.node(`n${i}`, 'ref/soften');
    b.edge('g', 'out', 'n0', 'in');
    for (let i = 1; i < NODES; i++) b.edge(`n${i - 1}`, 'out', `n${i}`, 'in');
    b.edge(last, 'out', 'n0', 'in');
    const doc = b.doc();
    return {
      ...measure(doc),
      // The ignored edge is an edge all the same: a connection along it would close a cycle of edges.
      along: validateConnection(doc, registry, { node: 'n0', port: 'out' }, { node: last, port: 'mask' }),
    };
  },

  /** One output into 20 000 inputs. */
  fan() {
    const b = new Builder();
    b.node('g', 'ref/gen');
    for (let i = 0; i < NODES; i++) {
      b.node(`n${i}`, 'ref/colorize');
      b.edge('g', 'out', `n${i}`, 'in');
    }
    return measure(b.doc());
  },
};

if (parentPort) {
  for (const [name, run] of Object.entries(cases)) parentPort.postMessage({ name, counts: run() } satisfies WorkerReport);
  parentPort.postMessage({ done: true } satisfies WorkerReport);
}
