// engineStore (runtime.md 8.5): the state as a reduction of EngineEvents. First against the two recordings of a
// real session in ../assets/ (made by ../record.ts), where the state at each mark is what the session had done by
// then; then, event by event, against streams written here for the rules a recording does not reach.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BuildPlan, BuildProblem, BuildResult, EngineEvent, GpuCaps, NodeError } from '../../../../src/core/runtime.ts';
import {
  applyEngineEvent, createEngineStore, INITIAL_ENGINE_STATE, reduceEngineEvent, reduceEngineEvents,
  type EngineState, type NodeRuntime,
} from '../../../../src/app/state/engine-store.ts';
import { difference, DRAFT, PREVIEW, same } from './_page.ts';
import { loadRecording, stateAt, stateAtMark, type Recording } from './_recording.ts';

const editing = loadRecording('editing');
const build = loadRecording('build');

const node = (state: EngineState, id: string): NodeRuntime | undefined => (Object.hasOwn(state.nodes, id) ? state.nodes[id] : undefined);
/** The state of each named node: 'none' for a node nothing was reported of. */
function states(state: EngineState, recording: Recording, names: readonly string[]): string[] {
  return names.map((name) => node(state, recording.ids[name]!)?.state ?? 'none');
}

// ---- the recordings: the same events give the same state ---------------------------------------------------------------

for (const [name, recording] of [['editing', editing], ['build', build]] as const) {
  test(`${name}: the state is reproducible from the recorded events, by whatever way they are fed`, () => {
    assert.ok(recording.events.length > 100, 'the recording holds a session, not a stub');
    const once = reduceEngineEvents(recording.events);
    assert.equal(difference(once, reduceEngineEvents(recording.events)), null, 'twice the same');
    assert.equal(difference(INITIAL_ENGINE_STATE, reduceEngineEvents([])), null, 'the reduction does not write into the initial state');

    // Through a store, as EngineClient feeds it.
    const store = createEngineStore();
    let notified = 0;
    store.subscribe(() => { notified++; });
    for (const event of recording.events) applyEngineEvent(store, event);
    assert.equal(difference(store.getState(), once), null);
    assert.ok(notified > 0 && notified <= recording.events.length, 'an event that changes nothing tells nobody');

    // From any point on, the state so far and the events that follow are all that counts: the state is copied
    // as JSON at every step, so nothing the reducer could have kept beside it survives.
    let state = INITIAL_ENGINE_STATE;
    for (const event of recording.events) state = reduceEngineEvent(JSON.parse(JSON.stringify(state)) as EngineState, event);
    assert.equal(difference(state, once), null, 'no memory but the state');
  });

  test(`${name}: what holds after every event of the recording`, () => {
    let state = INITIAL_ENGINE_STATE;
    const requests = new Map<string, number>();
    let viewRequest = 0;
    recording.events.forEach((event, i) => {
      const before = state;
      const text = JSON.stringify(before);
      state = reduceEngineEvent(state, event);
      const where = `after event ${i} (${event.type})`;
      assert.ok(JSON.stringify(before) === text, `the state before is not written into, ${where}`);
      if (state.evaluation === null) {
        const running = Object.entries(state.nodes).filter(([, n]) => n.state === 'running').map(([id]) => id);
        assert.deepEqual(running, [], `no evaluation, so no node is running, ${where}`);
      } else {
        assert.ok(state.evaluation.fraction >= 0 && state.evaluation.fraction <= 1, where);
      }
      for (const [id, n] of Object.entries(state.nodes)) {
        assert.ok(n.fraction >= 0 && n.fraction <= 1, where);
        assert.ok(n.requestId >= (requests.get(id) ?? 0), `the request that reported on a node never goes back, ${where}`);
        requests.set(id, n.requestId);
        assert.equal(n.error !== null, n.state === 'error', where);
        if (n.upstream !== null) assert.equal(n.state, 'skipped', where);
      }
      assert.ok((state.viewRequestId ?? 0) >= viewRequest, where);
      viewRequest = state.viewRequestId ?? 0;
      if (state.build.running) assert.notEqual(state.build.requestId, null, where);
    });
    assert.equal(state.evaluation, null, 'the recording ends at rest');
  });
}

// ---- the recording of editing --------------------------------------------------------------------------------------------

test('editing: the device is ready, and an empty document is shown as nothing at its revision', () => {
  const state = stateAtMark(editing, 'ready');
  assert.equal(state.device.state, 'ready');
  assert.equal(state.device.message, null);
  const caps = state.device.caps as GpuCaps;
  assert.deepEqual([typeof caps.adapter.vendor, caps.limits.maxTextureDimension2D >= 8192, Array.isArray(caps.features)], ['string', true, true], 'the capabilities of the device the session runs on');
  assert.deepEqual(state.view, { revision: 0, resolution: 1009, draft: false }, 'the default project previews at 1009');
  assert.deepEqual([state.evaluation, Object.keys(state.nodes).length, Object.keys(state.keys).length], [null, 0, 0]);
  assert.ok(state.memory !== null && state.memory.budgetBytes > 0);
  assert.equal('type' in state.memory, false, 'the memory report is the event without its type');
});

