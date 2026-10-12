// The image decoders of src/core/io/ (export-unreal.md 4.7): round trips through files generated here, the
// layout of DecodedImage, and every rejection the contract names.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from 'fast-png';
import { writeArrayBuffer } from 'geotiff';
import { decodeExr } from '../../src/core/io/exr.ts';
import { checkImageSize, decodeImage } from '../../src/core/io/image.ts';
import type { DecodedImage } from '../../src/core/io/image.ts';
import { decodePng } from '../../src/core/io/png.ts';
import { decodeRaw } from '../../src/core/io/raw.ts';
import { decodeTiff } from '../../src/core/io/tiff.ts';
import { buildExr, buildPng, buildTiff, exportExr, exportTiff } from './image-builders.ts';

const env = { progress(): void {} };

/** `count` distinct sample values up to `max`, among them 0 and `max`; no row and no column repeats, so a flipped image differs. */
function ramp(count: number, max: number): number[] {
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? max : Math.floor((i * max) / count) + (i > 0 ? 1 : 0)));
}

function expectImage(image: DecodedImage, width: number, height: number, channels: number, expected: readonly number[]): void {
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  assert.equal(image.channels, channels);
  assert.ok(image.data instanceof Float32Array);
  assert.deepEqual(Array.from(image.data), expected.map(Math.fround));
}

/** Every k-th value of a list, starting at `first`. */
const pick = (list: readonly number[], step: number, first = 0): number[] => list.filter((_, i) => i % step === first);

// ---- PNG ---------------------------------------------------------------------------------------------------

for (const depth of [8, 16] as const) {
  const max = depth === 16 ? 65535 : 255;
  const array = (values: number[]): Uint8Array | Uint16Array => (depth === 16 ? Uint16Array.from(values) : Uint8Array.from(values));

  test(`PNG: ${depth}-bit grey decodes to one channel of sample / ${max}, top row first`, () => {
    const values = ramp(5 * 3, max);
    const image = decodePng(encode({ width: 5, height: 3, data: array(values), depth, channels: 1 }));
    expectImage(image, 5, 3, 1, values.map((v) => v / max));
    assert.equal(image.data[0], 0);
    assert.equal(image.data[14], 1);
  });

  test(`PNG: ${depth}-bit RGB decodes to three channels`, () => {
    const values = ramp(4 * 3 * 3, max);
    expectImage(decodePng(encode({ width: 4, height: 3, data: array(values), depth, channels: 3 })), 4, 3, 3, values.map((v) => v / max));
  });

  test(`PNG: ${depth}-bit grey with alpha decodes to one channel, the alpha dropped`, () => {
    const values = ramp(3 * 2 * 2, max);
    expectImage(decodePng(encode({ width: 3, height: 2, data: array(values), depth, channels: 2 })), 3, 2, 1, pick(values, 2).map((v) => v / max));
  });

  test(`PNG: ${depth}-bit RGBA decodes to four channels`, () => {
    const values = ramp(3 * 2 * 4, max);
    expectImage(decodePng(encode({ width: 3, height: 2, data: array(values), depth, channels: 4 })), 3, 2, 4, values.map((v) => v / max));
  });
}

test('PNG: an interlaced file decodes like a plain one', () => {
  const values = ramp(9 * 7, 65535);
  const bytes = encode({ width: 9, height: 7, data: Uint16Array.from(values), depth: 16, channels: 1 }, { interlace: 'Adam7' });
  expectImage(decodePng(bytes), 9, 7, 1, values.map((v) => v / 65535));
});

test('PNG: a palette without transparency decodes to three channels', () => {
  const palette: [number, number, number][] = [[0, 0, 0], [255, 0, 10], [20, 200, 30], [255, 255, 255]];
  // 5 x 2 at 2 bits per pixel: each row is padded to two bytes.
  const indices = [0, 1, 2, 3, 1, 3, 2, 1, 0, 2];
  const rows = Uint8Array.of(0b00011011, 0b01000000, 0b11100100, 0b10000000);
  const image = decodePng(buildPng({ width: 5, height: 2, depth: 2, colorType: 3, rows, palette }));
  expectImage(image, 5, 2, 3, indices.flatMap((i) => palette[i]!.map((v) => v / 255)));
});

