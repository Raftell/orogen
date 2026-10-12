// Test-side writers of small image files, for the decoder tests. The export layouts follow export-unreal.md
// 4.5 (OpenEXR) and 4.6 (TIFF) byte for byte; the general writers cover what else the decoders accept.

import zlib from 'node:zlib';

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

// ---- PNG ---------------------------------------------------------------------------------------------------

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, zlib.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export interface PngSpec {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly colorType: number;                              // 0 grey, 2 RGB, 3 palette, 4 grey with alpha, 6 RGBA
  /** The unfiltered rows, one after another, each padded to whole bytes. Empty: a file without image data. */
  readonly rows: Uint8Array;
  readonly palette?: readonly (readonly [number, number, number])[];
  readonly alpha?: readonly number[];                      // tRNS: the alpha of the first palette entries, or the colour key of a grey or RGB image
  /** Adam7. `rows` is then the scanlines of the seven passes one after another, each with its filter byte. */
  readonly interlaced?: boolean;
}

export function buildPng(spec: PngSpec): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, spec.width);
  view.setUint32(4, spec.height);
  ihdr[8] = spec.depth;
  ihdr[9] = spec.colorType;
  ihdr[12] = spec.interlaced ? 1 : 0;
  const chunks = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), pngChunk('IHDR', ihdr)];
  if (spec.palette) chunks.push(pngChunk('PLTE', Uint8Array.from(spec.palette.flat())));
  if (spec.alpha) chunks.push(pngChunk('tRNS', Uint8Array.from(spec.alpha)));
  if (spec.interlaced) chunks.push(pngChunk('IDAT', zlib.deflateSync(spec.rows)));
  else if (spec.rows.length > 0) {
    const line = spec.rows.length / spec.height;
    const filtered = new Uint8Array(spec.height * (line + 1));          // filter type 0 before every row
    for (let y = 0; y < spec.height; y++) filtered.set(spec.rows.subarray(y * line, (y + 1) * line), y * (line + 1) + 1);
    chunks.push(pngChunk('IDAT', zlib.deflateSync(filtered)));
  }
  chunks.push(pngChunk('IEND', new Uint8Array(0)));
  return concat(chunks);
}

// ---- TIFF --------------------------------------------------------------------------------------------------

export interface TiffSpec {
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly bits: number;
  readonly format: 1 | 2 | 3;                              // unsigned, signed, float
  readonly values: ArrayLike<number>;                      // interleaved, row-major, top row first
  readonly littleEndian?: boolean;                         // default true
  readonly compression?: number;                           // 1 none (default), 5 LZW, 8 Deflate, 32773 PackBits
  readonly rowsPerStrip?: number;                          // default: one strip
  readonly tile?: number;                                  // square tiles of this side instead of strips
  readonly planar?: 1 | 2;                                 // default 1, samples interleaved
  readonly photometric?: number;                           // default 1, or 2 for three and four samples
  readonly declaredSize?: readonly [width: number, height: number];   // ImageWidth and ImageLength, when they shall differ from the data
  readonly predictor?: 2 | 3;                              // horizontal differencing of integers, or of the bytes of floats
  readonly shortBlocks?: number;                           // every strip or tile is stored and declared this many bytes shorter
}

function packBits(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let at = 0; at < data.length; at += 128) {
    const run = data.subarray(at, at + 128);
    out.push(run.length - 1, ...run);                      // literal runs only
  }
  return Uint8Array.from(out);
}

/** A valid TIFF LZW stream that compresses nothing: 9-bit literal codes, with a clear code before the table can grow a code width. */
function lzwLiterals(data: Uint8Array): Uint8Array {
  const codes: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i % 200 === 0) codes.push(256);
    codes.push(data[i]!);
  }
  codes.push(257);
  const out = new Uint8Array(Math.ceil((codes.length * 9) / 8));
  codes.forEach((code, i) => {
    for (let b = 0; b < 9; b++) {
      const bit = i * 9 + b;
      if (code & (1 << (8 - b))) out[bit >> 3]! |= 0x80 >> (bit & 7);
    }
  });
  return out;
}

function compress(data: Uint8Array, compression: number): Uint8Array {
  if (compression === 8 || compression === 32946) return zlib.deflateSync(data);
  if (compression === 32773) return packBits(data);
  if (compression === 5) return lzwLiterals(data);
  return data;
}

