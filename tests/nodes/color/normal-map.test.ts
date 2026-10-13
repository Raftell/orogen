// tests/nodes/color/normal-map.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, colorOf, compareLadder, conformance, expectClose, expectIdentical, fieldOf, fixtures, renderLadder, renderNode, stats, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/color/normal-map.ts';
import { COLOR, colorFrom, HEIGHT_RANGE, rough, slopes, TERRAIN_SIZE } from './_reference.ts';

conformance(def);

/** No smoothing: a radius below a quarter of a texel takes the normals of the terrain as it is. */
const RAW: Readonly<Record<string, number>> = { radius: 0.0001 };
/** The defaults. */
const DEFAULTS: Readonly<Record<string, number>> = {};

/** A unit normal as the map stores it: each component from -1..1 to 0..1, opaque. */
const encoded = (nx: number, ny: number, nz: number): readonly [number, number, number, number] => [0.5 * nx + 0.5, 0.5 * ny + 0.5, 0.5 * nz + 0.5, 1];
/** The stored normal of ground with the physical gradient (gx, gy), metres per metre. */
function ofSlope(gx: number, gy: number): readonly [number, number, number, number] {
  const length = Math.hypot(gx, gy, 1);
  return encoded(-gx / length, -gy / length, 1 / length);
}
const flat = (color: readonly [number, number, number, number]): FieldData => colorOf(257, () => color);

test('color/normal-map: level ground is the level normal, exactly', async () => {
  for (const params of [RAW, DEFAULTS, { radius: 0.05 }]) {
    // 0.5 and 1 are numbers a half float holds.
    expectIdentical((await renderNode(def, { inputs: { in: 'zero' }, params })).out, flat([0.5, 0.5, 1, 1]));
    expectIdentical((await renderNode(def, { inputs: { in: 'one' }, params })).out, flat([0.5, 0.5, 1, 1]));
  }
});

test('color/normal-map: a plane has one normal up to the border, from its physical slope, at every radius', async () => {
  // rampX rises by the height range across the terrain: 1024 m over 4096 m, a slope of 0.25 towards +X.
  for (const params of [RAW, DEFAULTS, { radius: 0.01 }, { radius: 0.08 }]) {
    expectClose((await renderNode(def, { inputs: { in: 'rampX' }, params })).out, flat(ofSlope(0.25, 0)), { max: COLOR });
    expectClose((await renderNode(def, { inputs: { in: 'rampY' }, params })).out, flat(ofSlope(0, 0.25)), { max: COLOR });
    const oblique = fieldOf(257, (u, v) => 0.2 + 1.2 * u - 0.6 * v);
    expectClose((await renderNode(def, { inputs: { in: oblique }, params })).out, flat(ofSlope(0.3, -0.15)), { max: COLOR });
  }
});

test('color/normal-map: red is the normal towards +X and green the normal towards +Y, down the picture', async () => {
  // Ground that falls towards +X faces +X: its normal leans that way, and red is above the middle.
  const facesX = (await renderNode(def, { inputs: { in: fieldOf(257, (u) => 1 - u) }, params: RAW })).out;
  assert.ok(at(facesX, 128, 128, 0) > 0.6 && Math.abs(at(facesX, 128, 128, 1) - 0.5) < COLOR);
  // Ground that falls towards +Y, down the picture, faces down the picture: green is above the middle there,
  // which is the convention of DirectX and of Unreal.
  const facesY = (await renderNode(def, { inputs: { in: fieldOf(257, (u, v) => 1 - v) }, params: RAW })).out;
  assert.ok(at(facesY, 128, 128, 1) > 0.6 && Math.abs(at(facesY, 128, 128, 0) - 0.5) < COLOR);
  // On a cone every side faces away from the summit at the centre.
  const cone = (await renderNode(def, { inputs: { in: 'cone' }, params: RAW })).out;
  assert.ok(at(cone, 160, 128, 0) > 0.6 && at(cone, 96, 128, 0) < 0.4, 'right of the summit the normal points to +X, left of it to -X');
  assert.ok(at(cone, 128, 160, 1) > 0.6 && at(cone, 128, 96, 1) < 0.4, 'below the summit the normal points to +Y, above it to -Y');
});

