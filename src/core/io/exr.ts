import parseExr from 'parse-exr';
import { checkImageSize, exactBuffer, reasonOf } from './image.ts';
import type { DecodedImage } from './image.ts';

const HALF = 1;
const FLOAT = 2;
// parse-exr's output type constant for 32-bit float.
const FLOAT_OUTPUT = 1015;

// Scan lines per chunk, by compression code. The codes the library does not read (B44, B44A) are absent.
const BLOCK_HEIGHT: ReadonlyMap<number, number> = new Map([
  [0, 1], [1, 1], [2, 1], [3, 16], [4, 32], [5, 16], [8, 32], [9, 256],
]);
const COMPRESSION_NAMES = ['none', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB'];

interface ExrChannel {
  readonly name: string;
  readonly type: number;          // 0 UINT, 1 HALF, 2 FLOAT
  readonly xSampling: number;
  readonly ySampling: number;
}

interface ExrHeader {
  readonly width: number;
  readonly height: number;
  readonly top: number;           // the y of the first scan line: dataWindow.yMin
  readonly channels: readonly ExrChannel[];
  readonly compression: number;
  readonly lineOrder: number;     // 0 increasing Y, 1 decreasing Y
  readonly end: number;           // the offset of the chunk offset table
}

const truncated = (): Error => new Error('OpenEXR file is truncated');

/** Reads the header by itself, so that every limit is checked before the library allocates and decodes. */
function readHeader(bytes: Uint8Array): ExrHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw truncated();
  // The version field: one byte of version, then flag bits.
  const flags = bytes[5];
  if (flags & 0x18) throw new Error('OpenEXR file is deep or has several parts; single-part scan-line files are read');
  if (flags & 0x02) throw new Error('OpenEXR file is tiled; scan-line files are read');

  let pos = 8;
  const text = (): string => {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end >= bytes.length) throw truncated();
    let s = '';
    for (let i = pos; i < end; i++) s += String.fromCharCode(bytes[i]);
    pos = end + 1;
    return s;
  };

  let channels: ExrChannel[] | null = null;
  let compression: number | null = null;
  let lineOrder = 0;
  let window: { xMin: number; yMin: number; xMax: number; yMax: number } | null = null;
  for (;;) {
    const name = text();
    if (name === '') break;
    text();                                       // the attribute's type name
    if (pos + 4 > bytes.length) throw truncated();
    const size = view.getInt32(pos, true);
    pos += 4;
    if (size < 0 || pos + size > bytes.length) throw truncated();
    const value = pos;
    const next = pos + size;
    if (name === 'channels') {
      channels = [];
      while (pos < next - 1) {
        const channel = text();
        if (pos + 16 > next) throw truncated();
        channels.push({
          name: channel,
          type: view.getInt32(pos, true),
          xSampling: view.getInt32(pos + 8, true),
          ySampling: view.getInt32(pos + 12, true),
        });
        pos += 16;
      }
    } else if (name === 'compression' && size >= 1) compression = bytes[value];
    else if (name === 'lineOrder' && size >= 1) lineOrder = bytes[value];
    else if (name === 'dataWindow' && size >= 16) {
      window = {
        xMin: view.getInt32(value, true), yMin: view.getInt32(value + 4, true),
        xMax: view.getInt32(value + 8, true), yMax: view.getInt32(value + 12, true),
      };
    }
    pos = next;
  }
  if (channels === null || compression === null || window === null) {
    throw new Error('OpenEXR file lacks a channels, compression or dataWindow attribute');
  }
  return {
    width: window.xMax - window.xMin + 1,
    height: window.yMax - window.yMin + 1,
    top: window.yMin,
    channels, compression, lineOrder, end: pos,
  };
}

