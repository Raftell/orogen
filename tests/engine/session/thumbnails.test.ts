// Thumbnails through the session (runtime.md 7.3 rules 8 and 9, 5.12, 7.7): the by-product of a view evaluation,
// the idle evaluation of the other requested nodes at the thumbnail resolution, what aborts it, and the node that
// is too slow to run for a thumbnail alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineEvent } from '../../../src/core/runtime.ts';
import { testGpu } from '../gpu/rig.ts';
import { doc, endings, PREVIEW, resetSlow, slow, startSession, THUMBNAIL, type SessionRig } from './rig.ts';

await testGpu();

type ThumbnailEvent = Extract<EngineEvent, { type: 'thumbnail' }>;

/** The view chain level → walk → out, and two nodes beside it: `side` reads level, `paint` reads nothing. */
const graph = (p: { value?: number; side?: number; iterations?: number; view?: string } = {}) => doc({
  level: { type: 'ref/constant', params: { value: p.value ?? 0.25 } },
  walk: { type: 'ref/slow', params: { iterations: p.iterations ?? 32 }, inputs: { in: 'level.out' } },
  out: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'walk.out' } },
  side: { type: 'ref/gain', params: { gain: p.side ?? 3 }, inputs: { in: 'level.out' } },
  paint: { type: 'ref/tint', params: { tint: [0.25, 0.5, 0.75] } },
}, { height: { node: p.view ?? 'out', port: 'out' } });

/** Waits until a thumbnail of each node has arrived since `from`, and returns the latest of each. */
async function thumbnails(t: SessionRig, nodes: readonly string[], from: number): Promise<Record<string, ThumbnailEvent>> {
  const got = (): Record<string, ThumbnailEvent> => Object.fromEntries(t.of('thumbnail', from).map((e) => [e.nodeId, e]));
  // Bounded by the events that can arrive: each wait consumes at least one.
  for (let round = 0; round < 64 && nodes.some((id) => !(id in got())); round++) await t.next('thumbnail');
  return got();
}

