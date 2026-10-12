// Graph validity (runtime.md 4.3) and the view after a selection (7.4).
//
// Every graph in this file is written out by hand and has a handful of edges, so a failing deepEqual prints a
// short diff. The graphs of 20 000 nodes are built and measured in validate.worker.ts, under a heap limit and a
// deadline, and only their counts are compared here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createsCycle, cycleNodes, endpointProblem, hasCycle, inputEdge, invalidEdges, reaches, usedEdges } from '../../src/core/graph/validate.ts';
import {
  newDoc, outputKind, validateConnection, viewAfterSelect,
  type Edge, type GraphDoc, type NodeInstance, type PortRef, type ViewBinding,
} from '../../src/core/runtime.ts';
import { registry } from './graph-fixtures.ts';
import type { Counts, WorkerReport } from './validate.worker.ts';

const ref = (text: string): PortRef => {
  const [node, port] = text.split('.') as [string, string];
  return { node, port };
};

/** A document from `id: type` pairs and `from -> to` edges; edge ids are e0, e1, ... in the order given. */
function doc(nodes: Readonly<Record<string, string>>, edges: readonly string[] = [], view?: ViewBinding): GraphDoc {
  const instances: Record<string, NodeInstance> = {};
  for (const [id, type] of Object.entries(nodes)) instances[id] = { id, type, version: 1, position: { x: 0, y: 0 }, params: {} };
  const records: Record<string, Edge> = {};
  edges.forEach((text, i) => {
    const [from, to] = text.split(' -> ') as [string, string];
    records[`e${i}`] = { id: `e${i}`, from: ref(from), to: ref(to) };
  });
  return { ...newDoc(), nodes: instances, edges: records, ui: view ? { view } : {} };
}
const check = (d: GraphDoc, from: string, to: string): string | null => validateConnection(d, registry, ref(from), ref(to));

test('rule 1: from names an output of a known node, to an input of another', () => {
  const d = doc({ g: 'ref/gen', s: 'ref/soften', c: 'ref/combine', ghost: 'legacy/unknown' });
  assert.equal(check(d, 'g.out', 's.in'), null);
  assert.equal(check(d, 'g.out', 'c.b'), null);
  assert.equal(check(d, 'nope.out', 's.in'), 'The source node does not exist');
  assert.equal(check(d, 'g.out', 'nope.in'), 'The target node does not exist');
  assert.equal(check(d, 'ghost.out', 's.in'), 'Unknown node type "legacy/unknown"');
  assert.equal(check(d, 'g.out', 'ghost.in'), 'Unknown node type "legacy/unknown"');
  assert.equal(check(d, 'g.result', 's.in'), 'Gen (Reference) has no output "result"');
  assert.equal(check(d, 'g.out', 's.src'), 'Soften (Reference) has no input "src"');
  assert.equal(check(d, 's.in', 'c.a'), 'Soften (Reference) has no output "in"');
  assert.equal(check(d, 's.out', 's.in'), 'A node cannot be connected to itself');
  // Ids are arbitrary strings: a name every object inherits is not a node.
  assert.equal(check(d, 'constructor.out', 's.in'), 'The source node does not exist');
  assert.equal(check(d, 'g.out', 'toString.in'), 'The target node does not exist');
});

test('rule 1: a maskable node also has the input mask; another node has it only when it declares it', () => {
  const d = doc({ g: 'ref/gen', s: 'ref/soften', c: 'ref/combine', k: 'ref/colorize' });
  assert.equal(check(d, 'g.out', 's.mask'), null);
  assert.equal(check(d, 'g.out', 'c.mask'), null);
  assert.equal(check(d, 'g.out', 'k.mask'), 'Colorize (Reference) has no input "mask"');
});

test('rule 4: field and color ports connect in every combination', () => {
  const d = doc({ g: 'ref/gen', k: 'ref/colorize', k2: 'ref/colorize', c: 'ref/combine', s: 'ref/soften' });
  assert.equal(check(d, 'g.out', 'k.base'), null);      // field -> color
  assert.equal(check(d, 'k.out', 'k2.in'), null);       // color -> field
  assert.equal(check(d, 'k.out', 'k2.base'), null);     // color -> color
  assert.equal(check(d, 'k.out', 's.in'), null);        // color -> any
  assert.equal(check(d, 's.out', 'c.a'), null);         // sameAs -> field
});

