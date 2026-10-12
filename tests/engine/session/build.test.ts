// Builds through the session (runtime.md 7.6, 2.8, 7.7): a build runs exclusively, previews pause and resume,
// the events, cancellation, and a build function that rejects. The build function is the rig's: one evaluation
// in build mode with staged delivery, at 513.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineEvent } from '../../../src/core/runtime.ts';
import { testGpu } from '../gpu/rig.ts';
import { doc, endings, PREVIEW, resetSlow, slow, startSession } from './rig.ts';

await testGpu();

const VIEW = { height: { node: 'out', port: 'out' } };
const graph = (value: number, iterations = 200) => doc({
  level: { type: 'ref/constant', params: { value } },
  walk: { type: 'ref/slow', params: { iterations }, inputs: { in: 'level.out' } },
  out: { type: 'ref/gain', params: { gain: 2 }, inputs: { in: 'walk.out' } },
}, VIEW);
const OUT = { node: 'out', port: 'out' };
const BUILD = 513;
const FIELD_BYTES = PREVIEW * PREVIEW * 4;

test('a build aborts the running preview, pauses previews, keeps the viewport, and a full evaluation follows it', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.setDocument(graph(0.25), 1);
    await t.next('view-updated');
    await t.idle();
    const bound = t.renderer.content?.height?.view;
    assert.ok(bound);

    // While the build has its target in hand: what the session does with calls made meanwhile.
    const during: Record<string, unknown> = {};
    t.builds.onTarget = async () => {
      during.sameView = t.renderer.content?.height?.view === bound;
      // What is on screen is pinned, beside what the build holds of its own at this moment.
      during.viewPinned = t.memory().pinnedBytes >= FIELD_BYTES + BUILD * BUILD * 4;
      during.inspect = await t.session.inspect(OUT);
      during.second = await t.session.build({ doc: graph(0.5), outDir: '/out/other' }).then(() => 'resolved', (e: Error) => e.message);
      t.session.setDocument(graph(0.25), 3);                    // recorded, not evaluated
      t.session.requestThumbnails(['level']);
    };
    // The build is asked for while the preview of revision 2 is in its slow node.
    let building: Promise<unknown> | null = null;
    slow.at = (i, ctx) => {
      if (ctx.res !== PREVIEW || i !== 100 || building) return;
      building = t.session.build({ doc: graph(0.5), outDir: '/out/terrain' });
    };
    const from = t.mark();
    t.session.setDocument(graph(0.75), 2);
    const end = await t.next('build-end');
    const result = await building!;
    const shown = await t.next('view-updated');
    await t.idle();

    // The result is the build function's, with the request id the session gave it.
    const start = t.of('build-start', from)[0]!;
    assert.deepEqual(result, { requestId: start.requestId, status: 'ok', problems: [], files: [], manifest: null, report: null, outDir: '/out/terrain' });
    assert.deepEqual({ ...start }, { type: 'build-start', requestId: start.requestId, resolution: BUILD, outDir: '/out/terrain' });
    assert.deepEqual({ ...end }, { type: 'build-end', requestId: start.requestId, status: 'ok' });
    assert.deepEqual(t.builds.calls, [{ requestId: start.requestId, outDir: '/out/terrain', resolution: BUILD, means: [2 * (0.5 + 200)] }]);
    assert.deepEqual(during, {
      sameView: true, viewPinned: true, inspect: null, second: 'A build is already running',
    }, 'the viewport keeps the last result, which is pinned; inspect answers null; a second build is refused');

    // The order of the whole episode.
    const events = t.events.slice(from);
    const preview = t.of('request-start', from)[0]!;
    assert.deepEqual([preview.revision, preview.purpose], [2, 'view']);
    assert.deepEqual(endings(events, preview.requestId), { level: 'run', walk: 'skipped:aborted', out: 'skipped:aborted' }, 'rule 2: the running preview was aborted');
    const outline = events
      .filter((e) => ['request-start', 'build-start', 'eval-start', 'eval-end', 'build-progress', 'build-result', 'build-end', 'view-updated', 'memory'].includes(e.type))
      .map((e) => (e.type === 'request-start' ? `request-start ${e.purpose} ${e.revision}` : e.type === 'eval-start' ? `eval-start ${e.mode} ${e.resolution}` : e.type));
    assert.deepEqual(outline, [
      'request-start view 2', `eval-start preview ${PREVIEW}`, 'eval-end', 'memory',                      // the aborted preview
      'memory',                                                                                           // rule 3: Engine.trim()
      'request-start build 2', 'build-start', `eval-start build ${BUILD}`, 'build-progress', 'eval-end', 'memory', 'build-result', 'build-end',
      'memory',                                                                                           // rule 7: Engine.trim({ keepResolution })
      'request-start view 3', `eval-start preview ${PREVIEW}`, 'eval-end', 'view-updated', 'memory',      // the full evaluation of the latest document
    ]);
    // Rule 3: the cache was emptied when the build started; only what was on screen survived.
    const memories = events.filter((e): e is Extract<EngineEvent, { type: 'memory' }> => e.type === 'memory');
    assert.deepEqual([memories[1]!.cacheBytes, memories[1]!.pinnedBytes, memories[1]!.freeBytes], [0, FIELD_BYTES, 0]);
    // Rule 7: after the build nothing of the build resolution is kept.
    assert.deepEqual([memories[3]!.cacheBytes, memories[3]!.pinnedBytes, memories[3]!.freeBytes], [0, FIELD_BYTES, 0]);
    // Every event of the build was forwarded with its request id.
    assert.deepEqual(endings(events, start.requestId), { level: 'run', walk: 'run', out: 'run' });
    assert.equal(t.of('build-result', from)[0]!.result.status, 'ok');

    // Revision 3 is the document of revision 1 again, and it is evaluated from nothing: the cache did not survive the build.
    assert.equal(shown.revision, 3);
    assert.deepEqual(endings(events, shown.requestId), { level: 'run', walk: 'run', out: 'run' });
    assert.equal(t.of('keys', from).at(-1)!.revision, 3, 'a document set during a build is recorded');
    assert.ok(t.of('eval-start', from).every((e) => e.mode === 'build' || e.requestId !== start.requestId), 'the build evaluates in build mode');
    assert.equal(t.of('request-start', from).filter((e) => e.requestId > preview.requestId && e.requestId < shown.requestId && e.purpose !== 'build').length, 0, 'no preview was scheduled until the build had ended');
    assert.notEqual(t.renderer.content?.height?.view, bound);
    assert.equal((await t.session.inspect(OUT))?.mean, 2 * (0.25 + 200));
  } finally {
    await t.dispose();
  }
});

