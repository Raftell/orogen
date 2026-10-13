// The mapping of the document to what the node-graph library draws (runtime.md 8.9: controlled mode): ids,
// what a node shows of its ports and of the view, the wires and their colours, and above all that nothing is
// made anew which did not change, since the library compares what it is given by identity.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { moveNodes, outputKind, parseDoc, setNodeFlags, setParam, setView } from '../../../../src/core/runtime.ts';
import {
  edgeFlowId, groupFlowId, handleId, nodeFlowId, parseFlowId, parseHandleId, rectOfNode, wireEnds,
  type FlowEdge, type FlowNode, type GroupView, type NodeView,
} from '../../../../src/app/panels/graph/flow.ts';
import { cycleNodes as coreCycleNodes } from '../../../../src/core/graph/validate.ts';
import { HANDLE_SIZE, NODE_WIDTH, THUMBNAIL_SIZE, nodeHeight, nodeWidth, portColumn, portY } from '../../../../src/app/panels/graph/geometry.ts';
import { cycleNodes, inputSources, outputTones, portKey, portLabel, inputsOf } from '../../../../src/app/panels/graph/model.ts';
import { setSelection } from '../../../../src/app/state/ui-store.ts';
import { bench, different, edgeInto, REGISTRY, same } from './_graph.ts';

const byId = (nodes: readonly FlowNode[], id: string): FlowNode => {
  const found = nodes.find((node) => node.id === id);
  assert.ok(found, `the flow holds ${id}`);
  return found;
};
const view = (nodes: readonly FlowNode[], id: string): NodeView => byId(nodes, nodeFlowId(id)).data as NodeView;
const wire = (edges: readonly FlowEdge[], id: string): FlowEdge => {
  const found = edges.find((edge) => edge.id === edgeFlowId(id));
  assert.ok(found, `the flow holds the wire ${id}`);
  return found;
};

