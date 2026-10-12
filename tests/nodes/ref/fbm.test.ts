// tests/nodes/ref/fbm.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, conformance, diff, expectClose, expectIdentical, expectLadder, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/ref/fbm.ts';

conformance(def);

/** Mean absolute difference between horizontal neighbours: how rough the field is at the scale of a texel. */
function meanStep(f: FieldData): number {
  let sum = 0;
  for (let y = 0; y < f.height; y++) for (let x = 1; x < f.width; x++) sum += Math.abs(at(f, x, y) - at(f, x - 1, y));
  return sum / (f.height * (f.width - 1));
}

test('ref/fbm: one octave is 0.5 on its lattice, and the feature size is the spacing of that lattice', async () => {
  // Gradient noise is 0 on the lattice points (engine.md 3.9); a size of 1/8 puts them 32 texels apart at 257.
  const { out } = await renderNode(def, { params: { size: 0.125, octaves: 1 } });
  let worst = 0;
  for (let y = 0; y <= 256; y += 32) for (let x = 0; x <= 256; x += 32) worst = Math.max(worst, Math.abs(at(out, x, y) - 0.5));
  assert.ok(worst <= 1e-6, `the lattice points differ from 0.5 by up to ${worst}; allowed 1e-6`);
  assert.ok(stats(out).std > 0.05, 'between the lattice points the field varies');
});

test('ref/fbm: a larger feature size gives a smoother field', async () => {
  const small = await renderNode(def, { params: { size: 0.0625 } });
  const large = await renderNode(def, { params: { size: 0.5 } });
  assert.ok(meanStep(large.out) < 0.5 * meanStep(small.out), `mean step ${meanStep(large.out)} at size 0.5 against ${meanStep(small.out)} at size 0.0625`);
});

test('ref/fbm: each octave has half the feature size of the one before, weighted by the roughness', async () => {
  // out = 0.5 + 0.8 (n0 + g n1) / (1 + g), with n1 at twice the frequency: at a gain g of 0.5 the second octave is
  // 1.5 (two - 0.5) - (one - 0.5) = 0.4 n1, which is 0 on a lattice of half the spacing, 16 texels, and nowhere else.
  const one = await renderNode(def, { params: { size: 0.125, octaves: 1 } });
  const two = await renderNode(def, { params: { size: 0.125, octaves: 2, gain: 0.5 } });
  const second = (x: number, y: number): number => 1.5 * (at(two.out, x, y) - 0.5) - (at(one.out, x, y) - 0.5);
  let onLattice = 0, squares = 0;
  for (let y = 0; y <= 256; y++) {
    for (let x = 0; x <= 256; x++) {
      if (x % 16 === 0 && y % 16 === 0) onLattice = Math.max(onLattice, Math.abs(second(x, y)));
      squares += second(x, y) ** 2;
    }
  }
  assert.ok(onLattice <= 1e-6, `the second octave is up to ${onLattice} on its lattice; allowed 1e-6`);
  assert.ok(Math.sqrt(squares / 257 ** 2) > 0.02, 'between its lattice points the second octave adds detail');

  // With a gain of 0 every octave after the first has amplitude 0: the sum is the first octave.
  const silent = await renderNode(def, { params: { size: 0.125, octaves: 8, gain: 0 } });
  expectClose(silent.out, one.out, { max: 1e-6 });
});

test('ref/fbm: the project seed and the node seed each give another terrain', async () => {
  const base = await renderNode(def);
  const node = await renderNode(def, { params: { seed: 1 } });
  const project = await renderNode(def, { settings: { seed: 2 } });
  const share = (a: FieldData, b: FieldData): number => diff(a, b).differing / a.data.length;
  assert.ok(share(node.out, base.out) > 0.01 && share(project.out, base.out) > 0.01 && share(node.out, project.out) > 0.01);
  expectIdentical((await renderNode(def)).out, base.out);
});

test('ref/fbm: the shape lives in a unit box, at every level of the ladder', async () => {
  // Lengths are fractions of the terrain and heights are normalised (engine.md 1.6 rule 4).
  const base = await renderNode(def);
  const doubled = await renderNode(def, { settings: { terrainSize: 8192, heightRange: 2048 } });
  expectIdentical(doubled.out, base.out);
  const levels = await renderLadder(def, { resolutions: [129, 257, 513] });
  expectLadder(levels[129].out, levels[257].out, { max: 1e-6 });
  expectLadder(levels[129].out, levels[513].out, { max: 1e-6 });
});
