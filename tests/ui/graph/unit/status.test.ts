// The status a node shows: the engine's events as engineStore reduces them (runtime.md 8.5), and what the
// document alone says, since the engine sends no event for a node outside the plan it evaluates (5.3).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setNodeFlags, type EngineEvent, type NodeError } from '../../../../src/core/runtime.ts';
import { createNodeFeed, isCurrent, isPaused, isStale, runtimeOf } from '../../../../src/app/panels/graph/engine-feed.ts';
import { formatDuration, nodeStatus } from '../../../../src/app/panels/graph/status.ts';
import { applyEngineEvent, setEnginePaused } from '../../../../src/app/state/engine-store.ts';
import { bench, type Bench } from './_graph.ts';

function chain(b: Bench): { range: string; erosion: string; fail: string; after: string; open: string } {
  const range = b.add('generate/mountain-range', { x: 0, y: 0 });
  const erosion = b.add('simulate/hydraulic-erosion', { x: 300, y: 0 }, { in: `${range}.out` });
  const fail = b.add('ref/fail', { x: 600, y: 0 }, { in: `${erosion}.out` });
  const after = b.add('filter/blur', { x: 900, y: 0 }, { in: `${fail}.out` });
  const open = b.add('surface/terraces', { x: 0, y: 300 });
  return { range, erosion, fail, after, open };
}

const feed = (b: Bench, events: readonly EngineEvent[]): void => { for (const event of events) applyEngineEvent(b.engineState, event); };


/** The status of a node as its component computes it: its view, the engine's record, and whether that record is of the running evaluation. */
function status(b: Bench, id: string, upstreamTitle: string | null = null) {
  const state = b.engineState.getState();
  const runtime = state.nodes[id];
  return nodeStatus(b.views().get(id)!, runtime, state.evaluation !== null && runtime?.requestId === state.evaluation.requestId, upstreamTitle, isPaused(state));
}

test('durations are short and never read as nothing', () => {
  assert.deepEqual([0, 0.4, 3.6, 999.4, 1000, 2345, 12_345, 59_949, 61_000, 754_000].map(formatDuration),
    ['< 1 ms', '< 1 ms', '4 ms', '999 ms', '1.00 s', '2.35 s', '12.3 s', '59.9 s', '1 min 01 s', '12 min 34 s']);
  assert.equal(formatDuration(Number.NaN), '');
});

test('a node waits, computes with its progress, is done with its time, and is cached the next time', () => {
  const b = bench();
  const { range, erosion } = chain(b);
  assert.deepEqual([status(b, range).state, status(b, range).text], ['idle', ''], 'before the engine has said anything');

  feed(b, [
    { type: 'request-start', requestId: 1, revision: 1, purpose: 'view' },
    { type: 'eval-start', requestId: 1, resolution: 1009, mode: 'preview', outputPeakBytes: null, plan: [{ nodeId: range, state: 'run' }, { nodeId: erosion, state: 'run' }] },
  ]);
  assert.deepEqual([status(b, range).state, status(b, range).text], ['waiting', 'Waiting']);
  feed(b, [{ type: 'node-start', requestId: 1, nodeId: range }]);
  assert.deepEqual([status(b, range).state, status(b, range).text, status(b, range).fraction], ['running', 'Computing 0%', 0]);
  feed(b, [
    { type: 'node-done', requestId: 1, nodeId: range, cached: false, resolution: 1009, wallMs: 12.4, gpuMs: 9, peakBytes: 1024 },
    { type: 'node-start', requestId: 1, nodeId: erosion },
    { type: 'node-progress', requestId: 1, nodeId: erosion, fraction: 0.424, label: 'Eroding', etaMs: 4200 },
  ]);
  assert.deepEqual([status(b, range).state, status(b, range).text, status(b, range).failed], ['done', '12 ms', false]);
  const running = status(b, erosion);
  assert.deepEqual([running.state, running.text, running.fraction], ['running', 'Eroding 42%, 4.20 s left', 0.424]);
  feed(b, [{ type: 'node-progress', requestId: 1, nodeId: erosion, fraction: 0.9, etaMs: 300 }]);
  assert.equal(status(b, erosion).text, 'Computing 90%', 'a remaining time under a second is not worth saying');
  feed(b, [
    { type: 'node-done', requestId: 1, nodeId: erosion, cached: false, resolution: 1009, wallMs: 5300, gpuMs: null, peakBytes: 1 },
    { type: 'eval-end', requestId: 1, status: 'ok', wallMs: 5400 },
  ]);
  assert.deepEqual([status(b, erosion).state, status(b, erosion).text, status(b, erosion).fraction], ['done', '5.30 s', null]);

  // The next evaluation finds both in the cache: the node says so, and keeps what its last run took for whoever asks.
  feed(b, [
    { type: 'request-start', requestId: 2, revision: 2, purpose: 'view' },
    { type: 'eval-start', requestId: 2, resolution: 1009, mode: 'preview', outputPeakBytes: null, plan: [{ nodeId: range, state: 'cached' }, { nodeId: erosion, state: 'cached' }] },
    { type: 'node-done', requestId: 2, nodeId: range, cached: true, resolution: 1009, wallMs: 0, gpuMs: null, peakBytes: 0 },
    { type: 'node-done', requestId: 2, nodeId: erosion, cached: true, resolution: 1009, wallMs: 0, gpuMs: null, peakBytes: 0 },
    { type: 'eval-end', requestId: 2, status: 'ok', wallMs: 1 },
  ]);
  assert.deepEqual([status(b, erosion).state, status(b, erosion).text, status(b, erosion).detail], ['cached', 'Cached', 'Cached; computed in 5.30 s']);
});