test('ids: a node, a group and an edge of one document id are three ids of the library, and each comes back', () => {
  for (const id of ['fbm', 'a b', 'ü/"quoted"', 'n-1', '100%']) {
    assert.deepEqual(parseFlowId(nodeFlowId(id)), { kind: 'node', id });
    assert.deepEqual(parseFlowId(groupFlowId(id)), { kind: 'group', id });
    assert.deepEqual(parseFlowId(edgeFlowId(id)), { kind: 'edge', id });
    assert.equal(new Set([nodeFlowId(id), groupFlowId(id), edgeFlowId(id)]).size, 3);
    // The library puts ids into CSS selectors between double quotes.
    assert.doesNotMatch(nodeFlowId(id), /["\\\s]/);
  }
  assert.equal(parseFlowId('fbm'), null);
  assert.equal(parseFlowId('n-%E0%A4%A'), null, 'an id this module did not write');
  assert.deepEqual(parseHandleId(handleId('in', 'mask')), { side: 'in', port: 'mask' });
  assert.deepEqual(parseHandleId(handleId('out', 'out')), { side: 'out', port: 'out' });
  assert.equal(parseHandleId('mask'), null);
  assert.equal(parseHandleId(null), null);
});

test('a node shows its title, its category, its ports with their labels, and has the size its ports give it', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const erosion = b.add('simulate/hydraulic-erosion', { x: 300, y: 40 }, { in: `${range}.out` });
  const { nodes } = b.flow();
  assert.deepEqual(nodes.map((node) => node.id), [nodeFlowId(range), nodeFlowId(erosion)]);

  const source = view(nodes, range);
  assert.deepEqual(
    [source.title, source.typeTitle, source.category, source.known, source.thumbnail, source.inputs.length],
    ['Mountain Range', 'Mountain Range', 'generate', true, true, 0],
  );
  assert.deepEqual(source.outputs.map((port) => [port.name, port.label, port.tone, port.connected, port.row]), [['out', 'Out', 'height', true, 0]]);

  const eroded = view(nodes, erosion);
  assert.deepEqual(eroded.inputs.map((port) => [port.name, port.label, port.tone, port.connected, port.optional]), [
    ['in', 'In', 'height', true, false], ['mask', 'Mask', 'mask', false, true], ['precipitation', 'Precipitation', 'mask', false, true],
  ]);
  assert.deepEqual(eroded.outputs.map((port) => [port.name, port.tone]), [['out', 'height'], ['wear', 'data'], ['deposit', 'data'], ['flow', 'data']]);

  // The size is the one geometry.ts computes, given to the library so that it measures nothing. This node is
  // wider than most: 'Precipitation' has thirteen letters, and the column of its inputs is as wide as that needs.
  const node = byId(nodes, nodeFlowId(erosion));
  const wide = nodeWidth({ inputLabel: 'Precipitation'.length, outputLabel: 'Deposit'.length });
  assert.equal(eroded.inputColumn, portColumn('Precipitation'.length));
  assert.ok(wide > NODE_WIDTH);
  assert.deepEqual([node.type, node.position, node.width, node.height], ['terrain', { x: 300, y: 40 }, wide, nodeHeight({ inputs: 3, outputs: 4, thumbnail: true })]);
  assert.equal(byId(nodes, nodeFlowId(range)).width, NODE_WIDTH, 'a node with short labels has the least width');
  assert.deepEqual(node.measured, { width: node.width, height: node.height });
  assert.deepEqual(node.handles!.map((handle) => [handle.id, handle.type, handle.position, handle.x, handle.y]), [
    ['in-in', 'target', 'left', -HANDLE_SIZE / 2, portY(0) - HANDLE_SIZE / 2],
    ['in-mask', 'target', 'left', -HANDLE_SIZE / 2, portY(1) - HANDLE_SIZE / 2],
    ['in-precipitation', 'target', 'left', -HANDLE_SIZE / 2, portY(2) - HANDLE_SIZE / 2],
    ['out-out', 'source', 'right', wide - HANDLE_SIZE / 2, portY(0) - HANDLE_SIZE / 2],
    ['out-wear', 'source', 'right', wide - HANDLE_SIZE / 2, portY(1) - HANDLE_SIZE / 2],
    ['out-deposit', 'source', 'right', wide - HANDLE_SIZE / 2, portY(2) - HANDLE_SIZE / 2],
    ['out-flow', 'source', 'right', wide - HANDLE_SIZE / 2, portY(3) - HANDLE_SIZE / 2],
  ]);
});

test('a node is as wide as the labels of its ports need, in a few widths; collapsed it keeps its width', () => {
  // The least column takes the short labels of most nodes; a longer label widens its own column, and the other keeps its width.
  assert.equal(nodeWidth({}), NODE_WIDTH);
  assert.equal(nodeWidth({ inputLabel: 'Mask'.length, outputLabel: 'Coverage'.length }), NODE_WIDTH);
  assert.equal(portColumn(0), (NODE_WIDTH - THUMBNAIL_SIZE) / 2);
  for (let letters = 0; letters <= 24; letters++) {
    const column = portColumn(letters);
    assert.ok(column >= portColumn(Math.max(0, letters - 1)), 'a longer label never has a narrower column');
    assert.equal(column % 8, 0);
    assert.equal(nodeWidth({ inputLabel: letters }), column + THUMBNAIL_SIZE + portColumn(0));
    assert.equal(nodeWidth({ inputLabel: 2, outputLabel: letters }), portColumn(2) + THUMBNAIL_SIZE + column);
  }
  // Every type of the product: at most a few widths, and none so wide that it reaches the next node of a
  // graph laid out at 300 pixels a column, as the example projects are.
  const widths = new Map<number, string[]>();
  for (const def of REGISTRY.list()) {
    const longest = (ports: readonly { readonly name: string; readonly label?: string }[]): number => Math.max(0, ...ports.map((port) => portLabel(port).length));
    const width = nodeWidth({ inputLabel: longest(inputsOf(def)), outputLabel: longest(def.outputs) });
    widths.set(width, [...(widths.get(width) ?? []), def.type]);
  }
  assert.ok(widths.size <= 6 && Math.max(...widths.keys()) <= 272, `${[...widths].map(([width, types]) => `${width}: ${types.length}`).join(', ')}`);
  assert.ok((widths.get(NODE_WIDTH) ?? []).length > REGISTRY.list().length * 0.8, 'most nodes have the least width');

  const b = bench();
  const rivers = b.add('simulate/rivers', { x: 0, y: 0 });
  const open = b.views().get(rivers)!;
  assert.equal(open.width, nodeWidth({ inputLabel: 'Headwaters'.length, outputLabel: 'Water surface'.length }));
  b.doc.getState().transact('Collapse', (draft) => setNodeFlags(draft, rivers, { collapsed: true }));
  assert.deepEqual([b.views().get(rivers)!.width, b.views().get(rivers)!.thumbnail], [open.width, false], 'its wires do not move when it is collapsed');
});

test('a maskable node has the input the evaluator appends, and a node without outputs has no thumbnail', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const blur = b.add('filter/blur', { x: 300, y: 0 }, { in: `${range}.out` });
  const out = b.add('io/export-landscape', { x: 600, y: 0 }, { in: `${blur}.out` });
  const { nodes } = b.flow();
  assert.deepEqual(view(nodes, blur).inputs.map((port) => [port.name, port.tone, port.optional]), [['in', 'height', false], ['mask', 'mask', true]]);
  const exported = view(nodes, out);
  assert.deepEqual([exported.thumbnail, exported.outputs.length, exported.height], [false, 0, nodeHeight({ inputs: 1, outputs: 0, thumbnail: false })]);
  assert.ok(exported.height < view(nodes, blur).height);
});

