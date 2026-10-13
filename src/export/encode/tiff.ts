import type { FileWriter } from '../../core/runtime.ts';
import type { RowEncoder } from './png.ts';
import { checkSize, littleEndian, rowCounter, SAMPLE_BYTES, writeChunked } from './raw.ts';

const ROWS_PER_STRIP = 64;
const SHORT = 3, LONG = 4;
/** The image file directory of 4.6 ends here; the strip tables, when there are several strips, follow. */
const DIRECTORY_END = 146;

/** Everything before the samples: the header, the directory of eleven entries and, for several strips, their offsets and byte counts. */
function directory(width: number, height: number, bytesPerSample: number, float: boolean): Uint8Array {
  const strips = Math.ceil(height / ROWS_PER_STRIP);
  const data = strips === 1 ? DIRECTORY_END : DIRECTORY_END + 8 * strips;
  const bytes = new Uint8Array(data);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 0x2a, 0x00]);
  view.setUint32(4, 8, true);
  view.setUint16(8, 11, true);
  let at = 10;
  /** A SHORT value occupies the first two bytes of the value field; the other two stay zero. */
  const entry = (tag: number, type: number, count: number, value: number): void => {
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === SHORT) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
    at += 12;
  };
  const stripBytes = ROWS_PER_STRIP * bytesPerSample * width;
  entry(256, LONG, 1, width);
  entry(257, LONG, 1, height);
  entry(258, SHORT, 1, 8 * bytesPerSample);
  entry(259, SHORT, 1, 1);                                   // no compression
  entry(262, SHORT, 1, 1);                                   // BlackIsZero
  entry(273, LONG, strips, strips === 1 ? data : DIRECTORY_END);
  entry(277, SHORT, 1, 1);
  entry(278, LONG, 1, ROWS_PER_STRIP);
  entry(279, LONG, strips, strips === 1 ? bytesPerSample * width * height : DIRECTORY_END + 4 * strips);
  entry(284, SHORT, 1, 1);
  entry(339, SHORT, 1, float ? 3 : 1);
  view.setUint32(at, 0, true);                               // no further directory
  if (strips > 1) {
    for (let i = 0; i < strips; i++) {
      view.setUint32(DIRECTORY_END + 4 * i, data + i * stripBytes, true);
      view.setUint32(DIRECTORY_END + 4 * strips + 4 * i, Math.min(ROWS_PER_STRIP, height - ROWS_PER_STRIP * i) * bytesPerSample * width, true);
    }
  }
  return bytes;
}

/**
 * export-unreal.md 4.6: baseline TIFF, little-endian, one image, one sample per pixel, uncompressed, in strips of
 * 64 rows. The strips follow one another, so the samples are one run of rows behind the directory. The file is
 * `D + bytesPerSample * width * height` bytes, D being 146 with one strip and `146 + 8 * strips` with more.
 */
export function createTiffEncoder(out: FileWriter, o: { width: number; height: number; sample: 'u16' | 'f32' }): RowEncoder<Uint16Array | Float32Array> {
  const { width, height, sample } = o;
  if (sample !== 'u16' && sample !== 'f32') throw new RangeError(`TIFF encoder: the sample type ${JSON.stringify(sample)} is not "u16" or "f32"`);
  checkSize('TIFF encoder', width, height);
  const size = SAMPLE_BYTES[sample];
  if (Math.ceil(height / ROWS_PER_STRIP) * 8 + DIRECTORY_END + size * width * height > 0xffffffff) {
    throw new RangeError(`TIFF encoder: ${width} x ${height} samples of ${size} bytes do not fit the 4 GiB of a TIFF file`);
  }
  const rows = rowCounter('TIFF encoder', { width, height, sample });
  let begun = false;
  return {
    get rowsWritten() { return rows.rowsWritten; },
    async write(samples) {
      if (rows.take(samples) === 0) return;
      await rows.filed(async () => {
        if (!begun) {
          begun = true;
          await writeChunked(out, directory(width, height, size, sample === 'f32'));
        }
        await writeChunked(out, littleEndian(samples));
      });
    },
    async end() {
      rows.finish();
    },
  };
}
