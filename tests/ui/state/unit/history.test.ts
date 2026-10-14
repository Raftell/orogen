// docStore's history (runtime.md 8.5, rules 3, 4, 6 and 7, and the saved state): merging by key and time,
// gestures that collapse a scrub or a drag into one entry, the selection an entry records and restores, the
// limits, and `unsaved` against the last saved state.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addNode, moveNodes, newDoc, removeNodes, setGraphViewport, setGroup, setParam, setSettings, setView, type GraphDoc } from '../../../../src/core/runtime.ts';
import { HISTORY_MAX_BYTES, HISTORY_MAX_ENTRIES, MERGE_WINDOW_MS, type HistoryEntry } from '../../../../src/app/state/doc-store.ts';
import { setSelection } from '../../../../src/app/state/ui-store.ts';
import { createPage, difference, REGISTRY, testClock, type Page, type TestClock, same } from './_page.ts';

interface Setup {
  readonly page: Page;
  readonly clock: TestClock;
  readonly land: string;
  readonly soft: string;
  /** The revision the setup ends at: making the graph and loading it took revisions of their own. */
  readonly revision: number;
}

function setup(limits?: { readonly entries?: number; readonly bytes?: number }): Setup {
  const clock = testClock();
  const page = createPage({ clock, ...(limits ? { limits } : {}) });
  const land = page.add('ref/fbm');
  const soft = page.add('ref/blur', {}, { in: `${land}.out` });
  // The two entries that made the graph are no part of what a test counts.
  page.doc.getState().load(page.doc.getState().doc, null);
  return { page, clock, land, soft, revision: page.doc.getState().revision };
}

const gainKey = (s: Setup): string => `param:${s.land}:gain`;
/** One transaction that sets the gain, under the key of its control; `null`: under no key. */
function setGain(s: Setup, value: number, mergeKey: string | null = gainKey(s)): void {
  s.page.doc.getState().transact('Fbm: Roughness', (draft) => setParam(draft, REGISTRY, s.land, 'gain', value), mergeKey === null ? {} : { mergeKey });
}
const gain = (s: Setup): unknown => s.page.doc.getState().doc.nodes[s.land]!.params.gain;
const past = (s: Setup): readonly HistoryEntry[] => s.page.doc.getState().past;
/** The values a list of patches sets, in order: which transaction a patch came from. */
const values = (patches: HistoryEntry['forward']): unknown[] => patches.map((patch) => patch.value);

// ---- rule 3: merging ------------------------------------------------------------------------------------------------------

test('transactions with one merge key less than 600 ms apart are one entry: forward patches appended, inverse patches prepended', () => {
  const s = setup();
  assert.equal(MERGE_WINDOW_MS, 600);
  setGain(s, 0.6);
  const first = past(s)[0]!;
  assert.deepEqual([first.mergeKey, first.time, first.label], [gainKey(s), 1000, 'Fbm: Roughness']);

  s.clock.advance(599);
  setGain(s, 0.7);
  s.clock.advance(599);
  setGain(s, 0.8);
  assert.equal(past(s).length, 1, 'each within 600 ms of the one before, whatever the time since the first');
  const merged = past(s)[0]!;
  assert.deepEqual(values(merged.forward), [0.6, 0.7, 0.8], 'the old forward patches, then the new');
  assert.deepEqual(values(merged.inverse), [0.7, 0.6, 0.5], 'the new inverse patches, then the old');
  assert.equal(merged.time, 1000 + 599 + 599, 'the time of the last transaction merged in');
  assert.equal(s.page.doc.getState().revision, s.revision + 3, 'every transaction is a revision of its own');

  // One undo takes all three back, one redo makes them again.
  s.page.doc.getState().undo();
  assert.equal(gain(s), 0.5);
  s.page.doc.getState().redo();
  assert.equal(gain(s), 0.8);
});