test('editing: without a view, idle evaluations report on the nodes: done, failed with the error, skipped for the failed node', () => {
  const mark = editing.marks.built!;
  const state = stateAtMark(editing, 'built');
  const { ids } = editing;
  assert.equal(state.view?.revision, mark.engineRevision, 'nothing is shown, at the revision the engine has');
  assert.deepEqual(states(state, editing, ['land', 'soft', 'scree', 'steep', 'paint', 'broken', 'after', 'lonely']),
    ['done', 'done', 'done', 'done', 'done', 'error', 'skipped', 'none']);

  // Errors with their details.
  const error = node(state, ids.broken!)!.error as NodeError;
  assert.deepEqual([error.nodeId, error.nodeType, error.kind, error.message], [ids.broken, 'ref/fail', 'node-exception', 'Recorded failure']);
  assert.equal(typeof error.detail, 'string', 'the stack travels with the error');
  assert.deepEqual([node(state, ids.after!)!.upstream, node(state, ids.after!)!.error], [ids.broken, null]);

  // A node that ran has its time and its memory; nothing is running.
  const land = node(state, ids.land!)!;
  assert.deepEqual([land.cached, land.fraction, land.label, land.etaMs, land.error, land.upstream], [false, 1, null, null, null, null]);
  assert.ok(typeof land.wallMs === 'number' && land.wallMs >= 0 && typeof land.peakBytes === 'number' && land.peakBytes > 0);

  // Keys of the document sent, and which thumbnails are current: `lonely` has no key, a failed node no thumbnail.
  assert.deepEqual(Object.keys(state.keys).sort(), ['land', 'soft', 'scree', 'steep', 'paint', 'broken', 'after'].map((n) => ids[n]!).sort());
  for (const name of ['land', 'soft', 'scree', 'steep', 'paint']) assert.equal(state.thumbnailKeys[ids[name]!], state.keys[ids[name]!], `the thumbnail of ${name} is current`);
  for (const name of ['broken', 'after', 'lonely']) assert.equal(Object.hasOwn(state.thumbnailKeys, ids[name]!), false, `${name} has no thumbnail`);
});

test('editing: a view is shown at the revision sent, and its nodes are those of the view request', () => {
  const mark = editing.marks.shown!;
  const state = stateAtMark(editing, 'shown');
  assert.deepEqual(state.view, { revision: mark.engineRevision, resolution: PREVIEW, draft: false });
  assert.notEqual(state.viewRequestId, null);
  for (const name of ['land', 'soft', 'scree']) {
    const n = node(state, editing.ids[name]!)!;
    assert.deepEqual([n.state, n.requestId, n.cached], ['done', state.viewRequestId, false], name);
  }
  // Inside that evaluation: the request is known by its purpose, and a node is running.
  const start = editing.events.findIndex((e, i) => i >= editing.marks.built!.events && e.type === 'node-start');
  const during = stateAt(editing, start + 1);
  assert.deepEqual([during.evaluation?.purpose, during.evaluation?.requestId], ['view', state.viewRequestId]);
  assert.deepEqual(states(during, editing, ['land', 'soft', 'scree']), ['running', 'idle', 'idle'], 'what the plan will run waits as idle');
  assert.equal(during.view?.revision, editing.marks.built!.engineRevision, 'the revision shown is behind: the view is updating');
});

test('editing: during a gesture every step is shown as a draft, and the gesture ends on the full result', () => {
  for (const step of ['scrub 0.3', 'scrub 0.35', 'scrub 0.4', 'scrub 0.45']) {
    const state = stateAtMark(editing, step);
    assert.deepEqual(state.view, { revision: editing.marks[step]!.engineRevision, resolution: DRAFT, draft: true }, step);
    assert.deepEqual(states(state, editing, ['land', 'soft', 'scree']), ['done', 'done', 'done'], step);
  }
  const state = stateAtMark(editing, 'scrubbed');
  assert.deepEqual(state.view, { revision: editing.marks.scrubbed!.engineRevision, resolution: PREVIEW, draft: false });
  for (const name of ['land', 'soft', 'scree', 'steep', 'paint']) assert.equal(state.thumbnailKeys[editing.ids[name]!], state.keys[editing.ids[name]!], `the thumbnail of ${name} is current again`);
});

