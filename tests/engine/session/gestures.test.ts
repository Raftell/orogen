// Gestures and drafts (runtime.md 7.3 rules 3 to 5 and 7; 5.4, transient entries): the draft level on the ladder,
// a draft that is not aborted by a newer edit, the refinement at the end, and the pure policy functions.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  draftResolution, nextDraftLevel, thumbnailResolution, viewTargets,
} from '../../../src/core/session/scheduler.ts';
import { testGpu } from '../gpu/rig.ts';
import { doc, DRAFT, endings, PREVIEW, REGISTRY, resetSlow, slow, startSession } from './rig.ts';

await testGpu();

const VIEW = { height: { node: 'out', port: 'out' } };
const graph = (value: number, iterations = 200, settings = {}) => doc({
  level: { type: 'ref/constant', params: { value } },
  walk: { type: 'ref/slow', params: { iterations }, inputs: { in: 'level.out' } },
  out: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'walk.out' } },
}, VIEW, settings);
const OUT = { node: 'out', port: 'out' };
const bytes = (resolution: number): number => resolution * resolution * 4;

test('edits inside a gesture are drafts on a coarser ladder level; endGesture refines at the preview resolution', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(0.25), 1);
    const full = await t.next('view-updated');
    assert.deepEqual([full.resolution, full.draft], [PREVIEW, false]);

    t.session.beginGesture();
    t.session.beginGesture();                                   // calls do not nest: ignored
    t.session.setDocument(graph(0.5), 2);
    const first = await t.next('view-updated');
    assert.deepEqual([first.revision, first.resolution, first.draft], [2, DRAFT[2], true], 'the first draft of a gesture is two levels down');
    const firstStart = t.of('request-start').find((e) => e.requestId === first.requestId)!;
    assert.equal(firstStart.purpose, 'draft');
    assert.equal((await t.session.inspect(OUT))?.mean, 2 * (0.5 + 200), 'the draft holds the new content, at its own resolution');
    assert.equal(t.renderer.content?.height?.width, DRAFT[2]);

    // The level of the next draft follows from how long this one took (rule 4), whatever that was on this machine.
    const took = t.of('eval-end').find((e) => e.requestId === first.requestId)!.wallMs;
    t.session.setDocument(graph(0.625), 3);
    const second = await t.next('view-updated');
    assert.deepEqual([second.revision, second.resolution, second.draft], [3, DRAFT[nextDraftLevel(2, took)], true]);

    // Drafts are transient: the ticks of a drag leave the entries of the last one, not one set per tick (5.4).
    for (let revision = 4; revision <= 7; revision++) {
      t.session.setDocument(graph(revision / 8), revision);
      await t.next('view-updated', (e) => e.revision === revision);
    }
    await t.idle();
    const last = t.of('view-updated').at(-1)!;
    const memory = t.memory();
    // Four outputs per resolution: level.out, walk.out, walk.steps, out.out.
    assert.equal(memory.cacheBytes + memory.pinnedBytes, 4 * bytes(PREVIEW) + 4 * bytes(last.resolution), JSON.stringify(memory));
    assert.equal(memory.pinnedBytes, bytes(last.resolution), 'the draft on screen is pinned');

    t.session.endGesture();
    const refined = await t.next('view-updated');
    assert.deepEqual([refined.revision, refined.resolution, refined.draft], [7, PREVIEW, false]);
    assert.equal(t.of('request-start').find((e) => e.requestId === refined.requestId)!.purpose, 'view');
    assert.equal((await t.session.inspect(OUT))?.mean, 2 * (7 / 8 + 200));
    assert.equal(slow.runs.get(PREVIEW), 2, 'the preview resolution was evaluated for the first document and for the refinement only');

    // A gesture without an edit ends without an evaluation: the full result of the latest revision is shown already.
    const from = t.mark();
    t.session.beginGesture();
    t.session.endGesture();
    await t.idle();
    assert.equal(t.of('request-start', from).length, 0);
    // Outside a gesture an edit is a full request again.
    t.session.setDocument(graph(0.125), 8);
    assert.equal((await t.next('view-updated')).resolution, PREVIEW);
  } finally {
    await t.dispose();
  }
});