test('cancelBuild aborts the build; it ends "aborted" and previews resume', async () => {
  resetSlow();
  const t = await startSession();
  try {
    t.session.cancelBuild();                                    // none runs: nothing happens
    t.session.setDocument(graph(0.25), 1);
    await t.next('view-updated');
    await t.idle();
    slow.at = (i, ctx) => { if (ctx.res === BUILD && i === 50) t.session.cancelBuild(); };
    const from = t.mark();
    const result = await t.session.build({ doc: graph(0.5), outDir: '/out/terrain' });
    assert.equal(result.status, 'aborted');
    const end = t.of('build-end', from)[0]!;
    assert.deepEqual([end.status, end.requestId], ['aborted', result.requestId]);
    assert.deepEqual(endings(t.events.slice(from), result.requestId), { level: 'run', walk: 'skipped:aborted', out: 'skipped:aborted' });
    const shown = await t.next('view-updated');
    assert.equal(shown.revision, 1, 'the latest document is evaluated again after the build');
    await t.idle();
    const memory = t.memory();
    assert.deepEqual([memory.workingBytes, memory.pinnedBytes], [0, FIELD_BYTES], 'the cancelled build left nothing behind');
  } finally {
    await t.dispose();
  }
});

test('a build function that rejects: build-end "errors", build() rejects with the same reason, previews resume', async () => {
  resetSlow();
  const t = await startSession();
  try {
    // No document was ever set: the build has its own, and the request names revision 0.
    const reason = new Error('the output folder cannot be created');
    t.builds.rejectWith = reason;
    await assert.rejects(t.session.build({ doc: graph(0.5), outDir: '/out/terrain' }), (thrown) => thrown === reason);
    const start = t.of('request-start')[0]!;
    assert.deepEqual([start.purpose, start.revision], ['build', 0]);
    assert.deepEqual(t.of('build-end').map((e) => [e.requestId, e.status]), [[start.requestId, 'errors']]);

    // The session goes on: the next build runs, and so does a preview.
    const result = await t.session.build({ doc: graph(0.5, 8), outDir: '/out/terrain' });
    assert.equal(result.status, 'ok');
    assert.ok(result.requestId > start.requestId, 'request ids increase');
    t.session.setDocument(graph(0.25, 8), 1);
    assert.equal((await t.next('view-updated')).revision, 1);
    await assert.rejects(t.session.build({ doc: graph(0.5), outDir: 7 as unknown as string }), TypeError);
  } finally {
    await t.dispose();
  }
});