test('PNG: a palette with transparency decodes to four channels, entries without alpha opaque', () => {
  const palette: [number, number, number][] = [[10, 20, 30], [40, 50, 60], [70, 80, 90]];
  const alpha = [0, 128];
  const indices = [2, 0, 1, 1, 2, 0];
  const image = decodePng(buildPng({ width: 3, height: 2, depth: 8, colorType: 3, rows: Uint8Array.from(indices), palette, alpha }));
  expectImage(image, 3, 2, 4, indices.flatMap((i) => [...palette[i]!, alpha[i] ?? 255].map((v) => v / 255)));
});

test('PNG: files outside the accepted set are rejected with a sentence that names the cause', () => {
  const grey = encode({ width: 4, height: 4, data: Uint8Array.from(ramp(16, 255)), depth: 8, channels: 1 });
  assert.throws(() => decodePng(grey.subarray(0, grey.length - 20)), { message: 'PNG file is truncated' });
  assert.throws(() => decodePng(grey.subarray(0, 30)), { message: 'PNG file is truncated' });

  const fourBit = buildPng({ width: 4, height: 1, depth: 4, colorType: 0, rows: Uint8Array.of(0x01, 0x23) });
  assert.throws(() => decodePng(fourBit), { message: 'PNG has 4 bits per channel; 8 and 16 are read' });

  const huge = buildPng({ width: 10812, height: 10812, depth: 8, colorType: 0, rows: Uint8Array.of(0) });
  assert.throws(() => decodePng(huge), { message: 'image is 10812 x 10812; the largest side is 8192' });

  const empty = buildPng({ width: 2, height: 2, depth: 8, colorType: 0, rows: new Uint8Array(0) });
  assert.throws(() => decodePng(empty), { message: 'PNG file holds no image data' });

  // A valid chunk list around a zlib stream whose first byte is not a zlib header.
  const damaged = grey.slice();
  assert.equal(String.fromCharCode(...damaged.subarray(37, 41)), 'IDAT');
  damaged[41] = 0;
  assert.throws(() => decodePng(damaged), /^Error: PNG file cannot be decoded: /);

  const badIndex = buildPng({ width: 2, height: 1, depth: 8, colorType: 3, rows: Uint8Array.of(0, 5), palette: [[1, 2, 3]] });
  assert.throws(() => decodePng(badIndex), { message: 'PNG file uses palette entry 5, and the palette has 1' });
});

// ---- TIFF --------------------------------------------------------------------------------------------------

test('TIFF: a 16-bit file of geotiff\'s writer decodes to sample / 65535', async () => {
  const values = ramp(6 * 4, 65535);
  const bytes = new Uint8Array(writeArrayBuffer(Uint16Array.from(values), { width: 6, height: 4 }));
  assert.deepEqual([...bytes.subarray(0, 4)], [0x4d, 0x4d, 0x00, 0x2a]);       // the writer is big-endian
  expectImage(await decodeTiff(bytes), 6, 4, 1, values.map((v) => v / 65535));
});

test('TIFF: a float file of geotiff\'s writer decodes unchanged, non-finite samples as 0', async () => {
  const values = [-2.5, 0, 0.1, 1, 3e20, NaN, Infinity, -Infinity, 1e-30, 0.333, 7, 8];
  const bytes = new Uint8Array(writeArrayBuffer(Float32Array.from(values), { width: 4, height: 3 }));
  expectImage(await decodeTiff(bytes), 4, 3, 1, values.map((v) => (Number.isFinite(v) ? v : 0)));
});

test('TIFF: the layout of the 16-bit export encoder decodes, in one strip and in several', async () => {
  for (const [width, height] of [[7, 5], [3, 150]] as const) {
    const values = ramp(width * height, 65535);
    const bytes = exportTiff(width, height, 'u16', values);
    const strips = Math.ceil(height / 64);
    assert.equal(bytes.length, (strips === 1 ? 146 : 146 + 8 * strips) + 2 * width * height);
    expectImage(await decodeTiff(bytes), width, height, 1, values.map((v) => v / 65535));
  }
});