test('thumbnails of the view chain are a by-product; the other requested nodes are evaluated when idle, at the thumbnail resolution', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.requestThumbnails(['level', 'walk', 'out', 'side', 'paint', 'no-such-node']);
    t.session.setDocument(graph(), 1);
    const keys = (await t.next('keys')).keys;
    t.mark();
    const got = await thumbnails(t, ['level', 'walk', 'out', 'side', 'paint'], 0);
    await t.idle();

    assert.deepEqual(t.of('request-start').map((e) => e.purpose), ['view', 'thumbnails'], 'one idle evaluation, and no other once every thumbnail is fresh');
    const [view, idle] = t.of('request-start');
    assert.deepEqual(endings(t.events, view!.requestId), { level: 'run', walk: 'run', out: 'run' });
    // The idle evaluation runs what the two remaining thumbnails need, at the thumbnail resolution, and nothing of the view chain below level.
    const start = t.of('eval-start').find((e) => e.requestId === idle!.requestId)!;
    assert.deepEqual([start.resolution, start.mode], [THUMBNAIL, 'preview']);
    assert.deepEqual(endings(t.events, idle!.requestId), { level: 'run', side: 'run', paint: 'run' });
    assert.deepEqual([...slow.runs], [[PREVIEW, 1]], 'the slow node ran for the view only, never for a thumbnail');
    assert.deepEqual(t.of('eval-start').map((e) => e.resolution), [PREVIEW, THUMBNAIL], 'nothing else was evaluated at the preview resolution');

    for (const id of ['level', 'walk', 'out', 'side', 'paint']) {
      const thumbnail = got[id]!;
      assert.equal(thumbnail.contentKey, keys[id], `the thumbnail of ${id} carries the node's content key`);
      assert.deepEqual(Object.keys(thumbnail).sort(), ['contentKey', 'nodeId', 'resolution', 'rgba', 'type']);
      assert.ok(thumbnail.rgba instanceof Uint8ClampedArray && thumbnail.rgba.length === 128 * 128 * 4);
      assert.equal(thumbnail.resolution, id === 'side' || id === 'paint' ? THUMBNAIL : PREVIEW);
    }
    assert.equal(t.of('thumbnail').length, 5, 'one thumbnail per node: level is not made again from the coarser grid');
    // The pixels are the content: the tint (0.25, 0.5, 0.75) encoded to sRGB, within the rounding of 8 bits.
    const pixel = [...got.paint!.rgba.subarray(0, 4)];
    assert.ok([137, 188, 225, 255].every((value, channel) => Math.abs(pixel[channel]! - value) <= 1), `the first pixel is ${pixel.join(', ')}`);

    // An edit beside the view chain: the view is evaluated from the cache, and the one stale thumbnail when idle.
    const from = t.mark();
    t.session.setDocument(graph({ side: 5 }), 2);
    const edited = (await t.next('keys')).keys;
    assert.deepEqual(Object.keys(keys).filter((id) => keys[id] !== edited[id]), ['side'], 'only the edited node has a new key');
    const again = await thumbnails(t, ['side'], from);
    await t.idle();
    assert.deepEqual(t.of('request-start', from).map((e) => e.purpose), ['view', 'thumbnails']);
    const second = t.of('request-start', from)[1]!;
    assert.deepEqual(endings(t.events, second.requestId), { level: 'cached', side: 'run' });
    assert.deepEqual(t.of('thumbnail', from).map((e) => e.nodeId), ['side']);
    assert.equal(again.side!.contentKey, edited.side);

    // Undo: the node has its first key again, but the thumbnail last delivered is the edited one, so it is stale.
    // The first result is still cached at the thumbnail resolution.
    const undo = t.mark();
    t.session.setDocument(graph({ side: 3 }), 3);
    const restored = await thumbnails(t, ['side'], undo);
    await t.idle();
    assert.equal(restored.side!.contentKey, keys.side);
    const third = t.of('request-start', undo).find((e) => e.purpose === 'thumbnails')!;
    assert.deepEqual(endings(t.events, third.requestId), { level: 'cached', side: 'cached' }, 'nothing ran for it');
  } finally {
    await t.dispose();
  }
});

test('requestThumbnails replaces the list, and a view or draft request aborts the idle evaluation', async () => {
  resetSlow();
  const t = await startSession();
  try {
    // The view shows level alone, so walk and out get their thumbnails from the idle evaluation.
    t.session.requestThumbnails(['out']);
    let edited = false;
    slow.at = (i, ctx) => {
      if (ctx.res !== THUMBNAIL || i !== 16 || edited) return;
      edited = true;
      t.session.setDocument(graph({ view: 'level', value: 0.5 }), 2);
    };
    t.session.setDocument(graph({ view: 'level' }), 1);
    const got = await thumbnails(t, ['out'], 0);
    await t.idle();

    const starts = t.of('request-start');
    assert.deepEqual(starts.map((e) => [e.revision, e.purpose]), [[1, 'view'], [1, 'thumbnails'], [2, 'view'], [2, 'thumbnails']]);
    assert.equal(t.of('eval-end').find((e) => e.requestId === starts[1]!.requestId)!.status, 'aborted', 'the edit aborted the idle evaluation');
    assert.deepEqual(endings(t.events, starts[3]!.requestId), { level: 'run', walk: 'run', out: 'run' });
    assert.equal(got.out!.resolution, THUMBNAIL);
    // `walk` was evaluated but is not on the list: its thumbnail is the engine's by-product all the same (5.12 rule 1).
    // level has two, one per content: the view showed it before the edit and after.
    assert.deepEqual(t.of('thumbnail').map((e) => e.nodeId).sort(), ['level', 'level', 'out', 'walk']);

    const from = t.mark();
    t.session.requestThumbnails(['paint']);
    const painted = await thumbnails(t, ['paint'], from);
    await t.idle();
    assert.equal(painted.paint!.resolution, THUMBNAIL);
    assert.deepEqual(t.of('request-start', from).map((e) => e.purpose), ['thumbnails']);
    assert.deepEqual(endings(t.events, t.of('request-start', from)[0]!.requestId), { paint: 'run' });
  } finally {
    await t.dispose();
  }
});

