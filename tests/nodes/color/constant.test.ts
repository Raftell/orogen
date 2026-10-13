// tests/nodes/color/constant.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorOf, conformance, expectClose, expectIdentical, renderNode } from '../../helpers/index.ts';
import type { ColorParam } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/color/constant.ts';

conformance(def);

/** What a value stored in a `color` field may differ by from a float32 computation (testing.md 3.4). */
const COLOR = 2e-3;

const DEFAULT = def.params.find((param): param is ColorParam => param.kind === 'color')!.default;

test('color/constant: every texel holds the color, opaque, at every resolution', async () => {
  for (const res of [33, 257, 513]) {
    const { out } = await renderNode(def, { res });
    assert.equal(out.kind, 'color');
    expectClose(out, colorOf(res, () => [DEFAULT[0], DEFAULT[1], DEFAULT[2], 1]), { max: COLOR });
  }
  for (const color of [[0.8, 0.05, 0.4], [0.02, 0.6, 0.9]] as const) {
    const { out } = await renderNode(def, { params: { color } });
    expectClose(out, colorOf(257, () => [color[0], color[1], color[2], 1]), { max: COLOR });
  }
});

test('color/constant: black and white are stored exactly, and the three channels are not mixed up', async () => {
  // 0, 0.5 and 1 are numbers a half float holds.
  for (const color of [[0, 0, 0], [1, 1, 1], [1, 0.5, 0], [0, 1, 0.5], [0.5, 0, 1]] as const) {
    const { out } = await renderNode(def, { params: { color } });
    expectIdentical(out, colorOf(257, () => [color[0], color[1], color[2], 1]));
  }
});
