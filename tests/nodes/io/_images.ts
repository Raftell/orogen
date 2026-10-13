// tests/nodes/io/_images.ts
// Image files for the tests of the import nodes, made in memory from the file formats themselves and from no
// encoder of the product: a PNG with stored (uncompressed) deflate blocks, a baseline TIFF of one strip, an
// OpenEXR file of uncompressed scan lines, and headerless raw samples.

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

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (const v of bytes) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A PNG of 8 or 16 bits per channel: 1 channel grey, 2 grey with alpha, 3 RGB, 4 RGBA. `samples` are the codes,
 * interleaved, row-major, top row first. Every scanline has filter type 0, in stored deflate blocks.
 */
export function png(o: { width: number; height: number; channels: 1 | 2 | 3 | 4; bits: 8 | 16; samples: ArrayLike<number> }): Uint8Array<ArrayBuffer> {
  const { width, height, channels, bits } = o;
  const bytesPerSample = bits / 8;
  const stride = width * channels * bytesPerSample;
  const lines = new Uint8Array(height * (1 + stride));
  for (let y = 0, s = 0; y < height; y++) {
    let at = y * (1 + stride) + 1;
    for (let i = 0; i < width * channels; i++, s++) {
      const v = o.samples[s]!;
      if (bits === 16) lines[at++] = v >> 8;
      lines[at++] = v & 0xff;
    }
  }
  // A zlib stream of stored blocks: the header, then for each block its flag, its length twice and its bytes.
  const blocks: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let at = 0; at < lines.length || at === 0; at += 65535) {
    const length = Math.min(65535, lines.length - at);
    const last = at + length >= lines.length ? 1 : 0;
    blocks.push(Uint8Array.of(last, length & 0xff, length >> 8, ~length & 0xff, (~length >> 8) & 0xff), lines.subarray(at, at + length));
  }
  const check = new Uint8Array(4);
  new DataView(check.buffer).setUint32(0, adler32(lines));
  blocks.push(check);

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = bits;
  header[9] = [0, 4, 2, 6][channels - 1]!;
  return concat([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), pngChunk('IHDR', header), pngChunk('IDAT', concat(blocks)), pngChunk('IEND', new Uint8Array(0))]);
}

/**
 * A baseline TIFF, little-endian, uncompressed, one strip: 1, 3 or 4 samples per pixel of 8 or 16 bits unsigned
 * or of 32-bit floats. `samples` are interleaved, row-major, top row first.
 */
export function tiff(o: { width: number; height: number; channels: 1 | 3 | 4; sample: 'u8' | 'u16' | 'f32'; samples: ArrayLike<number> }): Uint8Array<ArrayBuffer> {
  const { width, height, channels, sample } = o;
  const size = sample === 'u8' ? 1 : sample === 'u16' ? 2 : 4;
  const SHORT = 3, LONG = 4;
  const entries: (readonly [tag: number, type: number, values: readonly number[]])[] = [
    [256, LONG, [width]], [257, LONG, [height]], [258, SHORT, Array<number>(channels).fill(8 * size)], [259, SHORT, [1]],
    [262, SHORT, [channels === 1 ? 1 : 2]], [273, LONG, [0]], [277, SHORT, [channels]], [278, LONG, [height]],
    [279, LONG, [size * channels * width * height]], [284, SHORT, [1]],
    ...(channels === 4 ? [[338, SHORT, [2]] as const] : []),
    [339, SHORT, Array<number>(channels).fill(sample === 'f32' ? 3 : 1)],
  ];
  // The directory at 8; behind it the value lists that do not fit an entry; then the samples.
  const directoryEnd = 8 + 2 + 12 * entries.length + 4;
  const fits = (type: number, count: number): boolean => count * (type === SHORT ? 2 : 4) <= 4;
  const extra = entries.reduce((sum, [, type, values]) => sum + (fits(type, values.length) ? 0 : values.length * (type === SHORT ? 2 : 4)), 0);
  const data = directoryEnd + extra;
  const out = new Uint8Array(data + size * channels * width * height);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 0x2a, 0x00]);
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  let at = 10, spill = directoryEnd;
  for (const [tag, type, given] of entries) {
    const values = tag === 273 ? [data] : given;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, values.length, true);
    let to = at + 8;
    if (!fits(type, values.length)) {
      view.setUint32(at + 8, spill, true);
      to = spill;
      spill += values.length * (type === SHORT ? 2 : 4);
    }
    for (const [i, v] of values.entries()) {
      if (type === SHORT) view.setUint16(to + 2 * i, v, true);
      else view.setUint32(to + 4 * i, v, true);
    }
    at += 12;
  }
  for (let i = 0; i < width * height * channels; i++) {
    const v = o.samples[i]!;
    if (sample === 'u8') out[data + i] = v;
    else if (sample === 'u16') view.setUint16(data + 2 * i, v, true);
    else view.setFloat32(data + 4 * i, v, true);
  }
  return out;
}