test('rule 3: a connection that would close a cycle is refused', () => {
  const d = doc({ a: 'ref/soften', b: 'ref/soften', c: 'ref/soften', d: 'ref/soften' }, ['a.out -> b.in', 'b.out -> c.in']);
  assert.equal(check(d, 'c.out', 'a.in'), 'The connection would create a cycle');
  assert.equal(check(d, 'c.out', 'a.mask'), 'The connection would create a cycle');
  assert.equal(check(d, 'b.out', 'a.in'), 'The connection would create a cycle');
  assert.equal(check(d, 'a.out', 'c.mask'), null);      // a second path, no cycle
  assert.equal(check(d, 'c.out', 'd.in'), null);
  assert.equal(check(d, 'd.out', 'a.in'), null);
});

test('rule 2: an occupied input is no obstacle, since connect replaces its edge', () => {
  const d = doc({ a: 'ref/soften', b: 'ref/soften', g: 'ref/gen' }, ['a.out -> b.in']);
  assert.equal(check(d, 'g.out', 'b.in'), null);
  assert.equal(check(d, 'a.out', 'b.in'), null);
  assert.equal(createsCycle(d, ref('b.out'), ref('a.in')), true);
  assert.equal(createsCycle(d, ref('g.out'), ref('b.in')), false);
});

test('a cycle is found through edges the evaluator ignores', () => {
  // The second edge into b.in and the edge of the unknown type are ignored by the evaluator, but they are edges.
  const d = doc({ a: 'ref/soften', b: 'ref/soften', c: 'ref/soften', g: 'ref/gen', ghost: 'legacy/unknown' },
    ['g.out -> b.in', 'a.out -> b.in', 'b.out -> ghost.in', 'ghost.out -> c.in']);
  assert.equal(check(d, 'b.out', 'a.in'), 'The connection would create a cycle');
  assert.equal(check(d, 'c.out', 'b.mask'), 'The connection would create a cycle');
  assert.equal(check(d, 'c.out', 'a.in'), 'The connection would create a cycle');
  assert.equal(check(d, 'a.out', 'c.mask'), null);
});

test('an existing edge of a cycle is itself reported by validateConnection', () => {
  const d = doc({ a: 'ref/soften', b: 'ref/soften' }, ['a.out -> b.in', 'b.out -> a.in']);
  assert.equal(check(d, 'a.out', 'b.in'), 'The connection would create a cycle');
});

test('invalidEdges: each edge under the first rule it breaks, in record order', () => {
  const d = doc(
    { g: 'ref/gen', s: 'ref/soften', ghost: 'legacy/unknown', after: 'ref/soften', la: 'ref/soften', lb: 'ref/soften', tail: 'ref/soften' },
    [
      'g.out -> s.in',          // e0 fine
      'g.out -> ghost.in',      // e1 rule 1
      'ghost.out -> after.in',  // e2 rule 1
      'g.out -> s.in',          // e3 rule 2: e0 is used
      'lb.out -> la.in',        // e4 rule 3
      'la.out -> lb.in',        // e5 rule 3
      'la.out -> tail.in',      // e6 fine: it leaves the cycle
      's.out -> gone.in',       // e7 rule 1
      'g.nope -> after.mask',   // e8 rule 1
    ],
  );
  assert.deepEqual(invalidEdges(d, registry), [
    { edgeId: 'e1', rule: 1, message: 'Unknown node type "legacy/unknown"' },
    { edgeId: 'e2', rule: 1, message: 'Unknown node type "legacy/unknown"' },
    { edgeId: 'e3', rule: 2, message: 'The input "in" already has a connection' },
    { edgeId: 'e4', rule: 3, message: 'Part of a cycle' },
    { edgeId: 'e5', rule: 3, message: 'Part of a cycle' },
    { edgeId: 'e7', rule: 1, message: 'The target node does not exist' },
    { edgeId: 'e8', rule: 1, message: 'Gen (Reference) has no output "nope"' },
  ]);
  assert.deepEqual(invalidEdges(doc({ g: 'ref/gen', s: 'ref/soften' }, ['g.out -> s.in', 'g.out -> s.mask']), registry), []);
});

test('invalidEdges: only edges on a cycle are reported, in graphs with several', () => {
  const nodes = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, 'ref/combine']));
  const d = doc(nodes, [
    'a.out -> b.a',   // e0 cycle a b c
    'b.out -> c.a',   // e1
    'c.out -> a.a',   // e2
    'c.out -> d.a',   // e3 bridge between the cycles
    'd.out -> e.a',   // e4 cycle d e
    'e.out -> d.b',   // e5
    'e.out -> f.a',   // e6 leaves
    'a.out -> f.b',   // e7 leaves
  ]);
  assert.deepEqual(invalidEdges(d, registry).map((p) => p.edgeId), ['e0', 'e1', 'e2', 'e4', 'e5']);
});

