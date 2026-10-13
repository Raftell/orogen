// tests/nodes/filter/sharpen.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode, traceNode } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/sharpen.ts';
import { mapField, roughness, smoothed } from './_reference.ts';

conformance(def);

test('filter/sharpen: at full strength the detail that smoothing removes is added once more, at half strength half of it', async () => {
  // A radius of 0.02 is 5.12 texels at 257.
  const src = await fixtures.fbm(257);
  const low = smoothed(src, 0.02 * 256);
  const { out } = await renderNode(def, { inputs: { in: src }, params: { radius: 0.02 } });
  expectClose(out, mapField(src, (x, y) => 2 * src.data[y * 257 + x]! - low.data[y * 257 + x]!), { max: 2e-5 });
  const half = await renderNode(def, { inputs: { in: src }, params: { radius: 0.02, strength: 0.5 } });
  expectClose(half.out, mapField(src, (x, y) => 1.5 * src.data[y * 257 + x]! - 0.5 * low.data[y * 257 + x]!), { max: 2e-5 });
});

test('filter/sharpen: the terrain gets rougher with the strength, and a flat or evenly sloping one is left alone', async () => {
  const src = await fixtures.fbm(257);
  const weak = await renderNode(def, { inputs: { in: src }, params: { strength: 0.3 } });
  const full = await renderNode(def, { inputs: { in: src } });
  assert.ok(roughness(weak.out) > 1.2 * roughness(src), `roughness ${roughness(weak.out)} at strength 0.3 against ${roughness(src)} of the input`);
  assert.ok(roughness(full.out) > 1.4 * roughness(weak.out));

  const flat = fieldOf(257, () => 0.3);
  expectClose((await renderNode(def, { inputs: { in: flat } })).out, flat, { max: 1e-6 });
  // Smoothed, a plane is that plane up to the border: there is no detail to add anywhere, and no frame is
  // sharpened into ground that slopes towards the border. (Less a blur that clamps, rampX would rise by 0.004 at
  // the border it runs into, at a radius of 0.02.)
  for (const radius of [0.01, 0.02, 0.1]) {
    const ramp = await renderNode(def, { inputs: { in: 'rampX' }, params: { radius } });
    expectClose(ramp.out, fixtures.rampX(257), { max: 2e-6 });
  }
});

test('filter/sharpen: no strength, or a radius below a third of a texel, gives the input itself', async () => {
  const src = await fixtures.fbm(257);
  for (const params of [{ strength: 0 }, { radius: 0.3 / 256 }, { radius: 0 }] as Readonly<Record<string, number>>[]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src }, params });
    expectIdentical(outputs.out, src);
    assert.equal(report.nodes.node.peakBytes, 0);
  }
});

test('filter/sharpen: a color is sharpened channel by channel, and an opaque one stays opaque', async () => {
  const color = fixtures.color(257);
  const { out } = await renderNode(def, { inputs: { in: color }, params: { radius: 0.02 } });
  assert.equal(out.kind, 'color');
  const blue = await renderNode(def, { inputs: { in: channelOf(color, 2) }, params: { radius: 0.02 } });
  // A color keeps 11 significant bits, and the sharpened one is two of them less its blur.
  expectClose(channelOf(out, 2), blue.out, { max: 5e-3 });
  expectIdentical(channelOf(out, 3), fixtures.one(257));
});
