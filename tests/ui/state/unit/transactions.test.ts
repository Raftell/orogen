// docStore, one transaction at a time (runtime.md 8.5, rules 1, 2, 5 and 6): every command of 4.6 run as a
// recipe, what the transaction leaves in the state, and its inverse: undo gives the document before, redo the
// document after.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addNode, connect, copyNodes, disconnect, moveNodes, pasteNodes, removeGroups, removeNodes, resetParam, setGraphViewport, setGroup,
  setNodeFlags, setParam, setSettings, setView,
  type DocDraft, type GraphDoc,
} from '../../../../src/core/runtime.ts';
import type { DocState } from '../../../../src/app/state/doc-store.ts';
import { createPage, difference, REGISTRY, type Page, same, different } from './_page.ts';

interface Graph {
  readonly page: Page;
  readonly land: string;
  readonly soft: string;
  readonly scree: string;
  readonly paint: string;
  /** The edge from soft into scree. */
  readonly edge: string;
}

/** land → soft → scree, land → paint, and a group: enough for every command to have something to change. */
function graph(): Graph {
  const page = createPage();
  const land = page.add('ref/fbm', { octaves: 4 });
  const soft = page.add('ref/blur', {}, { in: `${land}.out` });
  const scree = page.add('ref/talus', {}, { in: `${soft}.out` });
  const paint = page.add('ref/colorize', {}, { in: `${land}.out` });
  page.doc.getState().transact('Group', (draft) => setGroup(draft, { id: 'g1', title: 'Terrain', rect: { x: 0, y: 0, w: 600, h: 200 } }));
  const edge = Object.values(page.doc.getState().doc.edges).find((e) => e.to.node === scree)!.id;
  return { page, land, soft, scree, paint, edge };
}

interface Kind {
  readonly name: string;
  /** Whether the evaluator can see the change (8.5, "What the engine is sent"). */
  readonly engine: boolean;
  readonly recipe: (draft: DocDraft, g: Graph) => void;
  /** What the document holds afterwards; a message when it does not. */
  readonly holds: (doc: GraphDoc, g: Graph, before: GraphDoc) => string | null;
}

const count = (record: object): number => Object.keys(record).length;
const expected = (what: string, ok: boolean): string | null => (ok ? null : what);

