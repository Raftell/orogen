// The raw, OpenEXR and TIFF encoders of export-unreal.md 4.4 to 4.6, and the PNG encoder read back by two more
// readers (png.test.ts reads it with fast-png). A file written from a known image is byte-exact to the layout of
// the contract, decodes to the same samples, has the size of 4.2, and does not depend on how the rows are split
// over calls.
//
// Readers that are not Orogen's encoder:
//   raw      the bytes, read here with a DataView; and the project's decodeRaw
//   OpenEXR  the project's decodeImage (its own header walk, then the package parse-exr), parse-exr called
//            directly, and a walk of the header and the chunks written here from the OpenEXR file layout
//   TIFF     the project's decodeImage (the package geotiff), and the directory read here entry by entry
//   PNG      the project's decodeImage (the package fast-png), and readPng of _support.ts, written from the
//            PNG specification
//
// By hand, once (2026-10-13, on the development machine; 37 x 23 images written by these encoders into a scratch
// folder, with the samples of `samples()` below):
//   file 5.45       f.exr: "OpenEXR image data, version 2, storage: scanline, compression: none, dataWindow:
//                   (0 0)-(36 22), displayWindow: (0 0)-(36 22), lineOrder: increasing y". The two .tif: "TIFF image
//                   data, little-endian, direntries=11, height=23, bps=16 [32], compression=none,
//                   PhotometricInterpretation=BlackIsZero, width=37". The .png files: "PNG image data, 37 x 23,
//                   16-bit grayscale [8-bit grayscale, 8-bit/color RGB], non-interlaced".
//   Pillow 10.2.0   opened the 16-bit TIFF (mode I;16), the float TIFF (mode F), the 16-bit grey PNG (mode I), the
//                   8-bit grey PNG (L) and the 8-bit RGB PNG (RGB): every sample equal to the one written.
//   pypng 0.20231004  read the three PNG files: size, bit depth, greyscale, no alpha, not interlaced, and every
//                   sample equal to the one written.
//   libOpenEXR 3.1  the OpenEXR reference library, the shared one of the system, called through ctypes by
//                   tests/export/tools/exr-reference-check.py (2026-10-13): files of 1 x 1, 3 x 2, 37 x 23, 257 x 5,
//                   2 x 300 and 8129 x 3 written by createExrEncoder seven rows a call, and the 4033 x 4033
//                   HeightsExr.exr of a real build, each beside the same floats written as .r32. Its C core
//                   (libOpenEXRCore) reports one part, scan lines, no compression, increasing y and the windows
//                   (0, 0) to (w - 1, h - 1), finds every chunk through the offset table as one scan line of 4 w
//                   bytes, and returns the bytes of the .r32 for every line. Its C++ RgbaInputFile, which runs
//                   Header::sanityCheck, opens each file as one luminance channel and returns every sample as the
//                   half nearest to the float. No sample differed in any file.
//   libtiff 4.5     through Pillow, on a real build at 4033 x 4033: the float TIFF byte for byte the .r32, and
//                   the 16-bit TIFF of a measured range the codes computed in Python from the .r32.
// No tool with a command line (exrheader, oiiotool) is installed, and nothing was installed for this.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import parseExr from 'parse-exr';

import { decodeImage, decodeRaw } from '../../../src/core/api.ts';
import type { FileWriter } from '../../../src/core/runtime.ts';
import { createExrEncoder } from '../../../src/export/encode/exr.ts';
import { createPngEncoder, type RowEncoder } from '../../../src/export/encode/png.ts';
import { createRawEncoder } from '../../../src/export/encode/raw.ts';
import { createTiffEncoder } from '../../../src/export/encode/tiff.ts';
import { assertSame, collector, readPng, type Collector } from './_support.ts';

type Samples = Uint8Array | Uint16Array | Float32Array;
const env = { progress() { /* not shown */ } };

/** Deterministic samples: smooth along x with noise from a small generator. Floats reach below 0 and above 1. */
function samples(kind: 'u8' | 'u16' | 'f32', count: number, width: number): Samples {
  const out = kind === 'u8' ? new Uint8Array(count) : kind === 'u16' ? new Uint16Array(count) : new Float32Array(count);
  let state = 0x2545f491;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const t = 0.75 * ((i % width) / Math.max(width - 1, 1)) + 0.25 * (state / 2 ** 32);
    out[i] = kind === 'u8' ? Math.round(t * 255) : kind === 'u16' ? Math.round(t * 65535) : (t - 0.25) * 4000;
  }
  return out;
}