test('a node that failed shows what the engine said, and the nodes after it say which node stopped them', () => {
  const b = bench();
  const { range, erosion, fail, after } = chain(b);
  const error: NodeError = { nodeId: fail, nodeType: 'ref/fail', kind: 'node-exception', message: 'Reference failure', detail: 'Error: Reference failure\n    at evaluate' };
  feed(b, [
    { type: 'request-start', requestId: 1, revision: 1, purpose: 'view' },
    { type: 'eval-start', requestId: 1, resolution: 1009, mode: 'preview', outputPeakBytes: null, plan: [range, erosion, fail, after].map((nodeId) => ({ nodeId, state: 'run' as const })) },
    { type: 'node-done', requestId: 1, nodeId: range, cached: false, resolution: 1009, wallMs: 3, gpuMs: null, peakBytes: 0 },
    { type: 'node-done', requestId: 1, nodeId: erosion, cached: false, resolution: 1009, wallMs: 3, gpuMs: null, peakBytes: 0 },
    { type: 'node-error', requestId: 1, error },
    { type: 'node-skipped', requestId: 1, nodeId: after, reason: 'upstream', upstream: fail },
    { type: 'eval-end', requestId: 1, status: 'errors', wallMs: 10 },
  ]);
  const failed = status(b, fail);
  assert.deepEqual([failed.state, failed.text, failed.failed], ['error', 'Reference failure', true]);
  assert.equal(failed.detail, null, 'the one sentence is all a node says; the stack is for the list of errors');
  assert.equal(b.engineState.getState().nodes[after]!.upstream, fail);
  const skipped = status(b, after, 'Fail (Reference)');
  assert.deepEqual([skipped.state, skipped.text, skipped.failed], ['skipped', 'Skipped: Fail (Reference) failed', false]);
  assert.equal(status(b, after).text, 'Skipped: an input failed');
  // An evaluation that was aborted leaves its nodes as they were before it, not failed.
  feed(b, [
    { type: 'request-start', requestId: 2, revision: 2, purpose: 'view' },
    { type: 'eval-start', requestId: 2, resolution: 1009, mode: 'preview', outputPeakBytes: null, plan: [{ nodeId: range, state: 'run' }] },
    { type: 'node-skipped', requestId: 2, nodeId: range, reason: 'aborted' },
  ]);
  assert.equal(status(b, range).state, 'waiting');
  feed(b, [{ type: 'eval-end', requestId: 2, status: 'aborted', wallMs: 1 }]);
  assert.deepEqual([status(b, range).state, status(b, range).text], ['idle', '']);
});

