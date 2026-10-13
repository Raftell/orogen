// The document commands of runtime.md 4.6. Each is a recipe on a draft: here on a structuredClone, and
// through immer's produceWithPatches for what the history of 8.5 relies on: a command that changes nothing
// produces no patch, a patch touches only the paths the command is about, and the inverse patches undo it.

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import {
  addNode, connect, copyNodes, disconnect, moveNodes, newDoc, parseDoc, pasteNodes, removeGroups, removeNodes, resetParam,
  serializeDoc, setGraphViewport, setGroup, setNodeFlags, setParam, setSettings, setView,
  type DocDraft, type GraphDoc, type NodeInstance, type ViewBinding,
} from '../../src/core/runtime.ts';
import { combine, everyKind, registry } from './graph-fixtures.ts';

enablePatches();

/** Runs a recipe as the application does and returns the new document, the patches and what the recipe returned. */
function transact<R>(doc: GraphDoc, recipe: (draft: DocDraft) => R): { doc: GraphDoc; patches: Patch[]; inverse: Patch[]; result: R } {
  let result!: R;
  const [next, patches, inverse] = produceWithPatches(doc, (draft) => { result = recipe(draft); });
  return { doc: next, patches, inverse, result };
}
const paths = (patches: readonly Patch[]): string[] => patches.map((p) => p.path.join('.')).sort();
const noChange = (doc: GraphDoc, recipe: (draft: DocDraft) => void): void => {
  const t = transact(doc, recipe);
  assert.deepEqual(t.patches, []);
  assert.equal(t.doc, doc);
};
/** The inverse patches restore the document exactly. */
const undoes = (before: GraphDoc, t: { doc: GraphDoc; inverse: Patch[] }): void => {
  assert.deepEqual(applyPatches(t.doc, t.inverse), before);
};

/** gen -> soften -> combine.a, gen -> combine.b, with a group and a view. Returns the document and the ids. */
function sample(): { doc: GraphDoc; g: string; s: string; c: string; gs: string; sc: string; gc: string } {
  const doc = structuredClone(newDoc()) as DocDraft;
  const g = addNode(doc, registry, 'ref/gen', { x: 0, y: 0 });
  const s = addNode(doc, registry, 'ref/soften', { x: 200, y: 0 });
  const c = addNode(doc, registry, 'ref/combine', { x: 400, y: 50 });
  const gs = connect(doc, registry, { node: g, port: 'out' }, { node: s, port: 'in' });
  const sc = connect(doc, registry, { node: s, port: 'out' }, { node: c, port: 'a' });
  const gc = connect(doc, registry, { node: g, port: 'out' }, { node: c, port: 'b' });
  setGroup(doc, { id: 'grp', title: 'Shapes', rect: { x: -20, y: -20, w: 300, h: 120 } });
  setView(doc, { height: { node: c, port: 'out' } });
  return { doc, g, s, c, gs, sc, gc };
}

// ---- newDoc and addNode ----------------------------------------------------------------------------------------

test('newDoc: the settings defaults of 4.2 and no nodes, a new object each time', () => {
  assert.deepEqual(newDoc(), {
    format: 'orogen',
    version: 1,
    settings: { terrainSize: 4032, heightRange: 1008, seed: 0, buildResolution: 4033, previewLevel: 2, seaLevel: 0 },
    nodes: {}, edges: {}, groups: {}, ui: {},
  });
  assert.notEqual(newDoc().settings, newDoc().settings);
});

test('addNode: a new instance under its id, at the definition version, with every param at its default', () => {
  const doc = structuredClone(newDoc()) as DocDraft;
  const id = addNode(doc, registry, 'ref/gen', { x: 12, y: -7 });
  assert.match(id, /^[0-9a-z]{10}$/);
  assert.deepEqual(Object.keys(doc.nodes), [id]);
  const node = doc.nodes[id]!;
  assert.deepEqual(Object.keys(node), ['id', 'type', 'version', 'position', 'params']);
  assert.equal(node.id, id);
  assert.equal(node.type, 'ref/gen');
  assert.equal(node.version, 1);
  assert.deepEqual(node.position, { x: 12, y: -7 });
  assert.deepEqual(Object.keys(node.params), everyKind.map((p) => p.name));
  for (const p of everyKind) assert.deepEqual(node.params[p.name], p.default);

  const other = addNode(doc, registry, 'ref/combine', { x: 0, y: 0 });
  assert.notEqual(other, id);
  assert.equal(doc.nodes[other]!.version, 2);
});

