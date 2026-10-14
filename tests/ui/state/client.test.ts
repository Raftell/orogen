// The stores and the engine client against the real engine, in Node (runtime.md 7.2, 8.3, 8.5): the client on one
// port of a MessageChannel, and on the other the protocol's server over a real session on a real engine, with a
// build function that calls buildProject with a memory sink. Everything the page does goes through docStore and
// the client; everything asserted of the engine is read from engineStore, the thumbnail cache or a call's result.
//
// The same client against a session that only records is in unit/client.test.ts. This file needs a GPU and no window.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setNodeFlags, setParam, setView, type EngineEvent } from '../../../src/core/runtime.ts';
import { INITIAL_ENGINE_STATE, type EngineState } from '../../../src/app/state/engine-store.ts';
import { selectNodes } from '../../../src/app/state/ui-store.ts';
import {
  applySettings, DRAFT, nodeStates, PREVIEW, same, REGISTRY, SETTINGS, showHeight, startApplication, startWorkerEnd, until, type Application,
} from './rig.ts';

/** The thumbnail resolution of the rig's settings (7.3 rule 9): the build resolution itself, whose next level is below 128. */
const THUMBNAIL = SETTINGS.buildResolution;

type EventOf<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;
const of = <T extends EngineEvent['type']>(events: readonly EngineEvent[], type: T, from = 0): EventOf<T>[] =>
  events.slice(from).filter((event): event is EventOf<T> => event.type === type);

const engine = (app: Application): EngineState => app.page.engineState.getState();
const revision = (app: Application): number => app.page.doc.getState().engineRevision;

/** land → soft → scree, shown; steep and paint beside the view. */
function terrain(app: Application): Record<'land' | 'soft' | 'scree' | 'steep' | 'paint', string> {
  const { page } = app;
  applySettings(page);
  const land = page.add('ref/fbm', { octaves: 4 });
  const soft = page.add('ref/blur', {}, { in: `${land}.out` });
  const scree = page.add('ref/talus', {}, { in: `${soft}.out` });
  const steep = page.add('ref/slope-mask', { slopeMin: 4, slopeMax: 12 }, { in: `${scree}.out` });
  const paint = page.add('ref/colorize', {}, { in: `${land}.out` });
  return { land, soft, scree, steep, paint };
}

