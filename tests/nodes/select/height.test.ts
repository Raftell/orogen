// tests/nodes/select/height.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectLadder, expectStats, fieldOf, renderLadder, renderNode } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/select/height.ts';

conformance(def);

/** The smooth step the category eases its edges with. */
const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** The CPU reference: 1 inside the band, eased to 0 over `feather` outside it. */
function band(h: number, lo: number, hi: number, feather: number): number {
  if (h >= lo && h <= hi) return 1;
  const outside = h < lo ? lo - h : h - hi;
  return outside >= feather ? 0 : ease(1 - outside / feather);
}

test('select/height: the band is 1, the ground a feather outside it is 0, both exactly', async () => {
  // rampX is the height u. The defaults select 0.5 to 0.75 with a feather of 0.05.
  const { out } = await renderNode(def, { inputs: { in: 'rampX' } });
  let wrongInside = 0, wrongOutside = 0;
  for (let x = 0; x < 257; x++) {
    const h = Math.fround(x / 256);
    if (h >= 0.5 && h <= 0.75 && at(out, x, 100) !== 1) wrongInside++;
    if ((h <= 0.44 || h >= 0.81) && at(out, x, 100) !== 0) wrongOutside++;
  }
  assert.equal(wrongInside, 0, 'texels of the band that are not exactly 1');
  assert.equal(wrongOutside, 0, 'texels more than a feather outside the band that are not exactly 0');
});

test('select/height: across the feather the mask is the smooth step of the height, below the band and above it', async () => {
  const { out } = await renderNode(def, { inputs: { in: 'rampX' }, params: { heightMin: 0.3, heightMax: 0.6, feather: 0.2 } });
  expectClose(out, fieldOf(257, (u) => band(Math.fround(u), 0.3, 0.6, 0.2)), { max: 1e-5 });
  // Half a feather outside either end the smooth step is a half: at the heights 0.2 and 0.7, the columns 51 and 179.
  assert.ok(Math.abs(at(out, 51, 7) - 0.5) <= 0.02, `0.1 below the band the mask is ${at(out, 51, 7)}`);
  assert.ok(Math.abs(at(out, 179, 7) - 0.5) <= 0.02, `0.1 above the band the mask is ${at(out, 179, 7)}`);
  // A quarter of the feather outside it, 0.844; three quarters, 0.156.
  assert.ok(Math.abs(at(out, 64, 7) - 0.84375) <= 1e-4 && Math.abs(at(out, 192, 7) - 0.15625) <= 1e-4);
});

test('select/height: a feather of 0 is a hard edge at both ends of the band', async () => {
  const { out } = await renderNode(def, { inputs: { in: 'rampY' }, params: { heightMin: 0.25, heightMax: 0.5, feather: 0 } });
  expectIdentical(out, fieldOf(257, (_u, v) => (v >= 0.25 && v <= 0.5 ? 1 : 0)));
});

test('select/height: heights are normalised: the band does not move with the height range or the terrain size', async () => {
  const base = await renderNode(def, { inputs: { in: 'terrain' } });
  const scaled = await renderNode(def, { inputs: { in: 'terrain' }, settings: { heightRange: 4096, terrainSize: 1024 } });
  expectIdentical(scaled.out, base.out);
});

test('select/height: heights outside 0 to 1 are selected like any other', async () => {
  const tall = fieldOf(257, (u) => 3 * u - 1);   // -1 to 2
  const { out } = await renderNode(def, { inputs: { in: tall }, params: { heightMin: 1.2, heightMax: 1.8, feather: 0.1 } });
  expectClose(out, fieldOf(257, (u) => band(Math.fround(3 * u - 1), 1.2, 1.8, 0.1)), { max: 1e-5 });
  expectStats(out, { min: [0, 0], max: [1, 1] });
});

test('select/height: an upper height below the lower one selects a soft line at the lower', async () => {
  const { out } = await renderNode(def, { inputs: { in: 'rampX' }, params: { heightMin: 0.5, heightMax: 0.2, feather: 0.1 } });
  expectClose(out, fieldOf(257, (u) => band(Math.fround(u), 0.5, 0.5, 0.1)), { max: 1e-5 });
  assert.equal(at(out, 128, 0), 1, 'the texel at the lower height itself');
});

test('select/height: inverted, the mask is its complement', async () => {
  const plain = await renderNode(def, { inputs: { in: 'terrain' } });
  const inverted = await renderNode(def, { inputs: { in: 'terrain' }, params: { invert: true } });
  expectClose(inverted.out, fieldOf(257, (u, v) => 1 - at(plain.out, Math.round(u * 256), Math.round(v * 256))), { max: 1e-6 });
  expectStats(inverted.out, { min: [0, 0], max: [1, 1] });
});

test('select/height: a preview and a build select the same ground', async () => {
  const levels = await renderLadder(def, { inputs: { in: 'terrain' } });
  expectLadder(levels[257].out, levels[513].out, { max: 1e-6 });
});
