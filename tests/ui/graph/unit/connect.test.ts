// Connections in the editor (runtime.md 4.3): the graph has no rules of its own. What the library proposes is
// judged by `validateConnection`; what this folder adds is the words for a wire between two ports of one side,
// the port a dragged wire ends at on a new node, and the plan that puts a node into a wire.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateConnection } from '../../../../src/core/runtime.ts';
import { addNodeAt, connectPorts, reconnectEdge } from '../../../../src/app/panels/graph/actions.ts';
import {
  acceptsWire, applyInsert, connectionRefs, insertPlan, pendingConnection, portEnd, portForWire, refusal, wireOntoNode, type PortEnd,
} from '../../../../src/app/panels/graph/connect.ts';
import { handleId, nodeFlowId, groupFlowId } from '../../../../src/app/panels/graph/flow.ts';
import { portY } from '../../../../src/app/panels/graph/geometry.ts';
import { bench, edgeInto, REGISTRY, wiring } from './_graph.ts';

const def = (type: string) => REGISTRY.get(type)!;
const out = (node: string, port = 'out'): PortEnd => ({ node, side: 'out', port });
const into = (node: string, port = 'in'): PortEnd => ({ node, side: 'in', port });

test('what the library proposes becomes two port references, or nothing when it is not from an output to an input', () => {
  assert.deepEqual(portEnd(nodeFlowId('a b'), handleId('out', 'flow')), { node: 'a b', side: 'out', port: 'flow' });
  assert.equal(portEnd(groupFlowId('g'), handleId('out', 'flow')), null, 'a group has no ports');
  assert.equal(portEnd(nodeFlowId('a'), null), null);
  assert.equal(portEnd(undefined, handleId('in', 'in')), null);

  const connection = { source: nodeFlowId('fbm'), sourceHandle: handleId('out', 'out'), target: nodeFlowId('blur'), targetHandle: handleId('in', 'mask') };
  assert.deepEqual(connectionRefs(connection), { from: { node: 'fbm', port: 'out' }, to: { node: 'blur', port: 'mask' } });
  assert.equal(connectionRefs({ ...connection, sourceHandle: handleId('in', 'in') }), null);
  assert.equal(connectionRefs({ ...connection, targetHandle: handleId('out', 'out') }), null);
  assert.equal(connectionRefs({ ...connection, target: null }), null);
});

test('a refused connection has a reason of one sentence, and between an output and an input it is validateConnection\'s', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const blur = b.add('filter/blur', { x: 300, y: 0 }, { in: `${range}.out` });
  const terraces = b.add('surface/terraces', { x: 600, y: 0 }, { in: `${blur}.out` });
  const doc = b.now();

  // Legal: also onto an input that has a wire (the new one replaces it), and a field into a mask.
  assert.equal(refusal(doc, REGISTRY, out(range), into(terraces)), null);
  assert.equal(refusal(doc, REGISTRY, into(terraces, 'mask'), out(blur)), null, 'dragged from the input to the output: the same connection');
  // The rules of 4.3, in the words of the one function that holds them.
  const cycle = refusal(doc, REGISTRY, out(terraces), into(blur));
  assert.equal(cycle, 'The connection would create a cycle');
  assert.equal(cycle, validateConnection(doc, REGISTRY, { node: terraces, port: 'out' }, { node: blur, port: 'in' }));
  assert.equal(refusal(doc, REGISTRY, out(blur), into(blur)), 'A node cannot be connected to itself');
  assert.equal(refusal(doc, REGISTRY, out(blur), into(blur, 'mask')), validateConnection(doc, REGISTRY, { node: blur, port: 'out' }, { node: blur, port: 'mask' }));
  assert.equal(refusal(doc, REGISTRY, out(range, 'flow'), into(blur)), 'Mountain Range has no output "flow"');
  assert.equal(refusal(doc, REGISTRY, out(range), into('nobody')), 'The target node does not exist');
  // What the library never asks about: two ports of one side.
  assert.equal(refusal(doc, REGISTRY, out(range), out(blur)), 'An output connects to an input, not to another output');
  assert.equal(refusal(doc, REGISTRY, into(blur), into(terraces)), 'An input connects to an output, not to another input');
  for (const reason of [cycle, refusal(doc, REGISTRY, out(range), out(blur))]) assert.match(reason!, /^[A-Z][^.]*$/, 'one sentence, capitalised, no full stop (testing.md 6.2)');
});