test('no merge at 600 ms, with another key, without a key, or across an entry of another key', () => {
  const s = setup();
  setGain(s, 0.6);
  s.clock.advance(600);
  setGain(s, 0.7);
  assert.equal(past(s).length, 2, '600 ms is not less than 600 ms');

  s.clock.advance(10);
  s.page.doc.getState().transact('Fbm: Octaves', (d) => setParam(d, REGISTRY, s.land, 'octaves', 5), { mergeKey: `param:${s.land}:octaves` });
  assert.equal(past(s).length, 3, 'another key');
  s.clock.advance(10);
  setGain(s, 0.8);
  assert.equal(past(s).length, 4, 'the last entry has another key: the entry of this key further down is not reached');

  s.clock.advance(10);
  setGain(s, 0.81, null);
  s.clock.advance(10);
  setGain(s, 0.82, null);
  assert.equal(past(s).length, 6, 'a transaction without a key never merges');
  assert.deepEqual(past(s).map((e) => e.mergeKey), [gainKey(s), gainKey(s), `param:${s.land}:octaves`, gainKey(s), null, null]);

  // Each is undone alone.
  const seen: unknown[] = [];
  for (let i = 0; i < 6; i++) {
    s.page.doc.getState().undo();
    seen.push(gain(s), s.page.doc.getState().doc.nodes[s.land]!.params.octaves);
  }
  assert.deepEqual(seen, [0.81, 5, 0.8, 5, 0.7, 5, 0.7, 8, 0.6, 8, 0.5, 8]);
});

test('a transaction that is not undoable neither merges nor keeps the next one from merging', () => {
  const s = setup();
  setGain(s, 0.6);
  s.clock.advance(100);
  s.page.doc.getState().transact('Pan', (d) => setGraphViewport(d, { x: 5, y: 5, zoom: 1 }), { undoable: false, mergeKey: gainKey(s) });
  s.clock.advance(100);
  setGain(s, 0.7);
  assert.equal(past(s).length, 1);
  assert.deepEqual(values(past(s)[0]!.forward), [0.6, 0.7]);
});

// ---- rule 4: gestures -----------------------------------------------------------------------------------------------------

test('a slider scrub is one entry however long it takes, and one undo', () => {
  const s = setup();
  const store = s.page.doc;
  store.getState().beginGesture(gainKey(s));
  assert.equal(store.getState().gesture, gainKey(s));
  for (let step = 1; step <= 40; step++) {
    s.clock.advance(1500);
    setGain(s, 0.5 + step / 100);
  }
  assert.equal(past(s).length, 1, '40 transactions, each 1.5 s after the one before');
  assert.equal(past(s)[0]!.forward.length, 40);
  assert.equal(past(s)[0]!.inverse.length, 40);
  assert.equal(store.getState().revision, s.revision + 40);
  store.getState().endGesture();
  assert.equal(store.getState().gesture, null);

  store.getState().undo();
  assert.equal(gain(s), 0.5, 'the value before the scrub');
  store.getState().redo();
  assert.equal(gain(s), 0.9, 'the value the scrub ended on');
});

test('a node drag is one entry: the moves of the drag, under the key of the drag', () => {
  const s = setup();
  const store = s.page.doc;
  const before = store.getState().doc.nodes[s.soft]!.position;
  store.getState().beginGesture('move:drag-17');
  for (let step = 0; step < 12; step++) {
    s.clock.advance(700);
    store.getState().transact('Move 2 nodes', (d) => moveNodes(d, [s.land, s.soft], { x: 3, y: -1 }), { mergeKey: 'move:drag-17' });
  }
  store.getState().endGesture();
  assert.equal(past(s).length, 1);
  assert.deepEqual(store.getState().doc.nodes[s.soft]!.position, { x: before.x + 36, y: before.y - 12 });
  assert.equal(store.getState().engineRevision, s.revision, 'moving nodes sends the engine nothing');
  store.getState().undo();
  assert.deepEqual(store.getState().doc.nodes[s.soft]!.position, before);
});