/** Writes `data` through an encoder, `rowsPerCall` rows at a time, and returns the file. */
async function encode<S extends Samples>(make: (out: FileWriter) => RowEncoder<S>, data: S, perRow: number, rowsPerCall: number, writer: Collector = collector()): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = make(writer);
  const height = data.length / perRow;
  for (let row = 0; row < height; row += rowsPerCall) {
    const rows = Math.min(rowsPerCall, height - row);
    await encoder.write(data.subarray(row * perRow, (row + rows) * perRow) as S);
    assert.equal(encoder.rowsWritten, row + rows);
  }
  await encoder.end();
  assert.equal(writer.closed, false, 'the encoder does not close the file');
  return writer.bytes();
}

const W = 37, H = 23;

test('raw: no header, row-major, little-endian, the size of 4.2, and the project decoder reads the samples back', async () => {
  for (const kind of ['u8', 'u16', 'f32'] as const) {
    const data = samples(kind, W * H, W);
    const file = await encode((out) => createRawEncoder(out, { width: W, height: H, sample: kind }), data, W, 5);
    const size = { u8: 1, u16: 2, f32: 4 }[kind];
    assert.equal(file.length, W * H * size, `${kind}: the file size`);

    // Byte by byte, with the order stated: row 0 first, low byte first.
    const view = new DataView(file.buffer);
    const read = (i: number): number => (kind === 'u8' ? view.getUint8(i) : kind === 'u16' ? view.getUint16(2 * i, true) : view.getFloat32(4 * i, true));
    let wrong = 0;
    for (let i = 0; i < W * H; i++) if (read(i) !== data[i]) wrong++;
    assert.equal(wrong, 0, `${kind}: samples that read back differently`);

    const decoded = decodeRaw.run({ bytes: file, sample: kind, width: W, height: H }, env);
    assert.deepEqual([decoded.width, decoded.height, decoded.channels], [W, H, 1]);
    const max = kind === 'u8' ? 255 : 65535;
    assertSame(kind === 'f32' ? decoded.data : decoded.data.map((v) => Math.round(v * max)), data, `${kind}: decodeRaw`);

    for (const rowsPerCall of [1, 7, H]) {
      assertSame(await encode((out) => createRawEncoder(out, { width: W, height: H, sample: kind }), data, W, rowsPerCall), file, `${kind}: ${rowsPerCall} rows per call`);
    }
  }
});

/** The attributes of an OpenEXR header, in file order, and the offset behind the header. */
function exrAttributes(file: Uint8Array): { readonly attributes: readonly { name: string; type: string; value: Uint8Array }[]; readonly end: number } {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 8;
  const text = (): string => {
    let s = '';
    while (file[at] !== 0) s += String.fromCharCode(file[at++]!);
    at++;
    return s;
  };
  const attributes: { name: string; type: string; value: Uint8Array }[] = [];
  for (let guard = 0; guard < 64; guard++) {
    const name = text();
    if (name === '') break;
    const type = text();
    const size = view.getInt32(at, true);
    at += 4;
    attributes.push({ name, type, value: file.subarray(at, at + size) });
    at += size;
  }
  return { attributes, end: at };
}