test('a document edit reaches the engine, and what the engine makes of it reaches the store', async () => {
  const app = await startApplication();
  try {
    const { page, client } = app;
    assert.equal(engine(app).device.state, 'starting');
    await until(() => engine(app).device.state === 'ready', 'the device is ready');
    assert.equal(engine(app).device.caps!.limits.maxTextureDimension2D >= 8192, true);
    await app.settled();
    assert.deepEqual(engine(app).view, { revision: 0, resolution: 1009, draft: false }, 'the empty document the client introduced is shown as nothing');

    const ids = terrain(app);
    showHeight(page, ids.scree);
    await app.settled();

    // The document the engine evaluated is the one in the store, at its revision.
    const shown = engine(app);
    assert.deepEqual(shown.view, { revision: revision(app), resolution: PREVIEW, draft: false });
    assert.equal(shown.evaluation, null);
    assert.deepEqual(nodeStates(shown, ids), { land: 'done', soft: 'done', scree: 'done', steep: 'none', paint: 'none' }, 'nothing asked for the nodes beside the view');
    assert.deepEqual(Object.keys(shown.keys).sort(), Object.values(ids).sort(), 'a content key for every node of the document');
    assert.ok(shown.memory !== null && shown.memory.cacheBytes > 0, 'the result is in the cache');
    for (const name of ['land', 'soft', 'scree'] as const) {
      const node = shown.nodes[ids[name]]!;
      assert.deepEqual([node.requestId, node.cached, node.fraction, node.error], [shown.viewRequestId, false, 1, null], name);
      assert.ok(typeof node.wallMs === 'number' && node.wallMs >= 0 && typeof node.peakBytes === 'number' && node.peakBytes > 0, name);
    }

    // The port's content, read on the engine's side: a terrain, not a constant.
    const before = (await client.inspect({ node: ids.scree, port: 'out' }))!;
    assert.ok(before.nonFinite === 0 && before.min < before.mean && before.mean < before.max, JSON.stringify(before));

    // An edit: a new revision, new keys from the edited node on, and another terrain.
    const keys = shown.keys;
    page.doc.getState().transact('Fbm: Feature size', (draft) => setParam(draft, REGISTRY, ids.land, 'size', 0.6));
    assert.ok(engine(app).view!.revision < revision(app), 'the revision shown is behind: the view is updating');
    await app.settled();
    const edited = engine(app);
    assert.equal(edited.view!.revision, revision(app));
    for (const name of ['land', 'soft', 'scree', 'steep', 'paint'] as const) assert.notEqual(edited.keys[ids[name]], keys[ids[name]], `${name} reads the edited node`);
    const after = (await client.inspect({ node: ids.scree, port: 'out' }))!;
    assert.ok(after.mean !== before.mean || after.max !== before.max, 'the engine evaluated the edited document');

    // Undo: an ordinary change with a new revision. The keys are those before the edit, and what is cached is a hit.
    page.doc.getState().undo();
    await app.settled();
    const undone = engine(app);
    assert.equal(undone.view!.revision, revision(app));
    for (const name of ['land', 'soft', 'scree'] as const) {
      assert.equal(undone.keys[ids[name]], keys[ids[name]], name);
      assert.deepEqual([undone.nodes[ids[name]]!.state, undone.nodes[ids[name]]!.cached], ['done', true], name);
    }
    assert.deepEqual(await client.inspect({ node: ids.scree, port: 'out' }), before, 'the very same field');

    // A node that fails, with the error's details, and the node behind it; a bypass, which the engine is sent as well.
    const broken = page.add('ref/fail', { message: 'Deliberately broken' }, { in: `${ids.land}.out` });
    const behind = page.add('ref/blur', {}, { in: `${broken}.out` });
    showHeight(page, behind);
    await app.settled();
    const failed = engine(app);
    assert.ok(failed.view!.revision < revision(app), 'a view whose target failed is not shown');
    const error = failed.nodes[broken]!.error!;
    assert.deepEqual([failed.nodes[broken]!.state, error.nodeId, error.nodeType, error.kind, error.message], ['error', broken, 'ref/fail', 'node-exception', 'Deliberately broken']);
    assert.deepEqual([failed.nodes[behind]!.state, failed.nodes[behind]!.upstream], ['skipped', broken]);
    page.doc.getState().transact('Bypass Fail', (draft) => setNodeFlags(draft, broken, { bypass: true }));
    await app.settled();
    assert.deepEqual([engine(app).view!.revision, engine(app).nodes[broken]!.state, engine(app).nodes[behind]!.state], [revision(app), 'done', 'done']);

    // What the page received is what the session emitted, event for event.
    assert.equal(app.received.length, app.worker.emitted.length);
    for (let i = 0; i < app.received.length; i++) assert.equal(app.received[i]!.type, app.worker.emitted[i]!.type, `event ${i}`);
  } finally {
    await app.close();
  }
});

