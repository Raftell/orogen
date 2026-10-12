// The strips of a readback and the checks of a LUT (runtime.md 5.7 rule 1, engine.md 3.12, 4.9): the arithmetic
// that needs no device. tests/engine/gpu/readback.test.ts reads real textures.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLutBuffer, lutBytes } from '../../../src/core/gpu/lut.ts';
import { BYTES_PER_TEXEL } from '../../../src/core/gpu/pool.ts';
import { stripLayout } from '../../../src/core/gpu/readback.ts';

const MAX = 67_108_864;

test('rows = floor(67 108 864 / align256(width x bytesPerTexel))', () => {
  // The example of the contract: an 8129 x 8129 field is read in 4 strips of 2048 rows.
  assert.deepEqual(stripLayout(8129, 4), { bytesPerRow: 32768, rows: 2048 });
  assert.equal(Math.ceil(8129 / stripLayout(8129, 4).rows), 4);
  assert.deepEqual(stripLayout(8129, 16), { bytesPerRow: 130304, rows: 515 });
  assert.deepEqual(stripLayout(8192, 16), { bytesPerRow: 131072, rows: 512 });
  assert.deepEqual(stripLayout(8129, 8), { bytesPerRow: 65280, rows: 1028 });
  assert.deepEqual(stripLayout(13, 4), { bytesPerRow: 256, rows: 262144 });
  assert.deepEqual(stripLayout(64, 4), { bytesPerRow: 256, rows: 262144 }, 'a row that is a multiple of 256 bytes is not padded');
  assert.deepEqual(stripLayout(65, 4), { bytesPerRow: 512, rows: 131072 });
  assert.deepEqual(stripLayout(1, 1), { bytesPerRow: 256, rows: 262144 });
});

test('no strip exceeds 64 MiB, and none is less than one row', () => {
  for (const bytesPerTexel of new Set(Object.values(BYTES_PER_TEXEL))) {
    for (const width of [1, 2, 63, 64, 65, 257, 1009, 2017, 4033, 8129, 8192]) {
      const { bytesPerRow, rows } = stripLayout(width, bytesPerTexel);
      assert.equal(bytesPerRow % 256, 0);
      assert.ok(bytesPerRow >= width * bytesPerTexel && bytesPerRow < width * bytesPerTexel + 256);
      assert.ok(rows >= 1 && rows * bytesPerRow <= MAX && (rows + 1) * bytesPerRow > MAX, `${width} texels of ${bytesPerTexel} bytes`);
    }
  }
  assert.deepEqual(stripLayout(40, 4, 1024), { bytesPerRow: 256, rows: 4 });
  assert.deepEqual(stripLayout(100, 16, 1024), { bytesPerRow: 1792, rows: 1 }, 'a row larger than the strip size is still read');
});

test('a LUT has 1 to 1 048 576 elements; a vec4f table has four floats per element', () => {
  const device = null as unknown as GPUDevice;                     // every refusal comes before the device is touched
  assert.throws(() => createLutBuffer(device, new Float32Array(0), 'f32'), RangeError);
  assert.throws(() => createLutBuffer(device, new Float32Array(0), 'vec4f'), RangeError);
  assert.throws(() => createLutBuffer(device, new Float32Array(1_048_577), 'f32'), RangeError);
  assert.throws(() => createLutBuffer(device, new Float32Array(4 * 1_048_577), 'vec4f'), RangeError);
  for (const length of [1, 2, 3, 5, 1023]) assert.throws(() => createLutBuffer(device, new Float32Array(length), 'vec4f'), RangeError, `${length} floats`);
  assert.throws(() => createLutBuffer(device, new Float32Array(4), 'vec3f' as never), TypeError);
  assert.equal(lutBytes('f32', 1024), 4096);
  assert.equal(lutBytes('vec4f', 256), 4096);
  assert.equal(lutBytes('vec4f', 1_048_576), 16_777_216, 'the largest table is 16 MiB, below the default maxStorageBufferBindingSize');
});