test('a group that is moved or resized is one entry under its key', () => {
  const s = setup();
  const store = s.page.doc;
  store.getState().transact('Group', (d) => setGroup(d, { id: 'g', title: 'Land', rect: { x: 0, y: 0, w: 100, h: 100 } }));
  s.clock.advance(5000);
  store.getState().beginGesture('group:g');
  for (let step = 1; step <= 5; step++) {
    s.clock.advance(900);
    store.getState().transact('Resize group', (d) => setGroup(d, { id: 'g', title: 'Land', rect: { x: 0, y: 0, w: 100 + 10 * step, h: 100 } }), { mergeKey: 'group:g' });
  }
  store.getState().endGesture();
  assert.equal(past(s).length, 2);
  store.getState().undo();
  assert.equal(store.getState().doc.groups.g!.rect.w, 100);
});

test('each gesture is an undo step of its own: a second scrub of the same slider does not continue the entry of the first', () => {
  const s = setup();
  const store = s.page.doc;
  store.getState().beginGesture(gainKey(s));
  setGain(s, 0.6);
  s.clock.advance(50);
  setGain(s, 0.65);
  store.getState().endGesture();

  s.clock.advance(MERGE_WINDOW_MS);
  store.getState().beginGesture(gainKey(s));
  setGain(s, 0.7);
  s.clock.advance(5000);
  setGain(s, 0.75);
  store.getState().endGesture();
  assert.equal(past(s).length, 2);
  assert.deepEqual(past(s).map((e) => values(e.forward)), [[0.6, 0.65], [0.7, 0.75]]);
  store.getState().undo();
  assert.equal(gain(s), 0.65, 'the value between the two scrubs');

  // Inside the 600 ms the rule of time still joins them, gesture or not: a tap right after a scrub.
  store.getState().redo();
  s.clock.advance(100);
  store.getState().beginGesture(gainKey(s));
  setGain(s, 0.8);
  store.getState().endGesture();
  assert.equal(past(s).length, 2);
  assert.deepEqual(values(past(s)[1]!.forward), [0.7, 0.75, 0.8]);
});

test('in a gesture, a transaction under another key is an entry of its own, and the gesture goes on after it', () => {
  const s = setup();
  const store = s.page.doc;
  store.getState().beginGesture(gainKey(s));
  setGain(s, 0.6);
  s.clock.advance(1000);
  store.getState().transact('Octaves', (d) => setParam(d, REGISTRY, s.land, 'octaves', 3));
  s.clock.advance(1000);
  setGain(s, 0.7);
  s.clock.advance(1000);
  setGain(s, 0.8);
  store.getState().endGesture();
  assert.deepEqual(past(s).map((e) => values(e.forward)), [[0.6], [3], [0.7, 0.8]]);

  // After the gesture has ended, only the rule of time merges.
  s.clock.advance(1000);
  setGain(s, 0.9);
  assert.equal(past(s).length, 4);
});

test('beginGesture and endGesture change nothing but `gesture`, and a second beginGesture takes its place', () => {
  const s = setup();
  const store = s.page.doc;
  const start = store.getState();
  start.endGesture();
  same(store.getState(), start, 'no gesture to end: no change');
  start.beginGesture('param:a:b');
  const begun = store.getState();
  assert.deepEqual([begun.gesture, begun.revision, begun.unsaved, begun.past.length, begun.doc === start.doc], ['param:a:b', start.revision, false, 0, true]);
  begun.beginGesture('param:a:b');
  same(store.getState(), begun, 'the same key again: no change');
  begun.beginGesture(gainKey(s));
  assert.equal(store.getState().gesture, gainKey(s));
  setGain(s, 0.6);
  s.clock.advance(5000);
  setGain(s, 0.7);
  assert.equal(past(s).length, 1, 'the gesture that is in progress is the one that merges');
});

// ---- rule 6: undo, redo and the selection --------------------------------------------------------------------------------