test('a gesture: every step of a scrub is shown as a draft, the release in full, and the scrub is one undo', async () => {
  const app = await startApplication();
  try {
    const { page } = app;
    const ids = terrain(app);
    showHeight(page, ids.scree);
    await app.settled();
    const keys = engine(app).keys;
    const entries = page.doc.getState().past.length;
    const from = app.received.length;

    const key = `param:${ids.land}:size`;
    page.doc.getState().beginGesture(key);
    for (const size of [0.3, 0.4, 0.5]) {
      page.doc.getState().transact('Fbm: Feature size', (draft) => setParam(draft, REGISTRY, ids.land, 'size', size), { mergeKey: key });
      await app.settled();
      assert.deepEqual(engine(app).view, { revision: revision(app), resolution: DRAFT, draft: true }, `the step to ${size} is shown coarser than the preview`);
      assert.deepEqual(nodeStates(engine(app), { land: ids.land, scree: ids.scree }), { land: 'done', scree: 'done' });
    }
    page.doc.getState().endGesture();
    await app.settled();
    assert.deepEqual(engine(app).view, { revision: revision(app), resolution: PREVIEW, draft: false }, 'the release is refined at the preview resolution');

    // Three drafts, then one full evaluation of the last revision; nothing else was asked of the engine for the view.
    const requests = of(app.received, 'request-start', from).filter((event) => event.purpose !== 'thumbnails');
    assert.deepEqual(requests.map((event) => event.purpose), ['draft', 'draft', 'draft', 'view']);
    assert.deepEqual(requests.map((event) => event.revision), [revision(app) - 2, revision(app) - 1, revision(app), revision(app)]);

    assert.equal(page.doc.getState().past.length, entries + 1, 'one entry for the whole scrub');
    page.doc.getState().undo();
    await app.settled();
    assert.equal(page.doc.getState().doc.nodes[ids.land]!.params.size, 0.25);
    assert.deepEqual(engine(app).view, { revision: revision(app), resolution: PREVIEW, draft: false });
    assert.equal(engine(app).keys[ids.scree], keys[ids.scree], 'the keys before the scrub');
  } finally {
    await app.close();
  }
});

test('a view change: the view follows the selection, a mask is laid over the terrain, a locked view stays, and a cleared one shows nothing', async () => {
  const app = await startApplication();
  try {
    const { page } = app;
    const ids = terrain(app);
    const context = { doc: page.doc, ui: page.ui, registry: REGISTRY };

    selectNodes(context, [ids.scree]);
    await app.settled();
    assert.deepEqual(page.doc.getState().doc.ui.view, { height: { node: ids.scree, port: 'out' } });
    let updated = of(app.received, 'view-updated').at(-1)!;
    assert.deepEqual([updated.revision, updated.height, updated.overlay, updated.resolution], [revision(app), true, false, PREVIEW]);

    // The mask of the slopes over the terrain: both from one evaluation, which runs the one node that was missing.
    const from = app.received.length;
    selectNodes(context, [ids.steep]);
    await app.settled();
    updated = of(app.received, 'view-updated').at(-1)!;
    assert.deepEqual([updated.revision, updated.height, updated.overlay], [revision(app), true, true]);
    const plan = of(app.received, 'eval-start', from)[0]!.plan;
    assert.deepEqual(plan.filter((node) => node.state === 'run').map((node) => node.nodeId), [ids.steep]);
    assert.deepEqual([engine(app).nodes[ids.steep]!.state, engine(app).nodes[ids.steep]!.requestId], ['done', engine(app).viewRequestId]);
    assert.equal(page.doc.getState().past.length, 6, 'a view change is no undo step: the history holds the settings and the five nodes');

    // Locked: the selection moves, the view does not, and the engine is sent nothing.
    page.doc.getState().transact('Lock view', (draft) => setView(draft, { ...page.doc.getState().doc.ui.view, locked: true }), { undoable: false });
    await app.settled();
    const locked = revision(app);
    const views = of(app.received, 'view-updated').length;
    selectNodes(context, [ids.land]);
    selectNodes(context, [ids.paint]);
    await app.settled();
    assert.deepEqual([revision(app), of(app.received, 'view-updated').length, page.ui.getState().selection], [locked, views, [ids.paint]]);

    // Cleared: nothing is shown, under the revision that cleared it.
    page.doc.getState().transact('Clear view', (draft) => setView(draft, null), { undoable: false });
    await app.settled();
    updated = of(app.received, 'view-updated').at(-1)!;
    assert.deepEqual([updated.revision, updated.height, updated.overlay], [revision(app), false, false]);
    assert.deepEqual(engine(app).view, { revision: revision(app), resolution: PREVIEW, draft: false });
  } finally {
    await app.close();
  }
});

