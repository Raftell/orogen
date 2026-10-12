// The conversions behind ctx.read and ctx.write for formats that are not float32 (runtime.md 5.7 rule 3).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { floatToHalf, halfToFloat, packTexels, TEXEL_ENCODING, unpackTexels } from '../../../src/core/gpu/texels.ts';

test('every half converts to a float and back to the same bits', () => {
  for (let h = 0; h < 65536; h++) {
    const exponent = (h >>> 10) & 0x1f, mantissa = h & 0x3ff;
    const value = halfToFloat(h);
    if (exponent === 0x1f && mantissa !== 0) {
      assert.ok(Number.isNaN(value));
      continue;
    }
    assert.equal(Math.fround(value), value, 'a float32 holds every half exactly');
    assert.equal(floatToHalf(value), h, `half 0x${h.toString(16)}`);
  }
});

test('known halves', () => {
  const known: readonly (readonly [number, number])[] = [
    [0, 0x0000], [1, 0x3c00], [-2, 0xc000], [0.5, 0x3800], [65504, 0x7bff], [2 ** -14, 0x0400], [2 ** -24, 0x0001],
    [Infinity, 0x7c00], [-Infinity, 0xfc00], [0.333251953125, 0x3555],
  ];
  for (const [value, half] of known) {
    assert.equal(floatToHalf(value), half, String(value));
    assert.equal(halfToFloat(half), value, `0x${half.toString(16)}`);
  }
  assert.equal(floatToHalf(-0), 0x8000);
  assert.ok(Number.isNaN(halfToFloat(floatToHalf(Number.NaN))));
});

test('floatToHalf rounds to the nearest half, ties to even', () => {
  const ulp = 2 ** -10;                              // spacing of halves in [1, 2)
  assert.equal(floatToHalf(1 + ulp * 0.25), 0x3c00);
  assert.equal(floatToHalf(1 + ulp * 0.75), 0x3c01);
  assert.equal(floatToHalf(1 + ulp * 0.5), 0x3c00, 'tie: 0x3c00 is even');
  assert.equal(floatToHalf(1 + ulp * 1.5), 0x3c02, 'tie: 0x3c02 is even');
  assert.equal(floatToHalf(65520), 0x7c00, 'the tie above the largest half rounds to infinity');
  assert.equal(floatToHalf(65519), 0x7bff);
  assert.equal(floatToHalf(1e30), 0x7c00);
  assert.equal(floatToHalf(2 ** -25), 0x0000, 'tie between 0 and the smallest subnormal: 0 is even');
  assert.equal(floatToHalf(2 ** -25 * 1.5), 0x0001);
  assert.equal(floatToHalf(2 ** -26), 0x0000);
  assert.equal(floatToHalf(2 ** -24 * 1.5), 0x0002, 'tie between subnormals 1 and 2');
  for (let i = 0; i < 20000; i++) {
    const value = Math.fround((Math.sin(i * 12.9898) * 43758.5453) % 70000);
    const half = floatToHalf(value);
    const got = halfToFloat(half);
    if (!Number.isFinite(got)) continue;
    for (const neighbour of [halfToFloat(half - 1), halfToFloat(half + 1)]) {
      if (Number.isFinite(neighbour) && Math.sign(neighbour) === Math.sign(got)) {
        assert.ok(Math.abs(got - value) <= Math.abs(neighbour - value), `${value} is nearer to a neighbour of ${got}`);
      }
    }
  }
});

test('packTexels and unpackTexels for each encoding', () => {
  assert.deepEqual(TEXEL_ENCODING, {
    r32float: 'f32', rg32float: 'f32', rgba32float: 'f32', r16float: 'f16', rg16float: 'f16', rgba16float: 'f16', r8unorm: 'unorm8',
  });
  const data = new Float32Array([0, 0.25, 0.5, 1, -3, 1025]);

  const f32 = packTexels('f32', data);
  assert.equal(f32, data, 'float32 data is written as it is');

  const f16 = packTexels('f16', data);
  assert.ok(f16 instanceof Uint16Array);
  assert.deepEqual([...f16], [...data].map(floatToHalf));
  const back = new Float32Array(8).fill(-1);
  unpackTexels('f16', f16.buffer as ArrayBuffer, 0, 6, back, 1);
  assert.deepEqual([...back], [-1, 0, 0.25, 0.5, 1, -3, 1025, -1]);

  const unorm = packTexels('unorm8', new Float32Array([0, 1, 0.5, -2, 7, 100 / 255, 0.4999 / 255, 0.5001 / 255]));
  assert.ok(unorm instanceof Uint8Array);
  assert.deepEqual([...unorm], [0, 255, 128, 0, 255, 100, 0, 1]);
  const levels = new Float32Array(3);
  unpackTexels('unorm8', new Uint8Array([9, 0, 255, 51, 9]).buffer, 1, 3, levels, 0);
  assert.deepEqual([...levels], [0, 1, Math.fround(51 / 255)]);

  const floats = new Float32Array([9, 1.5, -2.5, 9]);
  const plain = new Float32Array(2);
  unpackTexels('f32', floats.buffer, 4, 2, plain, 0);
  assert.deepEqual([...plain], [1.5, -2.5]);
});
