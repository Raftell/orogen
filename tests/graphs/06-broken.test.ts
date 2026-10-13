// Acceptance graph 06 (testing.md 10.2): everything that can be wrong with a document at once. A node of a type
// no build has, a node that throws, a version that needs migrating, an unconnected input and a cycle. Each is
// reported for what it is, and one failing branch does not stop another.
//
// Sizes: fields of 257 x 257, compared by the harness; no field is handed to an assertion of node:assert.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { parseDoc, serializeDoc } from '../../src/core/runtime.ts';
import { expectClose, expectFinite, expectNoLeaks, getEngine, renderGraph } from '../helpers/index.ts';
import { expectTargets, fieldFrom, graphFile, states } from './_graphs.ts';

const GRAPH = graphFile('06-broken');
/** The three outputs that can be made, and every other node as a node to run. */
const TARGETS = ['fbm.out', 'good.out', 'old.out', 'ghost', 'after', 'bad', 'down', 'open', 'loopa', 'loopb'];

test('06-broken: the document loads with its problems named, and is written back as it was read', async () => {
  const { registry } = (await getEngine()).engine;
  const text = fs.readFileSync(GRAPH, 'utf8');
  const { doc, problems } = parseDoc(text, registry);
  assert.ok(problems.some((problem) => problem.nodeId === 'ghost'), `a problem for the node of unknown type: ${JSON.stringify(problems)}`);
  const cycle = problems.filter((problem) => /cycle/i.test(problem.message));
  assert.ok(cycle.length >= 1 && cycle.every((problem) => ['loopa-out-loopb-in', 'loopb-out-loopa-in'].includes(problem.edgeId ?? '')), `a problem for the cycle: ${JSON.stringify(cycle)}`);

  // A node of a type this build lacks is kept as the file holds it: its parameters and its connections.
  const stored = JSON.parse(text) as { nodes: Record<string, unknown>; edges: Record<string, unknown> };
  assert.deepEqual(doc.nodes.ghost, stored.nodes.ghost);
  assert.deepEqual(doc.nodes.ghost!.params, { foo: 1, bar: 'x' });
  for (const edge of ['fbm-out-ghost-in', 'ghost-out-after-in']) assert.deepEqual(doc.edges[edge], stored.edges[edge], edge);

  // The node stored at version 1 is migrated on load: `amount` in percent became `strength`.
  assert.deepEqual([doc.nodes.old!.version, doc.nodes.old!.params], [2, { mode: 'mix', strength: 0.25 }]);

  // Written and read again, the document is the same one.
  const again = parseDoc(serializeDoc(doc), registry);
  assert.deepEqual(again.doc, doc);
  assert.deepEqual(again.problems.map((problem) => problem.nodeId ?? problem.edgeId).sort(), problems.map((problem) => problem.nodeId ?? problem.edgeId).sort());
});

test('06-broken: every broken node is reported for what it is, and the branches that can run do', async () => {
  const { fields, report } = await renderGraph(GRAPH, TARGETS);
  assert.equal(report.status, 'errors');
  assert.deepEqual(states(report, ['fbm', 'good', 'old', 'ghost', 'after', 'bad', 'down', 'open', 'loopa', 'loopb']), [
    'fbm: done', 'good: done', 'old: done', 'ghost: error', 'after: error', 'bad: error', 'down: skipped', 'open: error', 'loopa: error', 'loopb: error',
  ]);
  const error = (id: string): string => `${report.nodes[id]!.error!.kind}: ${report.nodes[id]!.error!.message}`;
  assert.equal(report.nodes.ghost!.error!.kind, 'unknown-type');
  // An edge from a node of unknown type is ignored (runtime.md 4.3): what reads it has no input.
  assert.equal(error('after'), 'missing-input: missing input "in"');
  assert.equal(error('bad'), 'node-exception: Reference failure');
  assert.deepEqual([report.nodes.down!.skipReason, report.nodes.down!.upstream], ['upstream', 'bad']);
  assert.equal(error('open'), 'missing-input: missing input "in"');
  assert.deepEqual([report.nodes.loopa!.error!.kind, report.nodes.loopb!.error!.kind], ['cycle', 'cycle']);

  // One failing branch does not stop another: the three outputs are delivered, finite, and as the expectation file has them.
  assert.deepEqual(Object.keys(fields).sort(), ['fbm.out', 'good.out', 'old.out']);
  for (const field of Object.values(fields)) expectFinite(field);
  expectTargets('06-broken', fields);
  assert.equal(report.nodesRun, 3);

  // The migrated node blends by a quarter: mode `mix`, strength 0.25, its own mask unconnected.
  const fbm = fields['fbm.out']!, good = fields['good.out']!;
  expectClose(fields['old.out']!, fieldFrom(fbm, (i) => fbm.data[i]! + (good.data[i]! - fbm.data[i]!) * 0.25), { max: 1e-6 });
  await expectNoLeaks();
});
