// The Unreal arithmetic of export-unreal.md section 5, at the level of numbers: the layouts of 5.2, the worked
// example of 5.6 to the digits the contract prints, the bounds of the height quantisation of 5.4, and the
// properties of the joint weight quantisation of 5.8.
//
// These are tests of arithmetic. That Unreal Engine reads the numbers as section 5 assumes is unverified
// (export-unreal.md section 11); the acceptance pattern of its section 9 is what settles that.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashCell, hashU32, hashUnit } from '../../../src/core/api.ts';
import { encodedBytes } from '../../../src/export/plan.ts';
import {
  DITHER_SEED, heightMapping, landscapeLayout, landscapeTransform, nearestLandscapeSizes, quantiseHeights, quantiseWeights, SRGB8, textureSide,
  weightFloorCode, worldZOfCode,
} from '../../../src/export/unreal.ts';
import { assertSame } from './_support.ts';

/** A small deterministic generator: uniform integers below `n`. */
function random(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
}

test('landscapeLayout: the table of 5.2, the further rows of Epic\'s table, and null for a size without a layout', () => {
  const layout = (n: number): unknown => {
    const l = landscapeLayout(n);
    return l && [l.quadsPerSection, l.sectionsPerComponent, l.components, l.totalComponents];
  };
  assert.deepEqual(layout(1009), [63, 2, 8, 64]);
  assert.deepEqual(layout(2017), [63, 2, 16, 256]);
  assert.deepEqual(layout(4033), [63, 2, 32, 1024]);
  assert.deepEqual(layout(8129), [127, 2, 32, 1024]);
  assert.deepEqual(layout(127), [63, 2, 1, 1]);
  assert.deepEqual(layout(253), [63, 2, 2, 4]);
  assert.deepEqual(layout(505), [63, 2, 4, 16]);
  for (const n of [2049, 4097, 513, 1025, 8192, 1, 2, 0]) assert.equal(landscapeLayout(n), null, `${n} has no layout`);
  // Every layout has exactly n vertices, and no other has fewer components.
  for (const n of [8, 255, 511, 1021, 2041, 8161, 3025]) {
    const l = landscapeLayout(n)!;
    assert.equal(l.components * l.quadsPerSection * l.sectionsPerComponent + 1, n);
    assert.ok(l.components >= 1 && l.components <= 32 && l.totalComponents === l.components ** 2);
  }
  // 510-quad components: 16 x 16 of them, not 32 x 32 of 255 quads.
  assert.deepEqual(layout(8161), [255, 2, 16, 256]);
  assert.deepEqual(nearestLandscapeSizes(2049), { below: 2033, above: 3025 });
  assert.deepEqual(nearestLandscapeSizes(4097), { below: 4081, above: 6097 });
  for (const size of [2033, 3025, 4081, 6097]) assert.ok(landscapeLayout(size) !== null && (size - 1) % 16 === 0, `${size} is a landscape size and a build resolution`);
});