test('no idle thumbnails during a gesture', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.requestThumbnails(['side']);
    t.session.beginGesture();
    t.session.setDocument(graph(), 1);
    await t.next('view-updated');
    await t.idle();
    assert.deepEqual(t.of('request-start').map((e) => e.purpose), ['draft']);
    t.session.endGesture();
    await thumbnails(t, ['side'], 0);
    await t.idle();
    assert.deepEqual(t.of('request-start').map((e) => e.purpose), ['draft', 'view', 'thumbnails']);
  } finally {
    await t.dispose();
  }
});

test('a requested node that fails gets one idle evaluation, not one after another', async () => {
  resetSlow();
  const t = await startSession();
  try {
    // `walk` is beside the view and throws; `out` reads it.
    slow.at = () => { throw new Error('the slow node fails'); };
    t.session.requestThumbnails(['walk', 'out', 'side']);
    t.session.setDocument(graph({ view: 'level' }), 1);
    await thumbnails(t, ['side'], 0);
    await t.idle();
    const idle = t.of('request-start').filter((e) => e.purpose === 'thumbnails');
    assert.equal(idle.length, 1, 'the failed node is not evaluated again until its key changes');
    assert.deepEqual(endings(t.events, idle[0]!.requestId), { level: 'run', walk: 'error:node-exception', out: 'skipped:upstream', side: 'run' });

    // An edit that leaves the failed node's key alone does not bring it back either; one that changes it does.
    let from = t.mark();
    t.session.setDocument(graph({ view: 'level', side: 4 }), 2);
    await thumbnails(t, ['side'], from);
    await t.idle();
    const second = t.of('request-start', from).filter((e) => e.purpose === 'thumbnails');
    assert.equal(second.length, 1);
    assert.deepEqual(endings(t.events, second[0]!.requestId), { level: 'cached', side: 'run' });

    slow.at = undefined;
    from = t.mark();
    t.session.setDocument(graph({ view: 'level', side: 4, iterations: 16 }), 3);
    const fixed = await thumbnails(t, ['walk', 'out'], from);
    await t.idle();
    assert.deepEqual([fixed.walk!.resolution, fixed.out!.resolution], [THUMBNAIL, THUMBNAIL]);
  } finally {
    await t.dispose();
  }
});