test('connectPorts connects what is legal as one step, replaces the wire into an input, and changes nothing for what is refused', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const other = b.add('generate/island', { x: 0, y: 300 });
  const blur = b.add('filter/blur', { x: 300, y: 0 });
  const terraces = b.add('surface/terraces', { x: 600, y: 0 }, { in: `${blur}.out` });
  const steps = b.labels().length;

  assert.equal(connectPorts(b, { node: range, port: 'out' }, { node: blur, port: 'in' }), null);
  assert.deepEqual(wiring(b.now()), [`${blur}.out>${terraces}.in`, `${range}.out>${blur}.in`].sort());
  assert.deepEqual(b.labels().slice(steps), ['Connect']);
  // An input has one edge (4.3 rule 2): another source takes the place of the first.
  assert.equal(connectPorts(b, { node: other, port: 'out' }, { node: blur, port: 'in' }), null);
  assert.deepEqual(wiring(b.now()), [`${blur}.out>${terraces}.in`, `${other}.out>${blur}.in`].sort());

  const held = b.now();
  assert.equal(connectPorts(b, { node: terraces, port: 'out' }, { node: blur, port: 'mask' }), 'The connection would create a cycle');
  assert.equal(b.now(), held);
  assert.deepEqual(b.labels().slice(steps), ['Connect', 'Connect']);
  b.doc.getState().undo();
  assert.deepEqual(wiring(b.now()), [`${blur}.out>${terraces}.in`, `${range}.out>${blur}.in`].sort());
});

test('a dragged wire ends at the first port of a new node that takes what it carries, and every type with a port on that side is offered', () => {
  // From an output: an input. A colour goes to the first input that takes a colour unconverted.
  assert.equal(portForWire(def('filter/blur'), { from: { node: 'a', port: 'out' } }), 'in');
  assert.equal(portForWire(def('color/hillshade'), { from: { node: 'a', port: 'out' } }, 'height'), 'in');
  assert.equal(portForWire(def('color/hillshade'), { from: { node: 'a', port: 'out' } }, 'color'), 'base');
  assert.equal(portForWire(def('color/hue-saturation'), { from: { node: 'a', port: 'out' } }, 'height'), 'in', 'no input takes a terrain as it is: the first, and the evaluator converts (4.3 rule 4)');
  assert.equal(portForWire(def('color/hue-saturation'), { from: { node: 'a', port: 'out' } }, 'mask'), 'mask', 'a mask goes to the input that is for masks');
  assert.equal(portForWire(def('surface/terraces'), { from: { node: 'a', port: 'out' } }, 'mask'), 'in');
  assert.equal(portForWire(def('generate/mountain-range'), { from: { node: 'a', port: 'out' } }), null);
  // From an input: an output.
  assert.equal(portForWire(def('generate/island'), { to: { node: 'a', port: 'in' } }), 'out');
  assert.equal(portForWire(def('io/export-landscape'), { to: { node: 'a', port: 'in' } }), null);

  assert.equal(acceptsWire(def('generate/mountain-range'), null), true);
  assert.equal(acceptsWire(def('generate/mountain-range'), { from: { node: 'a', port: 'out' } }), false, 'a generator has no input for the wire');
  assert.equal(acceptsWire(def('generate/crater'), { from: { node: 'a', port: 'out' } }), true, 'but one with an optional input has');
  assert.equal(acceptsWire(def('io/export-landscape'), { to: { node: 'a', port: 'in' } }), false);
  assert.equal(acceptsWire(def('filter/blur'), { to: { node: 'a', port: 'in' } }), true);

  assert.deepEqual(pendingConnection(def('filter/blur'), 'new', { from: { node: 'a', port: 'out' } }), { from: { node: 'a', port: 'out' }, to: { node: 'new', port: 'in' } });
  assert.deepEqual(pendingConnection(def('generate/island'), 'new', { to: { node: 'b', port: 'mask' } }), { from: { node: 'new', port: 'out' }, to: { node: 'b', port: 'mask' } });
  assert.equal(pendingConnection(def('generate/island'), 'new', { from: { node: 'a', port: 'out' } }), null);
});

