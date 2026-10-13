// Geometry of the graph, from the document alone: the size of a node, the curve of a wire, what a group holds,
// the wire a dragged node goes into and the wires a stroke cuts; and a drag as the one step of the history it is.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commitMove, groupSelection, resizeGroup, setGroupColor } from '../../../../src/app/panels/graph/actions.ts';
import {
  BODY_PADDING, BORDER, FOOTER_HEIGHT, GROUP_HEADER_HEIGHT, GROUP_PADDING, HEADER_HEIGHT, LOD_FAR_ZOOM, LOD_MID_ZOOM, NODE_WIDTH, ROW_HEIGHT, THUMBNAIL_SIZE,
  boundsOf, containsRect, distanceToPolyline, groupRectAround, lodOf, nodeHeight, polylineMeetsRect, polylinesMeet, portY, sampleWire, segmentsMeet,
  toFlow, toScreen, visibleRect, wireControls, wirePath, wirePathOn,
} from '../../../../src/app/panels/graph/geometry.ts';
import { groupContents, nodesIn, wireAtPoint, wiresCut, wireUnderNode } from '../../../../src/app/panels/graph/hits.ts';
import { setSelection } from '../../../../src/app/state/ui-store.ts';
import { bench, edgeInto, REGISTRY, wiring } from './_graph.ts';

test('a node is as high as its header, its thumbnail or its ports, and its status line; a port lies in its row', () => {
  const frame = 2 * BORDER + HEADER_HEIGHT + FOOTER_HEIGHT;
  assert.equal(nodeHeight({ inputs: 0, outputs: 1, thumbnail: true }), frame + THUMBNAIL_SIZE + 2 * BODY_PADDING);
  assert.equal(nodeHeight({ inputs: 4, outputs: 1, thumbnail: true }), frame + THUMBNAIL_SIZE + 2 * BODY_PADDING, 'four ports fit beside the thumbnail');
  assert.equal(nodeHeight({ inputs: 7, outputs: 1, thumbnail: true }), frame + 7 * ROW_HEIGHT + 2 * BODY_PADDING, 'more ports than that make the node higher');
  assert.equal(nodeHeight({ inputs: 2, outputs: 0, thumbnail: false }), frame + 2 * ROW_HEIGHT + 2 * BODY_PADDING);
  assert.equal(nodeHeight({ inputs: 0, outputs: 0, thumbnail: false }), frame);
  assert.equal(portY(0), BORDER + HEADER_HEIGHT + BODY_PADDING + ROW_HEIGHT / 2);
  assert.equal(portY(3) - portY(2), ROW_HEIGHT);
  // The acceptance graphs place nodes 280 apart along x and 160 along y: a node of the usual shape fits that grid.
  assert.ok(NODE_WIDTH < 280 && nodeHeight({ inputs: 3, outputs: 2, thumbnail: true }) < 160);
});

test('a wire is a cubic that leaves its output level and enters its input level; samples and crossings follow it', () => {
  const [a, b, c, d] = wireControls({ x: 0, y: 0 }, { x: 200, y: 100 });
  assert.deepEqual([a, b, c, d], [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }]);
  assert.equal(wirePath({ x: 0, y: 0 }, { x: 200, y: 100 }), 'M0,0 C100,0 100,100 200,100');
  // To a target that lies to the left the wire loops out and back, more the further it has to go back.
  const back = wireControls({ x: 0, y: 0 }, { x: -400, y: 0 });
  assert.ok(back[1].x > 100 && back[2].x < -500);

  const points = sampleWire({ x: 0, y: 0 }, { x: 200, y: 100 }, 10);
  assert.equal(points.length, 11);
  assert.deepEqual([points[0], points[10]], [{ x: 0, y: 0 }, { x: 200, y: 100 }]);
  assert.ok(Math.abs(points[5]!.x - 100) < 1e-9 && Math.abs(points[5]!.y - 50) < 1e-9, 'the middle of a symmetric wire');
  assert.ok(points.every((point, i) => i === 0 || point.x > points[i - 1]!.x), 'it runs forward');

  assert.equal(segmentsMeet({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }), true);
  assert.equal(segmentsMeet({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }), false);
  assert.equal(segmentsMeet({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }), true, 'touching counts');
  assert.equal(polylinesMeet(points, [{ x: 100, y: -50 }, { x: 100, y: 150 }]), true);
  assert.equal(polylinesMeet(points, [{ x: 100, y: 60 }, { x: 100, y: 150 }]), false);
  assert.equal(polylineMeetsRect(points, { x: 90, y: 40, w: 20, h: 20 }), true);
  assert.equal(polylineMeetsRect(points, { x: 90, y: 70, w: 20, h: 20 }), false);
  assert.equal(polylineMeetsRect([{ x: -50, y: 50 }, { x: 250, y: 50 }], { x: 90, y: 40, w: 20, h: 20 }), true, 'a line that crosses a box without a point inside it');
  assert.ok(Math.abs(distanceToPolyline({ x: 100, y: 60 }, points) - distanceToPolyline({ x: 100, y: 40 }, points)) < 1e-9);
  assert.equal(distanceToPolyline({ x: 0, y: -7 }, points), 7);
});