test('addNode: the stored defaults are copies, not the objects of the definition', () => {
  const doc = structuredClone(newDoc()) as DocDraft;
  const id = addNode(doc, registry, 'ref/gen', { x: 0, y: 0 });
  const curve = everyKind.find((p) => p.name === 'profile')!;
  assert.notEqual(doc.nodes[id]!.params.profile, curve.default);
  (doc.nodes[id]!.params.profile as { x: number }[])[0]!.x = 0.5;
  assert.deepEqual(curve.default, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
});

test('addNode: an unknown type and a position that is no number throw and change nothing', () => {
  const doc = newDoc();
  assert.throws(() => transact(doc, (d) => addNode(d, registry, 'legacy/unknown', { x: 0, y: 0 })), /^Error: Unknown node type "legacy\/unknown"$/);
  assert.throws(() => transact(doc, (d) => addNode(d, registry, 'ref/gen', { x: NaN, y: 0 })), TypeError);
  assert.deepEqual(doc, newDoc());
});

test('addNode: a random source that repeats itself throws instead of drawing ids for ever', () => {
  const doc = structuredClone(newDoc()) as DocDraft;
  const draws = mock.method(globalThis.crypto, 'getRandomValues', (bytes: Uint8Array) => bytes.fill(7));
  try {
    assert.equal(addNode(doc, registry, 'ref/gen', { x: 0, y: 0 }), '7777777777');
    assert.throws(() => addNode(doc, registry, 'ref/soften', { x: 0, y: 0 }), /^Error: newId returns ids that are already in use$/);
    assert.deepEqual(Object.keys(doc.nodes), ['7777777777']);
  } finally {
    draws.mock.restore();
  }
  assert.notEqual(addNode(doc, registry, 'ref/soften', { x: 0, y: 0 }), '7777777777');
});

// ---- removeNodes -----------------------------------------------------------------------------------------------

test('removeNodes: the nodes and every edge from or to them; ui.view is left alone', () => {
  const { doc, g, s, c, gc } = sample();
  const t = transact(doc, (d) => removeNodes(d, [s, c, 'missing', s]));
  assert.deepEqual(Object.keys(t.doc.nodes), [g]);
  assert.deepEqual(t.doc.edges, {});
  assert.deepEqual(t.doc.ui.view, { height: { node: c, port: 'out' } });
  assert.equal(t.doc.ui, doc.ui);
  assert.equal(t.doc.groups, doc.groups);
  assert.ok(t.patches.every((p) => p.path[0] === 'nodes' || p.path[0] === 'edges'));
  undoes(doc, t);

  const one = transact(doc, (d) => removeNodes(d, [s]));
  assert.deepEqual(Object.keys(one.doc.edges), [gc]);
  noChange(doc, (d) => removeNodes(d, []));
  noChange(doc, (d) => removeNodes(d, ['missing', 'constructor']));
});

// ---- connect and disconnect ------------------------------------------------------------------------------------

test('connect: a new edge under its id, from an output to an input', () => {
  const { doc, g, s, gs } = sample();
  assert.match(gs, /^[0-9a-z]{10}$/);
  assert.deepEqual(doc.edges[gs], { id: gs, from: { node: g, port: 'out' }, to: { node: s, port: 'in' } });
});

test('connect: replaces the edge into the input, and an output may feed any number of inputs', () => {
  const { doc, g, s, c, sc, gc } = sample();
  const t = transact(doc, (d) => connect(d, registry, { node: g, port: 'out' }, { node: c, port: 'a' }));
  assert.equal(sc in t.doc.edges, false);
  assert.deepEqual(t.doc.edges[t.result], { id: t.result, from: { node: g, port: 'out' }, to: { node: c, port: 'a' } });
  assert.equal(t.doc.edges[gc], doc.edges[gc]);
  assert.equal(Object.values(t.doc.edges).filter((e) => e.from.node === g).length, 3);
  assert.equal(Object.values(t.doc.edges).filter((e) => e.to.node === c && e.to.port === 'a').length, 1);
  assert.deepEqual(paths(t.patches), [`edges.${sc}`, `edges.${t.result}`].sort());
  undoes(doc, t);
  void s;
});

test('connect: the mask of a maskable node is an input like any other', () => {
  const { doc, g, s } = sample();
  const t = transact(doc, (d) => connect(d, registry, { node: g, port: 'out' }, { node: s, port: 'mask' }));
  assert.deepEqual(t.doc.edges[t.result]!.to, { node: s, port: 'mask' });
});

test('connect: the connection that already exists is kept and nothing changes', () => {
  const { doc, g, s, gs } = sample();
  const t = transact(doc, (d) => connect(d, registry, { node: g, port: 'out' }, { node: s, port: 'in' }));
  assert.equal(t.result, gs);
  assert.deepEqual(t.patches, []);
});

test('connect: throws the reason of validateConnection and changes nothing', () => {
  const { doc, g, s, c } = sample();
  const attempt = (from: [string, string], to: [string, string]) => (): void => {
    transact(doc, (d) => connect(d, registry, { node: from[0], port: from[1] }, { node: to[0], port: to[1] }));
  };
  assert.throws(attempt([c, 'out'], [s, 'in']), /^Error: The connection would create a cycle$/);
  assert.throws(attempt([c, 'out'], [c, 'a']), /^Error: A node cannot be connected to itself$/);
  assert.throws(attempt([g, 'nope'], [s, 'in']), /^Error: Gen \(Reference\) has no output "nope"$/);
  assert.throws(attempt([g, 'out'], ['missing', 'in']), /^Error: The target node does not exist$/);
  assert.equal(Object.keys(doc.edges).length, 3);
});

test('connect: a document with several edges into one input ends with one', () => {
  const { doc, g, s, c, sc } = sample();
  const edited = structuredClone(doc) as DocDraft;
  edited.edges.dup = { id: 'dup', from: { node: g, port: 'out' }, to: { node: c, port: 'a' } };
  const same = transact(edited, (d) => connect(d, registry, { node: s, port: 'out' }, { node: c, port: 'a' }));
  assert.equal(same.result, sc);
  assert.equal('dup' in same.doc.edges, false);
  assert.deepEqual(paths(same.patches), ['edges.dup']);
});

test('disconnect: removes the edges it is given and ignores the others', () => {
  const { doc, gs, sc, gc } = sample();
  const t = transact(doc, (d) => disconnect(d, [gs, sc, 'missing']));
  assert.deepEqual(Object.keys(t.doc.edges), [gc]);
  assert.equal(t.doc.nodes, doc.nodes);
  undoes(doc, t);
  noChange(doc, (d) => disconnect(d, ['missing', 'toString']));
});

// ---- setParam and resetParam -----------------------------------------------------------------------------------

test('setParam: stores the normalised value', () => {
  const { doc, g } = sample();
  const set = (name: string, value: unknown): unknown => transact(doc, (d) => setParam(d, registry, g, name, value)).doc.nodes[g]!.params[name];
  assert.equal(set('hard', 0.75), 0.75);
  assert.equal(set('hard', 7), 1);
  assert.equal(set('soft', 100), 100);
  assert.equal(set('count', 2.6), 3);
  assert.equal(set('count', 99), 16);
  assert.equal(set('invert', true), true);
  assert.equal(set('mode', 'add'), 'add');
  assert.equal(set('seed', -1), 4294967295);
  assert.deepEqual(set('offset', [5, 0.5]), [1, 0.5]);
  assert.deepEqual(set('tint', [2, 0.5, -1]), [1, 0.5, 0]);
  assert.deepEqual(set('profile', [{ x: 1, y: 1 }, { x: 0, y: 0.5 }]), [{ x: 0, y: 0.5 }, { x: 1, y: 1 }]);
  assert.deepEqual(set('ramp', [{ t: 1, color: [1, 1, 1] }, { t: 0, color: [0.5, 0, 0] }]), [{ t: 0, color: [0.5, 0, 0] }, { t: 1, color: [1, 1, 1] }]);
  assert.equal(set('file', 'assets/a.png'), 'assets/a.png');
  assert.equal(set('label', 'A long label'), 'A long l');
  // A value the kind does not accept is normalised like one in a file: to the default.
  assert.equal(set('hard', 'abc'), 0.5);
});

test('setParam: one patch at the param, undone by its inverse; an equal value is no change', () => {
  const { doc, g } = sample();
  const t = transact(doc, (d) => setParam(d, registry, g, 'hard', 0.75));
  assert.deepEqual(paths(t.patches), [`nodes.${g}.params.hard`]);
  assert.equal(t.doc.nodes[g]!.position, doc.nodes[g]!.position);
  assert.equal(t.doc.edges, doc.edges);
  undoes(doc, t);

  noChange(doc, (d) => setParam(d, registry, g, 'hard', 0.5));
  noChange(doc, (d) => setParam(d, registry, g, 'hard', -0 + 0.5));
  noChange(doc, (d) => setParam(d, registry, g, 'offset', [0, 0]));
  noChange(doc, (d) => setParam(d, registry, g, 'profile', [{ x: 0, y: 0 }, { x: 1, y: 1 }]));
  noChange(doc, (d) => setParam(d, registry, g, 'tint', [3, 3, 3]));      // clamps to the stored [1, 1, 1]
});

test('setParam: the stored value is a copy of what was passed', () => {
  const { doc, g } = sample();
  const points = [{ x: 0, y: 0.25 }, { x: 1, y: 0.75 }];
  const draft = structuredClone(doc) as DocDraft;
  setParam(draft, registry, g, 'profile', points);
  points[0]!.y = 1;
  assert.deepEqual(draft.nodes[g]!.params.profile, [{ x: 0, y: 0.25 }, { x: 1, y: 0.75 }]);
});

test('setParam: throws for an unknown node, an unknown name and an unknown enum value, and changes nothing', () => {
  const { doc, g } = sample();
  assert.throws(() => transact(doc, (d) => setParam(d, registry, 'missing', 'hard', 1)), /^Error: Node "missing" does not exist$/);
  assert.throws(() => transact(doc, (d) => setParam(d, registry, g, 'hardness', 1)), /^Error: Gen \(Reference\) has no parameter "hardness"$/);
  assert.throws(() => transact(doc, (d) => setParam(d, registry, g, 'constructor', 1)), /has no parameter "constructor"/);
  assert.throws(() => transact(doc, (d) => setParam(d, registry, g, 'mode', 'screen')), /^Error: param "mode": unknown value "screen"$/);
  assert.equal(doc.nodes[g]!.params.mode, 'mix');
});

test('setParam and resetParam: a node this build cannot read is not edited', () => {
  const { doc, c } = sample();
  const draft = structuredClone(doc) as DocDraft;
  draft.nodes.ghost = { id: 'ghost', type: 'legacy/unknown', version: 1, position: { x: 0, y: 0 }, params: { foo: 1 } };
  draft.nodes[c]!.version = 3;
  assert.throws(() => setParam(draft, registry, 'ghost', 'foo', 2), /^Error: Unknown node type "legacy\/unknown"$/);
  assert.throws(() => resetParam(draft, registry, 'ghost', 'foo'), /^Error: Unknown node type "legacy\/unknown"$/);
  assert.throws(() => setParam(draft, registry, c, 'strength', 1), /^Error: Saved with version 3 of this node; this build has version 2$/);
  draft.nodes[c]!.version = 1;
  assert.throws(() => resetParam(draft, registry, c, 'strength'), /^Error: Saved with version 1 of this node; this build has version 2$/);
  assert.deepEqual(draft.nodes.ghost.params, { foo: 1 });
});

test('resetParam: stores the default; at the default it is no change', () => {
  const { doc, g } = sample();
  const edited = transact(doc, (d) => {
    setParam(d, registry, g, 'count', 9);
    setParam(d, registry, g, 'profile', [{ x: 0, y: 1 }, { x: 1, y: 0 }]);
  }).doc;
  const t = transact(edited, (d) => {
    resetParam(d, registry, g, 'count');
    resetParam(d, registry, g, 'profile');
  });
  assert.deepEqual(t.doc.nodes[g]!.params, doc.nodes[g]!.params);
  assert.deepEqual(paths(t.patches), [`nodes.${g}.params.count`, `nodes.${g}.params.profile`]);
  undoes(edited, t);
  noChange(doc, (d) => resetParam(d, registry, g, 'count'));
  assert.throws(() => transact(doc, (d) => resetParam(d, registry, g, 'nope')), /has no parameter "nope"/);

  // A name the stored params lack is filled in.
  const sparse = structuredClone(doc) as DocDraft;
  delete sparse.nodes[g]!.params.count;
  resetParam(sparse, registry, g, 'count');
  assert.equal(sparse.nodes[g]!.params.count, 4);
});

// ---- setNodeFlags and moveNodes --------------------------------------------------------------------------------

test('setNodeFlags: sets what it is given and leaves the rest', () => {
  const { doc, s } = sample();
  const on = transact(doc, (d) => setNodeFlags(d, s, { bypass: true, title: 'Smooth' }));
  assert.equal(on.doc.nodes[s]!.bypass, true);
  assert.equal(on.doc.nodes[s]!.title, 'Smooth');
  assert.equal('collapsed' in on.doc.nodes[s]!, false);
  assert.deepEqual(paths(on.patches), [`nodes.${s}.bypass`, `nodes.${s}.title`]);
  assert.equal(on.doc.nodes[s]!.params, doc.nodes[s]!.params);
  undoes(doc, on);

  const more = transact(on.doc, (d) => setNodeFlags(d, s, { collapsed: true }));
  assert.deepEqual([more.doc.nodes[s]!.bypass, more.doc.nodes[s]!.collapsed, more.doc.nodes[s]!.title], [true, true, 'Smooth']);
  assert.deepEqual(paths(more.patches), [`nodes.${s}.collapsed`]);
});

test('setNodeFlags: a flag that is off and a title that is null or empty are absent, the defaults', () => {
  const { doc, s } = sample();
  const on = transact(doc, (d) => setNodeFlags(d, s, { bypass: true, collapsed: true, title: 'Smooth' })).doc;
  const off = transact(on, (d) => setNodeFlags(d, s, { bypass: false, collapsed: false, title: null }));
  assert.deepEqual(off.doc, doc);
  assert.deepEqual(Object.keys(off.doc.nodes[s]!), ['id', 'type', 'version', 'position', 'params']);
  assert.equal('title' in transact(on, (d) => setNodeFlags(d, s, { title: '' })).doc.nodes[s]!, false);

  noChange(doc, (d) => setNodeFlags(d, s, {}));
  noChange(doc, (d) => setNodeFlags(d, s, { bypass: false, collapsed: false, title: null }));
  noChange(on, (d) => setNodeFlags(d, s, { bypass: true, collapsed: true, title: 'Smooth' }));
  assert.throws(() => transact(doc, (d) => setNodeFlags(d, 'missing', { bypass: true })), /^Error: Node "missing" does not exist$/);
});

test('setNodeFlags works on a node of an unknown type', () => {
  const draft = structuredClone(newDoc()) as DocDraft;
  draft.nodes.ghost = { id: 'ghost', type: 'legacy/unknown', version: 4, position: { x: 0, y: 0 }, params: { foo: 1 } };
  setNodeFlags(draft, 'ghost', { collapsed: true, title: 'Old node' });
  moveNodes(draft, ['ghost'], { x: 5, y: 5 });
  assert.deepEqual(draft.nodes.ghost, { id: 'ghost', type: 'legacy/unknown', version: 4, position: { x: 5, y: 5 }, params: { foo: 1 }, collapsed: true, title: 'Old node' });
});

test('moveNodes: adds the delta to each node once and touches positions only', () => {
  const { doc, g, s, c } = sample();
  const t = transact(doc, (d) => moveNodes(d, [g, s, g, 'missing'], { x: 10, y: -5 }));
  assert.deepEqual(t.doc.nodes[g]!.position, { x: 10, y: -5 });
  assert.deepEqual(t.doc.nodes[s]!.position, { x: 210, y: -5 });
  assert.equal(t.doc.nodes[c], doc.nodes[c]);
  assert.deepEqual(paths(t.patches), [`nodes.${g}.position.x`, `nodes.${g}.position.y`, `nodes.${s}.position.x`, `nodes.${s}.position.y`].sort());
  assert.equal(t.doc.nodes[g]!.params, doc.nodes[g]!.params);
  undoes(doc, t);

  assert.deepEqual(paths(transact(doc, (d) => moveNodes(d, [g], { x: 0, y: 3 })).patches), [`nodes.${g}.position.y`]);
  noChange(doc, (d) => moveNodes(d, [g, s], { x: 0, y: 0 }));
  noChange(doc, (d) => moveNodes(d, [], { x: 4, y: 4 }));
  assert.throws(() => transact(doc, (d) => moveNodes(d, [g], { x: Infinity, y: 0 })), TypeError);
});

// ---- copyNodes and pasteNodes ----------------------------------------------------------------------------------

test('copyNodes: the nodes in document order and the edges between them, as copies', () => {
  const { doc, g, s, c, gs, sc, gc } = sample();
  const fragment = copyNodes(doc, [c, s, 'missing']);
  assert.deepEqual(fragment.nodes.map((n) => n.id), [s, c]);
  assert.deepEqual(fragment.edges.map((e) => e.id), [sc]);
  assert.deepEqual(fragment.nodes[0], doc.nodes[s]);
  assert.notEqual(fragment.nodes[0], doc.nodes[s]);
  assert.notEqual(fragment.nodes[0]!.params, doc.nodes[s]!.params);
  assert.notEqual(fragment.edges[0], doc.edges[sc]);
  assert.deepEqual(copyNodes(doc, [g, s, c]).edges.map((e) => e.id), [gs, sc, gc]);
  assert.deepEqual(copyNodes(doc, []), { nodes: [], edges: [] });
  // A fragment is clipboard content: plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(fragment)), fragment);
});

test('pasteNodes: new ids, the edges between the pasted nodes, the bounding box at the given point', () => {
  const { doc, g, s, c } = sample();
  const fragment = copyNodes(doc, [s, c]);
  const t = transact(doc, (d) => pasteNodes(d, registry, fragment, { x: 1000, y: 500 }));
  const [s2, c2] = t.result as [string, string];
  assert.equal(t.result.length, 2);
  assert.equal(Object.keys(t.doc.nodes).length, 5);
  assert.ok(![g, s, c].includes(s2) && ![g, s, c].includes(c2) && s2 !== c2);

  // The originals are at (200, 0) and (400, 50): the box starts at (200, 0).
  assert.deepEqual(t.doc.nodes[s2], { ...doc.nodes[s], id: s2, position: { x: 1000, y: 500 } });
  assert.deepEqual(t.doc.nodes[c2], { ...doc.nodes[c], id: c2, position: { x: 1200, y: 550 } });
  assert.notEqual(t.doc.nodes[s2]!.params, fragment.nodes[0]!.params);

  const added = Object.values(t.doc.edges).filter((e) => !(e.id in doc.edges));
  assert.equal(added.length, 1);
  assert.deepEqual(added[0], { id: added[0]!.id, from: { node: s2, port: 'out' }, to: { node: c2, port: 'a' } });
  assert.equal(added[0]!.id in doc.edges, false);
  for (const id of [g, s, c]) assert.equal(t.doc.nodes[id], doc.nodes[id]);
  assert.equal(t.doc.ui, doc.ui);
  undoes(doc, t);

  // Pasting twice gives two independent copies.
  const again = transact(t.doc, (d) => pasteNodes(d, registry, fragment, { x: 0, y: 0 }));
  assert.equal(Object.keys(again.doc.nodes).length, 7);
  assert.equal(Object.keys(again.doc.edges).length, 5);
  noChange(doc, (d) => { pasteNodes(d, registry, { nodes: [], edges: [] }, { x: 0, y: 0 }); });
});

test('pasteNodes: a fragment is read as the loader reads a file', () => {
  const old: NodeInstance = { id: 'old', type: 'ref/combine', version: 1, position: { x: 0, y: 0 }, params: { mode: 'add', amount: 25 } };
  const wild: NodeInstance = { id: 'wild', type: 'ref/gen', version: 1, position: { x: 10, y: 10 }, params: { count: 99, extra: 'kept' } };
  const ghost: NodeInstance = { id: 'ghost', type: 'legacy/unknown', version: 7, position: { x: 20, y: 0 }, params: { foo: 1 }, title: 'Ghost' };
  const t = transact(newDoc(), (d) => pasteNodes(d, registry, { nodes: [old, wild, ghost], edges: [] }, { x: 0, y: 0 }));
  const [a, b, c] = t.result as [string, string, string];
  assert.deepEqual(t.doc.nodes[a], { id: a, type: 'ref/combine', version: 2, position: { x: 0, y: 0 }, params: { mode: 'add', strength: 0.25 } });
  assert.deepEqual(t.doc.nodes[b]!.params, { count: 16, extra: 'kept' });
  assert.deepEqual(t.doc.nodes[c], { ...ghost, id: c });
  assert.equal(combine.version, 2);
});

test('pasteNodes: an edge that would break the graph is left out', () => {
  const nodes: NodeInstance[] = ['a', 'b', 'k', 'ghost'].map((id, i) => ({
    id, type: id === 'ghost' ? 'legacy/unknown' : id === 'k' ? 'ref/colorize' : 'ref/soften', version: 1, position: { x: i * 100, y: 0 }, params: {},
  }));
  const edge = (id: string, from: string, to: string) => {
    const [fn, fp] = from.split('.') as [string, string];
    const [tn, tp] = to.split('.') as [string, string];
    return { id, from: { node: fn, port: fp }, to: { node: tn, port: tp } };
  };
  const fragment = {
    nodes,
    edges: [
      edge('e0', 'a.out', 'b.in'),
      edge('e1', 'k.out', 'b.in'),         // a second edge into b.in
      edge('e2', 'b.out', 'a.in'),         // closes a cycle
      edge('e3', 'a.nope', 'k.in'),        // no such output
      edge('e4', 'a.out', 'outside.in'),   // leaves the fragment
      edge('e5', 'ghost.out', 'k.in'),     // an unknown type: kept as stored
      edge('e6', 'k.out', 'ghost.in'),
      edge('e7', 'ghost.out', 'ghost.in'), // closes a cycle
    ],
  };
  const t = transact(newDoc(), (d) => pasteNodes(d, registry, fragment, { x: 0, y: 0 }));
  const idOf = Object.fromEntries(nodes.map((n, i) => [t.result[i]!, n.id]));
  const pasted = Object.values(t.doc.edges).map((e) => `${idOf[e.from.node]}.${e.from.port} -> ${idOf[e.to.node]}.${e.to.port}`);
  assert.deepEqual(pasted, ['a.out -> b.in', 'ghost.out -> k.in']);
});

test('pasteNodes: clipboard content that is no fragment is left out entry by entry, and nothing throws', () => {
  const good: NodeInstance = { id: 'a', type: 'ref/gen', version: 1, position: { x: 30, y: 40 }, params: {} };
  const loose = {
    nodes: [
      good,
      null, 'node', 7, [good],
      { id: 5, type: 'ref/gen' },                                                  // no id
      { id: 'b' },                                                                 // no type
      { id: 'a', type: 'ref/soften', version: 1, position: { x: 0, y: 0 }, params: {} },    // an id that is taken
      { id: 'c', type: 'ref/soften', version: -3, position: 'left', params: [1], title: 9 }, // repaired as the loader repairs it
    ],
    edges: [
      null, 'edge', { id: 'e0' }, { id: 'e1', from: 'a.out', to: 'c.in' },
      { id: 'e2', from: { node: 'a', port: 'out' }, to: { node: 'c', port: 'in' } },
    ],
  } as unknown as Parameters<typeof pasteNodes>[2];
  const t = transact(newDoc(), (d) => pasteNodes(d, registry, loose, { x: 100, y: 100 }));
  assert.equal(t.result.length, 2);
  const [a, c] = t.result as [string, string];
  // The box of (30, 40) and the repaired (0, 0) starts at (0, 0).
  assert.deepEqual(t.doc.nodes[a], { ...good, id: a, position: { x: 130, y: 140 } });
  assert.deepEqual(t.doc.nodes[c], { id: c, type: 'ref/soften', version: 1, position: { x: 100, y: 100 }, params: {} });
  assert.deepEqual(Object.values(t.doc.edges).map((e) => [e.from, e.to]), [[{ node: a, port: 'out' }, { node: c, port: 'in' }]]);

  for (const nothing of [null, 'text', {}, { nodes: 'x', edges: 7 }, { nodes: [], edges: [{ id: 'e', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }] }]) {
    noChange(newDoc(), (d) => { assert.deepEqual(pasteNodes(d, registry, nothing as never, { x: 0, y: 0 }), []); });
  }
});

test('pasteNodes: a fragment with a cycle keeps the edges stored first, one per input', () => {
  const nodes: NodeInstance[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'ref/combine', version: 2, position: { x: 0, y: 0 }, params: {} }));
  const edge = (id: string, from: string, to: string, port: string) => ({ id, from: { node: from, port: 'out' }, to: { node: to, port } });
  const fragment = {
    nodes,
    edges: [
      edge('e0', 'a', 'b', 'a'),
      edge('e1', 'b', 'c', 'a'),
      edge('e2', 'c', 'a', 'a'),      // closes a -> b -> c -> a
      edge('e3', 'd', 'a', 'a'),      // a.a is still free, because e2 was left out
      edge('e4', 'a', 'c', 'b'),      // a second path, no cycle
      edge('e5', 'a', 'c', 'a'),      // c.a is taken by e1
      edge('e6', 'c', 'd', 'a'),      // closes d -> a -> b -> c -> d
    ],
  };
  const t = transact(newDoc(), (d) => pasteNodes(d, registry, fragment, { x: 0, y: 0 }));
  const idOf = Object.fromEntries(nodes.map((n, i) => [t.result[i]!, n.id]));
  const pasted = Object.values(t.doc.edges).map((e) => `${idOf[e.from.node]} -> ${idOf[e.to.node]}.${e.to.port}`);
  assert.deepEqual(pasted, ['a -> b.a', 'b -> c.a', 'd -> a.a', 'a -> c.b']);
  assert.deepEqual(parseDoc(serializeDoc(t.doc), registry).problems, []);
});

