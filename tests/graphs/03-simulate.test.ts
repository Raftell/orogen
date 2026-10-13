// Acceptance graph 03 (testing.md 10.2): an iterative simulation. An output nobody wants is not made, a loop
// reports progress and is the same in any slicing, a cancelled evaluation leaves what had completed, a data field
// drives a mask, and a budget that is too small stops the node that needs the memory and nothing before it.
//
// The numbers of bytes are those of 257 x 257 fields of four bytes a value: 264 196 each.
//
// Sizes: fields of 257 x 257, compared by the harness; no field is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  expectClose, expectFinite, expectIdentical, expectNoLeaks, openGraph, renderGraph, stats,
} from '../helpers/index.ts';
import { expectTargets, fieldFrom, graphFile, saturate, states } from './_graphs.ts';

const GRAPH = graphFile('03-simulate');
const FIELD = 257 * 257 * 4;

test('03-simulate: the statistics at 257 are those of the expectation file', async () => {
  const { fields, report } = await renderGraph(GRAPH, ['fbm.out', 'talus.out', 'talus.moved', 'steep.out', 'dist.out', 'mixed.out']);
  assert.equal(report.status, 'ok');
  expectTargets('03-simulate', fields);
});

test('03-simulate: an output nobody wants is not made, and the node runs again when it is wanted', async () => {
  const session = await openGraph(GRAPH);
  try {
    // `out` alone: the two fields of the ping-pong, and no accumulator.
    const alone = await session.evaluate(['talus.out']);
    assert.deepEqual(states(alone.report, ['fbm', 'talus']), ['fbm: done', 'talus: done']);
    assert.equal(alone.report.nodes.talus!.peakBytes, 2 * FIELD);
    assert.equal(2 * FIELD, 528_392);

    // `mixed` reads `moved` as its mask: the cache entry of `talus` lacks it, so the node runs again, with a third field.
    const both = await session.evaluate(['mixed.out', 'talus.out']);
    assert.deepEqual(states(both.report, ['fbm', 'talus', 'mixed']), ['fbm: cached', 'talus: done', 'mixed: done']);
    assert.equal(both.report.nodes.talus!.peakBytes, 3 * FIELD);
    assert.equal(3 * FIELD, 792_588);
    expectIdentical(both.fields['talus.out']!, alone.fields['talus.out']!);

    // The progress of the loop stays within 0..1 and never falls.
    for (const { report } of [alone, both]) {
      const fractions = report.nodes.talus!.progress;
      assert.ok(fractions.length > 0, 'the loop reports progress');
      let falls = 0, outside = 0;
      for (const [i, fraction] of fractions.entries()) {
        if (!(fraction >= 0 && fraction <= 1)) outside++;
        if (i > 0 && fraction < fractions[i - 1]!) falls++;
      }
      assert.deepEqual([outside, falls], [0, 0], `of ${fractions.length} fractions`);
    }
  } finally {
    await session.close();
  }
});

test('03-simulate: the relaxation conserves material, a data field drives a mask, and the distance is 0 on what it is measured from', async () => {
  const { fields, report } = await renderGraph(GRAPH, ['fbm.out', 'talus.out', 'talus.moved', 'steep.out', 'dist.out', 'mixed.out']);
  assert.equal(report.status, 'ok');
  const fbm = fields['fbm.out']!, out = fields['talus.out']!, moved = fields['talus.moved']!;
  const drift = Math.abs(stats(out).mean - stats(fbm).mean);
  assert.ok(drift <= 1e-5, `|mean(talus.out) - mean(fbm.out)| is ${drift}; allowed 1e-5`);
  assert.ok(stats(moved).max > 0.01, 'the terrain has slopes above 30 degrees: material moved');

  // `moved` is a height that crossed each texel, not limited to 0..1; a mask input saturates what it reads.
  assert.ok(stats(moved).min >= 0);
  expectClose(fields['mixed.out']!, fieldFrom(out, (i) => out.data[i]! + (fbm.data[i]! - out.data[i]!) * saturate(moved.data[i]!)), { max: 1e-6 });

  expectFinite(fields['dist.out']!);
  const steep = fields['steep.out']!, dist = fields['dist.out']!;
  let selected = 0, off = 0;
  for (let i = 0; i < steep.data.length; i++) {
    if (steep.data[i]! < 0.5) continue;
    selected++;
    if (dist.data[i] !== 0) off++;
  }
  assert.ok(selected > 100 && selected < steep.data.length, `${selected} texels are selected`);
  assert.equal(off, 0, 'selected texels whose distance is not 0');
  assert.ok(stats(dist).max > 0, 'and it is above 0 somewhere else');
});