/**
 * An OpenEXR file of one part: scan lines in increasing Y, no compression, FLOAT channels. `channels` maps a
 * channel name (`Y`, or `R`, `G`, `B`, `A`) to its values, row-major, top row first. A file stores its channels
 * in the order of their names.
 */
export function exr(o: { width: number; height: number; channels: Readonly<Record<string, ArrayLike<number>>> }): Uint8Array<ArrayBuffer> {
  const { width, height } = o;
  const names = Object.keys(o.channels).sort();
  const text = (s: string): Uint8Array => concat([ascii(s), Uint8Array.of(0)]);
  const int32 = (...values: number[]): Uint8Array => {
    const out = new Uint8Array(4 * values.length);
    values.forEach((v, i) => new DataView(out.buffer).setInt32(4 * i, v, true));
    return out;
  };
  const float32 = (...values: number[]): Uint8Array => {
    const out = new Uint8Array(4 * values.length);
    values.forEach((v, i) => new DataView(out.buffer).setFloat32(4 * i, v, true));
    return out;
  };
  const attribute = (name: string, type: string, value: Uint8Array): Uint8Array => concat([text(name), text(type), int32(value.length), value]);
  const channelList = concat([...names.map((name) => concat([text(name), int32(2), Uint8Array.of(0, 0, 0, 0), int32(1, 1)])), Uint8Array.of(0)]);
  const header = concat([
    Uint8Array.of(0x76, 0x2f, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00),
    attribute('channels', 'chlist', channelList),
    attribute('compression', 'compression', Uint8Array.of(0)),
    attribute('dataWindow', 'box2i', int32(0, 0, width - 1, height - 1)),
    attribute('displayWindow', 'box2i', int32(0, 0, width - 1, height - 1)),
    attribute('lineOrder', 'lineOrder', Uint8Array.of(0)),
    attribute('pixelAspectRatio', 'float', float32(1)),
    attribute('screenWindowCenter', 'v2f', float32(0, 0)),
    attribute('screenWindowWidth', 'float', float32(1)),
    Uint8Array.of(0),
  ]);
  const chunk = 8 + 4 * width * names.length;
  const out = new Uint8Array(header.length + 8 * height + height * chunk);
  const view = new DataView(out.buffer);
  out.set(header);
  for (let y = 0; y < height; y++) {
    const at = header.length + 8 * height + y * chunk;
    view.setUint32(header.length + 8 * y, at, true);
    view.setInt32(at, y, true);
    view.setInt32(at + 4, chunk - 8, true);
    names.forEach((name, c) => {
      for (let x = 0; x < width; x++) view.setFloat32(at + 8 + 4 * (c * width + x), o.channels[name]![y * width + x]!, true);
    });
  }
  return out;
}

/** Headerless samples, row-major, little-endian: the bytes of a `.r8`, `.r16` or `.r32` file. */
export function raw(sample: 'u8' | 'u16' | 'f32', samples: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const size = sample === 'u8' ? 1 : sample === 'u16' ? 2 : 4;
  const out = new Uint8Array(samples.length * size);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    if (sample === 'u8') out[i] = samples[i]!;
    else if (sample === 'u16') view.setUint16(2 * i, samples[i]!, true);
    else view.setFloat32(4 * i, samples[i]!, true);
  }
  return out;
}

/** One value per texel of a width x height image, row-major, from a function of the column and the row. */
export function grid<T>(width: number, height: number, fn: (x: number, y: number) => T): T[] {
  const out: T[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.push(fn(x, y));
  return out;
}