test('TIFF: the layout of the float export encoder decodes unchanged', async () => {
  const values = ramp(3 * 130, 1000).map((v) => v / 8 - 60);
  const bytes = exportTiff(3, 130, 'f32', values);
  assert.equal(bytes.length, 146 + 8 * 3 + 4 * 3 * 130);
  expectImage(await decodeTiff(bytes), 3, 130, 1, values);
});

test('TIFF: unsigned integers of 8, 16 and 32 bits decode to sample / (2^k - 1)', async () => {
  for (const bits of [8, 16, 32]) {
    const max = 2 ** bits - 1;
    const values = ramp(5 * 3, max);
    const image = await decodeTiff(buildTiff({ width: 5, height: 3, samples: 1, bits, format: 1, values }));
    expectImage(image, 5, 3, 1, values.map((v) => v / max));
    assert.equal(image.data[14], 1);
  }
});

test('TIFF: signed integers decode to (sample + 2^(k-1)) / (2^k - 1)', async () => {
  for (const bits of [8, 16, 32]) {
    const max = 2 ** bits - 1;
    const half = 2 ** (bits - 1);
    const values = ramp(5 * 3, max).map((v) => v - half);
    const image = await decodeTiff(buildTiff({ width: 5, height: 3, samples: 1, bits, format: 2, values }));
    expectImage(image, 5, 3, 1, values.map((v) => (v + half) / max));
    assert.equal(image.data[0], 0);
    assert.equal(image.data[14], 1);
  }
});

test('TIFF: three and four samples per pixel decode to three and four channels, interleaved or in planes', async () => {
  for (const samples of [3, 4]) {
    for (const planar of [1, 2] as const) {
      const values = ramp(4 * 3 * samples, 255);
      const image = await decodeTiff(buildTiff({ width: 4, height: 3, samples, bits: 8, format: 1, values, planar }));
      expectImage(image, 4, 3, samples, values.map((v) => v / 255));
    }
  }
});

test('TIFF: big-endian and little-endian files decode alike, also with a strip table that lies before the directory', async () => {
  const values = ramp(5 * 4 * 3, 65535);
  for (const littleEndian of [true, false]) {
    const bytes = buildTiff({ width: 5, height: 4, samples: 3, bits: 16, format: 1, values, littleEndian, rowsPerStrip: 3 });
    expectImage(await decodeTiff(bytes), 5, 4, 3, values.map((v) => v / 65535));
  }
});

test('TIFF: strips and tiles decode, uncompressed and with PackBits, LZW and Deflate', async () => {
  const width = 21;
  const height = 19;
  const values = ramp(width * height, 65535);
  const expected = values.map((v) => v / 65535);
  for (const compression of [1, 32773, 5, 8, 32946]) {
    for (const layout of [{ rowsPerStrip: 8 }, { tile: 16 }]) {
      const bytes = buildTiff({ width, height, samples: 1, bits: 16, format: 1, values, compression, ...layout });
      expectImage(await decodeTiff(bytes), width, height, 1, expected);
    }
  }
  const floats = values.map((v) => v / 16 - 1000);
  const deflated = buildTiff({ width, height, samples: 1, bits: 32, format: 3, values: floats, compression: 8, tile: 16 });
  expectImage(await decodeTiff(deflated), width, height, 1, floats);
});

test('TIFF: files outside the accepted set are rejected with a sentence that names the cause', async () => {
  const base = { width: 4, height: 4, samples: 1, bits: 16, format: 1, values: ramp(16, 65535) } as const;
  const rejects = (bytes: Uint8Array, message: string | RegExp): Promise<void> =>
    assert.rejects(decodeTiff(bytes), typeof message === 'string' ? { message } : message);

  await rejects(buildTiff({ ...base, samples: 2, values: ramp(32, 65535) }), 'TIFF has 2 samples per pixel; 1, 3 and 4 are read');
  await rejects(buildTiff({ ...base, bits: 16, format: 3 }), 'TIFF has 16-bit float samples; 32-bit float is read');
  await rejects(buildTiff({ ...base, compression: 7 }), 'TIFF compression 7 is not supported; uncompressed, PackBits, LZW and Deflate are read');
  await rejects(buildTiff({ ...base, bits: 8, photometric: 3 }), 'TIFF photometric interpretation 3 is not supported; grey and RGB are read');
  await rejects(buildTiff({ ...base, declaredSize: [10812, 10812] }), 'image is 10812 x 10812; the largest side is 8192');

  // The export layout has its directory first: cutting the end cuts the last strip, not the directory.
  const whole = exportTiff(4, 100, 'u16', ramp(400, 65535));
  await rejects(whole.subarray(0, whole.length - 100), 'TIFF file is truncated');
  await rejects(whole.subarray(0, 60), 'TIFF file is truncated');
  // The general writer has its directory last: cutting the end removes it.
  const tail = buildTiff(base);
  await rejects(tail.subarray(0, tail.length - 20), 'TIFF file is truncated');
});