test('a wire has the colour of what it carries: the role of a field, a colour, and through a "same as" output what came in', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const slope = b.add('select/slope', { x: 300, y: 0 }, { in: `${range}.out` });
  const distance = b.add('select/distance', { x: 600, y: 0 }, { in: `${slope}.out` });
  const paint = b.add('color/gradient-map', { x: 900, y: 0 }, { in: `${distance}.raw` });
  const soft = b.add('filter/blur', { x: 1200, y: 0 }, { in: `${paint}.out` });
  const flipped = b.add('filter/flip', { x: 1500, y: 0 }, { in: `${soft}.out` });
  const loose = b.add('filter/blur', { x: 0, y: 300 });
  const doc = b.now();
  const { nodes, edges } = b.flow();

  const toneOf = (node: string, port: string): string => wire(edges, edgeInto(doc, node, port)).data.tone;
  assert.equal(toneOf(slope, 'in'), 'height');
  assert.equal(toneOf(distance, 'in'), 'mask');
  assert.equal(toneOf(paint, 'in'), 'data');
  assert.equal(toneOf(soft, 'in'), 'color');
  assert.equal(toneOf(flipped, 'in'), 'color', 'the blur of a colour carries a colour');
  // An input that takes anything has the colour of what is connected, and none of its own.
  assert.equal(view(nodes, soft).inputs[0]!.tone, 'color');
  assert.equal(view(nodes, soft).outputs[0]!.tone, 'color');
  assert.deepEqual([view(nodes, loose).inputs[0]!.tone, view(nodes, loose).outputs[0]!.tone], ['any', 'any']);

  const first = wire(edges, edgeInto(doc, slope, 'in'));
  assert.deepEqual(
    [first.type, first.source, first.target, first.sourceHandle, first.targetHandle, first.selected, first.data.drop],
    ['wire', nodeFlowId(range), nodeFlowId(slope), 'out-out', 'in-in', false, false],
  );
});