test('thumbnails: the nodes of the view get theirs as a by-product, the others from idle evaluations, and the pixels arrive in the cache', async () => {
  // What the session is told its nodes took (testing.md 8.3): `slow` five seconds, too long to run for a thumbnail
  // alone (7.3 rule 9); every other node a millisecond. A node without a timing would be given the median of the others.
  const slow = new Set<string>();
  const app = await startApplication({ lastTiming: (nodeId) => ({ resolution: THUMBNAIL, wallMs: slow.has(nodeId) ? 5000 : 1 }) });
  try {
    const { page, client } = app;
    const ids = terrain(app);
    const side = page.add('ref/talus', { talus: 20 }, { in: `${ids.soft}.out` });
    const beyond = page.add('ref/slope-mask', {}, { in: `${side}.out` });
    slow.add(side);
    const drawn: string[] = [];
    page.thumbnails.subscribe(ids.paint, () => drawn.push(page.thumbnails.get(ids.paint)!.contentKey));

    // The view first: its three nodes get their thumbnails as a by-product, whatever list the graph has asked for.
    showHeight(page, ids.scree);
    await app.settled();
    await app.thumbnailsOf([ids.land, ids.soft, ids.scree], PREVIEW);
    assert.ok(page.thumbnails.get(ids.steep) === null && page.thumbnails.get(ids.paint) === null, 'nothing was asked for the nodes beside the view');

    // Then the list: the session evaluates what is stale when it has nothing else to do, at the thumbnail resolution.
    client.requestThumbnails([...Object.values(ids), side, beyond]);
    await app.thumbnailsOf(Object.values(ids), THUMBNAIL);
    await app.settled();
    const state = engine(app);

    // Every node the engine could make a thumbnail of has a current one: its key is the key of the document.
    for (const name of ['land', 'soft', 'scree', 'steep', 'paint'] as const) {
      const entry = page.thumbnails.get(ids[name]);
      assert.ok(entry !== null, `${name} has a thumbnail`);
      assert.equal(entry.contentKey, state.keys[ids[name]], `the thumbnail of ${name} is of the document as it is`);
      assert.equal(state.thumbnailKeys[ids[name]], state.keys[ids[name]], `${name} is not stale in the store`);
      const pixels = (entry.image as unknown as { data: Uint8ClampedArray }).data;
      assert.equal(pixels.length, 128 * 128 * 4);
      let opaque = 0, levels = new Set<number>();
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] === 255) opaque++;
        levels.add(pixels[i]!);
      }
      assert.equal(opaque, 128 * 128, `the thumbnail of ${name} is opaque`);
      assert.ok(levels.size > 8, `the thumbnail of ${name} is a picture: ${levels.size} levels of red`);
    }
    assert.deepEqual(drawn.at(-1), state.keys[ids.paint], 'a subscriber of the node heard of its image');
    // The pixels were moved off the engine's side.
    assert.ok(of(app.worker.emitted, 'thumbnail').every((event) => event.rgba.byteLength === 0));
    assert.ok(of(app.received, 'thumbnail').every((event) => event.rgba.byteLength === 128 * 128 * 4));

    // The slow node and the node that reads it were left to a view evaluation: no thumbnail, stale, and never run.
    for (const id of [side, beyond]) {
      assert.ok(page.thumbnails.get(id) === null);
      assert.notEqual(state.thumbnailKeys[id], state.keys[id]);
      assert.equal(state.nodes[id]!.state, 'idle', 'the idle evaluation that held it was aborted before its first node');
    }
    // Two idle evaluations were aborted for the slow node, which is cached nowhere (runtime.md 7.3 rules 9 and 10): the
    // one at the thumbnail resolution, and the try at the preview resolution, where a view would have left it cached.
    const aborted = of(app.received, 'eval-end').filter((event) => event.status === 'aborted');
    assert.equal(aborted.length, 2, 'the thumbnail evaluation and its try at the preview resolution were aborted for the slow node');
    const purposes = new Map(of(app.received, 'request-start').map((event) => [event.requestId, event.purpose]));
    assert.deepEqual(aborted.map((event) => purposes.get(event.requestId)), ['thumbnails', 'thumbnails']);

    // That evaluation named the nodes of the view too, and ran none of them: they are what the view request left them.
    const skipped = of(app.received, 'node-skipped').filter((event) => event.requestId === aborted[0]!.requestId).map((event) => event.nodeId);
    assert.ok(skipped.includes(ids.land) && skipped.includes(ids.soft), 'the aborted evaluation reported on nodes of the view');
    for (const name of ['land', 'soft', 'scree'] as const) {
      assert.deepEqual([state.nodes[ids[name]]!.state, state.nodes[ids[name]]!.requestId], ['done', state.viewRequestId], name);
    }
    assert.ok(state.nodes[ids.paint]!.requestId > state.viewRequestId!, 'a node outside the view is reported by the thumbnails request');
    assert.equal(state.nodes[ids.paint]!.state, 'done');

    // An edit makes the thumbnails stale until the new ones arrive.
    page.doc.getState().transact('Fbm: Octaves', (draft) => setParam(draft, REGISTRY, ids.land, 'octaves', 6));
    await until(() => engine(app).keys[ids.land] !== state.keys[ids.land], 'the keys of the edited document arrived');
    const cached = page.thumbnails.get(ids.paint)!;
    if (engine(app).thumbnailKeys[ids.paint] !== engine(app).keys[ids.paint]) assert.equal(cached.contentKey, state.keys[ids.paint], 'the cache still holds the image of the document before');
    await app.thumbnailsOf(Object.values(ids), THUMBNAIL);
    for (const name of ['land', 'scree', 'paint'] as const) {
      assert.equal(engine(app).thumbnailKeys[ids[name]], engine(app).keys[ids[name]], name);
      assert.notEqual(engine(app).keys[ids[name]], state.keys[ids[name]], name);
    }
    assert.ok(drawn.length >= 2);
  } finally {
    await app.close();
  }
});

