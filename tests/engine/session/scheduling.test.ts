// Scheduling (runtime.md 7.3 rules 1, 2 and 6; 7.1 setPaused; 2.8): latest wins, what a newer request aborts,
// what stays on screen meanwhile, pausing, and the trim when the preview resolution changes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testGpu } from '../gpu/rig.ts';
import { doc, endings, PREVIEW, resetSlow, slow, startSession, story } from './rig.ts';

await testGpu();

const VIEW = { height: { node: 'out', port: 'out' } };
/** level → walk (slow) → out. `out.out` is 2 × (value + iterations). */
const graph = (value: number, iterations = 300, settings = {}) => doc({
  level: { type: 'ref/constant', params: { value } },
  walk: { type: 'ref/slow', params: { iterations }, inputs: { in: 'level.out' } },
  out: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'walk.out' } },
}, VIEW, settings);
const OUT = { node: 'out', port: 'out' };
const FIELD_BYTES = PREVIEW * PREVIEW * 4;

test('a burst of document revisions evaluates only the last', async () => {
  resetSlow();
  const t = await startSession();
  try {
    // One task: the first starts at once (rule 1), the others replace one another as the one that waits (rule 2).
    for (let revision = 1; revision <= 8; revision++) t.session.setDocument(graph(revision / 8), revision);
    const shown = await t.next('view-updated');
    await t.idle();

    const starts = t.of('request-start');
    assert.deepEqual(starts.map((e) => [e.revision, e.purpose]), [[1, 'view'], [8, 'view']], 'revisions 2 to 7 were never evaluated');
    assert.deepEqual(endings(t.events, starts[0]!.requestId), { level: 'skipped:aborted', walk: 'skipped:aborted', out: 'skipped:aborted' });
    assert.deepEqual(endings(t.events, starts[1]!.requestId), { level: 'run', walk: 'run', out: 'run' });
    assert.deepEqual(t.of('node-start').map((e) => e.requestId), [starts[1]!.requestId, starts[1]!.requestId, starts[1]!.requestId]);
    assert.equal(slow.runs.get(PREVIEW), 1, 'the slow node ran once');

    assert.deepEqual(t.of('view-updated'), [shown]);
    assert.deepEqual(
      { ...shown }, { type: 'view-updated', requestId: starts[1]!.requestId, revision: 8, resolution: PREVIEW, draft: false, height: true, overlay: false },
    );
    assert.deepEqual(t.of('keys').map((e) => e.revision), [8], 'the keys of a replaced document are not emitted');

    const stats = await t.session.inspect(OUT);
    assert.deepEqual(stats, { min: 2 * (1 + 300), max: 2 * (1 + 300), mean: 2 * (1 + 300), nonFinite: 0 });
  } finally {
    await t.dispose();
  }
});

test('an edit upstream of a slow node aborts it, and what was shown stays bound until the new result is ready', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(0.25), 1);
    const first = await t.next('view-updated');
    assert.equal(first.revision, 1);
    const bound = t.renderer.content?.height;
    assert.ok(bound, 'the first result is on screen');
    const switches = t.renderer.switches;

    // In the middle of the slow node, twice: while revision 2 is evaluated, where revision 3 arrives, and while 3 is.
    const seen: { revision: number; sameView: boolean; pinnedBytes: number }[] = [];
    let revision = 2;
    slow.at = (i) => {
      if (i !== 150) return;
      seen.push({ revision, sameView: t.renderer.content?.height?.view === bound.view, pinnedBytes: t.memory().pinnedBytes });
      if (revision === 2) t.session.setDocument(graph(0.75), ++revision);
    };
    t.session.setDocument(graph(0.5), 2);
    const second = await t.next('view-updated');
    await t.idle();

    assert.equal(second.revision, 3, 'revision 2 was never shown');
    assert.deepEqual(seen.map((s) => [s.revision, s.sameView]), [[2, true], [3, true]], 'the stale result stays bound while newer ones are evaluated');
    for (const s of seen) assert.ok(s.pinnedBytes >= FIELD_BYTES, `what is on screen is pinned: ${s.pinnedBytes} bytes`);
    assert.equal(t.renderer.switches, switches + 1, 'the viewport switched once, to the new result, and was never blank');
    assert.notEqual(t.renderer.content?.height?.view, bound.view);

    const starts = t.of('request-start').filter((e) => e.revision >= 2);
    assert.deepEqual(starts.map((e) => e.revision), [2, 3]);
    assert.deepEqual(endings(t.events, starts[0]!.requestId), { level: 'run', walk: 'skipped:aborted', out: 'skipped:aborted' });
    assert.equal(t.of('eval-end').find((e) => e.requestId === starts[0]!.requestId)?.status, 'aborted');
    assert.deepEqual(endings(t.events, starts[1]!.requestId), { level: 'run', walk: 'run', out: 'run' });

    const stats = await t.session.inspect(OUT);
    assert.equal(stats?.mean, 2 * (0.75 + 300));
    // The handles of the result before were released when the viewport had switched: one result is pinned, not two.
    assert.equal(t.memory().pinnedBytes, FIELD_BYTES);
  } finally {
    await t.dispose();
  }
});