test('editing: an idle thumbnail evaluation says nothing of the nodes the view request reported on', () => {
  const state = stateAtMark(editing, 'scrubbed');
  const { ids } = editing;
  // The recording holds a thumbnails request after the view request that ran the three nodes of the view again, at another resolution.
  const view = state.viewRequestId!;
  const later = editing.events.slice(0, editing.marks.scrubbed!.events)
    .filter((e) => e.type === 'node-done' && e.requestId > view && e.nodeId === ids.land);
  assert.equal(later.length, 1, 'the thumbnails request reported land done');
  for (const name of ['land', 'soft', 'scree']) assert.equal(node(state, ids[name]!)!.requestId, view, `${name} keeps the record of the view`);
  // The nodes outside the view have only the thumbnails request to speak for them.
  for (const name of ['steep', 'paint', 'broken', 'after']) assert.ok(node(state, ids[name]!)!.requestId > view, name);
  assert.deepEqual(states(state, editing, ['steep', 'paint', 'broken', 'after']), ['done', 'done', 'error', 'skipped']);
});

test('editing: an overlay joins the view; a view whose target failed is not shown, and the error says why', () => {
  const overlay = stateAtMark(editing, 'overlay');
  assert.equal(overlay.view?.revision, editing.marks.overlay!.engineRevision);
  assert.deepEqual([node(overlay, editing.ids.steep!)!.state, node(overlay, editing.ids.steep!)!.requestId], ['done', overlay.viewRequestId]);

  const failed = stateAtMark(editing, 'failed view');
  assert.equal(failed.view?.revision, editing.marks.overlay!.engineRevision, 'the view shown is still the one before');
  assert.ok(failed.view!.revision < editing.marks['failed view']!.engineRevision);
  assert.equal(failed.evaluation, null);
  const broken = node(failed, editing.ids.broken!)!;
  assert.deepEqual([broken.state, broken.requestId, broken.error?.message], ['error', failed.viewRequestId, 'Recorded failure']);
  assert.deepEqual([node(failed, editing.ids.after!)!.state, node(failed, editing.ids.after!)!.upstream], ['skipped', editing.ids.broken]);
});

test('editing: a node that did not run is cached and keeps the time of its last run', () => {
  const bypassed = stateAtMark(editing, 'bypassed');
  const { ids } = editing;
  assert.deepEqual([node(bypassed, ids.soft!)!.state, node(bypassed, ids.soft!)!.cached], ['done', true], 'a bypassed node is done without running');
  assert.deepEqual([node(bypassed, ids.scree!)!.state, node(bypassed, ids.scree!)!.cached], ['done', false], 'the node behind it ran on other input');

  const undone = stateAtMark(editing, 'bypass undone');
  assert.equal(undone.view?.revision, editing.marks['bypass undone']!.engineRevision);
  for (const name of ['land', 'soft', 'scree']) {
    const n = node(undone, ids[name]!)!;
    assert.deepEqual([n.state, n.cached, n.requestId], ['done', true, undone.viewRequestId], `${name}: undo restored the keys, and the cache had them`);
    assert.ok(typeof n.wallMs === 'number' && typeof n.peakBytes === 'number', `${name} still says what its run took`);
  }
  // The keys after the undo are the keys before the bypass.
  const before = stateAtMark(editing, 'failed view');
  for (const name of ['land', 'soft', 'scree', 'steep']) assert.equal(undone.keys[ids[name]!], before.keys[ids[name]!], name);
  assert.notEqual(bypassed.keys[ids.scree!], before.keys[ids.scree!], 'a bypass upstream changes the key');
});

test('editing: a cleared view is shown as nothing, and the nodes keep what is known of them', () => {
  const state = stateAtMark(editing, 'nothing shown');
  assert.deepEqual(state.view, { revision: editing.marks['nothing shown']!.engineRevision, resolution: PREVIEW, draft: false });
  assert.deepEqual(states(state, editing, ['land', 'soft', 'scree', 'steep', 'broken', 'after']), ['done', 'done', 'done', 'done', 'error', 'skipped']);
  // The request that showed nothing reported on no node: from here on a thumbnails request speaks for all of them.
  assert.ok(Object.values(state.nodes).every((n) => n.requestId < state.viewRequestId!));
});

// ---- the recording of builds ---------------------------------------------------------------------------------------------