// ---- groups ----------------------------------------------------------------------------------------------------

test('setGroup: adds a group, then changes the members that differ', () => {
  const { doc } = sample();
  const added = transact(doc, (d) => setGroup(d, { id: 'g2', title: 'Water', color: '#246283', rect: { x: 1, y: 2, w: 3, h: 4 } }));
  assert.deepEqual(added.doc.groups.g2, { id: 'g2', title: 'Water', color: '#246283', rect: { x: 1, y: 2, w: 3, h: 4 } });
  assert.deepEqual(paths(added.patches), ['groups.g2']);
  undoes(doc, added);

  const moved = transact(added.doc, (d) => setGroup(d, { id: 'g2', title: 'Water', color: '#246283', rect: { x: 10, y: 2, w: 3, h: 40 } }));
  assert.deepEqual(paths(moved.patches), ['groups.g2.rect.h', 'groups.g2.rect.x']);
  undoes(added.doc, moved);

  const renamed = transact(added.doc, (d) => setGroup(d, { id: 'g2', title: 'Sea', rect: { x: 1, y: 2, w: 3, h: 4 } }));
  assert.deepEqual(renamed.doc.groups.g2, { id: 'g2', title: 'Sea', rect: { x: 1, y: 2, w: 3, h: 4 } });
  assert.deepEqual(paths(renamed.patches), ['groups.g2.color', 'groups.g2.title']);
  noChange(added.doc, (d) => setGroup(d, { id: 'g2', title: 'Water', color: '#246283', rect: { x: 1, y: 2, w: 3, h: 4 } }));
  assert.equal(added.doc.nodes, doc.nodes);
});