test('03-simulate: every dispatch its own slice, or no slicing at all: the same result, bit for bit', async () => {
  const small = await renderGraph(GRAPH, ['talus.out', 'talus.moved'], { slices: 'small' });
  const one = await renderGraph(GRAPH, ['talus.out', 'talus.moved'], { slices: 'one' });
  assert.deepEqual([small.report.status, one.report.status], ['ok', 'ok']);
  expectIdentical(small.fields['talus.out']!, one.fields['talus.out']!);
  expectIdentical(small.fields['talus.moved']!, one.fields['talus.moved']!);
  assert.ok(small.report.nodes.talus!.slices > one.report.nodes.talus!.slices, `${small.report.nodes.talus!.slices} slices against ${one.report.nodes.talus!.slices}`);
});

test('03-simulate: an evaluation aborted inside the loop leaves what had completed, and the next one gives the same result', async () => {
  const whole = await renderGraph(GRAPH, ['talus.out', 'talus.moved'], { slices: 'small' });
  const session = await openGraph(GRAPH);
  try {
    const controller = new AbortController();
    let slicesOfTalus = 0;
    const aborted = await session.evaluate(['talus.out', 'talus.moved'], {
      slices: 'small', signal: controller.signal,
      onSlice(slice) {
        if (slice.nodeId === 'talus' && ++slicesOfTalus === 2) controller.abort(new Error('cancelled by the test'));
      },
    });
    assert.equal(aborted.report.status, 'aborted');
    assert.deepEqual(states(aborted.report, ['fbm', 'talus']), ['fbm: done', 'talus: skipped']);
    assert.equal(aborted.report.nodes.talus!.skipReason, 'aborted');
    assert.deepEqual(Object.keys(aborted.fields), [], 'no target was delivered');

    // The same slicing, so the same engine and its cache: `fbm` had completed and is not computed again.
    const again = await session.evaluate(['talus.out', 'talus.moved'], { slices: 'small' });
    assert.equal(again.report.status, 'ok');
    assert.deepEqual(states(again.report, ['fbm', 'talus']), ['fbm: cached', 'talus: done']);
    expectIdentical(again.fields['talus.out']!, whole.fields['talus.out']!);
    expectIdentical(again.fields['talus.moved']!, whole.fields['talus.moved']!);
  } finally {
    await session.close();
  }
});

test('03-simulate: a budget too small for the simulation stops it in a preview where it runs, and a build before anything runs', async () => {
  // 600 000 bytes hold two fields of 257 x 257. The noise needs one; the relaxation, its input held, needs three more.
  const preview = await renderGraph(GRAPH, ['mixed.out'], { fieldBudgetBytes: 600_000 });
  assert.equal(preview.report.status, 'errors');
  assert.deepEqual(states(preview.report, ['fbm', 'talus', 'mixed']), ['fbm: done', 'talus: error', 'mixed: skipped']);
  assert.equal(preview.report.nodes.talus!.error!.kind, 'budget');
  assert.deepEqual([preview.report.nodes.mixed!.skipReason, preview.report.nodes.mixed!.upstream], ['upstream', 'talus']);
  assert.deepEqual(Object.keys(preview.fields), []);
  await expectNoLeaks();

  // A build checks its memory before it starts (runtime.md 5.3): nothing runs, and one node says why.
  const build = await renderGraph(GRAPH, ['mixed.out'], { mode: 'build', res: 257, fieldBudgetBytes: 600_000 });
  assert.equal(build.report.status, 'errors');
  assert.equal(build.report.nodesRun, 0);
  const failed = Object.values(build.report.nodes).filter((node) => node.state === 'error');
  assert.deepEqual(failed.map((node) => node.error!.kind), ['budget']);
  assert.equal(build.report.events.filter((event) => event.type === 'node-start').length, 0, 'no node started');
  await expectNoLeaks();

  // With the budget of the harness the same build is fine.
  assert.equal((await renderGraph(GRAPH, ['mixed.out'], { mode: 'build', res: 257 })).report.status, 'ok');
});
