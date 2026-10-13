// tests/nodes/select/edge.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectIdentical, expectLadder, expectStats, fieldOf, fixtures, renderLadder, renderNode, stats } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/select/edge.ts';

conformance(def);

const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
/** The mask of a distance from the edge, as lengths: 1 within half the width, eased to 0 over the feather beyond. */
function band(distance: number, width: number, feather: number): number {
  const outside = distance - width / 2;
  if (outside <= 0) return 1;
  return outside >= feather ? 0 : ease(1 - outside / feather);
}

/** A hard mask: 1 on the texels up to column 128 of 257, 0 beyond. Its edge lies half-way between 128 and 129. */
const half = fieldOf(257, (u) => (Math.round(u * 256) <= 128 ? 1 : 0));
const fromHalf = (x: number): number => Math.abs(x - 128.5) / 256;

test('select/edge: the band is the width across the edge, half on either side, and fades over the feather beyond', async () => {
  // A width of 8 texels and a feather of 4: the columns 125 to 132 are 3.5 texels from the edge and less.
  const params = { width: 8 / 256, feather: 4 / 256 };
  const { out } = await renderNode(def, { inputs: { in: half }, params });
  expectClose(out, fieldOf(257, (u) => band(fromHalf(Math.round(u * 256)), params.width, params.feather)), { max: 1e-5 });
  for (let x = 125; x <= 132; x++) assert.equal(at(out, x, 77), 1, `column ${x} is inside the band`);
  // Half a texel beyond the band on either side, then 1.5, 2.5 and 3.5: the same on both.
  for (const beyond of [0, 1, 2, 3]) {
    assert.ok(Math.abs(at(out, 124 - beyond, 77) - at(out, 133 + beyond, 77)) <= 1e-6);
    assert.ok(Math.abs(at(out, 133 + beyond, 77) - ease(1 - (beyond + 0.5) / 4)) <= 1e-5);
  }
  assert.equal(at(out, 120, 77), 0);
  assert.equal(at(out, 137, 77), 0);
});

test('select/edge: without a feather the band is hard, and without a width it is a soft line along the edge', async () => {
  const hard = (await renderNode(def, { inputs: { in: half }, params: { width: 6 / 256, feather: 0 } })).out;
  expectIdentical(hard, fieldOf(257, (u) => (Math.abs(Math.round(u * 256) - 128.5) <= 3 ? 1 : 0)));
  const line = (await renderNode(def, { inputs: { in: half }, params: { width: 0, feather: 8 / 256 } })).out;
  expectClose(line, fieldOf(257, (u) => band(fromHalf(Math.round(u * 256)), 0, 8 / 256)), { max: 1e-5 });
  // Neither a width nor a feather: no texel lies on the edge itself, which runs between them.
  expectStats((await renderNode(def, { inputs: { in: half }, params: { width: 0, feather: 0 } })).out, { min: [0, 0], max: [0, 0] });
});

test('select/edge: the band follows the edge where the mask crosses 0.5, at the same width all round a disc', async () => {
  // The disc of the mask fixture crosses 0.5 at a radius of 0.275.
  const params = { width: 0.03, feather: 0.02 };
  const { out } = await renderNode(def, { inputs: { in: 'mask' }, params });
  expectClose(out, fieldOf(257, (u, v) => band(Math.abs(Math.hypot(u - 0.5, v - 0.5) - 0.275), params.width, params.feather)), { max: 5e-3 });
  assert.equal(at(out, 128, 128), 0, 'the middle of the disc');
  assert.equal(at(out, 5, 5), 0, 'far outside it');
  assert.equal(at(out, 128 + 70, 128), 1, 'on its edge, 70.4 texels from the centre');
});

test('select/edge: a mask and what it leaves out have the same edge', async () => {
  const mask = fixtures.terrain(257);
  const complement = fieldOf(257, (u, v) => 1 - at(mask, Math.round(u * 256), Math.round(v * 256)));
  const a = await renderNode(def, { inputs: { in: mask } });
  const b = await renderNode(def, { inputs: { in: complement } });
  expectClose(a.out, b.out, { max: 1e-4 });
  assert.ok(stats(a.out).max === 1 && stats(a.out).min === 0 && stats(a.out).mean > 0.05 && stats(a.out).mean < 0.6, `the band covers ${stats(a.out).mean} of the terrain`);
});

test('select/edge: a mask without an edge has no band, however wide', async () => {
  for (const input of ['zero', 'one'] as const) {
    expectStats((await renderNode(def, { inputs: { in: input }, params: { width: 4, feather: 4 } })).out, { min: [0, 0], max: [0, 0] });
    expectStats((await renderNode(def, { inputs: { in: input }, params: { invert: true } })).out, { min: [1, 1], max: [1, 1] });
  }
});

test('select/edge: inverted, the mask is its complement, and lengths do not change with the size of the terrain', async () => {
  const plain = (await renderNode(def, { inputs: { in: 'terrain' } })).out;
  const inverted = (await renderNode(def, { inputs: { in: 'terrain' }, params: { invert: true } })).out;
  expectClose(inverted, fieldOf(257, (u, v) => 1 - at(plain, Math.round(u * 256), Math.round(v * 256))), { max: 1e-6 });
  const scaled = (await renderNode(def, { inputs: { in: 'terrain' }, settings: { terrainSize: 16384, heightRange: 256 } })).out;
  expectIdentical(scaled, plain);
});

test('select/edge: two levels of the ladder agree: the band is as wide in a preview as in a build', async () => {
  // The default band, 2.56 texels wide at 257 with a feather of 1.28, around the disc and along the many edges
  // of the terrain fixture read as a mask, where a band this thin differs by 1.3 % of its standard deviation:
  // the finer level resolves a neck of the mask the coarser one closes. And a broad band.
  for (const input of ['mask', 'terrain'] as const) {
    const thin = await renderLadder(def, { inputs: { in: input } });
    expectLadder(thin[257].out, thin[513].out, { rel: input === 'mask' ? 0.01 : 0.02 });
    const broad = await renderLadder(def, { inputs: { in: input }, params: { width: 0.04, feather: 0.03 } });
    expectLadder(broad[257].out, broad[513].out, { rel: 0.005 });
  }
});