test('what the document says needs no engine: a missing input, a bypass, a type this build lacks', () => {
  const b = bench();
  const { range, erosion, open } = chain(b);
  // No event names the node: it is outside every plan. The document says what is wrong with it.
  const missing = status(b, open);
  // It says what it lacks, and is not drawn as a node that failed: every node is in this state until it is wired.
  assert.deepEqual([missing.state, missing.text, missing.failed], ['missing', 'Missing input: In', false]);

  // The engine's own report of a missing input may be older than the wire that fixed it: the document is asked.
  const stale: NodeError = { nodeId: erosion, nodeType: 'simulate/hydraulic-erosion', kind: 'missing-input', message: 'missing input "in"' };
  feed(b, [
    { type: 'request-start', requestId: 1, revision: 1, purpose: 'view' },
    { type: 'eval-start', requestId: 1, resolution: 1009, mode: 'preview', outputPeakBytes: null, plan: [{ nodeId: erosion, state: 'blocked' }] },
    { type: 'node-error', requestId: 1, error: stale },
    { type: 'eval-end', requestId: 1, status: 'errors', wallMs: 1 },
  ]);
  assert.equal(b.engineState.getState().nodes[erosion]!.state, 'error');
  assert.deepEqual([status(b, erosion).state, status(b, erosion).failed], ['idle', false], 'the input is connected in the document');

  b.doc.getState().transact('Bypass', (draft) => setNodeFlags(draft, open, { bypass: true }));
  assert.deepEqual([status(b, open).state, status(b, open).text, status(b, open).failed], ['bypassed', 'Bypassed', false], 'bypassed, a node reads no input and misses none (5.6)');
  assert.equal(status(b, range).state, 'idle');

  b.doc.getState().load({ ...b.now(), nodes: { ghost: { id: 'ghost', type: 'legacy/unknown', version: 1, position: { x: 0, y: 0 }, params: {} } }, edges: {} }, null);
  const unknown = status(b, 'ghost');
  assert.deepEqual([unknown.state, unknown.text, unknown.failed], ['error', 'Unknown node type "legacy/unknown"', true]);

  // A cycle, as a file may hold one: no evaluation has named these nodes, and each says what the engine would say (5.8).
  const loop = (id: string) => ({ id, type: 'filter/blur', version: 1, position: { x: 0, y: 0 }, params: {} });
  b.doc.getState().load({
    ...b.now(),
    nodes: { p: loop('p'), q: loop('q') },
    edges: { pq: { id: 'pq', from: { node: 'p', port: 'out' }, to: { node: 'q', port: 'in' } }, qp: { id: 'qp', from: { node: 'q', port: 'out' }, to: { node: 'p', port: 'in' } } },
  }, null);
  const cyclic = status(b, 'p');
  assert.deepEqual([cyclic.state, cyclic.text, cyclic.failed], ['error', 'Part of a cycle', true]);
  assert.ok(cyclic.detail !== null && cyclic.detail !== cyclic.text, 'the pointer says more than the line');
});

test('an event of the engine is told to the nodes it concerns and to no other', () => {
  const b = bench();
  const { range, erosion, fail } = chain(b);
  const nodes = createNodeFeed(b.engineState);
  const told: string[] = [];
  const stops = [range, erosion, fail].map((id) => nodes.subscribe(id, () => told.push(id)));
  const during = (events: readonly EngineEvent[]): string[] => {
    told.length = 0;
    feed(b, events);
    return [...told].sort();
  };
  const sorted = (...ids: string[]): string[] => ids.sort();

  // A request and its plan: the nodes of the plan wait in it; the third is not in it and hears nothing.
  assert.deepEqual(during([{ type: 'request-start', requestId: 1, revision: 1, purpose: 'view' }]), []);
  assert.deepEqual(during([{ type: 'eval-start', requestId: 1, resolution: 1009, mode: 'preview', outputPeakBytes: null, plan: [{ nodeId: range, state: 'run' }, { nodeId: erosion, state: 'run' }] }]), sorted(range, erosion));
  assert.deepEqual([isCurrent(b.engineState.getState(), range), isCurrent(b.engineState.getState(), fail)], [true, false]);
  // What one node does is told to that node.
  assert.deepEqual(during([{ type: 'node-start', requestId: 1, nodeId: range }]), [range]);
  assert.deepEqual(during([{ type: 'node-progress', requestId: 1, nodeId: range, fraction: 0.5, etaMs: null }]), [range]);
  assert.deepEqual(during([{ type: 'node-done', requestId: 1, nodeId: range, cached: false, resolution: 1009, wallMs: 5, gpuMs: null, peakBytes: 0 }]), [range]);
  assert.equal(runtimeOf(b.engineState.getState(), range)!.state, 'done');
  // What concerns no node is told to none: the evaluation's own progress, the memory in use.
  assert.deepEqual(during([{ type: 'eval-progress', requestId: 1, fraction: 0.5, etaMs: null }]), []);
  assert.deepEqual(during([{ type: 'memory', budgetBytes: 1, workingBytes: 0, cacheBytes: 0, pinnedBytes: 0, freeBytes: 0, reservedBytes: 0, drainingBytes: 0 }]), []);
  // The end of the evaluation: its nodes are no longer in a running one.
  assert.deepEqual(during([{ type: 'eval-end', requestId: 1, status: 'ok', wallMs: 9 }]), sorted(range, erosion));
  assert.equal(isCurrent(b.engineState.getState(), range), false);

  // Keys and thumbnails: a node is told when its picture becomes stale or fresh, not when another's does.
  assert.deepEqual(during([{ type: 'keys', revision: 1, keys: { [range]: 'k1', [erosion]: 'k2' } }]), sorted(range, erosion));
  assert.deepEqual([isStale(b.engineState.getState(), range), isStale(b.engineState.getState(), fail)], [true, false]);
  const rgba = new Uint8ClampedArray(4);
  assert.deepEqual(during([{ type: 'thumbnail', nodeId: range, contentKey: 'k1', resolution: 128, rgba }]), [range]);
  assert.equal(isStale(b.engineState.getState(), range), false);
  assert.deepEqual(during([{ type: 'thumbnail', nodeId: range, contentKey: 'k1', resolution: 253, rgba }]), [], 'a finer picture of the same key changes nothing a node shows');
  assert.deepEqual(during([{ type: 'keys', revision: 2, keys: { [range]: 'k1', [erosion]: 'k3' } }]), [], 'the erosion was stale and still is');

  // A listener that is gone hears nothing, and the feed lets go of the store with its last listener.
  for (const stop of stops) stop();
  assert.deepEqual(during([{ type: 'node-start', requestId: 2, nodeId: range }]), []);
});

