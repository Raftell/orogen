// tests/nodes/filter/edge-fade.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, expectClose, expectLadder, fixtures, renderLadder, renderNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/filter/edge-fade.ts';
import { mapField } from './_reference.ts';

conformance(def);

const N = 257;
const SRC = fixtures.terrain(N);
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

const kept = (d: number, width: number): number => smoothstep(Math.min(1, Math.max(0, d / width)));

/** The fade on the CPU: `left(u, v)` is how much of the terrain is left at a place, 0..1. */
function faded(left: (u: number, v: number) => number, level: number): FieldData {
  return mapField(SRC, (x, y) => level + left(x / (N - 1), y / (N - 1)) * (at(SRC, x, y) - level));
}
/** The product of the fades from the two pairs of borders. */
const square = (width: number) => (u: number, v: number): number => kept(Math.min(u, 1 - u), width) * kept(Math.min(v, 1 - v), width);
/** The fade from the circle that touches the four borders. */
const round = (width: number) => (u: number, v: number): number => kept(0.5 - Math.hypot(u - 0.5, v - 0.5), width);

test('filter/edge-fade: square fades along the four borders: the level on them, the terrain untouched beyond the width', async () => {
  const { out } = await renderNode(def, { params: { width: 0.125, height: 0.2 } });
  expectClose(out, faded(square(0.125), 0.2), { max: 1e-6 });
  for (const i of [0, 77, 256]) {
    assert.equal(at(out, i, 0), Math.fround(0.2));
    assert.equal(at(out, 256, i), Math.fround(0.2));
  }
  // 0.125 is 32 texels: from there inwards the terrain is its own, bit for bit.
  let changed = 0;
  for (let y = 32; y <= 224; y++) for (let x = 32; x <= 224; x++) if (at(out, x, y) !== at(SRC, x, y)) changed++;
  assert.equal(changed, 0, 'texels beyond the width that differ from the input');
  assert.notEqual(at(out, 31, 128), at(SRC, 31, 128));
  // In a corner the two fades meet smoothly: along the diagonal the fade has no crease, which the distance to
  // the nearest border would have. Across it the second difference is that of the fade, not a jump of slope.
  const flat = await renderNode(def, { inputs: { in: 'one' }, params: { width: 0.125, height: 0 } });
  for (const i of [8, 16, 24]) {
    const bend = at(flat.out, i - 1, i + 1) - 2 * at(flat.out, i, i) + at(flat.out, i + 1, i - 1);
    assert.ok(Math.abs(bend) < 0.01, `across the diagonal at (${i}, ${i}) the surface bends by ${bend}`);
  }
});

test('filter/edge-fade: round fades outside a circle that touches the borders, corners included', async () => {
  const { out } = await renderNode(def, { params: { width: 0.25, height: 0.6, mode: 'round' } });
  expectClose(out, faded(round(0.25), 0.6), { max: 1e-6 });
  const level = Math.fround(0.6);
  assert.equal(at(out, 0, 0), level);
  assert.equal(at(out, 20, 20), level, 'a corner lies outside the circle');
  assert.equal(at(out, 128, 0), level, 'the circle touches the middle of a border');
  assert.equal(at(out, 128, 128), at(SRC, 128, 128));
});

test('filter/edge-fade: a wider band changes more of the terrain, and a width of nothing only the border itself', async () => {
  const narrow = await renderNode(def, { params: { width: 0.05 } });
  const wide = await renderNode(def, { params: { width: 0.3 } });
  const changed = (f: FieldData): number => f.data.reduce((count, v, i) => count + (v === SRC.data[i] ? 0 : 1), 0);
  assert.ok(changed(wide.out) > 3 * changed(narrow.out));

  for (const width of [0, -0.2]) {
    const { out } = await renderNode(def, { params: { width, height: 0.9 } });
    expectClose(out, mapField(SRC, (x, y) => (x === 0 || y === 0 || x === 256 || y === 256 ? 0.9 : at(SRC, x, y))), { max: 1e-6 });
  }
});

test('filter/edge-fade: the fade is a function of the place on the terrain: two levels of the ladder agree exactly', async () => {
  const levels = await renderLadder(def, { params: { width: 0.2, mode: 'round' } });
  expectLadder(levels[257].out, levels[513].out, { max: 1e-6 });
});
