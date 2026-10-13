// tests/nodes/surface/roughen.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode, TEST_SETTINGS, type FieldData,
} from '../../helpers/index.ts';
import def, { ROUGHEN } from '../../../src/core/nodes/surface/roughen.ts';
import { mapField } from './_probe.ts';

conformance(def);

const N = 257;
/** What the node adds to a terrain. */
const added = (out: FieldData, src: FieldData): FieldData => mapField(out, (v, x, y) => v - at(src, x, y));
/** The most the ground is moved at full strength: the relief times what a slope of 1 falls across the size. */
const relief = (size: number): number => (ROUGHEN.relief * size * TEST_SETTINGS.terrainSize) / TEST_SETTINGS.heightRange;
/** The window of texels around the middle with the given half width, as the values of a field there. */
function window(f: FieldData, x0: number, x1: number, y0: number, y1: number): number[] {
  const values: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) values.push(at(f, x, y));
  return values;
}
const deviation = (values: readonly number[]): number => {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
};
/** How often a row of the field passes through 0, over all rows. */
function crossings(f: FieldData): number {
  let count = 0;
  for (let y = 0; y < f.height; y++) for (let x = 1; x < f.width; x++) if (at(f, x, y) > 0 !== at(f, x - 1, y) > 0) count++;
  return count;
}

test('surface/roughen: the ground is moved up and down about itself, by no more than the relief of the size, in proportion to the strength', async () => {
  const src = fixtures.rampY(N);
  const size = 0.08;
  const full = added((await renderNode(def, { inputs: { in: src }, params: { size, slopeBias: 0 } })).out, src);
  const s = stats(full);
  assert.ok(s.max <= relief(size) + 1e-6 && s.min >= -relief(size) - 1e-6, `the ground is moved by ${s.min} to ${s.max}; the relief is ${relief(size)}`);
  assert.ok(s.std > 0.12 * relief(size) && s.std < 0.5 * relief(size), `the roughness has a deviation of ${s.std}`);
  assert.ok(Math.abs(s.mean) < 0.05 * relief(size), `and a mean of ${s.mean}`);
  const half = added((await renderNode(def, { inputs: { in: src }, params: { size, slopeBias: 0, strength: 0.5 } })).out, src);
  expectClose(half, mapField(full, (v) => 0.5 * v), { max: 2e-6 });
  const other = added((await renderNode(def, { inputs: { in: src }, params: { size, slopeBias: 0, seed: 1 } })).out, src);
  assert.ok(stats(mapField(other, (v, x, y) => v - at(full, x, y))).std > s.std, 'another seed is another roughness');
});

test('surface/roughen: the slope bias keeps the roughness for steep ground', async () => {
  // The cone: a flank of 45 degrees, which is steep in full, on a level floor.
  const cone = fixtures.cone(N);
  const rough = async (slopeBias: number): Promise<{ flank: number; floor: number; out: FieldData }> => {
    const { out } = await renderNode(def, { inputs: { in: cone }, params: { size: 0.03, slopeBias } });
    const moved = added(out, cone);
    // The flank between 16 and 48 texels from the summit, as a window beside it, and a window of the floor.
    return { flank: deviation(window(moved, 150, 174, 112, 144)), floor: deviation(window(moved, 8, 40, 8, 40)), out };
  };
  const even = await rough(0);
  assert.ok(even.floor > 0.7 * even.flank && even.floor < 1.4 * even.flank, `without a bias the floor is as rough as the flank: ${even.floor} against ${even.flank}`);
  const halfway = await rough(0.5);
  assert.ok(Math.abs(halfway.floor / even.floor - 0.5) < 0.01, `at a bias of 0.5 the level floor keeps ${halfway.floor / even.floor} of its roughness`);
  assert.ok(Math.abs(halfway.flank / even.flank - 1) < 0.01, `and the flank ${halfway.flank / even.flank}`);
  const steepOnly = await rough(1);
  assert.ok(Math.abs(steepOnly.flank / even.flank - 1) < 0.01);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) assert.equal(at(steepOnly.out, x, y), 0, `at a bias of 1 the level floor is moved at (${x}, ${y})`);
});

test('surface/roughen: the roughness has several layers, the broadest as broad as the size', async () => {
  const flat = fieldOf(513, () => 0.5);
  const rough = async (size: number): Promise<FieldData> => added((await renderNode(def, { res: 513, inputs: { in: flat }, params: { size, slopeBias: 0 } })).out, flat);
  const broad = await rough(0.2), fine = await rough(0.05);
  // Four times the size is the same roughness four times as broad: a row passes through the level a quarter as often.
  const ratio = crossings(fine) / crossings(broad);
  assert.ok(ratio > 2.5 && ratio < 6, `a row passes through the level ${crossings(fine)} times at a size of 0.05 and ${crossings(broad)} at 0.2`);
  // More than one layer. A grid of 33 holds the first layer of a size of 0.2 alone, 6.4 texels broad, and a
  // fifth of the second; the grid of 513 holds all six. Each layer keeps 0.6 of the height of the one before, so
  // the five finer ones together have sqrt(0.36 / 0.64) = 0.75 of the deviation of the first.
  const small = fieldOf(33, () => 0.5);
  const first = added((await renderNode(def, { res: 33, inputs: { in: small }, params: { size: 0.2, slopeBias: 0 } })).out, small);
  let finer = 0;
  for (let y = 0; y < 33; y++) for (let x = 0; x < 33; x++) finer += (at(broad, 16 * x, 16 * y) - at(first, x, y)) ** 2;
  const share = Math.sqrt(finer / (33 * 33)) / stats(first).std;
  assert.ok(share > 0.45 && share < 1, `the finer layers have ${share} of the deviation of the first`);
});

test('surface/roughen: layers finer than the grid can hold are left out, and with none left the input stays', async () => {
  const src = await fixtures.fbm(N);
  // A size of 0.008 is 2 texels at 257: no layer is 2.5 texels broad.
  const none = await renderNode(def, { inputs: { in: src }, params: { size: 0.008 } });
  expectIdentical(none.out, src);
  // A finer grid holds one layer more: what it adds to the coarser one's is small beside it.
  const flat = fieldOf(N, () => 0.5);
  const coarse = added((await renderNode(def, { inputs: { in: flat }, params: { size: 0.25, slopeBias: 0 } })).out, flat);
  const fineFlat = fieldOf(513, () => 0.5);
  const fine = added((await renderNode(def, { res: 513, inputs: { in: fineFlat }, params: { size: 0.25, slopeBias: 0 } })).out, fineFlat);
  let sum = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) sum += (at(fine, 2 * x, 2 * y) - at(coarse, x, y)) ** 2;
  assert.ok(Math.sqrt(sum / (N * N)) < 0.1 * stats(coarse).std, `the two levels differ by ${Math.sqrt(sum / (N * N))}; the roughness has a deviation of ${stats(coarse).std}`);
});

test('surface/roughen: no strength gives the input itself', async () => {
  const src = await fixtures.fbm(N);
  const { outputs, report } = await traceNode(def, { inputs: { in: src }, params: { strength: 0 } });
  expectIdentical(outputs.out!, src);
  assert.equal(report.nodes.node!.peakBytes, 0, 'an alias of the input: no texture, no pass');
});

test('surface/roughen: the roughened terrain is the same at two levels of the ladder', async () => {
  const levels = await renderLadder(def, { inputs: { in: 'terrain' } });
  expectLadder(levels[257]!.out, levels[513]!.out, { rel: 0.01 });
});
