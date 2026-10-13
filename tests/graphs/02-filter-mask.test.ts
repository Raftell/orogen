// Acceptance graph 02 (testing.md 10.2): a filter under a mask. One source read by three nodes, physical slopes,
// the blend a maskable node gets from the evaluator, bypass, a node's own unconnected mask, statistics of the
// whole field, and what an edit re-evaluates.
//
// Sizes: fields of at most 513 x 513, compared by the harness; no field is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { connect, disconnect, type DocDraft, type GraphDoc } from '../../src/core/runtime.ts';
import {
  diff, expectClose, expectIdentical, expectLadder, expectMask, expectStats, getEngine, openGraph, renderGraph, type FieldData,
} from '../helpers/index.ts';
import { expectTargets, fieldFrom, graphFile, states } from './_graphs.ts';

const GRAPH = graphFile('02-filter-mask');
const TARGETS = ['level.out', 'steep.out'];
const ALL = ['fbm.out', 'steep.out', 'blur.out', 'idle.out', 'peaks.out', 'level.out'];
const NODES = ['fbm', 'steep', 'blur', 'idle', 'peaks', 'level'];

/** The document of the graph with one change, under the ids of the file. */
function edited(doc: GraphDoc, change: (draft: DocDraft) => void): GraphDoc {
  const draft = structuredClone(doc) as DocDraft;
  change(draft);
  return draft as GraphDoc;
}
const maskEdges = (doc: GraphDoc): string[] => Object.values(doc.edges).filter((edge) => edge.to.node === 'blur' && edge.to.port === 'mask').map((edge) => edge.id);

test('02-filter-mask: the statistics at 257 are those of the expectation file', async () => {
  const { fields, report } = await renderGraph(GRAPH, ALL);
  assert.equal(report.status, 'ok');
  expectTargets('02-filter-mask', fields);
});

test('02-filter-mask: the source runs once although three nodes read it; the bypassed node passes its input on', async () => {
  const { fields, report } = await renderGraph(GRAPH, [...TARGETS, 'blur.out', 'idle.out']);
  assert.equal(report.status, 'ok');
  const ran = (id: string): number => report.events.filter((event) => event.type === 'node-start' && event.nodeId === id).length;
  assert.deepEqual([ran('fbm'), report.nodes.fbm!.state], [1, 'done']);
  assert.deepEqual(states(report, NODES), ['fbm: done', 'steep: done', 'blur: done', 'idle: bypassed', 'peaks: done', 'level: done']);
  assert.equal(ran('idle'), 0, 'a bypassed node does not run');
  expectIdentical(fields['idle.out']!, fields['blur.out']!);
  assert.equal(report.nodesRun, 5);
});

test('02-filter-mask: the slope mask is a mask of physical slopes: twice the height range changes it and leaves the terrain as it is', async () => {
  const session = await openGraph(GRAPH);
  try {
    const before = await session.evaluate(['steep.out', 'fbm.out']);
    expectMask(before.fields['steep.out']!);
    session.setSettings({ heightRange: 2048 });
    const after = await session.evaluate(['steep.out', 'fbm.out']);
    expectMask(after.fields['steep.out']!);
    expectIdentical(after.fields['fbm.out']!, before.fields['fbm.out']!);
    const changed = diff(after.fields['steep.out']!, before.fields['steep.out']!);
    assert.ok(changed.differing > 0.05 * before.fields['steep.out']!.data.length && changed.max > 0.5, `${changed.differing} texels of the mask changed, by up to ${changed.max}`);
    // Twice as steep: more of the terrain is above the lower angle.
    const share = (f: FieldData): number => f.data.reduce((sum, v) => sum + v, 0) / f.data.length;
    assert.ok(share(after.fields['steep.out']!) > share(before.fields['steep.out']!) + 0.05);
  } finally {
    await session.close();
  }
});

test('02-filter-mask: the mask of a maskable node blends its result over its input', async () => {
  const { fields } = await renderGraph(GRAPH, ['fbm.out', 'steep.out', 'blur.out']);
  // B: what the blur makes of the terrain with its mask disconnected.
  const session = await openGraph(GRAPH);
  let unmasked: FieldData;
  try {
    assert.equal(maskEdges(session.doc).length, 1);
    const plain = edited(session.doc, (draft) => disconnect(draft, maskEdges(session.doc)));
    unmasked = (await renderGraph(plain, ['blur.out'])).fields['blur.out']!;
  } finally {
    await session.close();
  }
  const fbm = fields['fbm.out']!, mask = fields['steep.out']!;
  const blended = fieldFrom(fbm, (i) => fbm.data[i]! + (unmasked.data[i]! - fbm.data[i]!) * mask.data[i]!);
  expectClose(fields['blur.out']!, blended, { max: 1e-6 });
  // The blur does something, and the mask keeps part of the terrain from it: neither end of the blend is the result.
  assert.ok(diff(unmasked, fbm).max > 1e-3 && diff(fields['blur.out']!, unmasked).max > 1e-3 && diff(fields['blur.out']!, fbm).max > 1e-3);
});

