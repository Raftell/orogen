// tests/nodes/adjust/switch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, colorOf, conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode, traceNode } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/adjust/switch.ts';
import { half, WIDE, WIDE_COLOR } from './_reference.ts';

conformance(def);

// The default inputs of the node: four different fields.
const INPUTS = { a: fixtures.terrain(257), b: fixtures.cone(257), c: fixtures.rampX(257), d: fixtures.basin(257) };

for (const mode of ['a', 'b', 'c', 'd'] as const) {
  test(`adjust/switch: mode ${mode} passes input \`${mode}\` through, bit for bit and at no cost`, async () => {
    const { outputs, report } = await traceNode(def, { inputs: INPUTS, params: { mode } });
    expectIdentical(outputs.out, INPUTS[mode]);
    assert.equal(report.nodes.node.peakBytes, 0, 'the input itself is the output: no texture, no pass');
  });
}

test('adjust/switch: the node starts on its first input', () => {
  assert.equal(def.params[0].default, 'a');
});

test('adjust/switch: values outside 0..1 pass unchanged', async () => {
  expectIdentical((await renderNode(def, { inputs: { a: 'terrain', b: WIDE, c: null, d: null }, params: { mode: 'b' } })).out, WIDE);
});

test('adjust/switch: an input with nothing connected passes the first input instead', async () => {
  for (const mode of ['b', 'c', 'd']) {
    const { out } = await renderNode(def, { inputs: { a: INPUTS.a, b: null, c: null, d: null }, params: { mode } });
    expectIdentical(out, INPUTS.a);
  }
  // Only the chosen one counts: `c` is connected, `b` is not.
  const { out } = await renderNode(def, { inputs: { a: INPUTS.a, b: null, c: INPUTS.c, d: null }, params: { mode: 'c' } });
  expectIdentical(out, INPUTS.c);
});

test('adjust/switch: colors are switched as heights are, alpha included', async () => {
  const other = colorOf(257, (u, v) => [half(v), half(1 - u), half(0.5), half(0.25 + 0.5 * v)]);
  for (const [mode, expected] of [['a', WIDE_COLOR], ['b', other], ['c', WIDE_COLOR]] as const) {
    const { out } = await renderNode(def, { inputs: { a: WIDE_COLOR, b: other, c: null, d: null }, params: { mode } });
    assert.equal(out.kind, 'color');
    expectIdentical(out, expected);
  }
});

test('adjust/switch: the output has the kind of the first input, and a chosen input of the other kind is converted as a connection would be', async () => {
  const color = colorOf(257, (u, v) => [half(u), half(v), half(1 - u), half(0.5)]);
  const field = fieldOf(257, (u, v) => half(-0.5 + 1.5 * u + 0.5 * v));

  // A color chosen on a switch of heights is its luminance.
  const asField = await renderNode(def, { inputs: { a: field, b: color, c: null, d: null }, params: { mode: 'b' } });
  assert.equal(asField.out.kind, 'field');
  expectClose(asField.out, fieldOf(257, (u, v) => 0.2126 * half(u) + 0.7152 * half(v) + 0.0722 * half(1 - u)), { max: 1e-6 });

  // A height chosen on a switch of colors is grey and opaque.
  const asColor = await renderNode(def, { inputs: { a: color, b: field, c: null, d: null }, params: { mode: 'b' } });
  assert.equal(asColor.out.kind, 'color');
  for (const channel of [0, 1, 2] as const) expectIdentical(channelOf(asColor.out, channel), field);
  expectIdentical(channelOf(asColor.out, 3), fixtures.one(257));
});
