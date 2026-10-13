// Sample conversion, the vertex normals and the texel-grid resampler of the build pipeline (export-unreal.md
// 3.4, 4.6, 5.9), against the formulas of the contract computed here in float64 and against what they must
// keep: a constant, a ramp, a plane, and the same output however the rows are cut into bands.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { colorToSrgb8, countNonFinite, createNormalRows, createTexelGridResampler, normalsToRgb8, quantiseUnit } from '../../../src/export/convert.ts';
import { SRGB8 } from '../../../src/export/unreal.ts';
import { assertSame, largestDifference } from './_support.ts';

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A field of n x n texels with `stride` floats each, from a function of the column, the row and the channel. */
function field(n: number, stride: number, fn: (x: number, y: number, c: number) => number): Float32Array {
  const out = new Float32Array(n * n * stride);
  for (let y = 0, i = 0; y < n; y++) for (let x = 0; x < n; x++) for (let c = 0; c < stride; c++) out[i++] = fn(x, y, c);
  return out;
}

/** Pushes the rows of `src` in groups of `rowsPerPush` and returns everything the resampler gave. */
function resample(src: Float32Array, o: { srcSize: number; dstSize: number; channels: 1 | 3; stride?: number }, rowsPerPush: number | readonly number[]): Float32Array {
  const resampler = createTexelGridResampler(o);
  const perRow = o.srcSize * (o.stride ?? o.channels);
  const parts: Float32Array[] = [];
  const groups = typeof rowsPerPush === 'number' ? [rowsPerPush] : rowsPerPush;
  for (let row = 0, g = 0; row < o.srcSize; g++) {
    const rows = Math.min(groups[g % groups.length]!, o.srcSize - row);
    parts.push(resampler.push(src.subarray(row * perRow, (row + rows) * perRow)));
    row += rows;
  }
  parts.push(resampler.finish());
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  assert.equal(out.length, o.dstSize * o.dstSize * o.channels, 'every output row was returned once');
  return out;
}

/** The formula of 5.9, literally: the weighted mean over the tent, as a double sum in float64. */
function reference(src: Float32Array, n: number, s: number, channels: number, stride: number): Float64Array {
  const rho = Math.max(1, (n - 1) / s);
  const centre = (i: number): number => (i + 0.5) * (n - 1) / s;
  const weight = (k: number, c: number): number => Math.max(0, 1 - Math.abs(k - c) / rho);
  const out = new Float64Array(s * s * channels);
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0, wl = 0, wk = 0;
        for (let l = 0; l < n; l++) wl += weight(l, centre(j));
        for (let k = 0; k < n; k++) wk += weight(k, centre(i));
        for (let l = 0; l < n; l++) {
          const w1 = weight(l, centre(j));
          if (w1 === 0) continue;
          for (let k = 0; k < n; k++) sum += w1 * weight(k, centre(i)) * src[(l * n + k) * stride + c]!;
        }
        out[(j * s + i) * channels + c] = sum / (wl * wk);
      }
    }
  }
  return out;
}

test('the resampler is the weighted mean of 5.9, when it grows a field and when it shrinks one', () => {
  const next = random(5);
  // Vertices and texture sides: the default size of a texture and beyond, whole reductions, and ratios that are none.
  for (const [n, s, channels, stride] of [[9, 8, 1, 1], [9, 32, 1, 1], [17, 16, 3, 3], [17, 16, 3, 4], [33, 8, 1, 1], [33, 4, 3, 4], [41, 7, 1, 1], [29, 13, 3, 3], [2, 5, 1, 1], [65, 1, 1, 1]] as const) {
    const src = field(n, stride, () => next() * 2 - 0.5);
    const out = resample(src, { srcSize: n, dstSize: s, channels, stride }, n);
    // The output is float32; the reference is float64.
    const worst = largestDifference(out, reference(src, n, s, channels, stride));
    assert.ok(worst <= 2e-7, `${n} vertices onto ${s} texels, ${channels} of ${stride} channels: the largest difference is ${worst}`);
  }
});