test('a wire dropped on the canvas: the node chosen from the palette is added and connected in one step', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const terraces = b.add('surface/terraces', { x: 600, y: 0 });
  const steps = b.labels().length;

  const blur = addNodeAt(b, 'filter/blur', { x: 300, y: 20 }, { pending: { from: { node: range, port: 'out' } }, tone: 'height' })!;
  assert.deepEqual(wiring(b.now()), [`${range}.out>${blur}.in`]);
  assert.deepEqual(b.now().nodes[blur]!.position, { x: 300, y: 20 });
  assert.deepEqual(b.ui.getState().selection, [blur], 'the new node is selected');
  // Dragged backwards from an input: the new node's output feeds it.
  const island = addNodeAt(b, 'generate/island', { x: 300, y: 300 }, { pending: { to: { node: terraces, port: 'in' } } })!;
  assert.deepEqual(wiring(b.now()), [`${island}.out>${terraces}.in`, `${range}.out>${blur}.in`].sort());
  assert.deepEqual(b.labels().slice(steps), ['Add Blur', 'Add Island']);

  // One step back takes the node and its wire away together, and the selection goes back with it.
  b.doc.getState().undo();
  assert.deepEqual([Object.hasOwn(b.now().nodes, island), wiring(b.now())], [false, [`${range}.out>${blur}.in`]]);
  assert.deepEqual(b.ui.getState().selection, [blur]);
  b.doc.getState().redo();
  assert.deepEqual(wiring(b.now()), [`${island}.out>${terraces}.in`, `${range}.out>${blur}.in`].sort());
  assert.equal(addNodeAt(b, 'legacy/unknown', { x: 0, y: 0 }), null);

  // `atPort`: the place is where the wire was let go, and the port that takes the wire goes there, whatever the
  // node's width and whichever row the port is in.
  const drop = { x: 1000, y: 500 };
  const erosion = addNodeAt(b, 'simulate/hydraulic-erosion', drop, { atPort: true, pending: { from: { node: range, port: 'out' } }, tone: 'height' })!;
  assert.deepEqual(b.now().nodes[erosion]!.position, { x: drop.x, y: drop.y - portY(0) }, 'its first input lies at the drop');
  const masked = addNodeAt(b, 'color/hue-saturation', { x: 1000, y: 900 }, { atPort: true, pending: { from: { node: erosion, port: 'wear' } }, tone: 'mask' })!;
  const maskRow = b.views().get(masked)!.inputs.find((port) => port.name === 'mask')!.row;
  assert.ok(maskRow > 0);
  assert.deepEqual(b.now().nodes[masked]!.position, { x: 1000, y: 900 - portY(maskRow) }, 'the input the wire went to, not the first');
  const source = addNodeAt(b, 'simulate/rivers', { x: 2000, y: 500 }, { atPort: true, pending: { to: { node: blur, port: 'mask' } } })!;
  assert.deepEqual(b.now().nodes[source]!.position, { x: 2000 - b.views().get(source)!.width, y: 500 - portY(0) }, 'backwards: its output lies at the drop, a wide node reaching left of it');
});

