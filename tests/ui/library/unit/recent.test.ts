// The recently used nodes (src/app/panels/library/recent.ts, state.ts): the list, what of a change of the
// document counts as a node the user added, and what the panel keeps between two starts. No window.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodes } from '../../../../src/core/nodes/index.ts';
import { addNode, connect, createRegistry, newDoc, removeNodes, setParam, setView, type DocDraft, type GraphDoc } from '../../../../src/core/runtime.ts';
import { createDocStore } from '../../../../src/app/state/doc-store.ts';
import { createUiStore } from '../../../../src/app/state/ui-store.ts';
import { addedType, cleanRecent, pushRecent, RECENT_MAX } from '../../../../src/app/panels/library/recent.ts';
import {
  cleanDetailsHeight, cleanKept, createLibraryStore, DETAILS_HEIGHT, noteUsed, QUERY_MAX, setActive, setDetailsHeight, setQuery, toggleSection, typeOfRow, watchAddedNodes,
} from '../../../../src/app/panels/library/state.ts';
import type { PanelKeep } from '../../../../src/app/platform.ts';

const registry = createRegistry(nodes);

/** The panel's entry of the preferences as a test holds it: what was written, in order, and what a read answers. */
function memoryKeep(initial: unknown = null): PanelKeep & { readonly writes: unknown[]; value(): unknown } {
  let held: unknown = initial;
  const writes: unknown[] = [];
  return {
    writes,
    value: () => held,
    read: async () => held,
    write(value) {
      held = structuredClone(value);
      writes.push(held);
    },
  };
}