test('build: a build that writes its files, from start to end', () => {
  const start = build.events.findIndex((e) => e.type === 'build-start');
  const requestId = (build.events[start] as Extract<EngineEvent, { type: 'build-start' }>).requestId;

  const begun = stateAt(build, start + 1);
  assert.deepEqual(begun.build, { running: true, requestId, plan: null, target: null, phase: null, fraction: 0, problems: [], result: null, lastStatus: null });
  assert.deepEqual([begun.evaluation?.purpose, begun.evaluation?.requestId, begun.viewRequestId], ['build', requestId, requestId]);

  // While it evaluates, the nodes of the build's plan are reported under the build's request, at the build resolution.
  const target = build.events.findIndex((e) => e.type === 'build-target');
  const during = stateAt(build, target + 1);
  assert.deepEqual([during.build.running, during.build.plan !== null, during.build.target?.index, during.build.target?.count], [true, true, 0, 2]);
  assert.equal(during.build.target?.nodeId, build.ids.outland);
  assert.deepEqual([node(during, build.ids.scree!)!.state, node(during, build.ids.scree!)!.requestId], ['done', requestId]);

  const state = stateAtMark(build, 'built');
  const plan = state.build.plan as BuildPlan;
  const result = state.build.result as BuildResult;
  assert.deepEqual([state.build.running, state.build.requestId, state.build.lastStatus, state.build.phase, state.build.fraction], [false, requestId, 'ok', 'commit', 1]);
  assert.deepEqual([plan.ok, plan.resolution, plan.name], [true, 241, 'Recorded']);
  assert.deepEqual(state.build.target, { index: 1, count: 2, nodeId: build.ids.outrock, label: state.build.target!.label });
  assert.deepEqual(state.build.problems, []);
  assert.deepEqual([result.status, result.requestId, result.manifest], ['ok', requestId, 'Recorded.orogen.json']);
  assert.deepEqual(result.files.map((f) => f.path), plan.files.map((f) => f.path), 'what the build wrote is what it planned');

  // The evaluation of a build is over long before the build is: the request stays the store's evaluation until build-end.
  const evaluated = build.events.findIndex((e) => e.type === 'eval-end' && e.requestId === requestId);
  const ending = build.events.findIndex((e) => e.type === 'build-end' && e.requestId === requestId);
  assert.ok(evaluated > start && ending > evaluated + 1, 'the build converts and writes after its evaluation');
  for (let count = start + 1; count <= ending; count++) {
    const at = stateAt(build, count);
    assert.deepEqual([at.build.running, at.evaluation?.purpose, at.evaluation?.requestId], [true, 'build', requestId], `after event ${count - 1}`);
  }
  assert.deepEqual([stateAt(build, ending + 1).build.running, stateAt(build, ending + 1).evaluation], [false, null]);

  // The preview came back after the build: the view is shown again by a request of its own.
  assert.equal(state.evaluation, null);
  assert.ok(state.viewRequestId! > requestId);
  assert.deepEqual([node(state, build.ids.scree!)!.state, node(state, build.ids.scree!)!.requestId], ['done', state.viewRequestId]);
  assert.deepEqual([node(state, build.ids.rock!)!.state, node(state, build.ids.rock!)!.requestId], ['done', requestId], 'a node only the build evaluated keeps the build\'s report');
});

test('build: a build that is cancelled ends aborted, and what the build before reported is replaced at its start', () => {
  const second = build.events.findIndex((e, i) => i >= build.marks.built!.events && e.type === 'build-start');
  const begun = stateAt(build, second + 1);
  assert.deepEqual([begun.build.running, begun.build.plan, begun.build.result, begun.build.lastStatus, begun.build.fraction], [true, null, null, null, 0]);

  const end = build.events.findIndex((e, i) => i > second && e.type === 'build-end');
  const ended = stateAt(build, end + 1);
  assert.deepEqual([ended.build.running, ended.build.lastStatus, ended.build.result?.status, ended.build.result?.files.length], [false, 'aborted', 'aborted', 0]);
  assert.notEqual(ended.build.plan, null, 'the plan of the cancelled build stays readable');
  // The nodes the aborted evaluation left are idle until the preview that follows reports on them.
  assert.deepEqual(states(ended, build, ['land', 'scree', 'rock']), ['idle', 'idle', 'idle']);
  assert.equal(ended.evaluation, null);

  const state = stateAtMark(build, 'cancelled');
  assert.deepEqual(states(state, build, ['land', 'scree', 'rock']), ['done', 'done', 'idle']);
  assert.deepEqual([state.build.running, state.build.lastStatus], [false, 'aborted']);
});

test('build: a build whose plan has an error ends with its problem and without an evaluation', () => {
  const state = stateAtMark(build, 'nothing to export');
  const plan = state.build.plan as BuildPlan;
  const result = state.build.result as BuildResult;
  assert.deepEqual([state.build.running, state.build.lastStatus, plan.ok, state.build.target, state.build.phase, state.build.fraction], [false, 'errors', false, null, null, 0]);
  assert.deepEqual(result.problems.map((p) => [p.severity, p.code]), [['error', 'E_NOTHING_TO_EXPORT']]);
  assert.deepEqual(plan.problems.map((p) => p.code), ['E_NOTHING_TO_EXPORT']);
  // request-start announced an evaluation that never began: build-end ends it.
  const end = build.events.findLastIndex((e) => e.type === 'build-end');
  assert.equal(stateAt(build, end).evaluation?.purpose, 'build');
  assert.equal(stateAt(build, end + 1).evaluation, null);
});

// ---- streams written here: the rules a recording does not reach ------------------------------------------------------------