test('the worked example of 5.6: 8129, 8 km, 2400 m of relief, to the digits the contract prints', () => {
  const { a, b, widened } = heightMapping({ mode: 'measured', headroom: 0 }, 0.05, 0.85, 3000);
  assert.deepEqual([a, b, widened], [0.05, 0.85, false]);
  const t = landscapeTransform({ resolution: 8129, terrainSize: 8000, heightRange: 3000, seaLevel: 0.1, a, b, zeroAt: 'seaLevel', origin: 'center' });

  // A number literal is the float64 nearest to its digits, and JSON writes the shortest digits that read back to
  // it: equality with these literals is equality with what the manifest of 6.2 prints.
  assert.deepEqual(t.scaleCm, { x: 98.4251968503937, y: 98.4251968503937, z: 468.75715266651406 });
  assert.deepEqual(t.actorLocationCm, { x: -400000, y: -400000, z: 105001.8310826276 });
  assert.deepEqual(t.uiLocationCm, { x: 0, y: 0, z: 105001.8310826276 });
  assert.deepEqual([t.heightMinM, t.heightMaxM, t.seaLevelZCm], [-150, 2250, 0]);
  assert.equal(JSON.stringify(t.scaleCm), '{"x":98.4251968503937,"y":98.4251968503937,"z":468.75715266651406}');

  assert.equal((t.scaleCm.z / 128).toPrecision(13), '3.662165255207', 'one code, in cm');
  assert.equal((t.scaleCm.x * 254).toPrecision(12), '25000.0000000', 'one component of 254 quads is 250 m');
  // The check lines: code 0 and code 65535 lie at the bottom and the top of the mapped range.
  assert.equal(worldZOfCode(0, t).toPrecision(12), '-15000.0000000');
  assert.equal(worldZOfCode(65535, t).toPrecision(12), '225000.000000');
  assert.equal(worldZOfCode(32768, t), t.actorLocationCm.z, 'code 32768 is the actor\'s Z');
  assert.equal((0.1 - 0.05) / 0.8 * 65535, 4095.9375);
  const sea = new Uint16Array(1);
  quantiseHeights(Float32Array.of(0.1), sea, { width: 1, y0: 0, a, b, dither: false });
  assert.equal(sea[0], 4096, 'the sea level, without dither');

  // Epic's approximate rule, range / 512, would leave the top one code low.
  const epic = 240000 / 512;
  assert.deepEqual([epic, -15000 + 256 * epic, (-15000 + 256 * epic + 255.9921875 * epic).toFixed(2)], [468.75, 105000, '224996.34']);

  assert.equal(8129 * 8129, 66_080_641);
  assert.equal(encodedBytes('raw-u16', 8129, 8129), 132_161_282);
  assert.equal(encodedBytes('raw-u8', 8129, 8129), 66_080_641);

  // The other choices of zero and origin, by the formulas of 5.5.
  const corner = landscapeTransform({ resolution: 8129, terrainSize: 8000, heightRange: 3000, seaLevel: 0.1, a, b, zeroAt: 'bottom', origin: 'corner' });
  assert.deepEqual([corner.actorLocationCm.x, corner.actorLocationCm.y, corner.uiLocationCm.x, corner.uiLocationCm.y], [0, 0, 400000, 400000]);
  assert.equal(corner.heightMinM.toPrecision(12), '150.000000000', 'height 0 at world Z 0: the terrain starts 150 m up');
  assert.equal(corner.seaLevelZCm.toPrecision(12), '30000.0000000');
  assert.equal(corner.scaleCm.z, t.scaleCm.z, 'the scale does not depend on where zero is');
});

test('the file sizes of 4.2 at 8129 x 8129', () => {
  const sizes = (['raw-u8', 'raw-u16', 'raw-f32', 'exr-f32', 'tiff-u16', 'tiff-f32'] as const).map((encoding) => encodedBytes(encoding, 8129, 8129));
  assert.deepEqual(sizes, [66_080_641, 132_161_282, 264_322_564, 264_452_905, 132_162_452, 264_323_734]);
  assert.deepEqual([encodedBytes('png-gray16', 8129, 8129), encodedBytes('json', 0, 0)], [null, null]);
  assert.equal(8129 * (1 + 8129 * 2), 132_169_411, 'the scanlines of a 16-bit grey PNG');
});

test('heightMapping: headroom widens both ends, a fixed range is taken as given, and less than 1 m becomes 1 m about its middle', () => {
  const close = (found: number, expected: number): void => assert.ok(Math.abs(found - expected) < 1e-15, `${found} is not ${expected}`);
  const wide = heightMapping({ mode: 'measured', headroom: 0.25 }, 0.2, 0.6, 1000);
  close(wide.a, 0.1);
  close(wide.b, 0.7);
  assert.equal(wide.widened, false);
  assert.deepEqual(heightMapping({ mode: 'fixed', min: -0.5, max: 2 }, 0.2, 0.6, 1000), { a: -0.5, b: 2, widened: false });

  // A flat terrain: 1 m of a 1000 m range is 0.001.
  const flat = heightMapping({ mode: 'measured', headroom: 0 }, 0.4, 0.4, 1000);
  assert.equal(flat.widened, true);
  close(flat.a, 0.3995);
  close(flat.b, 0.4005);
  const thin = heightMapping({ mode: 'measured', headroom: 0 }, 0.4, 0.4006, 1000);
  assert.equal(thin.widened, true);
  close(thin.a, 0.3998);
  close(thin.b, 0.4008);
  assert.equal(heightMapping({ mode: 'fixed', min: 0.25, max: 0.251 }, 0, 1, 1000).widened, false, 'exactly 1 m is kept');
  assert.equal(heightMapping({ mode: 'fixed', min: 0.25, max: 0.2505 }, 0, 1, 1000).widened, true);
  assert.equal(heightMapping({ mode: 'fixed', min: 0.25, max: 0.2505 }, 0, 1, 2000).widened, false, '0.0005 of 2000 m is 1 m');
});

