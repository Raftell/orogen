// tests/nodes/surface/scatter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, conformance, expectClose, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData,
} from '../../helpers/index.ts';
import def, { SCATTER, scatterCopies, type Copy } from '../../../src/core/nodes/surface/scatter.ts';
import { frameSeed, mapField } from './_probe.ts';

conformance(def);

const N = 257;
/** What the node adds to a terrain. */
const added = (out: FieldData, src: FieldData): FieldData => mapField(out, (v, x, y) => v - at(src, x, y));

interface Scatter { readonly count: number; readonly sizeMin: number; readonly sizeMax: number; readonly seed: number }
const BASE: Scatter = { count: 24, sizeMin: 0.08, sizeMax: 0.3, seed: 0 };
const copiesOf = (scatter: Scatter): Copy[] => scatterCopies(frameSeed(scatter.seed), scatter.count, scatter.sizeMin, scatter.sizeMax);

/**
 * The copies on the CPU, of a stamp that is given as a function of the place on it (u, v in 0..1): the height
 * of each copy at a place on the terrain. Such a stamp is the same on every reduction of itself.
 */
function copiesAt(copies: readonly Copy[], stamp: (u: number, v: number) => number, u: number, v: number): number[] {
  const heights: number[] = [];
  for (const copy of copies) {
    const dx = (u - copy.x) / copy.size, dy = (v - copy.y) / copy.size;
    const far = Math.hypot(dx, dy);
    if (far >= 0.5) continue;
    const t = Math.min(Math.max((far - SCATTER.whole) / (0.5 - SCATTER.whole), 0), 1);
    heights.push(stamp(dx * copy.cos + dy * copy.sin + 0.5, dy * copy.cos - dx * copy.sin + 0.5) * copy.size * (1 - t * t * (3 - 2 * t)));
  }
  return heights;
}
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

test('surface/scatter: every copy is the stamp at a hashed place, size and turn, round, and as tall for its width as the stamp', async () => {
  const src = await fixtures.fbm(N);
  for (const change of [{}, { count: 1, sizeMin: 0.5, sizeMax: 0.5, seed: 2 }, { count: 200, sizeMin: 0.02, sizeMax: 0.1, seed: 5 }, { count: 9, sizeMin: 0.3, sizeMax: 1, seed: 8 }]) {
    const scatter = { ...BASE, ...change };
    const copies = copiesOf(scatter);
    // A level stamp: a copy is a round pad as tall as it is wide.
    const pads = await renderNode(def, { inputs: { in: src, stamp: 'one' }, params: { ...scatter } });
    expectClose(added(pads.out, src), fieldOf(N, (u, v) => sum(copiesAt(copies, () => 1, u, v))), { max: 3e-5 * scatter.count ** 0.5 });
    // A stamp that rises along its own x: every copy rises along its own turn. A reduction of a ramp is the
    // ramp, but for its two border columns, which the round copies barely show.
    const ramps = await renderNode(def, { inputs: { in: src, stamp: 'rampX' }, params: { ...scatter } });
    expectClose(added(ramps.out, src), fieldOf(N, (u, v) => sum(copiesAt(copies, (su) => su, u, v))), { max: 1e-3 * scatter.sizeMax * scatter.count ** 0.5 });
  }
  // One copy of the level stamp: its middle stands its own width above the terrain.
  const [single] = copiesOf({ ...BASE, count: 1, sizeMin: 0.2, sizeMax: 0.4, seed: 3 });
  const one = await renderNode(def, { inputs: { in: 'zero', stamp: 'one' }, params: { count: 1, sizeMin: 0.2, sizeMax: 0.4, seed: 3 } });
  assert.ok(single !== undefined && single.size >= 0.2 && single.size <= 0.4);
  assert.ok(Math.abs(stats(one.out).max - single.size) < 1e-6, `a level stamp ${single.size} wide stands ${stats(one.out).max} high`);
});