test('setGroup: stores a copy and rejects what is no group', () => {
  const draft = structuredClone(newDoc()) as DocDraft;
  const group = { id: 'g', title: 'A', rect: { x: 0, y: 0, w: 1, h: 1 } };
  setGroup(draft, group);
  group.rect.w = 99;
  assert.equal(draft.groups.g!.rect.w, 1);
  assert.throws(() => setGroup(draft, { id: '', title: 'A', rect: group.rect }), TypeError);
  assert.throws(() => setGroup(draft, { id: 'h', title: 'A', rect: { x: 0, y: 0, w: NaN, h: 1 } }), TypeError);
  assert.throws(() => setGroup(draft, { id: 'h', title: 'A', color: 'red', rect: group.rect }), TypeError);
  assert.deepEqual(Object.keys(draft.groups), ['g']);
});

test('removeGroups: removes the groups it is given and nothing else', () => {
  const { doc } = sample();
  const t = transact(doc, (d) => removeGroups(d, ['grp', 'missing']));
  assert.deepEqual(t.doc.groups, {});
  assert.equal(t.doc.nodes, doc.nodes);
  assert.deepEqual(paths(t.patches), ['groups.grp']);
  undoes(doc, t);
  noChange(doc, (d) => removeGroups(d, ['missing']));
});