test('02-filter-mask: an unconnected mask of the node\'s own reads 1, and the statistics node stretches its input to 0..1', async () => {
  const { fields } = await renderGraph(GRAPH, ['idle.out', 'fbm.out', 'peaks.out', 'level.out']);
  const idle = fields['idle.out']!, fbm = fields['fbm.out']!;
  // mode `max` at strength 1 under a mask of 1: the higher of the two.
  expectClose(fields['peaks.out']!, fieldFrom(fbm, (i) => Math.max(idle.data[i]!, fbm.data[i]!)), { max: 1e-6 });
  expectStats(fields['level.out']!, { min: [-1e-6, 1e-6], max: [1 - 1e-6, 1 + 1e-6] });
});

test('02-filter-mask: 257 and 513 agree within the tolerance of each node; the statistics node is not compared', async () => {
  const compared = ['fbm.out', 'steep.out', 'blur.out', 'peaks.out'];
  const coarse = (await renderGraph(GRAPH, compared, { res: 257 })).fields;
  const fine = (await renderGraph(GRAPH, compared, { res: 513 })).fields;
  expectLadder(coarse['fbm.out']!, fine['fbm.out']!, { max: 1e-6 });
  // ref/slope-mask declares a tolerance of 0.08: it measures slope. The others have the default of testing.md 3.4.
  expectLadder(coarse['steep.out']!, fine['steep.out']!, { rel: 0.08 });
  expectLadder(coarse['blur.out']!, fine['blur.out']!, { rel: 0.01 });
  expectLadder(coarse['peaks.out']!, fine['peaks.out']!, { rel: 0.01 });
});

test('02-filter-mask: a changed parameter re-evaluates the node and what reads it, and nothing else', async () => {
  const session = await openGraph(GRAPH);
  try {
    const first = await session.evaluate(TARGETS);
    assert.deepEqual(states(first.report, NODES), ['fbm: done', 'steep: done', 'blur: done', 'idle: bypassed', 'peaks: done', 'level: done']);
    session.setParam('peaks', 'strength', 0.5);
    const second = await session.evaluate(TARGETS);
    assert.deepEqual(states(second.report, NODES), ['fbm: cached', 'steep: cached', 'blur: cached', 'idle: bypassed', 'peaks: done', 'level: done']);
    assert.equal(second.report.nodesRun, 2);
    expectIdentical(second.fields['steep.out']!, first.fields['steep.out']!);
    assert.ok(diff(second.fields['level.out']!, first.fields['level.out']!).max > 1e-4, 'half the strength is another result');
  } finally {
    await session.close();
  }
});

test('02-filter-mask: a mask reconnected to another source repeats the blend and not the node', async () => {
  const { registry } = (await getEngine()).engine;
  const session = await openGraph(GRAPH);
  try {
    const first = await session.evaluate(['blur.out', 'fbm.out']);
    assert.equal(first.report.nodes.blur!.state, 'done');
    // The same document with only the mask of `blur` connected elsewhere: to the terrain, read as a mask. A second
    // session opened while the first is open shares its cache.
    const rewired = edited(session.doc, (draft) => { connect(draft, registry, { node: 'fbm', port: 'out' }, { node: 'blur', port: 'mask' }); });
    assert.deepEqual(Object.values(rewired.edges).filter((edge) => edge.to.node === 'blur').map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.port}`).sort(), ['fbm.out>in', 'fbm.out>mask']);
    const other = await openGraph(rewired);
    try {
      const second = await other.evaluate(['blur.out']);
      assert.deepEqual(states(second.report, ['fbm', 'blur']), ['fbm: cached', 'blur: cached'], 'runtime.md 5.6: the node\'s own result is reused');
      assert.equal(second.report.nodesRun, 0);
      assert.ok(diff(second.fields['blur.out']!, first.fields['blur.out']!).max > 1e-3, 'and blended anew under the other mask');
      // Asked for again, the blend under the new mask is what it was.
      expectIdentical((await other.evaluate(['blur.out'])).fields['blur.out']!, second.fields['blur.out']!);
    } finally {
      await other.close();
    }
  } finally {
    await session.close();
  }
});