const UNDOABLE: readonly Kind[] = [
  {
    name: 'addNode', engine: true,
    recipe: (d) => { addNode(d, REGISTRY, 'ref/slope-mask', { x: 40, y: 80 }); },
    holds: (doc, _g, before) => expected('one node more, of the type added', count(doc.nodes) === count(before.nodes) + 1
      && Object.values(doc.nodes).some((n) => n.type === 'ref/slope-mask' && n.position.x === 40 && n.position.y === 80)),
  },
  {
    name: 'removeNodes, with the edges of the node', engine: true,
    recipe: (d, g) => removeNodes(d, [g.soft]),
    holds: (doc, g, before) => expected('the node and its two edges are gone', !Object.hasOwn(doc.nodes, g.soft)
      && count(doc.edges) === count(before.edges) - 2 && Object.values(doc.edges).every((e) => e.from.node !== g.soft && e.to.node !== g.soft)),
  },
  {
    name: 'connect, a new edge', engine: true,
    recipe: (d, g) => { connect(d, REGISTRY, { node: g.paint, port: 'out' }, { node: g.scree, port: 'mask' }); },
    holds: (doc, g, before) => expected('one edge more, into the mask input', count(doc.edges) === count(before.edges) + 1
      && Object.values(doc.edges).some((e) => e.from.node === g.paint && e.to.node === g.scree && e.to.port === 'mask')),
  },
  {
    name: 'connect, in place of the edge into the input', engine: true,
    recipe: (d, g) => { connect(d, REGISTRY, { node: g.land, port: 'out' }, { node: g.scree, port: 'in' }); },
    holds: (doc, g, before) => expected('the input has the new edge alone', count(doc.edges) === count(before.edges)
      && !Object.hasOwn(doc.edges, g.edge) && Object.values(doc.edges).filter((e) => e.to.node === g.scree && e.to.port === 'in').map((e) => e.from.node).join() === g.land),
  },
  {
    name: 'disconnect', engine: true,
    recipe: (d, g) => disconnect(d, [g.edge]),
    holds: (doc, g, before) => expected('the edge is gone', !Object.hasOwn(doc.edges, g.edge) && count(doc.edges) === count(before.edges) - 1),
  },
  {
    name: 'setParam, a number', engine: true,
    recipe: (d, g) => setParam(d, REGISTRY, g.land, 'gain', 0.75),
    holds: (doc, g) => expected('the value is stored', doc.nodes[g.land]!.params.gain === 0.75),
  },
  {
    name: 'setParam, a gradient', engine: true,
    recipe: (d, g) => setParam(d, REGISTRY, g.paint, 'gradient', [{ t: 0, color: [0, 0, 0] }, { t: 0.5, color: [1, 0.5, 0] }, { t: 1, color: [1, 1, 1] }]),
    holds: (doc, g) => expected('three stops are stored', (doc.nodes[g.paint]!.params.gradient as unknown[]).length === 3),
  },
  {
    name: 'resetParam', engine: true,
    recipe: (d, g) => resetParam(d, REGISTRY, g.land, 'octaves'),
    holds: (doc, g) => expected('the default is stored', doc.nodes[g.land]!.params.octaves === 8),
  },
  {
    name: 'setNodeFlags, bypass', engine: true,
    recipe: (d, g) => setNodeFlags(d, g.soft, { bypass: true }),
    holds: (doc, g) => expected('the node is bypassed', doc.nodes[g.soft]!.bypass === true),
  },
  {
    name: 'setNodeFlags, collapsed', engine: false,
    recipe: (d, g) => setNodeFlags(d, g.soft, { collapsed: true }),
    holds: (doc, g) => expected('the node is collapsed', doc.nodes[g.soft]!.collapsed === true),
  },
  {
    name: 'setNodeFlags, title', engine: false,
    recipe: (d, g) => setNodeFlags(d, g.soft, { title: 'Soften' }),
    holds: (doc, g) => expected('the node has the title', doc.nodes[g.soft]!.title === 'Soften'),
  },
  {
    name: 'moveNodes', engine: false,
    recipe: (d, g) => moveNodes(d, [g.land, g.soft], { x: 10, y: -20 }),
    holds: (doc, g, before) => expected('both nodes moved', doc.nodes[g.land]!.position.x === before.nodes[g.land]!.position.x + 10
      && doc.nodes[g.soft]!.position.y === before.nodes[g.soft]!.position.y - 20 && doc.nodes[g.scree]!.position === before.nodes[g.scree]!.position),
  },
  {
    name: 'pasteNodes', engine: true,
    recipe: (d, g) => { pasteNodes(d, REGISTRY, copyNodes(d as GraphDoc, [g.land, g.soft]), { x: 900, y: 300 }); },
    holds: (doc, _g, before) => expected('two nodes and the edge between them more', count(doc.nodes) === count(before.nodes) + 2 && count(doc.edges) === count(before.edges) + 1),
  },
  {
    name: 'setGroup, a new group', engine: false,
    recipe: (d) => setGroup(d, { id: 'g2', title: 'Colour', color: '#336699', rect: { x: 10, y: 20, w: 300, h: 100 } }),
    holds: (doc) => expected('the group exists', doc.groups.g2?.title === 'Colour' && doc.groups.g2.color === '#336699'),
  },
  {
    name: 'setGroup, moved and renamed', engine: false,
    recipe: (d) => setGroup(d, { id: 'g1', title: 'Land', rect: { x: 5, y: 0, w: 640, h: 200 } }),
    holds: (doc) => expected('the group changed', doc.groups.g1!.title === 'Land' && doc.groups.g1!.rect.x === 5 && doc.groups.g1!.rect.w === 640),
  },
  {
    name: 'removeGroups', engine: false,
    recipe: (d) => removeGroups(d, ['g1']),
    holds: (doc) => expected('the group is gone', !Object.hasOwn(doc.groups, 'g1')),
  },
  {
    name: 'setSettings, inside the history', engine: true,
    recipe: (d) => setSettings(d, { terrainSize: 8000, heightRange: 2000, seed: 42, seaLevel: 0.125 }),
    holds: (doc) => expected('the four settings are stored', doc.settings.terrainSize === 8000 && doc.settings.heightRange === 2000 && doc.settings.seed === 42 && doc.settings.seaLevel === 0.125),
  },
];

