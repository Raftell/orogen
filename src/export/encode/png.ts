import zlib from 'node:zlib';

import type { FileWriter } from '../../core/runtime.ts';

/** export-unreal.md 4.1: a streaming, append-only encoder of whole rows. */
export interface RowEncoder<S extends Uint8Array | Uint16Array | Float32Array> {
  readonly rowsWritten: number;
  /** Appends whole rows, top row first: rows.length is a multiple of width x channels. */
  write(rows: S): Promise<void>;
  /** Writes whatever ends the format. Does not close the FileWriter. */
  end(): Promise<void>;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The zlib stream is cut into IDAT chunks of exactly this many bytes; the last one holds the rest (4.3). */
const IDAT_BYTES = 1 << 20;
const FILTER_UP = 2;
const DIMENSION_MAX = 0x7fffffff;

/** A whole chunk: length, type, data, CRC-32 of type and data. */
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * export-unreal.md 4.3: grey or RGB, 8 or 16 bits, every scanline with filter type 2 (Up), one zlib stream of
 * level 3 cut into IDAT chunks of 1 MiB, no ancillary chunk. The file depends on the samples alone: not on how
 * the rows are split over calls of write, and not on how the deflate stream delivers its output.
 */
export function createPngEncoder(out: FileWriter, o: { width: number; height: number; channels: 1 | 3; bits: 8 | 16 }): RowEncoder<Uint8Array | Uint16Array> {
  const { width, height, channels, bits } = o;
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > DIMENSION_MAX) throw new RangeError(`createPngEncoder: ${name} ${String(value)} is not an integer of at least 1`);
  }
  if (channels !== 1 && channels !== 3) throw new RangeError(`createPngEncoder: ${String(channels)} channels; a PNG of this encoder has 1 or 3`);
  if (bits !== 8 && bits !== 16) throw new RangeError(`createPngEncoder: ${String(bits)} bits; a PNG of this encoder has 8 or 16`);

  const rowSamples = width * channels;
  const rowBytes = rowSamples * (bits / 8);
  /** The unfiltered bytes of the last row written: what the next row is filtered against. Zeros above the first row. */
  const above = new Uint8Array(rowBytes);
  let rowsWritten = 0;
  let ended = false;
  let failure: unknown = null;

  // Every FileWriter.write waits for the one before it (4.1 rule 2). A failed one is remembered and reported by
  // the next write or end; the chain itself never rejects, so that nothing is left unhandled.
  let filed: Promise<void> = Promise.resolve();
  let filing = 0;
  const deflate = zlib.createDeflate({ level: 3, chunkSize: 1 << 20 });
  const file = (bytes: Uint8Array): void => {
    filing++;
    // The compressor produces nothing more while the file is behind: its output buffer fills, then its input.
    deflate.pause();
    filed = filed.then(async () => {
      if (failure === null) await out.write(bytes);
    }).catch((thrown: unknown) => {
      failure ??= thrown;
    }).then(() => {
      if (--filing === 0) deflate.resume();
    });
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bits;
  header[9] = channels === 1 ? 0 : 2;   // colour type: grey, RGB
  file(Buffer.concat([Buffer.from(SIGNATURE), chunk('IHDR', header)]));

  // The IDAT chunk being filled: 8 bytes of length and type, the data, 4 bytes of CRC. A chunk that was handed
  // to the file is not written to again, so each one has a buffer of its own.
  let idat: Buffer | null = null;
  let fill = 0;
  const closeIdat = (chunkBytes: Buffer): void => {
    chunkBytes.writeUInt32BE(fill, 0);
    chunkBytes.write('IDAT', 4, 'latin1');
    chunkBytes.writeUInt32BE(zlib.crc32(chunkBytes.subarray(4, 8 + fill)), 8 + fill);
    file(chunkBytes.subarray(0, 12 + fill));
    idat = null;
    fill = 0;
  };
  deflate.on('data', (data: Buffer) => {
    for (let at = 0; at < data.length;) {
      idat ??= Buffer.allocUnsafe(12 + IDAT_BYTES);
      const count = Math.min(IDAT_BYTES - fill, data.length - at);
      data.copy(idat, 8 + fill, at, at + count);
      fill += count;
      at += count;
      if (fill === IDAT_BYTES) closeIdat(idat);
    }
  });
  const finished = new Promise<void>((resolve) => {
    deflate.once('end', resolve);
    deflate.once('error', (thrown) => {
      failure ??= thrown;
      resolve();
    });
  });

  const check = (): void => {
    if (failure !== null) throw failure;
  };

  return {
    get rowsWritten() { return rowsWritten; },

    async write(rows) {
      check();
      if (ended) throw new RangeError('PNG encoder: write after end');
      if (bits === 8 ? !(rows instanceof Uint8Array) : !(rows instanceof Uint16Array)) {
        throw new RangeError(`PNG encoder: a ${bits}-bit image takes ${bits === 8 ? 'Uint8Array' : 'Uint16Array'} rows`);
      }
      if (rows.length % rowSamples !== 0) {
        throw new RangeError(`PNG encoder: ${rows.length} samples are not whole rows of ${width} x ${channels}`);
      }
      const count = rows.length / rowSamples;
      if (rowsWritten + count > height) {
        throw new RangeError(`PNG encoder: ${rowsWritten + count} rows for an image of ${height}`);
      }
      if (count === 0) return;

      // Each scanline: the filter type, then every byte minus the byte above it. 16-bit samples have the high byte first.
      const lines = Buffer.allocUnsafe(count * (1 + rowBytes));
      for (let row = 0, at = 0, sample = 0; row < count; row++) {
        lines[at++] = FILTER_UP;
        if (bits === 8) {
          for (let i = 0; i < rowBytes; i++, at++) {
            const value = rows[sample++]!;
            lines[at] = value - above[i]!;
            above[i] = value;
          }
        } else {
          for (let i = 0; i < rowBytes; i += 2, at += 2) {
            const value = rows[sample++]!;
            const high = value >> 8, low = value & 0xff;
            lines[at] = high - above[i]!;
            lines[at + 1] = low - above[i + 1]!;
            above[i] = high;
            above[i + 1] = low;
          }
        }
      }
      rowsWritten += count;

      // Resolves when the compressor has taken the scanlines and the file has taken what the compressor gave.
      if (!deflate.write(lines)) {
        await Promise.race([new Promise<void>((resolve) => { deflate.once('drain', resolve); }), finished]);
      }
      await filed;
      check();
    },

    async end() {
      check();
      if (ended) throw new RangeError('PNG encoder: end was already called');
      if (rowsWritten < height) throw new RangeError(`PNG encoder: end after ${rowsWritten} of ${height} rows`);
      ended = true;
      deflate.end();
      // `filed` grows while the compressor delivers: it is complete only once the stream has ended.
      await finished;
      if (idat !== null && fill > 0) closeIdat(idat);
      file(chunk('IEND', new Uint8Array(0)));
      await filed;
      check();
    },
  };
}
