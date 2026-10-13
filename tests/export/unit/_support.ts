// What the GPU-free tests of the export code share: files kept in memory, a comparison of data that builds no
// textual diff (testing.md 8.2), and a PNG reader of the tests' own.

import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import type { FileSink, FileWriter } from '../../../src/core/runtime.ts';

export type Collector = FileWriter & { readonly sizes: number[]; closed: boolean; bytes(): Uint8Array<ArrayBuffer> };

/** A FileWriter that keeps what it is given. `delayMs` makes every write take that long. */
export function collector(delayMs = 0): Collector {
  const chunks: Uint8Array[] = [];
  const sizes: number[] = [];
  const writer: Collector = {
    sizes,
    closed: false,
    async write(chunk: Uint8Array): Promise<void> {
      sizes.push(chunk.byteLength);
      // A copy: the encoder may reuse what it handed over once the write has resolved.
      chunks.push(chunk.slice());
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    },
    async close() {
      writer.closed = true;
      return { bytes: sizes.reduce((sum, n) => sum + n, 0) };
    },
    async abort() { /* nothing to delete */ },
    bytes() {
      const out = new Uint8Array(sizes.reduce((sum, n) => sum + n, 0));
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
  };
  return writer;
}

export interface MemoryFiles extends FileSink {
  /** Closed files, by path. */
  readonly files: Map<string, Uint8Array<ArrayBuffer>>;
  /** Paths with a writer that is neither closed nor aborted. */
  readonly open: Set<string>;
  aborts: number;
}

/** A FileSink over a table: a file is visible once its writer is closed, and abortAll drops what is open. */
export function memoryFiles(): MemoryFiles {
  const sink: MemoryFiles = {
    files: new Map(),
    open: new Set(),
    aborts: 0,
    async create(relPath) {
      if (sink.open.has(relPath) || sink.files.has(relPath)) throw new Error(`"${relPath}" is written twice`);
      sink.open.add(relPath);
      const inner = collector();
      return {
        async write(chunk) {
          if (!sink.open.has(relPath)) throw new Error(`"${relPath}" is not open`);
          await inner.write(chunk);
        },
        async close() {
          if (!sink.open.delete(relPath)) throw new Error(`"${relPath}" is not open`);
          sink.files.set(relPath, inner.bytes());
          return inner.close();
        },
        async abort() {
          sink.open.delete(relPath);
        },
      };
    },
    async write(relPath, data) {
      const writer = await sink.create(relPath);
      await writer.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
      await writer.close();
    },
    async abortAll() {
      sink.aborts++;
      sink.open.clear();
    },
  };
  return sink;
}

/** The index of the first element that differs and the number that do; -1 and 0 when the lists are equal. */
export function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): { readonly index: number; readonly count: number } {
  let index = a.length === b.length ? -1 : Math.min(a.length, b.length), count = a.length === b.length ? 0 : 1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    // Object.is: a NaN equals a NaN, and a sample is never -0 on one side alone by accident.
    if (a[i] === b[i] || (a[i] !== a[i] && b[i] !== b[i])) continue;
    if (count++ === 0 || i < index) index = i;
  }
  return { index, count };
}
export function assertSame(a: ArrayLike<number>, b: ArrayLike<number>, what: string): void {
  const { index, count } = firstDifference(a, b);
  if (count > 0) assert.fail(`${what}: ${count} elements differ (lengths ${a.length} and ${b.length}); the first is element ${index}: ${a[index]} against ${b[index]}`);
}
/** The largest absolute difference of two lists of one length. */
export function largestDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  assert.equal(a.length, b.length, 'the lists have one length');
  let largest = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (!(d <= largest)) largest = d;       // a NaN difference becomes the result
  }
  return largest;
}

export interface PngChunk { readonly type: string; readonly data: Uint8Array }
/** The chunks of a PNG file, each with its CRC verified. */
export function pngChunks(file: Uint8Array): PngChunk[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  assertSame(file.subarray(0, 8), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the signature');
  const chunks: PngChunk[] = [];
  for (let at = 8; at < file.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    assert.equal(view.getUint32(at + 8 + length), zlib.crc32(file.subarray(at + 4, at + 8 + length)), `the CRC of chunk ${chunks.length} (${type})`);
    chunks.push({ type, data: file.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

export interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly bits: number;
  /** The filter type of every scanline. */
  readonly filters: Uint8Array;
  readonly samples: Uint8Array | Uint16Array;
}

/**
 * A PNG reader written for these tests from the PNG specification, sharing no code with the encoder or with
 * fast-png: the chunks, one inflate of the concatenated IDAT data, and the five scanline filters undone. It
 * reads what the encoder can write: grey or RGB, 8 or 16 bits, not interlaced.
 */
export function readPng(file: Uint8Array): PngImage {
  const chunks = pngChunks(file);
  const header = chunks[0]!;
  assert.equal(header.type, 'IHDR');
  const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
  const width = view.getUint32(0), height = view.getUint32(4), bits = header.data[8]!, colorType = header.data[9]!;
  assert.ok(colorType === 0 || colorType === 2, `colour type ${colorType}`);
  assert.ok(bits === 8 || bits === 16, `bit depth ${bits}`);
  assert.equal(header.data[12], 0, 'not interlaced');
  const channels = colorType === 0 ? 1 : 3;
  const bpp = channels * bits / 8;
  const stride = width * bpp;
  const lines = zlib.inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
  assert.equal(lines.length, height * (1 + stride), 'the length of the scanlines');

  const raw = new Uint8Array(height * stride);
  const filters = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    const filter = lines[y * (1 + stride)]!;
    filters[y] = filter;
    const from = y * (1 + stride) + 1, to = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? raw[to + i - bpp]! : 0;
      const up = y > 0 ? raw[to + i - stride]! : 0;
      const upLeft = y > 0 && i >= bpp ? raw[to + i - stride - bpp]! : 0;
      let predicted: number;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = (left + up) >> 1; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default: assert.fail(`filter type ${filter} in row ${y}`);
      }
      raw[to + i] = (lines[from + i]! + predicted) & 0xff;
    }
  }
  if (bits === 8) return { width, height, channels, bits, filters, samples: raw };
  const samples = new Uint16Array(width * height * channels);
  for (let i = 0; i < samples.length; i++) samples[i] = (raw[2 * i]! << 8) | raw[2 * i + 1]!;
  return { width, height, channels, bits, filters, samples };
}