test('a build with the injected build function: its progress, plan and result in the store, its files in the sink', async () => {
  const app = await startApplication();
  try {
    const { page, client, worker } = app;
    const ids = terrain(app);
    const outland = page.add('io/export-landscape', { name: 'Client Test', dither: false }, { in: `${ids.scree}.out` });
    const outrock = page.add('io/export-layer', { layer: 'Rock' }, { in: `${ids.steep}.out` });
    showHeight(page, ids.scree);
    await app.settled();
    assert.deepEqual(engine(app).build, INITIAL_ENGINE_STATE.build);

    // What the store said while the build ran.
    const seen: { running: boolean; purpose: string | null; phase: string | null; target: number | null }[] = [];
    const off = page.engineState.subscribe((state, previous) => {
      if (state.build === previous.build && state.evaluation?.purpose === previous.evaluation?.purpose) return;
      seen.push({ running: state.build.running, purpose: state.evaluation?.purpose ?? null, phase: state.build.phase, target: state.build.target?.index ?? null });
    });
    const from = app.received.length;
    const doc = page.doc.getState().doc;
    const building = client.build({ doc, outDir: '/out/client-test' });
    await assert.rejects(client.build({ doc, outDir: '/out/other' }), /A build is already running/);
    const result = await building;
    await app.settled();
    off();

    assert.deepEqual([result.status, result.problems, result.manifest, result.report], ['ok', [], 'ClientTest.orogen.json', 'ClientTest.report.json']);
    const state = engine(app);
    const plan = state.build.plan!;
    assert.deepEqual([state.build.running, state.build.lastStatus, state.build.phase, state.build.fraction, state.build.problems], [false, 'ok', 'commit', 1, []]);
    assert.deepEqual(state.build.result, result, 'the result of the call is the result in the store');
    assert.deepEqual([plan.ok, plan.resolution, plan.name, plan.items.map((entry) => entry.nodeId)], [true, 241, 'ClientTest', [outland, outrock]]);
    assert.deepEqual(state.build.target, { index: 1, count: 2, nodeId: outrock, label: state.build.target!.label });

    // The build function the session was given wrote into the sink of the test: the files of the result, and the report.
    assert.equal(worker.sinks.length, 1);
    const written = [...worker.sinks[0]!.files.keys()].sort();
    assert.deepEqual(written, [...result.files.map((file) => file.path), 'ClientTest.report.json'].sort());
    for (const file of result.files) assert.equal(worker.sinks[0]!.files.get(file.path)!.length, file.bytes, file.path);
    assert.deepEqual(result.files.map((file) => file.path), plan.files.map((file) => file.path));

    // The store while it ran: running from build-start to build-end, the evaluation one for a build, both targets, and the commit.
    assert.deepEqual(seen[0], { running: false, purpose: 'build', phase: null, target: null }, 'request-start says what the evaluation is for');
    assert.ok(seen.some((s) => s.running && s.purpose === 'build' && s.target === 0) && seen.some((s) => s.running && s.target === 1), JSON.stringify(seen));
    assert.ok(seen.some((s) => s.running && s.phase === 'commit'));
    assert.equal(seen.filter((s) => s.running).length > 4, true);
    assert.ok(seen.filter((s) => s.running).every((s) => s.purpose === 'build'), 'while a build runs, the evaluation of the store is the build\'s');
    assert.deepEqual(seen.at(-1)!.running, false);

    // The order of the stream (7.6): request-start, build-start, the plan, the evaluation, the result, build-end; then the preview again.
    const types = app.received.slice(from).map((event) => event.type).filter((type) => type.startsWith('build-') || type === 'request-start' || type === 'eval-start' || type === 'eval-end' || type === 'view-updated');
    assert.deepEqual(types.filter((type) => type !== 'build-target' && type !== 'build-progress'), [
      'request-start', 'build-start', 'build-plan', 'eval-start', 'eval-end', 'build-result', 'build-end', 'request-start', 'eval-start', 'eval-end', 'view-updated',
    ]);
    assert.deepEqual([state.evaluation, state.view!.revision], [null, revision(app)], 'the view is shown again after the build');
    assert.deepEqual([state.nodes[ids.scree]!.state, state.nodes[ids.scree]!.requestId], ['done', state.viewRequestId]);

    // A build that is cancelled: the two messages arrive in order, so the build is aborted whatever it had begun.
    const begun = new Promise<EngineState['build']>((resolve) => {
      const stop = page.engineState.subscribe((next) => {
        if (!next.build.running) return;
        stop();
        resolve(next.build);
      });
    });
    const second = client.build({ doc, outDir: '/out/client-test' });
    client.cancelBuild();
    const atStart = await begun;
    assert.deepEqual(atStart, { ...INITIAL_ENGINE_STATE.build, running: true, requestId: atStart.requestId }, 'build-start reset what the first build had left');
    assert.ok(atStart.requestId! > result.requestId);
    const cancelled = await second;
    await app.settled();
    assert.deepEqual([cancelled.status, cancelled.files.length], ['aborted', 0]);
    assert.deepEqual([engine(app).build.running, engine(app).build.lastStatus, engine(app).build.result?.status], [false, 'aborted', 'aborted']);
    assert.deepEqual([engine(app).evaluation, engine(app).view!.revision, engine(app).nodes[ids.scree]!.state], [null, revision(app), 'done'], 'and the preview is back');
    assert.equal(worker.sinks.length, 2);
    assert.equal(worker.sinks[1]!.files.has('ClientTest.orogen.json'), false, 'a cancelled build leaves no manifest');
  } finally {
    await app.close();
  }
});