test('OpenEXR: the layout of 4.5 byte for byte, the size of 4.2, and two readers return the rows', async () => {
  const data = samples('f32', W * H, W) as Float32Array;
  const file = await encode((out) => createExrEncoder(out, { width: W, height: H }), data, W, 5);
  assert.equal(file.length, 277 + H * (16 + 4 * W), 'the file size');
  const view = new DataView(file.buffer);

  assertSame(file.subarray(0, 8), [0x76, 0x2f, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00], 'the magic number and version 2 without flags');
  const { attributes, end } = exrAttributes(file);
  assert.equal(end, 277, 'the header ends at offset 277 whatever the image size');
  assert.deepEqual(attributes.map((a) => [a.name, a.type, a.value.length]), [
    ['channels', 'chlist', 19], ['compression', 'compression', 1], ['dataWindow', 'box2i', 16], ['displayWindow', 'box2i', 16],
    ['lineOrder', 'lineOrder', 1], ['pixelAspectRatio', 'float', 4], ['screenWindowCenter', 'v2f', 8], ['screenWindowWidth', 'float', 4],
  ]);
  const value = (name: string): DataView => {
    const { value: bytes } = attributes.find((a) => a.name === name)!;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  // The channel list: the name Y, FLOAT, pLinear 0, three zero bytes, both samplings 1, and the zero that ends the list.
  assertSame(attributes[0]!.value, [0x59, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], 'the channel list');
  assert.equal(value('compression').getUint8(0), 0);
  assert.equal(value('lineOrder').getUint8(0), 0);
  for (const name of ['dataWindow', 'displayWindow']) {
    const box = value(name);
    assert.deepEqual([box.getInt32(0, true), box.getInt32(4, true), box.getInt32(8, true), box.getInt32(12, true)], [0, 0, W - 1, H - 1], name);
  }
  assert.equal(value('pixelAspectRatio').getFloat32(0, true), 1);
  assert.deepEqual([value('screenWindowCenter').getFloat32(0, true), value('screenWindowCenter').getFloat32(4, true)], [0, 0]);
  assert.equal(value('screenWindowWidth').getFloat32(0, true), 1);

  // The offset table, then one chunk per scan line: its number, the size of its pixel data, its row.
  let wrong = 0;
  for (let y = 0; y < H; y++) {
    const chunk = 277 + 8 * H + y * (8 + 4 * W);
    if (view.getUint32(277 + 8 * y, true) !== chunk || view.getUint32(277 + 8 * y + 4, true) !== 0) wrong++;
    if (view.getInt32(chunk, true) !== y || view.getInt32(chunk + 4, true) !== 4 * W) wrong++;
    for (let x = 0; x < W; x++) if (view.getFloat32(chunk + 8 + 4 * x, true) !== data[y * W + x]) wrong++;
  }
  assert.equal(wrong, 0, 'offsets, chunk headers and samples that differ from the layout');

  // The project's decoder: its own walk of the header and the chunk sequence, then the library.
  const decoded = await decodeImage.run({ bytes: file.slice() }, env);
  assert.deepEqual([decoded.width, decoded.height, decoded.channels], [W, H, 1]);
  assertSame(decoded.data, data, 'decodeImage');

  // The library by itself, which is no code of Orogen's: one channel, bottom row first.
  const parsed = parseExr(file.slice().buffer, 1015);
  assert.deepEqual([parsed.width, parsed.height, parsed.data.length], [W, H, W * H]);
  const flipped = new Float32Array(W * H);
  for (let y = 0; y < H; y++) flipped.set((parsed.data as Float32Array).subarray((H - 1 - y) * W, (H - y) * W), y * W);
  assertSame(flipped, data, 'parse-exr');

  for (const rowsPerCall of [1, 7, H]) {
    assertSame(await encode((out) => createExrEncoder(out, { width: W, height: H }), data, W, rowsPerCall), file, `${rowsPerCall} rows per call`);
  }
});

test('TIFF: the layout of 4.6 byte for byte with one strip and with several, the size of 4.2, and the project decoder reads the samples back', async () => {
  for (const [kind, height] of [['u16', H], ['f32', H], ['u16', 130], ['f32', 130], ['u16', 64], ['f32', 65]] as const) {
    const name = `${kind}, ${W} x ${height}`;
    const data = samples(kind, W * height, W) as Uint16Array | Float32Array;
    const make = (out: FileWriter): RowEncoder<Uint16Array | Float32Array> => createTiffEncoder(out, { width: W, height, sample: kind });
    const file = await encode(make, data, W, 5);
    const b = kind === 'u16' ? 2 : 4;
    const n = Math.ceil(height / 64);
    const D = n === 1 ? 146 : 146 + 8 * n;
    assert.equal(file.length, D + b * W * height, `${name}: the file size`);

    const view = new DataView(file.buffer);
    assertSame(file.subarray(0, 4), [0x49, 0x49, 0x2a, 0x00], `${name}: little-endian TIFF`);
    assert.deepEqual([view.getUint32(4, true), view.getUint16(8, true), view.getUint32(142, true)], [8, 11, 0], `${name}: the directory at 8, eleven entries, no further directory`);
    const SHORT = 3, LONG = 4;
    const expected: readonly (readonly [tag: number, type: number, count: number, value: number])[] = [
      [256, LONG, 1, W], [257, LONG, 1, height], [258, SHORT, 1, 8 * b], [259, SHORT, 1, 1], [262, SHORT, 1, 1],
      [273, LONG, n, n === 1 ? D : 146], [277, SHORT, 1, 1], [278, LONG, 1, 64], [279, LONG, n, n === 1 ? b * W * height : 146 + 4 * n],
      [284, SHORT, 1, 1], [339, SHORT, 1, kind === 'u16' ? 1 : 3],
    ];
    for (const [i, [tag, type, count, value]] of expected.entries()) {
      const at = 10 + 12 * i;
      // A SHORT value occupies the first two bytes of the value field; the other two are zero.
      assert.deepEqual([view.getUint16(at, true), view.getUint16(at + 2, true), view.getUint32(at + 4, true), view.getUint32(at + 8, true)], [tag, type, count, value], `${name}: entry ${i}, tag ${tag}`);
    }
    if (n > 1) {
      for (let i = 0; i < n; i++) {
        assert.equal(view.getUint32(146 + 4 * i, true), D + i * 64 * b * W, `${name}: the offset of strip ${i}`);
        assert.equal(view.getUint32(146 + 4 * n + 4 * i, true), Math.min(64, height - 64 * i) * b * W, `${name}: the byte count of strip ${i}`);
      }
    }
    let wrong = 0;
    for (let i = 0; i < W * height; i++) {
      if ((kind === 'u16' ? view.getUint16(D + 2 * i, true) : view.getFloat32(D + 4 * i, true)) !== data[i]) wrong++;
    }
    assert.equal(wrong, 0, `${name}: samples that differ from the layout`);

    const decoded = await decodeImage.run({ bytes: file.slice() }, env);
    assert.deepEqual([decoded.width, decoded.height, decoded.channels], [W, height, 1], name);
    assertSame(kind === 'f32' ? decoded.data : decoded.data.map((v) => Math.round(v * 65535)), data, `${name}: decodeImage`);

    for (const rowsPerCall of [1, 64, height]) assertSame(await encode(make, data, W, rowsPerCall), file, `${name}: ${rowsPerCall} rows per call`);
  }
});

test('PNG: the project decoder and a reader written from the specification return the samples, in every layout', async () => {
  for (const shape of [
    { width: W, height: H, channels: 1, bits: 8 }, { width: W, height: H, channels: 3, bits: 8 },
    { width: W, height: H, channels: 1, bits: 16 }, { width: 300, height: 200, channels: 1, bits: 16 },
  ] as const) {
    const name = `${shape.width} x ${shape.height}, ${shape.channels} channels, ${shape.bits} bits`;
    const perRow = shape.width * shape.channels;
    const data = samples(shape.bits === 8 ? 'u8' : 'u16', perRow * shape.height, perRow) as Uint8Array | Uint16Array;
    const file = await encode((out) => createPngEncoder(out, shape), data, perRow, 9);

    const own = readPng(file);
    assert.deepEqual([own.width, own.height, own.channels, own.bits], [shape.width, shape.height, shape.channels, shape.bits], name);
    assertSame(own.samples, data, `${name}: the reader of these tests`);
    assert.ok(own.filters.every((filter) => filter === 2), `${name}: every scanline carries filter type 2`);

    const decoded = await decodeImage.run({ bytes: file.slice() }, env);
    assert.deepEqual([decoded.width, decoded.height, decoded.channels], [shape.width, shape.height, shape.channels], name);
    const max = shape.bits === 8 ? 255 : 65535;
    assertSame(decoded.data.map((v) => Math.round(v * max)), data, `${name}: decodeImage`);
  }
});

test('every encoder checks its rows, and end needs every row', async () => {
  const encoders: readonly (readonly [string, () => RowEncoder<Samples>, Samples, Samples])[] = [
    ['raw u8', () => createRawEncoder(collector(), { width: 4, height: 3, sample: 'u8' }), new Uint8Array(4), new Uint16Array(4)],
    ['raw u16', () => createRawEncoder(collector(), { width: 4, height: 3, sample: 'u16' }), new Uint16Array(4), new Uint8Array(4)],
    ['raw f32', () => createRawEncoder(collector(), { width: 4, height: 3, sample: 'f32' }), new Float32Array(4), new Uint16Array(4)],
    ['OpenEXR', () => createExrEncoder(collector(), { width: 4, height: 3 }) as RowEncoder<Samples>, new Float32Array(4), new Uint16Array(4)],
    ['TIFF u16', () => createTiffEncoder(collector(), { width: 4, height: 3, sample: 'u16' }) as RowEncoder<Samples>, new Uint16Array(4), new Float32Array(4)],
    ['TIFF f32', () => createTiffEncoder(collector(), { width: 4, height: 3, sample: 'f32' }) as RowEncoder<Samples>, new Float32Array(4), new Uint16Array(4)],
  ];
  for (const [name, make, row, otherType] of encoders) {
    const encoder = make();
    await assert.rejects(encoder.write(row.subarray(0, 3)), RangeError, `${name}: not a whole number of rows`);
    await assert.rejects(encoder.write(otherType), RangeError, `${name}: another sample type`);
    assert.equal(encoder.rowsWritten, 0, `${name}: a refused write wrote nothing`);
    await encoder.write(row);
    await encoder.write(row.subarray(0, 0));
    await assert.rejects(encoder.end(), RangeError, `${name}: end after 1 of 3 rows`);
    await encoder.write(row);
    await encoder.write(row);
    await assert.rejects(encoder.write(row), RangeError, `${name}: a fourth row`);
    assert.equal(encoder.rowsWritten, 3);
    await encoder.end();
    await assert.rejects(encoder.write(row), RangeError, `${name}: write after end`);
    await assert.rejects(encoder.end(), RangeError, `${name}: end twice`);
  }
  assert.throws(() => createRawEncoder(collector(), { width: 0, height: 1, sample: 'u8' }), RangeError);
  assert.throws(() => createRawEncoder(collector(), { width: 1, height: 1, sample: 'u32' as never }), RangeError);
  assert.throws(() => createExrEncoder(collector(), { width: 1, height: 1.5 }), RangeError);
  assert.throws(() => createTiffEncoder(collector(), { width: 1, height: 1, sample: 'u8' as never }), RangeError);
});

test('no chunk handed to the file is above 16 MiB, and each write is awaited before the next', async () => {
  // 2100 rows of 2048 floats are 16.4 MiB of samples: more than one chunk, in one write call.
  const width = 2048, height = 2100;
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i += 4099) data[i] = i;
  const makers: readonly (readonly [string, (out: FileWriter) => RowEncoder<Float32Array>, number])[] = [
    ['raw', (out) => createRawEncoder(out, { width, height, sample: 'f32' }) as RowEncoder<Float32Array>, 4 * width * height],
    ['OpenEXR', (out) => createExrEncoder(out, { width, height }), 277 + height * (16 + 4 * width)],
    ['TIFF', (out) => createTiffEncoder(out, { width, height, sample: 'f32' }) as RowEncoder<Float32Array>, 146 + 8 * 33 + 4 * width * height],
  ];
  for (const [name, make, size] of makers) {
    let busy = false, overlapping = 0, largest = 0, total = 0;
    const writer: FileWriter = {
      async write(chunk) {
        if (busy) overlapping++;
        busy = true;
        largest = Math.max(largest, chunk.byteLength);
        total += chunk.byteLength;
        await new Promise((resolve) => setImmediate(resolve));
        busy = false;
      },
      async close() { return { bytes: total }; },
      async abort() { /* nothing */ },
    };
    const encoder = make(writer);
    await encoder.write(data);
    await encoder.end();
    assert.equal(total, size, `${name}: the file size`);
    assert.ok(largest <= 16 << 20, `${name}: the largest chunk is ${largest} bytes`);
    assert.equal(overlapping, 0, `${name}: writes that began before the one before them had resolved`);
  }
});

