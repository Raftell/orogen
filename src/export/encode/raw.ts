import type { FileWriter } from '../../core/runtime.ts';
import type { RowEncoder } from './png.ts';

/** An encoder passes the FileWriter chunks of at most 16 MiB (export-unreal.md 4.1 rule 4). */
export const CHUNK_BYTES = 16 << 20;
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export type Sample = 'u8' | 'u16' | 'f32';
export type Samples = Uint8Array | Uint16Array | Float32Array;
const ARRAYS = { u8: Uint8Array, u16: Uint16Array, f32: Float32Array } as const;
export const SAMPLE_BYTES: Readonly<Record<Sample, number>> = { u8: 1, u16: 2, f32: 4 };

export function checkSize(encoder: string, width: number, height: number): void {
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) throw new RangeError(`${encoder}: ${name} ${String(value)} is not an integer of at least 1`);
  }
}

/** The bytes of `rows` in little-endian order. On a little-endian host they are the array's own, not a copy. */
export function littleEndian(rows: Samples): Uint8Array {
  const bytes = new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength);
  const size = rows.BYTES_PER_ELEMENT;
  if (HOST_LITTLE_ENDIAN || size === 1) return bytes;
  const swapped = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += size) {
    for (let b = 0; b < size; b++) swapped[i + b] = bytes[i + size - 1 - b]!;
  }
  return swapped;
}

/** Hands `bytes` to the file in order, in chunks of at most 16 MiB, awaiting each before the next. */
export async function writeChunked(out: FileWriter, bytes: Uint8Array): Promise<void> {
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) await out.write(bytes.subarray(at, Math.min(at + CHUNK_BYTES, bytes.length)));
}

/**
 * What every row encoder checks and counts (4.1 rule 3): whole rows of the right sample type, no more than
 * `height` of them, none after end, and every one before it. A failure of the file is remembered: every later
 * call rejects with it.
 */
export function rowCounter(encoder: string, o: { readonly width: number; readonly height: number; readonly sample: Sample }) {
  let rowsWritten = 0;
  let ended = false;
  let failure: { readonly thrown: unknown } | null = null;
  const check = (): void => {
    if (failure) throw failure.thrown;
  };
  return {
    get rowsWritten() { return rowsWritten; },
    /** The number of rows `rows` holds; throws RangeError for rows the encoder does not take. */
    take(rows: Samples): number {
      check();
      if (ended) throw new RangeError(`${encoder}: write after end`);
      if (!(rows instanceof ARRAYS[o.sample])) throw new RangeError(`${encoder}: ${o.sample} samples are written as ${ARRAYS[o.sample].name} rows`);
      if (rows.length % o.width !== 0) throw new RangeError(`${encoder}: ${rows.length} samples are not whole rows of ${o.width}`);
      const count = rows.length / o.width;
      if (rowsWritten + count > o.height) throw new RangeError(`${encoder}: ${rowsWritten + count} rows for an image of ${o.height}`);
      rowsWritten += count;
      return count;
    },
    finish(): void {
      check();
      if (ended) throw new RangeError(`${encoder}: end was already called`);
      if (rowsWritten < o.height) throw new RangeError(`${encoder}: end after ${rowsWritten} of ${o.height} rows`);
      ended = true;
    },
    /** Runs a step of file writing; what it rejects with stops the encoder. */
    async filed(step: () => Promise<void>): Promise<void> {
      try {
        await step();
      } catch (thrown) {
        failure ??= { thrown };
        throw failure.thrown;
      }
    },
  };
}

/**
 * export-unreal.md 4.4: `.r8`, `.r16` and `.r32`. No header; samples row-major, row 0 first, little-endian. The
 * file is `width * height * bytesPerSample` bytes.
 */
export function createRawEncoder(out: FileWriter, o: { width: number; height: number; sample: Sample }): RowEncoder<Samples> {
  if (!Object.hasOwn(ARRAYS, o.sample)) throw new RangeError(`raw encoder: the sample type ${JSON.stringify(o.sample)} is not "u8", "u16" or "f32"`);
  checkSize('raw encoder', o.width, o.height);
  const rows = rowCounter('raw encoder', o);
  return {
    get rowsWritten() { return rows.rowsWritten; },
    async write(samples) {
      if (rows.take(samples) === 0) return;
      await rows.filed(() => writeChunked(out, littleEndian(samples)));
    },
    async end() {
      rows.finish();
    },
  };
}