test('missing required inputs are read off the document, for every node, and a bypassed node has none', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const combine = b.add('adjust/combine', { x: 300, y: 0 }, { a: `${range}.out` });
  const terraces = b.add('surface/terraces', { x: 300, y: 300 });
  const crater = b.add('generate/crater', { x: 600, y: 300 });
  let { nodes } = b.flow();
  assert.deepEqual(view(nodes, combine).missing, ['B']);
  assert.deepEqual(view(nodes, combine).inputs.map((port) => port.missing), [false, true, false]);
  assert.deepEqual(view(nodes, terraces).missing, ['In']);
  assert.deepEqual(view(nodes, crater).missing, [], 'an optional input is never missing');
  assert.deepEqual(view(nodes, range).missing, []);

  // Bypassed, the node passes its first input through and reads nothing else (runtime.md 5.6).
  b.doc.getState().transact('Bypass', (draft) => setNodeFlags(draft, terraces, { bypass: true }));
  nodes = b.flow().nodes;
  assert.deepEqual([view(nodes, terraces).bypassed, view(nodes, terraces).missing], [true, []]);
  // A bypass flag on a node that cannot be bypassed is ignored (engine.md 4.14), and so it is not shown.
  b.doc.getState().transact('Bypass', (draft) => setNodeFlags(draft, range, { bypass: true }));
  nodes = b.flow().nodes;
  assert.deepEqual([view(nodes, range).bypassed, view(nodes, range).canBypass], [false, false]);
});

test('the node the viewport shows is marked, as the terrain or as what lies over it, and so is the lock', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const slope = b.add('select/slope', { x: 300, y: 0 }, { in: `${range}.out` });
  const shown = (): (string | boolean | null)[] => {
    const { nodes } = b.flow();
    return [view(nodes, range).shown, view(nodes, range).locked, view(nodes, slope).shown, view(nodes, slope).locked];
  };
  assert.deepEqual(shown(), [null, false, null, false]);
  b.doc.getState().transact('View', (draft) => setView(draft, { height: { node: range, port: 'out' } }), { undoable: false });
  assert.deepEqual(shown(), ['terrain', false, null, false]);
  b.doc.getState().transact('View', (draft) => setView(draft, { height: { node: range, port: 'out' }, overlay: { ref: { node: slope, port: 'out' }, as: 'mask', opacity: 1 }, locked: true }), { undoable: false });
  assert.deepEqual(shown(), ['terrain', true, 'overlay', true]);
  b.doc.getState().transact('View', (draft) => setView(draft, { height: { node: slope, port: 'out' }, overlay: { ref: { node: slope, port: 'out' }, as: 'mask', opacity: 1 } }), { undoable: false });
  assert.deepEqual(shown(), [null, false, 'both', false]);
});

