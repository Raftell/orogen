// What the panel keeps of a build beyond engineStore (runtime.md 8.5): a reduction of the event stream with the
// time each event arrived. From it: the stages and targets with their progress and time, an estimate of what is
// left that says how far it can be trusted, and what each node held, at which resolution.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineEvent } from '../../../../src/core/runtime.ts';
import {
  estimateRemaining, NO_MEASUREMENTS, peakMemory, progressRows, reduceBuildLog, reduceMeasurements, seedMeasurements, viewProgress,
  type BuildLog, type Measurements,
} from '../../../../src/app/panels/build/model/log.ts';
import { docOf, FULL, plan, SOURCES } from './_docs.ts';

const PLAN = plan(docOf(FULL));
const R = 7;

type Timed = readonly [at: number, event: EngineEvent];

function run(events: readonly Timed[], from: BuildLog | null = null): BuildLog {
  let log = from;
  for (const [at, event] of events) log = reduceBuildLog(log, event, at);
  assert.ok(log, 'the stream began a build');
  return log;
}

const start = (at: number, requestId = R): Timed => [at, { type: 'build-start', requestId, resolution: 1009, outDir: '/out/ridge' }];
const planned = (at: number): Timed => [at, { type: 'build-plan', requestId: R, plan: PLAN }];
/** The evaluation sets out to run two nodes; the export nodes themselves never run (export-unreal.md 2.3). */
const evalStart = (at: number, outputPeakBytes: number | null = 40e6): Timed => [at, {
  type: 'eval-start', requestId: R, resolution: 1009, mode: 'build', outputPeakBytes,
  plan: [{ nodeId: 'land', state: 'run' }, { nodeId: 'steep', state: 'run' }, { nodeId: 'paint', state: 'unused' }],
}];
const nodeStart = (at: number, nodeId: string): Timed => [at, { type: 'node-start', requestId: R, nodeId }];
const nodeDone = (at: number, nodeId: string, wallMs: number, peakBytes: number, cached = false): Timed =>
  [at, { type: 'node-done', requestId: R, nodeId, cached, wallMs, gpuMs: null, peakBytes }];
const target = (at: number, index: number): Timed => [at, { type: 'build-target', requestId: R, index, count: PLAN.items.length, nodeId: PLAN.items[index]!.nodeId, label: 'x' }];
const progress = (at: number, phase: 'targets' | 'weights' | 'commit', fraction: number): Timed => [at, { type: 'build-progress', requestId: R, phase, fraction }];
const evalProgress = (at: number, fraction: number): Timed => [at, { type: 'eval-progress', requestId: R, fraction, etaMs: null }];
const evalEnd = (at: number, status: 'ok' | 'errors' | 'aborted' | 'device-lost' = 'ok'): Timed => [at, { type: 'eval-end', requestId: R, status, wallMs: 0 }];
const result = (at: number, status: 'ok' | 'errors' | 'aborted' | 'device-lost'): Timed =>
  [at, { type: 'build-result', requestId: R, result: { requestId: R, status, problems: [], files: [], manifest: null, report: null, outDir: null } }];
const end = (at: number, status: 'ok' | 'errors' | 'aborted' | 'device-lost'): Timed => [at, { type: 'build-end', requestId: R, status }];

const rows = progressRows(PLAN);
/** The `build-progress.fraction` when the first `count` targets of the plan are converted. */
const after = (count: number, more = 0): number => (rows.targets.slice(0, count).reduce((sum, n) => sum + n, 0) + more) / rows.total;

// ---- the rows a build converts -------------------------------------------------------------------------------------------

test('the rows of a build: the output rows of every target, and the resolution once more for the layer weights (export-unreal.md 3.9)', () => {
  // The landscape, two layers, three textures of side 1024 and an image.
  assert.deepEqual(PLAN.items.map(({ item }) => item.kind), ['landscape', 'layer', 'layer', 'texture', 'texture', 'texture', 'image']);
  assert.deepEqual(rows.targets, [1009, 1009, 1009, 1024, 1024, 1024, 1009]);
  assert.equal(rows.weights, 1009);
  assert.equal(rows.total, 4 * 1009 + 3 * 1024 + 1009);
  const plain = progressRows(plan(docOf({ ...SOURCES, out: { type: 'io/export-field', in: 'land.out' } })));
  assert.deepEqual([plain.targets, plain.weights, plain.total], [[1009], 0, 1009]);
});