test('a wire let go over a node goes to the first input of it that is free for it, and never takes an input that has a wire', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const slope = b.add('select/slope', { x: 300, y: 300 }, { in: `${range}.out` });
  const combine = b.add('adjust/combine', { x: 600, y: 0 });
  const exported = b.add('io/export-landscape', { x: 900, y: 0 });
  const doc = (): ReturnType<typeof b.now> => b.now();

  // A terrain: the first input; with that taken the second; the mask input is for masks and is not taken for a terrain.
  assert.deepEqual(wireOntoNode(doc(), REGISTRY, out(range), combine, 'height'), { from: { node: range, port: 'out' }, to: { node: combine, port: 'a' } });
  b.doc.getState().transact('Connect', (draft) => { draft.edges.one = { id: 'one', from: { node: range, port: 'out' }, to: { node: combine, port: 'a' } }; });
  assert.deepEqual(wireOntoNode(doc(), REGISTRY, out(range), combine, 'height'), { from: { node: range, port: 'out' }, to: { node: combine, port: 'b' } });
  // A mask goes to the first free input that takes a field as it is: there is no telling that it was meant as the mask.
  assert.deepEqual(wireOntoNode(doc(), REGISTRY, out(slope), combine, 'mask'), { from: { node: slope, port: 'out' }, to: { node: combine, port: 'b' } });
  b.doc.getState().transact('Connect', (draft) => { draft.edges.two = { id: 'two', from: { node: range, port: 'out' }, to: { node: combine, port: 'b' } }; });
  assert.deepEqual(wireOntoNode(doc(), REGISTRY, out(slope), combine, 'mask'), { from: { node: slope, port: 'out' }, to: { node: combine, port: 'mask' } });
  assert.equal(wireOntoNode(doc(), REGISTRY, out(range), combine, 'height'), 'Combine has no free input for this wire');
  // The wire being moved does not hold its own input against itself.
  assert.deepEqual(wireOntoNode(doc(), REGISTRY, out(range), combine, 'height', 'two'), { from: { node: range, port: 'out' }, to: { node: combine, port: 'b' } });

  // What cannot be: a node without inputs, the wire's own node, a node this build does not know, and what the rules refuse.
  assert.equal(wireOntoNode(doc(), REGISTRY, out(slope), range, 'mask'), 'Mountain Range has no input');
  assert.equal(wireOntoNode(doc(), REGISTRY, out(range), range, 'height'), null);
  assert.equal(wireOntoNode(doc(), REGISTRY, out(range), 'nobody', 'height'), null);
  const blur = b.add('filter/blur', { x: 0, y: 600 });
  b.doc.getState().transact('Connect', (draft) => { draft.edges.three = { id: 'three', from: { node: combine, port: 'out' }, to: { node: exported, port: 'in' } }; });
  b.doc.getState().transact('Connect', (draft) => { draft.edges.four = { id: 'four', from: { node: blur, port: 'out' }, to: { node: slope, port: 'mask' } }; });
  b.doc.getState().transact('Disconnect', (draft) => { delete draft.edges.two; });
  b.doc.getState().transact('Connect', (draft) => { draft.edges.five = { id: 'five', from: { node: slope, port: 'out' }, to: { node: combine, port: 'b' } }; });
  assert.equal(wireOntoNode(doc(), REGISTRY, out(combine), blur, 'height'), validateConnection(doc(), REGISTRY, { node: combine, port: 'out' }, { node: blur, port: 'in' }));
  assert.equal(wireOntoNode(doc(), REGISTRY, out(combine), blur, 'height'), 'The connection would create a cycle');

  // From an input, backwards: the output of the kind the input is for, else the node's first.
  assert.deepEqual(wireOntoNode(doc(), REGISTRY, into(exported), range, 'height'), { from: { node: range, port: 'out' }, to: { node: exported, port: 'in' } });
  const erosion = b.add('simulate/hydraulic-erosion', { x: 0, y: 900 });
  assert.deepEqual(wireOntoNode(doc(), REGISTRY, into(combine, 'mask'), erosion, 'mask'), { from: { node: erosion, port: 'out' }, to: { node: combine, port: 'mask' } }, 'no output of it is a mask: its first');
  assert.equal(wireOntoNode(doc(), REGISTRY, into(combine, 'mask'), exported, 'mask'), 'Unreal Landscape has no output');
});