test('invalidEdges: an edge the evaluator ignores closes no cycle', () => {
  // e1 is a second edge into a.in and e2 comes from an unknown type, so neither is used.
  const d = doc({ a: 'ref/soften', b: 'ref/soften', g: 'ref/gen', ghost: 'legacy/unknown' },
    ['g.out -> a.in', 'b.out -> a.in', 'ghost.out -> b.mask', 'a.out -> b.in']);
  assert.deepEqual(invalidEdges(d, registry).map((p) => [p.edgeId, p.rule]), [['e1', 2], ['e2', 1]]);
});

test('invalidEdges: a graph without a cycle has no edge on one', () => {
  // The edges of a tree, of a diamond and of a chain are used and lie on no cycle.
  const d = doc({ g: 'ref/gen', a: 'ref/soften', b: 'ref/soften', c: 'ref/combine', tail: 'ref/soften' },
    ['g.out -> a.in', 'g.out -> b.in', 'a.out -> c.a', 'b.out -> c.b', 'g.out -> c.mask', 'c.out -> tail.in']);
  assert.deepEqual(invalidEdges(d, registry), []);
  assert.deepEqual([...cycleNodes(d, registry)], []);
  assert.equal(usedEdges(d, registry).length, 6);
});

test('usedEdges: the edges the evaluator uses, in record order', () => {
  const d = doc({ g: 'ref/gen', h: 'ref/gen', s: 'ref/soften', ghost: 'legacy/unknown' },
    ['ghost.out -> s.in', 'h.out -> s.in', 'g.out -> s.in', 'g.out -> s.mask', 'g.out -> ghost.in', 's.out -> s.mask']);
  assert.deepEqual(usedEdges(d, registry).map((e) => e.id), ['e1', 'e3']);
  assert.deepEqual(usedEdges(doc({ g: 'ref/gen' }), registry), []);
});

test('cycleNodes: the nodes on a cycle of used edges, and no node beside it', () => {
  const nodes = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => [id, 'ref/combine']));
  const d = doc(nodes, [
    'a.out -> b.a',   // cycle a b c
    'b.out -> c.a',
    'c.out -> a.a',
    'c.out -> d.a',   // d lies between the cycles, on neither
    'd.out -> e.a',   // cycle e f
    'e.out -> f.a',
    'f.out -> e.b',
    'f.out -> g.a',   // g hangs off a cycle
  ]);
  assert.deepEqual([...cycleNodes(d, registry)].sort(), ['a', 'b', 'c', 'e', 'f']);
  // A cycle that closes only through an edge the evaluator ignores is none.
  const open = doc({ g: 'ref/gen', a: 'ref/soften', b: 'ref/soften' }, ['g.out -> a.in', 'a.out -> b.in', 'b.out -> a.in']);
  assert.deepEqual([...cycleNodes(open, registry)], []);
  assert.deepEqual(invalidEdges(open, registry).map((p) => [p.edgeId, p.rule]), [['e2', 2]]);
});

test('reaches and hasCycle work on a list of edges alone', () => {
  const edges = Object.values(doc({}, ['a.out -> b.in', 'b.out -> c.in', 'a.out -> c.mask', 'x.out -> y.in']).edges);
  assert.equal(reaches(edges, 'a', 'c'), true);
  assert.equal(reaches(edges, 'c', 'a'), false);
  assert.equal(reaches(edges, 'a', 'y'), false);
  assert.equal(reaches(edges, 'a', 'a'), true);          // a node reaches itself
  assert.equal(reaches(edges, 'nowhere', 'a'), false);
  assert.equal(reaches([], 'a', 'b'), false);
  assert.equal(hasCycle(edges), false);
  assert.equal(hasCycle([]), false);
  assert.equal(hasCycle([...edges, ...Object.values(doc({}, ['c.out -> a.in']).edges)]), true);
  assert.equal(hasCycle(Object.values(doc({}, ['a.out -> a.in']).edges)), true);
  // Two edges between the same two nodes, in one direction, are no cycle.
  assert.equal(hasCycle(Object.values(doc({}, ['a.out -> b.a', 'a.out -> b.b']).edges)), false);
});

test('endpointProblem is rule 1 alone: it knows no cycle and no occupied input', () => {
  const d = doc({ a: 'ref/soften', b: 'ref/soften' }, ['a.out -> b.in']);
  assert.equal(endpointProblem(d, registry, ref('b.out'), ref('a.in')), null);
  assert.equal(endpointProblem(d, registry, ref('a.out'), ref('b.in')), null);
  assert.equal(endpointProblem(d, registry, ref('a.out'), ref('a.in')), 'A node cannot be connected to itself');
  assert.equal(check(d, 'b.out', 'a.in'), 'The connection would create a cycle');
});

