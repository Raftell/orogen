// tests/nodes/color/hillshade.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, channelOf, colorOf, conformance, expectClose, expectIdentical, fieldOf, fixtures, renderNode, type FieldData } from '../../helpers/index.ts';
import def from '../../../src/core/nodes/color/hillshade.ts';
import { COLOR, colorFrom, HEIGHT_RANGE, radians, TERRAIN_SIZE } from './_reference.ts';

conformance(def);

/** The share of the light that comes from the whole sky; the rest comes from the sun. */
const SKY = 0.3;
/** Half the height of the sun's disc, in degrees. */
const HALF_DISC = 2.5;

/** The unit vector towards a sun in the direction `angle`, `elevation` degrees above the horizon. */
const sunAt = (angle: number, elevation: number): readonly [number, number, number] =>
  [Math.cos(radians(elevation)) * Math.cos(radians(angle)), Math.cos(radians(elevation)) * Math.sin(radians(angle)), Math.sin(radians(elevation))];

/** The light on open ground with the physical gradient (gx, gy) that sees all of the sun and is sheltered by nothing. */
function openLight(gx: number, gy: number, angle: number, elevation: number): number {
  const length = Math.hypot(gx, gy, 1);
  const n = [-gx / length, -gy / length, 1 / length] as const;
  const sun = sunAt(angle, elevation);
  const direct = Math.max(n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2], 0);
  return (1 - SKY) * direct + SKY * (0.5 + 0.5 * n[2]);
}
const gray = (value: number): FieldData => colorOf(257, () => [value, value, value, 1]);

/** A plateau 64 m high over the texels up to column 100, level ground at 0 beyond: a step with its wall between 100 and 101. */
const STEP_HEIGHT = 0.0625;
const step = fieldOf(257, (u) => (Math.round(u * 256) <= 100 ? STEP_HEIGHT : 0));

test('color/hillshade: level ground in the open is lit by the sun as its elevation says and by the whole sky', async () => {
  for (const elevation of [15, 40, 70, 90]) {
    for (const angle of [0, 77, 225]) {
      const { out } = await renderNode(def, { inputs: { in: 'zero', base: null }, params: { angle, elevation } });
      expectClose(out, gray(openLight(0, 0, angle, elevation)), { max: COLOR });
    }
  }
  // The default light, and a height that is not 0: the level counts for nothing.
  expectClose((await renderNode(def, { inputs: { in: 'one', base: null } })).out, gray(openLight(0, 0, 225, 40)), { max: COLOR });
});

test('color/hillshade: a slope is lit by the cosine between its normal and the sun, and the direction is the one towards the sun', async () => {
  // rampX rises towards +X with a slope of 0.25, and it faces -X: the direction 180. Nothing stands between
  // it and a sun that is higher than the 14 degrees of its rise.
  for (const [angle, elevation] of [[180, 30], [0, 30], [90, 40], [135, 55], [270, 80]] as const) {
    const { out } = await renderNode(def, { inputs: { in: 'rampX', base: null }, params: { angle, elevation } });
    expectClose(out, gray(openLight(0.25, 0, angle, elevation)), { max: COLOR });
  }
  const towards = (await renderNode(def, { inputs: { in: 'rampX', base: null }, params: { angle: 180, elevation: 30 } })).out;
  const away = (await renderNode(def, { inputs: { in: 'rampX', base: null }, params: { angle: 0, elevation: 30 } })).out;
  assert.ok(at(towards, 128, 128) > at(away, 128, 128) + 0.2, `the slope that faces the sun is ${at(towards, 128, 128)}, the one that faces away ${at(away, 128, 128)}`);
});

test('color/hillshade: a wall casts a shadow as long as its height over the tangent of the elevation, with a soft edge', async () => {
  // The sun stands in the direction 180, towards -X, behind the plateau, 30 degrees high. Its disc reaches from
  // 27.5 to 32.5 degrees: the wall of 64 m hides all of it up to 64 / tan(32.5) = 100 m, 6.3 cells, and none of
  // it beyond 64 / tan(27.5) = 123 m, 7.7 cells.
  const elevation = 30;
  const { out } = await renderNode(def, { inputs: { in: step, base: null }, params: { angle: 180, elevation } });
  const lit = (await renderNode(def, { inputs: { in: step, base: null }, params: { angle: 0, elevation } })).out;
  const level = openLight(0, 0, 180, elevation);
  const hidden = Math.floor((STEP_HEIGHT * HEIGHT_RANGE) / Math.tan(radians(elevation + HALF_DISC)) / 16);
  const clear = Math.ceil((STEP_HEIGHT * HEIGHT_RANGE) / Math.tan(radians(elevation - HALF_DISC)) / 16);
  assert.deepEqual([hidden, clear], [6, 8]);
  for (const y of [0, 100, 256]) {
    // In the shadow only the sky lights the ground, and the wall beside it closes part of the sky.
    for (let x = 102; x <= 100 + hidden; x++) {
      assert.ok(at(out, x, y) <= SKY + COLOR && at(out, x, y) > 0.05, `${x - 100} cells from the wall the ground is ${at(out, x, y)}`);
      assert.ok(at(lit, x, y) > at(out, x, y) + 0.2, `${x - 100} cells from the wall the sun from the other side gives ${at(lit, x, y)}`);
    }
    // Beyond the shadow the ground comes back to the light of open ground as the wall recedes.
    for (let x = 100 + clear; x < 257; x++) assert.ok(at(out, x, y) > SKY + 0.1 && at(out, x, y) <= level + COLOR, `${x - 100} cells from the wall the ground is ${at(out, x, y)}`);
    for (let x = 160; x < 257; x++) assert.ok(Math.abs(at(out, x, y) - level) <= 2 * COLOR, `${x - 100} cells from the wall the ground is ${at(out, x, y)}; open ground is ${level}`);
    // The plateau itself is open ground.
    for (let x = 0; x <= 60; x++) assert.ok(Math.abs(at(out, x, y) - level) <= 2 * COLOR, `the plateau at ${x} is ${at(out, x, y)}`);
  }
});

