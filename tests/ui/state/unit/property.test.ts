// docStore under random use (runtime.md 8.5): 400 steps from a fixed seed, each a random command of 4.6 as a
// transaction, with merge keys, gestures, changes outside the history, and undo and redo in between. After
// every step the document at each depth of the history is the one that was there when the depth was reached;
// at the end everything is undone, back to the original document, and redone, forward to the last one.
//
// Documents are compared by `difference`, a loop that stops at the first member that differs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addNode, connect, copyNodes, disconnect, moveNodes, pasteNodes, removeGroups, removeNodes, resetParam, setGraphViewport, setGroup,
  setNodeFlags, setParam, setSettings, setView, validateConnection,
  type DocDraft, type GraphDoc,
} from '../../../../src/core/runtime.ts';
import { setSelection } from '../../../../src/app/state/ui-store.ts';
import { createPage, difference, REGISTRY, testClock, same } from './_page.ts';

const SEED = 20261013;
/** Steps of the run. Below the 500 entries the history holds, so that no entry is dropped. */
const STEPS = 400;
/** Nodes the document may hold: the run removes before it adds beyond this. */
const MAX_NODES = 24;

/** mulberry32: the same sequence on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['ref/fbm', 'ref/blur', 'ref/talus', 'ref/slope-mask', 'ref/colorize', 'ref/combine', 'ref/autolevel', 'io/export-landscape'] as const;

/** The document without what a transaction outside the history changes: what undo and redo answer for. */
function historyPart(doc: GraphDoc): unknown {
  const { buildResolution: _b, previewLevel: _p, ...settings } = doc.settings;
  return { settings, nodes: doc.nodes, edges: doc.edges, groups: doc.groups };
}