test('with at least resolution − 1 texels the resampler is bilinear interpolation between the four vertices around a texel centre', () => {
  const next = random(9);
  for (const [n, s] of [[9, 8], [9, 16], [33, 64], [17, 21]] as const) {
    const src = field(n, 1, () => next());
    const out = resample(src, { srcSize: n, dstSize: s, channels: 1 }, 3);
    const expected = new Float64Array(s * s);
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        const cx = (i + 0.5) * (n - 1) / s, cy = (j + 0.5) * (n - 1) / s;
        const x0 = Math.min(Math.floor(cx), n - 2), y0 = Math.min(Math.floor(cy), n - 2);
        const fx = cx - x0, fy = cy - y0;
        const at = (x: number, y: number): number => src[y * n + x]!;
        expected[j * s + i] = (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1));
      }
    }
    const worst = largestDifference(out, expected);
    assert.ok(worst <= 1e-7, `${n} vertices onto ${s} texels: the largest difference from bilinear is ${worst}`);
  }
  // With exactly resolution − 1 texels a texel is the mean of the four vertices of its cell.
  const cells = resample(field(5, 1, (x, y) => (x === 2 && y === 1 ? 4 : 0)), { srcSize: 5, dstSize: 4, channels: 1 }, 5);
  assertSame(cells, [0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'a single vertex of 4 gives 1 to each cell that touches it');
});

test('a constant field gives that constant, bit for bit, and the output does not depend on how the rows are pushed', () => {
  for (const [n, s, channels, stride] of [[9, 8, 1, 1], [129, 32, 3, 4], [101, 7, 3, 3], [33, 64, 1, 1], [57, 100, 3, 4]] as const) {
    const values = [Math.fround(0.3), Math.fround(1e-3), Math.fround(123456.7), 9];
    const out = resample(field(n, stride, (_x, _y, c) => values[c]!), { srcSize: n, dstSize: s, channels, stride }, 5);
    let wrong = 0;
    for (let i = 0; i < out.length; i++) if (out[i] !== values[i % channels]) wrong++;
    assert.equal(wrong, 0, `${n} onto ${s}, ${channels} channels: texels that are not the constant`);
  }

  const next = random(13);
  for (const [n, s, channels, stride] of [[65, 64, 1, 1], [65, 16, 3, 4], [50, 9, 3, 3], [20, 64, 1, 1]] as const) {
    const src = field(n, stride, () => next());
    const whole = resample(src, { srcSize: n, dstSize: s, channels, stride }, n);
    for (const groups of [1, 2, 7, [3, 1, 16, 5], [n - 1, 1]] as const) {
      assertSame(resample(src, { srcSize: n, dstSize: s, channels, stride }, groups), whole, `${n} onto ${s}: rows pushed ${JSON.stringify(groups)} at a time`);
    }
  }
});

test('a ramp stays a ramp: a texel holds the ramp at its centre', () => {
  // Growing, and shrinking by a whole number: exact everywhere inside, because the tent lies evenly about its centre.
  for (const [n, s] of [[33, 32], [33, 128], [17, 40], [65, 16], [61, 20], [97, 8]] as const) {
    const out = resample(field(n, 1, (x, y) => 3 * x - 2 * y), { srcSize: n, dstSize: s, channels: 1 }, 4);
    const rho = Math.max(1, (n - 1) / s);
    let worst = 0;
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        const cx = (i + 0.5) * (n - 1) / s, cy = (j + 0.5) * (n - 1) / s;
        // Where the tent would reach past the border it is cut, and the mean moves inward: not compared.
        if (Math.min(cx, cy) - rho < 0 || Math.max(cx, cy) + rho > n - 1) continue;
        worst = Math.max(worst, Math.abs(out[j * s + i]! - (3 * cx - 2 * cy)));
      }
    }
    assert.ok(worst <= 2e-5, `${n} onto ${s}: the largest difference from the ramp is ${worst}`);
  }
  // At a border a growing texture needs nothing beyond the field: the outermost texel centres lie inside the outermost cells.
  const grown = resample(field(9, 1, (x) => x), { srcSize: 9, dstSize: 8, channels: 1 }, 9);
  assertSame(grown.subarray(0, 8), [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5], 'the first row');
  // A reduction that is no whole number: the weights at the vertices are no longer even about the centre. The
  // ramp is kept to a small part of a source cell, and it stays monotonic.
  const odd = resample(field(101, 1, (x) => x), { srcSize: 101, dstSize: 7, channels: 1 }, 101);
  let worst = 0;
  for (let i = 1; i < 6; i++) worst = Math.max(worst, Math.abs(odd[i]! - (i + 0.5) * 100 / 7));
  assert.ok(worst < 0.01, `101 onto 7: inside, the ramp is off by ${worst} of a source cell`);
  for (let i = 1; i < 7; i++) assert.ok(odd[i]! > odd[i - 1]!, 'the ramp rises from texel to texel');
});

