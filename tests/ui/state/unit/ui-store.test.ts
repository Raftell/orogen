// uiStore (runtime.md 8.5) and the two functions that tie the selection to the view binding (7.4): the view
// follows what the user selects unless it is locked, as a change of the document that is not undoable.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setView, type ViewBinding } from '../../../../src/core/runtime.ts';
import { createUiStore, selectNodes, setSelection, setViewLocked, viewOutput } from '../../../../src/app/state/ui-store.ts';
import { createPage, REGISTRY, type Page, same } from './_page.ts';

interface Graph { readonly page: Page; readonly land: string; readonly scree: string; readonly steep: string; readonly paint: string; readonly out: string }

function graph(): Graph {
  const page = createPage();
  const land = page.add('ref/fbm');
  const scree = page.add('ref/talus', {}, { in: `${land}.out` });
  const steep = page.add('ref/slope-mask', {}, { in: `${scree}.out` });
  const paint = page.add('ref/colorize', {}, { in: `${scree}.out` });
  const out = page.add('io/export-landscape', {}, { in: `${scree}.out` });
  return { page, land, scree, steep, paint, out };
}
const view = (g: Graph): ViewBinding | undefined => g.page.doc.getState().doc.ui.view;
const context = (g: Graph) => ({ doc: g.page.doc, ui: g.page.ui, registry: REGISTRY });

test('a store starts with nothing selected, no panel focused and no drag, and holds a state of its own', () => {
  const a = createUiStore();
  const b = createUiStore();
  assert.deepEqual(a.getState(), { selection: [], focusedPanel: null, dragPositions: null });
  a.setState({ focusedPanel: 'graph', dragPositions: { n1: { x: 4, y: 5 } } });
  setSelection(a, ['n1']);
  assert.deepEqual(a.getState(), { selection: ['n1'], focusedPanel: 'graph', dragPositions: { n1: { x: 4, y: 5 } } });
  assert.deepEqual(b.getState(), { selection: [], focusedPanel: null, dragPositions: null });
});

test('setSelection keeps each id once, in order, and tells nobody of a selection that is the one there is', () => {
  const ui = createUiStore();
  let notified = 0;
  ui.subscribe(() => { notified++; });
  setSelection(ui, []);
  assert.equal(notified, 0);
  const given = ['b', 'a', 'b', 'c', 'a'];
  setSelection(ui, given);
  assert.deepEqual(ui.getState().selection, ['b', 'a', 'c']);
  assert.deepEqual(given, ['b', 'a', 'b', 'c', 'a'], 'the caller\'s array is its own');
  const held = ui.getState().selection;
  setSelection(ui, ['b', 'a', 'c']);
  setSelection(ui, ['b', 'b', 'a', 'c']);
  assert.equal(ui.getState().selection, held);
  assert.equal(notified, 1);
  setSelection(ui, ['a', 'b', 'c']);
  assert.equal(notified, 2, 'another order is another selection');
});

test('viewOutput: a height becomes the terrain shown; a mask, a colour or data is laid over the terrain that is shown', () => {
  const g = graph();
  viewOutput(context(g), { node: g.scree, port: 'out' });
  assert.deepEqual(view(g), { height: { node: g.scree, port: 'out' } });

  viewOutput(context(g), { node: g.steep, port: 'out' });
  assert.deepEqual(view(g), { height: { node: g.scree, port: 'out' }, overlay: { ref: { node: g.steep, port: 'out' }, as: 'mask', opacity: 1 } });
  viewOutput(context(g), { node: g.paint, port: 'out' });
  assert.deepEqual(view(g)?.overlay, { ref: { node: g.paint, port: 'out' }, as: 'color', opacity: 1 });
  viewOutput(context(g), { node: g.scree, port: 'moved' });
  assert.deepEqual(view(g)?.overlay, { ref: { node: g.scree, port: 'moved' }, as: 'heat', opacity: 1 }, 'a data output is shown as heat');

  viewOutput(context(g), { node: g.land, port: 'out' });
  assert.deepEqual(view(g), { height: { node: g.land, port: 'out' } }, 'another height replaces the terrain and takes the overlay off');
});

