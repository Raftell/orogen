// Acceptance graph 01 (testing.md 10.2): one generator. What a generator promises, end to end through the
// project file, the evaluator and the cache.
//
// Sizes: fields of at most 513 x 513, compared by the harness; no field is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diff, expectIdentical, expectLadder, openGraph, renderGraph, stats } from '../helpers/index.ts';
import { expectTargets, graphFile } from './_graphs.ts';

const GRAPH = graphFile('01-generate');

test('01-generate: the statistics at 257 are those of the expectation file, and the generator range rule holds', async () => {
  const { fields, report } = await renderGraph(GRAPH, ['fbm.out']);
  assert.equal(report.status, 'ok');
  assert.equal(fields['fbm.out']!.width, 257, 'the preview resolution of the project: level 1 of 513');
  expectTargets('01-generate', fields);
  // engine.md 1.7: a generator fills 0..1 without leaving it.
  const { min, max, mean } = stats(fields['fbm.out']!);
  assert.ok(min >= -0.05 && max <= 1.05 && max - min >= 0.5 && mean >= 0.25 && mean <= 0.75, `min ${min}, max ${max}, mean ${mean}`);
});

test('01-generate: 129, 257 and 513 agree at shared vertices', async () => {
  const at = async (res: number) => (await renderGraph(GRAPH, ['fbm.out'], { res })).fields['fbm.out']!;
  const [coarse, middle, fine] = [await at(129), await at(257), await at(513)];
  expectLadder(coarse, middle, { max: 1e-6 });
  expectLadder(middle, fine, { max: 1e-6 });
  expectLadder(coarse, fine, { max: 1e-6 });
});

test('01-generate: a second evaluation of the unchanged document is a cache hit', async () => {
  const session = await openGraph(GRAPH);
  try {
    const first = await session.evaluate(['fbm.out']);
    assert.deepEqual([first.report.nodes.fbm!.state, first.report.nodesRun], ['done', 1]);
    const second = await session.evaluate(['fbm.out']);
    assert.deepEqual([second.report.nodes.fbm!.state, second.report.nodesRun, second.report.nodesCached], ['cached', 0, 1]);
    expectIdentical(second.fields['fbm.out']!, first.fields['fbm.out']!);
  } finally {
    await session.close();
  }
});

test('01-generate: the project seed and the node seed each give another terrain, and not the same one', async () => {
  const session = await openGraph(GRAPH);
  try {
    const base = (await session.evaluate(['fbm.out'])).fields['fbm.out']!;
    const count = base.data.length;
    session.setSettings({ seed: 2 });
    const byProject = (await session.evaluate(['fbm.out'])).fields['fbm.out']!;
    session.setSettings({ seed: 1 });
    session.setParam('fbm', 'seed', 1);
    const byNode = (await session.evaluate(['fbm.out'])).fields['fbm.out']!;
    assert.ok(diff(base, byProject).differing > 0.01 * count, `the project seed 2 changes ${diff(base, byProject).differing} of ${count} values`);
    assert.ok(diff(base, byNode).differing > 0.01 * count, `the node seed 1 changes ${diff(base, byNode).differing} of ${count} values`);
    assert.ok(diff(byProject, byNode).differing > 0.01 * count, 'the two seeds are mixed, not added: project 2 with node 0 is not project 1 with node 1');
  } finally {
    await session.close();
  }
});

test('01-generate: twice the terrain size and twice the height range leave the output bit-identical: the graph describes a shape in a unit box', async () => {
  const session = await openGraph(GRAPH);
  try {
    const base = (await session.evaluate(['fbm.out'])).fields['fbm.out']!;
    session.setSettings({ terrainSize: 8192, heightRange: 2048 });
    const larger = await session.evaluate(['fbm.out']);
    assert.equal(larger.report.status, 'ok');
    expectIdentical(larger.fields['fbm.out']!, base);
  } finally {
    await session.close();
  }
});

test('01-generate: preview mode and build mode give bit-identical output', async () => {
  const preview = await renderGraph(GRAPH, ['fbm.out'], { mode: 'preview', res: 257 });
  const build = await renderGraph(GRAPH, ['fbm.out'], { mode: 'build', res: 257 });
  expectIdentical(build.fields['fbm.out']!, preview.fields['fbm.out']!);
  // And at the resolution each mode has by itself, a build is the finer level of the same terrain.
  const whole = await renderGraph(GRAPH, ['fbm.out'], { mode: 'build' });
  assert.equal(whole.fields['fbm.out']!.width, 513);
  expectLadder(preview.fields['fbm.out']!, whole.fields['fbm.out']!, { max: 1e-6 });
});