test('with the previews paused a node without a result says "Paused"; one that has a result, lacks a wire or exports says what it said', () => {
  const b = bench();
  const { range, erosion, open } = chain(b);
  const landscape = b.add('io/export-landscape', { x: 600, y: 300 }, { in: `${range}.out` });
  feed(b, [
    { type: 'request-start', requestId: 1, revision: 1, purpose: 'view' },
    { type: 'eval-start', requestId: 1, resolution: 1009, mode: 'preview', outputPeakBytes: null, plan: [{ nodeId: range, state: 'run' }, { nodeId: erosion, state: 'run' }] },
    { type: 'node-done', requestId: 1, nodeId: range, cached: false, resolution: 1009, wallMs: 12, gpuMs: null, peakBytes: 0 },
    { type: 'node-skipped', requestId: 1, nodeId: erosion, reason: 'aborted' },
    { type: 'eval-end', requestId: 1, status: 'aborted', wallMs: 20 },
  ]);
  const texts = (): string[] => [range, erosion, open, landscape].map((id) => status(b, id).text);
  assert.deepEqual(texts(), ['12 ms', '', 'Missing input: In', ''], 'not paused: a node nothing computes says nothing');

  setEnginePaused(b.engineState, true);
  assert.deepEqual(texts(), ['12 ms', 'Paused', 'Missing input: In', ''], 'the export node runs in no preview: the pause is not what it waits for');
  const paused = status(b, erosion);
  assert.deepEqual([paused.state, paused.failed, paused.fraction], ['paused', false, null]);
  assert.match(paused.detail!, /resumed/);
  // A node no event has named yet (added while paused) says the same.
  const added = b.add('filter/blur', { x: 900, y: 300 }, { in: `${range}.out` });
  assert.deepEqual([status(b, added).state, status(b, added).text], ['paused', 'Paused']);
  // What the document says of a node comes first: a bypass, a cycle, an unknown type.
  b.doc.getState().transact('Bypass', (draft) => setNodeFlags(draft, added, { bypass: true }));
  assert.equal(status(b, added).text, 'Bypassed');

  setEnginePaused(b.engineState, false);
  assert.deepEqual(texts(), ['12 ms', '', 'Missing input: In', '']);
});

test('the pause is told to every node through the feed, once, and not to a node that no longer listens', () => {
  const b = bench();
  const { range, erosion, fail } = chain(b);
  const nodes = createNodeFeed(b.engineState);
  const told: string[] = [];
  const stops = [range, erosion, fail].map((id) => nodes.subscribe(id, () => told.push(id)));
  setEnginePaused(b.engineState, true);
  assert.deepEqual([...told].sort(), [range, erosion, fail].sort());
  told.length = 0;
  setEnginePaused(b.engineState, true);
  assert.deepEqual(told, [], 'a pause that is as it was is no news');
  stops[0]!();
  setEnginePaused(b.engineState, false);
  assert.deepEqual([...told].sort(), [erosion, fail].sort());
  for (const stop of stops) stop();
});