test('the viewport of the graph: where a point of the panel is in the graph, what is visible, and what is drawn at a zoom', () => {
  const viewport = { x: 100, y: 50, zoom: 0.5 };
  assert.deepEqual(toFlow(viewport, { x: 300, y: 250 }), { x: 400, y: 400 });
  assert.deepEqual(toScreen(viewport, { x: 400, y: 400 }), { x: 300, y: 250 });
  assert.deepEqual(visibleRect(viewport, { width: 800, height: 600 }), { x: -200, y: -100, w: 1600, h: 1200 });
  assert.deepEqual([lodOf(1), lodOf(LOD_MID_ZOOM), lodOf(LOD_MID_ZOOM - 0.01), lodOf(LOD_FAR_ZOOM), lodOf(LOD_FAR_ZOOM - 0.01)], ['near', 'near', 'mid', 'mid', 'far']);
  // A wire drawn over the panel (the one the palette is open for) is the curve of the graph, in the panel's pixels.
  assert.equal(wirePathOn({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, { x: 200, y: 100 }), wirePath({ x: 0, y: 0 }, { x: 200, y: 100 }));
  assert.equal(wirePathOn(viewport, { x: 0, y: 0 }, { x: 200, y: 100 }), 'M100,50 C150,50 150,100 200,100');

  const b = bench();
  const near = b.add('generate/mountain-range', { x: 0, y: 0 });
  const edge = b.add('generate/island', { x: 1390, y: 0 });
  b.add('generate/volcano', { x: 1401, y: 0 });
  b.add('generate/canyon', { x: 0, y: 1101 });
  assert.deepEqual(nodesIn(b.now(), b.views(), visibleRect(viewport, { width: 800, height: 600 })), [near, edge], 'any part of a node in the panel makes it visible');
});

test('a group holds the nodes that lie wholly inside its frame, and the groups that do', () => {
  const b = bench();
  const inside = b.add('generate/mountain-range', { x: 20, y: 40 });
  const alsoInside = b.add('filter/blur', { x: 300, y: 60 }, { in: `${inside}.out` });
  const straddling = b.add('surface/terraces', { x: 500, y: 60 });
  const outside = b.add('generate/island', { x: 1000, y: 1000 });
  b.group({ id: 'outer', title: 'Outer', rect: { x: 0, y: 0, w: 600, h: 400 } });
  b.group({ id: 'inner', title: 'Inner', rect: { x: 10, y: 10, w: 250, h: 200 } });
  b.group({ id: 'elsewhere', title: 'Elsewhere', rect: { x: 900, y: 900, w: 400, h: 400 } });
  const doc = b.now();
  const views = b.views();

  assert.deepEqual(groupContents(doc, views, 'outer'), { nodes: [inside, alsoInside], groups: ['inner'] });
  assert.deepEqual(groupContents(doc, views, 'inner'), { nodes: [inside], groups: [] });
  assert.deepEqual(groupContents(doc, views, 'elsewhere'), { nodes: [outside], groups: [] });
  assert.deepEqual(groupContents(doc, views, 'no-such-group'), { nodes: [], groups: [] });
  assert.equal(groupContents(doc, views, 'outer').nodes.includes(straddling), false, 'a node that sticks out is not held');
  assert.equal(containsRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), true, 'flush with the frame is inside');
});

