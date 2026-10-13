import type { FileWriter } from '../../core/runtime.ts';
import type { RowEncoder } from './png.ts';
import { checkSize, CHUNK_BYTES, littleEndian, rowCounter, writeChunked } from './raw.ts';

/** The header of 4.5 ends here whatever the image size; the chunk offset table follows. */
const HEADER_BYTES = 277;

/** The magic number, the version, the eight attributes in the order of 4.5 and the byte that ends the header. */
function header(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const text = (s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[at++] = s.charCodeAt(i);
    at++;                                         // the terminating zero
  };
  const int32 = (v: number): void => { view.setInt32(at, v, true); at += 4; };
  const float32 = (v: number): void => { view.setFloat32(at, v, true); at += 4; };
  const attribute = (name: string, type: string, size: number): void => {
    text(name);
    text(type);
    int32(size);
  };
  const box = (): void => { int32(0); int32(0); int32(width - 1); int32(height - 1); };

  bytes.set([0x76, 0x2f, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00]);
  at = 8;
  attribute('channels', 'chlist', 19);
  text('Y');
  int32(2);                                       // FLOAT
  at += 4;                                        // pLinear 0 and three reserved bytes
  int32(1);                                       // xSampling
  int32(1);                                       // ySampling
  at++;                                           // the zero that ends the channel list
  attribute('compression', 'compression', 1);
  at++;                                           // 0: none
  attribute('dataWindow', 'box2i', 16);
  box();
  attribute('displayWindow', 'box2i', 16);
  box();
  attribute('lineOrder', 'lineOrder', 1);
  at++;                                           // 0: increasing Y
  attribute('pixelAspectRatio', 'float', 4);
  float32(1);
  attribute('screenWindowCenter', 'v2f', 8);
  float32(0);
  float32(0);
  attribute('screenWindowWidth', 'float', 4);
  float32(1);
  at++;                                           // the zero that ends the header
  if (at !== HEADER_BYTES) throw new Error(`OpenEXR encoder: the header is ${at} bytes, not ${HEADER_BYTES}`);
  return bytes;
}

/**
 * export-unreal.md 4.5: one part, scan lines, one channel `Y` of type FLOAT, no compression, increasing Y, all
 * values little-endian. Every chunk is one scan line, so the whole offset table is written before the first row.
 * The file is `277 + height * (16 + 4 * width)` bytes.
 */
export function createExrEncoder(out: FileWriter, o: { width: number; height: number }): RowEncoder<Float32Array> {
  const { width, height } = o;
  checkSize('OpenEXR encoder', width, height);
  const rows = rowCounter('OpenEXR encoder', { width, height, sample: 'f32' });
  const chunkBytes = 8 + 4 * width;
  let begun = false;

  /** The header and the table of the absolute file offset of every chunk, as uint64. */
  const begin = async (): Promise<void> => {
    begun = true;
    const table = new Uint8Array(8 * height);
    const view = new DataView(table.buffer);
    const first = HEADER_BYTES + 8 * height;
    for (let y = 0; y < height; y++) {
      const offset = first + y * chunkBytes;
      view.setUint32(8 * y, offset % 2 ** 32, true);
      view.setUint32(8 * y + 4, Math.floor(offset / 2 ** 32), true);
    }
    await out.write(header(width, height));
    await writeChunked(out, table);
  };

  return {
    get rowsWritten() { return rows.rowsWritten; },
    async write(samples) {
      const y0 = rows.rowsWritten;
      const count = rows.take(samples);
      if (count === 0) return;
      await rows.filed(async () => {
        if (!begun) await begin();
        // Whole chunks per buffer: the line number, the size of the pixel data, the row.
        const perBuffer = Math.max(1, Math.floor(CHUNK_BYTES / chunkBytes));
        for (let row = 0; row < count; row += perBuffer) {
          const n = Math.min(perBuffer, count - row);
          const bytes = new Uint8Array(n * chunkBytes);
          const view = new DataView(bytes.buffer);
          for (let r = 0, at = 0; r < n; r++, at += chunkBytes) {
            view.setInt32(at, y0 + row + r, true);
            view.setInt32(at + 4, 4 * width, true);
            bytes.set(littleEndian(samples.subarray((row + r) * width, (row + r + 1) * width)), at + 8);
          }
          await out.write(bytes);
        }
      });
    },
    async end() {
      rows.finish();
    },
  };
}