test('the resampler refuses rows it cannot take', () => {
  const resampler = createTexelGridResampler({ srcSize: 5, dstSize: 4, channels: 3, stride: 4 });
  assert.throws(() => resampler.push(new Float32Array(19)), RangeError, 'not whole rows of 5 x 4');
  assert.throws(() => resampler.finish(), RangeError, 'finish before the last row');
  resampler.push(new Float32Array(5 * 5 * 4));
  assert.throws(() => resampler.push(new Float32Array(20)), RangeError, 'a sixth row');
  assert.equal(resampler.finish().length, 0);
  assert.throws(() => createTexelGridResampler({ srcSize: 1, dstSize: 4, channels: 1 }), RangeError);
  assert.throws(() => createTexelGridResampler({ srcSize: 5, dstSize: 0, channels: 1 }), RangeError);
  assert.throws(() => createTexelGridResampler({ srcSize: 5, dstSize: 4, channels: 2 as never }), RangeError);
  assert.throws(() => createTexelGridResampler({ srcSize: 5, dstSize: 4, channels: 3, stride: 2 }), RangeError);
});

// ---- vertex normals ----------------------------------------------------------------------------------------------

/** normalAt of engine.md 3.8, for every vertex of an n x n field, in float64. */
function normalsOf(h: Float32Array, n: number, heightRange: number, terrainSize: number): Float64Array {
  const at = (x: number, y: number): number => h[y * n + x]!;
  const oneSided = (a: number, b: number, c: number): number => 0.5 * (4 * b - 3 * a - c);
  const out = new Float64Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x === 0 ? oneSided(at(0, y), at(1, y), at(2, y)) : x === n - 1 ? -oneSided(at(x, y), at(x - 1, y), at(x - 2, y)) : 0.5 * (at(x + 1, y) - at(x - 1, y));
      const dy = y === 0 ? oneSided(at(x, 0), at(x, 1), at(x, 2)) : y === n - 1 ? -oneSided(at(x, y), at(x, y - 1), at(x, y - 2)) : 0.5 * (at(x, y + 1) - at(x, y - 1));
      const sx = dx * heightRange * (n - 1) / terrainSize, sy = dy * heightRange * (n - 1) / terrainSize;
      const length = Math.hypot(sx, sy, 1);
      out.set([-sx / length, -sy / length, 1 / length], (y * n + x) * 3);
    }
  }
  return out;
}

function normalRows(h: Float32Array, n: number, rowsPerPush: number | readonly number[], heightRange = 1024, terrainSize = 4096): Float32Array {
  const rows = createNormalRows({ size: n, heightRange, terrainSize });
  const groups = typeof rowsPerPush === 'number' ? [rowsPerPush] : rowsPerPush;
  const out = new Float32Array(n * n * 3);
  let at = 0;
  for (let row = 0, g = 0; row < n; g++) {
    const count = Math.min(groups[g % groups.length]!, n - row);
    const part = rows.push(h.subarray(row * n, (row + count) * n));
    out.set(part, at);
    at += part.length;
    row += count;
  }
  rows.finish();
  assert.equal(at, out.length, 'every row was returned once');
  return out;
}

test('the vertex normals are normalAt of the engine at every vertex, the border included, whatever the bands', () => {
  const next = random(17);
  const n = 37;
  const h = field(n, 1, () => next() * 0.01);
  const whole = normalRows(h, n, n);
  const worst = largestDifference(whole, normalsOf(h, n, 1024, 4096));
  assert.ok(worst <= 1e-6, `the largest difference from normalAt is ${worst}`);
  for (const groups of [1, 2, 3, 5, [1, 2], [2, 1, 1, 30], [36, 1], [35, 2], [1, 36]] as const) {
    assertSame(normalRows(h, n, groups), whole, `rows pushed ${JSON.stringify(groups)} at a time`);
  }
});