for (const kind of UNDOABLE) {
  test(`${kind.name}: one entry with both patch lists; undo gives the document before, redo the document after`, () => {
    const g = graph();
    const store = g.page.doc;
    const start = store.getState();
    const before = start.doc;

    start.transact(`Do ${kind.name}`, (draft) => kind.recipe(draft, g));
    const done = store.getState();
    const after = done.doc;
    different(after, before, 'a new document object');
    assert.equal(kind.holds(after, g, before), null);
    assert.equal(difference(before, start.doc), null, 'the document before is not mutated');

    // Rule 2: an entry, the future cleared, the revision incremented, unsaved.
    assert.equal(done.past.length, start.past.length + 1);
    const entry = done.past[done.past.length - 1]!;
    assert.equal(entry.label, `Do ${kind.name}`);
    assert.ok(entry.forward.length > 0 && entry.inverse.length > 0, 'forward and inverse patches');
    assert.equal(entry.mergeKey, null);
    assert.deepEqual([done.future.length, done.revision, done.unsaved], [0, start.revision + 1, true]);
    assert.equal(done.engineRevision, kind.engine ? done.revision : start.engineRevision, 'engineRevision follows only what the evaluator reads');

    // Rule 6.
    done.undo();
    const undone = store.getState();
    assert.equal(difference(undone.doc, before), null, 'undo gives the document before');
    assert.deepEqual([undone.past.length, undone.future.length, undone.revision], [start.past.length, 1, done.revision + 1]);
    same(undone.future[0], entry, 'the entry moved to the future');
    assert.equal(undone.engineRevision, kind.engine ? undone.revision : start.engineRevision);

    undone.redo();
    const redone = store.getState();
    assert.equal(difference(redone.doc, after), null, 'redo gives the document after');
    assert.deepEqual([redone.past.length, redone.future.length, redone.revision], [done.past.length, 0, undone.revision + 1]);
    same(redone.past[redone.past.length - 1], entry);
    assert.equal(redone.engineRevision, kind.engine ? redone.revision : start.engineRevision);
  });
}

// ---- rule 5: what is not undoable ------------------------------------------------------------------------------------

const OUTSIDE: readonly (Kind & { readonly unsaved: boolean })[] = [
  {
    name: 'setView', engine: true, unsaved: false,
    recipe: (d, g) => setView(d, { height: { node: g.scree, port: 'out' }, overlay: { ref: { node: g.paint, port: 'out' }, as: 'color', opacity: 0.5 } }),
    holds: (doc, g) => expected('the view is stored', doc.ui.view?.height?.node === g.scree && doc.ui.view.overlay?.opacity === 0.5),
  },
  {
    name: 'setGraphViewport', engine: false, unsaved: false,
    recipe: (d) => setGraphViewport(d, { x: 12, y: -8, zoom: 1.5 }),
    holds: (doc) => expected('the viewport is stored', doc.ui.graphViewport?.zoom === 1.5),
  },
  {
    name: 'setSettings of buildResolution', engine: true, unsaved: true,
    recipe: (d) => setSettings(d, { buildResolution: 1009 }),
    // The default previewLevel 2 is a level of 1009 as well.
    holds: (doc) => expected('the resolution is stored', doc.settings.buildResolution === 1009 && doc.settings.previewLevel === 2),
  },
  {
    name: 'setSettings of previewLevel', engine: true, unsaved: true,
    recipe: (d) => setSettings(d, { previewLevel: 3 }),
    holds: (doc) => expected('the level is stored', doc.settings.previewLevel === 3),
  },
];

for (const kind of OUTSIDE) {
  test(`${kind.name} with undoable: false: no entry, the future intact, and undo passes it by`, () => {
    const g = graph();
    const store = g.page.doc;
    // Something to redo, and something to undo afterwards.
    store.getState().transact('Gain', (draft) => setParam(draft, REGISTRY, g.land, 'gain', 0.25));
    store.getState().transact('Move', (draft) => moveNodes(draft, [g.soft], { x: 7, y: 7 }));
    store.getState().undo();
    store.getState().markSaved('/projects/a.orogen');
    const start = store.getState();

    start.transact(`Do ${kind.name}`, (draft) => kind.recipe(draft, g), { undoable: false });
    const done = store.getState();
    assert.equal(kind.holds(done.doc, g, start.doc), null);
    same(done.past, start.past, 'no entry');
    same(done.future, start.future, 'the future is intact');
    assert.equal(done.revision, start.revision + 1);
    assert.equal(done.engineRevision, kind.engine ? done.revision : start.engineRevision);
    assert.equal(done.unsaved, kind.unsaved, 'changes under ui do not set unsaved; a setting does');

    // The entries made before still apply, and neither undo nor redo takes the change back.
    done.undo();
    assert.equal(store.getState().doc.nodes[g.land]!.params.gain, 0.5, 'the earlier entry is undone');
    assert.equal(kind.holds(store.getState().doc, g, start.doc), null, 'undo leaves the change');
    store.getState().redo();
    store.getState().redo();
    assert.equal(store.getState().doc.nodes[g.soft]!.position.x, start.doc.nodes[g.soft]!.position.x + 7, 'the future made before it is redone');
    assert.equal(kind.holds(store.getState().doc, g, start.doc), null, 'redo leaves the change');
  });
}