test('undo and redo end a gesture, and do nothing at the ends of the history', () => {
  const s = setup();
  const store = s.page.doc;
  const start = store.getState();
  start.undo();
  start.redo();
  same(store.getState(), start, 'nothing to undo or redo: no change, no revision');

  store.getState().beginGesture(gainKey(s));
  setGain(s, 0.6);
  s.clock.advance(2000);
  setGain(s, 0.7);
  store.getState().undo();
  assert.deepEqual([store.getState().gesture, gain(s), past(s).length], [null, 0.5, 0], 'undo in mid-drag takes the drag back and ends it');
  // What the drag sends next is no part of a gesture any more.
  s.clock.advance(2000);
  setGain(s, 0.8);
  s.clock.advance(2000);
  setGain(s, 0.9);
  assert.equal(past(s).length, 2);

  store.getState().undo();
  store.getState().beginGesture('move:1');
  store.getState().redo();
  assert.deepEqual([store.getState().gesture, gain(s)], [null, 0.9], 'redo ends a gesture as well');
});

// ---- cancelGesture -------------------------------------------------------------------------------------------------------

test('cancelGesture takes a drag back whole: the document, the history and what could be redone are as before the drag', () => {
  const s = setup();
  setGain(s, 0.6);
  s.clock.advance(5000);
  setGain(s, 0.7);
  s.page.doc.getState().undo();
  const before = s.page.doc.getState();
  assert.deepEqual([gain(s), before.past.length, before.future.length], [0.6, 1, 1]);
  setSelection(s.page.ui, [s.soft]);

  s.clock.advance(5000);
  s.page.doc.getState().beginGesture(gainKey(s));
  setGain(s, 0.61);
  s.clock.advance(5000);
  setGain(s, 0.9);
  setSelection(s.page.ui, [s.land]);
  assert.deepEqual([gain(s), past(s).length, s.page.doc.getState().future.length], [0.9, 2, 0], 'the drag is an entry, and has cleared the future');

  s.page.doc.getState().cancelGesture();
  const after = s.page.doc.getState();
  assert.equal(difference(after.doc, before.doc), null, 'the document is the one the drag began with');
  assert.equal(after.past.length, 1, 'no entry is left of the drag: the next undo is the step before it');
  same(after.past[0], before.past[0]);
  same(after.future, before.future, 'and what could be redone before the drag still can');
  assert.deepEqual([after.gesture, after.unsaved], [null, before.unsaved]);
  assert.ok(after.revision > before.revision && after.engineRevision === after.revision, 'the engine is sent the document that is back');
  assert.deepEqual(s.page.ui.getState().selection, [s.soft], 'the selection is that of the press');

  s.page.doc.getState().redo();
  assert.equal(gain(s), 0.7, 'the redo that was there is the redo that runs');
  s.page.doc.getState().undo();
  s.page.doc.getState().undo();
  assert.deepEqual([gain(s), past(s).length], [0.5, 0]);
});

test('cancelGesture after a drag whose first step went into the entry before it: that entry is back as it was', () => {
  const s = setup();
  setGain(s, 0.6);
  const typed = past(s)[0]!;
  // Less than 600 ms after a typed value the drag begins: rule 3 merges its first transaction into that entry.
  s.clock.advance(100);
  s.page.doc.getState().beginGesture(gainKey(s));
  setGain(s, 0.65);
  setGain(s, 0.8);
  assert.equal(past(s).length, 1);
  assert.notEqual(past(s)[0], typed, 'the entry of the typed value was replaced by the merged one');

  s.page.doc.getState().cancelGesture();
  assert.equal(gain(s), 0.6, 'the typed value stays: only the drag is taken back');
  assert.deepEqual(past(s), [typed]);
  same(past(s)[0], typed);
  s.page.doc.getState().undo();
  assert.equal(gain(s), 0.5);
});

