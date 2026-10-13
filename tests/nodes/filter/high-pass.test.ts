// tests/nodes/filter/high-pass.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, conformance, expectClose, expectIdentical, expectLadder, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/high-pass.ts';
import { gaussian, mapField } from './_reference.ts';

conformance(def, {
  resolutionTol: {
    value: 0.04,
    reason: 'A color is stored in 11 significant bits, steps of 4.9e-4 around the level 0.5, and the detail left of the color fixture has a standard deviation of 0.009: 2.2 % between 257 and 513, where a field differs by 0.14 %.',
  },
});

test('filter/high-pass: the output is the input less its blur, around 0.5', async () => {
  // A radius of 0.02 is 5.12 texels at 257.
  const src = await fixtures.fbm(257);
  const low = gaussian(src, 0.02 * 256);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { radius: 0.02 } });
  expectClose(out, mapField(src, (x, y) => 0.5 + src.data[y * 257 + x]! - low.data[y * 257 + x]!), { max: 1e-5 });
});

test('filter/high-pass: the broad shape goes and the detail stays: a larger radius keeps more', async () => {
  const src = await fixtures.fbm(257);
  const fine = await renderNode(def, { inputs: { in: src }, params: { radius: 0.005 } });
  const broad = await renderNode(def, { inputs: { in: src }, params: { radius: 0.02 } });
  expectStats(fine.out, { mean: [0.499, 0.501] });
  expectStats(broad.out, { mean: [0.495, 0.505] });
  assert.ok(stats(fine.out).std < 0.5 * stats(broad.out).std);
  // The terrain has features a quarter of its width across: twelve radii and more.
  assert.ok(stats(broad.out).std < 0.25 * stats(src).std, `the broad shape is left: a standard deviation of ${stats(broad.out).std} against ${stats(src).std}`);
});

test('filter/high-pass: a flat terrain, and any terrain at a radius of nothing, becomes the level 0.5', async () => {
  // The level is a sum the device computes: one that adds in another order is off by the last bit of 1.3.
  const level = fieldOf(257, () => 0.5);
  expectClose((await renderNode(def, { inputs: { in: fieldOf(257, () => 0.8) } })).out, level, { max: 1e-6 });
  expectClose((await renderNode(def, { inputs: { in: 'terrain' }, params: { radius: 0 } })).out, level, { max: 1e-6 });
});

test('filter/high-pass: the detail is the same at two levels of the ladder', async () => {
  const levels = await renderLadder(def, { inputs: { in: 'terrain' } });
  expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
});

test('filter/high-pass: a color keeps the detail of its three channels and its alpha', async () => {
  const color = fixtures.color(257);
  const { out } = await renderNode(def, { inputs: { in: color }, params: { radius: 0.02 } });
  assert.equal(out.kind, 'color');
  const blue = await renderNode(def, { inputs: { in: channelOf(color, 2) }, params: { radius: 0.02 } });
  expectClose(channelOf(out, 2), blue.out, { max: 2e-3 });
  expectIdentical(channelOf(out, 3), fixtures.one(257));
});