/** Capabilities by name only: the reducer passes them on unread. */
const CAPS = { software: false, vramBytes: 1 } as unknown as GpuCaps;
const ERROR: NodeError = { nodeId: 'b', nodeType: 'ref/fail', kind: 'validation', message: 'Bad binding', detail: 'the whole GPU message', kernel: 'ref/fail.pass' };
const plan = (...nodes: [string, 'cached' | 'run' | 'bypassed' | 'blocked' | 'unused'][]): Extract<EngineEvent, { type: 'eval-start' }>['plan'] =>
  nodes.map(([nodeId, state]) => ({ nodeId, state }));
const start = (requestId: number, purpose: 'view' | 'draft' | 'thumbnails' | 'build', ...nodes: [string, 'cached' | 'run' | 'bypassed' | 'blocked' | 'unused'][]): EngineEvent[] => [
  { type: 'request-start', requestId, revision: 1, purpose },
  { type: 'eval-start', requestId, resolution: 257, mode: purpose === 'build' ? 'build' : 'preview', plan: plan(...nodes), outputPeakBytes: null },
];
const done = (requestId: number, nodeId: string, cached = false, wallMs = 12): EngineEvent =>
  ({ type: 'node-done', requestId, nodeId, cached, wallMs: cached ? 0 : wallMs, gpuMs: null, peakBytes: cached ? 0 : 4096 });
const end = (requestId: number, status: 'ok' | 'errors' | 'aborted' | 'device-lost' = 'ok'): EngineEvent => ({ type: 'eval-end', requestId, status, wallMs: 20 });

test('the device: starting, ready, lost with what was shown gone, failed, and ready again', () => {
  let state = INITIAL_ENGINE_STATE;
  assert.deepEqual(state.device, { state: 'starting', caps: null, message: null });
  state = reduceEngineEvents([
    { type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 1 << 30 },
    { type: 'view-updated', requestId: 1, revision: 4, resolution: 257, draft: false, height: true, overlay: false },
  ], state);
  assert.deepEqual([state.device.state, state.device.caps, state.view?.revision], ['ready', CAPS, 4]);

  // An error that is not fatal is no state: the very same object.
  same(reduceEngineEvent(state, { type: 'engine-error', message: 'A slice took 900 ms', fatal: false }), state);

  state = reduceEngineEvent(state, { type: 'device-lost', reason: 'unknown', message: 'The GPU was reset', nodeId: 'a' });
  assert.deepEqual(state.device, { state: 'lost', caps: CAPS, message: 'The GPU was reset' });
  assert.equal(state.view, null, 'nothing is shown on a lost device (7.8 rule 1)');

  state = reduceEngineEvent(state, { type: 'engine-error', message: 'No GPU device could be opened', fatal: true });
  assert.deepEqual(state.device, { state: 'failed', caps: CAPS, message: 'No GPU device could be opened' });

  const caps2 = { software: true, vramBytes: 2 } as unknown as GpuCaps;
  state = reduceEngineEvent(state, { type: 'device-ready', epoch: 2, caps: caps2, budgetBytes: 1 << 30 });
  assert.deepEqual(state.device, { state: 'ready', caps: caps2, message: null });
});

test('a node through one request: idle while it waits, running with its progress, done with its time', () => {
  let state = reduceEngineEvents(start(3, 'view', ['a', 'cached'], ['b', 'run'], ['c', 'blocked'], ['d', 'bypassed'], ['e', 'unused']));
  assert.deepEqual(Object.keys(state.nodes), ['b', 'c'], 'cached, bypassed and unused nodes wait for their node-done as they are');
  assert.deepEqual(state.nodes.b, { requestId: 3, state: 'idle', cached: false, fraction: 0, label: null, etaMs: null, wallMs: null, peakBytes: null, error: null, upstream: null });
  assert.deepEqual(state.evaluation, { requestId: 3, purpose: 'view', fraction: 0, etaMs: null });

  state = reduceEngineEvent(state, { type: 'node-start', requestId: 3, nodeId: 'b' });
  assert.deepEqual([state.nodes.b!.state, state.nodes.b!.fraction], ['running', 0]);
  state = reduceEngineEvent(state, { type: 'node-progress', requestId: 3, nodeId: 'b', fraction: 0.25, label: 'Level 2 of 4', etaMs: null });
  state = reduceEngineEvent(state, { type: 'node-progress', requestId: 3, nodeId: 'b', fraction: 0.5, etaMs: 800 });
  assert.deepEqual([state.nodes.b!.state, state.nodes.b!.fraction, state.nodes.b!.label, state.nodes.b!.etaMs], ['running', 0.5, null, 800], 'a label lasts as long as its event');
  const previewed = reduceEngineEvent(state, { type: 'node-preview', requestId: 3, nodeId: 'b', ports: ['out'] });
  assert.equal(previewed, state, 'a loan is the viewport\'s business');

  state = reduceEngineEvent(state, { type: 'eval-progress', requestId: 3, fraction: 0.4, etaMs: 1500 });
  assert.deepEqual(state.evaluation, { requestId: 3, purpose: 'view', fraction: 0.4, etaMs: 1500 });
  same(reduceEngineEvent(state, { type: 'eval-progress', requestId: 2, fraction: 0.9, etaMs: 1 }), state, 'progress of a request that is not the running one');

  state = reduceEngineEvents([done(3, 'a', true), done(3, 'b', false, 640), { type: 'node-skipped', requestId: 3, nodeId: 'c', reason: 'upstream', upstream: 'x' }, done(3, 'd', true), done(3, 'e', true)], state);
  assert.deepEqual(state.nodes.b, { requestId: 3, state: 'done', cached: false, fraction: 1, label: null, etaMs: null, wallMs: 640, peakBytes: 4096, error: null, upstream: null });
  assert.deepEqual([state.nodes.a!.state, state.nodes.a!.cached, state.nodes.a!.wallMs, state.nodes.a!.peakBytes], ['done', true, null, null], 'a node that was never seen running has no time');
  assert.deepEqual([state.nodes.c!.state, state.nodes.c!.upstream], ['skipped', 'x']);

  same(reduceEngineEvent(state, end(2)), state, 'the end of another request');
  state = reduceEngineEvent(state, end(3));
  assert.equal(state.evaluation, null);
});