test('a node predicted above 100 ms is not run for its thumbnail alone, unless it is cached', async () => {
  resetSlow();
  // What a node took is the machine's to say. The session is told here, and the rule is held to those numbers:
  // the prediction is the last timing scaled by the number of texels (5.10).
  const timings = new Map<string, { resolution: number; wallMs: number }>([
    ['level', { resolution: THUMBNAIL, wallMs: 1 }], ['side', { resolution: THUMBNAIL, wallMs: 1 }],
  ]);
  const t = await startSession({ lastTiming: (id) => timings.get(id) ?? null });
  try {
    /** level, `far` (reads level) and `side`; the view shows `far` or level. */
    const lab = (p: { iterations: number; side?: number; view?: string }) => doc({
      level: { type: 'ref/constant', params: { value: 0.25 } },
      far: { type: 'ref/slow', params: { iterations: p.iterations }, inputs: { in: 'level.out' } },
      side: { type: 'ref/gain', params: { gain: p.side ?? 3 }, inputs: { in: 'level.out' } },
    }, { height: { node: p.view ?? 'level', port: 'out' } });
    let revision = 0;
    const idleRequests = (from: number) => t.of('request-start', from).filter((e) => e.purpose === 'thumbnails');
    const resolutionOf = (requestId: number) => t.of('eval-start').find((e) => e.requestId === requestId)!.resolution;
    const ABORTED = { level: 'skipped:aborted', far: 'skipped:aborted' };

    // 1. `far` has no timing: nothing predicts it slow, so the idle evaluation runs it.
    t.session.requestThumbnails(['far', 'side']);
    let from = t.mark();
    t.session.setDocument(lab({ iterations: 8 }), ++revision);
    const keysA = (await t.next('keys')).keys;
    const first = await thumbnails(t, ['far', 'side'], from);
    await t.idle();
    assert.equal(first.far!.contentKey, keysA.far);
    assert.deepEqual(endings(t.events, idleRequests(from)[0]!.requestId), { level: 'run', far: 'run', side: 'run' });
    const runsBefore = slow.runs.get(THUMBNAIL)!;

    // 2. It took 100.5 ms there. With another parameter it is predicted slow and is not cached: it is left out
    // at the thumbnail resolution, and `side` gets its thumbnail. It is then tried at the preview resolution,
    // where it is not cached either and is predicted slower still: left out there as well, before anything ran.
    timings.set('far', { resolution: THUMBNAIL, wallMs: 100.5 });
    from = t.mark();
    t.session.setDocument(lab({ iterations: 9, side: 4 }), ++revision);
    const keysB = (await t.next('keys')).keys;
    assert.notEqual(keysB.far, keysA.far);
    const second = await thumbnails(t, ['side'], from);
    await t.idle();
    assert.equal(second.side!.contentKey, keysB.side);
    const idle = idleRequests(from);
    assert.equal(idle.length, 3, 'one evaluation that stopped before its first node, one without the slow node, and one try at the preview resolution');
    assert.deepEqual(idle.map((e) => resolutionOf(e.requestId)), [THUMBNAIL, THUMBNAIL, PREVIEW]);
    assert.deepEqual(endings(t.events, idle[0]!.requestId), { ...ABORTED, side: 'skipped:aborted' });
    assert.deepEqual(endings(t.events, idle[1]!.requestId), { level: 'cached', side: 'run' });
    assert.deepEqual(endings(t.events, idle[2]!.requestId), ABORTED, 'the try at the preview resolution ran nothing');
    assert.deepEqual([slow.runs.get(THUMBNAIL), slow.runs.get(PREVIEW)], [runsBefore, undefined], 'the slow node did not run');
    assert.deepEqual(t.of('thumbnail', from).map((e) => e.nodeId), ['side'], 'its thumbnail stays stale');

    // 3. A view evaluation runs it, and the thumbnail comes with that.
    from = t.mark();
    t.session.setDocument(lab({ iterations: 9, side: 4, view: 'far' }), ++revision);
    const third = await thumbnails(t, ['far'], from);
    await t.idle();
    assert.deepEqual([third.far!.contentKey, third.far!.resolution], [keysB.far, PREVIEW]);
    assert.equal(idleRequests(from).length, 0);

    // 4. Back to the first parameter: the thumbnail is stale again, the node is still predicted slow, but its
    // result of step 1 is cached at the thumbnail resolution, so the idle evaluation makes it without running it.
    from = t.mark();
    t.session.setDocument(lab({ iterations: 8, side: 4 }), ++revision);
    const fourth = await thumbnails(t, ['far'], from);
    await t.idle();
    assert.deepEqual([fourth.far!.contentKey, fourth.far!.resolution], [keysA.far, THUMBNAIL]);
    const last = idleRequests(from);
    assert.equal(last.length, 1);
    assert.deepEqual(endings(t.events, last[0]!.requestId), { level: 'cached', far: 'cached' });
    assert.equal(slow.runs.get(THUMBNAIL), runsBefore);

    // 5. A timing at another resolution counts by its texels: 396 ms at 257 are 99.8 ms at 129, which is not above
    // the limit, and 100 ms is not above it either. The node is run for its thumbnail.
    for (const [iterations, timing] of [[10, { resolution: PREVIEW, wallMs: 396 }], [11, { resolution: THUMBNAIL, wallMs: 100 }]] as const) {
      timings.set('far', timing);
      from = t.mark();
      t.session.setDocument(lab({ iterations, side: 4 }), ++revision);
      const keys = (await t.next('keys')).keys;
      const made = await thumbnails(t, ['far'], from);
      await t.idle();
      assert.deepEqual([made.far!.contentKey, made.far!.resolution], [keys.far, THUMBNAIL]);
      const ran = idleRequests(from);
      assert.equal(ran.length, 1);
      assert.deepEqual(endings(t.events, ran[0]!.requestId), { level: 'cached', far: 'run' });
    }
    assert.equal(slow.runs.get(THUMBNAIL), runsBefore + 2);
  } finally {
    await t.dispose();
  }
});

