// tests/nodes/adjust/autolevel.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformance, expectClose, expectStats, fieldOf, fixtures, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/adjust/autolevel.ts';
import { countValues, mapValues } from './_reference.ts';

// resolutionDependent: the `resolution` check does not apply to the node, and nothing is opted out of.
conformance(def);

test('adjust/autolevel: the lowest point becomes 0 and the highest 1, exactly, and everything between keeps its place', async () => {
  const src = fixtures.terrain(257);
  const { out } = await renderNode(def, { inputs: { in: src } });
  const { min, max } = stats(src);
  expectStats(out, { min: [0, 0], max: [1, 1] });
  expectClose(out, mapValues(src, (v) => (v - min) / (max - min)), { max: 1e-6 });
});

test('adjust/autolevel: an input of any range is stretched onto 0..1', async () => {
  // Heights outside 0..1 are legal inside a graph: a tall slope far below 0, and a faint one that falls.
  const tall = await renderNode(def, { inputs: { in: fieldOf(257, (u, v) => 40 * (u + v) - 70) } });
  expectClose(tall.out, fieldOf(257, (u, v) => (u + v) / 2), { max: 1e-6 });
  const faint = await renderNode(def, { inputs: { in: fieldOf(257, (u, v) => -0.001 * (u + v)) } });
  expectClose(faint.out, fieldOf(257, (u, v) => 1 - (u + v) / 2), { max: 1e-6 });
});

test('adjust/autolevel: a flat input, which has no range to stretch, becomes 0', async () => {
  const { out } = await renderNode(def, { inputs: { in: fieldOf(257, () => 0.375) } });
  expectStats(out, { min: [0, 0], max: [0, 0] });
});

test('adjust/autolevel: the measured range is that of the evaluated level, so a preview differs from the build', async () => {
  // A peak one texel wide at 513 lies between the vertices of 257: the coarser level never sees it.
  const peak = (res: number) => fieldOf(res, (u, v) => (Math.abs(u - 255 / 512) < 1e-9 && Math.abs(v - 255 / 512) < 1e-9 ? 2 : u));
  const coarse = await renderNode(def, { res: 257, inputs: { in: peak(257) } });
  const fine = await renderNode(def, { res: 513, inputs: { in: peak(513) } });
  expectClose(coarse.out, fixtures.rampX(257), { max: 1e-6 });
  expectClose(fine.out, mapValues(peak(513), (v) => v / 2), { max: 1e-6 });
});

test('adjust/autolevel: the mask of the node keeps the input where it is 0', async () => {
  // The mask fixture is 1 inside a radius of 0.2 and 0 outside 0.35. The range is still measured on the whole input.
  const src = fieldOf(257, (u, v) => 0.2 + 0.4 * u + 0.2 * v), mask = fixtures.mask(257);
  const { out } = await renderNode(def, { inputs: { in: src }, mask });
  assert.equal(countValues(out, (v, i) => mask.data[i] === 0 && v !== src.data[i]), 0, 'a texel outside the mask changed');
  const stretched = mapValues(src, (v) => (v - 0.2) / 0.6);
  assert.equal(countValues(out, (v, i) => mask.data[i] === 1 && Math.abs(v - stretched.data[i]) > 1e-6), 0, 'a texel inside the mask is not the stretched height');
});
