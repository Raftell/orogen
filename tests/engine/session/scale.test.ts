// A large document under bursts of revisions (runtime.md 7.3): 300 nodes in 100 chains, every thumbnail asked
// for, and 200 revisions of one parameter arriving in the three ways an application sends them. What is held:
// the session comes to rest, shows the last revision, leaves no thumbnail stale, and what it emits meanwhile is
// bounded by the size of an idle evaluation (THUMBNAIL_BATCH), not by the size of the graph. Durations are
// reported and nothing is asserted of them.
//
// The case came from the application: such a project "had not become idle 60 seconds after 200 merged
// parameter transactions". Measured there before the idle evaluation had a size: 32 028 node-skipped events
// and 282 evaluations for one such burst, each event one message to the page and one pass of its store.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineEvent } from '../../../src/core/runtime.ts';
import { THUMBNAIL_BATCH } from '../../../src/core/session/scheduler.ts';
import { testGpu } from '../gpu/rig.ts';
import { doc, resetSlow, startSession, type SessionRig } from './rig.ts';
import type { NodeSpec } from '../eval/rig.ts';

await testGpu();

const CHAINS = 100;
const REVISIONS = 200;
/** The nodes of chain `c`, in the order it is evaluated. */
const chain = (c: number): [string, string, string] => [`c${c}a`, `c${c}b`, `c${c}c`];
const IDS = Array.from({ length: CHAINS }, (_, c) => chain(c)).flat();
/**
 * The most nodes the plan of an idle evaluation has here. With every thumbnail of a chain stale, a batch is ten
 * chains and the end of an eleventh, which brings the one or two nodes before it. With the levels fresh and the
 * two gains of every chain stale, a batch is sixteen chains with their levels.
 */
const PLAN_MAX = { fresh: THUMBNAIL_BATCH + 2, gains: THUMBNAIL_BATCH + THUMBNAIL_BATCH / 2 };

/** 100 chains of a level and two gains; `value` is the level of the first chain, which the view shows, `gain` the first gain of every chain. */
function graph(value: number, gain = 2) {
  const nodes: Record<string, NodeSpec> = {};
  for (let c = 0; c < CHAINS; c++) {
    const [a, b, last] = chain(c);
    nodes[a] = { type: 'ref/constant', params: { value: c === 0 ? value : c / CHAINS } };
    nodes[b] = { type: 'ref/gain', params: { gain }, inputs: { in: `${a}.out` } };
    nodes[last] = { type: 'ref/gain', params: { gain: 0.5 }, inputs: { in: `${b}.out` } };
  }
  return doc(nodes, { height: { node: chain(0)[2], port: 'out' } });
}

interface Tally {
  readonly events: number;
  readonly requests: Readonly<Record<string, number>>;
  readonly ends: Readonly<Record<string, number>>;
  readonly skipped: number;
  /** The largest plan of an evaluation made for thumbnails. */
  readonly largestIdlePlan: number;
}

function tally(t: SessionRig, from: number): Tally {
  const events = t.events.slice(from);
  const count = <K extends string>(keys: readonly K[]): Record<K, number> => {
    const out = {} as Record<K, number>;
    for (const key of keys) out[key] = (out[key] ?? 0) + 1;
    return out;
  };
  const idle = new Set(t.of('request-start', from).filter((e) => e.purpose === 'thumbnails').map((e) => e.requestId));
  return {
    events: events.length,
    requests: count(t.of('request-start', from).map((e) => e.purpose)),
    ends: count(t.of('eval-end', from).map((e) => e.status)),
    skipped: t.of('node-skipped', from).length,
    largestIdlePlan: Math.max(0, ...t.of('eval-start', from).filter((e) => idle.has(e.requestId)).map((e) => e.plan.length)),
  };
}

/** Every requested node has a thumbnail of the content it has now. Returns the ids that do not. */
function staleThumbnails(t: SessionRig): string[] {
  const keys = t.of('keys').at(-1)!.keys;
  const latest = new Map<string, string>();
  for (const e of t.of('thumbnail')) latest.set(e.nodeId, e.contentKey);
  return IDS.filter((id) => latest.get(id) !== keys[id]);
}

/** Waits until the session rests with every thumbnail delivered: the atlas is read back in its own time, after the evaluations. */
async function settled(t: SessionRig): Promise<void> {
  // Bounded by the thumbnails that can still arrive: each wait consumes at least one event.
  for (let round = 0; round < 4 * IDS.length; round++) {
    await t.idle();
    if (staleThumbnails(t).length === 0) return;
    await t.next('thumbnail');
  }
}

const shownRevision = (t: SessionRig): number | undefined => t.of('view-updated').at(-1)?.revision;
const say = (name: string, ms: number, n: Tally): string =>
  `${name}: at rest ${ms.toFixed(0)} ms after its first revision; ${n.events} events, requests ${JSON.stringify(n.requests)}, ended ${JSON.stringify(n.ends)}, `
  + `${n.skipped} node-skipped, largest idle plan ${n.largestIdlePlan}`;

