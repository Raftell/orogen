// tests/nodes/generate/constant.test.ts
import { test } from 'node:test';
import { conformance, expectStats, renderNode } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/generate/constant.ts';

conformance(def, {
  skip: { 'generator-range': 'Outputs one height on every texel by design: its span is 0, and its mean is whatever height is set.' },
});

test('generate/constant: every texel holds the height, at every resolution', async () => {
  // The default is the middle of the range. A field holds float32: 0.3 arrives as the float32 nearest to it.
  for (const res of [33, 257, 513]) {
    expectStats((await renderNode(def, { res })).out, { min: [0.5, 0.5], max: [0.5, 0.5] });
  }
  for (const height of [0, 0.3, 1]) {
    const stored = Math.fround(height);
    expectStats((await renderNode(def, { params: { height } })).out, { min: [stored, stored], max: [stored, stored] });
  }
});

test('generate/constant: a height typed beyond the slider is stored as it is', async () => {
  // Heights outside 0..1 are legal inside a graph (engine.md 1.7): nothing clamps them here.
  for (const height of [-0.25, 3]) {
    expectStats((await renderNode(def, { params: { height } })).out, { min: [height, height], max: [height, height] });
  }
});