test('quantiseHeights: without dither the nearest code, within half a code; the range ends are codes 0 and 65535; samples outside are clipped and counted', () => {
  const a = 0.125, b = 0.875;
  const next = random(7);
  const src = new Float32Array(50_000);
  for (let i = 0; i < src.length; i++) src[i] = a + (b - a) * (next(1 << 24) / (1 << 24));
  src[0] = a;
  src[1] = b;
  const dst = new Uint16Array(src.length);
  assert.equal(quantiseHeights(src, dst, { width: 250, y0: 0, a, b, dither: false }), 0);
  assert.deepEqual([dst[0], dst[1]], [0, 65535]);
  const code = (b - a) / 65535;
  let worst = 0, notNearest = 0;
  for (let i = 0; i < src.length; i++) {
    worst = Math.max(worst, Math.abs(a + dst[i]! * code - src[i]!));
    if (dst[i] !== Math.round((src[i]! - a) / (b - a) * 65535)) notNearest++;
  }
  assert.ok(worst <= 0.5 * code * (1 + 1e-9), `the largest error is ${worst / code} codes`);
  assert.equal(notNearest, 0);

  // Outside the range: clipped to the end codes, and counted.
  const out = new Uint16Array(6);
  const clipped = quantiseHeights(Float32Array.of(-1, 0.1249, 0.125, 0.875, 0.8751, 9), out, { width: 6, y0: 0, a, b, dither: false });
  assert.equal(clipped, 4);
  assert.deepEqual([...out], [0, 0, 0, 65535, 65535, 65535]);
});

test('quantiseHeights: with dither the error stays under 1.5 codes, the noise is triangular, and it depends on the texel alone', () => {
  const a = 0, b = 1, width = 173, rows = 300;
  const next = random(11);
  const src = new Float32Array(width * rows);
  for (let i = 0; i < src.length; i++) src[i] = next(1 << 24) / (1 << 24);
  const whole = new Uint16Array(src.length);
  assert.equal(quantiseHeights(src, whole, { width, y0: 0, a, b, dither: true }), 0);
  let worst = 0;
  for (let i = 0; i < src.length; i++) worst = Math.max(worst, Math.abs(whole[i]! / 65535 - src[i]!));
  assert.ok(worst < 1.5 / 65535, `the largest error is ${worst * 65535} codes`);

  // The same file whatever the bands: each band is told the row it begins at.
  for (const band of [1, 7, 64, 299]) {
    const banded = new Uint16Array(src.length);
    for (let y0 = 0; y0 < rows; y0 += band) {
      const y1 = Math.min(rows, y0 + band);
      quantiseHeights(src.subarray(y0 * width, y1 * width), banded.subarray(y0 * width, y1 * width), { width, y0, a, b, dither: true });
    }
    assertSame(banded, whole, `bands of ${band} rows`);
  }

  // The dither is the sum of two uniform values minus 1, from the hash of the texel position: computed here again.
  const flat = new Float32Array(width * rows).fill(Math.fround(0.5));
  const codes = new Uint16Array(flat.length);
  quantiseHeights(flat, codes, { width, y0: 5, a, b, dither: true });
  let wrong = 0;
  const counts = new Map<number, number>();
  for (let i = 0; i < flat.length; i++) {
    const h = hashCell(i % width, 5 + Math.floor(i / width), DITHER_SEED);
    const expected = Math.floor(flat[i]! * 65535 + 0.5 + hashUnit(h) + hashUnit(hashU32(h)) - 1);
    if (codes[i] !== expected) wrong++;
    counts.set(codes[i]!, (counts.get(codes[i]!) ?? 0) + 1);
  }
  assert.equal(wrong, 0);
  // 0.5 is code 32767.5: the +0.5 of the rounding makes it 32768 + t, and a triangular t in (-1, 1) falls below 0 half the time.
  assert.deepEqual([...counts.keys()].sort(), [32767, 32768]);
  const share = counts.get(32767)! / flat.length;
  assert.ok(Math.abs(share - 0.5) < 0.01, `${share} of the texels fall to the lower code`);
});

/** The exact weights of one texel by the rule of 5.8, as fractions of 255: floor, base, limit. */
function exactWeights(p: readonly number[], floorCode: number, limit: number): number[] {
  const e = [0, ...p.map((v) => (v >= floorCode ? v : 0))];
  e[0] = Math.max(0, 65535 - e.reduce((sum, v) => sum + v, 0));
  if (limit > 0) {
    for (let kept = e.filter((v) => v > 0).length; kept > limit; kept--) {
      let m = -1;
      for (let j = 0; j < e.length; j++) if (e[j]! > 0 && (m < 0 || e[j]! <= e[m]!)) m = j;
      e[m] = 0;
    }
  }
  const total = e.reduce((sum, v) => sum + v, 0);
  return e.map((v) => 255 * v / total);
}