test('a failed node holds its error with every detail; a node skipped for an abort or a lost device is idle', () => {
  let state = reduceEngineEvents([...start(5, 'view', ['a', 'run'], ['b', 'run'], ['c', 'run'], ['d', 'run'])]);
  state = reduceEngineEvents([
    done(5, 'a'),
    { type: 'node-start', requestId: 5, nodeId: 'b' },
    { type: 'node-error', requestId: 5, error: ERROR },
    { type: 'node-skipped', requestId: 5, nodeId: 'c', reason: 'aborted' },
    { type: 'node-skipped', requestId: 5, nodeId: 'd', reason: 'device-lost' },
    end(5, 'aborted'),
  ], state);
  assert.deepEqual(state.nodes.b, { requestId: 5, state: 'error', cached: false, fraction: 0, label: null, etaMs: null, wallMs: null, peakBytes: null, error: ERROR, upstream: null });
  assert.equal(state.nodes.b!.error, ERROR, 'the error as the engine sent it');
  for (const id of ['c', 'd']) assert.deepEqual([state.nodes[id]!.state, state.nodes[id]!.requestId, state.nodes[id]!.upstream], ['idle', 5, null], id);

  // The next request clears the error when the node runs through.
  state = reduceEngineEvents([...start(6, 'view', ['a', 'cached'], ['b', 'run']), done(6, 'a', true), { type: 'node-start', requestId: 6, nodeId: 'b' }, done(6, 'b'), end(6)], state);
  assert.deepEqual([state.nodes.b!.state, state.nodes.b!.error, state.nodes.a!.wallMs], ['done', null, 12], 'and a cached node keeps the time of its run');
});

test('the rule of 7.7: an event of a request older than the newest that reported on the node is ignored', () => {
  let state = reduceEngineEvents([...start(8, 'view', ['a', 'run'], ['b', 'run']), { type: 'node-start', requestId: 8, nodeId: 'a' }, done(8, 'a', false, 30)]);
  const late: EngineEvent[] = [
    { type: 'node-start', requestId: 7, nodeId: 'a' },
    { type: 'node-progress', requestId: 7, nodeId: 'a', fraction: 0.5, etaMs: null },
    done(7, 'a', false, 999),
    { type: 'node-error', requestId: 7, error: { ...ERROR, nodeId: 'a' } },
    { type: 'node-skipped', requestId: 7, nodeId: 'a', reason: 'aborted' },
    { type: 'eval-start', requestId: 7, resolution: 257, mode: 'preview', plan: plan(['a', 'run']), outputPeakBytes: null },
  ];
  for (const event of late) {
    const next = reduceEngineEvent(state, event);
    assert.equal(next.nodes.a, state.nodes.a, `${event.type} of request 7 after request 8 reported`);
    state = next;
  }
  assert.deepEqual([state.nodes.a!.requestId, state.nodes.a!.wallMs], [8, 30]);
  // One comparison per node: a node the newer request has not reported on yet still takes the older one's events.
  state = reduceEngineEvent(state, { type: 'node-skipped', requestId: 7, nodeId: 'z', reason: 'upstream', upstream: 'a' });
  assert.deepEqual([state.nodes.z!.state, state.nodes.z!.requestId], ['skipped', 7]);
  // And the same request goes on reporting.
  state = reduceEngineEvent(state, { type: 'node-start', requestId: 8, nodeId: 'b' });
  assert.equal(state.nodes.b!.state, 'running');
});