test('what did not change is the very object it was: a drag makes one node anew, a parameter none', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const blur = b.add('filter/blur', { x: 300, y: 0 }, { in: `${range}.out` });
  const terraces = b.add('surface/terraces', { x: 600, y: 0 }, { in: `${blur}.out` });
  const first = b.flow();
  same(b.flow(), first, 'asked again, the mapping is the same object');

  // A node is dragged: its position lives in uiStore (8.5 rule 8), and only that node is another object.
  b.ui.setState({ dragPositions: { [blur]: { x: 320, y: 15 } } });
  const dragged = b.flow();
  different(dragged.nodes, first.nodes);
  same(byId(dragged.nodes, nodeFlowId(range)), byId(first.nodes, nodeFlowId(range)));
  same(byId(dragged.nodes, nodeFlowId(terraces)), byId(first.nodes, nodeFlowId(terraces)));
  different(byId(dragged.nodes, nodeFlowId(blur)), byId(first.nodes, nodeFlowId(blur)));
  assert.deepEqual(byId(dragged.nodes, nodeFlowId(blur)).position, { x: 320, y: 15 });
  same(byId(dragged.nodes, nodeFlowId(blur)).data, byId(first.nodes, nodeFlowId(blur)).data, 'what the node shows did not change, so its body is not rendered again');
  same(dragged.edges, first.edges, 'the wires follow by the positions; none is made anew');
  same(dragged.views, first.views);

  // The drop: the document takes the position, uiStore lets go of it, and the node the library holds is the same.
  b.doc.getState().transact('Move', (draft) => moveNodes(draft, [blur], { x: 20, y: 15 }));
  const committed = b.flow();
  same(byId(committed.nodes, nodeFlowId(blur)), byId(dragged.nodes, nodeFlowId(blur)));
  b.ui.setState({ dragPositions: null });
  same(b.flow().nodes, committed.nodes);

  // A parameter is nothing the graph draws: thirty changes a second while a slider is dragged render nothing here.
  const before = b.flow();
  b.doc.getState().transact('Blur: Radius', (draft) => setParam(draft, REGISTRY, blur, 'radius', 0.02));
  same(b.flow(), before);

  // The selection makes the selected node anew and no other.
  setSelection(b.ui, [terraces]);
  const selected = b.flow();
  assert.deepEqual(selected.nodes.map((node) => node.selected), [false, false, true]);
  same(byId(selected.nodes, nodeFlowId(blur)), byId(before.nodes, nodeFlowId(blur)));
  same(byId(selected.nodes, nodeFlowId(terraces)).data, byId(before.nodes, nodeFlowId(terraces)).data);

  // A title is what the node shows: that one view is another object, and the views as a whole with it.
  b.doc.getState().transact('Rename', (draft) => setNodeFlags(draft, blur, { title: 'Soften' }));
  const renamed = b.flow();
  different(renamed.views, selected.views);
  assert.equal(view(renamed.nodes, blur).title, 'Soften');
  assert.equal(view(renamed.nodes, blur).typeTitle, 'Blur');
  same(byId(renamed.nodes, nodeFlowId(range)), byId(selected.nodes, nodeFlowId(range)));
});

test('a selected wire and the wire a node would be dropped into are marked, each alone', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const blur = b.add('filter/blur', { x: 300, y: 0 }, { in: `${range}.out` });
  const terraces = b.add('surface/terraces', { x: 600, y: 0 }, { in: `${blur}.out` });
  const doc = b.now();
  const [first, second] = [edgeInto(doc, blur, 'in'), edgeInto(doc, terraces, 'in')];
  const plain = b.flow();
  b.local.setState({ edgeSelection: [second], dropEdge: first });
  const marked = b.flow();
  assert.deepEqual([wire(marked.edges, first).selected, wire(marked.edges, first).data.drop], [false, true]);
  assert.deepEqual([wire(marked.edges, second).selected, wire(marked.edges, second).data.drop], [true, false]);
  same(marked.nodes, plain.nodes);
  b.local.setState({ edgeSelection: [], dropEdge: null });
  const cleared = b.flow();
  assert.deepEqual(cleared.edges.map((edge) => [edge.selected, edge.data.drop]), [[false, false], [false, false]]);
});

