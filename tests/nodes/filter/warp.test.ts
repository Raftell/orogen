// tests/nodes/filter/warp.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, channelOf, conformance, expectClose, expectIdentical, expectLadder, fieldOf, fixtures, renderLadder, renderNode, stats, traceNode,
  type FieldData,
} from '../../helpers/index.ts';
import type { ParamValue } from '../../../src/core/api.ts';
import def from '../../../src/core/nodes/filter/warp.ts';
import { cubicAt, inner, mapField, pathEnd, roughness, smoothed } from './_reference.ts';

conformance(def, {
  skip: { seed: 'The suite connects every input, and with a guide connected the noise and its seed play no part. The test of the noise below changes the seed without a guide.' },
});

const N = 257;
const L = N - 1;

/**
 * How far each texel is read from, as a length, along x and along y. A ramp is the same under the cubic reading
 * as under any other: warped, it is its own value at the place read, so the difference from the ramp is the offset.
 * Texels read from beyond the border are left out by the caller.
 */
async function offsets(params: Readonly<Record<string, ParamValue>>, guide: FieldData | null = null, res = N): Promise<{ x: FieldData; y: FieldData }> {
  const dx = await renderNode(def, { res, inputs: { in: 'rampX', guide }, params });
  const dy = await renderNode(def, { res, inputs: { in: 'rampY', guide }, params });
  const last = res - 1;
  return { x: mapField(dx.out, (x, y) => at(dx.out, x, y) - x / last), y: mapField(dy.out, (x, y) => at(dy.out, x, y) - y / last) };
}
const rms = (f: FieldData): number => Math.sqrt(f.data.reduce((sum, v) => sum + v * v, 0) / f.data.length);

test('filter/warp: without a guide the picture is pushed about by two noises, up to about the distance', async () => {
  const distance = 0.04;
  const { x, y } = await offsets({ distance });
  // 40 texels in from the border no texel is read from beyond it: 1.6 * 0.04 * 256 is 16.4 texels.
  const ix = inner(x, 40), iy = inner(y, 40);
  for (const f of [ix, iy]) {
    const s = stats(f);
    assert.ok(Math.max(Math.abs(s.min), Math.abs(s.max)) <= 1.6 * distance + 1e-6, `an offset of ${Math.max(Math.abs(s.min), Math.abs(s.max))}`);
    assert.ok(rms(f) > 0.2 * distance && rms(f) < 0.8 * distance, `the offsets have a root mean square of ${rms(f)}`);
    assert.ok(Math.abs(s.mean) < 0.3 * distance, 'the picture is not moved as a whole');
  }
  // The two noises are different ones.
  let dot = 0;
  for (let i = 0; i < ix.data.length; i++) dot += ix.data[i]! * iy.data[i]!;
  const correlation = dot / ix.data.length / (rms(ix) * rms(iy));
  assert.ok(Math.abs(correlation) < 0.5, `the offsets along x and along y correlate by ${correlation}`);
  // Another seed is another pair of noises.
  const other = await offsets({ distance, seed: 1 });
  let same = 0;
  for (let i = 0; i < x.data.length; i++) if (Math.abs(other.x.data[i]! - x.data[i]!) < 1e-4) same++;
  assert.ok(same < 0.05 * x.data.length, `${same} of ${x.data.length} offsets are the same with another seed`);
});

test('filter/warp: the offsets grow with the distance, and broaden with the size', async () => {
  const near = await offsets({ distance: 0.01 });
  const far = await offsets({ distance: 0.02 });
  // Twice the distance is the same noise twice as far.
  const nearX = inner(near.x, 40);
  expectClose(inner(far.x, 40), mapField(nearX, (x, y) => 2 * at(nearX, x, y)), { max: 2e-5 });

  const turn = (f: FieldData): number => {
    let sum = 0;
    for (let y = 40; y < N - 40; y++) for (let x = 40; x < N - 40; x++) sum += (at(f, x + 1, y) - at(f, x, y)) ** 2;
    return Math.sqrt(sum);
  };
  const fine = await offsets({ distance: 0.01, size: 0.1 });
  const broad = await offsets({ distance: 0.01, size: 0.4 });
  assert.ok(turn(broad.x) < 0.5 * turn(fine.x), `the offsets change ${turn(broad.x)} from texel to texel at a size of 0.4 and ${turn(fine.x)} at 0.1`);
  const plain = await offsets({ distance: 0.01, octaves: 1 });
  const wrinkled = await offsets({ distance: 0.01, octaves: 6 });
  assert.ok(roughness(inner(wrinkled.x, 40)) > 2 * roughness(inner(plain.x, 40)), `more octaves add finer wrinkles: a roughness of ${roughness(inner(wrinkled.x, 40))} with 6 octaves and ${roughness(inner(plain.x, 40))} with 1`);
});