// ---- a build that succeeds -----------------------------------------------------------------------------------------------

/** Two nodes and the seven targets: the landscape after the first node, the rest after the second, the weights, the commit. */
const WHOLE: readonly Timed[] = [
  start(0), planned(20), evalStart(30),
  nodeStart(40, 'land'), evalProgress(900, 0.4), nodeDone(1040, 'land', 1000, 16e6),
  target(1050, 0), progress(1100, 'targets', after(0, 500)), progress(1250, 'targets', after(1)),
  nodeStart(1300, 'steep'), nodeDone(1800, 'steep', 500, 24e6), evalProgress(1800, 1),
  target(1810, 1), target(1900, 2), target(2000, 3), target(2300, 4), target(2600, 5), target(2900, 6),
  evalEnd(3100),
  progress(3120, 'weights', after(7, 200)), progress(3400, 'weights', 1),
  progress(3410, 'commit', 1),
  result(3900, 'ok'), end(3910, 'ok'),
];

test('a build from its first event to its last: every stage has its time, every target its turn', () => {
  const log = run(WHOLE);
  assert.deepEqual([log.requestId, log.outDir, log.resolution, log.startedAt, log.endedAt, log.status], [R, '/out/ridge', 1009, 0, 3910, 'ok']);
  assert.deepEqual([log.plannedAt, log.evalStartedAt, log.evalEndedAt, log.evalStatus, log.commitAt], [20, 30, 3100, 'ok', 3410]);
  assert.deepEqual(log.nodes, { land: { wallMs: 1000, peakBytes: 16e6 }, steep: { wallMs: 500, peakBytes: 24e6 } });
  assert.equal(log.nodeMs, 1500);
  assert.deepEqual(log.order, [0, 1, 2, 3, 4, 5, 6]);
  // A stage ends when the next node or the next stage begins, the last one with the evaluation.
  assert.deepEqual(log.targets[0], { startedAt: 1050, endedAt: 1300, complete: true });
  assert.deepEqual(log.targets[1], { startedAt: 1810, endedAt: 1900, complete: true });
  assert.deepEqual(log.targets[6], { startedAt: 2900, endedAt: 3100, complete: true });
  assert.deepEqual(log.weights, { startedAt: 3120, endedAt: 3410, complete: true });
  assert.equal(log.stage, null);
  assert.equal(log.runningNode, null);
  assert.deepEqual(peakMemory(log), { outputBytes: 40e6, node: { nodeId: 'steep', bytes: 24e6 } });

  const view = viewProgress({ log, plan: PLAN, fraction: 1, now: 99_999 });
  assert.deepEqual(view.stages.map((stage) => [stage.id, stage.state, stage.fraction, stage.ms]), [
    ['plan', 'done', null, 20],
    ['compute', 'done', 1, 1500],
    ['export', 'done', 1, 250 + 90 + 100 + 300 + 300 + 300 + 200],
    ['weights', 'done', 1, 290],
    ['commit', 'done', null, 500],
  ]);
  assert.deepEqual(view.targets.map((t) => [t.index, t.nodeId, t.state, t.fraction]), PLAN.items.map((item, index) => [index, item.nodeId, 'done', 1]));
  assert.equal(view.elapsedMs, 3910, 'a build that has ended no longer counts');
  assert.equal(view.remaining, null);
});