test('a group is a frame behind the nodes, dragged by its title bar, at the place it is being dragged to', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  b.group({ id: 'g1', title: 'Base', color: '#246283', rect: { x: -20, y: -50, w: 300, h: 240 } });
  b.group({ id: range, title: '', rect: { x: 400, y: 0, w: 10, h: 10 } });
  const { nodes } = b.flow();
  // Frames come first and lie lower; a group that has the id of a node is still a thing of its own.
  assert.deepEqual(nodes.map((node) => [node.id, node.type, node.zIndex]), [
    [groupFlowId('g1'), 'frame', -1], [groupFlowId(range), 'frame', -1], [nodeFlowId(range), 'terrain', 0],
  ]);
  const frame = byId(nodes, groupFlowId('g1'));
  assert.deepEqual([frame.position, frame.width, frame.height, frame.dragHandle, frame.style], [{ x: -20, y: -50 }, 300, 240, '[data-group-drag]', { pointerEvents: 'none' }]);
  assert.equal(frame.selectable, false, 'a box that touches a frame does not select the group: its title bar does');
  assert.deepEqual(frame.data as GroupView, { id: 'g1', title: 'Base', color: '#246283', width: 300, height: 240 });
  // A frame is never smaller than its title bar needs, whatever a file holds.
  const tiny = byId(nodes, groupFlowId(range));
  assert.ok(tiny.width >= 100 && tiny.height >= 40, `${tiny.width} × ${tiny.height}`);
  assert.equal((tiny.data as GroupView).color, null);

  b.local.setState({ groupSelection: ['g1'], groupRects: { g1: { x: 30, y: 0, w: 300, h: 240 } } });
  const moved = b.flow().nodes;
  assert.deepEqual([byId(moved, groupFlowId('g1')).position, byId(moved, groupFlowId('g1')).selected], [{ x: 30, y: 0 }, true]);
  same(byId(moved, nodeFlowId(range)), byId(nodes, nodeFlowId(range)));
});

test('a document with what the rules forbid is drawn all the same: an unknown type, and the wires that still have two ends', () => {
  const text = JSON.stringify({
    format: 'orogen', version: 1, settings: {},
    nodes: {
      fbm: { id: 'fbm', type: 'generate/fractal-noise', version: 1, position: { x: 0, y: 0 }, params: {} },
      ghost: { id: 'ghost', type: 'legacy/unknown', version: 1, position: { x: 300, y: 0 }, params: { foo: 1 } },
      after: { id: 'after', type: 'filter/blur', version: 1, position: { x: 600, y: 0 }, params: {} },
    },
    edges: {
      e1: { id: 'e1', from: { node: 'fbm', port: 'out' }, to: { node: 'ghost', port: 'in' } },
      e2: { id: 'e2', from: { node: 'ghost', port: 'result' }, to: { node: 'after', port: 'in' } },
      e3: { id: 'e3', from: { node: 'fbm', port: 'nothing' }, to: { node: 'after', port: 'mask' } },
      e4: { id: 'e4', from: { node: 'gone', port: 'out' }, to: { node: 'after', port: 'mask' } },
    },
    groups: {}, ui: {},
  });
  const b = bench();
  b.doc.getState().load(parseDoc(text, REGISTRY).doc, null);
  const { nodes, edges, views } = b.flow();
  const ghost = view(nodes, 'ghost');
  // The node of a type this build lacks is drawn with the ports its wires name, so that the wires stay visible.
  assert.deepEqual([ghost.known, ghost.title, ghost.category, ghost.thumbnail], [false, 'legacy/unknown', null, false]);
  assert.deepEqual([ghost.inputs.map((port) => port.name), ghost.outputs.map((port) => port.name)], [['in'], ['result']]);
  assert.deepEqual(edges.map((edge) => edge.id), [edgeFlowId('e1'), edgeFlowId('e2')], 'a wire to a port that does not exist, or from a node that does not, is not drawn');
  // The evaluator ignores the edge from the unknown node (4.3 rule 5): the input it leads to is missing.
  assert.deepEqual(view(nodes, 'after').missing, ['In']);
  assert.equal(view(nodes, 'after').inputs[0]!.connected, true, 'though a wire is drawn into it');
  assert.equal(views.size, 3);
});

