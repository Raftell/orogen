// The PNG encoder of export-unreal.md 4.1 and 4.3: a file written from a known image decodes to the same samples
// (with fast-png, a reader that is not Orogen's), the bytes do not depend on how the rows are split over calls,
// every scanline carries filter type 2, every IDAT chunk but the last is 1 MiB, no ancillary chunk is written,
// and the encoder checks its rows and waits for the file.
//
// Sizes: the largest image is 1024 x 768 16-bit grey (1.5 MiB of samples); no list is handed to an assertion.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { decode } from 'fast-png';

import type { FileWriter } from '../../../src/core/runtime.ts';
import { createPngEncoder } from '../../../src/export/encode/png.ts';

type Samples = Uint8Array | Uint16Array;
interface Shape { readonly width: number; readonly height: number; readonly channels: 1 | 3; readonly bits: 8 | 16 }

/** A FileWriter that keeps what it is given, and counts the calls that overlap. */
function collector(delayMs = 0): FileWriter & { readonly chunks: Uint8Array[]; readonly sizes: number[]; overlapping: number; bytes(): Uint8Array } {
  const chunks: Uint8Array[] = [];
  const sizes: number[] = [];
  let busy = false;
  const writer = {
    chunks, sizes,
    overlapping: 0,
    async write(chunk: Uint8Array): Promise<void> {
      if (busy) writer.overlapping++;
      busy = true;
      sizes.push(chunk.byteLength);
      // A copy: the encoder may reuse nothing it handed over, and the test must not depend on that.
      chunks.push(chunk.slice());
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      busy = false;
    },
    async close() { return { bytes: sizes.reduce((sum, n) => sum + n, 0) }; },
    async abort() { /* nothing to delete */ },
    bytes(): Uint8Array { return Buffer.concat(chunks); },
  };
  return writer;
}

/** A deterministic image: smooth in x, with noise from a small generator, so that it neither vanishes nor is incompressible. */
function image(shape: Shape, noise = 0.25): Samples {
  const count = shape.width * shape.height * shape.channels;
  const max = shape.bits === 8 ? 255 : 65535;
  const out = shape.bits === 8 ? new Uint8Array(count) : new Uint16Array(count);
  let state = 0x9e3779b9;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const x = Math.floor(i / shape.channels) % shape.width;
    const smooth = x / Math.max(shape.width - 1, 1);
    out[i] = Math.round(max * Math.min(1, Math.max(0, (1 - noise) * smooth + noise * (state / 2 ** 32))));
  }
  return out;
}

/** Encodes `samples`, handing over `rowsPerCall` rows at a time. */
async function encodeImage(shape: Shape, samples: Samples, rowsPerCall: number, writer = collector()): Promise<Uint8Array> {
  const encoder = createPngEncoder(writer, shape);
  const perRow = shape.width * shape.channels;
  for (let row = 0; row < shape.height; row += rowsPerCall) {
    const rows = Math.min(rowsPerCall, shape.height - row);
    await encoder.write(samples.subarray(row * perRow, (row + rows) * perRow));
    assert.equal(encoder.rowsWritten, row + rows);
  }
  await encoder.end();
  return writer.bytes();
}

/** The index of the first element that differs and the number that do; -1 and 0 when the lists are equal. */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): { readonly index: number; readonly count: number } {
  let index = a.length === b.length ? -1 : Math.min(a.length, b.length), count = a.length === b.length ? 0 : 1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (count++ === 0 || i < index) index = i;
  }
  return { index, count };
}
function assertSame(a: ArrayLike<number>, b: ArrayLike<number>, what: string): void {
  const { index, count } = firstDifference(a, b);
  if (count > 0) assert.fail(`${what}: ${count} elements differ (lengths ${a.length} and ${b.length}); the first is element ${index}: ${a[index]} against ${b[index]}`);
}