// ---- OpenEXR -----------------------------------------------------------------------------------------------

test('OpenEXR: the layout of the export encoder decodes unchanged, top row first, non-finite samples as 0', () => {
  const width = 5;
  const height = 4;
  const values = [0, -1.5, 2.25, 1e-20, 3e20, NaN, Infinity, -Infinity, ...ramp(12, 4000).map((v) => v / 7)];
  const bytes = exportExr(width, height, values);
  assert.equal(bytes.length, 277 + height * (16 + 4 * width));
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++) {
    assert.equal(Number(view.getBigUint64(277 + 8 * y, true)), 277 + 8 * height + y * (8 + 4 * width));
  }
  expectImage(decodeExr(bytes), width, height, 1, values.map((v) => (Number.isFinite(v) ? v : 0)));
});

test('OpenEXR: R, G and B decode to three channels; with A to four', () => {
  const width = 6;
  const height = 20;                                        // ZIP packs 16 lines per chunk: two chunks
  const n = width * height;
  // Halves hold these exactly: multiples of 1/2 below 512.
  const plane = (offset: number): number[] => Array.from({ length: n }, (_, i) => (i + offset) / 2);
  const r = plane(0);
  const g = plane(200);
  const b = plane(400);
  const a = plane(600);
  const interleave = (...planes: number[][]): number[] => Array.from({ length: n * planes.length }, (_, i) => planes[i % planes.length]![Math.floor(i / planes.length)]!);

  const rgb = buildExr({ width, height, compression: 3, channels: [{ name: 'R', type: 1, values: r }, { name: 'G', type: 1, values: g }, { name: 'B', type: 1, values: b }] });
  expectImage(decodeExr(rgb), width, height, 3, interleave(r, g, b));

  const rgba = buildExr({
    width, height, compression: 2,
    channels: [{ name: 'R', type: 2, values: r }, { name: 'G', type: 2, values: g }, { name: 'B', type: 2, values: b }, { name: 'A', type: 2, values: a }],
  });
  expectImage(decodeExr(rgba), width, height, 4, interleave(r, g, b, a));
});

test('OpenEXR: a Y channel decodes to one channel, whatever else the file holds and wherever its data window lies', () => {
  const width = 7;
  const height = 5;
  const y = Array.from({ length: width * height }, (_, i) => i / 4 - 3);
  const other = Array.from({ length: width * height }, (_, i) => 100 + i);
  for (const type of [1, 2] as const) {
    const bytes = buildExr({
      width, height, origin: [-3, 11],
      channels: [{ name: 'Y', type, values: y }, { name: 'A', type, values: other }, { name: 'depth', type: 2, values: other }],
    });
    expectImage(decodeExr(bytes), width, height, 1, y);
  }
});

test('OpenEXR: scan lines stored in decreasing order decode with the top row first', () => {
  // Wide enough for one scan line to compress.
  const values = Array.from({ length: 48 * 6 }, (_, i) => i / 2);
  for (const compression of [0, 2] as const) {
    const bytes = buildExr({ width: 48, height: 6, lineOrder: 1, compression, channels: [{ name: 'Y', type: 2, values }] });
    expectImage(decodeExr(bytes), 48, 6, 1, values);
  }
});