test('a wire moved to another input is one step: the old connection goes and the new one is made, or nothing changes', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const blur = b.add('filter/blur', { x: 300, y: 0 }, { in: `${range}.out` });
  const terraces = b.add('surface/terraces', { x: 600, y: 0 });
  const wire = edgeInto(b.now(), blur, 'in');
  const steps = b.labels().length;

  assert.equal(reconnectEdge(b, wire, { node: range, port: 'out' }, { node: blur, port: 'in' }), null);
  assert.equal(b.labels().length, steps, 'put back where it was: no step');
  b.local.setState({ edgeSelection: [wire] });
  assert.equal(reconnectEdge(b, wire, { node: range, port: 'out' }, { node: terraces, port: 'in' }), null);
  assert.deepEqual(wiring(b.now()), [`${range}.out>${terraces}.in`]);
  assert.deepEqual(b.labels().slice(steps), ['Reconnect']);
  assert.deepEqual(b.local.getState().edgeSelection, [], 'the wire that went is not selected any more');
  b.doc.getState().undo();
  assert.deepEqual(wiring(b.now()), [`${range}.out>${blur}.in`], 'one step back: the wire is where it was');
  b.doc.getState().redo();

  // Refused: the reason comes back and nothing changes.
  const moved = edgeInto(b.now(), terraces, 'in');
  const before = b.now();
  assert.equal(reconnectEdge(b, moved, { node: range, port: 'out' }, { node: range, port: 'out' }), validateConnection(before, REGISTRY, { node: range, port: 'out' }, { node: range, port: 'out' }));
  assert.ok(b.now() === before);
  // A wire that is gone meanwhile (an undo while it was dragged): the connection asked for is made as a new one.
  assert.equal(reconnectEdge(b, 'gone', { node: terraces, port: 'out' }, { node: blur, port: 'in' }), null);
  assert.deepEqual(wiring(b.now()), [`${range}.out>${terraces}.in`, `${terraces}.out>${blur}.in`].sort());
});

test('a node goes into a wire when its first input and first output are free and both connections are legal', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const terraces = b.add('surface/terraces', { x: 600, y: 0 }, { in: `${range}.out` });
  const blur = b.add('filter/blur', { x: 300, y: 300 });
  const island = b.add('generate/island', { x: 0, y: 600 });
  const exported = b.add('io/export-landscape', { x: 900, y: 600 });
  const wire = edgeInto(b.now(), terraces, 'in');

  assert.deepEqual(insertPlan(b.now(), REGISTRY, blur, wire), { edgeId: wire, input: 'in', output: 'out' });
  assert.equal(insertPlan(b.now(), REGISTRY, island, wire), null, 'a node without an input');
  assert.equal(insertPlan(b.now(), REGISTRY, exported, wire), null, 'a node without an output');
  assert.equal(insertPlan(b.now(), REGISTRY, range, wire), null, 'the wire is the node\'s own');
  assert.equal(insertPlan(b.now(), REGISTRY, blur, 'no-such-edge'), null);

  b.doc.getState().transact('Insert Blur', (draft) => applyInsert(draft, REGISTRY, blur, insertPlan(draft, REGISTRY, blur, wire)!));
  assert.deepEqual(wiring(b.now()), [`${blur}.out>${terraces}.in`, `${range}.out>${blur}.in`].sort());
  assert.equal(Object.keys(b.now().edges).length, 2, 'the wire itself is replaced by the two');

  // A node that is wired already does not go into another wire, nor one that would close a cycle.
  const second = edgeInto(b.now(), terraces, 'in');
  assert.equal(insertPlan(b.now(), REGISTRY, blur, second), null);
  const loose = b.add('filter/blur', { x: 300, y: 600 }, { mask: `${terraces}.out` });
  assert.equal(insertPlan(b.now(), REGISTRY, loose, second), null, 'it reads the terraces already: into the wire before them it would feed itself');
  b.doc.getState().undo();
  b.doc.getState().undo();
  assert.deepEqual(wiring(b.now()), [`${range}.out>${terraces}.in`]);
});

test('a node added into a wire, as a drop from the library on it does', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const terraces = b.add('surface/terraces', { x: 600, y: 0 }, { in: `${range}.out` });
  const wire = edgeInto(b.now(), terraces, 'in');
  const blur = addNodeAt(b, 'filter/blur', { x: 412, y: 100 }, { centered: true, intoEdge: wire })!;
  assert.deepEqual(wiring(b.now()), [`${blur}.out>${terraces}.in`, `${range}.out>${blur}.in`].sort());
  // `centered`: the place is where the node's middle goes.
  const node = b.now().nodes[blur]!;
  const height = b.views().get(blur)!.height;
  assert.deepEqual([node.position.x + b.views().get(blur)!.width / 2, node.position.y + height / 2], [412, 100]);
  assert.equal(b.labels().at(-1), 'Add Blur');
  // A generator dropped on a wire is added beside it: it cannot go in.
  const island = addNodeAt(b, 'generate/island', { x: 300, y: 0 }, { intoEdge: edgeInto(b.now(), terraces, 'in') })!;
  assert.equal(wiring(b.now()).some((entry) => entry.includes(island)), false);
});