test('color/hillshade: the floor of a hollow is darker than open ground under the same sun', async () => {
  // A dimple 51 m deep and some 250 m wide. Its floor is level and sees all of a sun 40 degrees high, since its
  // sides rise at 14 degrees at the most: what darkens it is the shelter alone.
  const dimple = fieldOf(257, (u, v) => 0.5 - 0.05 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / (2 * 0.03 ** 2)));
  const { out } = await renderNode(def, { inputs: { in: dimple, base: null } });
  const level = openLight(0, 0, 225, 40);
  assert.ok(Math.abs(at(out, 5, 5) - level) <= COLOR, `far from the hollow the ground is ${at(out, 5, 5)}`);
  assert.ok(at(out, 128, 128) < level - 0.05 && at(out, 128, 128) > 0.5 * level, `the floor of the hollow is ${at(out, 128, 128)}; open ground is ${level}`);
  // A bump of the same shape is sheltered by nothing: its level top is lit as open ground is.
  const bump = fieldOf(257, (u, v) => 0.5 + 0.05 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / (2 * 0.03 ** 2)));
  const top = (await renderNode(def, { inputs: { in: bump, base: null } })).out;
  assert.ok(Math.abs(at(top, 128, 128) - level) <= 2 * COLOR, `the top of the bump is ${at(top, 128, 128)}`);
});

test('color/hillshade: the light multiplies the base color, and the strength fades it in', async () => {
  // On level ground the light is one number: the base comes out darker by it, hue and all.
  const base = fixtures.color(257);
  const light = openLight(0, 0, 225, 40);
  const full = await renderNode(def, { inputs: { in: 'zero', base } });
  expectClose(full.out, colorFrom(base, (i) => [base.data[i * 4]! * light, base.data[i * 4 + 1]! * light, base.data[i * 4 + 2]! * light, 1]), { max: COLOR });
  const half = await renderNode(def, { inputs: { in: 'zero', base }, params: { strength: 0.5 } });
  const faded = 1 + 0.5 * (light - 1);
  expectClose(half.out, colorFrom(base, (i) => [base.data[i * 4]! * faded, base.data[i * 4 + 1]! * faded, base.data[i * 4 + 2]! * faded, 1]), { max: COLOR });

  // No strength leaves the base as it is, on any terrain; without a base that is white.
  const none = await renderNode(def, { inputs: { in: 'terrain', base }, params: { strength: 0 } });
  const stored = await renderNode(def, { inputs: { in: 'zero', base }, params: { strength: 0 } });
  expectIdentical(none.out, stored.out);
  expectClose(none.out, base, { max: COLOR });
  expectIdentical((await renderNode(def, { inputs: { in: 'terrain', base: null }, params: { strength: 0 } })).out, gray(1));
});

test('color/hillshade: the picture is opaque whatever the alpha of the base, and no brighter than the base', async () => {
  const base = colorOf(257, (u, v) => [0.2 + 0.6 * u, 0.9 - 0.5 * v, 0.5, 0.25 * u]);
  const { out } = await renderNode(def, { inputs: { in: 'terrain', base } });
  expectIdentical(channelOf(out, 3), fixtures.one(257));
  for (let i = 0; i < 257 * 257; i++) {
    for (let c = 0; c < 3; c++) {
      if (out.data[i * 4 + c]! > base.data[i * 4 + c]! + COLOR || out.data[i * 4 + c]! < 0) assert.fail(`texel ${i}, channel ${c}: ${out.data[i * 4 + c]} over a base of ${base.data[i * 4 + c]}`);
    }
  }
});

test('color/hillshade: shadows and slopes are physical: the same shape at twice the size is the same picture', async () => {
  const terrain = (await renderNode(def, { inputs: { in: 'terrain', base: null } })).out;
  const scaled = (await renderNode(def, { inputs: { in: 'terrain', base: null }, settings: { terrainSize: 2 * TERRAIN_SIZE, heightRange: 2 * HEIGHT_RANGE } })).out;
  expectClose(scaled, terrain, { max: COLOR });
  // Twice the height range alone is a steeper terrain with longer shadows: a darker picture.
  const tall = (await renderNode(def, { inputs: { in: 'terrain', base: null }, settings: { heightRange: 2 * HEIGHT_RANGE } })).out;
  let sum = 0, sumTall = 0;
  for (let i = 0; i < 257 * 257; i++) {
    sum += terrain.data[i * 4]!;
    sumTall += tall.data[i * 4]!;
  }
  assert.ok(sumTall < 0.9 * sum, `the mean light is ${sum / 257 ** 2} and ${sumTall / 257 ** 2} at twice the height range`);
});