test('where a node and the two ends of a wire are, from the document and from a drag', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 40, y: 60 });
  const erosion = b.add('simulate/hydraulic-erosion', { x: 400, y: 100 }, { precipitation: `${range}.out` });
  const doc = b.now();
  const views = b.views();
  assert.deepEqual(rectOfNode(doc, views, range), { x: 40, y: 60, w: NODE_WIDTH, h: nodeHeight({ inputs: 0, outputs: 1, thumbnail: true }) });
  assert.equal(rectOfNode(doc, views, 'nobody'), null);
  const edge = doc.edges[edgeInto(doc, erosion, 'precipitation')]!;
  // From the outer edge of the output's dot to the outer edge of the input's, in the row of each port.
  assert.deepEqual(wireEnds(doc, views, edge), {
    from: { x: 40 + NODE_WIDTH + HANDLE_SIZE / 2, y: 60 + portY(0) },
    to: { x: 400 - HANDLE_SIZE / 2, y: 100 + portY(2) },
  });
  assert.deepEqual(wireEnds(doc, views, edge, { [erosion]: { x: 500, y: 0 } })!.to, { x: 500 - HANDLE_SIZE / 2, y: portY(2) });
  // A wire leaves a wide node at its right edge, wherever that is.
  const blur = b.add('filter/blur', { x: 900, y: 100 }, { in: `${erosion}.wear` });
  const out = b.now().edges[edgeInto(b.now(), blur, 'in')]!;
  assert.deepEqual(wireEnds(b.now(), b.views(), out)!.from, { x: 400 + b.views().get(erosion)!.width + HANDLE_SIZE / 2, y: 100 + portY(1) });
});

test('the nodes on a cycle are found in the document, the same as the evaluator names, and each says so', () => {
  const folder = path.resolve(import.meta.dirname, '../../../graphs');
  for (const file of fs.readdirSync(folder).filter((name) => name.endsWith('.orogen')).sort()) {
    const { doc } = parseDoc(fs.readFileSync(path.join(folder, file), 'utf8'), REGISTRY);
    assert.deepEqual([...cycleNodes(doc, inputSources(doc, REGISTRY))].sort(), [...coreCycleNodes(doc, REGISTRY)].sort(), file);
  }
  const broken = parseDoc(fs.readFileSync(path.join(folder, '06-broken.orogen'), 'utf8'), REGISTRY).doc;
  assert.deepEqual([...cycleNodes(broken, inputSources(broken, REGISTRY))].sort(), ['loopa', 'loopb']);

  // Two cycles that share a node, a node between them and one behind them: only what lies on a cycle.
  const node = (id: string, x: number): object => ({ id, type: 'adjust/combine', version: 1, position: { x, y: 0 }, params: {} });
  const edge = (id: string, from: string, to: string, port: string): object => ({ id, from: { node: from, port: 'out' }, to: { node: to, port } });
  const text = JSON.stringify({
    format: 'orogen', version: 1, settings: {},
    nodes: { a: node('a', 0), b: node('b', 300), c: node('c', 600), d: node('d', 900), e: node('e', 1200), f: node('f', 1500) },
    edges: {
      ab: edge('ab', 'a', 'b', 'a'), ba: edge('ba', 'b', 'a', 'a'), bc: edge('bc', 'b', 'c', 'a'), cb: edge('cb', 'c', 'b', 'b'),
      cd: edge('cd', 'c', 'd', 'a'), de: edge('de', 'd', 'e', 'a'), ed: edge('ed', 'e', 'd', 'b'), ef: edge('ef', 'e', 'f', 'a'),
      // A second edge into an input that has one is not used (4.3 rule 5): it closes no cycle.
      fa: edge('fa', 'f', 'a', 'a'),
    },
    groups: {}, ui: {},
  });
  const b = bench();
  b.doc.getState().load(parseDoc(text, REGISTRY).doc, null);
  assert.deepEqual([...cycleNodes(b.now(), inputSources(b.now(), REGISTRY))].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual([...coreCycleNodes(b.now(), REGISTRY)].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(['a', 'c', 'f'].map((id) => b.views().get(id)!.cycle), [true, true, false]);
  // The cycle is cut: every node of it is told at once.
  b.doc.getState().transact('Cut', (draft) => {
    delete draft.edges.ba;
    delete draft.edges.cb;
    delete draft.edges.ed;
    delete draft.edges.fa;
  });
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => b.views().get(id)!.cycle), [false, false, false, false, false, false]);

  // A chain of ten thousand nodes is walked without a stack of calls.
  const long: Record<string, object> = {};
  const wires: Record<string, object> = {};
  for (let i = 0; i < 10_000; i++) {
    long[`n${i}`] = { id: `n${i}`, type: 'filter/blur', version: 1, position: { x: 0, y: 0 }, params: {} };
    if (i > 0) wires[`w${i}`] = { id: `w${i}`, from: { node: `n${i - 1}`, port: 'out' }, to: { node: `n${i}`, port: 'in' } };
  }
  wires.back = { id: 'back', from: { node: 'n9999', port: 'out' }, to: { node: 'n0', port: 'in' } };
  const chain = parseDoc(JSON.stringify({ format: 'orogen', version: 1, settings: {}, nodes: long, edges: wires, groups: {}, ui: {} }), REGISTRY).doc;
  assert.equal(cycleNodes(chain, inputSources(chain, REGISTRY)).size, 10_000);
});