test('cancelGesture without a change, without a gesture, and with another change on top only ends the gesture', () => {
  const s = setup();
  const idle = s.page.doc.getState();
  s.page.doc.getState().cancelGesture();
  same(s.page.doc.getState(), idle, 'without a gesture nothing happens at all');

  s.page.doc.getState().beginGesture(gainKey(s));
  s.page.doc.getState().cancelGesture();
  assert.deepEqual([s.page.doc.getState().gesture, s.page.doc.getState().revision, past(s).length], [null, s.revision, 0]);

  // A change of another key in the middle of the drag: neither it nor the drag is taken back.
  s.page.doc.getState().beginGesture(gainKey(s));
  setGain(s, 0.9);
  s.page.doc.getState().transact('Move', (draft) => moveNodes(draft, [s.soft], { x: 40, y: 40 }));
  setGain(s, 0.95);
  const held = s.page.doc.getState();
  s.page.doc.getState().cancelGesture();
  assert.deepEqual([gain(s), past(s).length, s.page.doc.getState().gesture], [0.95, 3, null]);
  same(s.page.doc.getState().doc, held.doc);

  // After an undo in the middle of a drag the gesture is over (rule 6): a cancel that follows finds none.
  s.page.doc.getState().beginGesture(gainKey(s));
  setGain(s, 0.3);
  s.page.doc.getState().undo();
  const undone = s.page.doc.getState();
  s.page.doc.getState().cancelGesture();
  same(s.page.doc.getState(), undone);
});

test('a save in the middle of a drag that is then taken back leaves the project unsaved: the file holds what no undo leads to', () => {
  const s = setup();
  s.page.doc.getState().beginGesture(gainKey(s));
  setGain(s, 0.9);
  s.page.doc.getState().markSaved('/projects/hills.orogen');
  assert.equal(s.page.doc.getState().unsaved, false);
  s.page.doc.getState().cancelGesture();
  assert.deepEqual([gain(s), s.page.doc.getState().unsaved], [0.5, true]);
});

test('a new transaction clears the future', () => {
  const s = setup();
  setGain(s, 0.6, null);
  setGain(s, 0.7, null);
  s.page.doc.getState().undo();
  assert.equal(s.page.doc.getState().future.length, 1);
  setGain(s, 0.65, null);
  assert.deepEqual([past(s).length, s.page.doc.getState().future.length], [2, 0]);
  s.page.doc.getState().redo();
  assert.equal(gain(s), 0.65, 'nothing is left to redo');
});

test('an entry holds the selection before and after its transaction; undo restores the first, redo the second', () => {
  const s = setup();
  const { doc: store, ui } = s.page;
  setSelection(ui, [s.land]);

  // A command that selects what it made does so inside the recipe.
  let added = '';
  store.getState().transact('Add Blur', (draft) => {
    added = addNode(draft, REGISTRY, 'ref/blur', { x: 0, y: 300 });
    setSelection(ui, [added]);
  });
  assert.deepEqual([past(s)[0]!.selectionBefore, past(s)[0]!.selectionAfter], [[s.land], [added]]);

  // Deleting what is selected: the selection cannot name a node that is gone.
  setSelection(ui, [added, s.soft]);
  store.getState().transact('Delete', (draft) => removeNodes(draft, [added, s.soft]));
  assert.deepEqual(ui.getState().selection, [], 'the store drops the ids of removed nodes');
  assert.deepEqual([past(s)[1]!.selectionBefore, past(s)[1]!.selectionAfter], [[added, s.soft], []]);

  setSelection(ui, [s.land]);
  store.getState().undo();
  assert.deepEqual(ui.getState().selection, [added, s.soft], 'the nodes are back, and selected as they were');
  store.getState().undo();
  assert.deepEqual(ui.getState().selection, [s.land], 'the selection before the node was added');
  store.getState().redo();
  assert.deepEqual(ui.getState().selection, [added]);
  store.getState().redo();
  assert.deepEqual(ui.getState().selection, []);
});