// ---- settings --------------------------------------------------------------------------------------------------

test('setSettings: writes the members of the patch, validated', () => {
  const { doc } = sample();
  const t = transact(doc, (d) => setSettings(d, { terrainSize: 8000, seed: 7.5, seaLevel: 0.25 }));
  assert.deepEqual(t.doc.settings, { ...doc.settings, terrainSize: 8000, seed: 7, seaLevel: 0.25 });
  assert.deepEqual(paths(t.patches), ['settings.seaLevel', 'settings.seed', 'settings.terrainSize']);
  undoes(doc, t);

  const clamped = transact(doc, (d) => setSettings(d, { terrainSize: 0, heightRange: 1e9, seed: -4 })).doc.settings;
  assert.deepEqual([clamped.terrainSize, clamped.heightRange, clamped.seed], [1, 100000, 0]);
  // A value that is no number leaves the default of 4.2.
  assert.equal(transact(doc, (d) => setSettings(d, { seaLevel: NaN })).doc.settings.seaLevel, 0);
  assert.equal(transact(doc, (d) => setSettings(d, { buildResolution: 1000 })).doc.settings.buildResolution, 993);

  noChange(doc, (d) => setSettings(d, {}));
  noChange(doc, (d) => setSettings(d, { terrainSize: 4032, previewLevel: 2 }));
  noChange(doc, (d) => setSettings(d, { terrainSize: undefined }));
});