test(`${IDS.length} nodes with every thumbnail asked for: bursts of ${REVISIONS} revisions leave the session at rest, the last one shown, and a bounded stream of events`, async (t) => {
  resetSlow();
  const s = await startSession();
  try {
    let revision = 0;
    s.session.requestThumbnails(IDS);

    // ---- 1. the project is loaded: the view, then the idle evaluations, each of a bounded size ----
    let from = s.mark();
    let began = performance.now();
    s.session.setDocument(graph(0.25), ++revision);
    await settled(s);
    const load = tally(s, from);
    t.diagnostic(say('load', performance.now() - began, load));
    assert.deepEqual(staleThumbnails(s), []);
    assert.equal(shownRevision(s), revision);
    assert.equal(load.requests.view, 1);
    assert.equal(load.requests.thumbnails, Math.ceil((IDS.length - 3) / THUMBNAIL_BATCH), 'the nodes beside the view chain, a batch at a time');
    assert.ok(load.largestIdlePlan <= PLAN_MAX.fresh, `an idle evaluation has ${load.largestIdlePlan} nodes in its plan`);
    assert.deepEqual(load.ends, { ok: load.requests.view + load.requests.thumbnails });

    // ---- 2. the worst a run of edits does: each revision arrives as the idle evaluation after the one before starts ----
    // Another gain in every chain makes 200 thumbnails stale, as after a project is opened: an idle evaluation
    // follows every view evaluation, and the next revision aborts it before its first node.
    let sent = 0;
    const first = revision + 1;
    const stop = s.session.subscribe((e: EngineEvent) => {
      if (e.type !== 'request-start' || e.purpose !== 'thumbnails' || sent >= REVISIONS) return;
      sent++;
      s.session.setDocument(graph(1 + sent / REVISIONS, 3), ++revision);
    });
    from = s.mark();
    began = performance.now();
    s.session.setDocument(graph(1, 3), ++revision);
    await settled(s);
    stop();
    assert.equal(sent, REVISIONS, 'every revision of the run was sent, each aborting the idle evaluation that had just started');
    const run = tally(s, from);
    t.diagnostic(say(`a run of ${REVISIONS} edits`, performance.now() - began, run));
    assert.equal(shownRevision(s), revision, `the last of the revisions ${first}..${revision} is shown`);
    assert.deepEqual(staleThumbnails(s), [], 'no thumbnail is left stale');
    // Each revision is evaluated for the view at most once, and aborts at most one idle evaluation.
    assert.ok(run.requests.view! <= REVISIONS + 1, `${run.requests.view} view evaluations`);
    assert.ok(run.requests.thumbnails! <= REVISIONS + 2 * Math.ceil(IDS.length / THUMBNAIL_BATCH), `${run.requests.thumbnails} idle evaluations`);
    assert.ok(run.ends.aborted! >= REVISIONS, 'each revision aborted the idle evaluation it met');
    assert.ok(THUMBNAIL_BATCH <= 64, 'an idle evaluation is small beside a graph of hundreds of nodes');
    assert.ok(run.largestIdlePlan <= PLAN_MAX.gains, `an idle evaluation has ${run.largestIdlePlan} nodes in its plan`);
    // What an abort costs is the plan of the evaluation it ends, and an idle evaluation has a size: the 200 stale
    // nodes of this document in one evaluation would be 300 events for every revision.
    assert.ok(run.skipped <= (REVISIONS + 1) * PLAN_MAX.gains, `${run.skipped} node-skipped events for ${REVISIONS} aborted idle evaluations: more than ${PLAN_MAX.gains} each`);

    // ---- 3. a burst in one task: nothing in between is evaluated ----
    from = s.mark();
    began = performance.now();
    for (let i = 1; i <= REVISIONS; i++) s.session.setDocument(graph(3 + i / REVISIONS, 3), ++revision);
    await settled(s);
    const burst = tally(s, from);
    t.diagnostic(say(`${REVISIONS} revisions in one task`, performance.now() - began, burst));
    assert.equal(shownRevision(s), revision);
    assert.deepEqual(staleThumbnails(s), []);
    assert.ok(burst.requests.view! <= 2, 'the first, which started in the task it was set in, and the last');
    assert.ok(burst.events <= 100, `${burst.events} events for a burst of which one revision is evaluated`);

    // ---- 4. a gesture: drafts that run through, no idle evaluation in between, and the refinement at its end ----
    from = s.mark();
    began = performance.now();
    s.session.beginGesture();
    for (let i = 1; i <= REVISIONS; i++) {
      s.session.setDocument(graph(5 + i / REVISIONS, 3), ++revision);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    s.session.endGesture();
    await settled(s);
    const gesture = tally(s, from);
    t.diagnostic(say(`a gesture of ${REVISIONS} revisions`, performance.now() - began, gesture));
    assert.equal(shownRevision(s), revision);
    assert.equal(s.of('view-updated').at(-1)!.draft, false, 'refined at the end of the gesture');
    assert.deepEqual(staleThumbnails(s), []);
    assert.ok(gesture.requests.draft! <= REVISIONS && gesture.requests.view! <= 2);
    assert.ok(gesture.skipped <= 2 * PLAN_MAX.gains);
  } finally {
    await s.dispose();
  }
});