export function buildTiff(spec: TiffSpec): Uint8Array<ArrayBuffer> {
  const { width, height, samples, bits, format, values } = spec;
  const le = spec.littleEndian ?? true;
  const compression = spec.compression ?? 1;
  const planar = spec.planar ?? 1;
  const size = bits / 8;

  const put = (view: DataView, at: number, v: number): void => {
    if (format === 3) {
      if (bits === 32) view.setFloat32(at, v, le);         // other float sizes exist only as headers of rejected files
    } else if (bits === 8) format === 2 ? view.setInt8(at, v) : view.setUint8(at, v);
    else if (bits === 16) format === 2 ? view.setInt16(at, v, le) : view.setUint16(at, v, le);
    else format === 2 ? view.setInt32(at, v, le) : view.setUint32(at, v, le);
  };
  /** One strip or tile: the pixels [x0, x0 + w) x [y0, y0 + h) of the given samples; texels outside the image are zero. */
  const block = (x0: number, y0: number, w: number, h: number, which: readonly number[]): Uint8Array => {
    const out = new Uint8Array(w * h * which.length * size);
    const view = new DataView(out.buffer);
    let at = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        for (const s of which) {
          if (x < width && y < height) put(view, at, values[(y * width + x) * samples + s]!);
          at += size;
        }
      }
    }
    const row = w * which.length;                          // samples per row of the block
    for (let r = 0; r < h && spec.predictor; r++) {
      const at0 = r * row * size;
      if (spec.predictor === 2) {
        // Each sample minus the one a pixel to its left, in the sample's own width and byte order.
        const mask = 2 ** bits;
        const get = (i: number): number => (bits === 8 ? view.getUint8(at0 + i) : bits === 16 ? view.getUint16(at0 + i * 2, le) : view.getUint32(at0 + i * 4, le));
        for (let i = row - 1; i >= which.length; i--) {
          const d = (get(i) - get(i - which.length) + mask) % mask;
          if (bits === 8) view.setUint8(at0 + i, d);
          else if (bits === 16) view.setUint16(at0 + i * 2, d, le);
          else view.setUint32(at0 + i * 4, d, le);
        }
      } else {
        // The bytes of the row's floats in planes, most significant first, then each byte minus the one a pixel to its left.
        const planes = new Uint8Array(row * size);
        for (let i = 0; i < row; i++) for (let b = 0; b < size; b++) planes[b * row + i] = out[at0 + i * size + (le ? size - 1 - b : b)]!;
        for (let i = planes.length - 1; i >= which.length; i--) planes[i] = (planes[i]! - planes[i - which.length]!) & 255;
        out.set(planes, at0);
      }
    }
    const stored = compress(out, compression);
    return spec.shortBlocks ? stored.subarray(0, stored.length - spec.shortBlocks) : stored;
  };

  const planes: number[][] = planar === 2 ? Array.from({ length: samples }, (_, s) => [s]) : [Array.from({ length: samples }, (_, s) => s)];
  const blocks: Uint8Array[] = [];
  const rowsPerStrip = spec.rowsPerStrip ?? height;
  for (const which of planes) {
    if (spec.tile) {
      for (let y = 0; y < height; y += spec.tile) for (let x = 0; x < width; x += spec.tile) blocks.push(block(x, y, spec.tile, spec.tile, which));
    } else {
      for (let y = 0; y < height; y += rowsPerStrip) blocks.push(block(0, y, width, Math.min(rowsPerStrip, height - y), which));
    }
  }

  const SHORT = 3;
  const LONG = 4;
  const offsets: number[] = [];
  let at = 8;
  for (const b of blocks) {
    offsets.push(at);
    at += b.length;
  }
  const entries: [tag: number, type: number, values: number[]][] = [
    [256, LONG, [spec.declaredSize?.[0] ?? width]],
    [257, LONG, [spec.declaredSize?.[1] ?? height]],
    [258, SHORT, Array<number>(samples).fill(bits)],
    [259, SHORT, [compression]],
    [262, SHORT, [spec.photometric ?? (samples >= 3 ? 2 : 1)]],
    [277, SHORT, [samples]],
    [284, SHORT, [planar]],
    [339, SHORT, Array<number>(samples).fill(format)],
  ];
  if (spec.tile) {
    entries.push([322, LONG, [spec.tile]], [323, LONG, [spec.tile]], [324, LONG, offsets], [325, LONG, blocks.map((b) => b.length)]);
  } else {
    entries.push([273, LONG, offsets], [278, LONG, [rowsPerStrip]], [279, LONG, blocks.map((b) => b.length)]);
  }
  if (samples === 4) entries.push([338, SHORT, [2]]);      // ExtraSamples: unassociated alpha
  if (spec.predictor) entries.push([317, SHORT, [spec.predictor]]);
  entries.sort((a, b) => a[0] - b[0]);

  // After the blocks: the arrays that do not fit into an entry, then the directory.
  const arrays: { at: number; type: number; values: number[] }[] = [];
  for (const [, type, list] of entries) {
    const bytes = list.length * (type === SHORT ? 2 : 4);
    if (bytes > 4) {
      arrays.push({ at, type, values: list });
      at += bytes;
    }
  }
  const directory = at;
  const out = new Uint8Array(directory + 2 + entries.length * 12 + 4);
  const view = new DataView(out.buffer);
  out.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 42, le);
  view.setUint32(4, directory, le);
  blocks.forEach((b, i) => out.set(b, offsets[i]));
  const putList = (where: number, type: number, list: readonly number[]): void => {
    list.forEach((v, i) => (type === SHORT ? view.setUint16(where + i * 2, v, le) : view.setUint32(where + i * 4, v, le)));
  };
  for (const a of arrays) putList(a.at, a.type, a.values);
  view.setUint16(directory, entries.length, le);
  let nextArray = 0;
  entries.forEach(([tag, type, list], i) => {
    const entry = directory + 2 + i * 12;
    view.setUint16(entry, tag, le);
    view.setUint16(entry + 2, type, le);
    view.setUint32(entry + 4, list.length, le);
    if (list.length * (type === SHORT ? 2 : 4) > 4) view.setUint32(entry + 8, arrays[nextArray++]!.at, le);
    else putList(entry + 8, type, list);
  });
  return out;
}