test('a file that fails stops an encoder: the write that meets it and every later call reject with its error', async () => {
  const failure = new Error('disk full');
  const failing = (): FileWriter => {
    let calls = 0;
    return {
      async write() {
        if (++calls >= 2) throw failure;
      },
      async close() { return { bytes: 0 }; },
      async abort() { /* nothing */ },
    };
  };
  const makers: readonly (readonly [string, RowEncoder<Float32Array>])[] = [
    ['raw', createRawEncoder(failing(), { width: 8, height: 4, sample: 'f32' }) as RowEncoder<Float32Array>],
    ['OpenEXR', createExrEncoder(failing(), { width: 8, height: 4 })],
    ['TIFF', createTiffEncoder(failing(), { width: 8, height: 4, sample: 'f32' }) as RowEncoder<Float32Array>],
  ];
  for (const [name, encoder] of makers) {
    const row = new Float32Array(8);
    const outcome = await (async () => {
      for (let y = 0; y < 4; y++) await encoder.write(row);
      await encoder.end();
    })().then(() => null, (thrown: unknown) => thrown);
    assert.equal(outcome, failure, name);
    await assert.rejects(encoder.write(row), (thrown) => thrown === failure, `${name}: a later write`);
    await assert.rejects(encoder.end(), (thrown) => thrown === failure, `${name}: a later end`);
  }
});