test('the draft level follows the measured time of the draft before: finer after a fast one, coarser after a slow one', async () => {
  resetSlow();
  const t = await startSession();
  try {
    let revision = 0;
    let level: 1 | 2 = 2;
    const seen: number[] = [];
    /** One draft; checks that it ran at the level rule 4 gives for the time of the draft before, and returns its own time. */
    const draft = async (value: number, gain: number, iterations: number): Promise<number> => {
      t.session.setDocument(doc({
        level: { type: 'ref/constant', params: { value } },
        walk: { type: 'ref/slow', params: { iterations }, inputs: { in: 'level.out' } },
        out: { type: 'ref/gain', params: { gain }, inputs: { in: 'walk.out' } },
      }, VIEW), ++revision);
      const shown = await t.next('view-updated', (e) => e.revision === revision);
      assert.deepEqual([shown.resolution, shown.draft], [DRAFT[level], true], `draft ${revision} runs ${level} level(s) below the preview`);
      seen.push(shown.resolution);
      const tookMs = t.of('eval-end').find((e) => e.requestId === shown.requestId)!.wallMs;
      level = nextDraftLevel(level, tookMs);
      return tookMs;
    };

    t.session.beginGesture();
    // A draft that is slow on this adapter: the passes of the slow node are raised until one takes three times the threshold.
    let iterations = 4000;
    let slowMs = 0;
    for (let round = 0; round < 10 && slowMs < 150; round++) {
      slowMs = await draft(round / 16, 2, iterations);
      if (slowMs < 150) iterations = Math.ceil(iterations * Math.min(4, Math.max(1.5, 200 / Math.max(slowMs, 1))));
    }
    assert.ok(slowMs >= 150, `${iterations} passes take ${slowMs} ms`);
    assert.equal(level, 2, 'after a slow draft the next one is two levels down');

    // A fast one: only the last node has changed, the slow one is a hit among the entries of the draft before.
    let fastMs = Infinity;
    for (let round = 0; round < 8 && 4 * fastMs > 50; round++) fastMs = await draft(1, 3 + round, iterations);
    assert.ok(4 * fastMs <= 50, `a draft that runs one cheap node took ${fastMs} ms`);
    assert.equal(level, 1, 'after a fast draft the next one is one level down');

    // At the finer level the slow node runs again, slowly: back to two levels.
    const finer = await draft(2, 3, iterations);
    assert.equal(seen.at(-1), DRAFT[1]);
    assert.ok(finer > 50, `the slow node at the finer level took ${finer} ms`);
    assert.equal(level, 2);
    await draft(3, 3, iterations);
    assert.equal(seen.at(-1), DRAFT[2]);

    // A new gesture starts two levels down again, whatever the last draft was.
    let again = Infinity;
    for (let round = 0; round < 8 && 4 * again > 50; round++) again = await draft(3, 5 + round, iterations);
    assert.equal(level, 1);
    t.session.endGesture();
    await t.next('view-updated', (e) => !e.draft);
    t.session.beginGesture();
    level = 2;
    await draft(3, 20, iterations);
    assert.equal(seen.at(-1), DRAFT[2], 'the first draft of a gesture uses d = 2');
  } finally {
    await t.dispose();
  }
});

test('a running draft is not aborted by newer edits: it is shown, and the newest revision runs next', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(0.25), 1);
    await t.next('view-updated');
    t.session.beginGesture();
    let edited = false;
    slow.at = (i) => {
      if (i !== 100 || edited) return;
      edited = true;
      // Three edits while the draft of revision 2 is in its slow node.
      t.session.setDocument(graph(0.5), 3);
      t.session.setDocument(graph(0.625), 4);
      t.session.setDocument(graph(0.75), 5);
    };
    t.session.setDocument(graph(0.375), 2);
    const first = await t.next('view-updated');
    const second = await t.next('view-updated');
    await t.idle();
    assert.deepEqual([first.revision, first.draft], [2, true], 'the draft that was running finished and was shown');
    assert.deepEqual([second.revision, second.draft], [5, true]);
    const drafts = t.of('request-start').filter((e) => e.purpose === 'draft');
    assert.deepEqual(drafts.map((e) => e.revision), [2, 5], 'revisions 3 and 4 were never evaluated');
    assert.equal(t.of('eval-end').find((e) => e.requestId === drafts[0]!.requestId)!.status, 'ok');
    assert.equal((await t.session.inspect(OUT))?.mean, 2 * (0.75 + 200));
  } finally {
    await t.dispose();
  }
});

test('endGesture aborts the running draft and evaluates the latest revision in full', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(0.25), 1);
    await t.next('view-updated');
    const bound = t.renderer.content?.height?.view;
    t.session.beginGesture();
    let ended = false;
    slow.at = (i, ctx) => {
      if (i !== 100 || ended || ctx.res === PREVIEW) return;
      ended = true;
      t.session.endGesture();
    };
    t.session.setDocument(graph(0.5), 2);
    const shown = await t.next('view-updated');
    await t.idle();
    assert.deepEqual([shown.revision, shown.resolution, shown.draft], [2, PREVIEW, false]);
    const starts = t.of('request-start').filter((e) => e.revision === 2);
    assert.deepEqual(starts.map((e) => e.purpose), ['draft', 'view']);
    assert.deepEqual(endings(t.events, starts[0]!.requestId), { level: 'run', walk: 'skipped:aborted', out: 'skipped:aborted' });
    assert.equal(t.of('view-updated').length, 2, 'the aborted draft showed nothing');
    assert.notEqual(t.renderer.content?.height?.view, bound);
  } finally {
    await t.dispose();
  }
});