test('the normals come from physical slopes: a plane has one normal up to the border, and a paraboloid its own at every vertex', () => {
  const n = 33, heightRange = 500, terrainSize = 2000;
  // h = 0.3 u + 0.1 v, in heights over the unit box: 0.3 * 500 m over 2000 m is a slope of 0.075.
  const plane = normalRows(field(n, 1, (x, y) => 0.3 * x / (n - 1) + 0.1 * y / (n - 1)), n, 7, heightRange, terrainSize);
  const length = Math.hypot(0.075, 0.025, 1);
  let worst = 0;
  for (let i = 0; i < plane.length; i += 3) {
    worst = Math.max(worst, Math.abs(plane[i]! + 0.075 / length), Math.abs(plane[i + 1]! + 0.025 / length), Math.abs(plane[i + 2]! - 1 / length));
  }
  assert.ok(worst <= 1e-6, `a plane: the largest difference is ${worst}`);

  // h = u² + u v: the slope is (2u + v, u) * heightRange / terrainSize, also on the border, where the difference is one-sided.
  const bowl = normalRows(field(n, 1, (x, y) => (x / (n - 1)) ** 2 + (x / (n - 1)) * (y / (n - 1))), n, 4, heightRange, terrainSize);
  worst = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / (n - 1), v = y / (n - 1);
      const sx = (2 * u + v) * heightRange / terrainSize, sy = u * heightRange / terrainSize;
      const l = Math.hypot(sx, sy, 1), i = (y * n + x) * 3;
      worst = Math.max(worst, Math.abs(bowl[i]! + sx / l), Math.abs(bowl[i + 1]! + sy / l), Math.abs(bowl[i + 2]! - 1 / l));
    }
  }
  assert.ok(worst <= 2e-5, `a paraboloid: the largest difference is ${worst}`);

  const rows = createNormalRows({ size: 5, heightRange: 1, terrainSize: 1 });
  assert.throws(() => rows.push(new Float32Array(7)), RangeError);
  assert.throws(() => rows.finish(), RangeError, 'finish before the last row');
  assert.throws(() => createNormalRows({ size: 2, heightRange: 1, terrainSize: 1 }), RangeError);
});

// ---- samples -----------------------------------------------------------------------------------------------------

test('quantiseUnit: floor(saturate(t) * max + 0.5), with the range of the item, and non-finite samples counted', () => {
  const src = Float32Array.of(0, 1, 0.5, -3, 7, 0.25, 0.6 / 255, 1.4 / 255, NaN, Infinity, -Infinity);
  const bytes = new Uint8Array(src.length);
  const result = quantiseUnit(src, bytes, { max: 255, lo: 0, hi: 1 });
  assert.deepEqual([...bytes], [0, 255, 128, 0, 255, 64, 1, 1, 0, 0, 0]);
  assert.deepEqual(result, { nonFinite: 3, sum: 255 + 128 + 255 + 64 + 1 + 1 });
  const codes = new Uint16Array(4);
  quantiseUnit(Float32Array.of(0, 1, 0.5, 0.25), codes, { max: 65535, lo: 0, hi: 1 });
  assert.deepEqual([...codes], [0, 65535, 32768, 16384]);

  // A measured range: its two ends are the lowest and the highest code, and a range without width is all zero.
  quantiseUnit(Float32Array.of(-2, 2, 0, 6), codes, { max: 65535, lo: -2, hi: 2 });
  assert.deepEqual([...codes], [0, 65535, 32768, 65535]);
  quantiseUnit(Float32Array.of(3, 3, 3, 3), codes, { max: 65535, lo: 3, hi: 3 });
  assert.deepEqual([...codes], [0, 0, 0, 0]);
  assert.equal(countNonFinite(src), 3);
  assert.throws(() => quantiseUnit(src, new Uint8Array(3), { max: 255, lo: 0, hi: 1 }), RangeError);
});

test('colorToSrgb8 and normalsToRgb8 encode as 5.9 says', () => {
  const rgb = Float32Array.of(0, 1, 0.5, -1, 2, 0.2159, NaN, 0.001, 0.9999);
  const bytes = new Uint8Array(rgb.length);
  assert.equal(colorToSrgb8(rgb, bytes), 1);
  assert.deepEqual([...bytes], [0, 255, 188, 0, 255, 128, 0, SRGB8[Math.floor(Math.fround(0.001) * 65535 + 0.5)], 255]);

  // (0, 0, 1) is (128, 128, 255); a vector is normalised first; one shorter than 1e-6 is taken as straight up.
  const normals = Float32Array.of(0, 0, 1, 1, 0, 0, 0, -3, 0, 0.28, 0, 0.96, 1e-7, 0, 0, NaN, 0, 1);
  const encoded = new Uint8Array(normals.length);
  assert.equal(normalsToRgb8(normals, encoded), 1);
  assert.deepEqual([...encoded], [128, 128, 255, 255, 128, 128, 128, 0, 128, 163, 128, 250, 128, 128, 255, 128, 128, 255]);
});