test(`${STEPS} random commands from seed ${SEED}: every depth of the history holds its document; undoing all gives the original, redoing all the last`, () => {
  const next = random(SEED);
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]!;
  const some = <T>(list: readonly T[], most: number): T[] => list.filter(() => next() < 0.5).slice(0, most);

  const clock = testClock();
  const page = createPage({ clock });
  const store = page.doc;
  const state = () => store.getState();
  const nodeIds = (): string[] => Object.keys(state().doc.nodes);

  const original = state().doc;
  /** documents[d]: the document when the history last came to hold d entries by a transaction. */
  const documents: GraphDoc[] = [original];
  let groups = 0;
  let drags = 0;
  const counts = { transactions: 0, merged: 0, outside: 0, undone: 0, redone: 0, nothing: 0 };

  /** One transaction, and the bookkeeping of what the history must hold after it. */
  function transact(label: string, recipe: (draft: DocDraft) => void, opts: { mergeKey?: string; undoable?: boolean } = {}): void {
    const before = state();
    before.transact(label, recipe, opts);
    const after = state();
    if (after === before) {
      counts.nothing++;
      return;
    }
    assert.equal(after.revision, before.revision + 1);
    if (opts.undoable === false) {
      counts.outside++;
      same(after.past, before.past);
      same(after.future, before.future);
      return;
    }
    counts.transactions++;
    assert.equal(after.future.length, 0, 'a transaction clears the future');
    const grew = after.past.length - before.past.length;
    assert.ok(grew === 0 || grew === 1, 'a transaction adds an entry or merges into the last');
    if (grew === 0) counts.merged++;
    documents.length = after.past.length;
    documents[after.past.length] = after.doc;
  }

  const paramKey = (node: string, name: string): string => `param:${node}:${name}`;
  /** A value the parameter accepts, or undefined for a kind this run leaves alone. */
  function valueFor(type: string, name: string): unknown {
    const def = REGISTRY.get(type)!.params.find((p) => p.name === name)!;
    switch (def.kind) {
      case 'float': return def.min + next() * (def.max - def.min);
      case 'int': return def.min + int(def.max - def.min + 1);
      case 'bool': return next() < 0.5;
      case 'enum': return pick(def.options).value;
      case 'seed': return int(100000);
      case 'vec2': return [def.min + next() * (def.max - def.min), def.min + next() * (def.max - def.min)];
      case 'color': return [next(), next(), next()];
      case 'text': return `text ${int(1000)}`;
      case 'gradient': return [{ t: 0, color: [next(), next(), next()] }, { t: 0.25 + next() / 2, color: [next(), next(), next()] }, { t: 1, color: [1, 1, 1] }];
      default: return undefined;
    }
  }
  function setRandomParam(mergeKey: boolean): void {
    const ids = nodeIds();
    if (ids.length === 0) return;
    const node = pick(ids);
    const type = state().doc.nodes[node]!.type;
    const params = REGISTRY.get(type)!.params;
    if (params.length === 0) return;
    const name = pick(params).name;
    const value = valueFor(type, name);
    if (value === undefined) return;
    transact(`Set ${name}`, (d) => setParam(d, REGISTRY, node, name, value), mergeKey ? { mergeKey: paramKey(node, name) } : {});
  }

  const steps: readonly (() => void)[] = [
    () => {
      if (nodeIds().length >= MAX_NODES) return transact('Delete', (d) => removeNodes(d, some(nodeIds(), 4)));
      const type = pick(TYPES);
      transact('Add', (d) => {
        const id = addNode(d, REGISTRY, type, { x: int(2000), y: int(1000) });
        if (next() < 0.5) setSelection(page.ui, [id]);
      });
    },
    () => transact('Delete', (d) => removeNodes(d, some(nodeIds(), 2))),
    () => {
      // Any output to any input: a connection the rules forbid is no transaction, as in the application.
      const ids = nodeIds();
      if (ids.length < 2) return;
      const from = pick(ids), to = pick(ids);
      const outputs = REGISTRY.get(state().doc.nodes[from]!.type)!.outputs;
      const inputs = REGISTRY.get(state().doc.nodes[to]!.type)!.inputs;
      if (outputs.length === 0 || inputs.length === 0) return;
      const a = { node: from, port: pick(outputs).name }, b = { node: to, port: pick(inputs).name };
      if (validateConnection(state().doc, REGISTRY, a, b) !== null) return;
      transact('Connect', (d) => { connect(d, REGISTRY, a, b); });
    },
    () => transact('Disconnect', (d) => disconnect(d, some(Object.keys(state().doc.edges), 2))),
    () => setRandomParam(false),
    () => setRandomParam(true),
    () => {
      const ids = nodeIds();
      if (ids.length === 0) return;
      const node = pick(ids);
      const params = REGISTRY.get(state().doc.nodes[node]!.type)!.params;
      if (params.length > 0) transact('Reset', (d) => resetParam(d, REGISTRY, node, pick(params).name));
    },
    () => {
      const ids = nodeIds();
      if (ids.length === 0) return;
      const node = pick(ids);
      const flags = pick([{ bypass: next() < 0.5 }, { collapsed: next() < 0.5 }, { title: next() < 0.3 ? null : `Title ${int(50)}` }]);
      transact('Flags', (d) => setNodeFlags(d, node, flags));
    },
    () => transact('Move', (d) => moveNodes(d, some(nodeIds(), 5), { x: int(41) - 20, y: int(41) - 20 })),
    () => {
      if (nodeIds().length >= MAX_NODES) return;
      const copied = some(nodeIds(), 3);
      transact('Paste', (d) => { pasteNodes(d, REGISTRY, copyNodes(state().doc, copied), { x: int(2000), y: int(1000) }); });
    },
    () => {
      const known = Object.keys(state().doc.groups);
      const id = known.length > 0 && next() < 0.5 ? pick(known) : `group${groups++}`;
      transact('Group', (d) => setGroup(d, { id, title: `Group ${int(9)}`, ...(next() < 0.5 ? { color: '#3366aa' } : {}), rect: { x: int(500), y: int(500), w: 100 + int(400), h: 100 + int(400) } }));
    },
    () => transact('Ungroup', (d) => removeGroups(d, some(Object.keys(state().doc.groups), 1))),
    () => transact('Settings', (d) => setSettings(d, pick([{ terrainSize: 1000 + int(8000) }, { heightRange: 100 + int(3000) }, { seed: int(1 << 30) }, { seaLevel: next() }]))),
    // Outside the history.
    () => transact('Resolution', (d) => setSettings(d, pick([{ buildResolution: pick([1009, 2017, 4033]) }, { previewLevel: int(4) }])), { undoable: false }),
    () => {
      const ids = nodeIds();
      const view = ids.length === 0 || next() < 0.2 ? null : { height: { node: pick(ids), port: 'out' }, ...(next() < 0.3 ? { locked: true } : {}) };
      transact('View', (d) => setView(d, view), { undoable: false });
    },
    () => transact('Pan', (d) => setGraphViewport(d, { x: int(900), y: int(900), zoom: 0.25 + next() * 2 }), { undoable: false }),
    // A scrub: one gesture, some transactions under its key, however far apart.
    () => {
      const ids = nodeIds().filter((id) => state().doc.nodes[id]!.type === 'ref/fbm');
      if (ids.length === 0) return;
      const node = pick(ids);
      const key = paramKey(node, 'gain');
      const depth = state().past.length;
      const future = state().future.length;
      state().beginGesture(key);
      let changed = 0;
      for (let i = 0, n = 2 + int(5); i < n; i++) {
        clock.advance(int(2000));
        const before = state();
        transact('Scrub', (d) => setParam(d, REGISTRY, node, 'gain', next()), { mergeKey: key });
        if (state() !== before) changed++;
      }
      state().endGesture();
      // One entry for the whole scrub, or a merge into an entry of this key that is less than 600 ms old.
      if (changed > 0) assert.ok(state().past.length === depth + 1 || (state().past.length === depth && depth > 0), `a scrub of ${changed} changes is one entry`);
      else assert.deepEqual([state().past.length, state().future.length], [depth, future]);
    },
    // A drag: positions merge under the key of the drag.
    () => {
      const key = `move:${drags++}`;
      const moved = some(nodeIds(), 4);
      const depth = state().past.length;
      state().beginGesture(key);
      for (let i = 0, n = 2 + int(4); i < n; i++) {
        clock.advance(int(1500));
        transact('Drag', (d) => moveNodes(d, moved, { x: 1 + int(9), y: 1 + int(9) }), { mergeKey: key });
      }
      state().endGesture();
      assert.equal(state().past.length, depth + (moved.length > 0 ? 1 : 0));
    },
    () => {
      const before = state();
      before.undo();
      if (state() !== before) counts.undone++;
    },
    () => {
      const before = state();
      before.undo();
      before.undo();
      if (state() !== before) counts.undone++;
    },
    () => {
      const before = state();
      before.redo();
      if (state() !== before) counts.redone++;
    },
    // Back some steps and forward again by fewer: what a redo finds is seldom there otherwise.
    () => {
      const back = 1 + int(4);
      for (let i = 0; i < back; i++) state().undo();
      const forward = int(back + 1);
      for (let i = 0; i < forward; i++) {
        const before = state();
        before.redo();
        if (state() !== before) counts.redone++;
      }
    },
    () => setSelection(page.ui, some(nodeIds(), 3)),
  ];

  for (let step = 0; step < STEPS; step++) {
    // Mostly close together, so that keys merge by time; sometimes far apart.
    clock.advance(next() < 0.7 ? int(500) : 600 + int(5000));
    pick(steps)();

    const now = state();
    const found = difference(historyPart(now.doc), historyPart(documents[now.past.length]!));
    assert.equal(found, null, `step ${step}: the document at depth ${now.past.length}`);
    assert.ok(now.past.length <= STEPS, 'the history does not outgrow the run');
    assert.ok(page.ui.getState().selection.every((id) => Object.hasOwn(now.doc.nodes, id)), `step ${step}: the selection names nodes that exist`);
  }

  // The run did what it is meant to test.
  assert.ok(counts.transactions > 150 && counts.merged > 10 && counts.outside > 20 && counts.undone > 20 && counts.redone > 5, JSON.stringify(counts));

  const last = state().doc;
  const depth = state().past.length;
  /** What the run had undone and not redone when it ended: it stays beyond the last document. */
  const beyond = state().future.length;
  assert.ok(depth > 20, `${depth} entries to undo`);

  // Undo everything: each step back is the document of its depth, and the last is the original.
  for (let d = depth - 1; d >= 0; d--) {
    state().undo();
    assert.equal(state().past.length, d);
    assert.equal(difference(historyPart(state().doc), historyPart(documents[d]!)), null, `undone to depth ${d}`);
    assert.ok(page.ui.getState().selection.every((id) => Object.hasOwn(state().doc.nodes, id)), 'the selection names nodes that exist');
  }
  assert.equal(difference(historyPart(state().doc), historyPart(original)), null, 'everything undone: the original document');
  assert.deepEqual([Object.keys(state().doc.nodes).length, Object.keys(state().doc.edges).length, Object.keys(state().doc.groups).length], [0, 0, 0]);
  // What was changed outside the history is as the run left it.
  assert.equal(difference(state().doc.ui, last.ui), null);
  assert.deepEqual([state().doc.settings.buildResolution, state().doc.settings.previewLevel], [last.settings.buildResolution, last.settings.previewLevel]);
  const bottom = state();
  bottom.undo();
  same(state(), bottom, 'nothing more to undo');

  // Redo everything: forward to the last document, member for member.
  for (let d = 1; d <= depth; d++) {
    state().redo();
    assert.equal(difference(historyPart(state().doc), historyPart(documents[d]!)), null, `redone to depth ${d}`);
  }
  assert.equal(difference(state().doc, last), null, 'everything redone: the last document');
  assert.deepEqual([state().past.length, state().future.length], [depth, beyond]);
});