test('a merged entry holds the selection before its first transaction and after its last', () => {
  const s = setup();
  const { doc: store, ui } = s.page;
  setSelection(ui, [s.land]);
  store.getState().beginGesture(gainKey(s));
  setGain(s, 0.6);
  setSelection(ui, [s.land, s.soft]);
  setGain(s, 0.7);
  setSelection(ui, [s.soft]);
  setGain(s, 0.8);
  store.getState().endGesture();
  assert.deepEqual([past(s)[0]!.selectionBefore, past(s)[0]!.selectionAfter], [[s.land], [s.soft]]);
});

test('the selection is no part of the history: changing it is no entry and no revision', () => {
  const s = setup();
  const start = s.page.doc.getState();
  let notified = 0;
  const off = s.page.ui.subscribe(() => { notified++; });
  setSelection(s.page.ui, [s.soft, s.land, s.soft]);
  assert.deepEqual(s.page.ui.getState().selection, [s.soft, s.land], 'an id counts once');
  setSelection(s.page.ui, [s.soft, s.land]);
  assert.equal(notified, 1, 'the same selection again tells nobody');
  off();
  same(s.page.doc.getState(), start);
});

// ---- rule 7: the limits ---------------------------------------------------------------------------------------------------

test('the history holds at most 500 entries and 64 MiB of patches', () => {
  assert.equal(HISTORY_MAX_ENTRIES, 500);
  assert.equal(HISTORY_MAX_BYTES, 64 * 1024 * 1024);
  const s = setup();
  // 520 entries, bounded by the loop.
  for (let i = 1; i <= 520; i++) setGain(s, i / 1000, null);
  assert.equal(past(s).length, 500);
  assert.equal(past(s)[0]!.forward[0]!.value, 21 / 1000, 'the oldest 20 were dropped');
  for (let i = 0; i < 500; i++) s.page.doc.getState().undo();
  assert.deepEqual([past(s).length, gain(s)], [0, 20 / 1000], 'what the dropped entries did stays done');
  assert.equal(s.page.doc.getState().future.length, 500);
});

test('with a limit of entries, the oldest are dropped as new ones are added', () => {
  const s = setup({ entries: 3 });
  for (const value of [0.1, 0.2, 0.3, 0.4, 0.5]) setGain(s, value, null);
  assert.deepEqual(past(s).map((e) => e.forward[0]!.value), [0.3, 0.4, 0.5]);
  for (let i = 0; i < 5; i++) s.page.doc.getState().undo();
  assert.equal(gain(s), 0.2, 'three undos, then nothing more to undo');
});

test('with a limit of bytes, the oldest are dropped until the patches fit, a merged entry counted at its whole size', () => {
  const size = (entry: HistoryEntry): number => JSON.stringify(entry.forward).length + JSON.stringify(entry.inverse).length;
  const probe = setup();
  setGain(probe, 0.25, null);
  const one = size(past(probe)[0]!);

  // Room for three such entries and not for four.
  const s = setup({ bytes: 3 * one + one / 2 });
  for (const value of [0.11, 0.12, 0.13]) setGain(s, value, null);
  assert.equal(past(s).length, 3);
  setGain(s, 0.14, null);
  assert.deepEqual(past(s).map((e) => e.forward[0]!.value), [0.12, 0.13, 0.14]);

  // An entry that grows by merging pushes the older ones out, and at last itself.
  s.page.doc.getState().beginGesture(gainKey(s));
  setGain(s, 0.21);
  assert.deepEqual(past(s).map((e) => e.forward.length), [1, 1, 1], 'a fourth entry: the oldest is dropped');
  setGain(s, 0.22);
  assert.deepEqual(past(s).map((e) => e.forward.length), [1, 2], 'the entry of the gesture holds two transactions: room for one more only');
  setGain(s, 0.23);
  assert.deepEqual(past(s).map((e) => e.forward.length), [3]);
  setGain(s, 0.24);
  assert.deepEqual(past(s).map((e) => e.forward.length), [], 'an entry beyond the limit by itself is dropped too');
  setGain(s, 0.25);
  assert.deepEqual(past(s).map((e) => values(e.forward)), [[0.25]], 'the gesture goes on in a new entry');
  s.page.doc.getState().endGesture();
  assert.equal(gain(s), 0.25);
  assert.equal(s.page.doc.getState().unsaved, true);
});