test('grouping the selection makes a frame around it with room for its title, selects it and asks for its name', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 100, y: 100 });
  const blur = b.add('filter/blur', { x: 400, y: 140 }, { in: `${range}.out` });
  b.add('generate/island', { x: 2000, y: 2000 });
  setSelection(b.ui, [range, blur]);
  const steps = b.labels().length;
  const id = groupSelection(b)!;
  const group = b.now().groups[id]!;
  const rects = [range, blur].map((node) => ({ x: b.now().nodes[node]!.position.x, y: b.now().nodes[node]!.position.y, w: NODE_WIDTH, h: b.views().get(node)!.height }));
  assert.deepEqual(group.rect, groupRectAround(rects));
  const bounds = boundsOf(rects)!;
  assert.deepEqual(group.rect, { x: bounds.x - GROUP_PADDING, y: bounds.y - GROUP_PADDING - GROUP_HEADER_HEIGHT, w: bounds.w + 2 * GROUP_PADDING, h: bounds.h + 2 * GROUP_PADDING + GROUP_HEADER_HEIGHT });
  assert.equal(group.title, 'Group');
  assert.deepEqual(groupContents(b.now(), b.views(), id).nodes, [range, blur], 'the group holds what it was made around');
  assert.deepEqual(b.labels().slice(steps), ['Group']);
  // The group is selected in place of the nodes, and its name is the next thing typed.
  assert.deepEqual([b.ui.getState().selection, b.local.getState().groupSelection, b.local.getState().renaming], [[], [id], { kind: 'group', id }]);

  setGroupColor(b, [id], '#246283');
  assert.equal(b.now().groups[id]!.color, '#246283');
  setGroupColor(b, [id], null);
  assert.equal(Object.hasOwn(b.now().groups[id]!, 'color'), false);
  resizeGroup(b, id, { ...group.rect, w: 10, h: 10.4 });
  assert.ok(b.now().groups[id]!.rect.w >= 100 && b.now().groups[id]!.rect.h >= 40, 'a frame keeps room for its title bar');
  assert.deepEqual(b.labels().slice(steps), ['Group', 'Group Color', 'Group Color', 'Resize Group']);

  b.doc.getState().undo();
  b.doc.getState().undo();
  b.doc.getState().undo();
  b.doc.getState().undo();
  assert.deepEqual([Object.keys(b.now().groups), b.ui.getState().selection], [[], [range, blur]]);
  setSelection(b.ui, []);
  assert.equal(groupSelection(b), null, 'nothing selected: no group');
});

test('a drag is one step of the history: the nodes that moved, the group with what it holds, all at once', () => {
  const b = bench();
  const a = b.add('generate/mountain-range', { x: 20, y: 40 });
  const c = b.add('filter/blur', { x: 300, y: 60 }, { in: `${a}.out` });
  const far = b.add('generate/island', { x: 2000, y: 0 });
  b.group({ id: 'g', title: 'Base', rect: { x: 0, y: 0, w: 600, h: 400 } });
  const steps = b.labels().length;

  // Two nodes dragged together by (30, -10); positions are whole pixels.
  commitMove(b, { dragId: 'd1', positions: { [a]: { x: 50.4, y: 29.6 }, [c]: { x: 330.4, y: 49.6 } }, groups: {} });
  assert.deepEqual([b.now().nodes[a]!.position, b.now().nodes[c]!.position, b.now().nodes[far]!.position], [{ x: 50, y: 30 }, { x: 330, y: 50 }, { x: 2000, y: 0 }]);
  assert.deepEqual(b.labels().slice(steps), ['Move']);
  assert.equal(b.doc.getState().past.at(-1)!.mergeKey, 'move:d1');

  // The group dragged by (100, 200): the controller gives where the frame and each node it holds were dropped.
  commitMove(b, { dragId: 'd2', positions: { [a]: { x: 150, y: 230 }, [c]: { x: 430, y: 250 } }, groups: { g: { x: 100, y: 200, w: 600, h: 400 } } });
  assert.deepEqual([b.now().groups.g!.rect, b.now().nodes[a]!.position, b.now().nodes[c]!.position], [{ x: 100, y: 200, w: 600, h: 400 }, { x: 150, y: 230 }, { x: 430, y: 250 }]);
  assert.deepEqual(groupContents(b.now(), b.views(), 'g').nodes, [a, c], 'what the group held it still holds');
  assert.deepEqual(b.labels().slice(steps), ['Move', 'Move']);

  // A group dragged alone, and a drag that ends where it began.
  commitMove(b, { dragId: 'd3', positions: {}, groups: { g: { x: 90, y: 200, w: 600, h: 400 } } });
  assert.deepEqual(b.labels().slice(steps), ['Move', 'Move', 'Move Group']);
  const held = b.now();
  commitMove(b, { dragId: 'd4', positions: { [a]: { x: 150, y: 230 } }, groups: { g: { x: 90, y: 200, w: 600, h: 400 } } });
  assert.equal(b.now(), held, 'nothing moved: no step');
  assert.equal(b.labels().length, steps + 3);

  // One undo per drag.
  b.doc.getState().undo();
  b.doc.getState().undo();
  assert.deepEqual([b.now().groups.g!.rect.x, b.now().nodes[a]!.position, b.now().nodes[c]!.position], [0, { x: 50, y: 30 }, { x: 330, y: 50 }]);
  b.doc.getState().undo();
  assert.deepEqual([b.now().nodes[a]!.position, b.now().nodes[c]!.position], [{ x: 20, y: 40 }, { x: 300, y: 60 }]);
});

