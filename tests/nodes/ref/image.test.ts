// tests/nodes/ref/image.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectLadder, fieldOf, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/ref/image.ts';

// Paths are relative to tests/. The file is the terrain fixture at 253 as a 16-bit grey PNG, round(h * 65535).
const HEIGHTS = 'graphs/assets/heights-253.png';
// 9 x 5, 8-bit RGB. Red is 16 x + 8 y; green and blue hold other values.
const RAMP = 'nodes/ref/assets/ramp-rgb-9x5.png';

// The defaults cannot run: without a file the node fails, as it documents.
conformance(def, { params: { file: HEIGHTS } });

/** A height as the 16-bit file holds it and the decoder returns it. */
const stored = (h: number): number => Math.round(h * 65535) / 65535;

/** `src` at the fractional texel position (x, y), between its four neighbours. */
function bilinear(src: FieldData, x: number, y: number): number {
  const x0 = Math.min(Math.floor(x), src.width - 2), y0 = Math.min(Math.floor(y), src.height - 2);
  const fx = x - x0, fy = y - y0;
  return (1 - fy) * ((1 - fx) * at(src, x0, y0) + fx * at(src, x0 + 1, y0)) + fy * ((1 - fx) * at(src, x0, y0 + 1) + fx * at(src, x0 + 1, y0 + 1));
}

test('ref/image: without a file the node fails with "No file selected"', async () => {
  await assert.rejects(renderNode(def), /^NodeFailure: No file selected$/);
  await assert.rejects(renderNode(def, { params: { file: '' } }), /^NodeFailure: No file selected$/);
});

test('ref/image: at the size of the image the output is the image: 16 bits as heights 0..1', async () => {
  const { out } = await renderNode(def, { res: 253, params: { file: HEIGHTS } });
  const terrain = fixtures.terrain(253);
  // Half a step of 16 bits is 7.6e-6.
  expectClose(out, terrain, { max: 8e-6 });
  // And it is the stored value, not the terrain's: far closer than the half step. Computed here and by the
  // node, so compared with a tolerance (testing.md 5.2).
  expectClose(out, { ...terrain, data: terrain.data.map(stored) }, { max: 1e-6 });
});

test('ref/image: on a finer grid the image keeps its place: its texels at the shared vertices, straight lines between them', async () => {
  const own = await renderNode(def, { res: 253, params: { file: HEIGHTS } });
  // 505 is the next finer level of 253: every second vertex is a texel of the image.
  const fine = await renderNode(def, { res: 505, params: { file: HEIGHTS } });
  expectLadder(own.out, fine.out, { max: 1e-6 });
  // 257 shares only the corners with 253: texel x lies at x * 252 / 256 of the image.
  const other = await renderNode(def, { params: { file: HEIGHTS } });
  expectClose(other.out, fieldOf(257, (u, v) => bilinear(own.out, u * 252, v * 252)), { max: 1e-6 });
});

test('ref/image: the first channel of a color image is taken, 8 bits as heights 0..1, row for row', async () => {
  // Red, 16 x + 8 y of 255, is linear in the image, so on any grid it is the same plane: x and y run over 8 and 4
  // texels of the image and over 32 of the grid of 33. Green falls where red rises, and blue has no slope in x.
  const { out } = await renderNode(def, { res: 33, params: { file: RAMP } });
  expectClose(out, fieldOf(33, (u, v) => (128 * u + 32 * v) / 255), { max: 1e-6 });
});

test('ref/image: a file that is missing or is no image fails the node with the reason', async () => {
  await assert.rejects(renderNode(def, { params: { file: 'nodes/ref/assets/missing.png' } }), /File not found/);
  await assert.rejects(renderNode(def, { params: { file: 'nodes/ref/image.test.ts' } }), /not a PNG/);
});