// ---- the saved state -------------------------------------------------------------------------------------------------------

test('unsaved says whether the document differs from the last saved state: through edits, undo, redo and a save', () => {
  const s = setup();
  const store = s.page.doc;
  const unsaved = (): boolean => store.getState().unsaved;
  assert.deepEqual([unsaved(), store.getState().path], [false, null]);

  setGain(s, 0.6, null);
  assert.equal(unsaved(), true);
  store.getState().undo();
  assert.equal(unsaved(), false, 'undone back to what was loaded');
  store.getState().redo();
  assert.equal(unsaved(), true);

  const revision = store.getState().revision;
  store.getState().markSaved('/projects/hills.orogen');
  assert.deepEqual([unsaved(), store.getState().path, store.getState().revision, past(s).length], [false, '/projects/hills.orogen', revision, 1], 'a save changes neither the document nor the history');

  setGain(s, 0.7, null);
  setGain(s, 0.8, null);
  assert.equal(unsaved(), true);
  store.getState().undo();
  assert.equal(unsaved(), true);
  store.getState().undo();
  assert.equal(unsaved(), false, 'back at the saved state');
  store.getState().undo();
  assert.equal(unsaved(), true, 'before the saved state');
  store.getState().redo();
  assert.equal(unsaved(), false);

  // A new edit from before the saved state: no undo or redo leads back to it.
  store.getState().undo();
  setGain(s, 0.55, null);
  assert.equal(unsaved(), true);
  store.getState().undo();
  assert.equal(unsaved(), true, 'the saved state is not in the history any more');
  store.getState().redo();
  store.getState().markSaved('/projects/hills.orogen');
  assert.equal(unsaved(), false);
});

test('changes under ui do not set unsaved; the two settings outside the history do, until the next save', () => {
  const s = setup();
  const store = s.page.doc;
  store.getState().transact('View', (d) => setView(d, { height: { node: s.soft, port: 'out' } }), { undoable: false });
  store.getState().transact('Pan', (d) => setGraphViewport(d, { x: 3, y: 4, zoom: 2 }), { undoable: false });
  assert.equal(store.getState().unsaved, false);

  store.getState().transact('Preview', (d) => setSettings(d, { previewLevel: 1 }), { undoable: false });
  assert.equal(store.getState().unsaved, true);
  setGain(s, 0.6, null);
  store.getState().undo();
  assert.equal(store.getState().unsaved, true, 'no undo takes a setting outside the history back');
  store.getState().markSaved('/projects/hills.orogen');
  assert.equal(store.getState().unsaved, false);
  store.getState().transact('View', (d) => setView(d, null), { undoable: false });
  assert.equal(store.getState().unsaved, false);
});

test('a save that names the revision it wrote: a file that is behind the document leaves the project unsaved', () => {
  const s = setup();
  const store = s.page.doc;
  setGain(s, 0.6, null);
  // The file was written of this revision, and nothing changed meanwhile: saved.
  store.getState().markSaved('/projects/hills.orogen', store.getState().revision);
  assert.deepEqual([store.getState().unsaved, store.getState().path], [false, '/projects/hills.orogen']);

  // The file is written of this revision, and the document goes on before the write has ended.
  setGain(s, 0.7, null);
  const written = store.getState().revision;
  setGain(s, 0.8, null);
  const before = store.getState();
  store.getState().markSaved('/projects/other.orogen', written);
  assert.deepEqual([store.getState().unsaved, store.getState().path], [true, '/projects/other.orogen'], 'the project is at its new place and not saved');
  assert.deepEqual([store.getState().doc, store.getState().revision, past(s)], [before.doc, before.revision, before.past], 'neither the document nor the history changed');
  // The file holds 0.7 and no place of the history is known to be it: undo does not arrive at a saved state,
  // not at 0.7 and not at the 0.6 of the save before.
  store.getState().undo();
  assert.deepEqual([gain(s), store.getState().unsaved], [0.7, true]);
  store.getState().undo();
  assert.deepEqual([gain(s), store.getState().unsaved], [0.6, true], 'the file no longer holds what the earlier save wrote');
  store.getState().redo();
  store.getState().redo();
  // The next save, of the document as it is.
  store.getState().markSaved('/projects/other.orogen', store.getState().revision);
  assert.deepEqual([gain(s), store.getState().unsaved], [0.8, false]);
});

