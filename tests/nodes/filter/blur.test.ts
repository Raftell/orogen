// tests/nodes/filter/blur.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/blur.ts';
import { gaussian, range } from './_reference.ts';

conformance(def);

test('filter/blur: the output is the Gaussian whose standard deviation is the radius', async () => {
  // A radius of 0.02 is 5.12 texels at 257.
  const src = await fixtures.fbm(257);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { radius: 0.02 } });
  expectClose(out, gaussian(src, 0.02 * 256), { max: 1e-5 });
});

test('filter/blur: a wide radius is the same Gaussian, up to the border', async () => {
  // 25.6 and 64 texels at 257: too wide for the taps of one pass, and computed on a coarser grid.
  const src = await fixtures.fbm(257);
  for (const radius of [0.1, 0.25]) {
    const { out } = await renderNode(def, { inputs: { in: src }, params: { radius } });
    expectClose(out, gaussian(src, radius * 256), { max: (radius < 0.25 ? 3e-3 : 6e-3) * range(src) });
  }
});

test('filter/blur: a larger radius removes more detail', async () => {
  const src = await fixtures.fbm(257);
  const small = await renderNode(def, { inputs: { in: src }, params: { radius: 0.005 } });
  const large = await renderNode(def, { inputs: { in: src }, params: { radius: 0.05 } });
  assert.ok(stats(large.out).std < stats(small.out).std);
  assert.ok(stats(small.out).std < stats(src).std);
});

test('filter/blur: a constant stays that constant', async () => {
  const flat = fieldOf(257, () => 0.3);
  expectIdentical((await renderNode(def, { inputs: { in: flat }, params: { radius: 0.02 } })).out, flat);
  expectIdentical((await renderNode(def, { inputs: { in: flat }, params: { radius: 0.1 } })).out, flat);
});

test('filter/blur: below a third of a texel the output is the input itself', async () => {
  // 0.3 texels at 257: no neighbour within three standard deviations. A negative radius, which can be typed, is none.
  const src = await fixtures.fbm(257);
  for (const radius of [0.3 / 256, -0.1]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { radius } });
    expectIdentical(outputs.out, src);
    assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
});

test('filter/blur: a color is blurred channel by channel, and an opaque one stays opaque', async () => {
  const color = fixtures.color(257);
  const { out } = await renderNode(def, { inputs: { in: color }, params: { radius: 0.02 } });
  assert.equal(out.kind, 'color');
  for (const channel of [0, 1, 2] as const) {
    expectClose(channelOf(out, channel), gaussian(channelOf(color, channel), 0.02 * 256), { max: 2e-3 });
  }
  expectIdentical(channelOf(out, 3), fixtures.one(257));
});

test('filter/blur: the blur is the same at two levels of the ladder', async () => {
  const levels = await renderLadder(def, { inputs: { in: 'terrain' }, params: { radius: 0.03 } });
  expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
});

test('filter/blur: the mask limits the blur to where it is 1', async () => {
  const src = await fixtures.fbm(257);
  const plain = await renderNode(def, { inputs: { in: src } });
  expectIdentical((await renderNode(def, { inputs: { in: src }, mask: 'zero' })).out, src);
  expectClose((await renderNode(def, { inputs: { in: src }, mask: 'one' })).out, plain.out, { max: 1e-6 });
});