test('OpenEXR: files outside the accepted set are rejected with a sentence that names the cause', () => {
  const values = Array.from({ length: 4 * 20 }, (_, i) => i / 2);
  const y = { name: 'Y', type: 2, values } as const;
  const base = { width: 4, height: 20, channels: [y] } as const;
  const rejects = (bytes: Uint8Array, message: string): void => { assert.throws(() => decodeExr(bytes), { message }); };

  rejects(buildExr({ ...base, flags: 0x02 }), 'OpenEXR file is tiled; scan-line files are read');
  rejects(buildExr({ ...base, flags: 0x10 }), 'OpenEXR file is deep or has several parts; single-part scan-line files are read');
  rejects(buildExr({ ...base, channels: [{ name: 'Z', type: 2, values }] }), 'OpenEXR file has neither a Y channel nor R, G and B channels');
  rejects(buildExr({ ...base, channels: [y, { name: 'id', type: 0, values }] }), 'OpenEXR file has a UINT channel; files of HALF and FLOAT channels are read');
  rejects(buildExr({ ...base, channels: [y, { name: 'A', type: 1, values }] }), 'OpenEXR file mixes HALF and FLOAT image channels; one sample type is read');
  rejects(buildExr({ ...base, channels: [y, { name: 'RY', type: 2, values, sampling: 2 }] }), 'OpenEXR file has subsampled channels; full-resolution channels are read');
  rejects(buildExr({ ...base, declaredCompression: 6 }), 'OpenEXR compression B44 is not supported');
  rejects(buildExr({ ...base, compression: 3, lineOrder: 1 }), 'OpenEXR file stores its scan lines in decreasing or random order with this compression; increasing order is read');
  rejects(buildExr({ ...base, declaredSize: [10812, 10812] }), 'image is 10812 x 10812; the largest side is 8192');

  const whole = buildExr(base);
  rejects(whole.subarray(0, whole.length - 5), 'OpenEXR file is truncated');
  rejects(whole.subarray(0, 300), 'OpenEXR file is truncated');
  rejects(whole.subarray(0, 100), 'OpenEXR file is truncated');
  const zipped = buildExr({ ...base, compression: 3 });
  rejects(zipped.subarray(0, zipped.length - 5), 'OpenEXR file is truncated');
});

// ---- Raw ---------------------------------------------------------------------------------------------------

function rawBytes(sample: 'u8' | 'u16' | 'f32', values: readonly number[]): Uint8Array<ArrayBuffer> {
  const size = { u8: 1, u16: 2, f32: 4 }[sample];
  const out = new Uint8Array(values.length * size);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    if (sample === 'u8') view.setUint8(i, v);
    else if (sample === 'u16') view.setUint16(i * 2, v, true);
    else view.setFloat32(i * 4, v, true);
  });
  return out;
}

test('raw: .r8, .r16 and .r32 decode with stated dimensions', () => {
  const u8 = ramp(15, 255);
  expectImage(decodeRaw.run({ bytes: rawBytes('u8', u8), sample: 'u8', width: 5, height: 3 }, env), 5, 3, 1, u8.map((v) => v / 255));
  const u16 = ramp(15, 65535);
  expectImage(decodeRaw.run({ bytes: rawBytes('u16', u16), sample: 'u16', width: 3, height: 5 }, env), 3, 5, 1, u16.map((v) => v / 65535));
  const f32 = [-7.5, 0, 1e-30, 3e20, NaN, Infinity, -Infinity, 0.1, 2, 3, 4, 5, 6, 7, 8];
  expectImage(decodeRaw.run({ bytes: rawBytes('f32', f32), sample: 'f32', width: 5, height: 3 }, env), 5, 3, 1, f32.map((v) => (Number.isFinite(v) ? v : 0)));
});

test('raw: without dimensions a square sample count gives the side', () => {
  for (const sample of ['u8', 'u16', 'f32'] as const) {
    const max = sample === 'u8' ? 255 : sample === 'u16' ? 65535 : 1;
    const values = ramp(49, sample === 'f32' ? 1000 : max);
    const image = decodeRaw.run({ bytes: rawBytes(sample, values), sample }, env);
    expectImage(image, 7, 7, 1, values.map((v) => v / max));
  }
});