// ---- graphs of 20 000 nodes -------------------------------------------------------------------------------------

const NODES = 20_000;
const HEAP_LIMIT_MB = 256;
/** A backstop, not a measurement: the five graphs together take well under a second. */
const DEADLINE_MS = 30_000;

/** Runs validate.worker.ts and returns the counts of each case. Rejects when the worker dies, exceeds its heap limit or misses the deadline. */
function measureLargeGraphs(): Promise<Map<string, Counts>> {
  return new Promise((resolve, reject) => {
    const counts = new Map<string, Counts>();
    const worker = new Worker(new URL('./validate.worker.ts', import.meta.url), {
      workerData: { nodes: NODES },
      resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB },
    });
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      void worker.terminate();
      finish();
    };
    const timer = setTimeout(() => settle(() => {
      reject(new Error(`the graph functions did not finish within ${DEADLINE_MS} ms; finished: ${[...counts.keys()].join(', ') || 'none'}`));
    }), DEADLINE_MS);
    worker.on('message', (report: WorkerReport) => {
      if ('done' in report) settle(() => resolve(counts));
      else counts.set(report.name, report.counts);
    });
    worker.on('error', (error) => settle(() => reject(error)));
    worker.on('exit', (code) => settle(() => reject(new Error(`the worker stopped with code ${code} before it reported`))));
  });
}

test('graphs of 20 000 nodes: every traversal ends, within a heap limit, and reports only the edges on a cycle', async () => {
  const counts = await measureLargeGraphs();
  // Compared member by member: a wrong count fails with two numbers, never with a diff of a long list.
  const expect = (name: string, expected: Counts): void => {
    const actual = counts.get(name);
    assert.ok(actual, `the case "${name}" did not report`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), name);
    for (const [member, value] of Object.entries(expected)) assert.equal(actual[member], value, `${name}.${member}`);
  };
  expect('chain', {
    edges: NODES, used: NODES, rule1: 0, rule2: 0, rule3: 0, cycleNodes: 0,
    closing: 'The connection would create a cycle', onward: null, kind: 'field',
  });
  expect('ring', { edges: NODES, used: NODES, rule1: 0, rule2: 0, rule3: NODES, cycleNodes: NODES, kind: null, outside: null });
  // 19 999 chain edges, 19 997 skip edges and 200 edges back; 200 blocks of 8 nodes with 7 + 5 + 1 edges inside.
  expect('braid', { edges: 40_196, used: 40_196, rule1: 0, rule2: 0, rule3: 2600, cycleNodes: 1600 });
  expect('ignored', { edges: NODES + 1, used: NODES, rule1: 0, rule2: 1, rule3: 0, cycleNodes: 0, along: 'The connection would create a cycle' });
  expect('fan', { edges: NODES, used: NODES, rule1: 0, rule2: 0, rule3: 0, cycleNodes: 0 });
  assert.equal(counts.size, 5);
});

test('inputEdge: the first edge in record order that does not break rule 1', () => {
  const d = doc({ g: 'ref/gen', h: 'ref/gen', s: 'ref/soften', ghost: 'legacy/unknown' }, ['ghost.out -> s.in', 'h.out -> s.in', 'g.out -> s.in']);
  assert.equal(inputEdge(d, registry, ref('s.in'))?.id, 'e1');
  assert.equal(inputEdge(d, registry, ref('s.mask')), null);
  assert.equal(inputEdge(d, registry, ref('nope.in')), null);
});

test('outputKind: the port type, and sameAs resolved through the connections', () => {
  const d = doc(
    { g: 'ref/gen', k: 'ref/colorize', sField: 'ref/soften', sColor: 'ref/soften', sChain: 'ref/soften', sOpen: 'ref/soften', ghost: 'legacy/unknown', sGhost: 'ref/soften' },
    ['g.out -> k.in', 'g.out -> sField.in', 'k.out -> sColor.in', 'sColor.out -> sChain.in', 'ghost.out -> sGhost.in'],
  );
  const kind = (text: string) => outputKind(d, registry, ref(text));
  assert.equal(kind('g.out'), 'field');
  assert.equal(kind('k.out'), 'color');
  assert.equal(kind('sField.out'), 'field');
  assert.equal(kind('sColor.out'), 'color');
  assert.equal(kind('sChain.out'), 'color');
  assert.equal(kind('sOpen.out'), null);       // unconnected `any` input
  assert.equal(kind('sGhost.out'), null);      // the edge from an unknown type is ignored
  assert.equal(kind('ghost.out'), null);       // unknown type
  assert.equal(kind('nope.out'), null);
  assert.equal(kind('g.nope'), null);
  assert.equal(kind('k.in'), null);            // an input is no output
});