test('an entry that a later transaction merged into is not the saved state any more', () => {
  const s = setup();
  const store = s.page.doc;
  setGain(s, 0.6);
  store.getState().markSaved('/projects/hills.orogen');
  s.clock.advance(100);
  setGain(s, 0.7);
  assert.deepEqual([past(s).length, store.getState().unsaved], [1, true]);
  store.getState().undo();
  assert.deepEqual([gain(s), store.getState().unsaved], [0.5, true], 'undo passes the saved value 0.6 by');
  store.getState().redo();
  assert.equal(store.getState().unsaved, true);
});

test('when the limit drops entries, the saved state follows what can still be reached', () => {
  const s = setup({ entries: 2 });
  const store = s.page.doc;
  // Saved at the start; the third entry drops the first, and with it the way back.
  for (const value of [0.1, 0.2, 0.3]) setGain(s, value, null);
  store.getState().undo();
  store.getState().undo();
  assert.deepEqual([past(s).length, gain(s), store.getState().unsaved], [0, 0.1, true]);

  // Saved after an entry that is then dropped as the last of the dropped ones: undoing everything leads back to it.
  store.getState().redo();
  store.getState().markSaved('/projects/hills.orogen');
  assert.deepEqual([gain(s), store.getState().unsaved], [0.2, false]);
  for (const value of [0.4, 0.5]) setGain(s, value, null);
  assert.deepEqual(past(s).map((e) => e.forward[0]!.value), [0.4, 0.5]);
  store.getState().undo();
  assert.equal(store.getState().unsaved, true);
  store.getState().undo();
  assert.deepEqual([gain(s), store.getState().unsaved], [0.2, false]);
});

// ---- load ------------------------------------------------------------------------------------------------------------------

test('load replaces the document and clears the history; the revision goes on and the engine is sent the document', () => {
  const s = setup();
  const { doc: store, ui } = s.page;
  setGain(s, 0.6, null);
  setGain(s, 0.7, null);
  store.getState().undo();
  store.getState().beginGesture('move:1');
  setSelection(ui, [s.land]);
  ui.setState({ dragPositions: { [s.land]: { x: 1, y: 2 } } });
  const before = store.getState();

  const other: GraphDoc = newDoc();
  before.load(other, '/projects/other.orogen');
  const loaded = store.getState();
  assert.equal(difference(loaded.doc, newDoc()), null);
  assert.deepEqual(
    [loaded.past.length, loaded.future.length, loaded.gesture, loaded.unsaved, loaded.path],
    [0, 0, null, false, '/projects/other.orogen'],
  );
  assert.equal(loaded.revision, before.revision + 1, 'never back to an earlier revision: the engine refuses one (7.1)');
  assert.equal(loaded.engineRevision, loaded.revision);
  assert.deepEqual([ui.getState().selection, ui.getState().dragPositions], [[], null]);

  // A new project that was never saved has no path.
  loaded.load(newDoc(), null);
  assert.deepEqual([store.getState().path, store.getState().unsaved, store.getState().revision], [null, false, loaded.revision + 1]);
  store.getState().undo();
  assert.equal(store.getState().revision, loaded.revision + 1, 'nothing of the document before can be undone into this one');
});