interface Chunk { readonly type: string; readonly data: Uint8Array }
/** The chunks of a PNG file, each with its CRC verified. */
function chunksOf(file: Uint8Array): Chunk[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  assertSame(file.subarray(0, 8), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the signature');
  const chunks: Chunk[] = [];
  for (let at = 8; at < file.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const data = file.subarray(at + 8, at + 8 + length);
    assert.equal(view.getUint32(at + 8 + length), zlib.crc32(file.subarray(at + 4, at + 8 + length)), `the CRC of chunk ${chunks.length} (${type})`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

const SHAPES: readonly Shape[] = [
  { width: 37, height: 23, channels: 1, bits: 8 },
  { width: 37, height: 23, channels: 3, bits: 8 },
  { width: 37, height: 23, channels: 1, bits: 16 },
  { width: 37, height: 23, channels: 3, bits: 16 },
  { width: 1, height: 1, channels: 1, bits: 16 },
];

test('a written file decodes to the samples it was written from, in every layout', async () => {
  for (const shape of SHAPES) {
    const samples = image(shape);
    const file = await encodeImage(shape, samples, 5);
    const decoded = decode(file);
    const name = `${shape.width} x ${shape.height}, ${shape.channels} channels, ${shape.bits} bits`;
    assert.deepEqual([decoded.width, decoded.height, decoded.channels, decoded.depth], [shape.width, shape.height, shape.channels, shape.bits], name);
    assert.ok(shape.bits === 8 ? decoded.data instanceof Uint8Array : decoded.data instanceof Uint16Array, `${name}: the sample type`);
    assertSame(decoded.data, samples, name);
  }
});

test('the file is the same whether the rows come in one call, one by one or in uneven groups', async () => {
  const shape: Shape = { width: 211, height: 97, channels: 3, bits: 16 };
  const samples = image(shape);
  const whole = await encodeImage(shape, samples, shape.height);
  for (const rowsPerCall of [1, 7, 64]) assertSame(await encodeImage(shape, samples, rowsPerCall), whole, `${rowsPerCall} rows per call against one call`);
  // And whatever the pace of the file: the cut into chunks follows the stream, not its delivery.
  assertSame(await encodeImage(shape, samples, 13, collector(1)), whole, 'a slow file against a fast one');
});

test('the layout of 4.3: IHDR, IDAT chunks of 1 MiB with the rest last, IEND, filter type 2 on every scanline', async () => {
  // Mostly noise: the zlib stream of 1.5 MiB of samples is then longer than one IDAT chunk.
  const shape: Shape = { width: 1024, height: 768, channels: 1, bits: 16 };
  const samples = image(shape, 1);
  const writer = collector();
  const file = await encodeImage(shape, samples, 100, writer);
  const chunks = chunksOf(file);

  assert.deepEqual([...new Set(chunks.map((c) => c.type))], ['IHDR', 'IDAT', 'IEND'], 'no ancillary chunk, and the three kinds in order');
  assert.equal(chunks[0]!.type, 'IHDR');
  assert.equal(chunks.at(-1)!.type, 'IEND');
  const header = chunks[0]!.data;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  assert.deepEqual([header.length, view.getUint32(0), view.getUint32(4), ...header.subarray(8)], [13, 1024, 768, 16, 0, 0, 0, 0], 'width, height, depth, grey, deflate, filter method 0, not interlaced');
  assertSame(file.subarray(file.length - 12), [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], 'the IEND chunk');

  const data = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  assert.ok(data.length >= 2, `the stream spans several IDAT chunks (${data.length})`);
  for (const [i, part] of data.entries()) {
    if (i < data.length - 1) assert.equal(part.length, 1 << 20, `IDAT chunk ${i} of ${data.length}`);
    else assert.ok(part.length > 0 && part.length <= 1 << 20, `the last IDAT chunk holds the rest (${part.length} bytes)`);
  }
  assert.ok(Math.max(...writer.sizes) <= 16 << 20, 'no chunk handed to the file is above 16 MiB');

  // The concatenated IDAT data is one zlib stream of the scanlines (4.3).
  const lines = zlib.inflateSync(Buffer.concat(data));
  const stride = 1 + shape.width * 2;
  assert.equal(lines.length, shape.height * stride);
  let other = 0;
  for (let row = 0; row < shape.height; row++) if (lines[row * stride] !== 2) other++;
  assert.equal(other, 0, 'scanlines with a filter type other than 2 (Up)');
  // Up, undone by hand for one sample of the last row: high byte first, each byte the sum of its column modulo 256.
  const x = 513;
  let high = 0, low = 0;
  for (let row = 0; row < shape.height; row++) {
    high = (high + lines[row * stride + 1 + 2 * x]!) & 0xff;
    low = (low + lines[row * stride + 2 + 2 * x]!) & 0xff;
  }
  assert.equal((high << 8) | low, samples[(shape.height - 1) * shape.width + x]);
  assertSame(decode(file).data, samples, 'the decoded image');
});

test('write checks its rows; end needs every row', async () => {
  const shape: Shape = { width: 4, height: 3, channels: 3, bits: 8 };
  const encoder = createPngEncoder(collector(), shape);
  await assert.rejects(encoder.write(new Uint8Array(13)), RangeError, 'not a whole number of rows');
  await assert.rejects(encoder.write(new Uint16Array(12)), RangeError, '16-bit samples for an 8-bit image');
  await assert.rejects(encoder.write(new Uint8Array(48)), RangeError, 'more rows than the image has');
  assert.equal(encoder.rowsWritten, 0, 'a refused write wrote nothing');
  await encoder.write(new Uint8Array(24));
  await assert.rejects(encoder.end(), RangeError, 'end after 2 of 3 rows');
  await encoder.write(new Uint8Array(12));
  await assert.rejects(encoder.write(new Uint8Array(12)), RangeError, 'a fourth row');
  await encoder.end();
  await assert.rejects(encoder.write(new Uint8Array(0)), RangeError, 'write after end');
  await assert.rejects(encoder.end(), RangeError, 'end twice');

  const wide = createPngEncoder(collector(), { width: 4, height: 1, channels: 1, bits: 16 });
  await assert.rejects(wide.write(new Uint8Array(4)), RangeError, '8-bit samples for a 16-bit image');
  assert.throws(() => createPngEncoder(collector(), { width: 0, height: 1, channels: 1, bits: 8 }), RangeError);
  assert.throws(() => createPngEncoder(collector(), { width: 1, height: 1, channels: 4 as never, bits: 8 }), RangeError);
  assert.throws(() => createPngEncoder(collector(), { width: 1, height: 1, channels: 1, bits: 12 as never }), RangeError);
});

test('the encoder awaits each write of the file before the next, and a write resolves only when the file has caught up', async () => {
  const shape: Shape = { width: 1024, height: 768, channels: 1, bits: 16 };
  const samples = image(shape, 1);
  const writer = collector(2);
  const encoder = createPngEncoder(writer, shape);
  const perRow = shape.width;
  let filedBefore = 0;
  for (let row = 0; row < shape.height; row += 256) {
    await encoder.write(samples.subarray(row * perRow, (row + 256) * perRow));
    // Everything the compressor had delivered when the write resolved is in the file: nothing queues up behind a slow one.
    assert.ok(writer.chunks.length >= filedBefore);
    filedBefore = writer.chunks.length;
  }
  await encoder.end();
  assert.equal(writer.overlapping, 0, 'writes of the file that began before the one before them had resolved');
  assertSame(decode(writer.bytes()).data, samples, 'the decoded image');
  // The caller may reuse the array after a write: the file holds the samples as they were when it was called.
  const reused = createPngEncoder(collector(), { width: 2, height: 2, channels: 1, bits: 8 });
  const row = new Uint8Array([10, 20]);
  const sink = collector();
  const again = createPngEncoder(sink, { width: 2, height: 2, channels: 1, bits: 8 });
  await again.write(row);
  row.set([30, 40]);
  await again.write(row);
  await again.end();
  assertSame(decode(sink.bytes()).data, [10, 20, 30, 40], 'rows written from one reused array');
  await reused.write(new Uint8Array(4));
  await reused.end();
});

test('a file that fails stops the encoder: the write that meets it and every later call reject with its error', async () => {
  const failure = new Error('disk full');
  let calls = 0;
  const failing: FileWriter = {
    async write() {
      if (++calls >= 2) throw failure;
    },
    async close() { return { bytes: 0 }; },
    async abort() { /* nothing */ },
  };
  const shape: Shape = { width: 512, height: 512, channels: 3, bits: 8 };
  const samples = image(shape, 1);
  const encoder = createPngEncoder(failing, shape);
  const outcome = await (async () => {
    await encoder.write(samples);
    await encoder.end();
  })().then(() => null, (thrown: unknown) => thrown);
  assert.equal(outcome, failure);
  await assert.rejects(encoder.end(), (thrown) => thrown === failure);
  await assert.rejects(encoder.write(new Uint8Array(0)), (thrown) => thrown === failure);
});