/** Scan-line files with a `Y` channel, or `R`, `G`, `B` and optional `A` (export-unreal.md 4.7). Uses parse-exr. */
export function decodeExr(bytes: Uint8Array): DecodedImage {
  const header = readHeader(bytes);
  const { width, height } = header;

  const named = (name: string): ExrChannel | undefined => header.channels.find((c) => c.name === name);
  const rgb = named('R') !== undefined && named('G') !== undefined && named('B') !== undefined;
  if (!rgb && named('Y') === undefined) throw new Error('OpenEXR file has neither a Y channel nor R, G and B channels');
  const channels: 1 | 3 | 4 = rgb ? (named('A') !== undefined ? 4 : 3) : 1;
  checkImageSize(width, height, channels);

  // The library reads every one of Y, R, G, B and A with one sample type, takes a UINT channel for zero bytes wide
  // and ignores subsampling: a file outside those assumptions would decode to wrong values without an error.
  if (header.channels.some((c) => c.type !== HALF && c.type !== FLOAT)) {
    throw new Error('OpenEXR file has a UINT channel; files of HALF and FLOAT channels are read');
  }
  const image = header.channels.filter((c) => ['Y', 'R', 'G', 'B', 'A'].includes(c.name));
  if (image.some((c) => c.type !== image[0].type)) {
    throw new Error('OpenEXR file mixes HALF and FLOAT image channels; one sample type is read');
  }
  if (header.channels.some((c) => c.xSampling !== 1 || c.ySampling !== 1)) {
    throw new Error('OpenEXR file has subsampled channels; full-resolution channels are read');
  }

  const blockHeight = BLOCK_HEIGHT.get(header.compression);
  if (blockHeight === undefined) {
    throw new Error(`OpenEXR compression ${COMPRESSION_NAMES[header.compression] ?? header.compression} is not supported`);
  }
  // The library places the chunks of a decreasing-Y file correctly only when a chunk is one scan line.
  if (header.lineOrder !== 0 && (header.lineOrder !== 1 || blockHeight !== 1)) {
    throw new Error('OpenEXR file stores its scan lines in decreasing or random order with this compression; increasing order is read');
  }

  // The library reads the chunks one after another from behind the offset table, and places each by its position
  // in that sequence, never by the line number it carries: follow the same path to its end and compare the two.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = header.end + 8 * Math.ceil(height / blockHeight);
  for (let line = 0; line < height; line += blockHeight) {
    if (pos + 8 > bytes.length) throw truncated();
    const expected = header.top + (header.lineOrder === 0 ? line : height - 1 - line);
    if (view.getInt32(pos, true) !== expected) {
      throw new Error('OpenEXR file stores its scan lines in another order than its header states');
    }
    pos += 8 + view.getUint32(pos + 4, true);
  }
  if (pos > bytes.length) throw truncated();

  let decoded;
  try {
    decoded = parseExr(exactBuffer(bytes), FLOAT_OUTPUT);
  } catch (error) {
    throw new Error(`OpenEXR file cannot be decoded: ${reasonOf(error)}`);
  }
  const source = decoded.data;
  // The library gives 1 channel for Y and 4 for RGB with or without A, bottom row first.
  const stride = rgb ? 4 : 1;
  if (!(source instanceof Float32Array) || decoded.width !== width || decoded.height !== height || source.length !== width * height * stride) {
    throw new Error('OpenEXR file cannot be decoded: the decoder returned another image than the header describes');
  }

  const row = width * stride;
  let data: Float32Array<ArrayBuffer>;
  if (stride === channels) {
    // In place: swap the rows that mirror each other. The library types its result as possibly shared memory;
    // a result is moved between threads, so it is not.
    data = source.buffer instanceof ArrayBuffer ? source as Float32Array<ArrayBuffer> : new Float32Array(source);
    const scratch = new Float32Array(row);
    for (let y = 0, mirror = height - 1; y < mirror; y++, mirror--) {
      scratch.set(data.subarray(y * row, (y + 1) * row));
      data.copyWithin(y * row, mirror * row, (mirror + 1) * row);
      data.set(scratch, mirror * row);
    }
  } else {
    // RGB without A: the library's fourth channel is dropped.
    data = new Float32Array(width * height * channels);
    for (let y = 0, to = 0; y < height; y++) {
      let from = (height - 1 - y) * row;
      for (let x = 0; x < width; x++, from += stride) {
        for (let c = 0; c < channels; c++) data[to++] = source[from + c];
      }
    }
  }
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) data[i] = 0;
  return { width, height, channels, data };
}