/** The file createTiffEncoder writes (export-unreal.md 4.6): little-endian, one sample, strips of 64 rows, the directory first. */
export function exportTiff(width: number, height: number, sample: 'u16' | 'f32', values: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const b = sample === 'u16' ? 2 : 4;
  const n = Math.ceil(height / 64);
  const D = n === 1 ? 146 : 146 + 8 * n;
  const out = new Uint8Array(D + b * width * height);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 0x2a, 0x00]);
  view.setUint32(4, 8, true);
  view.setUint16(8, 11, true);
  const SHORT = 3;
  const LONG = 4;
  const entries: [tag: number, type: number, count: number, value: number][] = [
    [256, LONG, 1, width],
    [257, LONG, 1, height],
    [258, SHORT, 1, b * 8],
    [259, SHORT, 1, 1],
    [262, SHORT, 1, 1],
    [273, LONG, n, n === 1 ? D : 146],
    [277, SHORT, 1, 1],
    [278, LONG, 1, 64],
    [279, LONG, n, n === 1 ? b * width * height : 146 + 4 * n],
    [284, SHORT, 1, 1],
    [339, SHORT, 1, sample === 'u16' ? 1 : 3],
  ];
  entries.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === SHORT) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  view.setUint32(142, 0, true);
  if (n > 1) {
    for (let i = 0; i < n; i++) {
      view.setUint32(146 + 4 * i, D + i * 64 * b * width, true);
      view.setUint32(146 + 4 * n + 4 * i, Math.min(64, height - 64 * i) * b * width, true);
    }
  }
  for (let i = 0; i < width * height; i++) {
    if (sample === 'u16') view.setUint16(D + 2 * i, values[i]!, true);
    else view.setFloat32(D + 4 * i, values[i]!, true);
  }
  return out;
}

// ---- OpenEXR -----------------------------------------------------------------------------------------------

/** The 16 bits of a half float. Exact for the values the tests use: zero and normal numbers with at most 10 fraction bits. */
export function halfBits(v: number): number {
  if (v === 0) return 0;
  const u = new Uint32Array(new Float32Array([v]).buffer)[0]!;
  return ((u >>> 16) & 0x8000) | ((((u >>> 23) & 0xff) - 112) << 10) | ((u >>> 13) & 0x3ff);
}

function exrAttribute(name: string, type: string, value: Uint8Array): Uint8Array {
  const size = new Uint8Array(4);
  new DataView(size.buffer).setInt32(0, value.length, true);
  return concat([ascii(`${name}\0${type}\0`), size, value]);
}

function int32s(...list: number[]): Uint8Array {
  const out = new Uint8Array(list.length * 4);
  const view = new DataView(out.buffer);
  list.forEach((v, i) => view.setInt32(i * 4, v, true));
  return out;
}

function float32s(...list: number[]): Uint8Array {
  const out = new Uint8Array(list.length * 4);
  const view = new DataView(out.buffer);
  list.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return out;
}

export interface ExrChannelSpec {
  readonly name: string;
  readonly type: 0 | 1 | 2;                                // UINT, HALF, FLOAT
  readonly values: ArrayLike<number>;                      // width x height, row-major, top row first
  readonly sampling?: number;                              // xSampling and ySampling in the header; default 1
}