test('setSettings: a new build resolution lowers a preview level it no longer defines', () => {
  const { doc } = sample();
  const deep = transact(doc, (d) => setSettings(d, { previewLevel: 6 })).doc;
  assert.equal(deep.settings.previewLevel, 6);

  const t = transact(deep, (d) => setSettings(d, { buildResolution: 513 }));
  assert.equal(t.doc.settings.buildResolution, 513);
  assert.equal(t.doc.settings.previewLevel, 4);      // 513: 257, 129, 65, 33
  assert.deepEqual(paths(t.patches), ['settings.buildResolution', 'settings.previewLevel']);
  undoes(deep, t);

  // A level the new resolution defines is kept.
  const kept = transact(doc, (d) => setSettings(d, { buildResolution: 8129 }));
  assert.deepEqual(paths(kept.patches), ['settings.buildResolution']);
  assert.equal(kept.doc.settings.previewLevel, 2);
  assert.equal(transact(doc, (d) => setSettings(d, { previewLevel: 99 })).doc.settings.previewLevel, 6);
  assert.equal(transact(doc, (d) => setSettings(d, { buildResolution: 129, previewLevel: 9 })).doc.settings.previewLevel, 2);
});

test('setSettings: a change of buildResolution or previewLevel touches those two paths only, and no other change touches them (8.5 rule 5)', () => {
  const { doc } = sample();
  // A document whose stored preview level is not defined, as a file edited by hand could hold before parseDoc.
  const odd = structuredClone(doc) as DocDraft;
  odd.settings.previewLevel = 40;
  const undoable = transact(odd, (d) => setSettings(d, { terrainSize: 100, heightRange: 100, seed: 3, seaLevel: 1 }));
  assert.equal(undoable.patches.some((p) => p.path[1] === 'previewLevel' || p.path[1] === 'buildResolution'), false);
  assert.equal(undoable.doc.settings.previewLevel, 40);

  for (const patch of [{ buildResolution: 2017 }, { previewLevel: 1 }, { buildResolution: 1009, previewLevel: 3 }]) {
    const t = transact(doc, (d) => setSettings(d, patch));
    assert.ok(t.patches.length > 0);
    assert.ok(t.patches.every((p) => p.path[0] === 'settings' && (p.path[1] === 'buildResolution' || p.path[1] === 'previewLevel')));
  }
});