test('surface/scatter: add piles the copies up, maximum lets the taller of two stand, subtract carves them out', async () => {
  const src = fixtures.rampY(N);
  const scatter = { ...BASE, count: 60, sizeMin: 0.1, sizeMax: 0.3, seed: 1 };
  const copies = copiesOf(scatter);
  const stamp = fixtures.cone(N);
  const cone = (u: number, v: number): number => Math.max(0, 1 - 4 * Math.hypot(u - 0.5, v - 0.5));
  const render = async (mode: string): Promise<FieldData> => added((await renderNode(def, { inputs: { in: src, stamp }, params: { ...scatter, mode } })).out, src);
  // The tip of a cone is a point: a reduction of the stamp rounds it off, by a part of a copy's height.
  const tolerance = { max: 0.012 };
  const piled = await render('add');
  expectClose(piled, fieldOf(N, (u, v) => sum(copiesAt(copies, cone, u, v))), tolerance);
  const tallest = await render('maximum');
  expectClose(tallest, fieldOf(N, (u, v) => Math.max(0, ...copiesAt(copies, cone, u, v))), tolerance);
  const carved = await render('subtract');
  expectClose(carved, mapField(piled, (v) => -v), { max: 1e-6 });
  // Sixty copies overlap: piled up they stand higher than the tallest alone.
  assert.ok(stats(piled).max > 1.3 * stats(tallest).max, `piled up the copies reach ${stats(piled).max}, the tallest alone ${stats(tallest).max}`);
});

test('surface/scatter: a small copy is read from a reduction of the stamp, not from every so-manieth texel of it', async () => {
  // A stamp that alternates between 0 and 1 from texel to texel: every reduction of it is the level 0.5, and a
  // copy read from the stamp itself would be 0 here and 1 there.
  const checker = fieldOf(N, (u, v) => (Math.round(u * 256) + Math.round(v * 256)) % 2);
  const scatter = { ...BASE, count: 40, sizeMin: 0.05, sizeMax: 0.25, seed: 4 };
  const { out } = await renderNode(def, { inputs: { in: 'zero', stamp: checker }, params: { ...scatter } });
  const copies = copiesOf(scatter);
  expectClose(out, fieldOf(N, (u, v) => sum(copiesAt(copies, () => 0.5, u, v))), { max: 0.02 * 0.25 });
});

test('surface/scatter: more copies leave the first ones, the two sizes may come in either order, and another seed moves everything', () => {
  const few = copiesOf({ ...BASE, count: 5 }), many = copiesOf({ ...BASE, count: 9 });
  assert.equal(many.length, 9);
  assert.deepEqual(many.slice(0, 5), few);
  assert.deepEqual(copiesOf({ ...BASE, count: 5, sizeMin: 0.3, sizeMax: 0.08 }), few);
  for (const copy of copiesOf({ ...BASE, count: 256 })) {
    assert.ok(copy.size >= 0.08 - 1e-12 && copy.size <= 0.3 + 1e-12 && copy.x >= 0 && copy.x < 1 && copy.y >= 0 && copy.y < 1);
    assert.ok(Math.abs(Math.hypot(copy.cos, copy.sin) - 1) < 1e-12);
  }
  const other = copiesOf({ ...BASE, count: 5, seed: 1 });
  assert.ok(other.every((copy, i) => copy.x !== few[i]!.x && copy.size !== few[i]!.size));
  // Sizes are spread over the octaves between the two ends: as many copies below their geometric mean as above.
  const small = copiesOf({ ...BASE, count: 256 }).filter((copy) => copy.size < Math.sqrt(0.08 * 0.3)).length;
  assert.ok(small > 100 && small < 156, `${small} of 256 copies are smaller than the geometric mean of the two sizes`);
});

test('surface/scatter: the copies lie in the same places at two levels of the ladder', async () => {
  // A level stamp is the same on every grid: so are its copies, to the last digit of a place.
  const pads = await renderLadder(def, { inputs: { in: 'terrain', stamp: 'one' } });
  expectLadder(pads[257]!.out, pads[513]!.out, { max: 2e-6 });
  const cones = await renderLadder(def, { inputs: { in: 'terrain', stamp: 'cone' } });
  expectLadder(cones[257]!.out, cones[513]!.out, { rel: 0.01 });
});