test('a thumbnails request says nothing of a node the newest view, draft or build request reported on, and everything of the others', () => {
  // The view evaluates a and b; c is outside it.
  let state = reduceEngineEvents([...start(2, 'view', ['a', 'run'], ['b', 'run']), { type: 'node-start', requestId: 2, nodeId: 'a' }, done(2, 'a', false, 700), { type: 'node-start', requestId: 2, nodeId: 'b' }, done(2, 'b', false, 900), end(2)]);
  assert.equal(state.viewRequestId, 2);
  const shown = state.nodes;

  // An idle evaluation that the session aborts before its first node, because one is too slow (7.3 rule 9).
  state = reduceEngineEvents([
    ...start(3, 'thumbnails', ['a', 'run'], ['b', 'run'], ['c', 'run']),
    { type: 'node-skipped', requestId: 3, nodeId: 'a', reason: 'aborted' },
    { type: 'node-skipped', requestId: 3, nodeId: 'b', reason: 'aborted' },
    { type: 'node-skipped', requestId: 3, nodeId: 'c', reason: 'aborted' },
    end(3, 'aborted'),
  ], state);
  assert.equal(state.viewRequestId, 2, 'a thumbnails request is no request for the view');
  assert.equal(state.nodes.a, shown.a, 'a is what the view made of it: done, 700 ms');
  assert.equal(state.nodes.b, shown.b);
  assert.deepEqual([state.nodes.c!.state, state.nodes.c!.requestId], ['idle', 3]);

  // One that runs: at the thumbnail resolution, with other times, and an error of its own for c.
  state = reduceEngineEvents([
    ...start(4, 'thumbnails', ['a', 'run'], ['b', 'cached'], ['c', 'run']),
    { type: 'node-start', requestId: 4, nodeId: 'a' }, { type: 'node-progress', requestId: 4, nodeId: 'a', fraction: 0.5, etaMs: null }, done(4, 'a', false, 3),
    done(4, 'b', true),
    { type: 'node-start', requestId: 4, nodeId: 'c' }, { type: 'node-error', requestId: 4, error: { ...ERROR, nodeId: 'c' } },
    end(4, 'errors'),
  ], state);
  assert.equal(state.nodes.a, shown.a);
  assert.equal(state.nodes.b, shown.b);
  assert.deepEqual([state.nodes.c!.state, state.nodes.c!.error?.message], ['error', 'Bad binding'], 'a node outside the view shows what the thumbnail evaluation found');

  // The view moves to another branch: a and b are no longer nodes the newest view request reported on.
  state = reduceEngineEvents([...start(5, 'view', ['d', 'run']), { type: 'node-start', requestId: 5, nodeId: 'd' }, done(5, 'd'), end(5)], state);
  state = reduceEngineEvents([...start(6, 'thumbnails', ['a', 'cached'], ['d', 'cached']), done(6, 'a', true), done(6, 'd', true), end(6)], state);
  assert.deepEqual([state.nodes.a!.requestId, state.nodes.a!.cached, state.nodes.a!.wallMs], [6, true, 700], 'a is reported by the thumbnails request now');
  assert.equal(state.nodes.d!.requestId, 5);

  // A view that names nothing is shown under a request id of its own: no node is the view's after it.
  state = reduceEngineEvent(state, { type: 'view-updated', requestId: 7, revision: 9, resolution: 257, draft: false, height: false, overlay: false });
  assert.equal(state.viewRequestId, 7);
  state = reduceEngineEvents([...start(8, 'thumbnails', ['d', 'run']), { type: 'node-start', requestId: 8, nodeId: 'd' }, { type: 'node-error', requestId: 8, error: { ...ERROR, nodeId: 'd' } }, end(8, 'errors')], state);
  assert.equal(state.nodes.d!.state, 'error');

  // A draft and a build are requests for what the user sees as much as a view is.
  state = reduceEngineEvents(start(9, 'draft', ['d', 'run']), state);
  assert.equal(state.viewRequestId, 9);
  state = reduceEngineEvents([end(9, 'aborted'), ...start(10, 'build', ['d', 'run'])], state);
  assert.equal(state.viewRequestId, 10);
});

test('a stream that begins inside a request is taken as it comes', () => {
  // No request-start was seen: the mode of the evaluation says what is known of its purpose.
  let state = reduceEngineEvent(INITIAL_ENGINE_STATE, { type: 'eval-start', requestId: 40, resolution: 513, mode: 'build', plan: plan(['a', 'run']), outputPeakBytes: 1024 });
  assert.deepEqual(state.evaluation, { requestId: 40, purpose: 'build', fraction: 0, etaMs: null });
  state = reduceEngineEvent(INITIAL_ENGINE_STATE, { type: 'eval-start', requestId: 41, resolution: 257, mode: 'preview', plan: plan(['a', 'run']), outputPeakBytes: null });
  assert.equal(state.evaluation?.purpose, 'view');
  // Node events without any start.
  state = reduceEngineEvents([{ type: 'node-progress', requestId: 50, nodeId: 'q', fraction: 0.3, etaMs: null }, done(50, 'q')], INITIAL_ENGINE_STATE);
  assert.deepEqual([state.nodes.q!.state, state.evaluation], ['done', null]);
  // An event of a kind this interface does not know.
  same(reduceEngineEvent(state, { type: 'from-a-newer-engine' } as unknown as EngineEvent), state);
});