function quantised(planes: readonly Uint16Array[], floorCode = 0, limit = 0): Uint8Array[] {
  const count = planes[0]?.length ?? 1;
  const out = Array.from({ length: planes.length + 1 }, () => new Uint8Array(count));
  quantiseWeights(planes, out, { offset: 0, count, floorCode, limit });
  return out;
}

/** The texels whose bytes do not total 255. */
function wrongTotals(out: readonly Uint8Array[]): number {
  let wrong = 0;
  for (let t = 0; t < out[0]!.length; t++) {
    let sum = 0;
    for (const bytes of out) sum += bytes[t]!;
    if (sum !== 255) wrong++;
  }
  return wrong;
}

test('quantiseWeights: the bytes total exactly 255 on every texel, for random planes and for adversarial ones', () => {
  const next = random(23);
  const count = 20_000;
  for (const [layers, floorCode, limit] of [[1, 0, 0], [2, 0, 0], [6, 0, 0], [15, 0, 0], [6, 524, 0], [6, 0, 3], [15, 524, 4], [4, 16384, 1], [3, 65535, 16]] as const) {
    const planes = Array.from({ length: layers }, () => Uint16Array.from({ length: count }, () => next(65536)));
    assert.equal(wrongTotals(quantised(planes, floorCode, limit)), 0, `${layers} random layers, floor ${floorCode}, limit ${limit}`);
  }
  // Planes of few distinct values: ties on every texel, sums far above and far below a full weight.
  const values = [0, 1, 2, 255, 256, 257, 523, 524, 525, 21845, 21846, 32767, 32768, 65534, 65535];
  for (const layers of [1, 2, 3, 7, 15]) {
    for (const [floorCode, limit] of [[0, 0], [524, 0], [0, 1], [0, 2], [524, 3], [1, 15], [65535, 0], [0, 16]] as const) {
      const planes = Array.from({ length: layers }, () => Uint16Array.from({ length: 5000 }, () => values[next(values.length)]!));
      assert.equal(wrongTotals(quantised(planes, floorCode, limit)), 0, `${layers} layers of few values, floor ${floorCode}, limit ${limit}`);
    }
  }
  // Every layer full, every layer empty, every layer one step, and no layer at all.
  for (const value of [65535, 0, 1, 4369, 4370]) {
    const out = quantised(Array.from({ length: 15 }, () => new Uint16Array(64).fill(value)), 0, 0);
    assert.equal(wrongTotals(out), 0, `fifteen layers of ${value}`);
  }
  assert.deepEqual(quantised([]).map((bytes) => bytes[0]), [255], 'without a layer the base is everything');
});

