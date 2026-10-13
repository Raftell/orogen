// tests/nodes/color/extract-channel.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorOf, conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/color/extract-channel.ts';
import { COLOR, fieldFrom, luma } from './_reference.ts';

conformance(def);

test('color/extract-channel: each channel is the field that channel holds', async () => {
  // Four channels that no two of them share, the alpha included.
  const src = colorOf(257, (u, v) => [u, v, 0.5 + 0.5 * Math.sin(7 * u * v), 0.25 + 0.5 * u * (1 - v)]);
  const expected = { red: 0, green: 1, blue: 2, alpha: 3 } as const;
  for (const [channel, index] of Object.entries(expected)) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { channel } });
    assert.equal(out.kind, 'field');
    expectClose(out, fieldFrom(src, (i) => src.data[i * 4 + index]!), { max: COLOR });
  }
});

test('color/extract-channel: the default is the red channel', async () => {
  // The color fixture is (u, v, terrain, 1).
  const { out } = await renderNode(def, { inputs: { in: 'color' } });
  expectClose(out, fixtures.rampX(257), { max: COLOR });
});

test('color/extract-channel: the luminance weighs the three channels as a color read as a field is weighed, and ignores alpha', async () => {
  const src = colorOf(257, (u, v) => [u, v, 1 - u * v, 0.5 * u]);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { channel: 'luminance' } });
  expectClose(out, fieldFrom(src, (i) => luma(src.data[i * 4]!, src.data[i * 4 + 1]!, src.data[i * 4 + 2]!)), { max: COLOR });
  // Pure red, green and blue have the three weights, which add up to 1 for white.
  for (const [color, weight] of [[[1, 0, 0], 0.2126], [[0, 1, 0], 0.7152], [[0, 0, 1], 0.0722], [[1, 1, 1], 1]] as const) {
    const flat = await renderNode(def, { inputs: { in: colorOf(257, () => [...color, 1]) }, params: { channel: 'luminance' } });
    expectClose(flat.out, fieldOf(257, () => weight), { max: 1e-6 });
  }
});

test('color/extract-channel: values a channel holds beyond 0..1 pass through unchanged', async () => {
  // 3, -2 and 1024 are numbers a half float holds: nothing is clamped on the way.
  const src = colorOf(257, () => [3, -2, 1024, 0]);
  const values = { red: 3, green: -2, blue: 1024, alpha: 0 } as const;
  for (const [channel, value] of Object.entries(values)) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { channel } });
    expectIdentical(out, fieldOf(257, () => value));
  }
});