/** A turn of the event loop: what the read of the entry needs to arrive. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('the list holds each type once, newest first, and at most eight', () => {
  assert.deepEqual(pushRecent([], 'a'), ['a']);
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
  assert.deepEqual(pushRecent(['a', 'b'], 'x', 2), ['x', 'a']);
  let list: string[] = [];
  for (let i = 0; i < 12; i++) list = pushRecent(list, `type/${i}`);
  assert.equal(RECENT_MAX, 8);
  assert.deepEqual(list, ['type/11', 'type/10', 'type/9', 'type/8', 'type/7', 'type/6', 'type/5', 'type/4']);

  assert.deepEqual(cleanRecent(['a', 'b', 'a', '', 3, null, 'c']), ['a', 'b', 'c']);
  assert.deepEqual(cleanRecent('a'), []);
  assert.deepEqual(cleanRecent(undefined), []);
  assert.equal(cleanRecent(Array.from({ length: 40 }, (_, i) => `t/${i}`)).length, RECENT_MAX);
});

test('a node counts as used when one transaction adds it, by whatever hand; undo, redo, a paste of several and an opened project do not', () => {
  const ui = createUiStore();
  const doc = createDocStore({ ui });
  const seen: (string | null)[] = [];
  let previous = doc.getState();
  doc.subscribe((next) => {
    seen.push(addedType(previous, next));
    previous = next;
  });
  const last = (): string | null => seen[seen.length - 1] ?? null;

  let blur = '';
  doc.getState().transact('Add Blur', (draft) => { blur = addNode(draft, registry, 'filter/blur', { x: 0, y: 0 }); });
  assert.equal(last(), 'filter/blur');

  // What is no new node: a parameter, a connection, the view.
  let noise = '';
  doc.getState().transact('Add Noise', (draft) => { noise = addNode(draft, registry, 'generate/fractal-noise', { x: 0, y: 0 }); });
  assert.equal(last(), 'generate/fractal-noise');
  doc.getState().transact('Connect', (draft) => { connect(draft, registry, { node: noise, port: 'out' }, { node: blur, port: 'in' }); });
  assert.equal(last(), null);
  doc.getState().transact('Radius', (draft) => setParam(draft, registry, blur, 'radius', 0.033));
  assert.equal(last(), null);
  doc.getState().transact('View', (draft) => setView(draft, { height: { node: blur, port: 'out' } }), { undoable: false });
  assert.equal(last(), null);

  // Undo takes the node away and redo brings it back: neither is a use.
  doc.getState().undo();
  doc.getState().undo();
  doc.getState().undo();
  assert.equal(Object.keys(doc.getState().doc.nodes).length, 1);
  assert.equal(last(), null);
  doc.getState().redo();
  assert.equal(Object.keys(doc.getState().doc.nodes).length, 2);
  assert.equal(last(), null);

  // Several nodes in one transaction: a paste or a duplicate.
  doc.getState().transact('Paste', (draft) => {
    addNode(draft, registry, 'filter/sharpen', { x: 0, y: 0 });
    addNode(draft, registry, 'filter/median', { x: 0, y: 0 });
  });
  assert.equal(last(), null);
  doc.getState().transact('Delete', (draft) => removeNodes(draft, [blur]));
  assert.equal(last(), null);

  // A project that is opened holds nodes nobody added now.
  const opened = structuredClone(newDoc()) as DocDraft;
  addNode(opened, registry, 'generate/island', { x: 0, y: 0 });
  doc.getState().load(opened as GraphDoc, null);
  assert.equal(last(), null);
  doc.getState().transact('Add Sea', (draft) => { addNode(draft, registry, 'simulate/sea', { x: 0, y: 0 }); });
  assert.equal(last(), 'simulate/sea');
  assert.deepEqual(seen.filter((type) => type !== null), ['filter/blur', 'generate/fractal-noise', 'simulate/sea']);
});

test('the store follows the document, and keeps the tab, the folded sections, the recent nodes and the height of the details for the next start, in the preferences', async () => {
  const keep = memoryKeep();
  const store = createLibraryStore(keep);
  assert.deepEqual(
    { ...store.getState() },
    { tab: 'nodes', collapsed: [], recent: [], detailsHeight: null, query: '', active: null, example: null, gallery: false, searchRequests: 0, mounted: false },
  );
  await turn();
  assert.deepEqual(keep.writes, [], 'reading the entry writes nothing');

  const doc = createDocStore({ ui: createUiStore() });
  const stop = watchAddedNodes(store, doc, (type) => !type.startsWith('ref/'));
  const add = (type: string): void => doc.getState().transact('Add', (draft) => { addNode(draft, registry, type, { x: 0, y: 0 }); });
  add('filter/blur');
  add('generate/dunes');
  add('ref/blur');
  add('filter/blur');
  assert.deepEqual(store.getState().recent, ['filter/blur', 'generate/dunes'], 'a reference node is none of the library');
  const held = store.getState().recent;
  add('filter/blur');
  assert.equal(store.getState().recent, held, 'the newest again changes nothing');
  stop();
  add('filter/warp');
  assert.deepEqual(store.getState().recent, ['filter/blur', 'generate/dunes']);

  toggleSection(store, 'generate');
  toggleSection(store, 'io', false);
  toggleSection(store, 'io', false);
  toggleSection(store, 'adjust', true);
  assert.deepEqual(store.getState().collapsed, ['generate', 'io']);
  toggleSection(store, 'generate');
  assert.deepEqual(store.getState().collapsed, ['io']);
  store.setState({ tab: 'examples' });

  // The height the user gave the details: a whole number of pixels within its limits, written when it changes.
  let writes = keep.writes.length;
  setDetailsHeight(store, 300.4);
  setDetailsHeight(store, 300);
  assert.deepEqual([store.getState().detailsHeight, keep.writes.length], [300, writes + 1]);
  setDetailsHeight(store, 5);
  assert.equal(store.getState().detailsHeight, DETAILS_HEIGHT.min);
  setDetailsHeight(store, 1e9);
  assert.equal(store.getState().detailsHeight, DETAILS_HEIGHT.max);
  setDetailsHeight(store, Number.NaN);
  assert.equal(store.getState().detailsHeight, null, 'what is no height gives the choice back to the panel');
  setDetailsHeight(store, 240);
  assert.deepEqual([cleanDetailsHeight('240'), cleanDetailsHeight(null), cleanDetailsHeight(Infinity), cleanDetailsHeight(239.5)], [null, null, null, 240]);

  // What a search and a selection are is not kept: writes happen for the kept members only.
  writes = keep.writes.length;
  setQuery(store, 'blur');
  setActive(store, 'search:filter/blur');
  store.setState({ example: 'alpine-range', gallery: true });
  assert.equal(keep.writes.length, writes);
  assert.deepEqual(keep.value(), { tab: 'examples', collapsed: ['io'], recent: ['filter/blur', 'generate/dunes'], detailsHeight: 240 });

  // The next start: the entry arrives a moment after the store is made, and is what the panel then shows.
  const next = createLibraryStore(keep);
  assert.deepEqual([next.getState().tab, next.getState().recent], ['nodes', []], 'until the preferences are read the panel is at its first state');
  await turn();
  assert.deepEqual([next.getState().tab, next.getState().collapsed, next.getState().recent, next.getState().detailsHeight, next.getState().query, next.getState().active],
    ['examples', ['io'], ['filter/blur', 'generate/dunes'], 240, '', null]);
  assert.equal(keep.writes.length, writes, 'taking what was kept is no change to write');
  setDetailsHeight(next, null);
  const third = createLibraryStore(keep);
  await turn();
  assert.equal(third.getState().detailsHeight, null);
  noteUsed(next, 'simulate/snow');
  assert.deepEqual(next.getState().recent, ['simulate/snow', 'filter/blur', 'generate/dunes']);
});

test('what the user changed before the preferences were read stays, and is written with what was kept of the rest', async () => {
  const keep = memoryKeep({ tab: 'examples', collapsed: ['io'], recent: ['filter/blur'], detailsHeight: 240 });
  const store = createLibraryStore(keep);
  // Faster than the file: a node is added and a section folded before the entry has arrived.
  noteUsed(store, 'generate/dunes');
  toggleSection(store, 'select');
  assert.deepEqual(keep.writes, [], 'what the last run kept is not replaced by what this one started with');
  await turn();
  assert.deepEqual(
    [store.getState().tab, store.getState().collapsed, store.getState().recent, store.getState().detailsHeight],
    ['examples', ['select'], ['generate/dunes'], 240],
  );
  assert.deepEqual(keep.writes, [{ tab: 'examples', collapsed: ['select'], recent: ['generate/dunes'], detailsHeight: 240 }]);
});

test('a search text is cut at its greatest length', () => {
  const store = createLibraryStore(null);
  setQuery(store, 'W'.repeat(400));
  assert.deepEqual([QUERY_MAX, store.getState().query.length], [80, 80]);
  const held = store.getState();
  setQuery(store, 'W'.repeat(900));
  assert.equal(store.getState(), held, 'the same text again changes nothing');
  setQuery(store, 'blur');
  assert.equal(store.getState().query, 'blur');
});

test('an entry that holds something else, cannot be read, or is missing leaves the panel at its first state', async () => {
  for (const value of ['', null, [], '{', 'x', 7, { tab: 3, collapsed: 'all', recent: {}, detailsHeight: 'tall' }]) {
    assert.deepEqual(cleanKept(value), { tab: 'nodes', collapsed: [], recent: [], detailsHeight: null }, JSON.stringify(value));
  }
  assert.deepEqual(
    cleanKept({ tab: 'examples', collapsed: ['io', 4, 'select'], recent: ['a/b', 'a/b', 7], detailsHeight: 1e6 }),
    { tab: 'examples', collapsed: ['io', 'select'], recent: ['a/b'], detailsHeight: DETAILS_HEIGHT.max },
  );
  const partly = createLibraryStore(memoryKeep({ tab: 'examples', recent: 'none' }));
  await turn();
  assert.deepEqual([partly.getState().tab, partly.getState().collapsed, partly.getState().recent, partly.getState().detailsHeight], ['examples', [], [], null]);

  // A preferences file that cannot be read answers null (src/app/platform.ts): the panel works, and keeps what it is given from then on.
  const unread = memoryKeep(null);
  const store = createLibraryStore(unread);
  await turn();
  noteUsed(store, 'filter/blur');
  assert.deepEqual(store.getState().recent, ['filter/blur']);
  assert.deepEqual(unread.value(), { tab: 'nodes', collapsed: [], recent: ['filter/blur'], detailsHeight: null });
  const none = createLibraryStore(null);
  toggleSection(none, 'io');
  assert.deepEqual(none.getState().collapsed, ['io']);
});

test('the key of a row names its node type, and the key of a section none', () => {
  assert.equal(typeOfRow('generate:generate/mountain-range'), 'generate/mountain-range');
  assert.equal(typeOfRow('recent:filter/blur'), 'filter/blur');
  assert.equal(typeOfRow('search:io/export-landscape'), 'io/export-landscape');
  assert.equal(typeOfRow('section:generate'), null);
  assert.equal(typeOfRow('section:recent'), null);
  assert.equal(typeOfRow(null), null);
  assert.equal(typeOfRow('nothing'), null);
});