test('quantiseWeights: without floor and limit each byte is within 1 of its exact share, and the edge cases are as 5.8 states them', () => {
  const next = random(31);
  const count = 20_000;
  for (const layers of [1, 3, 6]) {
    const planes = Array.from({ length: layers }, () => Uint16Array.from({ length: count }, () => next(65536) >> next(4)));
    const out = quantised(planes);
    let worst = 0;
    for (let t = 0; t < count; t++) {
      const exact = exactWeights(planes.map((plane) => plane[t]!), 0, 0);
      for (let j = 0; j <= layers; j++) worst = Math.max(worst, Math.abs(out[j]![t]! - exact[j]!));
    }
    assert.ok(worst < 1, `${layers} layers: the largest difference from the exact share is ${worst}`);
  }
  // With a floor and a limit the same holds against the weights after both.
  const planes = Array.from({ length: 5 }, () => Uint16Array.from({ length: count }, () => next(65536) >> next(8)));
  const out = quantised(planes, 524, 3);
  let worst = 0, kept = 0;
  for (let t = 0; t < count; t++) {
    const exact = exactWeights(planes.map((plane) => plane[t]!), 524, 3);
    for (let j = 0; j <= 5; j++) worst = Math.max(worst, Math.abs(out[j]![t]! - exact[j]!));
    kept = Math.max(kept, out.filter((bytes) => bytes[t]! > 0).length);
  }
  assert.ok(worst < 1, `floor and limit: the largest difference is ${worst}`);
  assert.ok(kept <= 3, `at most 3 layers are kept on a texel, and ${kept} were`);

  const at = (values: readonly number[], floorCode = 0, limit = 0): number[] => quantised(values.map((v) => Uint16Array.of(v)), floorCode, limit).map((bytes) => bytes[0]!);
  assert.deepEqual(at([0, 0, 0]), [255, 0, 0, 0], 'all zero: the base takes everything');
  assert.deepEqual(at([65535, 0]), [0, 255, 0], 'one layer full');
  assert.deepEqual(at([65535, 65535, 65535]), [0, 85, 85, 85], 'three full layers share the weight');
  // Where the layers total at most 1 each keeps its weight and the base receives the rest.
  assert.deepEqual(at([13107, 26214]), [102, 51, 102], '0.2 and 0.4 leave 0.4');
  // Where they total more they are scaled down in proportion, and the base is 0.
  assert.deepEqual(at([65535, 21845]), [0, 191, 64], '1 and a third: three quarters and a quarter');
  // Ties in the remainder go to the lower index: two halves of 65536 are 127.5 each.
  assert.deepEqual(at([32768, 32768]), [0, 128, 127]);
  // The base ties with a layer: 32767 and 32768 of 65535 are 127.498 and 127.502.
  assert.deepEqual(at([32768]), [127, 128]);
  // The floor removes a small weight, which the base then receives.
  assert.deepEqual(at([523, 65012], 0), [0, 2, 253]);
  assert.deepEqual(at([523, 65012], 524), [2, 0, 253]);
  // A limit of 1 keeps the largest entry alone; among equals the lower index stays.
  assert.deepEqual(at([20000, 30000, 10000], 0, 1), [0, 0, 255, 0]);
  assert.deepEqual(at([1000, 2000], 0, 1), [255, 0, 0], 'the base is the largest');
  assert.deepEqual(at([30000, 30000], 0, 1), [0, 255, 0]);
  assert.deepEqual(at([21845, 21845], 0, 1), [255, 0, 0], 'three equal entries, the base among them: the base stays');
});

test('quantiseWeights: the order of the layers changes nothing but ties, and offset and count select the texels', () => {
  // Weights without ties: the outputs follow the layers when these are exchanged.
  const a = Uint16Array.of(10000, 3, 40000, 65535, 0), b = Uint16Array.of(20000, 50000, 30001, 100, 0), c = Uint16Array.of(5000, 7, 9, 11, 13);
  const abc = quantised([a, b, c]), cab = quantised([c, a, b]);
  assertSame(cab[0]!, abc[0]!, 'the base');
  assertSame(cab[2]!, abc[1]!, 'layer a');
  assertSame(cab[3]!, abc[2]!, 'layer b');
  assertSame(cab[1]!, abc[3]!, 'layer c');

  const plane = Uint16Array.from({ length: 100 }, (_, i) => i * 655);
  const whole = quantised([plane]);
  const part = [new Uint8Array(10), new Uint8Array(10)];
  quantiseWeights([plane], part, { offset: 40, count: 10, floorCode: 0, limit: 0 });
  assertSame(part[0]!, whole[0]!.subarray(40, 50), 'the base of texels 40 to 49');
  assertSame(part[1]!, whole[1]!.subarray(40, 50), 'the layer of texels 40 to 49');
  assert.equal(weightFloorCode(0.008), 524);
  assert.deepEqual([weightFloorCode(0), weightFloorCode(0.25)], [0, 16384]);
});

test('SRGB8 holds the 8-bit sRGB code of every 16-bit linear value, and a texture is as large as 2.2 says', () => {
  const encode = (c: number): number => Math.floor((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255 + 0.5);
  let wrong = 0, falling = 0;
  for (let i = 0; i < 65536; i++) {
    if (SRGB8[i] !== encode(i / 65535)) wrong++;
    if (i > 0 && SRGB8[i]! < SRGB8[i - 1]!) falling++;
  }
  assert.deepEqual([wrong, falling], [0, 0]);
  // Black, white, and two values that are known: linear 0.5 is sRGB 188, and the sRGB middle grey 128 is linear 0.2159.
  assert.deepEqual([SRGB8[0], SRGB8[65535], SRGB8[Math.round(0.5 * 65535)], SRGB8[Math.round(0.2159 * 65535)]], [0, 255, 188, 128]);

  assert.deepEqual([1009, 2017, 4033, 8129].map((res) => textureSide('auto', res)), [1024, 2048, 4096, 8192]);
  assert.deepEqual([129, 1025, 1026, 2049, 2050, 4097, 4098, 8177].map((res) => textureSide('auto', res)), [1024, 1024, 2048, 2048, 4096, 4096, 8192, 8192]);
  assert.deepEqual([textureSide(1024, 8129), textureSide(8192, 129)], [1024, 8192]);
});
