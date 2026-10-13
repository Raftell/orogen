// tests/nodes/color/pack-channels.test.ts
import { test } from 'node:test';
import { channelOf, colorOf, conformance, expectClose, expectFinite, expectIdentical, fieldOf, fixtures, renderNode } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/color/pack-channels.ts';
import { COLOR } from './_reference.ts';

conformance(def, {
  skip: { alpha: 'The alpha is the fourth packed field, as the description says: it is 1 only where that input is left open or holds 1.' },
});

test('color/pack-channels: each input becomes the channel it is named for', async () => {
  const r = fixtures.terrain(257), g = fixtures.cone(257), b = fixtures.rampX(257), a = fixtures.basin(257);
  const { out } = await renderNode(def, { inputs: { r, g, b, a } });
  expectClose(channelOf(out, 0), r, { max: COLOR });
  expectClose(channelOf(out, 1), g, { max: COLOR });
  expectClose(channelOf(out, 2), b, { max: COLOR });
  expectClose(channelOf(out, 3), a, { max: COLOR });
});

test('color/pack-channels: a channel left open is 0, and the alpha left open is 1', async () => {
  const nothing = await renderNode(def, { inputs: { r: null, g: null, b: null, a: null } });
  expectIdentical(nothing.out, colorOf(257, () => [0, 0, 0, 1]));

  // One input at a time: the others stay as they are without it.
  const mask = fixtures.mask(257);
  for (const [port, channel] of [['r', 0], ['g', 1], ['b', 2], ['a', 3]] as const) {
    const { out } = await renderNode(def, { inputs: { r: null, g: null, b: null, a: null, [port]: mask } });
    for (const other of [0, 1, 2, 3] as const) {
      // The mask fixture is exactly 0 and 1 outside its soft edge, and a half float holds what lies between within 2e-3.
      if (other === channel) expectClose(channelOf(out, other), mask, { max: COLOR });
      else expectIdentical(channelOf(out, other), other === 3 ? fixtures.one(257) : fixtures.zero(257));
    }
  }
});

test('color/pack-channels: values beyond 0..1 are kept, and those beyond what a color holds are stored at its limit', async () => {
  // -2, 3 and 1024 are numbers a half float holds.
  const kept = await renderNode(def, { inputs: { r: fieldOf(257, () => -2), g: fieldOf(257, () => 3), b: fieldOf(257, () => 1024), a: fieldOf(257, () => 0) } });
  expectIdentical(kept.out, colorOf(257, () => [-2, 3, 1024, 0]));

  // A channel of a color holds 65504 at the most; 1e6 would be stored as infinity.
  const far = await renderNode(def, { inputs: { r: fieldOf(257, () => 1e6), g: fieldOf(257, () => -1e6), b: fieldOf(257, () => 1e30), a: null } });
  expectFinite(far.out);
  expectIdentical(far.out, colorOf(257, () => [65504, -65504, 65504, 1]));
});