// ---- ui --------------------------------------------------------------------------------------------------------

test('setView and setGraphViewport are the only commands that write under ui', () => {
  const { doc, g, c } = sample();
  const view: ViewBinding = { height: { node: g, port: 'out' }, overlay: { ref: { node: c, port: 'out' }, as: 'heat', opacity: 0.5 }, locked: true };
  const t = transact(doc, (d) => setView(d, view));
  assert.deepEqual(t.doc.ui.view, view);
  assert.notEqual(t.doc.ui.view, view);
  assert.ok(t.patches.every((p) => p.path[0] === 'ui' && p.path[1] === 'view'));
  assert.equal(t.doc.nodes, doc.nodes);
  undoes(doc, t);
  noChange(t.doc, (d) => setView(d, structuredClone(view)));

  const cleared = transact(t.doc, (d) => setView(d, null));
  assert.equal('view' in cleared.doc.ui, false);
  noChange(cleared.doc, (d) => setView(d, null));
  assert.throws(() => transact(doc, (d) => setView(d, { overlay: { ref: { node: c, port: 'out' }, as: 'mask', opacity: NaN } })), TypeError);

  const panned = transact(doc, (d) => setGraphViewport(d, { x: 10, y: 20, zoom: 1.5 }));
  assert.deepEqual(panned.doc.ui, { ...doc.ui, graphViewport: { x: 10, y: 20, zoom: 1.5 } });
  assert.ok(panned.patches.every((p) => p.path[0] === 'ui' && p.path[1] === 'graphViewport'));
  assert.equal(panned.doc.ui.view, doc.ui.view);
  noChange(panned.doc, (d) => setGraphViewport(d, { x: 10, y: 20, zoom: 1.5 }));
  assert.throws(() => transact(doc, (d) => setGraphViewport(d, { x: 0, y: 0, zoom: NaN })), TypeError);
});