test('filter/warp: with a guide the picture is read up the guide\'s slope, in proportion to it, and moves down it', async () => {
  // rampX as the guide rises towards +X at 0.25 metres per metre: a quarter of the distance, towards +X.
  const even = await offsets({ distance: 0.04, guideRadius: 0.0005 }, fixtures.rampX(N));
  expectClose(inner(even.x, 12), mapField(inner(even.x, 12), () => 0.01), { max: 1e-5 });
  expectClose(inner(even.y, 12), mapField(inner(even.y, 12), () => 0), { max: 1e-5 });
  // The cone is at 45 degrees, where the push is the whole distance, towards its centre; its floor is level.
  const steep = await offsets({ distance: 0.04, guideRadius: 0.0005 }, fixtures.cone(N));
  assert.ok(Math.abs(at(steep.x, 160, 128) + 0.04) < 1e-4, `on the flank at +X the picture is read ${at(steep.x, 160, 128)} along x`);
  assert.ok(Math.abs(at(steep.y, 128, 100) - 0.04) < 1e-4, `on the flank at -Y it is read ${at(steep.y, 128, 100)} along y`);
  assert.equal(at(steep.x, 30, 30), 0);
  assert.equal(at(steep.y, 30, 30), 0);

  // Any guide: the end of the path of 11 steps up the slope of the smoothed guide, as the cubic reading of the
  // picture finds it.
  const src = await fixtures.fbm(N);
  const guide = await fixtures.fbm(N, 3);
  const { out } = await renderNode(def, { inputs: { in: src, guide }, params: { distance: 0.03, guideRadius: 0.02 } });
  const smooth = smoothed(guide, 0.02 * L);
  // The path is followed in float32 over a blur computed in float32, on a terrain that changes by up to 0.05 a texel.
  expectClose(out, mapField(src, (x, y) => cubicAt(src, ...pathEnd(smooth, x, y, 0.03 * L, 11))), { max: 2e-3 });

  // Paths do not cross: where single strides from the two sides of a hollow would fold the picture over, the
  // places a row of texels is read from stay in their order. A valley along y, its sides at 45 degrees.
  const valley = fieldOf(N, (u) => 4 * Math.abs(u - 0.5));
  const across = await offsets({ distance: 0.08, guideRadius: 0.0005 }, valley);
  let folds = 0;
  for (let x = 100; x < 156; x++) if (x + 1 + L * at(across.x, x + 1, 128) < x + L * at(across.x, x, 128) - 1e-3) folds++;
  assert.equal(folds, 0, 'the places a row is read from are in the order of its texels');

  // The noise plays no part: another seed, size or octave count changes nothing.
  const other = await renderNode(def, { inputs: { in: src, guide }, params: { distance: 0.03, guideRadius: 0.02, seed: 9, size: 0.03, octaves: 7 } });
  expectIdentical(other.out, out);
});

test('filter/warp: no distance gives the input itself', async () => {
  const src = await fixtures.fbm(N);
  for (const distance of [0, -0.1]) {
    const { outputs, report } = await traceNode(def, { inputs: { in: src, guide: null }, params: { distance } });
    expectIdentical(outputs.out, src);
    assert.equal(report.nodes.node.peakBytes, 0, 'an alias of the input: no texture, no pass');
  }
});

test('filter/warp: a color is warped channel by channel and stays opaque', async () => {
  const color = fixtures.color(N);
  const { out } = await renderNode(def, { inputs: { in: color, guide: null } });
  assert.equal(out.kind, 'color');
  const blue = await renderNode(def, { inputs: { in: channelOf(color, 2), guide: null } });
  expectClose(channelOf(out, 2), blue.out, { max: 2e-3 });
  expectIdentical(channelOf(out, 3), fixtures.one(N));
});

test('filter/warp: the noise is a function of the place on the terrain: two levels of the ladder agree', async () => {
  const coarse = await offsets({ distance: 0.03 });
  const fine = await offsets({ distance: 0.03 }, null, 513);
  expectLadder(inner(coarse.x, 40), inner(fine.x, 80), { max: 2e-5 });
  const levels = await renderLadder(def, { inputs: { in: 'terrain', guide: 'cone' }, params: { distance: 0.03, guideRadius: 0.02 } });
  expectLadder(levels[257].out, levels[513].out, { rel: 0.01 });
});