test('a full evaluation that is running is aborted by the first draft of a gesture', async () => {
  resetSlow();
  const t = await startSession();
  try {
    let dragged = false;
    slow.at = (i) => {
      if (i !== 100 || dragged) return;
      dragged = true;
      t.session.beginGesture();
      t.session.setDocument(graph(0.5), 2);
    };
    t.session.setDocument(graph(0.25), 1);
    const shown = await t.next('view-updated');
    assert.deepEqual([shown.revision, shown.draft], [2, true]);
    const starts = t.of('request-start');
    assert.deepEqual(starts.map((e) => [e.revision, e.purpose]), [[1, 'view'], [2, 'draft']]);
    assert.equal(t.of('eval-end').find((e) => e.requestId === starts[0]!.requestId)!.status, 'aborted');
  } finally {
    await t.dispose();
  }
});

test('the draft level: two levels down first, one when a draft was fast, two again when one was slow', () => {
  assert.equal(nextDraftLevel(2, 0), 1);
  assert.equal(nextDraftLevel(2, 12.5), 1, '4t = 50 is still fast');
  assert.equal(nextDraftLevel(2, 12.6), 2);
  assert.equal(nextDraftLevel(1, 50), 1, 't = 50 is not yet slow');
  assert.equal(nextDraftLevel(1, 50.1), 2);
  assert.equal(nextDraftLevel(1, 3), 1);

  const settings = (buildResolution: number, previewLevel: number) => graph(0, 1, { buildResolution, previewLevel });
  assert.deepEqual([draftResolution(settings(4033, 2), 1), draftResolution(settings(4033, 2), 2)], [505, 253]);
  assert.deepEqual([draftResolution(settings(513, 1), 1), draftResolution(settings(513, 1), 2)], [129, 65]);
  // Where the ladder has no such level, the coarsest defined one.
  assert.deepEqual([draftResolution(settings(513, 3), 1), draftResolution(settings(513, 3), 2)], [33, 33]);
  assert.deepEqual([draftResolution(settings(129, 2), 1), draftResolution(settings(129, 2), 2)], [33, 33]);
  assert.deepEqual([draftResolution(settings(8129, 5), 1), draftResolution(settings(8129, 5), 2)], [128, 128]);
});

test('the thumbnail resolution is the coarsest ladder level of at least 128', () => {
  assert.deepEqual([8129, 4033, 2017, 1009, 513, 257, 129, 145].map(thumbnailResolution), [128, 253, 253, 253, 129, 129, 129, 145]);
});

test('the view targets: the height as a field, the overlay by its meaning, and nothing for what does not exist', () => {
  const base = graph(0.5, 1);
  const tinted = doc({ level: { type: 'ref/constant' }, paint: { type: 'ref/tint' } });
  const view = (ui: object) => ({ ...tinted, ui });
  assert.deepEqual(viewTargets(base, REGISTRY), [{ ref: OUT, as: 'field' }]);
  assert.deepEqual(viewTargets({ ...base, ui: {} }, REGISTRY), []);
  const level = { node: 'level', port: 'out' }, paint = { node: 'paint', port: 'out' };
  assert.deepEqual(
    viewTargets(view({ view: { height: level, overlay: { ref: paint, as: 'color', opacity: 0.5 } } }), REGISTRY),
    [{ ref: level, as: 'field' }, { ref: paint, as: 'color' }],
  );
  // A mask or a heat overlay is a field, also of a colour port; a height may be a colour port too (5.6).
  assert.deepEqual(
    viewTargets(view({ view: { height: paint, overlay: { ref: paint, as: 'heat', opacity: 1 } } }), REGISTRY),
    [{ ref: paint, as: 'field' }, { ref: paint, as: 'field' }],
  );
  assert.deepEqual(viewTargets(view({ view: { overlay: { ref: level, as: 'mask', opacity: 1 } } }), REGISTRY), [{ ref: level, as: 'field' }]);
  // A node or a port the document lacks is left out (7.4 rule 1).
  assert.deepEqual(
    viewTargets(view({ view: { height: { node: 'gone', port: 'out' }, overlay: { ref: { node: 'level', port: 'nope' }, as: 'mask', opacity: 1 } } }), REGISTRY),
    [],
  );
  assert.deepEqual(viewTargets(view({ view: { height: { node: 'constructor', port: 'out' }, overlay: { ref: paint, as: 'color', opacity: 1 } } }), REGISTRY), [{ ref: paint, as: 'color' }]);
});