test('raw: a view into a larger buffer decodes its own bytes only', () => {
  const values = ramp(16, 65535);
  const padded = new Uint8Array(3 + 32 + 5);
  padded.set(rawBytes('u16', values), 3);
  expectImage(decodeRaw.run({ bytes: padded.subarray(3, 35), sample: 'u16' }, env), 4, 4, 1, values.map((v) => v / 65535));
  const floats = values.map((v) => v / 3);
  padded.set(rawBytes('f32', floats.slice(0, 8)), 3);
  expectImage(decodeRaw.run({ bytes: padded.subarray(3, 35), sample: 'f32', width: 4, height: 2 }, env), 4, 2, 1, floats.slice(0, 8));
});

test('raw: wrong sizes are rejected with a sentence that names the cause', () => {
  const run = (args: Parameters<typeof decodeRaw.run>[0]) => (): void => { decodeRaw.run(args, env); };
  assert.throws(run({ bytes: new Uint8Array(0), sample: 'u16' }), { message: 'raw file is empty' });
  assert.throws(run({ bytes: new Uint8Array(33), sample: 'u16' }), { message: 'raw file has 33 bytes, which is not a whole number of 16-bit samples' });
  assert.throws(run({ bytes: new Uint8Array(34), sample: 'f32' }), { message: 'raw file has 34 bytes, which is not a whole number of 32-bit float samples' });
  assert.throws(run({ bytes: new Uint8Array(30), sample: 'u16' }), { message: 'raw file holds 15 samples, which is not a square image; state its width and height' });
  assert.throws(run({ bytes: new Uint8Array(30), sample: 'u16', width: 4, height: 4 }), { message: 'raw file has 30 bytes; 4 x 4 16-bit samples are 32' });
  assert.throws(run({ bytes: new Uint8Array(32), sample: 'u16', width: 4 }), { message: 'raw file needs both its width and its height, or neither' });
  assert.throws(run({ bytes: new Uint8Array(32), sample: 'u16', width: 10812, height: 10812 }), { message: 'image is 10812 x 10812; the largest side is 8192' });
  assert.throws(run({ bytes: new Uint8Array(32), sample: 'u32' as 'u16' }), { message: 'raw sample type "u32" is not one of "u8", "u16" and "f32"' });
});

// ---- The task and the limits -------------------------------------------------------------------------------

test('decodeImage recognises the format from the first bytes', async () => {
  const values = ramp(16, 255);
  const expected = values.map((v) => v / 255);
  const files: Uint8Array[] = [
    encode({ width: 4, height: 4, data: Uint8Array.from(values), depth: 8, channels: 1 }),
    buildTiff({ width: 4, height: 4, samples: 1, bits: 8, format: 1, values, littleEndian: true }),
    buildTiff({ width: 4, height: 4, samples: 1, bits: 8, format: 1, values, littleEndian: false }),
    exportExr(4, 4, expected.map(Math.fround)),
  ];
  for (const bytes of files) {
    expectImage(await decodeImage.run({ bytes }, env), 4, 4, 1, expected);
    // The same bytes as a view into a larger buffer, as a caller other than FileSource.read may hand them over.
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 5);
    expectImage(await decodeImage.run({ bytes: padded.subarray(5, 5 + bytes.length) }, env), 4, 4, 1, expected);
  }
});

test('decodeImage rejects a file it does not recognise', async () => {
  const unrecognised = { message: 'file is not a PNG, TIFF or OpenEXR image' };
  await assert.rejects(decodeImage.run({ bytes: new Uint8Array(0) }, env), unrecognised);
  await assert.rejects(decodeImage.run({ bytes: Uint8Array.of(0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0) }, env), unrecognised);
  await assert.rejects(decodeImage.run({ bytes: Uint8Array.of(0x49, 0x49, 0x2b, 0x00, 8, 0, 0, 0) }, env), unrecognised);    // BigTIFF
  await assert.rejects(decodeImage.run({ bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) }, env), { message: 'PNG file is truncated' });
});

test('checkImageSize allows a side of 8192 and four channels, and no more', () => {
  checkImageSize(8192, 8192, 4);
  checkImageSize(1, 8192, 1);
  assert.throws(() => checkImageSize(8193, 16, 1), { message: 'image is 8193 x 16; the largest side is 8192' });
  assert.throws(() => checkImageSize(16, 8193, 3), { message: 'image is 16 x 8193; the largest side is 8192' });
  assert.throws(() => checkImageSize(0, 16, 1), { message: 'image is 0 x 16; both sides must be whole numbers of at least 1' });
});