test('keys replace the keys before; a thumbnail records the key it was made from, and staleness is the difference', () => {
  let state = reduceEngineEvent(INITIAL_ENGINE_STATE, { type: 'keys', revision: 1, keys: { a: 'k1', b: 'k2' } });
  state = reduceEngineEvent(state, { type: 'thumbnail', nodeId: 'a', contentKey: 'k1', resolution: 129, rgba: new Uint8ClampedArray(0) });
  const stale = (id: string): boolean => state.keys[id] !== state.thumbnailKeys[id];
  assert.deepEqual([stale('a'), stale('b')], [false, true]);
  state = reduceEngineEvent(state, { type: 'keys', revision: 2, keys: { a: 'k9', c: 'k3' } });
  assert.deepEqual(state.keys, { a: 'k9', c: 'k3' }, 'the keys of the latest document, and of no node it lacks');
  assert.deepEqual([stale('a'), state.thumbnailKeys.a], [true, 'k1'], 'the thumbnail last received is still the one for k1');
  assert.equal('rgba' in state.thumbnailKeys, false);
  assert.equal(JSON.stringify(state).includes('rgba'), false, 'pixels are in no store');
});

test('a build in the store: build-start resets every member, each event fills its own, problems keep their order', () => {
  const problem = (code: BuildProblem['code']): BuildProblem => ({ severity: code.startsWith('W') ? 'warning' : 'error', code, message: `${code} happened` });
  const somePlan = { ok: true, resolution: 505, name: 'Land' } as unknown as BuildPlan;
  const result = { requestId: 20, status: 'errors', problems: [problem('E_WRITE_FAILED')], files: [], manifest: null, report: 'Land.report.json', outDir: '/out' } as BuildResult;

  let state = reduceEngineEvents([
    { type: 'request-start', requestId: 20, revision: 3, purpose: 'build' },
    { type: 'build-start', requestId: 20, resolution: 505, outDir: '/out' },
    { type: 'build-plan', requestId: 20, plan: somePlan },
    { type: 'build-target', requestId: 20, index: 0, count: 3, nodeId: 'out', label: 'Landscape: LandHeight.png' },
    { type: 'build-progress', requestId: 20, phase: 'targets', fraction: 0.25 },
    { type: 'build-problem', requestId: 20, problem: problem('W_HEIGHT_CLIPPED') },
    { type: 'build-progress', requestId: 20, phase: 'weights', fraction: 0.75 },
    { type: 'build-problem', requestId: 20, problem: problem('E_WRITE_FAILED') },
  ]);
  assert.deepEqual(state.build, {
    running: true, requestId: 20, plan: somePlan, target: { index: 0, count: 3, nodeId: 'out', label: 'Landscape: LandHeight.png' },
    phase: 'weights', fraction: 0.75, problems: [problem('W_HEIGHT_CLIPPED'), problem('E_WRITE_FAILED')], result: null, lastStatus: null,
  });

  state = reduceEngineEvents([{ type: 'build-result', requestId: 20, result }, { type: 'build-end', requestId: 20, status: 'errors' }], state);
  assert.deepEqual([state.build.running, state.build.lastStatus, state.build.result, state.evaluation], [false, 'errors', result, null]);
  assert.equal(state.build.plan, somePlan, 'what the build reported stays readable');

  // Events of that build that arrive after the next one has started belong to nothing.
  state = reduceEngineEvent(state, { type: 'build-start', requestId: 22, resolution: 505, outDir: '/out' });
  const fresh = state.build;
  assert.deepEqual(fresh, { running: true, requestId: 22, plan: null, target: null, phase: null, fraction: 0, problems: [], result: null, lastStatus: null });
  for (const event of [
    { type: 'build-progress', requestId: 20, phase: 'commit', fraction: 1 },
    { type: 'build-problem', requestId: 20, problem: problem('E_INTERNAL') },
    { type: 'build-result', requestId: 20, result },
    { type: 'build-end', requestId: 20, status: 'ok' },
  ] satisfies EngineEvent[]) {
    same(reduceEngineEvent(state, event).build, fresh, event.type);
  }
  for (const status of ['ok', 'aborted', 'device-lost'] as const) {
    assert.equal(reduceEngineEvent(state, { type: 'build-end', requestId: 22, status }).build.lastStatus, status);
  }
});

test('the store starts at the initial state, and every store has a state of its own', () => {
  const a = createEngineStore();
  const b = createEngineStore();
  same(a.getState(), INITIAL_ENGINE_STATE);
  applyEngineEvent(a, { type: 'device-ready', epoch: 1, caps: CAPS, budgetBytes: 1 });
  assert.equal(a.getState().device.state, 'ready');
  assert.equal(b.getState().device.state, 'starting');
  assert.equal(INITIAL_ENGINE_STATE.device.state, 'starting');
});