test('an evaluation in which the view target fails shows nothing: the last result stays', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(0.25, 8), 1);
    await t.next('view-updated');
    const bound = t.renderer.content?.height?.view;
    slow.at = () => { throw new Error('the slow node fails'); };
    t.session.setDocument(graph(0.5, 8), 2);
    const end = await t.next('eval-end');
    await t.idle();
    assert.equal(end.status, 'errors');
    assert.deepEqual(endings(t.events, end.requestId), { level: 'run', walk: 'error:node-exception', out: 'skipped:upstream' });
    assert.equal(t.of('view-updated').length, 1, 'nothing new is shown');
    assert.equal(t.renderer.content?.height?.view, bound, 'the viewport keeps the last shown content');
    assert.equal(t.memory().pinnedBytes, FIELD_BYTES);
  } finally {
    await t.dispose();
  }
});

test('setPaused(true) aborts the running preview and starts no other; documents are still recorded', async () => {
  resetSlow();
  const t = await startSession();
  try {
    slow.at = (i) => { if (i === 100) t.session.setPaused(true); };
    t.session.setDocument(graph(0.25), 1);
    const end = await t.next('eval-end');
    assert.equal(end.status, 'aborted');
    slow.at = undefined;

    t.session.setDocument(graph(0.5), 2);
    t.session.setDocument(graph(0.75), 3);
    const keys = await t.next('keys', (e) => e.revision === 3);
    assert.deepEqual(Object.keys(keys.keys).sort(), ['level', 'out', 'walk']);
    await t.idle();
    assert.deepEqual(t.of('request-start').map((e) => e.revision), [1], 'no evaluation starts while paused');
    assert.equal(t.of('view-updated').length, 0);

    t.session.setPaused(false);
    const shown = await t.next('view-updated');
    assert.equal(shown.revision, 3);
    assert.deepEqual(t.of('request-start').map((e) => e.revision), [1, 3]);
    assert.equal((await t.session.inspect(OUT))?.mean, 2 * (0.75 + 300));
  } finally {
    await t.dispose();
  }
});

test('a changed preview resolution trims the cache to the new resolution before the full evaluation', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(0.25, 16), 1);
    await t.next('view-updated');
    await t.idle();
    const before = t.memory();
    assert.ok(before.cacheBytes + before.pinnedBytes >= 3 * FIELD_BYTES, 'the first result is cached');

    const from = t.mark();
    t.session.setDocument(graph(0.25, 16, { previewLevel: 2 }), 2);
    const shown = await t.next('view-updated');
    await t.idle();
    assert.deepEqual([shown.revision, shown.resolution, shown.draft], [2, 129, false]);
    // The trim reports before the evaluation is asked for, and leaves only what is on screen of the old resolution.
    const order = t.events.slice(from).filter((e) => e.type === 'memory' || e.type === 'request-start').map((e) => e.type);
    assert.deepEqual(order.slice(0, 2), ['memory', 'request-start']);
    const trimmed = t.of('memory', from)[0]!;
    assert.deepEqual([trimmed.cacheBytes, trimmed.pinnedBytes, trimmed.freeBytes], [0, FIELD_BYTES, 0]);
    assert.equal(slow.runs.get(129), 1);

    // Back at the first resolution nothing of it is cached any more.
    t.session.setDocument(graph(0.25, 16), 3);
    const back = await t.next('view-updated');
    assert.equal(back.resolution, PREVIEW);
    assert.equal(slow.runs.get(PREVIEW), 2, 'the trim emptied the cache of the old preview resolution');
  } finally {
    await t.dispose();
  }
});