test('a build under way: what runs, how far each stage is, and the target being converted by its own rows', () => {
  // Stopped in the middle of the landscape: half its rows are converted, and no other target is delivered.
  const during = WHOLE.slice(0, WHOLE.findIndex(([, event]) => event.type === 'build-progress') + 1);
  const log = run(during);
  assert.equal(log.stage, 0);
  const view = viewProgress({ log, plan: PLAN, fraction: after(0, 500), now: 1200 });
  assert.deepEqual(view.stages.map((stage) => [stage.id, stage.state]), [['plan', 'done'], ['compute', 'running'], ['export', 'running'], ['weights', 'waiting'], ['commit', 'waiting']]);
  const [compute, exported] = [view.stages[1]!, view.stages[2]!];
  // One of the two nodes has run: half is the least that is shown, though the evaluation last reported 0.4.
  assert.deepEqual([compute.fraction, compute.ms], [0.5, 1000], 'no node runs while a target is converted: the time of the nodes stands');
  assert.equal(exported.ms, 150);
  assert.ok(Math.abs(exported.fraction! - 500 / (rows.total - rows.weights)) < 1e-12);
  assert.deepEqual(view.targets.map((t) => t.state), ['running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
  assert.ok(Math.abs(view.targets[0]!.fraction - 500 / 1009) < 1e-12);
  assert.equal(view.targets[0]!.ms, 150);
  assert.equal(view.elapsedMs, 1200);

  // A node that is running counts with the time it has run so far.
  const computing = run(WHOLE.slice(0, 4));
  assert.deepEqual(computing.runningNode, { nodeId: 'land', since: 40 });
  assert.equal(viewProgress({ log: computing, plan: PLAN, fraction: 0, now: 640 }).stages[1]!.ms, 600);
  assert.deepEqual(viewProgress({ log: computing, plan: PLAN, fraction: 0, now: 640 }).stages[2], { id: 'export', label: 'Convert and encode', state: 'waiting', fraction: null, ms: null });

  // In the weights: the targets are done, and the weights have their own share of the rows.
  const weighing = run(WHOLE.slice(0, WHOLE.findIndex(([, event]) => event.type === 'build-progress' && event.phase === 'weights') + 1));
  const weights = viewProgress({ log: weighing, plan: PLAN, fraction: after(7, 200), now: 3200 });
  assert.deepEqual(weights.stages.map((stage) => stage.state), ['done', 'done', 'done', 'running', 'waiting']);
  assert.ok(Math.abs(weights.stages[3]!.fraction! - 200 / 1009) < 1e-9);
  assert.equal(weights.stages[3]!.ms, 80);
  assert.ok(weights.targets.every((t) => t.state === 'done'));
});

test('a cached node took no time of its own, and events of another request say nothing of this build', () => {
  const log = run([start(0), evalStart(10), nodeStart(20, 'land'), nodeDone(20, 'land', 0, 0, true)]);
  assert.deepEqual([log.nodes, log.nodeMs, log.runningNode], [{}, 0, null]);
  const other: EngineEvent = { type: 'node-done', requestId: R + 1, nodeId: 'land', cached: false, wallMs: 999, gpuMs: null, peakBytes: 1 };
  assert.equal(reduceBuildLog(log, other, 30), log);
  assert.equal(reduceBuildLog(log, { type: 'keys', revision: 3, keys: {} }, 30), log);
  assert.equal(reduceBuildLog(null, other, 30), null, 'no build, no log');
  // An event that arrives after the build has ended changes nothing; the next build begins a new log.
  const over = run([...WHOLE]);
  assert.equal(reduceBuildLog(over, evalProgress(5000, 0.2)[1], 5000), over);
  assert.equal(run([start(6000, R + 1)], over).requestId, R + 1);
  assert.equal(run([start(6000, R + 1)], over).startedAt, 6000);
});

test('the nodes are done when all that were to run have run, though the evaluation goes on until its last target is written', () => {
  // Both nodes have run; the second target is being written, and five more wait.
  const log = run(WHOLE.slice(0, WHOLE.findIndex(([, event]) => event.type === 'build-target' && event.index === 1) + 1));
  assert.deepEqual([log.nodesToRun, Object.keys(log.nodes).length, log.evalEndedAt], [2, 2, null]);
  const view = viewProgress({ log, plan: PLAN, fraction: after(1, 300), now: 1900 });
  assert.deepEqual(view.stages.slice(1, 3).map((stage) => [stage.id, stage.state, stage.fraction]), [['compute', 'done', 1], ['export', 'running', (1009 + 300) / (rows.total - rows.weights)]]);
  // What is left is the files alone, at the rate they were written so far.
  const spent = 250 + 90;
  assert.deepEqual(view.remaining, { ms: spent * (1 - after(1, 300)) / after(1, 300), bound: 'about' });
  // Before the evaluation has said what it will run, nothing is taken for done.
  const early = run([start(0), planned(20)]);
  assert.deepEqual(viewProgress({ log: early, plan: PLAN, fraction: 0, now: 25 }).stages[1], { id: 'compute', label: 'Compute the nodes', state: 'waiting', fraction: null, ms: null });
});

// ---- builds that do not succeed ------------------------------------------------------------------------------------------

test('a node that fails: the nodes stopped, the target under way was never written, the later stages were not reached', () => {
  const failing: EngineEvent = { type: 'node-error', requestId: R, error: { nodeId: 'steep', nodeType: 'ref/slope-mask', kind: 'node', message: 'Boom' } as never };
  const log = run([
    start(0), planned(20), evalStart(30), nodeStart(40, 'land'), nodeDone(1040, 'land', 1000, 16e6), evalProgress(1040, 0.6),
    target(1050, 0), progress(1250, 'targets', after(1)),
    nodeStart(1300, 'steep'), [1500, failing], evalEnd(1510, 'errors'), result(1520, 'errors'), end(1530, 'errors'),
  ]);
  assert.equal(log.runningNode, null);
  const view = viewProgress({ log, plan: PLAN, fraction: after(1), now: 9999 });
  assert.deepEqual(view.stages.map((stage) => [stage.id, stage.state]), [['plan', 'done'], ['compute', 'stopped'], ['export', 'stopped'], ['weights', 'skipped'], ['commit', 'skipped']]);
  assert.equal(view.stages[1]!.fraction, 0.6, 'how far the nodes had come is kept');
  assert.deepEqual(view.targets.map((t) => t.state), ['done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(view.remaining, null);
});

test('a build cancelled inside a target: that target is stopped where it was, not done', () => {
  const log = run([
    start(0), planned(20), evalStart(30), nodeStart(40, 'land'), nodeDone(1040, 'land', 1000, 16e6),
    target(1050, 0), progress(1100, 'targets', after(0, 512)), evalEnd(1200, 'aborted'), result(1210, 'aborted'), end(1220, 'aborted'),
  ]);
  assert.deepEqual(log.targets[0], { startedAt: 1050, endedAt: 1200, complete: false });
  const view = viewProgress({ log, plan: PLAN, fraction: after(0, 512), now: 9999 });
  assert.deepEqual(view.targets.slice(0, 2).map((t) => [t.state, Math.round(t.fraction * 1000)]), [['stopped', Math.round(512 / 1009 * 1000)], ['skipped', 0]]);
  assert.deepEqual(view.stages.map((stage) => stage.state), ['done', 'stopped', 'stopped', 'skipped', 'skipped']);
});

test('a folder that is refused ends the build before any plan; a plan with an error ends it at the plan', () => {
  const refused = run([start(0), result(15, 'errors'), end(16, 'errors')]);
  assert.deepEqual(viewProgress({ log: refused, plan: null, fraction: 0, now: 50 }).stages.map((stage) => [stage.id, stage.state]), [
    ['plan', 'stopped'], ['compute', 'skipped'], ['export', 'skipped'], ['commit', 'skipped'],
  ]);
  assert.deepEqual(viewProgress({ log: refused, plan: null, fraction: 0, now: 50 }).targets, []);

  const broken = plan(docOf({ ...SOURCES, loose: { type: 'io/export-normal' } }));
  assert.equal(broken.ok, false);
  const stopped = run([start(0), [20, { type: 'build-plan', requestId: R, plan: broken }], result(25, 'errors'), end(26, 'errors')]);
  const view = viewProgress({ log: stopped, plan: broken, fraction: 0, now: 50 });
  assert.deepEqual(view.stages.map((stage) => stage.state), ['stopped', 'skipped', 'skipped', 'skipped']);
  assert.equal(view.stages[0]!.ms, 20);
});

test('the weights cut short, and a commit that fails, are stopped; what came before them is done', () => {
  const head = WHOLE.slice(0, WHOLE.findIndex(([, event]) => event.type === 'build-progress' && event.phase === 'weights') + 1);
  const cancelled = run([...head, result(3300, 'aborted'), end(3310, 'aborted')]);
  assert.deepEqual(cancelled.weights, { startedAt: 3120, endedAt: 3300, complete: false });
  assert.deepEqual(viewProgress({ log: cancelled, plan: PLAN, fraction: after(7, 200), now: 0 }).stages.map((stage) => stage.state), ['done', 'done', 'done', 'stopped', 'skipped']);

  const commit = WHOLE.slice(0, WHOLE.findIndex(([, event]) => event.type === 'build-progress' && event.phase === 'commit') + 1);
  const failed = run([...commit, result(3500, 'errors'), end(3510, 'errors')]);
  assert.deepEqual(viewProgress({ log: failed, plan: PLAN, fraction: 1, now: 0 }).stages.map((stage) => stage.state), ['done', 'done', 'done', 'done', 'stopped']);
});

test('a target that is written is written, whatever fraction was last reported: progress is reported ten times a second at the most', () => {
  // A small build: three targets are done within a tenth of a second, and the last report was of the middle of the first.
  const log = run([
    start(0), planned(5), evalStart(6), nodeStart(7, 'land'), nodeDone(20, 'land', 13, 1e6), target(21, 0), progress(25, 'targets', after(0, 100)),
    nodeStart(40, 'steep'), nodeDone(50, 'steep', 10, 1e6), target(51, 1), target(60, 2), target(70, 3),
  ]);
  const view = viewProgress({ log, plan: PLAN, fraction: after(0, 100), now: 80 });
  assert.deepEqual(view.targets.slice(0, 4).map((t) => [t.state, t.fraction]), [['done', 1], ['done', 1], ['done', 1], ['running', 0]]);
  assert.equal(view.stages[2]!.fraction, (3 * 1009) / (rows.total - rows.weights), 'the stage is as far as its targets');
});

test('the weights of a small build are over before progress names them: a build that came to its commit has done them', () => {
  // No `build-progress` of the phase 'weights' at all: they took less than the tenth of a second between two reports.
  const quick = WHOLE.filter(([, event]) => !(event.type === 'build-progress' && event.phase === 'weights'));
  const log = run(quick);
  assert.equal(log.weights, null);
  const view = viewProgress({ log, plan: PLAN, fraction: 1, now: 0 });
  assert.deepEqual(view.stages.map((stage) => [stage.id, stage.state]), [['plan', 'done'], ['compute', 'done'], ['export', 'done'], ['weights', 'done'], ['commit', 'done']]);
  assert.deepEqual([view.stages[3]!.fraction, view.stages[3]!.ms], [1, null], 'done, and how long is not known');
  // Before the commit nothing says that they have begun.
  const before = run(quick.slice(0, quick.findIndex(([, event]) => event.type === 'eval-end') + 1));
  assert.equal(viewProgress({ log: before, plan: PLAN, fraction: after(7), now: 3105 }).stages[3]!.state, 'waiting');
});

// ---- what is left --------------------------------------------------------------------------------------------------------

test('what is left is estimated from what the finished part took, and only once a rate is measured', () => {
  // Nothing measured yet: no estimate, not a guess.
  assert.equal(estimateRemaining({ computeMs: 400, computeFraction: 0.5, computeDone: false, exportMs: 0, exportFraction: 0 }), null);
  assert.equal(estimateRemaining({ computeMs: 5000, computeFraction: 0.04, computeDone: false, exportMs: 100, exportFraction: 0.5 }), null);
  // The nodes are measured, the files not yet: the files are left out, and the estimate says that it is a lower bound.
  assert.deepEqual(estimateRemaining({ computeMs: 4000, computeFraction: 0.25, computeDone: false, exportMs: 0, exportFraction: 0 }), { ms: 12_000, bound: 'at-least' });
  assert.deepEqual(estimateRemaining({ computeMs: 500, computeFraction: 0.5, computeDone: false, exportMs: 1000, exportFraction: 0.5 }), { ms: 1000, bound: 'at-least' });
  // Both measured: their sum.
  assert.deepEqual(estimateRemaining({ computeMs: 4000, computeFraction: 0.5, computeDone: false, exportMs: 1000, exportFraction: 0.25 }), { ms: 4000 + 3000, bound: 'about' });
  // The nodes are done: only the files are left.
  assert.deepEqual(estimateRemaining({ computeMs: 9000, computeFraction: 0.7, computeDone: true, exportMs: 1500, exportFraction: 0.75 }), { ms: 500, bound: 'about' });
  assert.deepEqual(estimateRemaining({ computeMs: 9000, computeFraction: 1, computeDone: true, exportMs: 2000, exportFraction: 1 }), { ms: 0, bound: 'about' });

  // In a build: after the first node and half the landscape, both rates are known.
  const log = run(WHOLE.slice(0, WHOLE.findIndex(([, event]) => event.type === 'build-progress') + 1));
  const fraction = after(0, 500);
  const view = viewProgress({ log, plan: PLAN, fraction, now: 1350 });
  assert.equal(view.remaining!.bound, 'about');
  const expected = 1000 * (1 - 0.4) / 0.4 + 300 * (1 - fraction) / fraction;
  assert.ok(Math.abs(view.remaining!.ms - expected) < 1e-6, `${view.remaining!.ms} against ${expected}`);
  // While the files are finished nothing says how long that takes, and nothing is claimed.
  const committing = run(WHOLE.slice(0, WHOLE.findIndex(([, event]) => event.type === 'build-progress' && event.phase === 'commit') + 1));
  assert.equal(viewProgress({ log: committing, plan: PLAN, fraction: 1, now: 3500 }).remaining, null);
  assert.equal(viewProgress({ log: committing, plan: PLAN, fraction: 1, now: 3500 }).stages.at(-1)!.state, 'running');
});

// ---- what nodes hold -----------------------------------------------------------------------------------------------------

test('what a node held is kept with the resolution it ran at, which the evaluation it ran in names', () => {
  const feed = (events: readonly EngineEvent[], from: Measurements = NO_MEASUREMENTS): Measurements => events.reduce(reduceMeasurements, from);
  const done = (requestId: number, nodeId: string, peakBytes: number, cached = false): EngineEvent => ({ type: 'node-done', requestId, nodeId, cached, wallMs: 1, gpuMs: null, peakBytes });
  const began = (requestId: number, resolution: number): EngineEvent => ({ type: 'eval-start', requestId, resolution, mode: 'preview', plan: [], outputPeakBytes: null });

  let measured = feed([began(1, 505), done(1, 'land', 4e6), done(1, 'steep', 6e6), done(1, 'paint', 0)]);
  assert.deepEqual(measured.peaks, { land: { bytes: 4e6, resolution: 505 }, steep: { bytes: 6e6, resolution: 505 } }, 'a node that held nothing measures nothing');
  // A draft at a coarser level replaces the node it ran, and only that one.
  measured = feed([began(2, 253), done(2, 'steep', 1.5e6), done(2, 'land', 4e6, true)], measured);
  assert.deepEqual(measured.peaks, { land: { bytes: 4e6, resolution: 505 }, steep: { bytes: 1.5e6, resolution: 253 } });
  // An evaluation whose start was not heard has no resolution: its nodes measure nothing.
  assert.equal(feed([done(9, 'land', 7e6)], measured), measured);
  // Only the newest evaluations are remembered.
  const many = feed(Array.from({ length: 12 }, (_, i) => began(10 + i, 505)), measured);
  assert.deepEqual(Object.keys(many.resolutions).map(Number), [14, 15, 16, 17, 18, 19, 20, 21]);
  assert.equal(many.peaks, measured.peaks);
});

test('when the panel begins to listen, it takes what is certain: the nodes that ran for what is shown', () => {
  const node = (requestId: number, state: string, cached: boolean, peakBytes: number | null) => ({ requestId, state, cached, peakBytes });
  const shown = {
    evaluation: null, view: { resolution: 505, draft: false }, viewRequestId: 4, build: { requestId: null },
    nodes: { land: node(4, 'done', false, 4e6), steep: node(4, 'done', true, 9e6), thumb: node(5, 'done', false, 1e6), broken: node(4, 'error', false, null) },
  };
  // A node that was cached may have run at any resolution before; one of another request ran for a thumbnail.
  assert.deepEqual(seedMeasurements(shown), { resolutions: { 4: 505 }, peaks: { land: { bytes: 4e6, resolution: 505 } } });
  assert.equal(seedMeasurements({ ...shown, view: { resolution: 253, draft: true } }), NO_MEASUREMENTS, 'a draft ran coarser than it says');
  assert.equal(seedMeasurements({ ...shown, evaluation: { requestId: 6 } }), NO_MEASUREMENTS, 'an evaluation is under way');
  assert.equal(seedMeasurements({ ...shown, build: { requestId: 4 } }), NO_MEASUREMENTS, 'the newest request was a build, at another resolution');
  assert.equal(seedMeasurements({ ...shown, view: null }), NO_MEASUREMENTS);
});
