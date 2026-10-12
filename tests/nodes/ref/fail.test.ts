// tests/nodes/ref/fail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformance, expectIdentical, fixtures, NodeFailure, renderNode, traceNode } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/ref/fail.ts';

conformance(def);

test('ref/fail: a message is the error of the node, word for word', async () => {
  await assert.rejects(renderNode(def, { params: { message: 'Reference failure' } }), (thrown: unknown) => {
    assert.ok(thrown instanceof NodeFailure);
    assert.equal(thrown.message, 'Reference failure');
    assert.equal(thrown.error.kind, 'node-exception');
    assert.equal(thrown.report.nodes.node.state, 'error');
    return true;
  });
});

test('ref/fail: without a message the output is the input itself', async () => {
  const { outputs, report } = await traceNode(def, { inputs: { in: 'terrain' } });
  expectIdentical(outputs.out, fixtures.terrain(257));
  // An input passed straight to ctx.output() is an alias: the node holds no texture of its own.
  assert.equal(report.nodes.node.state, 'done');
  assert.equal(report.nodes.node.peakBytes, 0);
});