test('a new worker: the client moves to it, tells it everything again, and the page goes on where it was', async () => {
  const app = await startApplication();
  let second: Awaited<ReturnType<typeof startWorkerEnd>> | null = null;
  try {
    const { page, client } = app;
    const ids = terrain(app);
    client.requestThumbnails(Object.values(ids));
    showHeight(page, ids.scree);
    await app.thumbnailsOf(Object.values(ids), THUMBNAIL);
    await app.settled();
    const before = engine(app);
    const statsBefore = await client.inspect({ node: ids.scree, port: 'out' });
    const images = new Map(Object.values(ids).map((id) => [id, page.thumbnails.get(id)]));
    assert.ok([...images.values()].every((entry) => entry !== null));

    // The worker is gone, with its session, its engine and its end of the channel.
    await app.worker.close();
    const unanswered = client.inspect({ node: ids.scree, port: 'out' });
    // The page goes on editing while there is no engine.
    page.doc.getState().transact('Fbm: Octaves', (draft) => setParam(draft, REGISTRY, ids.land, 'octaves', 6));
    page.doc.getState().undo();
    const sent = revision(app);
    assert.ok(sent > before.view!.revision);

    second = await startWorkerEnd();
    const worker = second;
    const base = app.received.length;
    client.connect(worker.port);
    await assert.rejects(unanswered, /The engine worker was replaced/);
    assert.deepEqual(engine(app), INITIAL_ENGINE_STATE, 'the store starts over with the new session');

    /** As Application.settled, for the worker the client has moved to. */
    const settled = async (): Promise<void> => {
      await client.viewport.pick(0, 0);
      await worker.idle();
      await until(() => app.received.length - base === worker.emitted.length, 'every event of the new worker arrived');
    };
    await settled();
    const after = engine(app);
    assert.equal(after.device.state, 'ready');
    assert.deepEqual(after.view, { revision: sent, resolution: PREVIEW, draft: false });
    assert.deepEqual(nodeStates(after, ids), { land: 'done', soft: 'done', scree: 'done', steep: 'done', paint: 'done' }, 'the thumbnail list was told again: the nodes beside the view were evaluated');
    for (const name of ['land', 'soft', 'scree'] as const) assert.equal(after.nodes[ids[name]]!.cached, false, `${name} ran on the new engine: nothing was cached there`);
    // The same document gives the same keys and the same field on another engine.
    for (const id of Object.values(ids)) assert.equal(after.keys[id], before.keys[id]);
    assert.deepEqual(await client.inspect({ node: ids.scree, port: 'out' }), statsBefore);
    // The new engine delivers thumbnails of its own: the cache comes to hold new images for the same keys.
    await until(() => Object.values(ids).every((id) => page.thumbnails.get(id) !== images.get(id)), 'the thumbnails of the new engine arrived');
    await app.thumbnailsOf(Object.values(ids), THUMBNAIL);
    for (const id of Object.values(ids)) assert.equal(page.thumbnails.get(id)!.contentKey, before.keys[id]);

    // And the page's edits reach the new engine as they reached the old one.
    page.doc.getState().transact('Fbm: Feature size', (draft) => setParam(draft, REGISTRY, ids.land, 'size', 0.5));
    await settled();
    assert.deepEqual(engine(app).view, { revision: revision(app), resolution: PREVIEW, draft: false });
    assert.notEqual(engine(app).keys[ids.scree], before.keys[ids.scree]);
    // The client ends through the worker it is on.
    await client.dispose();
  } finally {
    await app.close();
    await second?.close();
  }
});