test('a node dragged onto a wire is marked for it and goes into it with the drop, in the same step as the move', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const terraces = b.add('surface/terraces', { x: 700, y: 0 }, { in: `${range}.out` });
  const blur = b.add('filter/blur', { x: 300, y: 400 });
  const island = b.add('generate/island', { x: 300, y: 700 });
  const wire = edgeInto(b.now(), terraces, 'in');
  const doc = b.now();
  const views = b.views();

  assert.equal(wireUnderNode(doc, REGISTRY, views, blur), null, 'far from the wire');
  // Dragged so that the wire, which runs level at the height of the first port row, passes under its middle.
  const over = { [blur]: { x: 350, y: portY(0) - 70 } };
  assert.equal(wireUnderNode(doc, REGISTRY, views, blur, over), wire);
  assert.equal(wireUnderNode(doc, REGISTRY, views, blur, { [blur]: { x: 350, y: portY(0) + 5 } }), null, 'a wire that only grazes the top edge does not count');
  assert.equal(wireUnderNode(doc, REGISTRY, views, island, { [island]: { x: 350, y: portY(0) - 70 } }), null, 'a node without an input cannot go in');
  assert.equal(wireUnderNode(doc, REGISTRY, views, range, { [range]: { x: 350, y: portY(0) - 70 } }), null, 'nor a node into its own wire');

  const steps = b.labels().length;
  commitMove(b, { dragId: 'd', positions: over, groups: {}, insert: { node: blur, edge: wire } });
  assert.deepEqual(wiring(b.now()), [`${blur}.out>${terraces}.in`, `${range}.out>${blur}.in`].sort());
  assert.deepEqual(b.now().nodes[blur]!.position, { x: 350, y: portY(0) - 70 });
  assert.deepEqual(b.labels().slice(steps), ['Insert Blur']);
  b.doc.getState().undo();
  assert.deepEqual([wiring(b.now()), b.now().nodes[blur]!.position], [[`${range}.out>${terraces}.in`], { x: 300, y: 400 }], 'one step back: out of the wire and back where it was');

  // A point near a wire, as a drop from the library gives it.
  const middle = { x: (NODE_WIDTH + 700) / 2, y: portY(0) };
  assert.equal(wireAtPoint(b.now(), b.views(), middle, 12), wire);
  assert.equal(wireAtPoint(b.now(), b.views(), { x: middle.x, y: middle.y + 30 }, 12), null);
});

test('a stroke cuts the wires it crosses and no other', () => {
  const b = bench();
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const upper = b.add('surface/terraces', { x: 700, y: 0 }, { in: `${range}.out` });
  const lower = b.add('filter/blur', { x: 700, y: 300 }, { in: `${range}.out` });
  b.add('filter/blur', { x: 700, y: 600 }, { in: `${range}.out` });
  const doc = b.now();
  const views = b.views();
  const [first, second] = [edgeInto(doc, upper, 'in'), edgeInto(doc, lower, 'in')];
  // A stroke down the gap between the columns, long enough to cross the upper two wires.
  assert.deepEqual(wiresCut(doc, views, [{ x: 650, y: -50 }, { x: 650, y: 200 }, { x: 660, y: 420 }]), [first, second]);
  assert.deepEqual(wiresCut(doc, views, [{ x: 650, y: -50 }, { x: 650, y: 10 }]), []);
  assert.deepEqual(wiresCut(doc, views, [{ x: 650, y: -50 }, { x: 650, y: 100 }]), [first]);
  assert.deepEqual(wiresCut(doc, views, [{ x: 650, y: 20 }]), [], 'a press without a stroke cuts nothing');
});