test('what every output carries is found in one pass, and is what outputKind says of each: the acceptance graphs, a cycle and an unknown type among them', () => {
  const folder = path.resolve(import.meta.dirname, '../../../graphs');
  const files = fs.readdirSync(folder).filter((file) => file.endsWith('.orogen')).sort();
  assert.ok(files.length >= 6);
  let outputs = 0;
  let unknown = 0;
  for (const file of files) {
    const { doc } = parseDoc(fs.readFileSync(path.join(folder, file), 'utf8'), REGISTRY);
    const tones = outputTones(doc, REGISTRY, inputSources(doc, REGISTRY));
    for (const [id, instance] of Object.entries(doc.nodes)) {
      for (const port of REGISTRY.get(instance.type)?.outputs ?? []) {
        const tone = tones.get(portKey(id, port.name));
        // The one implementation of the rule (4.3): the kind through the connections, or none.
        const kind = outputKind(doc, REGISTRY, { node: id, port: port.name });
        assert.equal(tone === 'any' ? null : tone === 'color' ? 'color' : 'field', kind, `${file}: ${id}.${port.name}`);
        // A declared output keeps its role; a "same as" output is a height when it carries a field (7.4).
        if (kind === 'field') assert.equal(tone, typeof port.type === 'object' ? 'height' : port.role ?? 'height', `${file}: ${id}.${port.name}`);
        outputs++;
        if (tone === 'any') unknown++;
      }
    }
  }
  assert.ok(outputs > 25 && unknown >= 3, `${outputs} outputs, ${unknown} of them of no known kind (the cycle, and what follows the unknown node)`);

  // A chain of "same as" outputs, re-wired: every link follows.
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const paint = b.add('color/gradient-map', { x: 0, y: 300 }, { in: `${range}.out` });
  const first = b.add('filter/blur', { x: 300, y: 0 }, { in: `${range}.out` });
  const second = b.add('filter/flip', { x: 600, y: 0 }, { in: `${first}.out` });
  const third = b.add('adjust/combine', { x: 900, y: 0 }, { a: `${second}.out`, b: `${paint}.out` });
  const chain = (): (string | undefined)[] => {
    const tones = outputTones(b.now(), REGISTRY, inputSources(b.now(), REGISTRY));
    return [first, second, third].map((id) => tones.get(portKey(id, 'out')));
  };
  assert.deepEqual(chain(), ['height', 'height', 'height']);
  b.add('filter/blur', { x: 0, y: 600 });
  b.doc.getState().transact('Connect', (draft) => { draft.edges[edgeInto(b.now(), first, 'in')]!.from = { node: paint, port: 'out' }; });
  assert.deepEqual(chain(), ['color', 'color', 'color'], 'a colour at the head of the chain is a colour all the way down');
});