test('color/normal-map: the map is the normal of the physical slopes at every texel, the border included', async () => {
  for (const src of [fixtures.terrain(257), fixtures.basin(257)]) {
    const { gx, gy } = slopes(src);
    const { out } = await renderNode(def, { inputs: { in: src }, params: RAW });
    expectClose(out, colorFrom(src, (i) => ofSlope(gx[i]!, gy[i]!)), { max: COLOR });
  }
  // A paraboloid has its own normal up to the border and into the corners: no frame of another slope there.
  const paraboloid = fieldOf(257, (u, v) => 0.2 + 0.5 * u * u + 0.3 * v * v + 0.2 * u * v);
  const { out } = await renderNode(def, { inputs: { in: paraboloid }, params: RAW });
  const scale = HEIGHT_RANGE / TERRAIN_SIZE;
  expectClose(out, colorOf(257, (u, v) => ofSlope((u + 0.2 * v) * scale, (0.6 * v + 0.2 * u) * scale)), { max: COLOR });
});

test('color/normal-map: every stored normal has the length 1', async () => {
  const src = await fixtures.fbm(257);
  for (const params of [RAW, DEFAULTS, { strength: 0.3 }]) {
    const { out } = await renderNode(def, { inputs: { in: src }, params });
    let worst = 0;
    for (let i = 0; i < out.width * out.height; i++) {
      const length = Math.hypot(2 * out.data[i * 4]! - 1, 2 * out.data[i * 4 + 1]! - 1, 2 * out.data[i * 4 + 2]! - 1);
      worst = Math.max(worst, Math.abs(length - 1));
    }
    assert.ok(worst <= 2 * COLOR, `a stored normal is ${worst} away from the length 1`);
  }
});

test('color/normal-map: slopes are physical: twice the height range is twice the slope, and the same shape at twice the size is the same map', async () => {
  const tall = await renderNode(def, { inputs: { in: 'rampX' }, params: RAW, settings: { heightRange: 2 * HEIGHT_RANGE } });
  expectClose(tall.out, flat(ofSlope(0.5, 0)), { max: COLOR });
  const wide = await renderNode(def, { inputs: { in: 'rampX' }, params: RAW, settings: { terrainSize: 2 * TERRAIN_SIZE } });
  expectClose(wide.out, flat(ofSlope(0.125, 0)), { max: COLOR });
  const terrain = (await renderNode(def, { inputs: { in: 'terrain' } })).out;
  const scaled = (await renderNode(def, { inputs: { in: 'terrain' }, settings: { terrainSize: 2 * TERRAIN_SIZE, heightRange: 2 * HEIGHT_RANGE } })).out;
  expectClose(scaled, terrain, { max: COLOR });
});

test('color/normal-map: the strength scales the slopes the normals are made from, down to a level map', async () => {
  for (const strength of [0.5, 0.2]) {
    expectClose((await renderNode(def, { inputs: { in: 'rampX' }, params: { ...RAW, strength } })).out, flat(ofSlope(0.25 * strength, 0)), { max: COLOR });
  }
  const src = fixtures.terrain(257);
  const { gx, gy } = slopes(src);
  const half = await renderNode(def, { inputs: { in: src }, params: { ...RAW, strength: 0.5 } });
  expectClose(half.out, colorFrom(src, (i) => ofSlope(0.5 * gx[i]!, 0.5 * gy[i]!)), { max: COLOR });
  expectIdentical((await renderNode(def, { inputs: { in: src }, params: { strength: 0 } })).out, flat([0.5, 0.5, 1, 1]));
});

test('color/normal-map: a larger radius leaves out small detail: the normals stand closer to upright', async () => {
  const src = await fixtures.fbm(257);
  const upright = async (radius: number): Promise<number> => stats((await renderNode(def, { inputs: { in: src }, params: { radius } })).out, 2).mean;
  const raw = await upright(0.0001), fine = await upright(0.004), broad = await upright(0.03);
  assert.ok(raw < fine - 0.01 && fine < broad - 0.02, `the mean of blue is ${raw}, ${fine} and ${broad}`);
});

test('color/normal-map: two levels of the ladder agree where the radius is wider than their texels', async () => {
  // The terrain fixture is smooth at the scale of a texel: the map of the coarser level is that of the finer one.
  const levels = await renderLadder(def, { inputs: { in: 'terrain' } });
  const smooth = compareLadder(levels[257]!.out!, levels[513]!.out!);
  assert.ok(smooth.rel <= 0.005, `the terrain fixture differs by ${smooth.rel} of its standard deviation`);
  // A rough terrain has detail down to 8 texels of the coarser level. With a radius of 0.01, 2.56 of its texels,
  // both levels see the same smoothed ground.
  const coarse = (await renderNode(def, { res: 257, inputs: { in: rough(257) }, params: { radius: 0.01 } })).out;
  const fine = (await renderNode(def, { res: 513, inputs: { in: rough(513) }, params: { radius: 0.01 } })).out;
  const wide = compareLadder(coarse, fine);
  assert.ok(wide.rel <= 0.01, `at a radius of 0.01 a rough terrain differs by ${wide.rel} of its standard deviation`);
});