test('a node behind a slow one gets its thumbnail at the preview resolution, where the view has the slow one cached', async () => {
  resetSlow();
  // `walk` is the simulation the view shows; `mask` and `tint` read it and are on no path of the view; `deep`
  // is a second slow node behind it. Every timing is told, so the rule is held to these numbers.
  const timings = new Map<string, { resolution: number; wallMs: number }>([['walk', { resolution: PREVIEW, wallMs: 4000 }]]);
  const t = await startSession({ lastTiming: (id) => timings.get(id) ?? null });
  try {
    const lab = (p: { iterations?: number; gain?: number; view?: string } = {}) => doc({
      level: { type: 'ref/constant', params: { value: 0.25 } },
      walk: { type: 'ref/slow', params: { iterations: p.iterations ?? 12 }, inputs: { in: 'level.out' } },
      mask: { type: 'ref/gain', params: { gain: p.gain ?? 2 }, inputs: { in: 'walk.out' } },
      tint: { type: 'ref/gain', params: { gain: 5 }, inputs: { in: 'mask.out' } },
      deep: { type: 'ref/slow', params: { iterations: 3 }, inputs: { in: 'walk.out' } },
      last: { type: 'ref/gain', params: { gain: 7 }, inputs: { in: 'deep.out' } },
    }, { height: { node: p.view ?? 'walk', port: 'out' } });
    const idleRequests = (from: number) => t.of('request-start', from).filter((e) => e.purpose === 'thumbnails');
    const resolutionOf = (requestId: number) => t.of('eval-start').find((e) => e.requestId === requestId)!.resolution;
    let revision = 0;

    // 1. The view shows the simulation. At the thumbnail resolution it would have to run again, 1 s by its
    // timing: `mask` and `tint` are left out there. At the preview resolution it is cached: both are evaluated
    // from it, and nothing slow runs.
    t.session.requestThumbnails(['mask', 'tint']);
    let from = t.mark();
    t.session.setDocument(lab(), ++revision);
    const keys = (await t.next('keys')).keys;
    const got = await thumbnails(t, ['mask', 'tint'], from);
    await t.idle();
    assert.deepEqual([got.mask!.contentKey, got.mask!.resolution, got.tint!.contentKey, got.tint!.resolution], [keys.mask, PREVIEW, keys.tint, PREVIEW]);
    let idle = idleRequests(from);
    assert.deepEqual(idle.map((e) => resolutionOf(e.requestId)), [THUMBNAIL, PREVIEW], 'one try at the thumbnail resolution, then the preview resolution');
    assert.deepEqual(endings(t.events, idle[0]!.requestId), { level: 'skipped:aborted', walk: 'skipped:aborted', mask: 'skipped:aborted', tint: 'skipped:aborted' });
    assert.deepEqual(endings(t.events, idle[1]!.requestId), { level: 'cached', walk: 'cached', mask: 'run', tint: 'run' });
    assert.deepEqual([...slow.runs], [[PREVIEW, 1]], 'the simulation ran once, for the view');
    assert.equal(t.of('eval-end').find((e) => e.requestId === idle[1]!.requestId)!.status, 'ok');

    // 2. A node behind a second slow node that nothing has cached is left out at both resolutions: no thumbnail,
    // and no evaluation after the two tries.
    timings.set('deep', { resolution: PREVIEW, wallMs: 500 });
    from = t.mark();
    t.session.requestThumbnails(['mask', 'tint', 'last']);
    await t.idle();
    idle = idleRequests(from);
    assert.deepEqual(idle.map((e) => resolutionOf(e.requestId)), [THUMBNAIL, PREVIEW]);
    assert.deepEqual(idle.map((e) => t.of('eval-end').find((end) => end.requestId === e.requestId)!.status), ['aborted', 'aborted']);
    assert.deepEqual(t.of('thumbnail', from).map((e) => e.nodeId), []);
    assert.deepEqual([...slow.runs], [[PREVIEW, 1]]);

    // An edit beside the slow node, which runs a cheap node for the view: nothing is cached that was missing,
    // so the node behind the slow one is not tried again. The one stale thumbnail is made, at the preview resolution.
    from = t.mark();
    t.session.setDocument(lab({ view: 'mask', gain: 6 }), ++revision);
    const beside = await thumbnails(t, ['tint'], from);
    await t.idle();
    assert.equal(beside.tint!.resolution, PREVIEW);
    idle = idleRequests(from);
    const plans = idle.map((e) => t.of('eval-start').find((start) => start.requestId === e.requestId)!.plan.map((node) => node.nodeId));
    assert.deepEqual(plans, [['level', 'walk', 'mask', 'tint'], ['level', 'walk', 'mask', 'tint']], 'neither idle evaluation asks for the node that was left out');
    assert.deepEqual(idle.map((e) => resolutionOf(e.requestId)), [THUMBNAIL, PREVIEW]);
    assert.deepEqual([...slow.runs], [[PREVIEW, 1]]);

    // 3. Once a view evaluation has run that node, the cache holds it: the thumbnail that waited is made.
    from = t.mark();
    t.session.setDocument(lab({ view: 'deep', gain: 6 }), ++revision);
    const made = await thumbnails(t, ['last'], from);
    await t.idle();
    assert.equal(made.last!.resolution, PREVIEW);
    idle = idleRequests(from);
    assert.deepEqual(idle.map((e) => resolutionOf(e.requestId)), [PREVIEW], 'asked again at the preview resolution alone');
    assert.deepEqual(endings(t.events, idle[0]!.requestId), { level: 'cached', walk: 'cached', deep: 'cached', last: 'run' });

    // 4. The idle evaluation at the preview resolution is aborted by an edit like any other, and made again.
    let edited = false;
    const stop = t.session.subscribe((e) => {
      if (edited || e.type !== 'node-start' || e.nodeId !== 'tint') return;
      const request = t.of('request-start').find((r) => r.requestId === e.requestId)!;
      if (request.purpose !== 'thumbnails') return;
      edited = true;
      t.session.setDocument(lab({ view: 'deep', gain: 3 }), ++revision);
    });
    from = t.mark();
    t.session.setDocument(lab({ view: 'deep', gain: 4 }), ++revision);
    const again = await thumbnails(t, ['tint'], from);
    await t.idle();
    stop();
    assert.equal(edited, true);
    const purposes = t.of('request-start', from).map((e) => [e.revision, e.purpose]);
    assert.deepEqual(purposes.slice(0, 3), [[revision - 1, 'view'], [revision - 1, 'thumbnails'], [revision - 1, 'thumbnails']], 'the view, the try at the thumbnail resolution, the preview resolution');
    const interrupted = t.of('request-start', from)[2]!;
    assert.equal(t.of('eval-end').find((e) => e.requestId === interrupted.requestId)!.status, 'aborted', 'the edit aborted the idle evaluation at the preview resolution');
    assert.deepEqual([again.tint!.resolution, again.tint!.contentKey !== got.tint!.contentKey], [PREVIEW, true]);
    assert.deepEqual([...slow.runs].sort(), [[PREVIEW, 2]], 'no slow node ever ran for a thumbnail');
  } finally {
    await t.dispose();
  }
});