test('no command but setView and setGraphViewport produces a patch under ui', () => {
  const { doc, g, s, c, gs } = sample();
  const fragment = copyNodes(doc, [s, c]);
  const recipes: readonly ((d: DocDraft) => void)[] = [
    (d) => { addNode(d, registry, 'ref/gen', { x: 0, y: 0 }); },
    (d) => removeNodes(d, [c]),
    (d) => { connect(d, registry, { node: g, port: 'out' }, { node: s, port: 'mask' }); },
    (d) => disconnect(d, [gs]),
    (d) => setParam(d, registry, g, 'count', 2),
    (d) => resetParam(d, registry, g, 'count'),
    (d) => setNodeFlags(d, c, { bypass: true, collapsed: true, title: 'T' }),
    (d) => moveNodes(d, [c], { x: 1, y: 1 }),
    (d) => { pasteNodes(d, registry, fragment, { x: 0, y: 0 }); },
    (d) => setGroup(d, { id: 'g9', title: 'G', rect: { x: 0, y: 0, w: 1, h: 1 } }),
    (d) => removeGroups(d, ['grp']),
    (d) => setSettings(d, { terrainSize: 1, buildResolution: 513, previewLevel: 0 }),
  ];
  for (const recipe of recipes) {
    const t = transact(doc, recipe);
    assert.equal(t.patches.some((p) => p.path[0] === 'ui'), false);
    assert.equal(t.doc.ui, doc.ui);
  }
});

// ---- across commands -------------------------------------------------------------------------------------------

test('a document made by the commands is valid: it survives serializeDoc and parseDoc unchanged and without problems', () => {
  const { doc, g, s, c } = sample();
  const edited = transact(doc, (d) => {
    setParam(d, registry, g, 'profile', [{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }]);
    setNodeFlags(d, s, { bypass: true, title: 'Smooth' });
    moveNodes(d, [g, s, c], { x: 0.5, y: 0.25 });
    pasteNodes(d, registry, copyNodes(doc, [g, s, c]), { x: 0, y: 300 });
    setSettings(d, { seed: 9, buildResolution: 2017 });
    setGraphViewport(d, { x: 1, y: 2, zoom: 0.5 });
  }).doc;
  const text = serializeDoc(edited);
  const parsed = parseDoc(text, registry);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.doc, edited);
  assert.equal(serializeDoc(parsed.doc), text);
  for (const [id, node] of Object.entries(parsed.doc.nodes)) assert.equal(node.id, id);
  for (const [id, edge] of Object.entries(parsed.doc.edges)) assert.equal(edge.id, id);
});

test('a sequence of transactions is undone step by step by its inverse patches', () => {
  const { doc, g, s, c } = sample();
  const steps: ((d: DocDraft) => void)[] = [
    (d) => setParam(d, registry, g, 'hard', 0.1),
    (d) => { connect(d, registry, { node: g, port: 'out' }, { node: c, port: 'a' }); },
    (d) => removeNodes(d, [s]),
    (d) => { addNode(d, registry, 'ref/colorize', { x: 5, y: 5 }); },
    (d) => setSettings(d, { heightRange: 10 }),
    (d) => moveNodes(d, [g, c], { x: -3, y: 9 }),
  ];
  const history: { before: GraphDoc; inverse: Patch[] }[] = [];
  let current = doc;
  for (const step of steps) {
    const t = transact(current, step);
    assert.ok(t.patches.length > 0);
    history.push({ before: current, inverse: t.inverse });
    current = t.doc;
  }
  for (const entry of history.reverse()) {
    current = applyPatches(current, entry.inverse);
    assert.deepEqual(current, entry.before);
  }
  assert.deepEqual(current, doc);
});