test('outputKind: the first usable edge decides, and a cycle of sameAs outputs has no kind', () => {
  const first = doc({ g: 'ref/gen', k: 'ref/colorize', s: 'ref/soften' }, ['k.out -> s.in', 'g.out -> s.in', 'g.out -> k.in']);
  assert.equal(outputKind(first, registry, ref('s.out')), 'color');
  const loop = doc({ a: 'ref/soften', b: 'ref/soften' }, ['a.out -> b.in', 'b.out -> a.in']);
  assert.equal(outputKind(loop, registry, ref('a.out')), null);
});

// ---- 7.4: the table of viewAfterSelect -------------------------------------------------------------------------

const viewDoc = (view?: ViewBinding): GraphDoc => doc(
  { g: 'ref/gen', k: 'ref/colorize', sel: 'ref/select', sColor: 'ref/soften', sOpen: 'ref/soften', sink: 'ref/sink', ghost: 'legacy/unknown' },
  ['g.out -> k.in', 'g.out -> sel.in', 'k.out -> sColor.in'],
  view,
);
const select = (view: ViewBinding | undefined, text: string): ViewBinding | undefined => viewAfterSelect(viewDoc(view), registry, ref(text));
const terrain: ViewBinding = { height: ref('g.out') };

test('a field of role height becomes the height, without an overlay', () => {
  assert.deepEqual(select(undefined, 'g.out'), { height: ref('g.out') });
  assert.deepEqual(select({ height: ref('sel.flow'), overlay: { ref: ref('k.out'), as: 'color', opacity: 0.5 } }, 'g.out'), { height: ref('g.out') });
});

test('a mask, a data field and a colour become the overlay; the height stays', () => {
  assert.deepEqual(select(terrain, 'sel.out'), { height: ref('g.out'), overlay: { ref: ref('sel.out'), as: 'mask', opacity: 1 } });
  assert.deepEqual(select(terrain, 'sel.flow'), { height: ref('g.out'), overlay: { ref: ref('sel.flow'), as: 'heat', opacity: 1 } });
  assert.deepEqual(select(terrain, 'k.out'), { height: ref('g.out'), overlay: { ref: ref('k.out'), as: 'color', opacity: 1 } });
  assert.deepEqual(select(terrain, 'sColor.out'), { height: ref('g.out'), overlay: { ref: ref('sColor.out'), as: 'color', opacity: 1 } });
  // Without a height the overlay lies on a flat plane.
  assert.deepEqual(select(undefined, 'sel.out'), { overlay: { ref: ref('sel.out'), as: 'mask', opacity: 1 } });
  // A new overlay replaces the old one and its opacity.
  assert.deepEqual(
    select({ height: ref('g.out'), overlay: { ref: ref('k.out'), as: 'color', opacity: 0.3 } }, 'sel.flow'),
    { height: ref('g.out'), overlay: { ref: ref('sel.flow'), as: 'heat', opacity: 1 } },
  );
});

test('while the view is locked, and when the kind is not determinable, the view stays', () => {
  const locked: ViewBinding = { height: ref('g.out'), locked: true };
  for (const text of ['sel.out', 'k.out', 'sel.flow', 'g.out']) {
    const d = viewDoc(locked);
    assert.equal(viewAfterSelect(d, registry, ref(text)), d.ui.view);
  }
  for (const text of ['sOpen.out', 'ghost.out', 'nope.out', 'sink.out', 'g.nope']) {
    const d = viewDoc(terrain);
    assert.equal(viewAfterSelect(d, registry, ref(text)), d.ui.view, text);
    assert.equal(select(undefined, text), undefined, text);
  }
});

test('a selection that changes nothing returns the current view itself', () => {
  const d = viewDoc(terrain);
  assert.equal(viewAfterSelect(d, registry, ref('g.out')), d.ui.view);
  const withOverlay = viewDoc({ height: ref('g.out'), overlay: { ref: ref('sel.out'), as: 'mask', opacity: 1 } });
  assert.equal(viewAfterSelect(withOverlay, registry, ref('sel.out')), withOverlay.ui.view);
});

test('the returned view shares nothing with the reference it was given', () => {
  const given = ref('g.out');
  const view = viewAfterSelect(viewDoc(), registry, given)!;
  assert.notEqual(view.height, given);
  assert.deepEqual(view.height, given);
});