export interface ExrSpec {
  readonly width: number;
  readonly height: number;
  readonly channels: readonly ExrChannelSpec[];
  readonly compression?: 0 | 2 | 3;                        // none (default), ZIPS (one line per chunk), ZIP (16 lines)
  readonly lineOrder?: 0 | 1;                              // increasing (default) or decreasing Y
  readonly storedOrder?: 0 | 1;                            // the order of the chunks in the file, when it shall differ from lineOrder
  readonly origin?: readonly [x: number, y: number];       // the data window's minimum; default [0, 0]
  readonly flags?: number;                                 // the flag byte after the version; default 0
  readonly declaredCompression?: number;                   // the code in the header, when it shall differ
  readonly declaredSize?: readonly [width: number, height: number];   // the size of the data window, when it shall differ from the data
}

/** The byte reordering and the predictor of OpenEXR's ZIP modes, then zlib. */
function exrZip(raw: Uint8Array): Uint8Array {
  const t = new Uint8Array(raw.length);
  let low = 0;
  let high = (raw.length + 1) >> 1;
  for (let i = 0; i < raw.length; i++) t[i & 1 ? high++ : low++] = raw[i]!;
  for (let i = t.length - 1; i > 0; i--) t[i] = (t[i]! - t[i - 1]! + 128) & 255;
  const packed = zlib.deflateSync(t);
  if (packed.length >= raw.length) throw new Error('test data does not compress: an EXR chunk would be stored raw');
  return packed;
}

export function buildExr(spec: ExrSpec): Uint8Array<ArrayBuffer> {
  const { width, height } = spec;
  const compression = spec.compression ?? 0;
  const lineOrder = spec.lineOrder ?? 0;
  const [x0, y0] = spec.origin ?? [0, 0];
  const channels = [...spec.channels].sort((a, b) => (a.name < b.name ? -1 : 1));       // a file lists its channels by name

  const chlist = concat([
    ...channels.map((c) => concat([ascii(`${c.name}\0`), int32s(c.type), Uint8Array.of(0, 0, 0, 0), int32s(c.sampling ?? 1, c.sampling ?? 1)])),
    Uint8Array.of(0),
  ]);
  const [declaredWidth, declaredHeight] = spec.declaredSize ?? [width, height];
  const window = int32s(x0, y0, x0 + declaredWidth - 1, y0 + declaredHeight - 1);
  const header = concat([
    Uint8Array.of(0x76, 0x2f, 0x31, 0x01, 2, spec.flags ?? 0, 0, 0),
    exrAttribute('channels', 'chlist', chlist),
    exrAttribute('compression', 'compression', Uint8Array.of(spec.declaredCompression ?? compression)),
    exrAttribute('dataWindow', 'box2i', window),
    exrAttribute('displayWindow', 'box2i', window),
    exrAttribute('lineOrder', 'lineOrder', Uint8Array.of(lineOrder)),
    exrAttribute('pixelAspectRatio', 'float', float32s(1)),
    exrAttribute('screenWindowCenter', 'v2f', float32s(0, 0)),
    exrAttribute('screenWindowWidth', 'float', float32s(1)),
    Uint8Array.of(0),
  ]);

  const widths = [4, 2, 4];
  const lineBytes = channels.reduce((n, c) => n + widths[c.type]! * width, 0);
  const linesPerChunk = compression === 3 ? 16 : 1;
  const chunks: { y: number; bytes: Uint8Array }[] = [];
  for (let y = 0; y < height; y += linesPerChunk) {
    const lines = Math.min(linesPerChunk, height - y);
    const raw = new Uint8Array(lines * lineBytes);
    const view = new DataView(raw.buffer);
    let at = 0;
    for (let line = y; line < y + lines; line++) {
      for (const c of channels) {
        for (let x = 0; x < width; x++) {
          const v = c.values[line * width + x]!;
          if (c.type === 2) view.setFloat32(at, v, true);
          else if (c.type === 1) view.setUint16(at, halfBits(v), true);
          else view.setUint32(at, v, true);
          at += widths[c.type]!;
        }
      }
    }
    const data = compression === 0 ? raw : exrZip(raw);
    chunks.push({ y: y0 + y, bytes: concat([int32s(y0 + y, data.length), data]) });
  }

  // The offset table is by increasing y whatever the order of the chunks in the file.
  const stored = (spec.storedOrder ?? lineOrder) === 1 ? [...chunks].reverse() : chunks;
  const table = new Uint8Array(8 * chunks.length);
  const tableView = new DataView(table.buffer);
  let at = header.length + table.length;
  for (const chunk of stored) {
    tableView.setBigUint64(8 * chunks.indexOf(chunk), BigInt(at), true);
    at += chunk.bytes.length;
  }
  return concat([header, table, ...stored.map((c) => c.bytes)]);
}

/** The file createExrEncoder writes (export-unreal.md 4.5): one FLOAT channel Y, no compression, increasing Y. */
export function exportExr(width: number, height: number, values: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return buildExr({ width, height, channels: [{ name: 'Y', type: 2, values }] });
}