test('viewOutput is a change of the document that is not undoable, and no change at all when the view stays', () => {
  const g = graph();
  const store = g.page.doc;
  store.getState().markSaved('/projects/a.orogen');
  const before = store.getState();
  viewOutput(context(g), { node: g.scree, port: 'out' });
  const after = store.getState();
  same(after.past, before.past, 'no entry');
  assert.deepEqual([after.revision, after.engineRevision, after.unsaved], [before.revision + 1, before.revision + 1, false], 'the engine is sent the view; the project is not unsaved for it');

  viewOutput(context(g), { node: g.scree, port: 'out' });
  viewOutput(context(g), { node: g.scree, port: 'nothing' });
  viewOutput(context(g), { node: 'gone', port: 'out' });
  viewOutput(context(g), { node: g.out, port: 'out' });
  same(store.getState(), after, 'the same output again, an output or a node that does not exist: the state object itself');

  store.getState().undo();
  assert.deepEqual(view(g), { height: { node: g.scree, port: 'out' } }, 'undo takes back the last node added, not the view');
});

test('a locked view is the pin: selecting does not change it', () => {
  const g = graph();
  const store = g.page.doc;
  viewOutput(context(g), { node: g.scree, port: 'out' });
  viewOutput(context(g), { node: g.steep, port: 'out' });
  const entries = store.getState().past;
  setViewLocked(context(g), true);
  assert.deepEqual(view(g), { height: { node: g.scree, port: 'out' }, overlay: { ref: { node: g.steep, port: 'out' }, as: 'mask', opacity: 1 }, locked: true });
  same(store.getState().past, entries, 'locking is no undo step');

  const pinned = store.getState();
  setViewLocked(context(g), true);
  viewOutput(context(g), { node: g.land, port: 'out' });
  selectNodes(context(g), [g.land]);
  same(store.getState(), pinned, 'locked again, an output viewed, a node selected: the document as it was');
  assert.deepEqual(g.page.ui.getState().selection, [g.land], 'the selection itself moves');

  setViewLocked(context(g), false);
  assert.deepEqual(view(g), { height: { node: g.scree, port: 'out' }, overlay: { ref: { node: g.steep, port: 'out' }, as: 'mask', opacity: 1 } }, 'unlocked: the view it had, without the lock');
  const unlocked = store.getState();
  setViewLocked(context(g), false);
  same(store.getState(), unlocked);
  selectNodes(context(g), [g.land]);
  assert.deepEqual(view(g), { height: { node: g.land, port: 'out' } }, 'and the view follows again');

  // A view that shows nothing can be pinned as well: selecting then shows nothing still.
  store.getState().transact('Clear view', (d) => setView(d, null), { undoable: false });
  setViewLocked(context(g), true);
  selectNodes(context(g), [g.scree]);
  assert.deepEqual(view(g), { locked: true });
  setViewLocked(context(g), false);
  assert.deepEqual(view(g), {});
});

test('selectNodes: the view follows a selection of one node, by its first output', () => {
  const g = graph();
  selectNodes(context(g), [g.scree]);
  assert.deepEqual([g.page.ui.getState().selection, view(g)], [[g.scree], { height: { node: g.scree, port: 'out' } }]);
  selectNodes(context(g), [g.steep]);
  assert.equal(view(g)?.overlay?.as, 'mask');

  const held = g.page.doc.getState();
  selectNodes(context(g), [g.land, g.paint]);
  selectNodes(context(g), []);
  selectNodes(context(g), [g.out]);
  selectNodes(context(g), ['gone']);
  same(g.page.doc.getState(), held, 'several nodes, none, a node without outputs, an id the document lacks: the view stays');
  assert.deepEqual(g.page.ui.getState().selection, ['gone'], 'what is selected is the caller\'s business');
});