test('a view that names nothing shows nothing and makes no evaluation; a dangling reference is left out', async () => {
  resetSlow();
  const t = await startSession();
  try {
    const plain = graph(0.25, 8);
    t.session.setDocument(plain, 1);
    await t.next('view-updated');
    assert.ok(t.renderer.content?.height);

    // The overlay names a node the document lacks: the height alone is evaluated and shown (7.4 rule 1).
    t.session.setDocument({ ...plain, ui: { view: { ...VIEW, overlay: { ref: { node: 'gone', port: 'out' }, as: 'mask', opacity: 1 } } } }, 2);
    const partial = await t.next('view-updated');
    assert.deepEqual([partial.revision, partial.height, partial.overlay], [2, true, false]);

    const from = t.mark();
    t.session.setDocument({ ...plain, ui: {} }, 3);
    const empty = await t.next('view-updated');
    await t.idle();
    assert.deepEqual([empty.revision, empty.resolution, empty.draft, empty.height, empty.overlay], [3, PREVIEW, false, false, false]);
    assert.equal(t.renderer.content, null, 'the viewport draws nothing');
    assert.equal(t.of('request-start', from).length, 0, 'no view evaluation is made');
    assert.equal(t.memory().pinnedBytes, 0, 'the handles of the last result were released');
    assert.equal(await t.session.inspect(OUT), null, 'nothing is shown, so there is nothing to inspect');

    // In a gesture too: there is nothing to draft, and nothing to refine when it ends.
    const dragged = t.mark();
    t.session.beginGesture();
    t.session.setDocument({ ...plain, ui: { view: { height: { node: 'gone', port: 'out' } } } }, 4);
    const still = await t.next('view-updated');
    assert.deepEqual([still.revision, still.resolution, still.draft, still.height], [4, PREVIEW, false, false]);
    t.session.endGesture();
    await t.idle();
    assert.equal(t.of('view-updated', dragged).length, 1);
    assert.equal(t.of('request-start', dragged).length, 0);
  } finally {
    await t.dispose();
  }
});

test('setDocument takes revisions that increase; a document set before is replaced, never queued', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(0.25, 8), 5);
    assert.throws(() => t.session.setDocument(graph(0.5, 8), 5), RangeError);
    assert.throws(() => t.session.setDocument(graph(0.5, 8), 4), RangeError);
    assert.throws(() => t.session.setDocument(graph(0.5, 8), 5.5), RangeError);
    assert.throws(() => t.session.setDocument(null as never, 6), TypeError);
    const shown = await t.next('view-updated');
    await t.idle();
    assert.equal(shown.revision, 5);
    assert.deepEqual(t.of('request-start').map((e) => e.revision), [5], 'a refused call schedules nothing');
    // A revision may skip numbers: the interface sends only the revisions the evaluator can see (8.5).
    t.session.setDocument(graph(0.5, 8), 12);
    assert.equal((await t.next('view-updated')).revision, 12);
  } finally {
    await t.dispose();
  }
});

test('events of one request come in the documented order: request-start, the evaluation, view-updated, memory', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(0.25, 8), 1);
    await t.next('view-updated');
    await t.idle();
    const id = t.of('request-start')[0]!.requestId;
    // The fields of the session's own events are exactly those of runtime.md 7.7.
    assert.deepEqual(t.of('request-start'), [{ type: 'request-start', requestId: id, revision: 1, purpose: 'view' }]);
    const keys = t.of('keys')[0]!;
    assert.deepEqual(Object.keys(keys).sort(), ['keys', 'revision', 'type']);
    assert.deepEqual([keys.revision, Object.keys(keys.keys).sort()], [1, ['level', 'out', 'walk']]);
    assert.ok(Object.values(keys.keys).every((key) => typeof key === 'string' && key.length > 0));
    assert.deepEqual(t.of('view-updated'), [{ type: 'view-updated', requestId: id, revision: 1, resolution: PREVIEW, draft: false, height: true, overlay: false }]);
    assert.deepEqual(story(t.events, id), [
      'request-start', 'eval-start',
      'node-start level', 'node-done level', 'node-start walk', 'node-done walk', 'node-start out', 'node-done out',
      'eval-end', 'view-updated',
    ]);
    const after = t.events.slice(t.events.findIndex((e) => e.type === 'view-updated') + 1).map((e) => e.type);
    assert.equal(after[0], 'memory', 'memory follows every evaluation');
  } finally {
    await t.dispose();
  }
});