test('a transaction changes the paths outside the history with undoable: false, and no others that way', () => {
  const g = graph();
  const store = g.page.doc;
  const start = store.getState();
  const refused = (work: (state: DocState) => void, message: RegExp): void => {
    assert.throws(() => work(store.getState()), message);
    same(store.getState(), start, 'a refused transaction changes nothing');
  };
  refused((s) => s.transact('View', (d) => setView(d, { height: { node: g.land, port: 'out' } })), /"View" changes ui\.view: .* undoable: false/);
  refused((s) => s.transact('Pan', (d) => setGraphViewport(d, { x: 1, y: 1, zoom: 1 })), /changes ui\.graphViewport/);
  refused((s) => s.transact('Resolution', (d) => setSettings(d, { buildResolution: 1009 })), /changes settings\.buildResolution/);
  refused((s) => s.transact('Both', (d) => setSettings(d, { terrainSize: 500, previewLevel: 1 })), /changes settings\.previewLevel/);
  refused((s) => s.transact('Gain', (d) => setParam(d, REGISTRY, g.land, 'gain', 0.1), { undoable: false }), /"Gain" is not undoable and changes nodes\./);
  refused((s) => s.transact('Size', (d) => setSettings(d, { terrainSize: 500, previewLevel: 1 }), { undoable: false }), /is not undoable and changes settings\.terrainSize/);
});

// ---- rule 1 ------------------------------------------------------------------------------------------------------------

test('a recipe that changes nothing has no effect at all, and one that throws changes nothing', () => {
  const g = graph();
  const store = g.page.doc;
  store.getState().transact('Gain', (draft) => setParam(draft, REGISTRY, g.land, 'gain', 0.25));
  store.getState().undo();
  const start = store.getState();
  let notified = 0;
  const off = store.subscribe(() => { notified++; });

  start.transact('Nothing', () => {});
  start.transact('The value it has', (draft) => setParam(draft, REGISTRY, g.land, 'octaves', 4));
  start.transact('No move', (draft) => moveNodes(draft, [g.land], { x: 0, y: 0 }));
  start.transact('Nothing outside the history', (draft) => setView(draft, null), { undoable: false });
  same(store.getState(), start, 'the same state object: no revision, the future intact');
  assert.equal(start.future.length, 1);

  // connect throws when validateConnection fails (4.6): the error reaches the caller and the draft is dropped.
  assert.throws(() => start.transact('A cycle', (draft) => {
    setParam(draft, REGISTRY, g.land, 'gain', 0.9);
    connect(draft, REGISTRY, { node: g.scree, port: 'out' }, { node: g.soft, port: 'in' });
  }));
  same(store.getState(), start);
  assert.equal(notified, 0, 'no subscriber ran');
  off();

  // What a recipe returns is no part of the transaction.
  start.transact('Returns a value', (draft) => addNode(draft, REGISTRY, 'ref/fbm', { x: 0, y: 0 }));
  assert.equal(Object.keys(store.getState().doc.nodes).length, Object.keys(start.doc.nodes).length + 1);
});

test('a recipe changes its draft and nothing else: the store refuses to be changed from inside one', () => {
  const g = graph();
  const store = g.page.doc;
  const start = store.getState();
  for (const inside of [
    (s: DocState) => s.transact('Inner', (d) => setParam(d, REGISTRY, g.land, 'gain', 0.1)),
    (s: DocState) => s.undo(),
    (s: DocState) => s.redo(),
    (s: DocState) => s.beginGesture('param:x:y'),
    (s: DocState) => s.endGesture(),
    (s: DocState) => s.load(start.doc, null),
    (s: DocState) => s.markSaved('/a.orogen'),
  ]) {
    assert.throws(() => start.transact('Outer', (draft) => {
      setParam(draft, REGISTRY, g.land, 'gain', 0.9);
      inside(store.getState());
    }), /inside the recipe of a transaction/);
    same(store.getState(), start);
  }
  // The refusal ends with the recipe.
  start.transact('Afterwards', (draft) => setParam(draft, REGISTRY, g.land, 'gain', 0.9));
  assert.equal(store.getState().doc.nodes[g.land]!.params.gain, 0.9);
});

test('the document in the store is frozen: nothing changes it but a transaction', () => {
  const g = graph();
  const doc = g.page.doc.getState().doc as DocDraft;
  assert.throws(() => { doc.nodes[g.land]!.params.gain = 1; }, TypeError);
  assert.throws(() => { doc.settings.seed = 9; }, TypeError);
  assert.throws(() => { delete doc.edges[g.edge]; }, TypeError);
  // A loaded document as well, and a transaction on it still works.
  const loaded = JSON.parse(JSON.stringify(doc)) as GraphDoc;
  g.page.doc.getState().load(loaded, '/projects/b.orogen');
  assert.throws(() => { (loaded as DocDraft).settings.seed = 9; }, TypeError);
  g.page.doc.getState().transact('Seed', (draft) => setSettings(draft, { seed: 9 }));
  assert.equal(g.page.doc.getState().doc.settings.seed, 9);
});
